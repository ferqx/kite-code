import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import type { JobDefinition, JobEvent } from '../../../../src/extensions';
import { openSqliteStore } from '../../../../src/sqlite';
import { createShellExtension } from '../../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function calls(...items: [string, Record<string, unknown>][]): ModelEvent[] {
  return [
    ...items.map(([name, input], index) => ({
      type: 'tool_call' as const,
      id: `call-${index}`,
      name,
      arguments: JSON.stringify(input),
    })),
    { ...finish, reason: 'tool_calls' },
  ];
}
async function fixture(responses: ModelEvent[][], startFailure = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-reference-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const model = createFixedModel(responses);
  let starts = 0,
    cancels = 0,
    probes = 0;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'controlled original Job',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      appendFileSync(join(root, 'effects'), 'start\n');
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      yield {
        type: 'terminal',
        result: startFailure
          ? {
              outcome: 'outcome_unknown',
              content: 'effect result unavailable after confirmed process exit',
            }
          : { outcome: 'succeeded', content: 'original result' },
        supervision: 'ended',
      };
    },
    async cancel() {
      cancels++;
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    extensions: [
      createShellExtension({ job }),
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read',
            version: '1',
            description: 'independent read',
            inputSchema: { type: 'object' },
            async execute() {
              probes++;
              return { outcome: 'succeeded', content: 'independent read completed' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'test',
    expectedStoreId,
  });
  await runtime.createSession({
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'test',
    subjectId: 'owner',
    expectedStoreId,
  });
  const run = async () => {
    await runtime.submitCommand({
      commandId: 'original',
      sessionId: 's',
      subjectId: 'owner',
      expectedStoreId,
      request: { kind: 'run.start', content: 'inspect the exact original Shell' },
    });
    await runtime.waitForCommand('original');
    return runtime.getView('s');
  };
  return {
    root,
    store,
    model,
    runtime,
    run,
    counts: () => ({ starts, cancels, probes }),
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const tool of ['shell_read', 'shell_wait', 'shell_stop'])
  test(`${tool} missing reference remains a correctable failure in the actual Loop`, async () => {
    const input = {
      shell_id: 'noop-probe',
      ...(tool === 'shell_stop' ? { command_id: 'exact-stop' } : {}),
    };
    const f = await fixture([
      calls([tool, input], ['fixture.read', {}]),
      [
        { type: 'text_delta', text: 'Reference unavailable; independent inspection completed.' },
        finish,
      ],
    ]);
    try {
      const view = await f.run();
      expect(view.runs[0]!.status).toBe('completed');
      const failed = view.executions.find(
        (e) => e.definitionId === tool.replace('shell_', 'shell.'),
      )!;
      expect(failed.status).toBe('failed');
      expect(failed.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'shell_reference_not_found', shellId: 'noop-probe' },
      });
      expect(view.executions.find((e) => e.definitionId === 'fixture.read')!.status).toBe(
        'succeeded',
      );
      expect(f.model.requests).toHaveLength(2);
      const feedback = f.model.requests[1]!.messages.find(
        (m) => m.role === 'tool' && m.content.includes('noop-probe'),
      )!;
      expect(feedback.content).toContain('did not start or stop');
      expect(feedback.content).toContain('do not invent an ID');
      expect(f.counts()).toEqual({ starts: 0, cancels: 0, probes: 1 });
    } finally {
      await f.close();
    }
  });

test('wrong reference does not alter or restart an existing original Job', async () => {
  const f = await fixture([
    calls(['shell_execute', { key: 'original-shell', command: 'controlled command' }]),
    calls(
      ['shell_read', { shell_id: 'wrong-shell' }],
      ['shell_stop', { shell_id: 'wrong-shell', command_id: 'wrong-stop' }],
    ),
    calls(['shell_read', { shell_id: 'original-shell' }]),
    [finish],
  ]);
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('completed');
    const jobs = view.executions.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('succeeded');
    expect(jobs[0]!.result).toMatchObject({ content: 'original result' });
    expect(f.counts()).toEqual({ starts: 1, cancels: 0, probes: 0 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('start\n');
    const lastInput = f.model.requests.at(-1)!.messages;
    expect(lastInput.some((m) => m.role === 'tool' && m.content.includes(jobs[0]!.id))).toBe(true);
  } finally {
    await f.close();
  }
});

test('an attempted Shell with unknown business outcome remains unknown after confirmed cleanup', async () => {
  const f = await fixture(
    [calls(['shell_execute', { key: 'original-shell', command: 'controlled command' }]), [finish]],
    true,
  );
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('failed');
    expect(view.executions.some((e) => e.kind === 'job' && e.status === 'outcome_unknown')).toBe(
      true,
    );
    expect(f.model.requests).toHaveLength(1);
    expect(f.counts().starts).toBe(1);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('start\n');
  } finally {
    await f.close();
  }
});

test('a failure reading local reference storage stays unknown in the actual Runtime', async () => {
  const f = await fixture([calls(['shell_read', { shell_id: 'original' }]), [finish]]);
  const read = f.store.getExtensionRecord.bind(f.store);
  f.store.getExtensionRecord = async (input) => {
    if (input.extensionId === 'builtin.shell' && input.key === 'shell/original')
      throw Error('original_reference_storage_unavailable');
    return read(input);
  };
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('failed');
    expect(view.executions.find((e) => e.definitionId === 'shell.read')!.status).toBe(
      'outcome_unknown',
    );
    expect(f.model.requests).toHaveLength(1);
    expect(f.counts()).toEqual({ starts: 0, cancels: 0, probes: 0 });
  } finally {
    f.store.getExtensionRecord = read;
    await f.close();
  }
});
