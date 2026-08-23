import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';

import {
  SandboxPreparationArtifactStore,
  sandboxPreparationDigest,
} from '@kite/builtin-runtime/sandbox';
import {
  createDeterministicRuntimeIdSource,
  createRuntimeHostSandboxPreparedProcessExecutionPort,
  type RuntimeHostExecutionServices,
  type StateRuntimeState,
} from '@kite/runtime-host';
import {
  createRuntimeHostStateInitialState,
  createRuntimeHostStateSession,
  type StateRuntimeSessionInput,
} from '@kite/runtime-host/kernel-adapter';
import type {
  ExecutionBackendCapabilities,
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedSandboxExecution,
  PreparedToolInvocation,
  SandboxExecutionDispatchIntentAcknowledgement,
  SandboxPreparation,
  ToolPipelineAttemptAcknowledgement,
} from '@kite/runtime-spi';
import {
  AppToolPipelineSandboxLifecycleError,
  createAppToolPipelineSandboxLifecycle,
} from '#app/bootstrap/runtime/tool-pipeline-sandbox-lifecycle';

const NOW = '2026-08-22T00:00:00.000Z';
const WORKSPACE = '/workspace';
const EFFECTS = Object.freeze({
  filesystem: 'none' as const,
  network: 'none' as const,
  externalState: 'none' as const,
});
const EFFECTS_DIGEST = digestCapabilityValue(EFFECTS);

const backendCapabilities: ExecutionBackendCapabilities = deepFreeze({
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

function preparedTool(): Readonly<PreparedToolInvocation> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentity>;
} {
  const identity: NonDynamicPreparedToolInvocationIdentity = {
    invocationId: 'invocation-sandbox-lifecycle',
    attemptId: 'invocation-sandbox-lifecycle:attempt:1',
    toolCallId: 'tool-call-sandbox-lifecycle',
    turnId: 'turn-sandbox-lifecycle',
    modelMessageId: 'message-sandbox-lifecycle',
    argumentOrigin: 'model_public',
    providerId: 'builtin-provider',
    operationId: 'builtin:shell_execute' as NonDynamicOperationId,
    executionFamily: 'builtin',
    executionMechanism: 'shell',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'shell-capability-v1',
    descriptorRevision: 'shell-descriptor-v1',
    parserRevision: 'shell-parser-v1',
    executorRevision: 'shell-executor-v1',
    argumentsDigest: digestCapabilityValue({ command: 'printf hello' }),
    schemaDigest: 'shell-schema-v1',
    effectiveEffectsDigest: EFFECTS_DIGEST,
    policyDigest: 'shell-policy-v1',
    authorizationDigest: 'shell-authorization-v1',
    admissionDigest: 'shell-admission-v1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: 'shell_execute',
    builtinProjectionRevision: 'builtin-projection-v1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: 'computer',
  };
  return deepFreeze({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { command: 'printf hello' },
      request: {
        schema: 'kite.tool-pipeline-prepared-request.v1',
        authorizationKind: 'policy_allow',
        grantUsed: 'none',
        policyEffects: {},
        effectiveEffects: EFFECTS,
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
  });
}

function openAcknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<ToolPipelineAttemptAcknowledgement> {
  const identity = prepared.identity;
  return deepFreeze({
    acknowledged: true,
    attempt: {
      ...identity,
      attempt: 1,
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      recordedAt: NOW,
      startedAt: NOW,
    },
  });
}

function preparation(prepared: Readonly<PreparedToolInvocation>): Readonly<SandboxPreparation> {
  return deepFreeze({
    schema: 'kite.sandbox-execution-provider.v1',
    toolCallId: prepared.identity.toolCallId,
    capabilityId: prepared.identity.capabilityId,
    capabilityRevision: prepared.identity.capabilityRevision,
    invocationId: prepared.identity.invocationId,
    attempt: 1,
    effectiveEffectsDigest: prepared.identity.effectiveEffectsDigest,
    admissionDigest: prepared.identity.admissionDigest!,
    canonicalWorkspace: WORKSPACE,
    argv: ['printf', 'hello'],
    commandDigest: 'command-digest-v1',
    executionBoundaryDigest: 'execution-boundary-v1',
    protectedPathRevision: 'protected-path-v1',
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
    cancellationCorrelation: 'cancel-sandbox-lifecycle',
  });
}

function preparedSandbox(
  prepared: Readonly<PreparedToolInvocation>,
  source: Readonly<SandboxPreparation>,
): Readonly<PreparedSandboxExecution> {
  return deepFreeze({
    schema: 'kite.sandbox-execution-provider.v1',
    kind: 'prepared_sandbox_execution',
    planId: 'plan-sandbox-lifecycle',
    toolCallId: prepared.identity.toolCallId,
    capabilityId: prepared.identity.capabilityId,
    capabilityRevision: prepared.identity.capabilityRevision,
    invocationId: prepared.identity.invocationId,
    attempt: 1,
    canonicalWorkspace: WORKSPACE,
    effectiveEffectsDigest: prepared.identity.effectiveEffectsDigest,
    admissionDigest: prepared.identity.admissionDigest!,
    preparationDigest: sandboxPreparationDigest(source),
    commandDigest: source.commandDigest,
    approvedArgv: source.argv,
    argv: source.argv,
    cwd: WORKSPACE,
    env: null,
    stdin: null,
    transport: 'stdio',
    backend: 'bubblewrap',
    backendCapabilities,
    enforcement: 'full',
    resourceSemantics: 'allocating',
    expiresAtMs: Date.parse(NOW) + 60_000,
    cleanup: { kind: 'none', resourceId: 'none', recoveryPayload: {} },
  });
}

function initialState(): StateRuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'sandbox-lifecycle-test',
    userId: 'user-sandbox-lifecycle',
    workspace: WORKSPACE,
    runtimeIdSource: createDeterministicRuntimeIdSource({
      seed: 'sandbox-lifecycle',
      epochMs: Date.parse(NOW),
    }),
  });
}

function services(): RuntimeHostExecutionServices<RuntimeEvent, StateRuntimeState> {
  return {
    sessions: {
      appendEvents: () => undefined,
      loadEventsStrict: () => [],
      saveSnapshot: () => undefined,
      loadSnapshot: () => null,
      loadSnapshotRecord: () => null,
      getLastEventPosition: () => 0,
      listSessions: () => [],
      setSessionName: () => undefined,
      getSessionModelRoute: () => null,
      setSessionModelRoute: () => undefined,
      deleteSession: () => undefined,
    },
    transactions: { commit: () => undefined },
    leases: {
      tryAcquire: () => true,
      renew: () => true,
      release: () => undefined,
      hasClaim: () => true,
    },
    checkpoints: {
      saveNamedSnapshot: () => undefined,
      loadNamedSnapshot: () => null,
      listNamedSnapshots: () => [],
      getNamedSnapshotEntry: () => null,
      restoreNamedSnapshot: () => false,
      forkSession: () => false,
      forkCurrentSession: () => false,
      recordFilePreimage: () => undefined,
      recordFilePostimage: () => undefined,
      fileRestorePlan: () => [],
    },
    recoveryIdentities: {
      read: () => 'a'.repeat(64),
      getOrCreate: (_sessionId, allocate) => allocate(),
      remove: () => undefined,
    },
  };
}

function createHarness(options: { readonly persist?: 'false' | 'throw' | 'stale' } = {}) {
  const prepared = preparedTool();
  const ack = openAcknowledgement(prepared);
  const source = preparation(prepared);
  const plan = preparedSandbox(prepared, source);
  const session = createRuntimeHostStateSession({
    state: initialState(),
    services: services(),
    clock: () => NOW,
    id: (kind) => `${kind}-sandbox-lifecycle`,
    sandboxAvailable: true,
  } satisfies StateRuntimeSessionInput);
  session.processEvent({
    type: 'tool.queued',
    toolCallId: prepared.identity.toolCallId,
    name: 'shell_execute',
    args: { command: 'printf hello' },
    modelMessageId: prepared.identity.modelMessageId,
  });
  const lease = session.beginEffect({
    type: 'run_tools',
    toolCallIds: [prepared.identity.toolCallId],
  });
  const recorded: RuntimeEvent = {
    type: 'capability.invocation_recorded',
    invocationId: ack.attempt.invocationId,
    toolCallId: ack.attempt.toolCallId,
    capabilityId: ack.attempt.capabilityId,
    capabilityRevision: ack.attempt.capabilityRevision,
    argumentsDigest: ack.attempt.argumentsDigest,
    authorizationDigest: ack.attempt.authorizationDigest!,
    admissionDigest: ack.attempt.admissionDigest!,
    effectiveEffectsDigest: ack.attempt.effectiveEffectsDigest,
    effectiveEffects: EFFECTS,
    receiptRequirement: 'effect_receipt',
    retryEligibility: 'none',
    recordedAt: NOW,
  };
  const started: RuntimeEvent = {
    type: 'capability.execution_started',
    invocationId: ack.attempt.invocationId,
    startedAt: NOW,
    attempt: ack.attempt.attempt,
  };
  expect(session.applyEffectEvents(lease, [recorded, started], 'attempt_start')).toBe(true);
  const store = new SandboxPreparationArtifactStore({
    root: join(
      mkdtempSync(join('/tmp', 'kite-sandbox-lifecycle-artifacts-')),
      'sandbox-preparations',
    ),
  });
  const lifecycle = createAppToolPipelineSandboxLifecycle({
    prepared,
    resolveOpenAcknowledgement: (candidate) => {
      expect(candidate).toBe(prepared);
      return ack;
    },
    getState: () => session.getState(),
    persistEvents: async (events) => {
      if (options.persist === 'throw') throw new Error('State unavailable');
      if (options.persist === 'false' || options.persist === 'stale') return false;
      return session.applyEffectEvents(lease, events, 'receipt_evidence');
    },
    now: () => NOW,
    artifacts: store,
  });
  return { prepared, ack, source, plan, lifecycle, session, lease, store };
}

describe('App State sandbox lifecycle composition', () => {
  test('accepts all six stages with exact State events and frozen acknowledgements', async () => {
    const harness = createHarness();
    const intent = await harness.lifecycle.recordPreparationIntent(harness.source);
    const ready = await harness.lifecycle.recordPreparationReady(harness.plan);
    const dispatch = await harness.lifecycle.recordExecutionDispatchIntent(harness.plan, {
      dispatchId: 'dispatch-sandbox-lifecycle',
      supervisorNonce: 'nonce-sandbox-lifecycle',
    });
    const started = await harness.lifecycle.recordExecutionSupervisorStarted(harness.plan, {
      dispatchId: dispatch.dispatchId,
      dispatchIntentDigest: dispatch.dispatchIntentDigest,
      supervisorPid: 42,
      processGroupId: 42,
      processStartIdentity: 'process-start-sandbox-lifecycle',
    });
    const disposal = await harness.lifecycle.recordDisposalIntent(harness.plan);
    const receipt = await harness.lifecycle.recordDisposalReceipt({
      prepared: harness.plan,
      purpose: disposal.purpose,
      lifecycleIntentDigest: disposal.lifecycleIntentDigest,
      cleanupAttempt: disposal.cleanupAttempt,
      disposed: true,
    });

    for (const acknowledgement of [intent, ready, dispatch, started, disposal, receipt]) {
      expect(acknowledgement.acknowledged).toBe(true);
      expect(Object.isFrozen(acknowledgement)).toBe(true);
    }
    expect(receipt).toMatchObject({ stage: 'disposal_receipt', disposed: true });
    const invocation =
      harness.session.getState().capabilities.invocations[harness.ack.attempt.invocationId];
    expect(invocation?.sandboxPreparationIntent?.intentDigest).toBe(intent.intentDigest);
    expect(invocation?.sandboxPreparationReady?.readyDigest).toBe(ready.readyDigest);
    expect(invocation?.sandboxExecutionDispatch?.status).toBe('supervisor_started');
    expect(invocation?.sandboxDisposal?.status).toBe('completed');
  });

  test('rejects an unacknowledged attempt before lifecycle creation and never reaches process execution', async () => {
    const prepared = preparedTool();
    const source = preparation(prepared);
    expect(() =>
      createAppToolPipelineSandboxLifecycle({
        prepared,
        resolveOpenAcknowledgement: () => null,
        getState: () => initialState(),
        persistEvents: async () => true,
        now: () => NOW,
        artifacts: new SandboxPreparationArtifactStore({
          root: join(
            mkdtempSync(join('/tmp', 'kite-sandbox-lifecycle-no-ack-')),
            'sandbox-preparations',
          ),
        }),
      }),
    ).toThrow(AppToolPipelineSandboxLifecycleError);
    void source;

    const harness = createHarness();
    let providerCalls = 0;
    const port = createRuntimeHostSandboxPreparedProcessExecutionPort({
      supervisor: {
        execute: async () => {
          providerCalls++;
          throw new Error('must not execute');
        },
      },
    });
    const result = await port.execute({
      prepared: harness.plan,
      dispatchIntent: Object.freeze({
        acknowledged: true,
        stage: 'execution_dispatch_intent',
        dispatchId: 'unacknowledged',
        supervisorNonce: 'unacknowledged',
        dispatchIntentDigest: 'unacknowledged',
      } satisfies SandboxExecutionDispatchIntentAcknowledgement),
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      kind: 'failed',
      failure: { code: 'dispatch_not_acknowledged' },
    });
    expect(providerCalls).toBe(0);
  });

  test('fails closed on out-of-order, cloned prepared, cloned dispatch ack, and tampered ack', async () => {
    const harness = createHarness();
    await expect(harness.lifecycle.recordPreparationReady(harness.plan)).rejects.toMatchObject({
      code: 'invalid_stage',
    });
    await harness.lifecycle.recordPreparationIntent(harness.source);
    const ready = await harness.lifecycle.recordPreparationReady(harness.plan);
    const clonedPlan = deepFreeze(structuredClone(harness.plan));
    await expect(
      harness.lifecycle.recordExecutionDispatchIntent(clonedPlan, {
        dispatchId: 'dispatch-clone-plan',
        supervisorNonce: 'nonce-clone-plan',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const dispatch = await harness.lifecycle.recordExecutionDispatchIntent(harness.plan, {
      dispatchId: 'dispatch-clone',
      supervisorNonce: 'nonce-clone',
    });
    const clonedDispatch = deepFreeze(structuredClone(dispatch));
    let supervisorCalls = 0;
    const clonedDispatchResult = await createRuntimeHostSandboxPreparedProcessExecutionPort({
      supervisor: {
        execute: async () => {
          supervisorCalls += 1;
          throw new Error('cloned dispatch must not execute');
        },
      },
    }).execute({
      prepared: harness.plan,
      dispatchIntent: clonedDispatch,
      lifecycle: harness.lifecycle,
      timeoutMs: 1_000,
    });
    expect(clonedDispatchResult).toMatchObject({
      kind: 'failed',
      failure: { code: 'dispatch_not_acknowledged' },
    });
    expect(supervisorCalls).toBe(0);
    await expect(
      harness.lifecycle.recordExecutionSupervisorStarted(harness.plan, {
        dispatchId: dispatch.dispatchId,
        dispatchIntentDigest: 'tampered',
        supervisorPid: 1,
        processGroupId: 1,
        processStartIdentity: 'tampered',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(ready.preparationArtifact).toBeDefined();
  });

  test('rejects State persist false, throw, and stale no-op', async () => {
    for (const mode of ['false', 'throw', 'stale'] as const) {
      const harness = createHarness({ persist: mode });
      await expect(harness.lifecycle.recordPreparationIntent(harness.source)).rejects.toMatchObject(
        { code: mode === 'stale' ? 'persistence_failed' : 'persistence_failed' },
      );
    }
  });

  test('accepts a real Artifact store clone round-trip but rejects corrupt Artifact evidence', async () => {
    const harness = createHarness();
    await harness.lifecycle.recordPreparationIntent(harness.source);
    await expect(harness.lifecycle.recordPreparationReady(harness.plan)).resolves.toMatchObject({
      stage: 'preparation_ready',
    });

    const corruptHarness = createHarness();
    const corruptStore = {
      write: () =>
        Object.freeze({
          artifactId: 'corrupt-artifact',
          kind: 'sandbox_preparation' as const,
          integrityIdentifier: 'corrupt-integrity',
          byteLength: 1,
        }),
      read: () => deepFreeze({ ...harness.plan, planId: 'corrupt-plan' }),
    };
    const corrupt = createAppToolPipelineSandboxLifecycle({
      prepared: corruptHarness.prepared,
      resolveOpenAcknowledgement: () => corruptHarness.ack,
      getState: () => corruptHarness.session.getState(),
      persistEvents: async (events) =>
        corruptHarness.session.applyEffectEvents(corruptHarness.lease, events, 'receipt_evidence'),
      now: () => NOW,
      artifacts: corruptStore,
    });
    await corrupt.recordPreparationIntent(corruptHarness.source);
    await expect(corrupt.recordPreparationReady(corruptHarness.plan)).rejects.toMatchObject({
      code: 'artifact_identity_mismatch',
    });
  });
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
