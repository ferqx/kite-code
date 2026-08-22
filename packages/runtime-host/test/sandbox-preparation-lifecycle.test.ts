import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExecutionBackendCapabilitiesV1,
  PreparedSandboxExecutionV1,
  SandboxExecutionDispatchIntentAcknowledgementV1,
  SandboxPreparationArtifactPortV1,
  SandboxPreparationArtifactRefV1,
  SandboxPreparationV1,
} from '@kite/runtime-spi';
import { SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1 } from '@kite/runtime-spi';
import type { RuntimeHostPreparedProcessInputV1 } from '../src/posix-supervisor';
import {
  createRuntimeHostSandboxPreparationLifecycleV1,
  createRuntimeHostSandboxPreparedProcessExecutionPortV1,
  RuntimeHostSandboxLifecycleErrorV1,
  type RuntimeHostSandboxLifecycleEvidencePortV1,
  type RuntimeHostSandboxLifecyclePersistenceV1,
  type RuntimeHostSandboxSupervisorPortV1,
} from '../src/sandbox-preparation-lifecycle';

const backendCapabilities: ExecutionBackendCapabilitiesV1 = deepFreeze({
  backend: 'bubblewrap',
  filesystem: {
    read_only: 'enforced',
    workspace_write: 'enforced',
    full_access: 'unsupported',
  },
  network: { off: 'enforced', allowlist: 'unsupported' },
  syscallFilter: 'enforced',
  processTreeLimit: 'enforced',
  childProcessInheritance: 'enforced',
  verifiedInProcessReadOnly: 'enforced',
});

const preparation: Readonly<SandboxPreparationV1> = deepFreeze({
  schema: SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1,
  toolCallId: 'tool-call-1',
  capabilityId: 'builtin:shell_execute',
  capabilityRevision: 'shell-v1',
  invocationId: 'invocation-1',
  attempt: 1,
  effectiveEffectsDigest: 'effects-1',
  admissionDigest: 'admission-1',
  canonicalWorkspace: '/workspace',
  argv: ['printf', 'hello'],
  commandDigest: 'command-1',
  executionBoundaryDigest: 'boundary-1',
  protectedPathRevision: 'protected-1',
  filesystemMode: 'workspace_only',
  networkMode: 'disabled',
  executionTrust: 'policy_proven_read_only',
  resourceLimits: {
    cpuTime: 10,
    virtualMemory: 1_024,
    fileSize: 1_024,
    fileDescriptors: 16,
    processes: 4,
    maxProcessTreeTasks: 4,
  },
  timeoutMs: 1_000,
  cancellationCorrelation: 'cancel-1',
});

const prepared: Readonly<PreparedSandboxExecutionV1> = deepFreeze({
  schema: SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1,
  kind: 'prepared_sandbox_execution',
  planId: 'plan-1',
  toolCallId: preparation.toolCallId,
  capabilityId: preparation.capabilityId,
  capabilityRevision: preparation.capabilityRevision,
  invocationId: preparation.invocationId,
  attempt: preparation.attempt,
  canonicalWorkspace: preparation.canonicalWorkspace,
  effectiveEffectsDigest: preparation.effectiveEffectsDigest,
  admissionDigest: preparation.admissionDigest,
  preparationDigest: 'preparation-1',
  commandDigest: preparation.commandDigest,
  approvedArgv: preparation.argv,
  argv: preparation.argv,
  cwd: preparation.canonicalWorkspace,
  env: null,
  stdin: null,
  transport: 'stdio',
  backend: 'bubblewrap',
  backendCapabilities,
  enforcement: 'full',
  resourceSemantics: 'allocating',
  expiresAtMs: 5_000,
  cleanup: { kind: 'none', resourceId: 'none', recoveryPayload: {} },
});

const artifactRef: Readonly<SandboxPreparationArtifactRefV1> = Object.freeze({
  artifactId: 'artifact-1',
  kind: 'sandbox_preparation',
  integrityIdentifier: 'artifact-integrity-1',
  byteLength: 256,
});

type LifecycleHarness = ReturnType<typeof createLifecycleHarness>;

function createLifecycleHarness(
  options: {
    readonly rejectEvidenceStage?: string;
    readonly failSupervisorPersistence?: boolean;
  } = {},
) {
  const order: string[] = [];
  const artifacts: SandboxPreparationArtifactPortV1 = {
    write(candidate) {
      order.push('artifact:write');
      expect(candidate).toBe(prepared);
      return artifactRef;
    },
    read(reference) {
      order.push('artifact:read');
      expect(reference).toBe(artifactRef);
      return prepared;
    },
  };
  const persistence: RuntimeHostSandboxLifecyclePersistenceV1 = {
    async persistPreparationIntent() {
      order.push('persist:preparation_intent');
      return Object.freeze({
        acknowledged: true,
        stage: 'preparation_intent',
        intentDigest: 'intent-1',
      });
    },
    async persistPreparationReady(input) {
      order.push('persist:preparation_ready');
      return Object.freeze({
        acknowledged: true,
        stage: 'preparation_ready',
        readyDigest: 'ready-1',
        preparationArtifact: input.preparationArtifact,
      });
    },
    async persistExecutionDispatchIntent(input) {
      order.push('persist:execution_dispatch_intent');
      return Object.freeze({
        acknowledged: true,
        stage: 'execution_dispatch_intent',
        dispatchId: input.dispatchId,
        supervisorNonce: input.supervisorNonce,
        dispatchIntentDigest: 'dispatch-intent-1',
      });
    },
    async persistExecutionSupervisorStarted(input) {
      order.push('persist:execution_supervisor_started');
      if (options.failSupervisorPersistence) throw new Error('supervisor persistence rejected');
      return Object.freeze({
        acknowledged: true,
        stage: 'execution_supervisor_started',
        dispatchId: input.dispatchIntent.dispatchId,
        dispatchIntentDigest: input.dispatchIntent.dispatchIntentDigest,
        supervisorPid: input.supervisorPid,
        processGroupId: input.processGroupId,
        processStartIdentity: input.processStartIdentity,
      });
    },
    async persistDisposalIntent(input) {
      order.push('persist:disposal_intent');
      return Object.freeze({
        acknowledged: true,
        stage: 'disposal_intent',
        purpose: input.prepared === null ? 'reconcile_preparation_intent' : 'dispose',
        lifecycleIntentDigest: 'disposal-intent-1',
        cleanupAttempt: 1,
      });
    },
    async persistDisposalReceipt(input) {
      order.push('persist:disposal_receipt');
      return Object.freeze({
        acknowledged: true,
        stage: 'disposal_receipt',
        purpose: input.disposalIntent.purpose,
        lifecycleIntentDigest: input.disposalIntent.lifecycleIntentDigest,
        cleanupAttempt: input.disposalIntent.cleanupAttempt,
        disposed: input.disposed,
      });
    },
  };
  const evidence: RuntimeHostSandboxLifecycleEvidencePortV1 = {
    verify(candidate) {
      order.push(`verify:${candidate.stage}`);
      return candidate.stage === options.rejectEvidenceStage
        ? { valid: false, code: 'not_reflected' }
        : { valid: true };
    },
  };
  return {
    lifecycle: createRuntimeHostSandboxPreparationLifecycleV1({
      persistence,
      evidence,
      artifacts,
    }),
    order,
  };
}

async function acknowledgeReady(harness: LifecycleHarness) {
  await harness.lifecycle.recordPreparationIntent(preparation);
  await harness.lifecycle.recordPreparationReady(prepared);
  return harness.lifecycle.recordExecutionDispatchIntent(prepared, {
    dispatchId: 'dispatch-1',
    supervisorNonce: 'nonce-1',
  });
}

function successfulSupervisor(onExecute?: (input: RuntimeHostPreparedProcessInputV1) => void) {
  let calls = 0;
  let goCalls = 0;
  const supervisor: RuntimeHostSandboxSupervisorPortV1 = {
    async execute(input) {
      calls += 1;
      onExecute?.(input);
      const started = await input.lifecycle.recordExecutionSupervisorStarted(input.prepared, {
        dispatchId: input.dispatchId,
        dispatchIntentDigest: input.dispatchIntentDigest,
        supervisorPid: 42,
        processGroupId: 42,
        processStartIdentity: 'process-start-1',
      });
      if (!started) throw new Error('supervisor acknowledgement rejected');
      input.onGoStarted?.();
      goCalls += 1;
      return {
        cleanupConfirmed: true,
        outcome: {
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
          processCleanup: clean(),
        },
      };
    },
  };
  return {
    supervisor,
    get calls() {
      return calls;
    },
    get goCalls() {
      return goCalls;
    },
  };
}

function clean() {
  return {
    confirmedExited: true,
    gracefulRequested: true,
    forced: false,
    unconfirmedDescendantCount: 0,
  } as const;
}

describe('Runtime Host sandbox lifecycle', () => {
  test('enforces the exact durable lifecycle order and Artifact identity', async () => {
    const harness = createLifecycleHarness();
    const dispatch = await acknowledgeReady(harness);
    await harness.lifecycle.recordExecutionSupervisorStarted(prepared, {
      dispatchId: dispatch.dispatchId,
      dispatchIntentDigest: dispatch.dispatchIntentDigest,
      supervisorPid: 42,
      processGroupId: 42,
      processStartIdentity: 'process-start-1',
    });
    const disposal = await harness.lifecycle.recordDisposalIntent(prepared);
    await harness.lifecycle.recordDisposalReceipt({
      prepared,
      purpose: disposal.purpose,
      lifecycleIntentDigest: disposal.lifecycleIntentDigest,
      cleanupAttempt: disposal.cleanupAttempt,
      disposed: true,
    });

    expect(harness.order).toEqual([
      'persist:preparation_intent',
      'verify:preparation_intent',
      'artifact:write',
      'artifact:read',
      'persist:preparation_ready',
      'verify:preparation_ready',
      'persist:execution_dispatch_intent',
      'verify:execution_dispatch_intent',
      'persist:execution_supervisor_started',
      'verify:execution_supervisor_started',
      'persist:disposal_intent',
      'verify:disposal_intent',
      'persist:disposal_receipt',
      'verify:disposal_receipt',
    ]);
  });

  test('fails closed on out-of-order, cloned, and unreflected evidence', async () => {
    const harness = createLifecycleHarness();
    await expect(harness.lifecycle.recordPreparationReady(prepared)).rejects.toBeInstanceOf(
      RuntimeHostSandboxLifecycleErrorV1,
    );
    await harness.lifecycle.recordPreparationIntent(preparation);
    await harness.lifecycle.recordPreparationReady(prepared);
    const cloned = deepFreeze({ ...prepared });
    await expect(
      harness.lifecycle.recordExecutionDispatchIntent(cloned, {
        dispatchId: 'dispatch-1',
        supervisorNonce: 'nonce-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const rejected = createLifecycleHarness({ rejectEvidenceStage: 'preparation_ready' });
    await rejected.lifecycle.recordPreparationIntent(preparation);
    await expect(rejected.lifecycle.recordPreparationReady(prepared)).rejects.toMatchObject({
      code: 'evidence_rejected',
    });
    await expect(
      rejected.lifecycle.recordExecutionDispatchIntent(prepared, {
        dispatchId: 'dispatch-2',
        supervisorNonce: 'nonce-2',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('executes only one exact acknowledged dispatch', async () => {
    const harness = createLifecycleHarness();
    const dispatch = await acknowledgeReady(harness);
    const fake = successfulSupervisor();
    const port = createRuntimeHostSandboxPreparedProcessExecutionPortV1({
      supervisor: fake.supervisor,
    });

    const first = await port.execute({
      prepared,
      dispatchIntent: dispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    const duplicate = await port.execute({
      prepared,
      dispatchIntent: dispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(first).toMatchObject({ kind: 'completed', executionPhase: 'go_started', exitCode: 0 });
    expect(duplicate).toMatchObject({
      kind: 'failed',
      executionPhase: 'not_started',
      failure: { code: 'dispatch_not_acknowledged' },
    });
    expect(fake.calls).toBe(1);
    expect(fake.goCalls).toBe(1);
  });

  test('rejects cloned dispatch authority before supervisor or GO', async () => {
    const harness = createLifecycleHarness();
    const dispatch = await acknowledgeReady(harness);
    const fake = successfulSupervisor();
    const port = createRuntimeHostSandboxPreparedProcessExecutionPortV1({
      supervisor: fake.supervisor,
    });
    const clonedDispatch: SandboxExecutionDispatchIntentAcknowledgementV1 = Object.freeze({
      ...dispatch,
    });
    const result = await port.execute({
      prepared,
      dispatchIntent: clonedDispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      kind: 'failed',
      executionPhase: 'not_started',
      failure: { code: 'dispatch_not_acknowledged' },
    });
    expect(fake.calls).toBe(0);
    expect(fake.goCalls).toBe(0);
  });

  test('requires supervisor-start persistence before GO', async () => {
    const harness = createLifecycleHarness({ failSupervisorPersistence: true });
    const dispatch = await acknowledgeReady(harness);
    const fake = successfulSupervisor();
    const port = createRuntimeHostSandboxPreparedProcessExecutionPortV1({
      supervisor: fake.supervisor,
    });
    const result = await port.execute({
      prepared,
      dispatchIntent: dispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      kind: 'failed',
      executionPhase: 'supervisor_started_before_go',
      failure: { code: 'supervisor_start_not_acknowledged' },
    });
    expect(fake.calls).toBe(1);
    expect(fake.goCalls).toBe(0);
  });

  test('never downgrades post-GO terminal, transport, or cleanup uncertainty', async () => {
    const cases = [
      {
        code: 'post_go_terminal_unknown',
        execute: async (input: RuntimeHostPreparedProcessInputV1) => {
          await recordSupervisorStarted(input);
          input.onGoStarted?.();
          return {
            cleanupConfirmed: true,
            outcome: {
              exitCode: -1,
              stdout: '',
              stderr: 'terminal unavailable',
              processCleanup: clean(),
            },
          };
        },
      },
      {
        code: 'post_go_transport_lost',
        execute: async (input: RuntimeHostPreparedProcessInputV1) => {
          await recordSupervisorStarted(input);
          input.onGoStarted?.();
          throw new Error('transport lost');
        },
      },
      {
        code: 'post_go_cleanup_unknown',
        execute: async (input: RuntimeHostPreparedProcessInputV1) => {
          await recordSupervisorStarted(input);
          input.onGoStarted?.();
          return {
            cleanupConfirmed: false,
            outcome: {
              exitCode: 0,
              stdout: '',
              stderr: 'cleanup unknown',
              processCleanup: {
                confirmedExited: false,
                gracefulRequested: true,
                forced: true,
                unconfirmedDescendantCount: 1,
              },
            },
          };
        },
      },
    ] as const;

    for (const candidate of cases) {
      const harness = createLifecycleHarness();
      const dispatch = await acknowledgeReady(harness);
      const port = createRuntimeHostSandboxPreparedProcessExecutionPortV1({
        supervisor: { execute: candidate.execute },
      });
      const result = await port.execute({
        prepared,
        dispatchIntent: dispatch,
        lifecycle: harness.lifecycle,
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({
        kind: 'unknown',
        executionPhase: 'unknown_after_go',
        unknown: { code: candidate.code },
        retryable: false,
      });
    }
  });

  test('projects abort terminal and exact cleanup without changing its certainty', async () => {
    const harness = createLifecycleHarness();
    const dispatch = await acknowledgeReady(harness);
    const port = createRuntimeHostSandboxPreparedProcessExecutionPortV1({
      supervisor: {
        async execute(input) {
          await recordSupervisorStarted(input);
          input.onGoStarted?.();
          return {
            cleanupConfirmed: true,
            outcome: {
              exitCode: 130,
              stdout: '',
              stderr: 'cancelled',
              terminationReason: 'cancelled',
              processCleanup: {
                confirmedExited: true,
                gracefulRequested: true,
                forced: true,
                unconfirmedDescendantCount: 0,
              },
            },
          };
        },
      },
    });
    const result = await port.execute({
      prepared,
      dispatchIntent: dispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      kind: 'terminated',
      executionPhase: 'go_started',
      terminationReason: 'cancelled',
      processCleanup: { confirmedExited: true, forced: true, unconfirmedDescendantCount: 0 },
    });
  });

  test('keeps package direction clean and marks GO immediately before its write', () => {
    const lifecycleSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'sandbox-preparation-lifecycle.ts'),
      'utf8',
    );
    expect(lifecycleSource).not.toMatch(
      /(?:from\s+|import\s*\()\s*['"](?:@kite\/(?:builtin-runtime|agent-kernel)|#app|@\/core)/,
    );
    expect(lifecycleSource).not.toMatch(
      /\b(?:State26|Store4|RuntimeEvent|createHash|createHmac)\b/,
    );

    const supervisorSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'posix-supervisor.ts'),
      'utf8',
    );
    const marker = supervisorSource.indexOf('input.onGoStarted?.();');
    const write = supervisorSource.indexOf('socket.write(', marker);
    expect(marker).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(marker);
  });
});

async function recordSupervisorStarted(input: RuntimeHostPreparedProcessInputV1): Promise<void> {
  const accepted = await input.lifecycle.recordExecutionSupervisorStarted(input.prepared, {
    dispatchId: input.dispatchId,
    dispatchIntentDigest: input.dispatchIntentDigest,
    supervisorPid: 42,
    processGroupId: 42,
    processStartIdentity: 'process-start-1',
  });
  if (!accepted) throw new Error('supervisor acknowledgement rejected');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
