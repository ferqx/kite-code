import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { OperationRef } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('more than a thousand sequential children and independent authorization checks reuse one hot slot after failure and cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-child-history-'));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let enteredCancel!: () => void;
  const cancellationEntered = new Promise<void>((resolve) => {
    enteredCancel = resolve;
  });
  let started = 0,
    reviews = 0,
    effects = 0,
    settled = 0;
  const refs: OperationRef[] = [];
  const statuses: string[] = [];
  const child: ModelAdapter = {
    async *stream(request, { signal }) {
      if (request.messages.some((message) => message.role === 'tool')) {
        yield finish;
        return;
      }
      const index = started++;
      if (index === 0) throw new Error('Actual child model failure');
      if (index === 1) {
        enteredCancel();
        yield { type: 'text_delta', text: 'Waiting for the exact original child cancellation' };
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return;
      }
      yield { type: 'tool_call', id: `effect-${index}`, name: 'fixture.effect', arguments: '{}' };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  let runtime!: ReturnType<typeof createRuntime>;
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize(request) {
        return request.definitionId === 'fixture.effect'
          ? {
              allowed: false,
              revision: 'owned',
              check: { request: { task: 'Exact child effect' } },
            }
          : { allowed: true, revision: 'owned' };
      },
    },
    authorizationCheck: {
      id: 'reviewer',
      version: '1',
      modelId: 'review-model',
      model: {
        async *stream(request) {
          reviews++;
          expect(request.tools).toEqual([]);
          yield {
            type: 'text_delta',
            text: '{"decision":"approve_once","reason":"Exact child effect"}',
          };
          yield finish;
        },
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.effect'],
        maxConcurrentSubagents: 1,
        snapshot: {},
      },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Actual harmless reviewed effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'Actual reviewed effect completed' };
            },
          },
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Sequential actual child lifecycle',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              for (let i = 0; i < 1003; i++) {
                const options = {
                  key: `child-${i}`,
                  request: {
                    kind: 'agent' as const,
                    configurationId: 'child',
                    input: { content: 'Perform the exact harmless effect' },
                  },
                };
                const ref = await context.operations.ensure(options);
                refs.push(ref);
                if (i === 1) {
                  await cancellationEntered;
                  const active = (await store.getView(ref.childSessionId!)).runs.find(
                    (run) => run.isActive,
                  )!;
                  await context.operations.interruptAgent!(ref, {
                    commandId: 'cancel-exact-child',
                    targetRunId: active.id,
                  });
                }
                const actual = await context.operations.wait(ref, {
                  signal: context.signal,
                  timeoutMs: 10000,
                });
                statuses.push(actual!.status);
                settled++;
                if (i % 100 === 0 || i === 1002)
                  expect(await context.operations.ensure(options)).toEqual(ref);
              }
              return {
                outcome: 'succeeded',
                content: 'All 1003 original child lifecycles settled',
              };
            },
          },
        ],
      },
    ],
  });
  let db: Database | undefined;
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'History',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'Run the actual sequential delegations' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 240000 });
    expect(
      JSON.stringify(
        (await store.listExecutions('s')).find((execution) => execution.callId === 'delegate')
          ?.result,
      ),
    ).not.toContain('child_scope_too_large');
    const terminal = (await store.getView('s')).runs[0]!;
    if (terminal.status !== 'completed')
      console.error(
        'child_history_terminal',
        JSON.stringify({
          reason: terminal.reason,
          settled,
          reviews,
          effects,
          delegate: (await store.listExecutions('s')).find(
            (execution) => execution.callId === 'delegate',
          )?.result,
        }),
      );
    expect(terminal.status).toBe('completed');
    expect(settled).toBe(1003);
    expect(statuses.slice(0, 2)).toEqual(['failed', 'cancelled']);
    expect(statuses.slice(2).every((status) => status === 'succeeded')).toBe(true);
    expect(reviews).toBe(1001);
    expect(effects).toBe(1001);
    expect(new Set(refs.map((ref) => ref.childSessionId)).size).toBe(1003);
    db = new Database(join(root, 'test', 'core.db'));
    expect(
      (db.query("SELECT count(*) AS n FROM session WHERE root_id='s'").get() as { n: number }).n,
    ).toBe(1004);
    expect(
      (
        db.query("SELECT count(*) AS n FROM run WHERE session_id<>'s' AND is_active=1").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .query(
            "SELECT count(*) AS n FROM run WHERE session_id<>'s' AND deadline_at<>CAST(started_at AS INTEGER)+1800000",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(parent.requests).toHaveLength(2);
    await runtime.close();
    expect(runtime.getLifecycleState().state).toBe('closed');
  } finally {
    db?.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 250000);
