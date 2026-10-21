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
for (const settlement of ['cancel', 'continue-active', 'continue-pump'] as const) {
  test(`deferred report binding is ${settlement === 'cancel' ? 'released by cancellation' : `retained for its exact ${settlement} continuation`}`, async () => {
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
        const listAccepted = store.listAcceptedCommands.bind(store);
        const readCommand = store.getCommand.bind(store);
        let holdPump = true;
        let holdBusiness = settlement === 'continue-pump';
        let observedTerminal = false;
        store.listAcceptedCommands = async (...args) => {
          if (args[0] !== identity.sessionId) return listAccepted(...args);
          if (holdPump) return [];
          const commands = await listAccepted(...args);
          if (settlement === 'continue-active')
            return commands.filter((command) => command.kind !== 'job.report.continue');
          return holdBusiness
            ? commands.filter((command) => command.kind === 'job.report.continue')
            : commands;
        };
        store.getCommand = async (id) => {
          const command = await readCommand(id);
          if (
            id === report.id &&
            (command?.receipt as { reason?: string } | undefined)?.reason ===
              'continuation_admission'
          ) {
            // The next turn lets the deferred watcher handle the terminal read,
            // while both the successor report pump and business Run remain gated.
            setTimeout(() => {
              observedTerminal = true;
            }, 0);
          }
          return command;
        };
        for (const [commandId, content] of [
          ['pause', '暂停当前任务 work'],
          ['continue', '继续当前任务 work'],
        ])
          await runtime.submitCommand({
            ...identity,
            commandId: commandId!,
            request: { kind: 'run.start', content: content! },
          });
        await until(async () => (observedTerminal ? true : null));
        const original = await readCommand(report.id);
        expect(original).toMatchObject({
          status: 'rejected',
          receipt: { reason: 'continuation_admission' },
        });
        const successorId = (original!.receipt as { continuationCommandId: string })
          .continuationCommandId;
        expect(await readCommand(successorId)).toMatchObject({
          status: 'accepted',
          kind: 'job.report.continue',
          request: { originalReportCommandId: report.id },
        });
        expect(disposed).toBe(0);
        holdPump = false;
        if (holdBusiness) {
          await until(async () => {
            const successor = await readCommand(successorId);
            return (successor?.receipt as { outcome?: string } | undefined)?.outcome ===
              'report_deferred'
              ? true
              : null;
          });
          expect(disposed).toBe(0);
          holdBusiness = false;
        }
        await runtime.waitForCommand('continue', { timeoutMs: 8000 });
        await until(async () =>
          (await readCommand(successorId))?.status === 'applied' ? true : null,
        );
        expect((await readCommand(successorId))?.status).toBe('applied');
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
