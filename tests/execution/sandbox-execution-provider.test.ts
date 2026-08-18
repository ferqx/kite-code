import { describe, expect, test } from 'bun:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
import { sandboxPreparationIntentDigestV1 } from '@/core/capabilities/sandbox-preparation-evidence';
import {
  createSandboxExecutionConsumerV1,
  reconcilePendingSandboxPreparationsAfterCrashV1,
  reconcileSandboxPreparationAfterCrashV1,
  SandboxExecutionGrantAuthorityV1,
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
} from '@/core/execution/sandbox-execution';
import { removeDirectoryTreeAtV1 } from '@/core/execution/sandbox-execution/descriptor-relative-cleanup';
import { LocalSandboxExecutionProviderV1 } from '@/core/execution/sandbox-execution/local-provider';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  createPosixSandboxRuntimeRootsForPreparationV1,
  sandboxRuntimeRootsForPreparationV1,
} from '@/core/execution/sandbox-execution/local-runtime-filesystem';
import type { RecordedInvocationV1 } from '@/core/execution/tool-pipeline';
import { createSandboxPreparationLifecycleV1 } from '@/core/execution/tool-pipeline/sandbox-preparation';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import {
  SandboxPreparationArtifactErrorV1,
  SandboxPreparationArtifactStoreV1,
} from '@/core/persistence/sandbox-preparation-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import {
  createSandboxRuntimeDir,
  createSandboxRuntimeDirForPreparationV1,
} from '@/core/sandbox/shell-wrapper';
import type {
  PreparedSandboxExecutionV1,
  SandboxPreparationV1,
} from '@/protocol/sandbox-execution-provider';
import { ScriptableFakeSandboxExecutionProviderV1 } from '../helpers/sandbox-execution-provider';

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

  test('allocating prepare is zero-call without durable intent lifecycle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: () => ({ ok: false, failure: { code: 'fake_denied', message: 'deny' } }),
      });
      const consumer = createSandboxExecutionConsumerV1({
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
        const result = await createSandboxExecutionConsumerV1({
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
              return { intentDigest: intentDigest(preparation) };
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
                purpose: 'reconcile_preparation_intent' as const,
                lifecycleIntentDigest: `${failure}-abandonment`,
                cleanupAttempt: 1,
              };
            },
            async recordDisposalReceipt(value) {
              sequence.push('abandonment-receipt');
              receipt = value;
              return true;
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
      const deniedBeforeAck = await createSandboxExecutionConsumerV1({
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
            return false;
          },
          async recordExecutionDispatchIntent() {
            return { dispatchIntentDigest: '' };
          },
          async recordExecutionSupervisorStarted() {
            return false;
          },
          async recordDisposalIntent() {
            return null;
          },
          async recordDisposalReceipt() {
            return false;
          },
        },
      });
      expect(deniedBeforeAck.terminationReason).toBe('sandbox_denied');
      expect(probes).toBe(0);
    } finally {
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
        const runtimeDirectory = createSandboxRuntimeDir(workspace);
        const controlRoot = join(runtimeDirectory, 'control');
        const dataRoot = join(runtimeDirectory, 'data');
        mkdirSync(controlRoot);
        mkdirSync(dataRoot);
        let sharedPlan: PreparedSandboxExecutionV1 | undefined;
        const fake = new ScriptableFakeSandboxExecutionProviderV1({
          verifier: grants.verifier(),
          resourceSemantics: 'allocating',
          prepare: (grant) => {
            sharedPlan ??= {
              ...plan(
                grant.preparation,
                grant.preparationDigest,
                workspace,
                'same-plan',
                'allocating',
              ),
              cleanup: {
                kind: 'runtime_directory',
                resourceId: 'same-plan-runtime',
                recoveryPayload: { controlRoot, dataRoot },
              },
            };
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
        const consumer = createSandboxExecutionConsumerV1(consumerOptions);
        let consumed = false;
        const lifecycle = {
          async recordPreparationIntent(preparation: SandboxPreparationV1) {
            return { intentDigest: intentDigest(preparation) };
          },
          async recordPreparationReady() {
            return true;
          },
          async recordExecutionDispatchIntent(
            _prepared: unknown,
            dispatch: { dispatchId: string },
          ) {
            if (consumed) throw new Error('durable plan consumption already exists');
            consumed = true;
            return { dispatchIntentDigest: `dispatch:${dispatch.dispatchId}` };
          },
          async recordExecutionSupervisorStarted() {
            return true;
          },
          async recordDisposalIntent() {
            return {
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'durable-disposal',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt() {
            return true;
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
        const second = await createSandboxExecutionConsumerV1(consumerOptions)(input);
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
            observation: {
              ...prepared,
              approvedArgv: ['/bin/sh', '-c', 'printf changed'],
              argv: ['/bin/sh', '-c', 'touch must-not-exist'],
            },
          };
        },
      });
      const consumer = createSandboxExecutionConsumerV1({
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
      expect(result.stderr).toContain('approved argv');
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
          observation: {
            ...plan(
              grant.preparation,
              grant.preparationDigest,
              workspace,
              'wrong-cwd-plan',
              'allocating',
            ),
            cwd: sibling,
            argv: ['/bin/sh', '-c', `touch ${marker}`],
          },
        }),
      });
      let readyCalls = 0;
      let abandonmentReceipt = false;
      const result = await createSandboxExecutionConsumerV1({
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
            return { intentDigest: intentDigest(preparation) };
          },
          async recordPreparationReady() {
            readyCalls += 1;
            return true;
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
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'wrong-cwd-abandonment',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(receipt) {
            expect(receipt.prepared).toBeNull();
            abandonmentReceipt = receipt.disposed;
            return true;
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
            observation: {
              ...prepared,
              backendCapabilities: {
                ...prepared.backendCapabilities,
                network: { off: 'unsupported', allowlist: 'unsupported' },
              },
            },
          };
        },
      });
      const result = await createSandboxExecutionConsumerV1({
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
      const consumer = createSandboxExecutionConsumerV1({
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
            return { intentDigest: intentDigest(preparation) };
          },
          async recordPreparationReady() {
            return false;
          },
          async recordExecutionDispatchIntent() {
            return { dispatchIntentDigest: 'not-reached' };
          },
          async recordExecutionSupervisorStarted() {
            return false;
          },
          async recordDisposalIntent(prepared) {
            expect(prepared).toBeNull();
            return {
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'ready-failed-abandonment',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(receipt) {
            expect(receipt.prepared).toBeNull();
            return true;
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
      const consumer = createSandboxExecutionConsumerV1({
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
            return { intentDigest: intentDigest(preparation) };
          },
          async recordPreparationReady() {
            return true;
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return { dispatchIntentDigest: `test-dispatch:${dispatch.dispatchId}` };
          },
          async recordExecutionSupervisorStarted() {
            return true;
          },
          async recordDisposalIntent() {
            return null;
          },
          async recordDisposalReceipt() {
            return false;
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
      const runtimeDirectory = createSandboxRuntimeDir(workspace);
      const grants = new SandboxExecutionGrantAuthorityV1();
      const fake = new ScriptableFakeSandboxExecutionProviderV1({
        verifier: grants.verifier(),
        prepare: (grant) => {
          const prepared = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'receipt-ack',
          );
          return {
            ok: true,
            observation: {
              ...prepared,
              cleanup: {
                kind: 'runtime_directory',
                resourceId: 'receipt-runtime',
                recoveryPayload: { path: runtimeDirectory },
              },
            },
          };
        },
      });
      const result = await createSandboxExecutionConsumerV1({
        provider: fake,
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
          async recordPreparationIntent() {
            throw new Error('not used');
          },
          async recordPreparationReady() {
            throw new Error('not used');
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return { dispatchIntentDigest: `dispatch:${dispatch.dispatchId}` };
          },
          async recordExecutionSupervisorStarted() {
            return true;
          },
          async recordDisposalIntent() {
            return {
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'disposal-intent',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt() {
            return false;
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
        prepare: (grant) => ({
          ok: true,
          observation: plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            'fake-leak-plan',
          ),
        }),
        dispose: () => ({
          ok: false,
          failure: { code: 'dispose_failed', message: 'Fake cleanup remains unknown.' },
        }),
      });
      const result = await createSandboxExecutionConsumerV1({
        provider: fake,
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
          async recordPreparationIntent() {
            throw new Error('not used');
          },
          async recordPreparationReady() {
            throw new Error('not used');
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            return { dispatchIntentDigest: `dispatch:${dispatch.dispatchId}` };
          },
          async recordExecutionSupervisorStarted() {
            return true;
          },
          async recordDisposalIntent() {
            return {
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'fake-leak-disposal',
              cleanupAttempt: 1,
            };
          },
          async recordDisposalReceipt(input) {
            disposedReceipt = input.disposed;
            return true;
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Fake cleanup remains unknown.');
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
        let state = createInitialRuntimeState({ threadId: 'thread', userId: 'user', workspace });
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
      const consumer = createSandboxExecutionConsumerV1({
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
      const result = await createSandboxExecutionConsumerV1({
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
      let state = createInitialRuntimeState({
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
      const artifacts = new SandboxPreparationArtifactStoreV1({
        integrityKey: randomBytes(32),
        root: join(root, 'sandbox-preparations'),
      });
      const recorded = {
        schema: 'kite.tool-pipeline.v1',
        stage: 'recorded',
        admitted: {
          admissionDigest: 'admission',
          authorized: {
            policy: {
              classified: {
                effectiveEffectsDigest: 'effects',
                validated: {
                  resolved: {
                    call: { toolCallId: 'tool-call' },
                    target: {
                      descriptor: {
                        capabilityId: 'builtin:shell_execute',
                        revision: 'revision',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        invocationId: 'invocation',
        attempt: 1,
        idempotencyKey: null,
        recordedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      } as unknown as RecordedInvocationV1;
      const lifecycle = createSandboxPreparationLifecycleV1({
        recorded,
        persistence,
        artifacts,
      });
      const preparation = samplePreparation(workspace);
      const intent = await lifecycle.recordPreparationIntent(preparation);
      const fixedNow = Date.now();
      const grants = new SandboxExecutionGrantAuthorityV1({ now: () => fixedNow });
      const grant = grants.issue({
        preparation,
        resourceSemantics: 'allocating',
        preparationIntentDigest: intent.intentDigest,
      });
      const prepared = plan(
        preparation,
        grant.preparationDigest,
        workspace,
        'crashed-plan',
        'allocating',
      );
      expect(await lifecycle.recordPreparationReady(prepared)).toBe(true);

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
