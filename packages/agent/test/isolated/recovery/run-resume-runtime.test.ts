import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import type { CommandRecord, RunRecord } from '../../../src/storage/types';
import { binding } from './run-resume-fixture';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('resume_fixture_timeout');
    await Bun.sleep(5);
  }
}
for (const mode of [
  'reconciled_model',
  'planned_model',
  'planned_large',
  'continuation_planned',
  'continuation_running',
  'continuation_failed',
  'length_response',
  'length_planned',
  'length_history',
  'retry_planned',
  'retry_failed',
  'retry_lineage',
  'running_model',
  'running_large',
  'compression_running',
  'compression_pending',
  'compression_published',
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
    const seedMode =
      mode === 'reconciled_model'
        ? 'running_model'
        : [
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
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
      };
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      if (mode === 'running_model') {
        const observer = await openSqliteStore(profile);
        try {
          const liveInput = {
            ...ready,
            commandId: 'while-owner-live',
            sessionId: 's',
            subjectId: 'owner',
          };
          const state = await observer.verifyRunResume(liveInput);
          const execution = await observer.getExecution(ready.executionId);
          const error = await observer
            .beginRunResume({
              ...liveInput,
              instanceId: 'blocked-observer',
              checkpoint: state.checkpoint!,
            })
            .catch((error) => error);
          expect(error.code).toBe('owner_busy');
          expect(await observer.getExecution(ready.executionId)).toEqual(execution);
          expect(await observer.getCommand('while-owner-live')).toBeNull();
        } finally {
          await observer.close();
        }
      }
      child.kill('SIGKILL');
      await child.exited;
      store = await openSqliteStore(profile);
      if (mode === 'reconciled_model') {
        const result = await store.reconcileSession({
          ...ready,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'reconcile',
        });
        ready.expectedOwnerGeneration = result.report!.generation;
        expect(await store.getRun(ready.runId)).toMatchObject({
          status: 'interrupted',
          isActive: false,
          reason: 'owner_lost',
        });
        expect(await store.getExecution(ready.executionId)).toMatchObject({ status: 'failed' });
      }
      let resolves = 0,
        disposals = 0;
      let releasePreflight!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      let releaseContinuation!: () => void;
      const continuationGate = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      releaseHeld = () => {
        releasePreflight();
        releaseContinuation();
      };
      const recoveryInputs: { command: Readonly<CommandRecord>; run: Readonly<RunRecord> }[] = [];
      const preparationDisposals: number[] = [];
      const originalWork = (await store.getCommand('work'))!;
      const originalRun = (await store.getRun(ready.runId))!;
      let entered = false;
      let historicalPages = 0;
      const wrapped = new Proxy(store, {
        get(target, key) {
          if (key === 'readRunResumeExecutionPage')
            return async (input: Parameters<Store['readRunResumeExecutionPage']>[0]) => {
              if (input.kind === 'prior_models') historicalPages++;
              return target.readRunResumeExecutionPage(input);
            };
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
                        content: 'Continue current work: next requested work',
                      }
                    : {
                        kind: 'input.steer',
                        targetRunId: ready.runId,
                        contextSelectionId: session.contextSelectionId,
                        content: 'Follow up: new exact input',
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
      });
      runtime = createRuntime({
        store: wrapped,
        ...(mode === 'follow_up'
          ? { resolveRunConfiguration: async () => binding(directory, seedMode) }
          : {}),
        permissions: binding(directory, seedMode).permissions!,
        artifacts: createArtifactStore({ profile, store: wrapped }),
        resolveRecoveryRunConfiguration: async (input) => {
          recoveryInputs.push({ command: input.command, run: input.run });
          // Continue restores A again after its first recovery lease is released.
          // Keep that separate preparation outside the original resume assertions.
          if (mode === 'follow_up' && !input.run.isActive) await continuationGate;
          resolves++;
          const preparation = preparationDisposals.length;
          preparationDisposals.push(0);
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
              preparationDisposals[preparation]!++;
              if (mode === 'cleanup') throw Error('owned disposer failure');
            },
          };
        },
      });
      const original = (await store.getView('s')).executions;
      const before = readFileSync(join(directory, 'ledger'), 'utf8');
      if (mode.startsWith('continuation_')) {
        const snapshot = await runtime.readModelInput({
          expectedStoreId: ready.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          executionId: ready.executionId,
        });
        expect(
          snapshot.request.messages.every((message) => message.continuation === undefined),
        ).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain('opaqueopaque');
      }
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
      if (mode === 'follow_up') {
        await until(async () => recoveryInputs.length === 2);
        expect(recoveryInputs[0]!.command).toEqual(originalWork);
        expect(recoveryInputs[0]!.run).toEqual(originalRun);
        expect(recoveryInputs[1]!.command).toEqual(originalWork);
        expect(recoveryInputs[1]!.run).toMatchObject({
          id: ready.runId,
          originCommandId: originalWork.id,
          originStoreId: ready.expectedStoreId,
          rootWorkCommandId: originalWork.rootWorkCommandId,
          rootWorkSeq: originalWork.rootWorkSeq,
          configuration: originalRun.configuration,
          isActive: false,
          status: 'completed',
        });
        expect(preparationDisposals).toEqual([1]);
      }
      expect(await runtime.resumeRun(input)).toEqual(receipt);
      expect(resolves).toBe(1);
      expect(historicalPages).toBe(0);
      if (mode === 'follow_up') {
        releaseContinuation();
        await until(async () => {
          const saved = await store!.getCommand('follow-up');
          if (saved?.status !== 'applied') return false;
          const runId = (saved.receipt as { runId: string }).runId;
          return (await store!.getRun(runId))?.isActive === false;
        });
        const followup = (await store.getCommand('follow-up'))!;
        const receipt = followup.receipt as { runId: string; businessCommandId: string };
        const business = await store.getCommand(receipt.businessCommandId);
        expect(followup.receipt).toMatchObject({ outcome: 'human_input_applied' });
        expect(business).toMatchObject({ status: 'applied', rootWorkCommandId: 'work' });
        expect(business?.receipt).toMatchObject({ runId: receipt.runId });
        expect(await store.getRun(receipt.runId)).toMatchObject({
          originCommandId: business!.id,
          rootWorkCommandId: 'work',
          status: 'completed',
        });
        const user = (await store.listMessages('s')).find(
          (message) => message.runId === receipt.runId && message.role === 'user',
        );
        expect(user).toMatchObject({
          content: 'Continue current work: next requested work',
          sourceIds: [business!.id],
        });
        await until(async () => disposals === 2);
        expect(resolves).toBe(2);
        expect(preparationDisposals).toEqual([1, 1]);
        expect(await runtime.resumeRun(input)).toEqual(await promise);
        expect(resolves).toBe(2);
        expect((await store.getView('s')).runs.length).toBe(2);
        expect((await store.getCommand('follow-up'))!.status).toBe('applied');
      }
      const ledger = readFileSync(join(directory, 'ledger'), 'utf8').trim().split('\n');
      expect(ledger.filter((v) => v.startsWith('effect:')).length).toBe(
        seedMode === 'repeat_failure'
          ? 5
          : [
                'completion',
                'length_response',
                'length_planned',
                'retry_planned',
                'retry_failed',
                'retry_lineage',
                'running_model',
                'running_large',
              ].includes(seedMode)
            ? 0
            : 1,
      );
      expect(ledger.filter((v) => v.startsWith('model:')).length).toBe(
        ['continuation_running', 'continuation_failed'].includes(seedMode)
          ? 3
          : seedMode === 'retry_lineage'
            ? 5
            : ['compression_running', 'compression_pending'].includes(seedMode)
              ? 4
              : seedMode === 'compression_published'
                ? 3
                : seedMode === 'length_history'
                  ? 3
                  : seedMode === 'repeat_failure'
                    ? 5
                    : ['steer', 'follow_up'].includes(mode)
                      ? 2
                      : seedMode === 'completion'
                        ? 1
                        : 2,
      );
      if (mode.startsWith('continuation_')) {
        expect(ledger.filter((value) => value.startsWith('continuation:'))).toHaveLength(
          mode === 'continuation_planned' ? 1 : 2,
        );
        const inputs = await runtime.listModelInputs({
          expectedStoreId: ready.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
        });
        for (const entry of inputs.items) {
          const snapshot = await runtime.readModelInput({
            expectedStoreId: ready.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            executionId: entry.executionId,
          });
          expect(
            snapshot.request.messages.every((message) => message.continuation === undefined),
          ).toBe(true);
          expect(JSON.stringify(snapshot)).not.toContain('opaqueopaque');
        }
      }
      if (mode === 'repeat_failure')
        expect(await store.getRun(ready.runId)).toMatchObject({
          status: 'cancelled',
          reason: 'repeated_tool_failure',
        });
      else expect((await store.getRun(ready.runId))!.status).toBe('completed');
      const after = (await store.getView('s')).executions;
      if (mode === 'retry_lineage') {
        expect(
          after.find((execution) => execution.id === ready.executionId)!.decisionSource,
        ).toMatchObject({ retry: { attempt: 4 } });
        expect(
          after.filter((execution) => execution.kind === 'model').at(-1)!.decisionSource,
        ).toMatchObject({
          retry: { previousExecutionId: ready.executionId, attempt: 5, maxAttempts: null },
        });
      }
      if (
        [
          'running_model',
          'running_large',
          'retry_failed',
          'compression_running',
          'continuation_running',
          'continuation_failed',
        ].includes(seedMode)
      ) {
        expect(after.find((execution) => execution.id === ready.executionId)).toMatchObject({
          status: 'failed',
          result: { incomplete: true },
        });
        expect(
          after
            .filter((execution) => execution.kind === 'model' && execution.status === 'succeeded')
            .every((execution) => execution.id !== ready.executionId),
        ).toBe(true);
      }
      if (seedMode.startsWith('compression_')) {
        const selected = await store.getModelContext({
          expectedStoreId: ready.expectedStoreId,
          sessionId: 's',
        });
        expect(selected.compression).not.toBeNull();
        if (seedMode === 'compression_published')
          expect(selected.compression!.modelExecutionId).toBe(ready.executionId);
        else expect(selected.compression!.modelExecutionId).not.toBe(ready.executionId);
      }
      for (const ex of original.filter((e) => e.status === 'succeeded'))
        expect(after.find((e) => e.id === ex.id)).toEqual(ex);
      if (
        seedMode.startsWith('planned_') ||
        ['length_planned', 'length_history', 'retry_planned', 'continuation_planned'].includes(
          seedMode,
        )
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

for (const mode of [
  'prior_refresh',
  'last_refresh',
  'prior_preserve',
  'last_preserve',
  'prior_refresh_legacy',
  'prior_preserve_legacy',
] as const)
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
      if (mode.endsWith('_legacy')) {
        const db = new Database(join(directory, 'data', 'test', 'core.db'));
        try {
          const row = db
            .query<{ decision_source_json: string }, [string]>(
              'SELECT decision_source_json FROM execution WHERE id=?',
            )
            .get(ready.executionId)!;
          const source = JSON.parse(row.decision_source_json);
          expect(source.sourceBody).toBeUndefined();
          // Controlled old-format fixture: four genuine failures and four
          // pre-dispatch refreshes were indistinguishable in v1 checkpoints.
          source.continuation.version = 1;
          source.continuation.sourceRequests = [];
          delete source.continuation.sourceRequestJournal;
          source.continuation.toolFailureStreak = {
            signature: JSON.stringify(['effect', '{}']),
            count: 4,
          };
          db.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
            JSON.stringify(source),
            ready.executionId,
          ]);
        } finally {
          db.close(true);
        }
      }
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
      expect(refresh).toHaveLength(
        mode.includes('preserve') ? (mode.endsWith('_legacy') ? 0 : 1) : 4,
      );
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
