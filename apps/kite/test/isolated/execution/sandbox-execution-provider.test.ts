import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { canonicalModelJson } from '@kite-ai/builtin-runtime/model';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawn,
  cleanupWindowsSandboxRuntimeDirNoSpawn,
  createPosixSandboxRuntimeRootsForPreparation,
  createSandboxRuntimeDirForPreparation,
  createWindowsSandboxRuntimeDirForPreparation,
  LocalSandboxExecutionProvider,
  removeDirectoryTreeAt,
  SandboxPreparationArtifactError,
  SandboxPreparationArtifactStore,
  sandboxPreparationIntentDigest,
  sandboxRuntimeDirForPreparation,
  sandboxRuntimeRootsForPreparation,
} from '@kite-ai/builtin-runtime/sandbox';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  NonDynamicOperationId,
  PreparedSandboxExecution,
  PreparedToolInvocation,
  SandboxPreparation,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessExecutionPort,
  ToolPipelineAttemptAcknowledgement,
} from '@kite-ai/runtime-spi';
import { createAppToolPipelineSandboxLifecycle } from '#app/bootstrap/runtime/tool-pipeline-sandbox-lifecycle';
import {
  reconcilePendingSandboxPreparationsAfterCrash,
  reconcileSandboxPreparationAfterCrash,
  SandboxExecutionGrantAuthority,
  sandboxCommandDigest,
  sandboxPreparationDigest,
} from '#app/sandbox/runtime-execution';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { ScriptableFakeSandboxExecutionProvider } from '../../../../../tests/helpers/sandbox-execution-provider';
import {
  createBuiltinSandboxExecutionConsumerForTest,
  createCompletedPreparedProcessPortForTest,
} from '../../../../../tests/helpers/sandbox-executor';

function createTestRuntimeDir(workspace: string, label: string): string {
  const preparationDigest = `sandbox-provider-test:${label}:${randomUUID()}`;
  return process.platform === 'win32'
    ? createWindowsSandboxRuntimeDirForPreparation(workspace, preparationDigest)
    : createSandboxRuntimeDirForPreparation(workspace, preparationDigest);
}

describe('SandboxExecutionProvider', () => {
  test.skipIf(process.platform === 'win32')(
    'confirms an allocating intent made no POSIX runtime when its private base is absent',
    () => {
      const isolatedTemp = mkdtempSync(join(tmpdir(), 'kite-sandbox-absent-runtime-base-'));
      const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-absent-runtime-workspace-'));
      const previousTmpdir = process.env.TMPDIR;
      try {
        process.env.TMPDIR = isolatedTemp;
        const roots = sandboxRuntimeRootsForPreparation(workspace, 'sha256:absent-runtime');
        expect(existsSync(join(isolatedTemp, 'openpx-sandbox-runtime'))).toBe(false);
        expect(existsSync(join(isolatedTemp, 'openpx-sandbox-control'))).toBe(false);
        expect(cleanupPosixSandboxRuntimeRootsNoSpawn(roots)).toBe(true);
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
      const runtimeRoot = createWindowsSandboxRuntimeDirForPreparation(
        workspace,
        'sha256:already-removed',
      );

      expect(cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeRoot)).toBe(true);
      expect(existsSync(join(isolatedTemp, 'openpx-sandbox-runtime'))).toBe(false);
      expect(cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeRoot)).toBe(true);
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: () => ({ ok: false, failure: { code: 'fake_denied', message: 'deny' } }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTest({
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
    const authority = new SandboxExecutionGrantAuthority();
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
        const grants = new SandboxExecutionGrantAuthority();
        const provider = new ScriptableFakeSandboxExecutionProvider({
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
          | { prepared: Readonly<PreparedSandboxExecution> | null; disposed: boolean }
          | undefined;
        const result = await createBuiltinSandboxExecutionConsumerForTest({
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
      const deniedBeforeAck = await createBuiltinSandboxExecutionConsumerForTest({
        resolveProviderAfterIntent: () => {
          probes += 1;
          throw new Error('probe must not run');
        },
        resourceSemantics: 'allocating',
        backend: 'seatbelt',
        grants: new SandboxExecutionGrantAuthority(),
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
      const grants = new SandboxExecutionGrantAuthority();
      let reconciled = false;
      const provider = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          runtimeRoot = createWindowsSandboxRuntimeDirForPreparation(
            workspace,
            grant.preparationDigest,
          );
          expectedRuntimeRoot = realpathSync.native(
            sandboxRuntimeDirForPreparation(workspace, grant.preparationDigest),
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
      const result = await createBuiltinSandboxExecutionConsumerForTest({
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
      const store = new SandboxPreparationArtifactStore({
        root: storeRoot,
      });
      const preparation = samplePreparation(workspace);
      const prepared = plan(
        preparation,
        sandboxPreparationDigest(preparation),
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
      ).toThrow(SandboxPreparationArtifactError);

      const ref = store.write(prepared);
      const sibling = join(root, 'sibling');
      mkdirSync(sibling);
      const siblingPayload = Buffer.from(
        canonicalModelJson({
          artifactFormatVersion: 1,
          prepared: { ...prepared, cwd: sibling },
        }),
        'utf8',
      );
      const siblingRef = privateArtifactReference(
        'sandbox-preparations',
        'sandbox_preparation',
        siblingPayload,
      );
      const siblingTarget = join(storeRoot, 'plans', `${siblingRef.artifactId}.json`);
      writeFileSync(siblingTarget, siblingPayload);
      if (process.platform !== 'win32') chmodSync(siblingTarget, 0o600);
      expect(() => store.read(siblingRef)).toThrow(SandboxPreparationArtifactError);

      const target = join(storeRoot, 'plans', `${ref.artifactId}.json`);
      writeFileSync(target, '{"artifactFormatVersion":1,"prepared":{"extra":true}}', 'utf8');
      if (process.platform !== 'win32') chmodSync(target, 0o600);
      try {
        store.read(ref);
        throw new Error('expected typed Artifact corruption');
      } catch (error) {
        expect(error).toBeInstanceOf(SandboxPreparationArtifactError);
        if (!(error instanceof SandboxPreparationArtifactError)) throw error;
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
        const grants = new SandboxExecutionGrantAuthority();
        const runtimeDirectory = createTestRuntimeDir(workspace, 'shared-plan');
        const controlRoot = join(runtimeDirectory, 'control');
        const dataRoot = join(runtimeDirectory, 'data');
        mkdirSync(controlRoot);
        mkdirSync(dataRoot);
        let sharedPlan: PreparedSandboxExecution | undefined;
        const fake = new ScriptableFakeSandboxExecutionProvider({
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
        const consumer = createBuiltinSandboxExecutionConsumerForTest(consumerOptions);
        let consumed = false;
        const lifecycle: SandboxPreparationLifecycle = {
          async recordPreparationIntent(preparation: SandboxPreparation) {
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
        const second = await createBuiltinSandboxExecutionConsumerForTest(consumerOptions)(input);
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
            observation: deepFreezeSandboxFixture({
              ...prepared,
              approvedArgv: ['/bin/sh', '-c', 'printf changed'],
              argv: ['/bin/sh', '-c', 'touch must-not-exist'],
            }),
          };
        },
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTest({
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => ({
          ok: true,
          observation: deepFreezeSandboxFixture({
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
      const result = await createBuiltinSandboxExecutionConsumerForTest({
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

  test.each([
    'seatbelt',
    'bubblewrap',
  ] as const)('explicitly approved network reaches the prepared process without claiming allowlist enforcement: %s', async (backend) => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-approved-network-'));
    try {
      const grants = new SandboxExecutionGrantAuthority();
      const transitions: string[] = [];
      let processCalls = 0;
      const completedPort = createCompletedPreparedProcessPortForTest();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          const candidate = plan(
            grant.preparation,
            grant.preparationDigest,
            workspace,
            `approved-network-${backend}`,
            'allocating',
          );
          const prepared = deepFreezeSandboxFixture({
            ...candidate,
            backend,
            backendCapabilities: {
              ...candidate.backendCapabilities,
              backend,
            },
          });
          // Current platform evidence remains deliberately conservative. An
          // explicit approval can authorize this one invocation, but must
          // never rewrite the backend fact into an enforcement claim.
          expect(prepared.backendCapabilities.network.allowlist).toBe('unsupported');
          return { ok: true, observation: prepared };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        backend,
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
        preparedProcess: Object.freeze({
          execute: async (input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0]) => {
            processCalls += 1;
            transitions.push('process');
            expect(input.prepared.backendCapabilities.network.allowlist).toBe('unsupported');
            expect(input.prepared.backend).toBe(backend);
            expect(input.prepared.approvedArgv.at(-1)?.endsWith('printf approved-network')).toBe(
              true,
            );
            const supervisor = await input.lifecycle.recordExecutionSupervisorStarted(
              input.prepared,
              {
                dispatchId: input.dispatchIntent.dispatchId,
                dispatchIntentDigest: input.dispatchIntent.dispatchIntentDigest,
                supervisorPid: 1,
                processGroupId: 1,
                processStartIdentity: 'approved-network-process',
              },
            );
            expect(supervisor.acknowledged).toBe(true);
            return completedPort.execute(input);
          },
        }),
      })({
        workspace,
        command: 'printf approved-network',
        filesystemMode: 'workspace_only',
        networkMode: 'allow_all',
        sandboxInvocationIdentity: invocationIdentity(),
        sandboxPreparationLifecycle: {
          async recordPreparationIntent(preparation) {
            transitions.push('intent');
            return preparationIntentAcknowledgement(preparation);
          },
          async recordPreparationReady(prepared) {
            transitions.push('ready');
            return preparationReadyAcknowledgement(prepared);
          },
          async recordExecutionDispatchIntent(_prepared, dispatch) {
            transitions.push('dispatch');
            return dispatchAcknowledgement(dispatch);
          },
          async recordExecutionSupervisorStarted(_prepared, started) {
            transitions.push('supervisor');
            return supervisorAcknowledgement(started);
          },
          async recordDisposalIntent(prepared) {
            transitions.push('dispose-intent');
            expect(prepared).not.toBeNull();
            return Object.freeze({
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'dispose' as const,
              lifecycleIntentDigest: 'approved-network-dispose',
              cleanupAttempt: 1,
            });
          },
          async recordDisposalReceipt(receipt) {
            transitions.push('dispose-receipt');
            return disposalReceiptAcknowledgement(receipt);
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        exitCode: 0,
      });
      expect(processCalls).toBe(1);
      expect(transitions).toEqual([
        'intent',
        'ready',
        'dispatch',
        'process',
        'supervisor',
        'dispose-intent',
        'dispose-receipt',
      ]);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 1, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('sealed backend evidence mismatch is denied before dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthority();
      let processCalls = 0;
      const completedPort = createCompletedPreparedProcessPortForTest();
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
            observation: deepFreezeSandboxFixture({
              ...prepared,
              backendCapabilities: {
                ...prepared.backendCapabilities,
                network: { off: 'unsupported', allowlist: 'unsupported' },
              },
            }),
          };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
        preparedProcess: Object.freeze({
          execute: async (input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0]) => {
            processCalls += 1;
            return completedPort.execute(input);
          },
        }),
      })({
        workspace,
        command: 'printf must-not-dispatch',
        sandboxInvocationIdentity: invocationIdentity(),
      });
      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('backend evidence mismatch');
      expect(processCalls).toBe(0);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('Windows approved network without a full filesystem grant is denied before dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-windows-network-scope-'));
    try {
      const grants = new SandboxExecutionGrantAuthority();
      let processCalls = 0;
      const completedPort = createCompletedPreparedProcessPortForTest();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: (grant) => {
          expect(grant.preparation.networkMode).toBe('allow_all');
          expect(grant.preparation.filesystemMode).toBe('workspace_only');
          return {
            ok: false,
            failure: {
              code: 'backend_unavailable',
              message: 'approved_network_requires_full_filesystem_scope',
            },
          };
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        backend: 'windows_restricted_token',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
        preparedProcess: Object.freeze({
          execute: async (input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0]) => {
            processCalls += 1;
            return completedPort.execute(input);
          },
        }),
      })({
        workspace,
        command: 'printf must-not-run',
        filesystemMode: 'workspace_only',
        networkMode: 'allow_all',
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
            throw new Error('supervisor must not be reached');
          },
          async recordDisposalIntent(prepared) {
            expect(prepared).toBeNull();
            return Object.freeze({
              acknowledged: true as const,
              stage: 'disposal_intent' as const,
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest: 'windows-network-abandonment',
              cleanupAttempt: 1,
            });
          },
          async recordDisposalReceipt(receipt) {
            return disposalReceiptAcknowledgement(receipt);
          },
        },
      });

      expect(result).toMatchObject({
        ok: false,
        terminationReason: 'sandbox_denied',
        sandboxFailure: { code: 'backend_unavailable', stage: 'pre_dispatch' },
      });
      expect(result.stderr).toContain('approved_network_requires_full_filesystem_scope');
      expect(processCalls).toBe(0);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('policy-proven read-only execution cannot combine with full filesystem access', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-read-only-full-scope-'));
    try {
      const grants = new SandboxExecutionGrantAuthority();
      let processCalls = 0;
      const completedPort = createCompletedPreparedProcessPortForTest();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        prepare: (grant) => ({
          ok: true,
          observation: deepFreezeSandboxFixture(
            plan(grant.preparation, grant.preparationDigest, workspace, 'read-only-full-scope'),
          ),
        }),
      });
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        backend: 'seatbelt',
        grants,
        canonicalWorkspace: workspace,
        executionBoundaryDigest: 'boundary',
        protectedPathRevision: 'protected',
        preparedProcess: Object.freeze({
          execute: async (input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0]) => {
            processCalls += 1;
            return completedPort.execute(input);
          },
        }),
      })({
        workspace,
        command: 'printf must-not-run',
        filesystemMode: 'allow_all',
        executionTrust: 'policy_proven_read_only',
        sandboxInvocationIdentity: invocationIdentity(),
      });

      expect(result.terminationReason).toBe('sandbox_denied');
      expect(result.stderr).toContain('cannot combine full filesystem access with read-only trust');
      expect(processCalls).toBe(0);
      expect(fake.calls()).toEqual({ prepare: 1, dispose: 0, reconcile: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('ready acknowledgement failure disposes and spawns zero processes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-provider-'));
    try {
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
      const consumer = createBuiltinSandboxExecutionConsumerForTest({
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
      const consumer = createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        preparedProcess: createCompletedPreparedProcessPortForTest(),
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
          const runtimeRoots = sandboxRuntimeRootsForPreparation(
            workspace,
            grant.preparationDigest,
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixture({
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
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        resourceSemantics: 'allocating',
        preparedProcess: createCompletedPreparedProcessPortForTest(),
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
      const grants = new SandboxExecutionGrantAuthority();
      const preparation = samplePreparation(workspace);
      const runtimeRoots = createPosixSandboxRuntimeRootsForPreparation(
        workspace,
        sandboxPreparationDigest(preparation),
      );
      expect(dirname(runtimeRoots.controlRoot)).not.toBe(dirname(runtimeRoots.dataRoot));
      const externalSentinel = join(workspace, 'external-sentinel');
      if (process.platform !== 'win32') {
        writeFileSync(join(runtimeRoots.dataRoot, 'x'.repeat(255)), 'max-name');
        writeFileSync(externalSentinel, 'must-survive');
        symlinkSync(externalSentinel, join(runtimeRoots.dataRoot, 'external-link'));
      }
      try {
        const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
          backend: 'seatbelt',
          canonicalWorkspace: workspace,
        });
        const prepared: PreparedSandboxExecution = {
          ...plan(
            preparation,
            sandboxPreparationDigest(preparation),
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
    'Seatbelt preparation admits a canonical workspace without a synthetic containment gate',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-sandbox-canonical-'));
      const workspace = join(root, 'workspace');
      const alias = join(root, 'workspace-alias');
      mkdirSync(workspace);
      symlinkSync(workspace, alias, 'dir');
      try {
        const grants = new SandboxExecutionGrantAuthority();
        const preparation = samplePreparation(workspace);
        const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
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
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.failure.message);
        expect(
          (
            await provider.dispose({
              grant: grants.issueCleanup({
                purpose: 'dispose',
                prepared: result.observation,
                lifecycleIntentDigest: 'seatbelt-test-disposal',
                cleanupAttempt: 1,
                cleanupConfirmed: true,
              }),
              prepared: result.observation,
            })
          ).ok,
        ).toBe(true);
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

        expect(removeDirectoryTreeAt(parentFd, 'hardlink-tree')).toBe(false);
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

        expect(removeDirectoryTreeAt(parentFd, 'special-tree')).toBe(false);
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

        expect(removeDirectoryTreeAt(parentFd, 'pinned-tree')).toBe(true);
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
      const grants = new SandboxExecutionGrantAuthority();
      let disposedReceipt: boolean | undefined;
      const fake = new ScriptableFakeSandboxExecutionProvider({
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
          const runtimeRoots = sandboxRuntimeRootsForPreparation(
            workspace,
            grant.preparationDigest,
          );
          return {
            ok: true,
            observation: deepFreezeSandboxFixture({
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
      const result = await createBuiltinSandboxExecutionConsumerForTest({
        provider: fake,
        resourceSemantics: 'allocating',
        preparedProcess: createCompletedPreparedProcessPortForTest(),
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
        let state = createRuntimeHostStateInitialState({
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
        const preparationDigest = sandboxPreparationDigest(preparation);
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
        const runtimeDirectory = createSandboxRuntimeDirForPreparation(
          workspace,
          preparationDigest,
        );
        const grants = new SandboxExecutionGrantAuthority();
        const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
          backend: 'seatbelt',
          canonicalWorkspace: workspace,
        });
        const artifacts = new SandboxPreparationArtifactStore({
          root: join(root, 'sandbox-preparations'),
        });

        expect(
          await reconcilePendingSandboxPreparationsAfterCrash({
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        prepare: () => ({
          ok: false,
          failure: { code: 'fake_denied', message: 'Scriptable Fake denied prepare.' },
        }),
      });
      const consumer = createBuiltinSandboxExecutionConsumerForTest({
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
      const grants = new SandboxExecutionGrantAuthority();
      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        prepare: () => {
          throw new Error('Fake lost its preparation handle.');
        },
      });
      const result = await createBuiltinSandboxExecutionConsumerForTest({
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
      let state = createRuntimeHostStateInitialState({
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
      const artifacts = new SandboxPreparationArtifactStore({
        root: join(root, 'sandbox-preparations'),
      });
      const preparedTool = sandboxPreparedToolPacket();
      const acknowledgement = sandboxAttemptAcknowledgement(preparedTool);
      const lifecycle = createAppToolPipelineSandboxLifecycle({
        prepared: preparedTool,
        resolveOpenAcknowledgement: (candidate) =>
          candidate === preparedTool ? acknowledgement : null,
        getState: persistence.getState,
        persistEvents: persistence.persistEvents,
        now: () => new Date().toISOString(),
        artifacts,
      });
      const preparation = deepFreezeSandboxFixture(samplePreparation(workspace));
      const intent = await lifecycle.recordPreparationIntent(preparation);
      const fixedNow = Date.now();
      const grants = new SandboxExecutionGrantAuthority({ now: () => fixedNow });
      const grant = grants.issue({
        preparation,
        resourceSemantics: 'allocating',
        preparationIntentDigest: intent.intentDigest,
      });
      const prepared = deepFreezeSandboxFixture(
        plan(preparation, grant.preparationDigest, workspace, 'crashed-plan', 'allocating'),
      );
      expect(await lifecycle.recordPreparationReady(prepared)).toMatchObject({
        acknowledged: true,
        stage: 'preparation_ready',
      });

      const fake = new ScriptableFakeSandboxExecutionProvider({
        verifier: grants.verifier(),
        resourceSemantics: 'allocating',
        prepare: () => ({ ok: true, observation: prepared }),
        reconcile: () => {
          if (fake.calls().reconcile === 1) throw new Error('cleanup transport lost its receipt');
          return { ok: true, observation: { disposed: true } };
        },
      });
      expect(
        await reconcileSandboxPreparationAfterCrash({
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
        await reconcileSandboxPreparationAfterCrash({
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
        const grants = new SandboxExecutionGrantAuthority();
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
        const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
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

function sandboxPreparedToolPacket(): Readonly<PreparedToolInvocation> {
  const identity = {
    invocationId: 'invocation',
    attemptId: 'invocation:attempt:1',
    toolCallId: 'tool-call',
    turnId: 'turn-sandbox-recovery',
    modelMessageId: 'message-sandbox-recovery',
    argumentOrigin: 'model_public' as const,
    providerId: 'builtin-provider',
    operationId: 'builtin:shell_execute' as NonDynamicOperationId,
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
  return deepFreezeSandboxFixture({
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
  }) as Readonly<PreparedToolInvocation>;
}

function sandboxAttemptAcknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<ToolPipelineAttemptAcknowledgement> {
  return deepFreezeSandboxFixture({
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

function deepFreezeSandboxFixture<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeSandboxFixture(nested);
    }
  }
  return value;
}

function samplePreparation(workspace: string): SandboxPreparation {
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
    commandDigest: sandboxCommandDigest(argv),
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

function intentDigest(preparation: SandboxPreparation): string {
  return sandboxPreparationIntentDigest({
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigest(preparation),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
  });
}

function preparationIntentAcknowledgement(preparation: SandboxPreparation) {
  return Object.freeze({
    acknowledged: true as const,
    stage: 'preparation_intent' as const,
    intentDigest: intentDigest(preparation),
  });
}

function preparationReadyAcknowledgement(prepared?: Readonly<PreparedSandboxExecution>) {
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
  preparation: SandboxPreparation,
  preparationDigest: string,
  workspace: string,
  planId: string,
  resourceSemantics: 'pure' | 'allocating' = 'pure',
): PreparedSandboxExecution {
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
  namespace: string,
  kind: 'sandbox_preparation',
  bytes: Uint8Array,
) {
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const identityMaterial = `${namespace}\0${kind}\0${contentDigest}`;
  const artifactId = `pa_${createHash('sha256')
    .update('kite.private-immutable-artifact.id.v1\0')
    .update(identityMaterial)
    .digest('hex')}`;
  const integrityIdentifier = `sha256:${createHash('sha256')
    .update('kite.private-immutable-artifact.integrity.v1\0')
    .update(identityMaterial)
    .update('\0')
    .update(artifactId)
    .update('\0')
    .update(String(bytes.byteLength))
    .digest('hex')}`;
  return { artifactId, kind, integrityIdentifier, byteLength: bytes.byteLength } as const;
}
