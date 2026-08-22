import { digestCapabilityValueV1 } from '@kite/builtin-runtime';
import {
  type SandboxPreparationArtifactStoreV1,
  sandboxAbandonmentLifecycleIntentDigestV1,
  sandboxDisposalLifecycleIntentDigestV1,
  sandboxPreparationDigestV1,
  sandboxPreparationIntentDigestV1,
  sandboxPreparationReadyDigestV1,
  sandboxPreparedPlanDigestV1,
} from '@kite/builtin-runtime/sandbox';
import {
  createRuntimeHostSandboxPreparationLifecycleV1,
  type RuntimeHostSandboxLifecycleEvidenceV1,
  type RuntimeHostSandboxLifecycleEvidenceVerificationResultV1,
  type State25RuntimeEventV1,
  type State25RuntimeStateV1,
} from '@kite/runtime-host';
import type {
  PreparedSandboxExecutionV1,
  PreparedToolInvocationV1,
  SandboxDisposalIntentAcknowledgementV1,
  SandboxDisposalReceiptAcknowledgementV1,
  SandboxExecutionDispatchIntentAcknowledgementV1,
  SandboxExecutionSupervisorStartedAcknowledgementV1,
  SandboxPreparationArtifactPortV1,
  SandboxPreparationIntentAcknowledgementV1,
  SandboxPreparationLifecycleV1,
  SandboxPreparationReadyAcknowledgementV1,
  SandboxPreparationV1,
  ToolPipelineAttemptAcknowledgementV1,
} from '@kite/runtime-spi';

export const APP_TOOL_PIPELINE_SANDBOX_LIFECYCLE_SCHEMA_V1 =
  'kite.app.tool-pipeline-sandbox-lifecycle.v1' as const;

export interface AppToolPipelineSandboxLifecyclePersistenceV1 {
  readonly getState: () => Readonly<State25RuntimeStateV1>;
  readonly persistEvents: (events: State25RuntimeEventV1[]) => Promise<boolean>;
  readonly now: () => string;
}

export interface CreateAppToolPipelineSandboxLifecycleInputV1
  extends AppToolPipelineSandboxLifecyclePersistenceV1 {
  /** Exact packet emitted by the App prepared-attempt composition. */
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  /** Returns the exact open State25 acknowledgement for this packet. */
  readonly resolveOpenAcknowledgement: (
    prepared: Readonly<PreparedToolInvocationV1>,
  ) => Readonly<ToolPipelineAttemptAcknowledgementV1> | null | undefined;
  /** Existing Builtin-owned durable Artifact store; App only wraps identity. */
  readonly artifacts: Pick<SandboxPreparationArtifactStoreV1, 'write' | 'read'>;
}

export type AppToolPipelineSandboxLifecycleErrorCodeV1 =
  | 'invalid_composition'
  | 'attempt_not_acknowledged'
  | 'prepared_identity_mismatch'
  | 'acknowledgement_mismatch'
  | 'invalid_stage'
  | 'persistence_failed'
  | 'state_mismatch'
  | 'artifact_identity_mismatch';

export class AppToolPipelineSandboxLifecycleErrorV1 extends Error {
  readonly code: AppToolPipelineSandboxLifecycleErrorCodeV1;

  constructor(code: AppToolPipelineSandboxLifecycleErrorCodeV1, message: string) {
    super(message);
    this.name = 'AppToolPipelineSandboxLifecycleErrorV1';
    this.code = code;
  }
}

type StageAck =
  | SandboxPreparationIntentAcknowledgementV1
  | SandboxPreparationReadyAcknowledgementV1
  | SandboxExecutionDispatchIntentAcknowledgementV1
  | SandboxExecutionSupervisorStartedAcknowledgementV1
  | SandboxDisposalIntentAcknowledgementV1
  | SandboxDisposalReceiptAcknowledgementV1;

type InvocationState = Readonly<State25RuntimeStateV1['capabilities']['invocations'][string]>;

interface StageBinding {
  readonly stage: StageAck['stage'];
  readonly acknowledgement: Readonly<StageAck>;
  readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
  readonly preparation?: Readonly<SandboxPreparationV1>;
  readonly preparationIntent?: Readonly<SandboxPreparationIntentAcknowledgementV1>;
  readonly preparationReady?: Readonly<SandboxPreparationReadyAcknowledgementV1> | null;
  readonly dispatchIntent?: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
  readonly disposalIntent?: Readonly<SandboxDisposalIntentAcknowledgementV1>;
}

/**
 * Compose the App State25 sandbox persistence owner with the generic Host
 * lifecycle.  State25 event encoding and acknowledgement evidence stay here;
 * Host owns stage ordering and the process-facing exact-object authority.
 */
export function createAppToolPipelineSandboxLifecycleV1(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInputV1>,
): SandboxPreparationLifecycleV1 {
  assertCompositionInputV1(input);
  const prepared = input.prepared;
  const openAcknowledgement = input.resolveOpenAcknowledgement(prepared);
  assertOpenAcknowledgementV1(prepared, openAcknowledgement);

  const stageBindings = new WeakMap<object, StageBinding>();
  const artifactPort = createExactArtifactPortV1(input.artifacts, prepared);
  const persistence = createHostPersistenceV1(input, prepared, openAcknowledgement, stageBindings);
  const evidence = createEvidencePortV1(input, prepared, openAcknowledgement, stageBindings);
  const lifecycle = createRuntimeHostSandboxPreparationLifecycleV1({
    persistence,
    evidence,
    artifacts: artifactPort,
  });
  return Object.freeze(lifecycle);
}

function createHostPersistenceV1(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInputV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
  openAcknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  stageBindings: WeakMap<object, StageBinding>,
) {
  let preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1> | undefined;
  let preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1> | undefined;
  let preparedSandbox: Readonly<PreparedSandboxExecutionV1> | undefined;
  let dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1> | undefined;
  let disposalIntent: Readonly<SandboxDisposalIntentAcknowledgementV1> | undefined;

  const persistPreparationIntent = async ({
    preparation,
  }: {
    readonly preparation: Readonly<SandboxPreparationV1>;
  }): Promise<Readonly<SandboxPreparationIntentAcknowledgementV1>> => {
    if (preparationIntent) failV1('invalid_stage', 'Preparation intent already exists.');
    assertPreparationMatchesPreparedV1(preparation, prepared, openAcknowledgement);
    const before = currentInvocationV1(input, openAcknowledgement, 'preparation intent');
    if (before.sandboxPreparationIntent) {
      failV1('state_mismatch', 'State25 already contains a sandbox preparation intent.');
    }
    const recordedAt = timestampV1(input.now());
    const body = {
      attempt: openAcknowledgement.attempt.attempt,
      toolCallId: preparation.toolCallId,
      capabilityId: preparation.capabilityId,
      capabilityRevision: preparation.capabilityRevision,
      canonicalWorkspace: preparation.canonicalWorkspace,
      effectiveEffectsDigest: preparation.effectiveEffectsDigest,
      admissionDigest: preparation.admissionDigest,
      preparationDigest: sandboxPreparationDigestV1(preparation),
      commandDigest: preparation.commandDigest,
      executionBoundaryDigest: preparation.executionBoundaryDigest,
      resourceSemantics: 'allocating' as const,
    };
    const intentDigest = sandboxPreparationIntentDigestV1(body);
    const event: State25RuntimeEventV1 = Object.freeze({
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: openAcknowledgement.attempt.invocationId,
      ...body,
      intentDigest,
      recordedAt,
    });
    await persistState25EventsV1(input, [event], 'preparation intent');
    const after = currentInvocationV1(input, openAcknowledgement, 'preparation intent');
    assertPreparationIntentStateV1(after, body, intentDigest, recordedAt);
    preparationIntent = Object.freeze({
      acknowledged: true,
      stage: 'preparation_intent',
      intentDigest,
    });
    stageBindings.set(preparationIntent, {
      stage: 'preparation_intent',
      acknowledgement: preparationIntent,
      prepared: null,
      preparation,
    });
    return preparationIntent;
  };

  const persistPreparationReady = async ({
    preparationIntent: intentAck,
    prepared: candidate,
    preparationArtifact,
  }: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly preparationArtifact: ReturnType<SandboxPreparationArtifactPortV1['write']>;
  }): Promise<Readonly<SandboxPreparationReadyAcknowledgementV1>> => {
    if (!preparationIntent || intentAck !== preparationIntent) {
      failV1('acknowledgement_mismatch', 'Preparation ready did not receive the exact intent ack.');
    }
    if (preparationReady) failV1('invalid_stage', 'Preparation ready already exists.');
    assertPreparedSandboxAttemptMatchesV1(candidate, openAcknowledgement);
    const before = currentInvocationV1(input, openAcknowledgement, 'preparation ready');
    if (
      !before.sandboxPreparationIntent ||
      before.sandboxPreparationIntent.intentDigest !== intentAck.intentDigest ||
      before.sandboxPreparationReady
    ) {
      failV1('state_mismatch', 'State25 is not open for sandbox preparation ready.');
    }
    const body = {
      attempt: openAcknowledgement.attempt.attempt,
      intentDigest: intentAck.intentDigest,
      preparationDigest: candidate.preparationDigest,
      commandDigest: candidate.commandDigest,
      planDigest: sandboxPreparedPlanDigestV1(candidate),
      backend: candidate.backend,
      backendCapabilitiesDigest: digestCapabilityValueV1(candidate.backendCapabilities),
      enforcement: candidate.enforcement,
      resourceSemantics: candidate.resourceSemantics,
      cleanupDigest: digestCapabilityValueV1(candidate.cleanup),
      preparationArtifact,
    };
    const readyDigest = sandboxPreparationReadyDigestV1(body);
    const readyAt = timestampV1(input.now());
    const event: State25RuntimeEventV1 = Object.freeze({
      type: 'capability.sandbox_preparation_ready',
      invocationId: openAcknowledgement.attempt.invocationId,
      ...body,
      readyDigest,
      readyAt,
    });
    await persistState25EventsV1(input, [event], 'preparation ready');
    const after = currentInvocationV1(input, openAcknowledgement, 'preparation ready');
    assertPreparationReadyStateV1(after, body, readyDigest, readyAt);
    preparationReady = Object.freeze({
      acknowledged: true,
      stage: 'preparation_ready',
      readyDigest,
      preparationArtifact,
    });
    preparedSandbox = candidate;
    stageBindings.set(preparationReady, {
      stage: 'preparation_ready',
      acknowledgement: preparationReady,
      prepared: candidate,
      preparationIntent: intentAck,
      preparationReady,
    });
    return preparationReady;
  };

  const persistExecutionDispatchIntent = async ({
    preparationReady: readyAck,
    prepared: candidate,
    dispatchId,
    supervisorNonce,
  }: {
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly dispatchId: string;
    readonly supervisorNonce: string;
  }): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>> => {
    if (!preparationReady || readyAck !== preparationReady) {
      failV1('acknowledgement_mismatch', 'Dispatch did not receive the exact ready ack.');
    }
    if (dispatchIntent) failV1('invalid_stage', 'Dispatch intent already exists.');
    assertPreparedSandboxMatchesV1(
      candidate,
      requiredPreparedSandboxV1(preparedSandbox),
      openAcknowledgement,
    );
    if (!nonEmptyV1(dispatchId) || !nonEmptyV1(supervisorNonce)) {
      failV1('invalid_stage', 'Dispatch identity must be non-empty.');
    }
    const before = currentInvocationV1(input, openAcknowledgement, 'dispatch intent');
    if (
      before.sandboxPreparationReady?.readyDigest !== readyAck.readyDigest ||
      before.sandboxExecutionDispatch
    ) {
      failV1('state_mismatch', 'State25 is not open for sandbox dispatch intent.');
    }
    const recordedAt = timestampV1(input.now());
    const planDigest = sandboxPreparedPlanDigestV1(candidate);
    const dispatchIntentDigest = digestCapabilityValueV1({
      kind: 'sandbox_execution_dispatch_intent_v1',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      planDigest,
      dispatchId,
      supervisorNonce,
    });
    const event: State25RuntimeEventV1 = Object.freeze({
      type: 'capability.sandbox_execution_dispatch_intent_recorded',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      planDigest,
      dispatchId,
      supervisorNonce,
      dispatchIntentDigest,
      recordedAt,
    });
    await persistState25EventsV1(input, [event], 'dispatch intent');
    const after = currentInvocationV1(input, openAcknowledgement, 'dispatch intent');
    assertDispatchIntentStateV1(after, event);
    dispatchIntent = Object.freeze({
      acknowledged: true,
      stage: 'execution_dispatch_intent',
      dispatchId,
      supervisorNonce,
      dispatchIntentDigest,
    });
    stageBindings.set(dispatchIntent, {
      stage: 'execution_dispatch_intent',
      acknowledgement: dispatchIntent,
      prepared: candidate,
      preparationReady: readyAck,
      dispatchIntent,
    });
    return dispatchIntent;
  };

  const persistExecutionSupervisorStarted = async ({
    dispatchIntent: dispatchAck,
    prepared: candidate,
    supervisorPid,
    processGroupId,
    processStartIdentity,
  }: {
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgementV1>> => {
    if (!dispatchIntent || dispatchAck !== dispatchIntent) {
      failV1(
        'acknowledgement_mismatch',
        'Supervisor start did not receive the exact dispatch ack.',
      );
    }
    assertPreparedSandboxMatchesV1(
      candidate,
      requiredPreparedSandboxV1(preparedSandbox),
      openAcknowledgement,
    );
    if (
      !Number.isSafeInteger(supervisorPid) ||
      !Number.isSafeInteger(processGroupId) ||
      !nonEmptyV1(processStartIdentity)
    ) {
      failV1('invalid_stage', 'Supervisor identity is invalid.');
    }
    const before = currentInvocationV1(input, openAcknowledgement, 'supervisor start');
    if (
      before.sandboxExecutionDispatch?.status !== 'intent_recorded' ||
      before.sandboxExecutionDispatch.dispatchId !== dispatchAck.dispatchId ||
      before.sandboxExecutionDispatch.dispatchIntentDigest !== dispatchAck.dispatchIntentDigest
    ) {
      failV1('state_mismatch', 'State25 is not open for supervisor start.');
    }
    const startedAt = timestampV1(input.now());
    const event: State25RuntimeEventV1 = Object.freeze({
      type: 'capability.sandbox_execution_supervisor_started',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      dispatchId: dispatchAck.dispatchId,
      dispatchIntentDigest: dispatchAck.dispatchIntentDigest,
      supervisorPid,
      processGroupId,
      processStartIdentity,
      startedAt,
    });
    await persistState25EventsV1(input, [event], 'supervisor start');
    const after = currentInvocationV1(input, openAcknowledgement, 'supervisor start');
    assertSupervisorStartedStateV1(after, event);
    const acknowledgement = Object.freeze({
      acknowledged: true,
      stage: 'execution_supervisor_started',
      dispatchId: dispatchAck.dispatchId,
      dispatchIntentDigest: dispatchAck.dispatchIntentDigest,
      supervisorPid,
      processGroupId,
      processStartIdentity,
    });
    stageBindings.set(acknowledgement, {
      stage: 'execution_supervisor_started',
      acknowledgement,
      prepared: candidate,
      dispatchIntent: dispatchAck,
    });
    return acknowledgement;
  };

  const persistDisposalIntent = async ({
    preparationIntent: intentAck,
    preparationReady: readyAck,
    prepared: candidate,
  }: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1> | null;
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
  }): Promise<Readonly<SandboxDisposalIntentAcknowledgementV1>> => {
    if (!preparationIntent || intentAck !== preparationIntent) {
      failV1('acknowledgement_mismatch', 'Disposal did not receive the exact intent ack.');
    }
    if (disposalIntent) failV1('invalid_stage', 'Disposal intent already exists.');
    const before = currentInvocationV1(input, openAcknowledgement, 'disposal intent');
    if (candidate === null) {
      if (readyAck !== null || preparationReady || before.sandboxPreparationReady) {
        failV1('invalid_stage', 'A ready preparation requires exact-plan disposal.');
      }
      const stateIntent = before.sandboxPreparationIntent;
      if (!stateIntent || stateIntent.intentDigest !== intentAck.intentDigest) {
        failV1('state_mismatch', 'State25 preparation intent is not current.');
      }
      if (before.sandboxPreparationAbandonment) {
        failV1('state_mismatch', 'State25 already contains a preparation abandonment record.');
      }
      const lifecycleIntentDigest = sandboxAbandonmentLifecycleIntentDigestV1({
        invocationId: openAcknowledgement.attempt.invocationId,
        attempt: openAcknowledgement.attempt.attempt,
        intentDigest: intentAck.intentDigest,
        preparationDigest: stateIntent.preparationDigest,
      });
      const startedAt = timestampV1(input.now());
      const event: State25RuntimeEventV1 = Object.freeze({
        type: 'capability.sandbox_preparation_abandonment_started',
        invocationId: openAcknowledgement.attempt.invocationId,
        attempt: openAcknowledgement.attempt.attempt,
        intentDigest: intentAck.intentDigest,
        lifecycleIntentDigest,
        startedAt,
      });
      await persistState25EventsV1(input, [event], 'preparation abandonment');
      const after = currentInvocationV1(input, openAcknowledgement, 'preparation abandonment');
      if (
        after.sandboxPreparationAbandonment?.status !== 'pending' ||
        after.sandboxPreparationAbandonment.lifecycleIntentDigest !== lifecycleIntentDigest
      ) {
        failV1('state_mismatch', 'State25 did not reflect preparation abandonment.');
      }
      const acknowledgement = Object.freeze({
        acknowledged: true,
        stage: 'disposal_intent',
        purpose: 'reconcile_preparation_intent' as const,
        lifecycleIntentDigest,
        cleanupAttempt: after.sandboxPreparationAbandonment.attempts + 1,
      });
      disposalIntent = acknowledgement;
      stageBindings.set(acknowledgement, {
        stage: 'disposal_intent',
        acknowledgement,
        prepared: null,
        preparationIntent: intentAck,
        preparationReady: null,
        disposalIntent: acknowledgement,
      });
      return acknowledgement;
    }
    if (!readyAck || !preparationReady || readyAck !== preparationReady) {
      failV1('acknowledgement_mismatch', 'Disposal ready acknowledgement is not exact.');
    }
    assertPreparedSandboxMatchesV1(
      candidate,
      requiredPreparedSandboxV1(preparedSandbox),
      openAcknowledgement,
    );
    if (before.sandboxPreparationReady?.readyDigest !== readyAck.readyDigest) {
      failV1('state_mismatch', 'State25 preparation ready is not current.');
    }
    if (before.sandboxDisposal) {
      failV1('state_mismatch', 'State25 already contains a sandbox disposal record.');
    }
    const lifecycleIntentDigest = sandboxDisposalLifecycleIntentDigestV1({
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      planDigest: sandboxPreparedPlanDigestV1(candidate),
      cleanupDigest: digestCapabilityValueV1(candidate.cleanup),
    });
    const startedAt = timestampV1(input.now());
    const event: State25RuntimeEventV1 = Object.freeze({
      type: 'capability.sandbox_disposal_started',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      lifecycleIntentDigest,
      startedAt,
    });
    await persistState25EventsV1(input, [event], 'disposal intent');
    const after = currentInvocationV1(input, openAcknowledgement, 'disposal intent');
    if (
      after.sandboxDisposal?.status !== 'pending' ||
      after.sandboxDisposal.lifecycleIntentDigest !== lifecycleIntentDigest
    ) {
      failV1('state_mismatch', 'State25 did not reflect disposal intent.');
    }
    const acknowledgement = Object.freeze({
      acknowledged: true,
      stage: 'disposal_intent',
      purpose: 'dispose' as const,
      lifecycleIntentDigest,
      cleanupAttempt: after.sandboxDisposal.attempts + 1,
    });
    disposalIntent = acknowledgement;
    stageBindings.set(acknowledgement, {
      stage: 'disposal_intent',
      acknowledgement,
      prepared: candidate,
      preparationIntent: intentAck,
      preparationReady: readyAck,
      disposalIntent: acknowledgement,
    });
    return acknowledgement;
  };

  const persistDisposalReceipt = async ({
    disposalIntent: intentAck,
    prepared: candidate,
    disposed,
  }: {
    readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgementV1>> => {
    if (!disposalIntent || intentAck !== disposalIntent) {
      failV1('acknowledgement_mismatch', 'Disposal receipt did not receive the exact intent ack.');
    }
    const binding = stageBindings.get(intentAck);
    if (binding?.stage !== 'disposal_intent') {
      failV1('acknowledgement_mismatch', 'Disposal intent is not owned by this composition.');
    }
    if ((candidate === null) !== (intentAck.purpose === 'reconcile_preparation_intent')) {
      failV1('invalid_stage', 'Disposal receipt purpose does not match its prepared plan.');
    }
    if (candidate !== null)
      assertPreparedSandboxMatchesV1(
        candidate,
        requiredPreparedSandboxV1(preparedSandbox),
        openAcknowledgement,
      );
    const before = currentInvocationV1(input, openAcknowledgement, 'disposal receipt');
    const stateDisposal =
      intentAck.purpose === 'dispose'
        ? before.sandboxDisposal
        : before.sandboxPreparationAbandonment;
    if (
      stateDisposal?.status !== 'pending' ||
      stateDisposal.lifecycleIntentDigest !== intentAck.lifecycleIntentDigest
    ) {
      failV1('state_mismatch', 'State25 disposal intent is not pending.');
    }
    const disposedAt = timestampV1(input.now());
    const event: State25RuntimeEventV1 =
      intentAck.purpose === 'dispose'
        ? Object.freeze({
            type: 'capability.sandbox_disposal_completed',
            invocationId: openAcknowledgement.attempt.invocationId,
            attempt: openAcknowledgement.attempt.attempt,
            readyDigest: before.sandboxDisposal!.readyDigest,
            lifecycleIntentDigest: intentAck.lifecycleIntentDigest,
            cleanupAttempt: intentAck.cleanupAttempt,
            disposed,
            disposedAt,
          })
        : Object.freeze({
            type: 'capability.sandbox_preparation_abandonment_completed',
            invocationId: openAcknowledgement.attempt.invocationId,
            attempt: openAcknowledgement.attempt.attempt,
            intentDigest: binding.preparationIntent!.intentDigest,
            lifecycleIntentDigest: intentAck.lifecycleIntentDigest,
            cleanupAttempt: intentAck.cleanupAttempt,
            disposed,
            disposedAt,
          });
    await persistState25EventsV1(input, [event], 'disposal receipt');
    const after = currentInvocationV1(input, openAcknowledgement, 'disposal receipt');
    const afterState =
      intentAck.purpose === 'dispose' ? after.sandboxDisposal : after.sandboxPreparationAbandonment;
    if (
      !afterState ||
      afterState.status !== (disposed ? 'completed' : 'pending') ||
      afterState.attempts !== intentAck.cleanupAttempt
    ) {
      failV1('state_mismatch', 'State25 did not reflect disposal receipt.');
    }
    const acknowledgement = Object.freeze({
      acknowledged: true,
      stage: 'disposal_receipt',
      purpose: intentAck.purpose,
      lifecycleIntentDigest: intentAck.lifecycleIntentDigest,
      cleanupAttempt: intentAck.cleanupAttempt,
      disposed,
    });
    disposalIntent = undefined;
    stageBindings.set(acknowledgement, {
      stage: 'disposal_receipt',
      acknowledgement,
      prepared: candidate,
      disposalIntent: intentAck,
    });
    return acknowledgement;
  };

  return Object.freeze({
    persistPreparationIntent,
    persistPreparationReady,
    persistExecutionDispatchIntent,
    persistExecutionSupervisorStarted,
    persistDisposalIntent,
    persistDisposalReceipt,
  });
}

function createEvidencePortV1(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInputV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
  openAcknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  stageBindings: WeakMap<object, StageBinding>,
) {
  return Object.freeze({
    verify(
      evidence: RuntimeHostSandboxLifecycleEvidenceV1,
    ): RuntimeHostSandboxLifecycleEvidenceVerificationResultV1 {
      try {
        const binding = stageBindings.get(evidence.acknowledgement);
        if (!binding || binding.stage !== evidence.stage)
          return { valid: false, code: 'identity_mismatch' as const };
        assertOpenAcknowledgementV1(prepared, openAcknowledgement);
        assertCurrentInvocationIdentityV1(input, openAcknowledgement, 'evidence');
        switch (evidence.stage) {
          case 'preparation_intent':
            if (
              binding.preparation !== evidence.preparation ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertPreparationIntentStateV1(
              currentInvocationV1(input, openAcknowledgement, evidence.stage),
              {
                attempt: openAcknowledgement.attempt.attempt,
                toolCallId: evidence.preparation.toolCallId,
                capabilityId: evidence.preparation.capabilityId,
                capabilityRevision: evidence.preparation.capabilityRevision,
                canonicalWorkspace: evidence.preparation.canonicalWorkspace,
                effectiveEffectsDigest: evidence.preparation.effectiveEffectsDigest,
                admissionDigest: evidence.preparation.admissionDigest,
                preparationDigest: sandboxPreparationDigestV1(evidence.preparation),
                commandDigest: evidence.preparation.commandDigest,
                executionBoundaryDigest: evidence.preparation.executionBoundaryDigest,
                resourceSemantics: 'allocating',
              },
              evidence.acknowledgement.intentDigest,
              currentInvocationV1(input, openAcknowledgement, evidence.stage)
                .sandboxPreparationIntent!.recordedAt,
            );
            return { valid: true as const };
          case 'preparation_ready':
            if (
              binding.prepared !== evidence.prepared ||
              binding.preparationIntent !== evidence.preparationIntent ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertPreparationReadyStateV1(
              currentInvocationV1(input, openAcknowledgement, evidence.stage),
              {
                attempt: openAcknowledgement.attempt.attempt,
                intentDigest: evidence.preparationIntent.intentDigest,
                preparationDigest: evidence.prepared.preparationDigest,
                commandDigest: evidence.prepared.commandDigest,
                planDigest: sandboxPreparedPlanDigestV1(evidence.prepared),
                backend: evidence.prepared.backend,
                backendCapabilitiesDigest: digestCapabilityValueV1(
                  evidence.prepared.backendCapabilities,
                ),
                enforcement: evidence.prepared.enforcement,
                resourceSemantics: evidence.prepared.resourceSemantics,
                cleanupDigest: digestCapabilityValueV1(evidence.prepared.cleanup),
                preparationArtifact: evidence.acknowledgement.preparationArtifact,
              },
              evidence.acknowledgement.readyDigest,
              currentInvocationV1(input, openAcknowledgement, evidence.stage)
                .sandboxPreparationReady!.readyAt,
            );
            return { valid: true as const };
          case 'execution_dispatch_intent':
            if (
              binding.prepared !== evidence.prepared ||
              binding.preparationReady !== evidence.preparationReady ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertDispatchIntentStateV1(
              currentInvocationV1(input, openAcknowledgement, evidence.stage),
              {
                dispatchId: evidence.acknowledgement.dispatchId,
                supervisorNonce: evidence.acknowledgement.supervisorNonce,
                dispatchIntentDigest: evidence.acknowledgement.dispatchIntentDigest,
                readyDigest: evidence.preparationReady.readyDigest,
                planDigest: sandboxPreparedPlanDigestV1(evidence.prepared),
                attempt: openAcknowledgement.attempt.attempt,
              },
            );
            return { valid: true as const };
          case 'execution_supervisor_started':
            if (
              binding.prepared !== evidence.prepared ||
              binding.dispatchIntent !== evidence.dispatchIntent ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertSupervisorStartedStateV1(
              currentInvocationV1(input, openAcknowledgement, evidence.stage),
              {
                dispatchId: evidence.acknowledgement.dispatchId,
                dispatchIntentDigest: evidence.acknowledgement.dispatchIntentDigest,
                supervisorPid: evidence.acknowledgement.supervisorPid,
                processGroupId: evidence.acknowledgement.processGroupId,
                processStartIdentity: evidence.acknowledgement.processStartIdentity,
                attempt: openAcknowledgement.attempt.attempt,
              },
            );
            return { valid: true as const };
          case 'disposal_intent':
            if (
              binding.prepared !== evidence.prepared ||
              binding.preparationIntent !== evidence.preparationIntent ||
              binding.preparationReady !== evidence.preparationReady ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertDisposalIntentStateV1(input, openAcknowledgement, evidence.acknowledgement);
            return { valid: true as const };
          case 'disposal_receipt':
            if (
              binding.prepared !== evidence.prepared ||
              binding.disposalIntent !== evidence.disposalIntent ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertDisposalReceiptStateV1(input, openAcknowledgement, evidence);
            return { valid: true as const };
        }
      } catch {
        return { valid: false, code: 'stale_stage' as const };
      }
    },
  });
}

function createExactArtifactPortV1(
  store: Pick<SandboxPreparationArtifactStoreV1, 'write' | 'read'>,
  prepared: Readonly<PreparedToolInvocationV1>,
): SandboxPreparationArtifactPortV1 {
  const exactByArtifact = new Map<
    string,
    {
      readonly reference: ReturnType<SandboxPreparationArtifactPortV1['write']>;
      readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    }
  >();
  return Object.freeze({
    write(candidate: Readonly<PreparedSandboxExecutionV1>) {
      assertPreparedToolPacketV1(candidate, prepared);
      const rawReference = store.write(candidate);
      const reference = Object.freeze({ ...rawReference });
      if (!Object.isFrozen(reference)) {
        failV1(
          'artifact_identity_mismatch',
          'Sandbox preparation Artifact reference is not frozen.',
        );
      }
      const roundTrip = store.read(reference);
      assertArtifactRoundTripV1(roundTrip, candidate);
      const existing = exactByArtifact.get(reference.artifactId);
      if (existing && (existing.prepared !== candidate || existing.reference !== reference)) {
        failV1('artifact_identity_mismatch', 'Sandbox preparation Artifact identity was reused.');
      }
      exactByArtifact.set(reference.artifactId, { reference, prepared: candidate });
      return reference;
    },
    read(reference: Readonly<ReturnType<SandboxPreparationArtifactPortV1['write']>>) {
      const existing = exactByArtifact.get(reference.artifactId);
      if (
        !existing ||
        existing.reference !== reference ||
        existing.reference.integrityIdentifier !== reference.integrityIdentifier ||
        existing.reference.byteLength !== reference.byteLength
      ) {
        failV1('artifact_identity_mismatch', 'Sandbox preparation Artifact reference is unknown.');
      }
      const roundTrip = store.read(reference);
      assertArtifactRoundTripV1(roundTrip, existing.prepared);
      return existing.prepared;
    },
  });
}

function assertArtifactRoundTripV1(
  roundTrip: Readonly<PreparedSandboxExecutionV1>,
  expected: Readonly<PreparedSandboxExecutionV1>,
): void {
  if (
    sandboxPreparedPlanDigestV1(roundTrip) !== sandboxPreparedPlanDigestV1(expected) ||
    roundTrip.invocationId !== expected.invocationId ||
    roundTrip.attempt !== expected.attempt ||
    roundTrip.planId !== expected.planId
  ) {
    failV1(
      'artifact_identity_mismatch',
      'Sandbox preparation Artifact round-trip changed the plan.',
    );
  }
}

function assertCompositionInputV1(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInputV1>,
): void {
  if (
    !input ||
    typeof input !== 'object' ||
    !Object.isFrozen(input.prepared) ||
    typeof input.resolveOpenAcknowledgement !== 'function' ||
    typeof input.getState !== 'function' ||
    typeof input.persistEvents !== 'function' ||
    typeof input.now !== 'function' ||
    !input.artifacts ||
    typeof input.artifacts.write !== 'function' ||
    typeof input.artifacts.read !== 'function'
  ) {
    failV1('invalid_composition', 'App sandbox lifecycle composition inputs are invalid.');
  }
}

function assertOpenAcknowledgementV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1> | null | undefined,
): asserts acknowledgement is Readonly<ToolPipelineAttemptAcknowledgementV1> {
  if (
    !acknowledgement ||
    !Object.isFrozen(acknowledgement) ||
    !Object.isFrozen(acknowledgement.attempt) ||
    acknowledgement.acknowledged !== true ||
    !samePreparedAttemptIdentityV1(prepared, acknowledgement)
  ) {
    failV1('attempt_not_acknowledged', 'The exact prepared attempt is not openly acknowledged.');
  }
}

function samePreparedAttemptIdentityV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): boolean {
  const identity = prepared.identity;
  const attempt = acknowledgement.attempt;
  const expected: Record<string, unknown> = {
    ...identity,
    attempt: attempt.attempt,
    runtimeWrapperProviderId: identity.isDynamicMcp ? identity.runtimeWrapper.providerId : null,
    runtimeWrapperCapabilityRevision: identity.isDynamicMcp
      ? identity.runtimeWrapper.capabilityRevision
      : null,
    runtimeWrapperExecutorRevision: identity.isDynamicMcp
      ? identity.runtimeWrapper.executorRevision
      : null,
    runtimeWrapperSchemaDigest: identity.isDynamicMcp ? identity.runtimeWrapper.schemaDigest : null,
    runtimeWrapperBuiltinProjectionRevision: identity.isDynamicMcp
      ? identity.runtimeWrapper.builtinProjectionRevision
      : null,
  };
  for (const key of [
    'invocationId',
    'attemptId',
    'attempt',
    'toolCallId',
    'turnId',
    'modelMessageId',
    'argumentOrigin',
    'providerId',
    'operationId',
    'capabilityId',
    'capabilityRevision',
    'descriptorRevision',
    'parserRevision',
    'executorRevision',
    'argumentsDigest',
    'schemaDigest',
    'effectiveEffectsDigest',
    'builtinProjectionRevision',
    'dynamicCatalogRevision',
    'runtimeWrapperProviderId',
    'runtimeWrapperCapabilityRevision',
    'runtimeWrapperExecutorRevision',
    'runtimeWrapperSchemaDigest',
    'runtimeWrapperBuiltinProjectionRevision',
    'policyDigest',
    'authorizationDigest',
    'admissionDigest',
    'idempotencyKey',
  ]) {
    if (attempt[key as keyof typeof attempt] !== expected[key]) return false;
  }
  return (
    attempt.attemptId === `${attempt.invocationId}:attempt:${attempt.attempt}` &&
    typeof attempt.recordedAt === 'string' &&
    typeof attempt.startedAt === 'string'
  );
}

function assertPreparationMatchesPreparedV1(
  preparation: Readonly<SandboxPreparationV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): void {
  if (
    preparation.invocationId !== prepared.identity.invocationId ||
    preparation.attempt !== acknowledgement.attempt.attempt ||
    preparation.toolCallId !== prepared.identity.toolCallId ||
    preparation.capabilityId !== prepared.identity.capabilityId ||
    preparation.capabilityRevision !== prepared.identity.capabilityRevision ||
    preparation.effectiveEffectsDigest !== prepared.identity.effectiveEffectsDigest ||
    preparation.admissionDigest !== prepared.identity.admissionDigest
  ) {
    failV1(
      'prepared_identity_mismatch',
      'Sandbox preparation does not match the prepared attempt.',
    );
  }
}

function assertPreparedSandboxMatchesV1(
  candidate: Readonly<PreparedSandboxExecutionV1>,
  prepared: Readonly<PreparedSandboxExecutionV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): void {
  if (
    candidate !== prepared ||
    candidate.invocationId !== acknowledgement.attempt.invocationId ||
    candidate.attempt !== acknowledgement.attempt.attempt ||
    candidate.toolCallId !== acknowledgement.attempt.toolCallId ||
    candidate.capabilityId !== acknowledgement.attempt.capabilityId ||
    candidate.capabilityRevision !== acknowledgement.attempt.capabilityRevision ||
    candidate.effectiveEffectsDigest !== acknowledgement.attempt.effectiveEffectsDigest ||
    candidate.admissionDigest !== acknowledgement.attempt.admissionDigest
  ) {
    failV1(
      'prepared_identity_mismatch',
      'Prepared sandbox execution is not the exact acknowledged plan.',
    );
  }
}

function assertPreparedSandboxAttemptMatchesV1(
  candidate: Readonly<PreparedSandboxExecutionV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): void {
  if (
    candidate.invocationId !== acknowledgement.attempt.invocationId ||
    candidate.attempt !== acknowledgement.attempt.attempt ||
    candidate.toolCallId !== acknowledgement.attempt.toolCallId ||
    candidate.capabilityId !== acknowledgement.attempt.capabilityId ||
    candidate.capabilityRevision !== acknowledgement.attempt.capabilityRevision ||
    candidate.effectiveEffectsDigest !== acknowledgement.attempt.effectiveEffectsDigest ||
    candidate.admissionDigest !== acknowledgement.attempt.admissionDigest
  ) {
    failV1(
      'prepared_identity_mismatch',
      'Prepared sandbox execution does not match the open attempt.',
    );
  }
}

function requiredPreparedSandboxV1(
  prepared: Readonly<PreparedSandboxExecutionV1> | undefined,
): Readonly<PreparedSandboxExecutionV1> {
  if (!prepared) failV1('invalid_stage', 'Prepared sandbox execution is not acknowledged yet.');
  return prepared;
}

function assertPreparedToolPacketV1(
  candidate: Readonly<PreparedSandboxExecutionV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): void {
  if (
    candidate.invocationId !== prepared.identity.invocationId ||
    candidate.attempt !== parseAttemptV1(prepared.identity.attemptId)
  ) {
    failV1(
      'prepared_identity_mismatch',
      'Prepared sandbox Artifact belongs to another Tool packet.',
    );
  }
}

function parseAttemptV1(attemptId: string): number {
  const match = /:attempt:(\d+)$/u.exec(attemptId);
  if (!match) failV1('prepared_identity_mismatch', 'Prepared attempt id is invalid.');
  return Number(match[1]);
}

function currentInvocationV1(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistenceV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  stage: string,
): InvocationState {
  const invocation =
    input.getState().capabilities.invocations[acknowledgement.attempt.invocationId];
  if (!invocation) failV1('attempt_not_acknowledged', `State25 has no open attempt for ${stage}.`);
  if (
    invocation.status !== 'running' ||
    invocation.toolCallId !== acknowledgement.attempt.toolCallId ||
    invocation.capabilityId !== acknowledgement.attempt.capabilityId ||
    invocation.capabilityRevision !== acknowledgement.attempt.capabilityRevision ||
    invocation.argumentsDigest !== acknowledgement.attempt.argumentsDigest ||
    invocation.authorizationDigest !== acknowledgement.attempt.authorizationDigest ||
    invocation.admissionDigest !== (acknowledgement.attempt.admissionDigest ?? undefined) ||
    invocation.effectiveEffectsDigest !== acknowledgement.attempt.effectiveEffectsDigest ||
    invocation.attemptsStarted !== acknowledgement.attempt.attempt
  ) {
    failV1('attempt_not_acknowledged', `State25 open attempt identity is invalid for ${stage}.`);
  }
  return invocation;
}

function assertCurrentInvocationIdentityV1(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistenceV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  stage: string,
): void {
  currentInvocationV1(input, acknowledgement, stage);
}

async function persistState25EventsV1(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistenceV1>,
  events: State25RuntimeEventV1[],
  stage: string,
): Promise<void> {
  const before = input.getState().revision;
  let accepted: boolean;
  try {
    accepted = await input.persistEvents(events);
  } catch (error) {
    failV1(
      'persistence_failed',
      `${stage} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (accepted !== true) failV1('persistence_failed', `${stage} persistence was not accepted.`);
  if (input.getState().revision < before + events.length) {
    failV1('state_mismatch', `${stage} persistence did not advance State25.`);
  }
}

function assertPreparationIntentStateV1(
  invocation: InvocationState,
  body: Readonly<Record<string, unknown>>,
  intentDigest: string,
  recordedAt: string,
): void {
  const state = invocation.sandboxPreparationIntent;
  if (
    !state ||
    state.attempt !== body.attempt ||
    state.toolCallId !== body.toolCallId ||
    state.capabilityId !== body.capabilityId ||
    state.capabilityRevision !== body.capabilityRevision ||
    state.canonicalWorkspace !== body.canonicalWorkspace ||
    state.effectiveEffectsDigest !== body.effectiveEffectsDigest ||
    state.admissionDigest !== body.admissionDigest ||
    state.preparationDigest !== body.preparationDigest ||
    state.commandDigest !== body.commandDigest ||
    state.executionBoundaryDigest !== body.executionBoundaryDigest ||
    state.resourceSemantics !== 'allocating' ||
    state.intentDigest !== intentDigest ||
    state.recordedAt !== recordedAt
  ) {
    failV1('state_mismatch', 'State25 sandbox preparation intent does not match the event.');
  }
}

function assertPreparationReadyStateV1(
  invocation: InvocationState,
  body: Readonly<Record<string, unknown>>,
  readyDigest: string,
  readyAt: string,
): void {
  const state = invocation.sandboxPreparationReady;
  const artifact = body.preparationArtifact as { artifactId: string };
  if (
    !state ||
    state.attempt !== body.attempt ||
    state.intentDigest !== body.intentDigest ||
    state.preparationDigest !== body.preparationDigest ||
    state.commandDigest !== body.commandDigest ||
    state.planDigest !== body.planDigest ||
    state.backend !== body.backend ||
    state.backendCapabilitiesDigest !== body.backendCapabilitiesDigest ||
    state.enforcement !== body.enforcement ||
    state.resourceSemantics !== body.resourceSemantics ||
    state.cleanupDigest !== body.cleanupDigest ||
    state.preparationArtifact.artifactId !== artifact.artifactId ||
    state.readyDigest !== readyDigest ||
    state.readyAt !== readyAt
  ) {
    failV1('state_mismatch', 'State25 sandbox preparation ready does not match the event.');
  }
}

function assertDispatchIntentStateV1(
  invocation: InvocationState,
  event: {
    readonly attempt: number;
    readonly readyDigest: string;
    readonly planDigest: string;
    readonly dispatchId: string;
    readonly supervisorNonce: string;
    readonly dispatchIntentDigest: string;
  },
): void {
  const state = invocation.sandboxExecutionDispatch;
  if (
    state?.status !== 'intent_recorded' ||
    state.attempt !== event.attempt ||
    state.readyDigest !== event.readyDigest ||
    state.planDigest !== event.planDigest ||
    state.dispatchId !== event.dispatchId ||
    state.supervisorNonce !== event.supervisorNonce ||
    state.dispatchIntentDigest !== event.dispatchIntentDigest
  ) {
    failV1('state_mismatch', 'State25 sandbox dispatch intent does not match the event.');
  }
}

function assertSupervisorStartedStateV1(
  invocation: InvocationState,
  event: {
    readonly attempt: number;
    readonly dispatchId: string;
    readonly dispatchIntentDigest: string;
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  },
): void {
  const state = invocation.sandboxExecutionDispatch;
  if (
    state?.status !== 'supervisor_started' ||
    state.attempt !== event.attempt ||
    state.dispatchId !== event.dispatchId ||
    state.dispatchIntentDigest !== event.dispatchIntentDigest ||
    state.supervisorPid !== event.supervisorPid ||
    state.processGroupId !== event.processGroupId ||
    state.processStartIdentity !== event.processStartIdentity
  ) {
    failV1('state_mismatch', 'State25 supervisor start does not match the event.');
  }
}

function assertDisposalIntentStateV1(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistenceV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  intent: Readonly<SandboxDisposalIntentAcknowledgementV1>,
): void {
  const invocation = currentInvocationV1(input, acknowledgement, 'disposal evidence');
  const state =
    intent.purpose === 'dispose'
      ? invocation.sandboxDisposal
      : invocation.sandboxPreparationAbandonment;
  if (
    state?.status !== 'pending' ||
    state.lifecycleIntentDigest !== intent.lifecycleIntentDigest ||
    state.attempts + 1 !== intent.cleanupAttempt
  ) {
    failV1('state_mismatch', 'State25 disposal intent does not match the acknowledgement.');
  }
}

function assertDisposalReceiptStateV1(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistenceV1>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  evidence: Extract<RuntimeHostSandboxLifecycleEvidenceV1, { readonly stage: 'disposal_receipt' }>,
): void {
  const invocation = currentInvocationV1(input, acknowledgement, 'disposal receipt evidence');
  const state =
    evidence.acknowledgement.purpose === 'dispose'
      ? invocation.sandboxDisposal
      : invocation.sandboxPreparationAbandonment;
  if (
    !state ||
    state.status !== (evidence.acknowledgement.disposed ? 'completed' : 'pending') ||
    state.lifecycleIntentDigest !== evidence.disposalIntent.lifecycleIntentDigest ||
    state.attempts !== evidence.acknowledgement.cleanupAttempt
  ) {
    failV1('state_mismatch', 'State25 disposal receipt does not match the acknowledgement.');
  }
}

function timestampV1(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    failV1('invalid_composition', 'State25 sandbox lifecycle timestamp is invalid.');
  }
  return value;
}

function nonEmptyV1(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function failV1(code: AppToolPipelineSandboxLifecycleErrorCodeV1, message: string): never {
  throw new AppToolPipelineSandboxLifecycleErrorV1(code, message);
}
