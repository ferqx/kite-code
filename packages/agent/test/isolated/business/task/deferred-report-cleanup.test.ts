import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('deferred_report_cleanup_fixture_timeout');
    await Bun.sleep(5);
  }
}
for (const settlement of ['cancel', 'ordinary-input'] as const) {
  test(`deferred report binding is ${settlement === 'cancel' ? 'released by cancellation' : `retained until the next ordinary input consumes its exact result`}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-deferred-report-cleanup-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    let release!: () => void;
    const childGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parentCalls = 0,
      configurations = 0,
      disposed = 0;
    const parent: ModelAdapter = {
      async *stream() {
        if (parentCalls++ === 0) {
          yield {
            type: 'tool_call',
            id: crypto.randomUUID(),
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: 'Complete independently' }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Original parent done' };
          yield finish;
        }
      },
    };
    const child: ModelAdapter = {
      async *stream() {
        await childGate;
        yield { type: 'text_delta', text: 'Child result' };
        yield finish;
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
    });
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: parent,
      modelId: 'parent',
      modelConcurrency: 3,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      extensions: [task],
      async resolveRunConfiguration() {
        const isOriginal = configurations++ === 0;
        return {
          model: parent,
          modelId: 'parent',
          snapshot: {},
          toolIds: task.tools!.map((tool) => tool.id),
          dispose: async () => {
            if (isOriginal) disposed++;
          },
        };
      },
      childConfigurations: [
        { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'fixture',
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'fixture',
      });
      await runtime.submitCommand({
        ...identity,
        commandId: 'work',
        request: { kind: 'run.start', content: 'coordinate' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      release();
      const report = await until(
        async () =>
          (await store.listPendingJobReports(identity)).commands.find(
            (command) => (command.receipt as { outcome?: string }).outcome === 'report_deferred',
          ) ?? null,
      );
      expect(disposed).toBe(0);
      if (settlement === 'cancel') {
        await runtime.cancelSession({
          ...identity,
          commandId: 'cancel-all',
          includeBackground: true,
        });
        expect((await store.getCommand(report.id))?.status).toBe('rejected');
      } else {
        await runtime.submitCommand({
          ...identity,
          commandId: 'next',
          request: { kind: 'run.start', content: 'Use the result in this conversation' },
        });
        const next = await runtime.waitForCommand('next', { timeoutMs: 8000 });
        const nextRun = (next.receipt as { runId: string }).runId;
        expect(await store.getCommand(report.id)).toMatchObject({
          status: 'applied',
          receipt: { mode: 'active', runId: nextRun },
        });
        expect((await store.getView('root')).runs.map((run) => run.originCommandId)).toEqual([
          'work',
          'next',
        ]);
      }
      await until(async () => (disposed === 1 ? true : null));
      expect(disposed).toBe(1);
      // The report watcher and the existing 250 ms dispatch poll drain independently.
      await until(async () => (!runtime.getLifecycleState().busy ? true : null));
      expect(runtime.getLifecycleState().busy).toBe(false);
    } finally {
      release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
