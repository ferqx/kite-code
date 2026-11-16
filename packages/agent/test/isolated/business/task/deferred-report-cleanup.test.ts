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
for (const [retainedPolicy, settlement] of [
  [false, 'cancel'],
  [false, 'ordinary-input'],
  [true, 'cancel'],
  [true, 'ordinary-input'],
] as const) {
  test(`${retainedPolicy ? 'retained-policy' : 'queue-only'} deferred report preserves resource ownership through ${settlement}`, async () => {
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
      childCalls = 0,
      policyApplies = 0,
      configurations = 0,
      disposed = 0;
    const parentInputs: string[] = [];
    const parent: ModelAdapter = {
      async *stream(request) {
        parentInputs.push(JSON.stringify(request.messages));
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
        childCalls++;
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
      afterTurn: retainedPolicy
        ? {
            async authorize(input) {
              if (input.phase === 'apply') policyApplies++;
              return { allowed: input.phase === 'request', revision: 'original-policy' };
            },
          }
        : undefined,
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
      // The live child retains its original resources even after the parent finishes.
      expect(disposed).toBe(0);
      expect(parentCalls).toBe(2);
      release();
      const report = await until(async () => {
        const mail = (await store.listAgentMessages(identity)).items.find(
          (item) => item.kind === 'result' && item.state === 'accepted',
        );
        const command = mail && (await store.getCommand(mail.id));
        return (command?.receipt as { outcome?: string } | undefined)?.outcome === 'report_deferred'
          ? command!
          : null;
      });
      expect(report.receipt).toMatchObject({
        outcome: 'report_deferred',
        reason: 'idle_authorization_required',
      });
      if (retainedPolicy) await until(async () => (policyApplies > 0 ? true : null));
      else await until(async () => (disposed === 1 ? true : null));
      // A deferred policy lease is idle; queue-only mail needs no old configuration.
      await until(async () => (!runtime.getLifecycleState().busy ? true : null));
      expect(disposed).toBe(retainedPolicy ? 0 : 1);
      expect(policyApplies).toBe(retainedPolicy ? 1 : 0);
      expect(parentCalls).toBe(2);
      if (settlement === 'cancel') {
        await runtime.cancelSession({
          ...identity,
          commandId: 'cancel-all',
          includeBackground: true,
        });
        expect((await store.getCommand(report.id))?.status).toBe('rejected');
        expect(parentInputs.some((input) => input.includes('Child result'))).toBe(false);
      } else {
        await runtime.submitCommand({
          ...identity,
          commandId: 'next',
          request: { kind: 'run.start', content: 'Use the result in this conversation' },
        });
        const next = await runtime.waitForCommand('next', { timeoutMs: 8000 });
        const nextRun = (next.receipt as { runId: string }).runId;
        expect(parentInputs.filter((input) => input.includes('Child result'))).toHaveLength(1);
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
    expect(parentCalls).toBe(settlement === 'cancel' ? 2 : 3);
    expect(childCalls).toBe(1);
    expect(disposed).toBe(1);
  }, 20000);
}
