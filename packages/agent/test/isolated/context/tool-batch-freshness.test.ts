import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { ContextSources, SourceRequest } from '../../../src/context';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function calls(...values: { id: string; name: string; path: string }[]): ModelEvent[] {
  return [
    ...values.map(
      ({ id, name, path }): ModelEvent => ({
        type: 'tool_call',
        id,
        name,
        arguments: JSON.stringify({ path }),
      }),
    ),
    { ...finish, type: 'finish', reason: 'tool_calls' },
  ];
}
const read = (id: string, path: string) => ({ id, name: 'read_file', path });
const list = (id: string, path: string) => ({ id, name: 'list_directory', path });
const inputPath = (request: SourceRequest) => {
  const input = request.input;
  return input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof input.path === 'string'
    ? input.path
    : null;
};
async function fixture(
  model: (workspace: string) => ModelAdapter,
  customSources?: (workspace: string) => ContextSources,
  options: { unmarked?: boolean; context?: Extension['context'] } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tool-batch-freshness-')));
  const workspace = join(root, 'workspace');
  for (const directory of ['', 'apps', 'packages', 'docs'])
    mkdirSync(join(workspace, directory), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{"name":"batch-fixture"}');
  writeFileSync(join(workspace, 'docs/value.txt'), 'original docs evidence');
  writeFileSync(join(workspace, 'AGENTS.md'), 'Original root rule.');
  writeFileSync(join(workspace, 'docs/AGENTS.md'), 'Original local docs rule.');
  const project = createProjectSources({
    workspaceRoot: async () => workspace,
    targetPaths: (request) => (inputPath(request) ? [inputPath(request)!] : []),
  });
  const files = createWorkspaceFiles({ root: workspace });
  const executed: { name: string; path: string }[] = [];
  const tools = createFileTools(files).map((original) => {
    const tool = { ...original } as ToolDefinition & { contextDiscovery?: 'read_only' };
    if (options.unmarked) delete tool.contextDiscovery;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        executed.push({ name: tool.id, path: (args[0] as { path: string }).path });
        return tool.execute(...args);
      },
    };
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    model: model(workspace),
    modelId: 'fixed',
    sources: customSources?.(workspace) ?? project,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [
      {
        id: 'builtin.files',
        version: '1',
        apiMajor: 1,
        tools,
        ...(options.context ? { context: options.context } : {}),
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'batch freshness',
  });
  return {
    workspace,
    store,
    runtime,
    executed,
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Read the original evidence.' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const view = await store.getView('s');
      expect(view.runs[0]!.status).toBe('completed');
      return (await store.listExecutions('s')).filter((execution) => execution.kind === 'tool');
    },
    async close() {
      await runtime.close();
      await files.close();
      await project.dispose();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('trusted readonly discovery completes every mixed Files call once and reaches the next Model', async () => {
  const model = createFixedModel([
    calls(
      read('package', 'package.json'),
      list('apps', 'apps'),
      list('packages', 'packages'),
      list('docs-old', 'docs'),
    ),
    [finish],
  ]);
  const f = await fixture(() => model);
  try {
    const tools = await f.run();
    expect(
      tools
        .map((tool) => ({
          callId: tool.callId,
          status: tool.status,
          dispatched: tool.authorization?.dispatched,
        }))
        .sort((a, b) => a.callId.localeCompare(b.callId)),
    ).toEqual(
      ['package', 'apps', 'packages', 'docs-old']
        .map((callId) => ({ callId, status: 'succeeded' as const, dispatched: true }))
        .sort((a, b) => a.callId.localeCompare(b.callId)),
    );
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[0]!.messages)).not.toContain('Original local docs rule.');
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('Original local docs rule.');
    expect(
      model.requests[1]!.messages.filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId)
        .sort(),
    ).toEqual(['apps', 'docs-old', 'package', 'packages']);
    expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('context_refresh_required');
    expect(f.executed.filter(({ path }) => path === 'package.json')).toHaveLength(1);
    expect(f.executed.filter(({ path }) => path === 'apps')).toHaveLength(1);
    expect(f.executed.filter(({ path }) => path === 'packages')).toHaveLength(1);
    expect(f.executed.filter(({ path }) => path === 'docs')).toHaveLength(1);
    expect(tools).toHaveLength(4);
    for (const callId of ['package', 'apps', 'packages', 'docs-old'])
      expect(tools.find((tool) => tool.callId === callId)).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
      });
  } finally {
    await f.close();
  }
});

for (const change of ['rewrite', 'delete', 'custom-batch'] as const)
  test(`a ${change} of an already used local source retires a call targeting elsewhere`, async () => {
    const original = 'Original local docs rule.';
    const updated = 'Updated local docs rule.';
    let customBody = original;
    const fixed = createFixedModel([
      ...(change === 'custom-batch' ? [calls(read('discover-docs', 'docs/value.txt'))] : []),
      calls(read('consume-docs', 'docs/value.txt')),
      calls(read('elsewhere-stale', 'package.json')),
      calls(read('elsewhere-fresh', 'package.json')),
      [finish],
    ]);
    let requests = 0;
    const f = await fixture(
      (workspace) => ({
        stream(request, options) {
          if (++requests === (change === 'custom-batch' ? 3 : 2)) {
            if (change === 'delete') rmSync(join(workspace, 'docs/AGENTS.md'));
            else if (change === 'rewrite')
              writeFileSync(join(workspace, 'docs/AGENTS.md'), updated);
            else customBody = updated;
          }
          return fixed.stream(request, options);
        },
      }),
      change === 'custom-batch'
        ? () => {
            const captureBatch: NonNullable<ContextSources['captureBatch']> = async (requests) =>
              requests.some((request) => inputPath(request)?.startsWith('docs/'))
                ? [
                    {
                      id: 'host:local-docs',
                      kind: 'host_instruction',
                      role: 'user',
                      placement: 'after_history',
                      scope: 'docs',
                      content: customBody,
                      digest: createHash('sha256').update(customBody).digest('hex'),
                    },
                  ]
                : [];
            return { captureBatch, capture: (request) => captureBatch([request]) };
          }
        : undefined,
    );
    try {
      const tools = await f.run();
      const staleRequestIndex = change === 'custom-batch' ? 2 : 1;
      expect(fixed.requests).toHaveLength(change === 'custom-batch' ? 5 : 4);
      if (change === 'custom-batch')
        expect(tools.find((tool) => tool.callId === 'discover-docs')).toMatchObject({
          status: 'failed',
          authorization: { dispatched: false },
          result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
        });
      expect(JSON.stringify(fixed.requests[staleRequestIndex]!.messages)).toContain(original);
      expect(JSON.stringify(fixed.requests[staleRequestIndex + 1]!.messages)).not.toContain(
        original,
      );
      if (change !== 'delete')
        expect(JSON.stringify(fixed.requests[staleRequestIndex + 1]!.messages)).toContain(updated);
      expect(f.executed).toEqual([
        { name: 'files.read', path: 'docs/value.txt' },
        { name: 'files.read', path: 'package.json' },
      ]);
      expect(tools.find((tool) => tool.callId === 'elsewhere-stale')).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false },
        result: {
          details: {
            code: 'context_refresh_required',
            adapterAttempted: false,
            dispatchCommitted: false,
          },
        },
      });
      expect(tools.find((tool) => tool.callId === 'elsewhere-fresh')).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
      });
      const originalDecision = await f.store.getExecution(
        fixed.requests[staleRequestIndex]!.requestId,
      );
      expect(JSON.stringify(originalDecision!.decisionSource)).toContain(original);
    } finally {
      await f.close();
    }
  });

for (const boundary of ['unmarked', 'extension-source'] as const)
  test(`${boundary} cannot grant new project instruction discovery`, async () => {
    const model = createFixedModel([
      calls(list('unreviewed', 'docs')),
      calls(list('reviewed', 'docs')),
      [finish],
    ]);
    const context: NonNullable<Extension['context']> = {
      async capture(request) {
        return inputPath(request) === 'docs'
          ? [
              {
                id: 'builtin.files:pretend-project',
                kind: 'project_instruction',
                role: 'user',
                placement: 'after_history',
                scope: 'docs',
                content: 'Extension-supplied rule.',
                digest: createHash('sha256').update('Extension-supplied rule.').digest('hex'),
              },
            ]
          : [];
      },
    };
    const f = await fixture(
      () => model,
      undefined,
      boundary === 'unmarked' ? { unmarked: true } : { context },
    );
    try {
      const tools = await f.run();
      expect(model.requests).toHaveLength(3);
      expect(f.executed).toEqual([{ name: 'files.list', path: 'docs' }]);
      expect(tools.find((tool) => tool.callId === 'unreviewed')).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false },
        result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
      });
      expect(tools.find((tool) => tool.callId === 'reviewed')).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
      });
      if (boundary === 'extension-source')
        expect(JSON.stringify(model.requests[1]!.messages)).toContain('Extension-supplied rule.');
    } finally {
      await f.close();
    }
  });
