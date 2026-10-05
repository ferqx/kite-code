import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { binding } from './run-resume-fixture';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('resume_fixture_timeout');
    await Bun.sleep(5);
  }
}
for (const mode of [
  'planned_model',
  'planned_large',
  'tool_result',
  'completion',
  'large',
  'version',
  'cleanup',
  'closing',
  'steer',
  'follow_up',
  'cancel_preparation',
  'concurrent_preparation',
  'initializer',
  'dispatched',
] as const)
  test(`genuine SIGKILL active Run resumes exact durable ${mode} boundary`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-run-resume-')));
    const seedMode = [
      'version',
      'cleanup',
      'closing',
      'steer',
      'follow_up',
      'cancel_preparation',
      'concurrent_preparation',
    ].includes(mode)
      ? 'completion'
      : mode;
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
        directory,
        seedMode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let releaseHeld = () => {};
    try {
      await until(async () => existsSync(join(directory, 'ready.json')));
      child.kill('SIGKILL');
      await child.exited;
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
      };
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      let resolves = 0,
        disposals = 0;
      let releasePreflight!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePreflight = resolve;
        releaseHeld = resolve;
      });
      let entered = false;
      const wrapped = ['closing', 'steer', 'follow_up'].includes(mode)
        ? new Proxy(store, {
            get(target, key) {
              if (key === 'finishRun' && ['steer', 'follow_up'].includes(mode) && !entered)
                return async (input: Parameters<Store['finishRun']>[0]) => {
                  entered = true;
                  const session = (await target.getSession('s'))!;
                  await runtime!.submitCommand({
                    expectedStoreId: ready.expectedStoreId,
                    subjectId: 'owner',
                    commandId: mode === 'follow_up' ? 'follow-up' : 'steer',
                    sessionId: 's',
                    request:
                      mode === 'follow_up'
                        ? {
                            kind: 'input.follow_up',
                            afterRunId: ready.runId,
                            contextSelectionId: session.contextSelectionId,
                            content: 'next requested work',
                          }
                        : {
                            kind: 'input.steer',
                            targetRunId: ready.runId,
                            contextSelectionId: session.contextSelectionId,
                            content: 'new exact input',
                          },
                  });
                  return target.finishRun(input);
                };
              if (key === 'verifyRunResume' && mode === 'closing')
                return async (input: Parameters<Store['verifyRunResume']>[0]) => {
                  const state = await target.verifyRunResume(input);
                  entered = true;
                  await gate;
                  return state;
                };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : store;
      runtime = createRuntime({
        store: wrapped,
        ...(mode === 'follow_up'
          ? { resolveRunConfiguration: async () => binding(directory, seedMode) }
          : {}),
        permissions: binding(directory, seedMode).permissions!,
        artifacts: createArtifactStore({ profile, store: wrapped }),
        resolveRecoveryRunConfiguration: async () => {
          resolves++;
          if (mode === 'cancel_preparation' || mode === 'concurrent_preparation') {
            entered = true;
            await gate;
          }
          const config = binding(directory, seedMode);
          return {
            ...config,
            ...(mode === 'version' ? { snapshot: { changed: true } } : {}),
            dispose: async () => {
              disposals++;
              if (mode === 'cleanup') throw Error('owned disposer failure');
            },
          };
        },
      });
      const original = (await store.getView('s')).executions;
      const before = readFileSync(join(directory, 'ledger'), 'utf8');
      await runtime.getView('s');
      expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(before);
      expect(resolves).toBe(0);
      const input = {
        expectedStoreId: ready.expectedStoreId,
        runId: ready.runId,
        expectedOwnerGeneration: ready.expectedOwnerGeneration,
        commandId: 'resume',
        subjectId: 'owner',
        sessionId: 's',
      };
      const promise = runtime.resumeRun(input);
      if (mode === 'initializer' || mode === 'dispatched') {
        const error = await promise.catch((e) => e);
        expect(error.code).toBe(
          mode === 'initializer'
            ? 'run_initialization_incomplete'
            : 'run_resume_checkpoint_unavailable',
        );
        expect(resolves).toBe(0);
        expect(await store.getCommand('resume')).toBeNull();
        expect((await store.getRun(ready.runId))!.isActive).toBe(true);
        expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(before);
        return;
      }
      if (mode === 'closing') {
        await until(async () => entered);
        const shutdown = runtime.tryBeginShutdown('cancel');
        releasePreflight();
        const error = await promise.catch((e) => e);
        if (!shutdown.accepted) throw Error('shutdown_not_accepted');
        await shutdown.completion;
        expect(error.code).toBe('runtime_draining');
        expect(resolves).toBe(0);
        return;
      }
      if (mode === 'concurrent_preparation') {
        await until(async () => entered);
        const accepted = await runtime.resumeRun(input);
        expect(accepted.status).toBe('accepted');
        expect(accepted.receipt).toBeNull();
        const error = await runtime
          .resumeRun({
            ...input,
            commandId: 'other-resume',
            expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
          })
          .catch((e) => e);
        releasePreflight();
        expect(error.code).toBe('run_resume_busy');
        expect(await store.getCommand('other-resume')).toBeNull();
        expect(resolves).toBe(1);
        releasePreflight();
      }
      if (mode === 'cancel_preparation') {
        await until(async () => entered);
        await runtime.cancelCommand({
          expectedStoreId: ready.expectedStoreId,
          subjectId: 'owner',
          commandId: 'cancel',
          sessionId: 's',
          targetCommandId: 'resume',
        });
        releasePreflight();
        const error = await promise.catch((e) => e);
        expect(error.code).toBe('cancel_requested');
        await until(async () => disposals === 1);
        expect((await store.getCommand('resume'))!.status).toBe('accepted');
        expect((await store.getRun(ready.runId))!.isActive).toBe(true);
        expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(before);
        return;
      }
      if (mode === 'version') {
        const error = await promise.catch((e) => e);
        expect(error.code).toBe('run_configuration_mismatch');
        expect(resolves).toBe(1);
        expect(disposals).toBe(1);
        expect((await store.getRun(ready.runId))!.isActive).toBe(true);
        expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(before);
        return;
      }
      const receipt = await promise;
      expect(receipt.receipt).toMatchObject({
        outcome: 'run_resumed',
        runId: ready.runId,
        originalCommandId: 'work',
      });
      await until(async () => !(await store!.getRun(ready.runId))!.isActive);
      await until(async () => disposals === 1);
      expect(await runtime.resumeRun(input)).toEqual(receipt);
      expect(resolves).toBe(1);
      if (mode === 'follow_up') {
        await until(async () =>
          (await store!.getView('s')).runs.some(
            (run) => run.originCommandId === 'follow-up' && !run.isActive,
          ),
        );
        expect((await store.getView('s')).runs.length).toBe(2);
        expect((await store.getCommand('follow-up'))!.status).toBe('applied');
      }
      const ledger = readFileSync(join(directory, 'ledger'), 'utf8').trim().split('\n');
      expect(ledger.filter((v) => v.startsWith('effect:')).length).toBe(
        seedMode === 'completion' ? 0 : 1,
      );
      expect(ledger.filter((v) => v.startsWith('model:')).length).toBe(
        ['steer', 'follow_up'].includes(mode) ? 2 : seedMode === 'completion' ? 1 : 2,
      );
      const after = (await store.getView('s')).executions;
      for (const ex of original.filter((e) => e.status === 'succeeded'))
        expect(after.find((e) => e.id === ex.id)).toEqual(ex);
      if (seedMode.startsWith('planned_')) {
        const resumed = after.find((e) => e.id === ready.executionId)!;
        expect(resumed.status).toBe('succeeded');
        expect(resumed.input).toEqual(original.find((e) => e.id === ready.executionId)!.input);
      }
      if (seedMode === 'large') {
        const model = original.find((e) => e.kind === 'model')!;
        expect(model.result).toHaveProperty('modelOutput');
        expect(model.decisionSource).toHaveProperty('sourceBody');
        expect(ledger).toContain('effect:80000');
      }
      if (mode === 'cleanup') {
        const close = runtime.tryBeginShutdown('cancel');
        if (!close.accepted) throw Error('shutdown_not_accepted');
        const error = await close.completion!.catch((e: unknown) => e as { code: string });
        expect((error as { code?: string }).code).toBe('shutdown_cleanup_unconfirmed');
        expect(runtime.getLifecycleState()).toMatchObject({ state: 'drain_failed', busy: true });
        expect(await store.getMetadata()).toHaveProperty('storeId');
      }
    } finally {
      releaseHeld();
      child.kill('SIGKILL');
      await child.exited;
      await runtime?.close().catch(() => {});
      await store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
