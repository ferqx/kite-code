import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { ContextSource } from '../../../src/context';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const calls = (...names: string[]): ModelEvent[] => [
  ...names.map((name) => ({
    type: 'tool_call' as const,
    id: crypto.randomUUID(),
    name,
    arguments: '{}',
  })),
  { ...finish, reason: 'tool_calls' },
];
const definition = (id: string, execute: ToolDefinition['execute']): ToolDefinition => ({
  id,
  version: '1',
  description: 'Harmless context fixture',
  inputSchema: { type: 'object' },
  execute,
});
async function rejected(p: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture(
  extensions: Extension[],
  responses: ModelEvent[][],
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-context-contributions-'))),
    store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' }),
    model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    extensions,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  const session = (sessionId: string) =>
    runtime.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
      subjectId: 'owner',
    });
  await session('s');
  const submit = (commandId: string, sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      sessionId,
      commandId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: commandId },
    });
  const done = async (commandId: string) => {
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    return store.getRun((command.receipt as { runId: string }).runId);
  };
  return {
    store,
    runtime,
    model,
    expectedStoreId,
    session,
    submit,
    done,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('scoped business context reaches Model as user data; same-decision record change fences later Tool and preserves public source proof', async () => {
  const keys = new Map<string, string>();
  let foreignExecution = '',
    effects = 0,
    captures = 0,
    queryExecution = '';
  const callerSource: ContextSource = {
    id: 'fixture:business',
    kind: 'business',
    scope: 's',
    digest: 'initial',
    content: 'initial',
    role: 'system',
  };
  const records = [
    { contentType: 'fixture.record', contentVersion: 1, schema: { type: 'object' } },
  ];
  const ext: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    records,
    tools: [
      definition('fixture.writer', async (_input, context) => {
        await context.records.write({
          key: keys.get('s')!,
          expectedRevision: '1',
          contentType: 'fixture.record',
          contentVersion: 1,
          value: { version: 2 },
          executable: true,
        });
        return { outcome: 'succeeded', content: 'source changed' };
      }),
      definition('fixture.effect', async () => {
        effects++;
        return { outcome: 'succeeded', content: 'effect' };
      }),
    ],
    context: {
      async capture(request, context) {
        captures++;
        expect(request.sessionId).toBe(context.sessionId);
        expect('owner' in context).toBe(false);
        expect('operations' in context).toBe(false);
        expect('write' in context.records).toBe(false);
        if (request.sessionId === 's' && foreignExecution)
          await rejected(context.getExecution(foreignExecution), 'permission_denied');
        const record = await context.records.get(keys.get(request.sessionId)!);
        expect(record!.extensionId).toBe('fixture');
        callerSource.scope = request.sessionId;
        callerSource.digest = await semanticDigest(record!.value);
        callerSource.content = JSON.stringify(record!.value);
        return [callerSource];
      },
    },
    queries: [
      {
        id: 'proof',
        version: '1',
        description: 'Read original source proof',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' },
        async execute(_input, context) {
          const execution = await context.getExecution(queryExecution);
          return [
            {
              id: 'proof',
              extensionId: 'fixture',
              contentType: 'fixture.proof',
              contentVersion: 1,
              summary: 'Original source proof',
              payload: JSON.parse(JSON.stringify(execution)),
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  const peer: Extension = { id: 'peer', version: '1', apiMajor: 1, records };
  const f = await fixture(
    [ext, peer],
    [[finish], calls('fixture.writer', 'fixture.effect'), [finish]],
    {
      async initializeRunRequirements(input) {
        const key = `run/${input.run.id}/business`;
        keys.set(input.session.id, key);
        for (const namespace of ['fixture', 'peer'])
          await (await input.forExtension(namespace)).records.create({
            key,
            contentType: 'fixture.record',
            contentVersion: 1,
            value: { version: namespace === 'fixture' ? 1 : 999 },
          });
        return [];
      },
      sources: {
        async capture() {
          return [
            {
              id: 'project:instructions',
              kind: 'instructions',
              scope: 'w',
              digest: 'trusted',
              content: 'Trusted project instructions',
            },
          ];
        },
      },
    },
  );
  try {
    await f.session('other');
    await f.submit('other-work', 'other');
    await f.done('other-work');
    foreignExecution = (await f.store.listExecutions('other'))[0]!.id;
    await f.submit('work');
    const run = await f.done('work');
    expect(run!.status).toBe('completed');
    expect(effects).toBe(0);
    const main = f.model.requests.slice(1);
    expect(main).toHaveLength(2);
    for (const [index, request] of main.entries()) {
      const business = request.messages.find((m) => m.sourceIds?.includes('fixture:business'))!;
      expect(business.role).toBe('user');
      expect(business.content).toBe(JSON.stringify({ version: index + 1 }));
      expect(
        request.messages.find((m) => m.sourceIds?.includes('project:instructions'))!.role,
      ).toBe('system');
    }
    const executions = await f.store.listExecutions('s'),
      later = executions.find((e) => e.definitionId === 'fixture.effect')!;
    expect(later.status).toBe('failed');
    expect((later.result as { content: string }).content).toBe('context_refresh_required');
    queryExecution = later.id;
    const beforeCaptures = captures,
      beforeModels = f.model.requests.length,
      beforeCursor = (await f.store.getMetadata()).lastChangeCursor;
    const query = () =>
      f.runtime.queryExtension({
        sessionId: 's',
        extensionId: 'fixture',
        queryId: 'proof',
        input: {},
        subjectId: 'owner',
        expectedStoreId: f.expectedStoreId,
      });
    const proof = (await query())[0]!.payload as { sources: { id: string; digest: string }[] };
    expect(proof.sources).toContainEqual({
      id: 'fixture:business',
      digest: await semanticDigest({ version: 1 }),
    });
    expect(
      proof.sources.every((source) => Object.keys(source).sort().join(',') === 'digest,id'),
    ).toBe(true);
    proof.sources[0]!.digest = 'caller-mutated';
    callerSource.content = 'caller-mutated';
    callerSource.digest = 'caller-mutated';
    const reread = (await query())[0]!.payload as { sources: { id: string; digest: string }[] };
    expect(reread.sources).toContainEqual({
      id: 'fixture:business',
      digest: await semanticDigest({ version: 1 }),
    });
    await f.runtime.getView('s');
    await f.store.getSession('s');
    expect(captures).toBe(beforeCaptures);
    expect(f.model.requests).toHaveLength(beforeModels);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeCursor);
  } finally {
    await f.close();
  }
});

test('invalid contribution namespace, collisions and finite source budgets fail before Model or Tool effects', async () => {
  for (const mode of ['prefix', 'collision', 'count', 'aggregate', 'format'] as const) {
    let effects = 0;
    const source = (id: string): ContextSource => ({
      id,
      kind: 'fixture',
      scope: 's',
      digest: '1',
      content: 'bounded',
    });
    const ext: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        definition('fixture.effect', async () => {
          effects++;
          return { outcome: 'succeeded', content: 'effect' };
        }),
      ],
      context: {
        async capture() {
          if (mode === 'prefix') return [source('peer:stolen')];
          if (mode === 'format')
            return [{ ...source('fixture:malformed'), content: 42 as unknown as string }];
          if (mode === 'count')
            return Array.from({ length: 129 }, (_, i) => source(`fixture:${i}`));
          return [source('fixture:collision')];
        },
      },
    };
    const aggregate: Extension[] =
      mode === 'aggregate'
        ? [
            ext,
            ...['second', 'third'].map(
              (id): Extension => ({
                id,
                version: '1',
                apiMajor: 1,
                context: {
                  async capture() {
                    return Array.from({ length: 128 }, (_, i) => source(`${id}:${i}`));
                  },
                },
              }),
            ),
          ]
        : [ext];
    const f = await fixture(
      aggregate,
      [calls('fixture.effect')],
      mode === 'collision'
        ? {
            sources: {
              async capture() {
                return [{ ...source('fixture:collision'), digest: 'other' }];
              },
            },
          }
        : {},
    );
    try {
      await f.submit('work');
      const run = await f.done('work');
      expect(run!.status).toBe('failed');
      expect(effects).toBe(0);
      expect(f.model.requests).toHaveLength(0);
      expect(await f.store.listExecutions('s')).toHaveLength(0);
      expect(run!.reason).toBe(
        mode === 'format'
          ? 'context_source_invalid'
          : mode === 'prefix'
            ? 'extension_source_namespace_mismatch'
            : mode === 'collision'
              ? 'context_refresh_required'
              : 'context_source_budget_exceeded',
      );
    } finally {
      await f.close();
    }
  }
});

test('each trusted Run selects its own extension context hook without substituting another binding', async () => {
  let selected = 0;
  const counts = [0, 0];
  const f = await fixture([], [[finish], [finish]], {
    async resolveRunConfiguration() {
      const index = selected++;
      return {
        model: f.model,
        modelId: 'fixed',
        snapshot: { binding: index + 1 },
        extensions: [
          {
            id: 'perrun',
            version: String(index + 1),
            apiMajor: 1,
            context: {
              async capture(request, context) {
                counts[index]!++;
                expect(context.sessionId).toBe(request.sessionId);
                expect('owner' in context).toBe(false);
                return [
                  {
                    id: 'perrun:business',
                    kind: 'business',
                    scope: request.sessionId,
                    digest: String(index + 1),
                    content: `binding-${index + 1}`,
                    role: 'system' as const,
                  },
                ];
              },
            },
          },
        ],
      };
    },
  });
  try {
    for (const id of ['first', 'second']) {
      await f.submit(id);
      expect((await f.done(id))!.status).toBe('completed');
    }
    expect(f.model.requests).toHaveLength(2);
    for (const [index, request] of f.model.requests.entries()) {
      const message = request.messages.find((m) => m.sourceIds?.includes('perrun:business'))!;
      expect(message.role).toBe('user');
      expect(message.content).toBe(`binding-${index + 1}`);
    }
    expect(counts.every((count) => count > 0)).toBe(true);
  } finally {
    await f.close();
  }
});
