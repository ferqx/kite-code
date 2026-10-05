import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { JobReconcileResult } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { createLedgerExtension } from './job-reconcile-fixture';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('ledger_fixture_timeout');
    await Bun.sleep(5);
  }
}

test('SIGKILL after persisted Job reference preserves original unknown and explicitly verifies its external ledger', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-job-reconcile-kill-')));
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./job-reconcile-crash-child.ts', import.meta.url)),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    await until(async () => existsSync(join(directory, 'ready.json')));
    child.kill('SIGKILL');
    await child.exited;
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
      expectedStoreId: string;
      executionId: string;
    };
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    store = await openSqliteStore(profile);
    const originalReference = (await store.getExecution(ready.executionId))!.reference;
    const generation = (await store.getSession('s'))!.ownerGeneration;
    await store.recoverSession({
      expectedStoreId: ready.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'interrupt',
      expectedOwnerGeneration: generation,
      decision: 'interrupt',
    });
    const original = structuredClone((await store.getExecution(ready.executionId))!);
    expect(original.status).toBe('outcome_unknown');
    expect(original.reference).toEqual(originalReference);
    let starts = 0,
      queries = 0;
    runtime = createRuntime({
      store,
      extensions: [
        createLedgerExtension(join(directory, 'external-ledger.json'), {
          onStart: () => {
            starts++;
          },
          onQuery: () => {
            queries++;
          },
        }),
      ],
      permissions: {
        async authorize() {
          throw Error('ordinary execution authorizer called');
        },
      },
      authorizeJobReconcile: async () => ({ allowed: true, revision: 'current' }),
    });
    await runtime.getView('s');
    expect(starts + queries).toBe(0);
    const input = {
      expectedStoreId: ready.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'verify',
      executionId: original.id,
      expectedResultRevision: original.resultRevision,
    };
    const proof = await runtime.reconcileJob(input);
    expect(proof.receipt).toMatchObject({
      outcome: 'verified',
      supervision: 'ended',
      evidenceSource: 'adapter_reconcile',
    });
    expect(await store.getExecution(original.id)).toEqual(original);
    expect(starts).toBe(0);
    expect(queries).toBe(1);
    await runtime.reconcileJob(input);
    expect(queries).toBe(1);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}
async function denied(work: Promise<unknown>) {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
}

for (const mode of [
  'static',
  'dynamic',
  'version',
  'missing',
  'deny',
  'default_deny',
  'second_deny',
  'throw',
  'running',
  'unknown',
  'invalid',
  'shutdown',
  'query_cancel',
  'query_cancel_external',
  'cleanup',
  'preflight_shutdown',
] as const) {
  test(`cold Job reconciliation ${mode} queries original effect without reviving execution`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-job-reconcile-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const ledger = join(directory, 'external-ledger.json');
    let starts = 0,
      queries = 0,
      policies = 0,
      factories = 0,
      disposals = 0;
    let resumedModels = 0;
    const held = gate();
    let store = await openSqliteStore(profile);
    let artifacts = createArtifactStore({ store, profile });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const permission = {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    };
    const original = createLedgerExtension(ledger, {
      onStart: () => {
        starts++;
      },
      recovery: mode !== 'missing',
    });
    let runtime = createRuntime({
      store,
      artifacts,
      permissions: permission,
      extensions: [original],
      modelId: 'fixed',
      model: createFixedModel([
        [
          { type: 'tool_call', id: 'launch', name: 'ledger.launch', arguments: '{}' },
          { ...finish, reason: 'tool_calls' },
        ],
        [finish],
      ]),
    });
    let failedClose = false;
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: `file://${directory}`,
        name: 'ledger',
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        commandId: 'create',
        subjectId: 'owner',
        workspaceId: 'w',
        title: 'ledger',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'write ledger once' },
      });
      await runtime.waitForCommand('work');
      await until(async () =>
        (await store.getView('s')).executions.some(
          (e) => e.kind === 'job' && e.status === 'outcome_unknown',
        ),
      );
      const job = (await store.getView('s')).executions.find((e) => e.kind === 'job')!;
      const originalJob = structuredClone(job);
      expect(starts).toBe(1);
      expect(job.runId).toBeNull();
      expect(job.recoveryManifest !== null).toBe(mode !== 'missing');
      await runtime.close();
      store = await openSqliteStore(profile);
      artifacts = createArtifactStore({ store, profile });
      const preflightEntered = gate(),
        preflightRelease = gate();
      let leaseBegins = 0;
      const recoveryStore =
        mode === 'preflight_shutdown'
          ? (new Proxy(store, {
              get(target, key) {
                if (key === 'getJobReconciliationReceipt')
                  return async (input: Parameters<Store['getJobReconciliationReceipt']>[0]) => {
                    const result = await target.getJobReconciliationReceipt(input);
                    preflightEntered.release();
                    await preflightRelease.promise;
                    return result;
                  };
                if (key === 'beginJobReconciliation')
                  return async (input: Parameters<Store['beginJobReconciliation']>[0]) => {
                    leaseBegins++;
                    return target.beginJobReconciliation(input);
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }) as Store)
          : store;
      const extension = createLedgerExtension(ledger, {
        version: mode === 'version' || mode === 'cleanup' ? '2' : '1',
        onStart: () => {
          starts++;
        },
        onQuery: () => {
          queries++;
        },
        ...(mode === 'throw'
          ? {
              query: async () => {
                throw Error('remote query failed');
              },
            }
          : {}),
        ...(mode === 'running'
          ? {
              query: async () => ({
                status: 'observed' as const,
                result: { outcome: 'succeeded' as const, content: 'business replied' },
                supervision: 'running' as const,
                evidence: { running: true },
              }),
            }
          : {}),
        ...(mode === 'unknown'
          ? {
              query: async () => ({
                status: 'observed' as const,
                result: { outcome: 'outcome_unknown' as const, content: 'business still unknown' },
                supervision: 'ended' as const,
                evidence: { ended: true },
              }),
            }
          : {}),
        ...(mode === 'invalid'
          ? {
              query: async () =>
                ({
                  status: 'observed',
                  supervision: 'ended',
                  result: {
                    outcome: 'succeeded',
                    content: 'invalid body descriptor',
                    modelContent: null,
                  },
                  evidence: {},
                }) as unknown as JobReconcileResult,
            }
          : {}),
        ...(mode === 'shutdown'
          ? {
              query: async () => {
                held.release();
                return new Promise<never>(() => {});
              },
            }
          : {}),
      });
      // The recovery resolver owns only query assets; the Model is used solely by later explicit work.
      runtime = createRuntime({
        store: recoveryStore,
        artifacts,
        permissions: permission,
        modelId: 'explicit-next',
        model: {
          async *stream() {
            resumedModels++;
            yield finish;
          },
        },
        extensions:
          mode === 'dynamic' || mode === 'cleanup' || mode === 'preflight_shutdown'
            ? []
            : [extension],
        ...(mode === 'dynamic' || mode === 'cleanup' || mode === 'preflight_shutdown'
          ? {
              resolveRecoveryJobConfiguration: async () => {
                factories++;
                return {
                  extension,
                  dispose: async () => {
                    disposals++;
                    if (mode === 'cleanup') throw Error('dispose failed');
                  },
                };
              },
            }
          : {}),
        ...(mode === 'default_deny'
          ? {}
          : {
              authorizeJobReconcile: async () => {
                policies++;
                return {
                  allowed: mode !== 'deny' && !(mode === 'second_deny' && policies > 1),
                  revision: 'current',
                };
              },
            }),
      });
      const coldCursor = (await store.getMetadata()).lastChangeCursor;
      await runtime.getView('s');
      await runtime.getCommand('work');
      expect((await store.getMetadata()).lastChangeCursor).toBe(coldCursor);
      expect(queries + policies + factories).toBe(0);
      const input = {
        expectedStoreId,
        commandId: 'verify',
        subjectId: 'owner',
        sessionId: 's',
        executionId: job.id,
        expectedResultRevision: job.resultRevision,
      };
      if (mode === 'preflight_shutdown') {
        const pending = runtime.reconcileJob(input).catch((error: unknown) => error);
        await preflightEntered.promise;
        const closing = runtime.close();
        expect(runtime.getLifecycleState().state).toBe('draining');
        expect(policies + factories + queries + leaseBegins).toBe(0);
        preflightRelease.release();
        expect(((await pending) as { code?: string }).code).toBe('runtime_draining');
        await closing;
        expect(policies + factories + queries + leaseBegins).toBe(0);
        expect(runtime.getLifecycleState().state).toBe('closed');
        store = await openSqliteStore(profile);
        expect(await store.getCommand('verify')).toBeNull();
        expect(await store.getExecution(job.id)).toEqual(originalJob);
        return;
      }
      for (const changed of [
        { subjectId: 'foreign' },
        { expectedStoreId: 'foreign-store' },
        { expectedResultRevision: '999' },
      ]) {
        await denied(runtime.reconcileJob({ ...input, ...changed }));
      }
      expect(queries + policies + factories).toBe(0);
      if (mode === 'missing' || mode === 'deny' || mode === 'default_deny') {
        await denied(runtime.reconcileJob(input));
        expect(queries).toBe(0);
        expect(factories).toBe(0);
        expect(await store.getCommand('verify')).toBeNull();
        return;
      }
      if (mode === 'second_deny') {
        await denied(runtime.reconcileJob(input));
        expect(queries).toBe(0);
        expect(policies).toBe(2);
        const accepted = await runtime.reconcileJob(input);
        expect(accepted.status).toBe('accepted');
        expect(policies).toBe(2);
        expect(await store.getExecution(job.id)).toEqual(originalJob);
        return;
      }
      if (mode === 'shutdown' || mode === 'query_cancel' || mode === 'query_cancel_external') {
        // Separate finite abort-aware query proves shutdown can drain admission.
        runtime = await (async () => {
          await runtime.close();
          store = await openSqliteStore(profile);
          artifacts = createArtifactStore({ store, profile });
          const abortExtension = createLedgerExtension(ledger);
          abortExtension.jobs![0]!.reconcile = async (_reference, context) => {
            queries++;
            held.release();
            await new Promise<void>((resolve) => {
              context.signal.addEventListener('abort', () => resolve(), { once: true });
              if (context.signal.aborted) resolve();
            });
            context.signal.throwIfAborted();
            return { status: 'unavailable', reason: 'aborted' };
          };
          return createRuntime({
            store,
            artifacts,
            extensions: [abortExtension],
            permissions: permission,
            authorizeJobReconcile: async () => ({ allowed: true, revision: 'current' }),
          });
        })();
        const pending = runtime.reconcileJob(input);
        await held.promise;
        expect(runtime.getLifecycleState().busy).toBe(true);
        const rejection = denied(pending);
        if (mode === 'query_cancel' || mode === 'query_cancel_external') {
          const cancel = {
            expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            commandId: 'cancel-query',
            targetCommandId: input.commandId,
          };
          if (mode === 'query_cancel_external') await store.cancelCommand(cancel);
          else await runtime.cancelCommand(cancel);
          await rejection;
          expect((await store.getCommand(input.commandId))?.status).toBe('accepted');
          expect((await store.getCommand(input.commandId))?.receipt).toBeNull();
          expect((await store.getCommand(input.commandId))?.cancelRequestedAt).not.toBeNull();
          expect(await store.getExecution(job.id)).toEqual(originalJob);
        }
        await runtime.close();
        await rejection;
        expect(starts).toBe(1);
        store = await openSqliteStore(profile);
        artifacts = createArtifactStore({ store, profile });
        runtime = createRuntime({
          store,
          artifacts,
          extensions: [
            createLedgerExtension(ledger, {
              onStart: () => {
                starts++;
              },
              onQuery: () => {
                queries++;
              },
            }),
          ],
          permissions: permission,
          modelId: 'explicit-next',
          model: {
            async *stream() {
              resumedModels++;
              yield finish;
            },
          },
          authorizeJobReconcile: async () => ({ allowed: true, revision: 'current' }),
        });
        const unknown = await runtime.reconcileJob(input);
        expect(unknown.status).toBe('accepted');
        expect(queries).toBe(1);
        const originalQuery = structuredClone(unknown);
        await store.recoverSession({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'explicit-interrupt',
          expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
          decision: 'interrupt',
        });
        expect(await store.getCommand(input.commandId)).toEqual(originalQuery);
        const secondProof = await runtime.reconcileJob({
          ...input,
          commandId: 'another-verification',
        });
        expect(secondProof.receipt).toMatchObject({ outcome: 'verified', supervision: 'ended' });
        expect(queries).toBe(2);
        expect(resumedModels).toBe(0);
        await runtime.submitCommand({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'explicit-next',
          request: { kind: 'run.start', content: 'new explicit work' },
        });
        await runtime.waitForCommand('explicit-next');
        expect(resumedModels).toBe(1);
        expect((await store.getView('s')).runs).toHaveLength(2);
        expect(await store.getCommand(input.commandId)).toEqual(originalQuery);
        const untouched = (await store.getExecution(job.id))!;
        expect(untouched.status).toBe(originalJob.status);
        expect(untouched.result).toEqual(originalJob.result);
        expect(untouched.resultRevision).toBe(originalJob.resultRevision);
        expect(untouched.resultAcceptance).toEqual(originalJob.resultAcceptance);
        expect(untouched.delivery).toBe('suppressed');
        expect(starts).toBe(1);
        expect(queries).toBe(2);
        await runtime.reconcileJob(input);
        expect(queries).toBe(2);
        return;
      }
      const pending = runtime.reconcileJob(input);
      input.executionId = 'mutated-after-call';
      const command = await pending;
      expect(command.status).toBe('applied');
      const verified = mode === 'static' || mode === 'dynamic';
      expect(command.receipt).toMatchObject({
        executionId: job.id,
        resultRevision: job.resultRevision,
        outcome: verified ? 'verified' : 'unresolved',
        evidenceSource: 'adapter_reconcile',
      });
      if (mode === 'invalid')
        expect(command.receipt).toMatchObject({
          reason: 'job_reconciliation_result_invalid',
          result: null,
        });
      expect(queries).toBe(mode === 'version' || mode === 'cleanup' ? 0 : 1);
      const same = { ...input, executionId: job.id };
      const duplicate = await runtime.reconcileJob(same);
      expect(duplicate.receipt).toEqual(command.receipt);
      const policyCount = policies;
      await runtime.reconcileJob(same);
      expect(policies).toBe(policyCount);
      expect(starts).toBe(1);
      expect(await store.getExecution(job.id)).toEqual({
        ...originalJob,
        delivery: originalJob.delivery === 'pending' ? 'suppressed' : originalJob.delivery,
        deliveryReason:
          originalJob.delivery === 'pending'
            ? 'explicit_reconciliation'
            : originalJob.deliveryReason,
      });
      expect((await store.getView('s')).runs).toHaveLength(1);
      expect(resumedModels).toBe(0);
      if (verified) {
        await runtime.submitCommand({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'explicit-next',
          request: { kind: 'run.start', content: 'new explicit work after proof' },
        });
        await runtime.waitForCommand('explicit-next');
        expect(resumedModels).toBe(1);
        const untouched = (await store.getExecution(job.id))!;
        expect(untouched.resultAcceptance).toEqual(originalJob.resultAcceptance);
        expect(untouched.result).toEqual(originalJob.result);
        expect(untouched.resultRevision).toBe(originalJob.resultRevision);
        expect(untouched.delivery).toBe('suppressed');
        expect(untouched.deliveryReason).toBe('explicit_reconciliation');
        expect((await store.getView('s')).runs).toHaveLength(2);
        expect(starts).toBe(1);
        expect(queries).toBe(1);
      }
      if (mode === 'cleanup') {
        expect(disposals).toBe(1);
        expect(runtime.getLifecycleState().reasons).toContain('cleanup');
        await denied(runtime.close());
        failedClose = true;
        expect(runtime.getLifecycleState().state).toBe('drain_failed');
        expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
        expect(disposals).toBe(1);
      } else {
        await runtime.close();
        expect(disposals).toBe(mode === 'dynamic' ? 1 : 0);
      }
    } finally {
      if (!failedClose) await runtime.close().catch(() => {});
      await artifacts.close().catch(() => {});
      await store.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
}
