import { describe, expect, test } from 'bun:test';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { canonicalModelJsonV1 } from '@kite/builtin-runtime/model';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  cleanupWindowsSandboxRuntimeDirNoSpawnV1,
  createPosixSandboxRuntimeRootsForPreparationV1,
  createSandboxRuntimeDirForPreparationV1,
  createWindowsSandboxRuntimeDirForPreparationV1,
  LocalSandboxExecutionProviderV1,
  removeDirectoryTreeAtV1,
  SandboxPreparationArtifactErrorV1,
  SandboxPreparationArtifactStoreV1,
  sandboxPreparationIntentDigestV1,
  sandboxRuntimeDirForPreparationV1,
  sandboxRuntimeRootsForPreparationV1,
} from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import type {
  NonDynamicOperationIdV1,
  PreparedSandboxExecutionV1,
  PreparedToolInvocationV1,
  SandboxPreparationLifecycleV1,
  SandboxPreparationV1,
  ToolPipelineAttemptAcknowledgementV1,
} from '@kite/runtime-spi';
import { createAppToolPipelineSandboxLifecycleV1 } from '#app/bootstrap/runtime/tool-pipeline-sandbox-lifecycle';
import {
  reconcilePendingSandboxPreparationsAfterCrashV1,
  reconcileSandboxPreparationAfterCrashV1,
  SandboxExecutionGrantAuthorityV1,
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
} from '#app/sandbox/runtime-execution';
import { reduceRuntimeState } from '#runtime-support/runtime-state26-reducer';
import { ScriptableFakeSandboxExecutionProviderV1 } from '../helpers/sandbox-execution-provider';
import {
  createBuiltinSandboxExecutionConsumerForTestV1,
  createCompletedPreparedProcessPortForTestV1,
} from '../helpers/sandbox-executor';

function createTestRuntimeDir(workspace: string, label: string): string {
  const preparationDigest = `sandbox-provider-test:${label}:${randomUUID()}`;
  return process.platform === 'win32'
    ? createWindowsSandboxRuntimeDirForPreparationV1(workspace, preparationDigest)
    : createSandboxRuntimeDirForPreparationV1(workspace, preparationDigest);
}

describe('SandboxExecutionProviderV1', () => {
  test.skipIf(process.platform === 'win32')(
    'confirms an allocating intent made no POSIX runtime when its private base is absent',
    () => {
      const isolatedTemp = mkdtempSync(join(tmpdir(), 'kite-sandbox-absent-runtime-base-'));
      const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-absent-runtime-workspace-'));
      const previousTmpdir = process.env.TMPDIR;
      try {
        process.env.TMPDIR = isolatedTemp;
        const roots = sandboxRuntimeRootsForPreparationV1(workspace, 'sha256:absent-runtime');
        expect(existsSync(join(isolatedTemp, 'openpx-sandbox-runtime'))).toBe(false);
        expect(cleanupPosixSandboxRuntimeRootsNoSpawnV1(roots)).toBe(true);
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(isolatedTemp, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test('Windows runtime cleanup accepts an allocation already removed with its empty base', () => {
    const isolatedTemp = mkdtempSync(join(tmpdir(), 'kite-windows-runtime-cleanup-'));
    const workspace = mkdtempSync(join(tmpdir(), 'kite-windows-runtime-workspace-'));
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = isolatedTemp;
      const runtimeRoot = createWindowsSandboxRuntimeDirForPreparationV1(
        workspace,
        'sha256:already-removed',
      );

      expect(cleanupWindowsSandboxRuntimeDirNoSpawnV1(runtimeRoot)).toBe(true);
      expect(existsSync(join(isolatedTemp, 'openpx-sandbox-runtime'))).toBe(false);
      expect(cleanupWindowsSandboxRuntimeDirNoSpawnV1(runtimeRoot)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      rmSync(isolatedTemp, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('allocating prepare is zero-call without durable intent lifecycle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: () => ({ ok: false, failure: { code: 'fake_denied', message: 'deny' } }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      });
      const result = await consumer({
        workspace,
        command: 'printf should-not-run',
        sandboxInvocationIdentity: {
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          invocationId: 'invocation',
          attempt: 1,
          effectiveEffectsDigest: 'effects',
          admissionDigest: 'admission',
          cancellationCorrelation: 'tool-call',
        },
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(fake.calls()).toEqual({ prepare: 0, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('allocating grant cannot be issued without acknowledged intent', () => {
    const authority = new SandboxExecutionGrantAuthorityV1();
    const preparation = samplePreparation(process.cwd());
    expect(() => authority.issue({ preparation, resourceSemantics: 'allocating' })).toThrow(
      'durable intent acknowledgement',
    );
  });

  test('backend qualification stays after intent ack and every pre-prepare exit records abandonment', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      for (const failure of ['resolver', 'semantics', 'grant'] as const) {
        const sequence: string[] = [];
        const grants = new SandboxExecutionGrantAuthorityV1();
        const provider = new ScriptableFakeSandboxExecutionProviderV1({
          verifier: grants.verifier(),
          resourceSemantics: failure === 'semantics' ? 'pure' : 'allocating',
          prepare: () => {
            throw new Error('prepare must not be reached');
          },
        });
        if (failure === 'grant') {
          Object.defineProperty(grants, 'issue', {
            value: () => {
              throw new Error('grant issue failed');
            },
          });
        }
        let receipt:
          | { prepared: Readonly<PreparedSandboxExecutionV1> | null; disposed: boolean }
          | undefined;
        const result = await createBuiltinSandboxExecutionConsumerForTestV1({
          resolveProviderAfterIntent: () => {
            sequence.push('resolve');
            if (failure === 'resolver') throw new Error('probe failed');
            return provider;
          },
          resourceSemantics: 'allocating',
          backend: 'seatbelt',
          grants,
          canonicalWorkspace: workspace,
          executionBoundaryDigest: 'boundary',
          protectedPathRevision: 'protected',
        })({
          workspace,
          command: 'printf must-not-run',
          sandboxInvocationIdentity: invocationIdentity(),
          sandboxPreparationLifecycle: {
            async recordPreparationIntent(preparation) {
              sequence.push('intent');
              return preparationIntentAcknowledgement(preparation);
            },
            async recordPreparationReady() {
              throw new Error('ready must not be reached');
            },
            async recordExecutionDispatchIntent() {
              throw new Error('dispatch must not be reached');
            },
            async recordExecutionSupervisorStarted() {
              throw new Error('spawn must not be reached');
            },
            async recordDisposalIntent(prepared) {
              sequence.push('abandonment-intent');
              expect(prepared).toBeNull();
              return {
                acknowledged: true as const,
                stage: 'disposal_intent' as const,
                purpose: 'reconcile_preparation_intent' as const,
                lifecycleIntentDigest: `${failure}-abandonment`,
                cleanupAttempt: 1,
              };
            },
            async recordDisposalReceipt(value) {
              sequence.push('abandonment-receipt');
              receipt = value;
              return disposalReceiptAcknowledgement(value);
            },
          },
        });
        expect(result.terminationReason).toBe('sandbox_denied');
        expect(sequence).toEqual([
          'intent',
          'resolve',
          'abandonment-intent',
          'abandonment-receipt',
        ]);
        expect(receipt?.prepared).toBeNull();
        expect(provider.calls().prepare).toBe(0);
      }

      let probes = 0;
      const deniedBeforeAck = await createBuiltinSandboxExecutionConsumerForTestV1({
        resolveProviderAfterIntent: () => {
          probes += 1;
          throw new Error('probe must not run');
        },
        resourceSemantics: 'allocating',
        backend: 'seatbelt',
        grants: new SandboxExecutionGrantAuthorityV1(),
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf must-not-run',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent() {
            throw new Error('persistence unavailable');
          },
          async recordPreparationReady() {
            throw new Error('ready not reached');
          },
          async recordExecutionDispatchIntent() {
            throw new Error('dispatch not reached');
          },
          async recordExecutionSupervisorStarted() {
            throw new Error('supervisor not reached');
          },
          async recordDisposalIntent() {
            throw new Error('disposal not reached');
          },
          async recordDisposalReceipt() {
            throw new Error('receipt not reached');
          },
        },
      });
      expect(deniedBeforeAck.terminationReason).toBe('sandbox_denied');
      expect(probes).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('Windows pre-dispatch failure confirms cleanup of an allocated runtime before fallback', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-windows-sandbox-provider-'));
    let runtimeRoot = '';
    let expectedRuntimeRoot = '';
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      let reconciled = false;
      const provider = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          runtimeRoot = createWindowsSandboxRuntimeDirForPreparationV1(
            workspace,
            grant.preparationDigest,
          );
          expectedRuntimeRoot = realpathSync.native(
            sandboxRuntimeDirForPreparationV1(workspace, grant.preparationDigest),
          );
          return {
            ok: false,
            failure: {
              code: 'backend_unavailable',
              message: 'runner unavailable after allocation',
            },
          };
        },
        reconcilePreparationIntent: (grant) => {
          reconciled = true;
          expect(grant.cleanupConfirmed).toBe(true);
          expect(runtimeRoot).toBe(expectedRuntimeRoot);
          expect(existsSync(runtimeRoot)).toBe(false);
          return { ok: true, observation: { disposed: true } };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider,
        resourceSemantics: 'allocating',
        backend: 'windows_restricted_token',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf must-not-run',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady() {
            throw new Error('ready must not be reached');
          },
          async recordExecutionDispatchIntent() {
            throw new Error('dispatch must not be reached');
          },
          async recordExecutionSupervisorStarted() {
            throw new Error('spawn must not be reached');
          },
          async recordDisposalIntent(prepared) {
            expect(prepared).toBeNull();
            return {
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'windows-abandonment',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(receipt) {
            expect(receipt.disposed).toBe(true);
            return disposalReceiptAcknowledgement(receipt);
          },
        },
      });
      expect(reconciled).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        terminationReason: 'sandbox_denied',
        sandboxFailure: {
          code: 'backend_unavailable',
          stage: 'pre_dispatch',
          cleanupConfirmed: true,
        },
      });
    } finally {
      if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('prepared Artifacts reject nested shape drift and surface typed corruption', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-artifact-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    try {
      const storeRoot = join(root, 'sandbox-preparations');
      const integrityKey = Buffer.alloc(32, 0x61);
      const store = new SandboxPreparationArtifactStoreV1({
        integrityKey,
        root: storeRoot,
      });
      const preparation = samplePreparation(workspace);
      const prepared = plan(
        preparation,
        sandboxPreparationDigestV1(preparation),
        workspace,
        'artifact-plan',
      );
      expect(() =>
        store.write({
          ...prepared,
          cleanup: {
            ...prepared.cleanup,
            recoveryPayload: { unexpected: 'authority drift' },
          },
        }),
      ).toThrow(SandboxPreparationArtifactErrorV1);

      const ref = store.write(prepared);
      const sibling = join(root, 'sibling');
      mkdirSync(sibling);
      const siblingPayload = Buffer.from(
        canonicalModelJsonV1({
          artifactFormatVersion: 1,
          prepared: { ...prepared, cwd: sibling },
        }),
        'utf8',
      );
      const siblingRef = privateArtifactReference(
        integrityKey,
        'sandbox-preparations',
        'sandbox_preparation',
        siblingPayload,
      );
      const siblingTarget = join(storeRoot, 'plans', `${siblingRef.artifactId}.json`);
      writeFileSync(siblingTarget, siblingPayload);
      if (process.platform !== 'win32') chmodSync(siblingTarget, 0o600);
      expect(() => store.read(siblingRef)).toThrow(SandboxPreparationArtifactErrorV1);

      const target = join(storeRoot, 'plans', `${ref.artifactId}.json`);
      writeFileSync(target, '{"artifactFormatVersion":1,"prepared":{"extra":true}}', 'utf8');
      if (process.platform !== 'win32') chmodSync(target, 0o600);
      try {
        store.read(ref);
        throw new Error('expected typed Artifact corruption');
      } catch (error) {
        expect(error).toBeInstanceOf(SandboxPreparationArtifactErrorV1);
        if (!(error instanceof SandboxPreparationArtifactErrorV1)) throw error;
        expect(error.code).toBe('artifact_corrupt');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'prepared plan is consumed only once and consumer owns spawn',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
      try {
        const grants = new SandboxExecutionGrantAuthorityV1();
        const runtimeDirectory = createTestRuntimeDir(workspace, 'shared-plan');
        const controlRoot = join(runtimeDirectory, 'control');
        const dataRoot = join(runtimeDirectory, 'data');
        mkdirSync(controlRoot);
        mkdirSync(dataRoot);
        let sharedPlan: PreparedSandboxExecutionV1 | undefined;
        const fake = new ScriptableFakeSandboxExecutionProviderV1({
          verifier: grants.verifier(),
          resourceSemantics: 'allocating',
          prepare: (grant) => {
            if (!sharedPlan) {
              const candidate = plan(
                grant.preparation,
                grant.preparationDigest,
                workspace,
                'same-plan',
                'allocating',
              );
              sharedPlan = Object.freeze({
                ...candidate,
                approvedArgv: Object.freeze([...candidate.approvedArgv]),
                argv: Object.freeze([...candidate.argv]),
                backendCapabilities: Object.freeze({
                  ...candidate.backendCapabilities,
                  filesystem: Object.freeze({ ...candidate.backendCapabilities.filesystem }),
                  network: Object.freeze({ ...candidate.backendCapabilities.network }),
                }),
                cleanup: Object.freeze({
                  kind: 'runtime_directory',
                  resourceId: 'same-plan-runtime',
                  recoveryPayload: Object.freeze({ controlRoot, dataRoot }),
                }),
              });
            }
            return { ok: true, observation: sharedPlan };
          },
        });
        const consumerOptions = {
          provider: fake,
          backend: 'seatbelt',
          grants,
          canonicalWorkspace: workspace,
          executionBoundaryDigest: 'boundary',
          protectedPathRevision: 'protected',
        } as const;
        const consumer = createBuiltinSandboxExecutionConsumerForTestV1(consumerOptions);
        let consumed = false;
        const lifecycle: SandboxPreparationLifecycleV1 = {
          async recordPreparationIntent(preparation: SandboxPreparationV1) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady() {
            return preparationReadyAcknowledgement();
          },
          async recordExecutionDispatchIntent(
            _prepared: unknown,
            dispatch: { dispatchId: string; supervisorNonce: string },
          ) {
            if (consumed) throw new Error('durable plan consumption already exists');
            consumed = true;
            return dispatchAcknowledgement(dispatch);
          },
          async recordExecutionSupervisorStarted(_prepared, started) {
            return supervisorAcknowledgement(started);
          },
          async recordDisposalIntent() {
            return Object.freeze({
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'durable-disposal',
              cleanupAttempt: 1,
            });
          },
          async recordDisposalReceipt(receipt) {
            return disposalReceiptAcknowledgement(receipt);
          },
        };
        const input = {
          workspace,
          command: 'printf one',
          sandboxInvocationIdentity: {
            toolCallId: 'tool-call',
            capabilityId: 'builtin:shell_execute',
            capabilityRevision: 'revision',
            invocationId: 'invocation',
            attempt: 1,
            effectiveEffectsDigest: 'effects',
            admissionDigest: 'admission',
            cancellationCorrelation: 'tool-call',
          },
          sandboxPreparationLifecycle: lifecycle,
        } as const;
        expect((await consumer(input)).stdout).toBe('one');
        const second = await createBuiltinSandboxExecutionConsumerForTestV1(consumerOptions)(input);
        expect(second.terminationReason).toBe('sandbox_denied');
        expect(second.stderr).toContain('dispatch intent acknowledgement failed');
        expect(fake.calls()).toEqual({ prepare: 2, dispose: 2, reconcile: 0 });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test('prepared plan cannot replace the approved argv before spawn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        prepare: (grant) => {
          const prepared = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'changed-argv-plan',
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixtureV1({
              ...prepared,
              approvedArgv: ['/bin/sh', '-c', 'printf changed'],
              argv: ['/bin/sh', '-c', 'touch must-not-exist'],
            }),
          };
        },
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      });
      const result = await consumer({
        workspace,
        command: 'printf approved',
        sandboxInvocationIdentity: {
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          invocationId: 'invocation',
          attempt: 1,
          effectiveEffectsDigest: 'effects',
          admissionDigest: 'admission',
          cancellationCorrelation: 'tool-call',
        },
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('approved command identity');
      expect(existsSync(join(workspace, 'must-not-exist'))).toBe(false);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('prepared plan cannot replace the frozen workspace before ready or spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    const workspace = join(root, 'workspace');
    const sibling = join(root, 'sibling');
    mkdirSync(workspace);
    mkdirSync(sibling);
    try {
      const marker = join(workspace, 'must-not-spawn');
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => ({
          ok: true,
          observation: deepFreezeSandboxFixtureV1({
            ...plan(
              grant.preparation,
              grant.preparationDigest,
              workspace,
              'wrong-cwd-plan',
              'allocating',
            ),
            cwd: sibling,
            argv: ['/bin/sh', '-c', `touch ${marker}`],
          }),
        }),
      });
      let readyCalls = 0;
      let abandonmentReceipt = false;
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf approved',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady() {
            readyCalls += 1;
            return preparationReadyAcknowledgement();
          },
          async recordExecutionDispatchIntent() {
            throw new Error('dispatch must not be reached');
          },
          async recordExecutionSupervisorStarted() {
            throw new Error('spawn must not be reached');
          },
          async recordDisposalIntent(prepared) {
            expect(prepared).toBeNull();
            return {
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'wrong-cwd-abandonment',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(receipt) {
            expect(receipt.prepared).toBeNull();
            abandonmentReceipt = receipt.disposed;
            return disposalReceiptAcknowledgement(receipt);
          },
        },
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('invocation identity');
      expect(readyCalls).toBe(0);
      expect(abandonmentReceipt).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sealed backend evidence mismatch is denied before dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        prepare: (grant) => {
          const prepared = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'backend-mismatch',
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixtureV1({
              ...prepared,
              backendCapabilities: {
                ...prepared.backendCapabilities,
                network: { off: 'unsupported', allowlist: 'unsupported' },
              },
            }),
          };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf must-not-dispatch',
        sandboxInvocationIdentity: invocationIdentity(),
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('backend evidence mismatch');
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('ready acknowledgement failure disposes and spawns zero processes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => ({
          ok: true,
          observation: plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'allocating-plan',
            'allocating',
          ),
        }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      });
      const result = await consumer({
        workspace,
        command: 'printf must-not-run',
        sandboxInvocationIdentity: {
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          invocationId: 'invocation',
          attempt: 1,
          effectiveEffectsDigest: 'effects',
          admissionDigest: 'admission',
          cancellationCorrelation: 'tool-call',
        },
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady() {
            throw new Error('ready acknowledgement rejected');
          },
          async recordExecutionDispatchIntent() {
            throw new Error('dispatch not reached');
          },
          async recordExecutionSupervisorStarted() {
            throw new Error('supervisor not reached');
          },
          async recordDisposalIntent(prepared) {
            expect(prepared).toBeNull();
            return {
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'ready-failed-abandonment',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(receipt) {
            expect(receipt.prepared).toBeNull();
            return disposalReceiptAcknowledgement(receipt);
          },
        },
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stdout).toBe('');
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('disposal intent failure calls no Provider cleanup and fails closed', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => ({
          ok: true,
          observation: plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'cleanup-plan',
            'allocating',
          ),
        }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      });
      const result = await consumer({
        workspace,
        command: 'printf one',
        sandboxInvocationIdentity: {
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          invocationId: 'invocation',
          attempt: 1,
          effectiveEffectsDigest: 'effects',
          admissionDigest: 'admission',
          cancellationCorrelation: 'tool-call',
        },
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady() {
            return preparationReadyAcknowledgement();
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return dispatchAcknowledgement(dispatch);
          },
          async recordExecutionSupervisorStarted(_prepared, started) {
            return supervisorAcknowledgement(started);
          },
          async recordDisposalIntent() {
            throw new Error('disposal intent unavailable');
          },
          async recordDisposalReceipt() {
            throw new Error('disposal receipt acknowledgement rejected');
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('disposal intent acknowledgement failed');
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('disposal receipt acknowledgement failure cannot report command success', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          const prepared = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'receipt-ack',
            'allocating',
          );
          const runtimeRoots = createPosixSandboxRuntimeRootsForPreparationV1(
            workspace,
            grant.preparationDigest,
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixtureV1({
              ...prepared,
              cleanup: {
                kind: 'runtime_directory',
                resourceId: 'receipt-runtime',
                recoveryPayload: {
                  controlRoot: runtimeRoots.controlRoot,
                  dataRoot: runtimeRoots.dataRoot,
                },
              },
            }),
          };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        resourceSemantics: 'allocating',
        preparedProcess: createCompletedPreparedProcessPortForTestV1(),
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf ack',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady(prepared) {
            return preparationReadyAcknowledgement(prepared);
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return dispatchAcknowledgement(dispatch);
          },
          async recordExecutionSupervisorStarted(_prepared, started) {
            return supervisorAcknowledgement(started);
          },
          async recordDisposalIntent() {
            return Object.freeze({
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'disposal-intent',
              cleanupAttempt: 1,
            });
          },
          async recordDisposalReceipt() {
            throw new Error('disposal receipt acknowledgement rejected');
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('disposal receipt acknowledgement failed');
      expect(fake.calls().dispose).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'Local POSIX disposal retains a runtime until process cleanup is confirmed',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
      const grants = new SandboxExecutionGrantAuthorityV1();
      const preparation = samplePreparation(workspace);
      const runtimeRoots = createPosixSandboxRuntimeRootsForPreparationV1(
        workspace,
        sandboxPreparationDigestV1(preparation),
      );
      const externalSentinel = join(workspace, 'external-sentinel');
      if (process.platform !== 'win32') {
        writeFileSync(join(runtimeRoots.dataRoot, 'x'.repeat(255)), 'max-name');
        writeFileSync(externalSentinel, 'must-survive');
        symlinkSync(externalSentinel, join(runtimeRoots.dataRoot, 'external-link'));
      }
      try {
        const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
          backend: 'seatbelt',
          canonicalWorkspace: workspace,
        });
        const prepared: PreparedSandboxExecutionV1 = {
          ...plan(
            preparation,
            sandboxPreparationDigestV1(preparation),
            workspace,
            'retained-runtime',
            'allocating',
          ),
          cleanup: {
            kind: 'runtime_directory',
            resourceId: 'retained-runtime',
            recoveryPayload: {
              controlRoot: runtimeRoots.controlRoot,
              dataRoot: runtimeRoots.dataRoot,
            },
          },
        };
        expect(
          (
            await provider.dispose({
              grant: grants.issueCleanup({
                purpose: 'dispose',
                prepared,
                lifecycleIntentDigest: 'disposal-intent-1',
                cleanupAttempt: 1,
                cleanupConfirmed: false,
              }),
              prepared,
            })
          ).ok,
        ).toBe(false);
        expect(existsSync(runtimeRoots.controlRoot)).toBe(true);
        expect(existsSync(runtimeRoots.dataRoot)).toBe(true);
        expect(
          (
            await provider.dispose({
              grant: grants.issueCleanup({
                purpose: 'dispose',
                prepared,
                lifecycleIntentDigest: 'disposal-intent-2',
                cleanupAttempt: 2,
                cleanupConfirmed: true,
              }),
              prepared,
            })
          ).ok,
        ).toBe(true);
        expect(existsSync(runtimeRoots.controlRoot)).toBe(false);
        expect(existsSync(runtimeRoots.dataRoot)).toBe(false);
        expect(existsSync(externalSentinel)).toBe(true);
      } finally {
        rmSync(runtimeRoots.controlRoot, { recursive: true, force: true });
        rmSync(runtimeRoots.dataRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'Darwin Seatbelt preparation fails closed without descendant containment proof',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-canonical-'));
      const workspace = join(root, 'workspace');
      const alias = join(root, 'workspace-alias');
      mkdirSync(workspace);
      symlinkSync(workspace, alias, 'dir');
      try {
        const grants = new SandboxExecutionGrantAuthorityV1();
        const preparation = samplePreparation(workspace);
        const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
          backend: 'seatbelt',
          canonicalWorkspace: alias,
        });
        const result = await provider.prepare({
          grant: grants.issue({
            preparation,
            resourceSemantics: 'allocating',
            preparationIntentDigest: intentDigest(preparation),
          }),
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Seatbelt unexpectedly admitted execution.');
        expect(result.failure.code).toBe('backend_unavailable');
        expect(result.failure.message).toBe('seatbelt_descendant_containment_unproven');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'descriptor cleanup refuses hardlinks and special entries without following them',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-descriptor-cleanup-'));
      const parentFd = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const hardlinkTree = join(root, 'hardlink-tree');
        const hardlinkTarget = join(root, 'hardlink-target.txt');
        const hardlink = join(hardlinkTree, 'linked.txt');
        mkdirSync(hardlinkTree);
        writeFileSync(hardlinkTarget, 'must-survive');
        linkSync(hardlinkTarget, hardlink);

        expect(removeDirectoryTreeAtV1(parentFd, 'hardlink-tree')).toBe(false);
        expect(existsSync(hardlink)).toBe(true);
        expect(lstatSync(hardlink).nlink).toBe(2);
        expect(existsSync(hardlinkTarget)).toBe(true);

        unlinkSync(hardlink);
        rmdirSync(hardlinkTree);

        const specialTree = join(root, 'special-tree');
        const fifo = join(specialTree, 'runtime.fifo');
        mkdirSync(specialTree);
        expect(
          Bun.spawnSync(['/usr/bin/mkfifo', fifo], { stdout: 'ignore', stderr: 'ignore' }).exitCode,
        ).toBe(0);
        expect(lstatSync(fifo).isFIFO()).toBe(true);

        expect(removeDirectoryTreeAtV1(parentFd, 'special-tree')).toBe(false);
        expect(existsSync(fifo)).toBe(true);
        expect(lstatSync(fifo).isFIFO()).toBe(true);

        unlinkSync(fifo);
        rmdirSync(specialTree);

        const displacedRoot = `${root}-displaced`;
        const pinnedTree = join(root, 'pinned-tree');
        mkdirSync(pinnedTree);
        writeFileSync(join(pinnedTree, 'owned.txt'), 'owned-by-pinned-parent');
        renameSync(root, displacedRoot);
        mkdirSync(root);
        const replacementTree = join(root, 'pinned-tree');
        mkdirSync(replacementTree);
        const replacementSentinel = join(replacementTree, 'must-survive.txt');
        writeFileSync(replacementSentinel, 'replacement-parent');

        expect(removeDirectoryTreeAtV1(parentFd, 'pinned-tree')).toBe(true);
        expect(existsSync(join(displacedRoot, 'pinned-tree'))).toBe(false);
        expect(existsSync(replacementSentinel)).toBe(true);
      } finally {
        closeSync(parentFd);
        rmSync(root, { recursive: true, force: true });
        rmSync(`${root}-displaced`, { recursive: true, force: true });
      }
    },
  );

  test('Fake cleanup failure stays failed and records no successful disposal receipt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      let disposedReceipt: boolean | undefined;
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          const prepared = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'fake-leak-plan',
            'allocating',
          );
          const runtimeRoots = createPosixSandboxRuntimeRootsForPreparationV1(
            workspace,
            grant.preparationDigest,
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixtureV1({
              ...prepared,
              cleanup: {
                kind: 'runtime_directory',
                resourceId: 'fake-leak-runtime',
                recoveryPayload: {
                  controlRoot: runtimeRoots.controlRoot,
                  dataRoot: runtimeRoots.dataRoot,
                },
              },
            }),
          };
        },
        dispose: () => ({
          ok: false,
          failure: { code: 'dispose_failed', message: 'Fake cleanup remains unknown.' },
        }),
      });
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        resourceSemantics: 'allocating',
        preparedProcess: createCompletedPreparedProcessPortForTestV1(),
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf fake-cleanup',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady(prepared) {
            return preparationReadyAcknowledgement(prepared);
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return dispatchAcknowledgement(dispatch);
          },
          async recordExecutionSupervisorStarted(_prepared, started) {
            return supervisorAcknowledgement(started);
          },
          async recordDisposalIntent() {
            return Object.freeze({
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'fake-leak-disposal',
              cleanupAttempt: 1,
            });
          },
          async recordDisposalReceipt(input) {
            disposedReceipt = input.disposed;
            return disposalReceiptAcknowledgement(input);
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Sandbox cleanup could not be confirmed.');
      expect(result.stdout).toBe('');
      expect(disposedReceipt).toBe(false);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 1, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'crash before ready publication reclaims the intent-addressed allocation',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-abandonment-'));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      try {
        let state = createRuntimeHostState26InitialStateV1({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: 'thread',
          userId: 'user',
          workspace,
        });
        const apply = (event: RuntimeEvent) => {
          state = reduceRuntimeState(state, event);
        };
        apply({
          type: 'capability.invocation_recorded',
          invocationId: 'invocation',
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          argumentsDigest: 'arguments',
          authorizationDigest: 'authorization',
          admissionDigest: 'admission',
          effectiveEffectsDigest: 'effects',
          effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
          receiptRequirement: 'effect_receipt',
          retryEligibility: 'none',
          recordedAt: new Date().toISOString(),
        });
        apply({
          type: 'capability.execution_started',
          invocationId: 'invocation',
          startedAt: new Date().toISOString(),
          attempt: 1,
        });
        const persistence = {
          getState: () => state,
          persistEvents: async (events: RuntimeEvent[]) => {
            for (const event of events) apply(event);
            return true;
          },
        };
        const preparation = samplePreparation(workspace);
        const preparationDigest = sandboxPreparationDigestV1(preparation);
        apply({
          type: 'capability.sandbox_preparation_intent_recorded',
          invocationId: 'invocation',
          attempt: 1,
          toolCallId: preparation.toolCallId,
          capabilityId: preparation.capabilityId,
          capabilityRevision: preparation.capabilityRevision,
          canonicalWorkspace: preparation.canonicalWorkspace,
          effectiveEffectsDigest: preparation.effectiveEffectsDigest,
          admissionDigest: preparation.admissionDigest,
          preparationDigest,
          commandDigest: preparation.commandDigest,
          executionBoundaryDigest: preparation.executionBoundaryDigest,
          resourceSemantics: 'allocating',
          intentDigest: intentDigest(preparation),
          recordedAt: new Date().toISOString(),
        });
        const runtimeDirectory = createSandboxRuntimeDirForPreparationV1(
          workspace,
          preparationDigest,
        );
        const grants = new SandboxExecutionGrantAuthorityV1();
        const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
          backend: 'seatbelt',
          canonicalWorkspace: workspace,
        });
        const artifacts = new SandboxPreparationArtifactStoreV1({
          integrityKey: randomBytes(32),
          root: join(root, 'sandbox-preparations'),
        });

        expect(
          await reconcilePendingSandboxPreparationsAfterCrashV1({
            provider,
            grants,
            artifacts,
            persistence,
          }),
        ).toBe(true);
        expect(existsSync(runtimeDirectory)).toBe(false);
        expect(
          state.capabilities.invocations.invocation?.sandboxPreparationAbandonment?.status,
        ).toBe('completed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('fake denial does not fall back to a Local or host command', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        prepare: () => ({
          ok: false,
          failure: { code: 'fake_denied', message: 'Scriptable Fake denied prepare.' },
        }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      });
      const result = await consumer({
        workspace,
        command: 'printf bypass',
        sandboxInvocationIdentity: {
          toolCallId: 'tool-call',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision',
          invocationId: 'invocation',
          attempt: 1,
          effectiveEffectsDigest: 'effects',
          admissionDigest: 'admission',
          cancellationCorrelation: 'tool-call',
        },
      });
      expect(result.ok).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('fake_denied');
      expect(fake.calls().prepare).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('fake crash evidence remains denied with zero Local fallback', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        prepare: () => {
          throw new Error('Fake lost its preparation handle.');
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTestV1({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
      })({
        workspace,
        command: 'printf forbidden-fallback',
        sandboxInvocationIdentity: invocationIdentity(),
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('preparation_failed');
      expect(result.stdout).toBe('');
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('fixed-clock Kernel cleanup retries once on the same durable disposal identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-recovery-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    await Bun.write(join(workspace, '.keep'), '');
    try {
      let state = createRuntimeHostState26InitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'thread',
        userId: 'user',
        workspace,
      });
      const apply = (event: RuntimeEvent) => {
        state = reduceRuntimeState(state, event);
      };
      apply({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation',
        toolCallId: 'tool-call',
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'revision',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        admissionDigest: 'admission',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
        receiptRequirement: 'effect_receipt',
        retryEligibility: 'none',
        recordedAt: new Date().toISOString(),
      });
      apply({
        type: 'capability.execution_started',
        invocationId: 'invocation',
        startedAt: new Date().toISOString(),
        attempt: 1,
      });
      const persistence = {
        getState: () => state,
        persistEvents: async (events: RuntimeEvent[]) => {
          const beforeRevision = state.revision;
          for (const event of events) apply(event);
          if (state.revision < beforeRevision + events.length) {
            state = { ...state, revision: beforeRevision + events.length };
          }
          return true;
        },
      };
      const artifacts = new SandboxPreparationArtifactStoreV1({
        integrityKey: randomBytes(32),
        root: join(root, 'sandbox-preparations'),
      });
      const preparedTool = sandboxPreparedToolPacketV1();
      const acknowledgement = sandboxAttemptAcknowledgementV1(preparedTool);
      const lifecycle = createAppToolPipelineSandboxLifecycleV1({
        prepared: preparedTool,
        resolveOpenAcknowledgement: (candidate) =>
          candidate === preparedTool ? acknowledgement : null,
        getState: persistence.getState,
        persistEvents: persistence.persistEvents,
        now: () => new Date().toISOString(),
        artifacts,
      });
      const preparation = deepFreezeSandboxFixtureV1(samplePreparation(workspace));
      const intent = await lifecycle.recordPreparationIntent(preparation);
      const fixedNow = Date.now();
      const grants = new SandboxExecutionGrantAuthorityV1({ now: () => fixedNow });
      const grant = grants.issue({
        preparation,
        resourceSemantics: 'allocating',
        preparationIntentDigest: intent.intentDigest,
      });
      const prepared = deepFreezeSandboxFixtureV1(
        plan(preparation, grant.preparationDigest, workspace, 'crashed-plan', 'allocating'),
      );
      expect(await lifecycle.recordPreparationReady(prepared)).toMatchObject({
        acknowledged: true,
        stage: 'preparation_ready',
      });

      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: () => ({ ok: true, observation: prepared }),
        reconcile: () => {
          if (fake.calls().reconcile === 1) throw new Error('cleanup transport lost its receipt');
          return { ok: true, observation: { disposed: true } };
        },
      });
      expect(
        await reconcileSandboxPreparationAfterCrashV1({
          invocationId: 'invocation',
          provider: fake,
          grants,
          artifacts,
          persistence,
        }),
      ).toBe(false);
      expect(state.capabilities.invocations.invocation?.sandboxDisposal).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
      expect(
        await reconcileSandboxPreparationAfterCrashV1({
          invocationId: 'invocation',
          provider: fake,
          grants,
          artifacts,
          persistence,
        }),
      ).toBe(true);
      expect(fake.calls().reconcile).toBe(2);
      expect(state.capabilities.invocations.invocation?.sandboxDisposal?.status).toBe('completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'linux')(
    'Local bubblewrap provider rejects cgroup hard-count before emitting a spawnable plan',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-cgroup-negative-'));
      try {
        const grants = new SandboxExecutionGrantAuthorityV1();
        const preparation = {
          ...samplePreparation(workspace),
          resourceLimits: {
            ...samplePreparation(workspace).resourceLimits,
            maxProcessTreeTasks: 4,
          },
        };
        const grant = grants.issue({
          preparation,
          resourceSemantics: 'allocating',
          preparationIntentDigest: intentDigest(preparation),
        });
        const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
          backend: 'bubblewrap',
          canonicalWorkspace: workspace,
          bubblewrapPath: '/usr/bin/bwrap',
          cgroupPidsRunner: {
            mechanism: 'systemd_user_scope_tasks_max',
            executable: '/usr/bin/systemd-run',
            systemctlExecutable: '/usr/bin/systemctl',
          },
        });
        const result = await provider.prepare({ grant });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected cgroup hard-count denial');
        expect(result.failure.code).toBe('preparation_failed');
        expect(result.failure.message).toContain('cgroup_pids_cleanup_authority_unavailable');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});

function sandboxPreparedToolPacketV1(): Readonly<PreparedToolInvocationV1> {
  const identity = {
    invocationId: 'invocation',
    attemptId: 'invocation:attempt:1',
    toolCallId: 'tool-call',
    turnId: 'turn-sandbox-recovery',
    modelMessageId: 'message-sandbox-recovery',
    argumentOrigin: 'model_public' as const,
    providerId: 'builtin-provider',
    operationId: 'builtin:shell_execute' as NonDynamicOperationIdV1,
    executionFamily: 'builtin' as const,
    executionMechanism: 'shell' as const,
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    descriptorRevision: 'descriptor-revision',
    parserRevision: 'parser-revision',
    executorRevision: 'executor-revision',
    argumentsDigest: 'arguments',
    schemaDigest: 'schema-digest',
    effectiveEffectsDigest: 'effects',
    policyDigest: 'policy-digest',
    authorizationDigest: 'authorization',
    admissionDigest: 'admission',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model' as const,
    modelVisible: true,
    exposedToolName: 'shell_execute',
    builtinProjectionRevision: 'builtin-projection-revision',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false as const,
    toolKind: 'computer' as const,
  };
  return deepFreezeSandboxFixtureV1({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { command: 'printf test' },
      request: {
        schema: 'kite.tool-pipeline-prepared-request.v1',
        authorizationKind: 'policy_allow',
        grantUsed: 'none',
        policyEffects: {},
        effectiveEffects: {
          filesystem: 'unknown',
          network: 'unknown',
          externalState: 'unknown',
        },
        receiptRequirement: 'effect_receipt',
        retryEligibility: 'none',
        taskId: null,
        planId: null,
        planStepId: null,
        capabilityRequestFacts: null,
      },
      binding: null,
      facts: {},
    },
  }) as Readonly<PreparedToolInvocationV1>;
}

function sandboxAttemptAcknowledgementV1(
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<ToolPipelineAttemptAcknowledgementV1> {
  return deepFreezeSandboxFixtureV1({
    acknowledged: true as const,
    attempt: {
      ...prepared.identity,
      attempt: 1,
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      recordedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    },
  });
}

function deepFreezeSandboxFixtureV1<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeSandboxFixtureV1(nested);
    }
  }
  return value;
}

function samplePreparation(workspace: string): SandboxPreparationV1 {
  const argv = ['/bin/sh', '-c', 'printf test'];
  const canonicalWorkspace = realpathSync.native(workspace);
  return {
    schema: 'kite.sandbox-execution-provider.v1',
    toolCallId: 'tool-call',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    invocationId: 'invocation',
    attempt: 1,
    effectiveEffectsDigest: 'effects',
    admissionDigest: 'admission',
    canonicalWorkspace,
    argv,
    commandDigest: sandboxCommandDigestV1(argv),
    executionBoundaryDigest: 'boundary',
    protectedPathRevision: 'protected',
    filesystemMode: 'workspace_only',
    networkMode: 'disabled',
    executionTrust: null,
    resourceLimits: {
      cpuTime: 120,
      virtualMemory: -1,
      fileSize: 1024,
      fileDescriptors: 64,
      processes: -1,
      maxProcessTreeTasks: null,
    },
    timeoutMs: 60_000,
    cancellationCorrelation: 'tool-call',
  };
}

function invocationIdentity() {
  return {
    toolCallId: 'tool-call',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    invocationId: 'invocation',
    attempt: 1,
    effectiveEffectsDigest: 'effects',
    admissionDigest: 'admission',
    cancellationCorrelation: 'tool-call',
  } as const;
}

function intentDigest(preparation: SandboxPreparationV1): string {
  return sandboxPreparationIntentDigestV1({
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigestV1(preparation),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
  });
}

function preparationIntentAcknowledgement(preparation: SandboxPreparationV1) {
  return Object.freeze({
    acknowledged: true as const,
    stage: 'preparation_intent' as const,
    intentDigest: intentDigest(preparation),
  });
}

function preparationReadyAcknowledgement(prepared?: Readonly<PreparedSandboxExecutionV1>) {
  const preparedPlanDigest = prepared?.planId ?? 'test-prepared';
  return Object.freeze({
    acknowledged: true as const,
    stage: 'preparation_ready' as const,
    readyDigest: `ready:${preparedPlanDigest}`,
    preparationArtifact: Object.freeze({
      artifactId: `test-artifact:${prepared?.planId ?? 'plan'}`,
      kind: 'sandbox_preparation' as const,
      integrityIdentifier: `test-integrity:${preparedPlanDigest}`,
      byteLength: 1,
    }),
  });
}

function dispatchAcknowledgement(dispatch: {
  readonly dispatchId: string;
  readonly supervisorNonce: string;
}) {
  return Object.freeze({
    acknowledged: true as const,
    stage: 'execution_dispatch_intent' as const,
    dispatchId: dispatch.dispatchId,
    supervisorNonce: dispatch.supervisorNonce,
    dispatchIntentDigest: `dispatch:${dispatch.dispatchId}`,
  });
}

function supervisorAcknowledgement(input: {
  readonly dispatchId: string;
  readonly dispatchIntentDigest: string;
  readonly supervisorPid: number;
  readonly processGroupId: number;
  readonly processStartIdentity: string;
}) {
  return Object.freeze({
    acknowledged: true as const,
    stage: 'execution_supervisor_started' as const,
    dispatchId: input.dispatchId,
    dispatchIntentDigest: input.dispatchIntentDigest,
    supervisorPid: input.supervisorPid,
    processGroupId: input.processGroupId,
    processStartIdentity: input.processStartIdentity,
  });
}

function disposalReceiptAcknowledgement(input: {
  readonly purpose: 'dispose' | 'reconcile_preparation_intent';
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly disposed: boolean;
}) {
  return Object.freeze({
    acknowledged: true as const,
    stage: 'disposal_receipt' as const,
    purpose: input.purpose,
    lifecycleIntentDigest: input.lifecycleIntentDigest,
    cleanupAttempt: input.cleanupAttempt,
    disposed: input.disposed,
  });
}

function plan(
  preparation: SandboxPreparationV1,
  preparationDigest: string,
  workspace: string,
  planId: string,
  resourceSemantics: 'pure' | 'allocating' = 'pure',
): PreparedSandboxExecutionV1 {
  return {
    schema: 'kite.sandbox-execution-provider.v1',
    kind: 'prepared_sandbox_execution',
    planId,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    invocationId: preparation.invocationId,
    attempt: preparation.attempt,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest,
    commandDigest: preparation.commandDigest,
    approvedArgv: preparation.argv,
    argv: ['/bin/sh', '-c', 'printf one'],
    cwd: realpathSync.native(workspace),
    env: null,
    stdin: null,
    transport: 'stdio',
    backend: 'seatbelt',
    backendCapabilities: {
      backend: 'seatbelt',
      filesystem: {
        read_only: 'enforced',
        workspace_write: 'enforced',
        full_access: 'unsupported',
      },
      network: { off: 'enforced', allowlist: 'unsupported' },
      syscallFilter: 'unsupported',
      processTreeLimit: 'unsupported',
      childProcessInheritance: 'enforced',
      verifiedInProcessReadOnly: 'unsupported',
    },
    enforcement: 'partial',
    resourceSemantics,
    expiresAtMs: Date.now() + 60_000,
    cleanup: { kind: 'none', resourceId: planId, recoveryPayload: {} },
  };
}

function privateArtifactReference(
  key: Uint8Array,
  namespace: string,
  kind: 'sandbox_preparation',
  bytes: Uint8Array,
) {
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const identityMaterial = `${namespace}\0${kind}\0${contentDigest}`;
  const artifactId = `pa_${createHmac('sha256', key)
    .update('kite.private-immutable-artifact.id.v1\0')
    .update(identityMaterial)
    .digest('hex')}`;
  const integrityIdentifier = `hmac-sha256:${createHmac('sha256', key)
    .update('kite.private-immutable-artifact.integrity.v1\0')
    .update(identityMaterial)
    .update('\0')
    .update(artifactId)
    .update('\0')
    .update(String(bytes.byteLength))
    .digest('hex')}`;
  return { artifactId, kind, integrityIdentifier, byteLength: bytes.byteLength } as const;
}
