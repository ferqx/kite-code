import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import type { Extension } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const calls = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > end) throw Error('attached_job_settlement_deadline');
    await Bun.sleep(5);
  }
}
for (const scenario of ['attached', 'detached', 'cancel', 'wake_race', 'close'] as const)
  test(`Task settlement preserves ${scenario} effect ownership after its Model finishes`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-job-settlement-')));
    const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
    let release!: () => void;
    const signals = new WeakMap<object, AbortSignal>();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0,
      cancellations = 0,
      childCalls = 0;
    const jobs: Extension = {
      id: 'jobs',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'launch',
          version: '1',
          description: 'Start two independently supervised bounded Jobs',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            for (const key of ['one', 'two'])
              await context.operations.ensure({
                key,
                cancellation: scenario === 'detached' ? 'detached' : 'attached',
                request: { kind: 'job', definitionId: 'held', definitionVersion: '1', input: {} },
              });
            return { outcome: 'succeeded', content: 'Jobs accepted' };
          },
        },
      ],
      jobs: [
        {
          id: 'held',
          version: '1',
          description: 'Finite controlled process permit owner',
          inputSchema: { type: 'object' },
          resources: { slot: 'process' },
          async start(_input, context) {
            starts++;
            const handle = { reference: { executionId: context.executionId } };
            signals.set(handle, context.signal);
            return handle;
          },
          async *observe(handle) {
            await gate;
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: {
                outcome: signals.get(handle)!.aborted ? 'cancelled' : 'succeeded',
                content: 'Owned effect ended',
              },
            };
          },
          async cancel() {
            cancellations++;
            release();
            return { status: 'stopped' };
          },
          async dispose() {},
        },
      ],
    };
    const child: ModelAdapter = {
      async *stream(request) {
        childCalls++;
        for (const event of request.messages.some((message) => message.role === 'tool')
          ? [finish]
          : calls('launch', {}))
          yield event;
      },
    };
    let parentCalls = 0;
    const parent: ModelAdapter = {
      async *stream() {
        parentCalls++;
        for (const event of parentCalls === 1
          ? calls('task', {
              key: 'child',
              role: 'worker',
              input: { content: 'launch supervised Jobs' },
            })
          : [finish])
          yield event;
      },
    };
    let staleWakeExercised = false;
    if (scenario === 'wake_race') {
      const inspect = store.inspectChildSettlement.bind(store);
      store.inspectChildSettlement = async (input) => {
        const snapshot = await inspect(input);
        if (snapshot.pending && !staleWakeExercised) {
          staleWakeExercised = true;
          release();
          const carrier = await store.getExecution(input.executionId);
          await until(
            () => store.listExecutions(carrier!.childSessionId!),
            (rows) =>
              rows.filter((row) => row.kind === 'job').every((row) => row.status === 'succeeded'),
          );
        }
        return snapshot;
      };
    }
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      processConcurrency: 1,
      extensions: [
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'child', description: 'trusted fixture' }],
        }),
        jobs,
      ],
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['launch'],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'settlement',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'start child' },
      });
      const carrier = (
        await until(
          () => store.listExecutions('root'),
          (rows) => rows.some((row) => !!row.childSessionId),
        )
      ).find((row) => row.childSessionId)!;
      await until(
        () => store.getView(carrier.childSessionId!),
        (view) => view.runs.some((run) => !run.isActive && run.status === 'completed'),
      );
      const childJobs = (await store.listExecutions(carrier.childSessionId!)).filter(
        (row) => row.kind === 'job',
      );
      expect(childJobs).toHaveLength(2);
      if (scenario !== 'wake_race') {
        expect(childJobs.filter((row) => row.status === 'running')).toHaveLength(1);
        expect(childJobs.filter((row) => row.status === 'planned')).toHaveLength(1);
      }
      if (scenario === 'close') {
        await runtime.close();
        const db = new Database(join(directory, 'data/test/core.db'), { readonly: true });
        const active = db
          .query(
            "SELECT COUNT(*) AS n FROM execution WHERE kind='job' AND state IN ('planned','dispatching','running')",
          )
          .get() as { n: number };
        db.close();
        expect(active.n).toBe(0);
        expect(cancellations).toBeGreaterThan(0);
        return;
      }
      expect(childCalls).toBe(2);
      if (scenario === 'attached') {
        const root = (await store.getSession('root'))!;
        const input = {
          expectedStoreId,
          executionId: carrier.id,
          owner: {
            sessionId: 'root',
            instanceId: root.ownerInstanceId!,
            generation: root.ownerGeneration,
          },
        };
        expect((await store.inspectChildSettlement(input)).pending).toBe(true);
        const wrongStore = await store
          .inspectChildSettlement({ ...input, expectedStoreId: 'other-store' })
          .then(
            () => null,
            (error) => error.code,
          );
        expect(wrongStore).toBe('store_identity_mismatch');
        const wrongOwner = await store
          .inspectChildSettlement({ ...input, owner: { ...input.owner, generation: '0' } })
          .then(
            () => null,
            (error) => error.code,
          );
        expect(wrongOwner).toBe('owner_changed');
      }
      if (scenario === 'detached') {
        await until(
          () => store.getExecution(carrier.id),
          (row) => row?.status === 'succeeded',
        );
        expect(starts).toBe(1);
      } else if (scenario !== 'wake_race') {
        expect((await store.getExecution(carrier.id))?.status).toBe('running');
        if (scenario === 'cancel') {
          const receipt = await runtime.cancelExecution({
            expectedStoreId,
            sessionId: 'root',
            subjectId: 'owner',
            commandId: 'stop',
            executionId: carrier.id,
          });
          expect(receipt.receipt).toMatchObject({ outcome: 'cancel_requested' });
          await until(
            () => store.getExecution(carrier.id),
            (row) => row?.status === 'cancelled',
          );
          await until(
            () => store.listExecutions(carrier.childSessionId!),
            (rows) =>
              rows.filter((row) => row.kind === 'job').every((row) => row.status === 'cancelled'),
          );
          expect(cancellations).toBeGreaterThan(0);
          expect(starts).toBe(1);
        }
      }
      release();
      await until(
        () => store.getExecution(carrier.id),
        (row) => row?.status === (scenario === 'cancel' ? 'cancelled' : 'succeeded'),
      );
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect((await store.getView('root')).runs[0]?.status).toBe('completed');
      expect(childCalls).toBe(2);
      if (scenario === 'wake_race') expect(staleWakeExercised).toBe(true);
    } finally {
      release();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
