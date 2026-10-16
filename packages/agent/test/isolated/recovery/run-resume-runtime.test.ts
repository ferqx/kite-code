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
  'length_response',
  'length_planned',
  'length_history',
  'retry_planned',
  'retry_failed',
  'tool_result',
  'repeat_failure',
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
      if (mode === 'initializer' || mode === 'dispatched' || mode === 'retry_failed') {
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
        seedMode === 'repeat_failure'
          ? 5
          : ['completion', 'length_response', 'length_planned', 'retry_planned'].includes(seedMode)
            ? 0
            : 1,
      );
      expect(ledger.filter((v) => v.startsWith('model:')).length).toBe(
        seedMode === 'length_history'
          ? 3
          : seedMode === 'repeat_failure'
            ? 5
            : ['steer', 'follow_up'].includes(mode)
              ? 2
              : seedMode === 'completion'
                ? 1
                : 2,
      );
      if (mode === 'repeat_failure')
        expect(await store.getRun(ready.runId)).toMatchObject({
          status: 'cancelled',
          reason: 'repeated_tool_failure',
        });
      else expect((await store.getRun(ready.runId))!.status).toBe('completed');
      const after = (await store.getView('s')).executions;
      for (const ex of original.filter((e) => e.status === 'succeeded'))
        expect(after.find((e) => e.id === ex.id)).toEqual(ex);
      if (
        seedMode.startsWith('planned_') ||
        ['length_planned', 'length_history', 'retry_planned'].includes(seedMode)
      ) {
        const resumed = after.find((e) => e.id === ready.executionId)!;
        expect(resumed.status).toBe('succeeded');
        expect(resumed.input).toEqual(original.find((e) => e.id === ready.executionId)!.input);
      }
      if (seedMode.startsWith('length_')) {
        const segment = original.find(
          (execution) =>
            execution.kind === 'model' &&
            (execution.result as { finishReason?: string } | null)?.finishReason === 'length',
        )!;
        expect(segment.result).toMatchObject({
          content: 'saved length segment',
          finishReason: 'length',
          toolCalls: [],
        });
        expect(after.find((execution) => execution.id === segment.id)).toEqual(segment);
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
      // The deliberate disposer failure must retain its original profile owner.
      // Windows correctly refuses deleting that still-held directory.
      if (mode !== 'cleanup') rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

for (const mode of ['prior_refresh', 'last_refresh', 'prior_preserve', 'last_preserve'] as const)
  test(`genuine SIGKILL reconstructs trusted Tool failure streak at ${mode}`, async () => {
    const { streakBinding } = await import('./run-resume-streak-fixture');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-streak-resume-')));
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-streak-crash-child.ts', import.meta.url)),
        directory,
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stderr = new Response(child.stderr).text();
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await until(async () => {
        if (child.exitCode !== null) throw Error(`streak_child_exit:${await stderr}`);
        return existsSync(join(directory, 'ready.json'));
      });
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(await stderr).toBe('');
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
      };
      store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
      runtime = createRuntime({
        store,
        permissions: streakBinding(directory, mode).permissions!,
        resolveRecoveryRunConfiguration: async () => streakBinding(directory, mode),
      });
      const original = await store.listExecutions('s');
      const originalTools = original.filter((execution) => execution.kind === 'tool');
      const refresh = originalTools.filter(
        (execution) => execution.authorization?.dispatched === false,
      );
      expect(refresh).toHaveLength(mode.includes('preserve') ? 1 : 4);
      expect(
        refresh.every(
          (execution) =>
            (execution.result as { content?: string }).content === 'context_refresh_required',
        ),
      ).toBe(true);
      const oldEffects = readFileSync(join(directory, 'ledger'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:'));
      expect(oldEffects).toHaveLength(mode.includes('preserve') ? 4 : 0);
      const receipt = await runtime.resumeRun({
        ...ready,
        sessionId: 's',
        commandId: 'resume',
        subjectId: 'owner',
      });
      expect(receipt.receipt).toMatchObject({ outcome: 'run_resumed', runId: ready.runId });
      await until(async () => !(await store!.getRun(ready.runId))!.isActive);
      const run = await store.getRun(ready.runId);
      expect(run).toMatchObject(
        mode.includes('preserve')
          ? { status: 'cancelled', reason: 'repeated_tool_failure' }
          : { status: 'completed' },
      );
      const effects = readFileSync(join(directory, 'ledger'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:'));
      expect(effects).toHaveLength(mode.includes('preserve') ? 5 : 1);
      expect(new Set(effects).size).toBe(effects.length);
      expect(effects.slice(0, oldEffects.length)).toEqual(oldEffects);
      for (const execution of originalTools)
        expect(await store.getExecution(execution.id)).toEqual(execution);
      const completedEffects = (await store.listExecutions('s')).filter(
        (execution) => execution.kind === 'tool' && execution.authorization?.dispatched === true,
      );
      expect(completedEffects).toHaveLength(mode.includes('preserve') ? 5 : 1);
      expect(
        completedEffects.every(
          (execution) =>
            (execution.result as { details?: { dispatchCommitted?: boolean } }).details
              ?.dispatchCommitted === false,
        ),
      ).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await runtime?.close();
      await store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
