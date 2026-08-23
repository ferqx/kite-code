import { digestCapabilityValue } from '@kite/builtin-runtime';
import {
  type SandboxPreparationArtifactStore,
  sandboxAbandonmentLifecycleIntentDigest,
  sandboxDisposalLifecycleIntentDigest,
  sandboxPreparationDigest,
  sandboxPreparationIntentDigest,
  sandboxPreparationReadyDigest,
  sandboxPreparedPlanDigest,
} from '@kite/builtin-runtime/sandbox';
import {
  createRuntimeHostSandboxPreparationLifecycle,
  type RuntimeHostSandboxLifecycleEvidence,
  type RuntimeHostSandboxLifecycleEvidenceVerificationResult,
  type StateRuntimeEvent,
  type StateRuntimeState,
} from '@kite/runtime-host';
import type {
  PreparedSandboxExecution,
  PreparedToolInvocation,
  SandboxDisposalIntentAcknowledgement,
  SandboxDisposalReceiptAcknowledgement,
  SandboxExecutionDispatchIntentAcknowledgement,
  SandboxExecutionSupervisorStartedAcknowledgement,
  SandboxPreparation,
  SandboxPreparationArtifactPort,
  SandboxPreparationIntentAcknowledgement,
  SandboxPreparationLifecycle,
  SandboxPreparationReadyAcknowledgement,
  ToolPipelineAttemptAcknowledgement,
} from '@kite/runtime-spi';

export const APP_TOOL_PIPELINE_SANDBOX_LIFECYCLE_SCHEMA_ =
  'kite.app.tool-pipeline-sandbox-lifecycle.v1' as const;

export interface AppToolPipelineSandboxLifecyclePersistence {
  readonly getState: () => Readonly<StateRuntimeState>;
  readonly persistEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly now: () => string;
}

export interface CreateAppToolPipelineSandboxLifecycleInput
  extends AppToolPipelineSandboxLifecyclePersistence {
  /** Exact packet emitted by the App prepared-attempt composition. */
  readonly prepared: Readonly<PreparedToolInvocation>;
  /** Returns the exact open State acknowledgement for this packet. */
  readonly resolveOpenAcknowledgement: (
    prepared: Readonly<PreparedToolInvocation>,
  ) => Readonly<ToolPipelineAttemptAcknowledgement> | null | undefined;
  /** Existing Builtin-owned durable Artifact store; App only wraps identity. */
  readonly artifacts: Pick<SandboxPreparationArtifactStore, 'write' | 'read'>;
}

export type AppToolPipelineSandboxLifecycleErrorCode =
  | 'invalid_composition'
  | 'attempt_not_acknowledged'
  | 'prepared_identity_mismatch'
  | 'acknowledgement_mismatch'
  | 'invalid_stage'
  | 'persistence_failed'
  | 'state_mismatch'
  | 'artifact_identity_mismatch';

export class AppToolPipelineSandboxLifecycleError extends Error {
  readonly code: AppToolPipelineSandboxLifecycleErrorCode;

  constructor(code: AppToolPipelineSandboxLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'AppToolPipelineSandboxLifecycleError';
    this.code = code;
  }
}

type StageAck =
  | SandboxPreparationIntentAcknowledgement
  | SandboxPreparationReadyAcknowledgement
  | SandboxExecutionDispatchIntentAcknowledgement
  | SandboxExecutionSupervisorStartedAcknowledgement
  | SandboxDisposalIntentAcknowledgement
  | SandboxDisposalReceiptAcknowledgement;

type InvocationState = Readonly<StateRuntimeState['capabilities']['invocations'][string]>;

interface StageBinding {
  readonly stage: StageAck['stage'];
  readonly acknowledgement: Readonly<StageAck>;
  readonly prepared: Readonly<PreparedSandboxExecution> | null;
  readonly preparation?: Readonly<SandboxPreparation>;
  readonly preparationIntent?: Readonly<SandboxPreparationIntentAcknowledgement>;
  readonly preparationReady?: Readonly<SandboxPreparationReadyAcknowledgement> | null;
  readonly dispatchIntent?: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
  readonly disposalIntent?: Readonly<SandboxDisposalIntentAcknowledgement>;
}

/**
 * Compose the App State sandbox persistence owner with the generic Host
 * lifecycle.  State event encoding and acknowledgement evidence stay here;
 * Host owns stage ordering and the process-facing exact-object authority.
 */
export function createAppToolPipelineSandboxLifecycle(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInput>,
): SandboxPreparationLifecycle {
  assertCompositionInput(input);
  const prepared = input.prepared;
  const openAcknowledgement = input.resolveOpenAcknowledgement(prepared);
  assertOpenAcknowledgement(prepared, openAcknowledgement);

  const stageBindings = new WeakMap<object, StageBinding>();
  const artifactPort = createExactArtifactPort(input.artifacts, prepared);
  const persistence = createHostPersistence(input, prepared, openAcknowledgement, stageBindings);
  const evidence = createEvidencePort(input, prepared, openAcknowledgement, stageBindings);
  const lifecycle = createRuntimeHostSandboxPreparationLifecycle({
    persistence,
    evidence,
    artifacts: artifactPort,
  });
  return Object.freeze(lifecycle);
}

function createHostPersistence(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInput>,
  prepared: Readonly<PreparedToolInvocation>,
  openAcknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  stageBindings: WeakMap<object, StageBinding>,
) {
  let preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement> | undefined;
  let preparationReady: Readonly<SandboxPreparationReadyAcknowledgement> | undefined;
  let preparedSandbox: Readonly<PreparedSandboxExecution> | undefined;
  let dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgement> | undefined;
  let disposalIntent: Readonly<SandboxDisposalIntentAcknowledgement> | undefined;

  const persistPreparationIntent = async ({
    preparation,
  }: {
    readonly preparation: Readonly<SandboxPreparation>;
  }): Promise<Readonly<SandboxPreparationIntentAcknowledgement>> => {
    if (preparationIntent) fail('invalid_stage', 'Preparation intent already exists.');
    assertPreparationMatchesPrepared(preparation, prepared, openAcknowledgement);
    const before = currentInvocation(input, openAcknowledgement, 'preparation intent');
    if (before.sandboxPreparationIntent) {
      fail('state_mismatch', 'State already contains a sandbox preparation intent.');
    }
    const recordedAt = timestamp(input.now());
    const body = {
      attempt: openAcknowledgement.attempt.attempt,
      toolCallId: preparation.toolCallId,
      capabilityId: preparation.capabilityId,
      capabilityRevision: preparation.capabilityRevision,
      canonicalWorkspace: preparation.canonicalWorkspace,
      effectiveEffectsDigest: preparation.effectiveEffectsDigest,
      admissionDigest: preparation.admissionDigest,
      preparationDigest: sandboxPreparationDigest(preparation),
      commandDigest: preparation.commandDigest,
      executionBoundaryDigest: preparation.executionBoundaryDigest,
      resourceSemantics: 'allocating' as const,
    };
    const intentDigest = sandboxPreparationIntentDigest(body);
    const event: StateRuntimeEvent = Object.freeze({
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: openAcknowledgement.attempt.invocationId,
      ...body,
      intentDigest,
      recordedAt,
    });
    await persistStateEvents(input, [event], 'preparation intent');
    const after = currentInvocation(input, openAcknowledgement, 'preparation intent');
    assertPreparationIntentState(after, body, intentDigest, recordedAt);
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
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly preparationArtifact: ReturnType<SandboxPreparationArtifactPort['write']>;
  }): Promise<Readonly<SandboxPreparationReadyAcknowledgement>> => {
    if (!preparationIntent || intentAck !== preparationIntent) {
      fail('acknowledgement_mismatch', 'Preparation ready did not receive the exact intent ack.');
    }
    if (preparationReady) fail('invalid_stage', 'Preparation ready already exists.');
    assertPreparedSandboxAttemptMatches(candidate, openAcknowledgement);
    const before = currentInvocation(input, openAcknowledgement, 'preparation ready');
    if (
      !before.sandboxPreparationIntent ||
      before.sandboxPreparationIntent.intentDigest !== intentAck.intentDigest ||
      before.sandboxPreparationReady
    ) {
      fail('state_mismatch', 'State is not open for sandbox preparation ready.');
    }
    const body = {
      attempt: openAcknowledgement.attempt.attempt,
      intentDigest: intentAck.intentDigest,
      preparationDigest: candidate.preparationDigest,
      commandDigest: candidate.commandDigest,
      planDigest: sandboxPreparedPlanDigest(candidate),
      backend: candidate.backend,
      backendCapabilitiesDigest: digestCapabilityValue(candidate.backendCapabilities),
      enforcement: candidate.enforcement,
      resourceSemantics: candidate.resourceSemantics,
      cleanupDigest: digestCapabilityValue(candidate.cleanup),
      preparationArtifact,
    };
    const readyDigest = sandboxPreparationReadyDigest(body);
    const readyAt = timestamp(input.now());
    const event: StateRuntimeEvent = Object.freeze({
      type: 'capability.sandbox_preparation_ready',
      invocationId: openAcknowledgement.attempt.invocationId,
      ...body,
      readyDigest,
      readyAt,
    });
    await persistStateEvents(input, [event], 'preparation ready');
    const after = currentInvocation(input, openAcknowledgement, 'preparation ready');
    assertPreparationReadyState(after, body, readyDigest, readyAt);
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
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly dispatchId: string;
    readonly supervisorNonce: string;
  }): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgement>> => {
    if (!preparationReady || readyAck !== preparationReady) {
      fail('acknowledgement_mismatch', 'Dispatch did not receive the exact ready ack.');
    }
    if (dispatchIntent) fail('invalid_stage', 'Dispatch intent already exists.');
    assertPreparedSandboxMatches(
      candidate,
      requiredPreparedSandbox(preparedSandbox),
      openAcknowledgement,
    );
    if (!nonEmpty(dispatchId) || !nonEmpty(supervisorNonce)) {
      fail('invalid_stage', 'Dispatch identity must be non-empty.');
    }
    const before = currentInvocation(input, openAcknowledgement, 'dispatch intent');
    if (
      before.sandboxPreparationReady?.readyDigest !== readyAck.readyDigest ||
      before.sandboxExecutionDispatch
    ) {
      fail('state_mismatch', 'State is not open for sandbox dispatch intent.');
    }
    const recordedAt = timestamp(input.now());
    const planDigest = sandboxPreparedPlanDigest(candidate);
    const dispatchIntentDigest = digestCapabilityValue({
      kind: 'sandbox_execution_dispatch_intent_v1',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      planDigest,
      dispatchId,
      supervisorNonce,
    });
    const event: StateRuntimeEvent = Object.freeze({
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
    await persistStateEvents(input, [event], 'dispatch intent');
    const after = currentInvocation(input, openAcknowledgement, 'dispatch intent');
    assertDispatchIntentState(after, event);
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
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgement>> => {
    if (!dispatchIntent || dispatchAck !== dispatchIntent) {
      fail('acknowledgement_mismatch', 'Supervisor start did not receive the exact dispatch ack.');
    }
    assertPreparedSandboxMatches(
      candidate,
      requiredPreparedSandbox(preparedSandbox),
      openAcknowledgement,
    );
    if (
      !Number.isSafeInteger(supervisorPid) ||
      !Number.isSafeInteger(processGroupId) ||
      !nonEmpty(processStartIdentity)
    ) {
      fail('invalid_stage', 'Supervisor identity is invalid.');
    }
    const before = currentInvocation(input, openAcknowledgement, 'supervisor start');
    if (
      before.sandboxExecutionDispatch?.status !== 'intent_recorded' ||
      before.sandboxExecutionDispatch.dispatchId !== dispatchAck.dispatchId ||
      before.sandboxExecutionDispatch.dispatchIntentDigest !== dispatchAck.dispatchIntentDigest
    ) {
      fail('state_mismatch', 'State is not open for supervisor start.');
    }
    const startedAt = timestamp(input.now());
    const event: StateRuntimeEvent = Object.freeze({
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
    await persistStateEvents(input, [event], 'supervisor start');
    const after = currentInvocation(input, openAcknowledgement, 'supervisor start');
    assertSupervisorStartedState(after, event);
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
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement> | null;
    readonly prepared: Readonly<PreparedSandboxExecution> | null;
  }): Promise<Readonly<SandboxDisposalIntentAcknowledgement>> => {
    if (!preparationIntent || intentAck !== preparationIntent) {
      fail('acknowledgement_mismatch', 'Disposal did not receive the exact intent ack.');
    }
    if (disposalIntent) fail('invalid_stage', 'Disposal intent already exists.');
    const before = currentInvocation(input, openAcknowledgement, 'disposal intent');
    if (candidate === null) {
      if (readyAck !== null || preparationReady || before.sandboxPreparationReady) {
        fail('invalid_stage', 'A ready preparation requires exact-plan disposal.');
      }
      const stateIntent = before.sandboxPreparationIntent;
      if (!stateIntent || stateIntent.intentDigest !== intentAck.intentDigest) {
        fail('state_mismatch', 'State preparation intent is not current.');
      }
      if (before.sandboxPreparationAbandonment) {
        fail('state_mismatch', 'State already contains a preparation abandonment record.');
      }
      const lifecycleIntentDigest = sandboxAbandonmentLifecycleIntentDigest({
        invocationId: openAcknowledgement.attempt.invocationId,
        attempt: openAcknowledgement.attempt.attempt,
        intentDigest: intentAck.intentDigest,
        preparationDigest: stateIntent.preparationDigest,
      });
      const startedAt = timestamp(input.now());
      const event: StateRuntimeEvent = Object.freeze({
        type: 'capability.sandbox_preparation_abandonment_started',
        invocationId: openAcknowledgement.attempt.invocationId,
        attempt: openAcknowledgement.attempt.attempt,
        intentDigest: intentAck.intentDigest,
        lifecycleIntentDigest,
        startedAt,
      });
      await persistStateEvents(input, [event], 'preparation abandonment');
      const after = currentInvocation(input, openAcknowledgement, 'preparation abandonment');
      if (
        after.sandboxPreparationAbandonment?.status !== 'pending' ||
        after.sandboxPreparationAbandonment.lifecycleIntentDigest !== lifecycleIntentDigest
      ) {
        fail('state_mismatch', 'State did not reflect preparation abandonment.');
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
      fail('acknowledgement_mismatch', 'Disposal ready acknowledgement is not exact.');
    }
    assertPreparedSandboxMatches(
      candidate,
      requiredPreparedSandbox(preparedSandbox),
      openAcknowledgement,
    );
    if (before.sandboxPreparationReady?.readyDigest !== readyAck.readyDigest) {
      fail('state_mismatch', 'State preparation ready is not current.');
    }
    if (before.sandboxDisposal) {
      fail('state_mismatch', 'State already contains a sandbox disposal record.');
    }
    const lifecycleIntentDigest = sandboxDisposalLifecycleIntentDigest({
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      planDigest: sandboxPreparedPlanDigest(candidate),
      cleanupDigest: digestCapabilityValue(candidate.cleanup),
    });
    const startedAt = timestamp(input.now());
    const event: StateRuntimeEvent = Object.freeze({
      type: 'capability.sandbox_disposal_started',
      invocationId: openAcknowledgement.attempt.invocationId,
      attempt: openAcknowledgement.attempt.attempt,
      readyDigest: readyAck.readyDigest,
      lifecycleIntentDigest,
      startedAt,
    });
    await persistStateEvents(input, [event], 'disposal intent');
    const after = currentInvocation(input, openAcknowledgement, 'disposal intent');
    if (
      after.sandboxDisposal?.status !== 'pending' ||
      after.sandboxDisposal.lifecycleIntentDigest !== lifecycleIntentDigest
    ) {
      fail('state_mismatch', 'State did not reflect disposal intent.');
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
    readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution> | null;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgement>> => {
    if (!disposalIntent || intentAck !== disposalIntent) {
      fail('acknowledgement_mismatch', 'Disposal receipt did not receive the exact intent ack.');
    }
    const binding = stageBindings.get(intentAck);
    if (binding?.stage !== 'disposal_intent') {
      fail('acknowledgement_mismatch', 'Disposal intent is not owned by this composition.');
    }
    if ((candidate === null) !== (intentAck.purpose === 'reconcile_preparation_intent')) {
      fail('invalid_stage', 'Disposal receipt purpose does not match its prepared plan.');
    }
    if (candidate !== null)
      assertPreparedSandboxMatches(
        candidate,
        requiredPreparedSandbox(preparedSandbox),
        openAcknowledgement,
      );
    const before = currentInvocation(input, openAcknowledgement, 'disposal receipt');
    const stateDisposal =
      intentAck.purpose === 'dispose'
        ? before.sandboxDisposal
        : before.sandboxPreparationAbandonment;
    if (
      stateDisposal?.status !== 'pending' ||
      stateDisposal.lifecycleIntentDigest !== intentAck.lifecycleIntentDigest
    ) {
      fail('state_mismatch', 'State disposal intent is not pending.');
    }
    const disposedAt = timestamp(input.now());
    const event: StateRuntimeEvent =
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
    await persistStateEvents(input, [event], 'disposal receipt');
    const after = currentInvocation(input, openAcknowledgement, 'disposal receipt');
    const afterState =
      intentAck.purpose === 'dispose' ? after.sandboxDisposal : after.sandboxPreparationAbandonment;
    if (
      !afterState ||
      afterState.status !== (disposed ? 'completed' : 'pending') ||
      afterState.attempts !== intentAck.cleanupAttempt
    ) {
      fail('state_mismatch', 'State did not reflect disposal receipt.');
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

function createEvidencePort(
  input: Readonly<CreateAppToolPipelineSandboxLifecycleInput>,
  prepared: Readonly<PreparedToolInvocation>,
  openAcknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  stageBindings: WeakMap<object, StageBinding>,
) {
  return Object.freeze({
    verify(
      evidence: RuntimeHostSandboxLifecycleEvidence,
    ): RuntimeHostSandboxLifecycleEvidenceVerificationResult {
      try {
        const binding = stageBindings.get(evidence.acknowledgement);
        if (!binding || binding.stage !== evidence.stage)
          return { valid: false, code: 'identity_mismatch' as const };
        assertOpenAcknowledgement(prepared, openAcknowledgement);
        assertCurrentInvocationIdentity(input, openAcknowledgement, 'evidence');
        switch (evidence.stage) {
          case 'preparation_intent':
            if (
              binding.preparation !== evidence.preparation ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertPreparationIntentState(
              currentInvocation(input, openAcknowledgement, evidence.stage),
              {
                attempt: openAcknowledgement.attempt.attempt,
                toolCallId: evidence.preparation.toolCallId,
                capabilityId: evidence.preparation.capabilityId,
                capabilityRevision: evidence.preparation.capabilityRevision,
                canonicalWorkspace: evidence.preparation.canonicalWorkspace,
                effectiveEffectsDigest: evidence.preparation.effectiveEffectsDigest,
                admissionDigest: evidence.preparation.admissionDigest,
                preparationDigest: sandboxPreparationDigest(evidence.preparation),
                commandDigest: evidence.preparation.commandDigest,
                executionBoundaryDigest: evidence.preparation.executionBoundaryDigest,
                resourceSemantics: 'allocating',
              },
              evidence.acknowledgement.intentDigest,
              currentInvocation(input, openAcknowledgement, evidence.stage)
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
            assertPreparationReadyState(
              currentInvocation(input, openAcknowledgement, evidence.stage),
              {
                attempt: openAcknowledgement.attempt.attempt,
                intentDigest: evidence.preparationIntent.intentDigest,
                preparationDigest: evidence.prepared.preparationDigest,
                commandDigest: evidence.prepared.commandDigest,
                planDigest: sandboxPreparedPlanDigest(evidence.prepared),
                backend: evidence.prepared.backend,
                backendCapabilitiesDigest: digestCapabilityValue(
                  evidence.prepared.backendCapabilities,
                ),
                enforcement: evidence.prepared.enforcement,
                resourceSemantics: evidence.prepared.resourceSemantics,
                cleanupDigest: digestCapabilityValue(evidence.prepared.cleanup),
                preparationArtifact: evidence.acknowledgement.preparationArtifact,
              },
              evidence.acknowledgement.readyDigest,
              currentInvocation(input, openAcknowledgement, evidence.stage).sandboxPreparationReady!
                .readyAt,
            );
            return { valid: true as const };
          case 'execution_dispatch_intent':
            if (
              binding.prepared !== evidence.prepared ||
              binding.preparationReady !== evidence.preparationReady ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertDispatchIntentState(
              currentInvocation(input, openAcknowledgement, evidence.stage),
              {
                dispatchId: evidence.acknowledgement.dispatchId,
                supervisorNonce: evidence.acknowledgement.supervisorNonce,
                dispatchIntentDigest: evidence.acknowledgement.dispatchIntentDigest,
                readyDigest: evidence.preparationReady.readyDigest,
                planDigest: sandboxPreparedPlanDigest(evidence.prepared),
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
            assertSupervisorStartedState(
              currentInvocation(input, openAcknowledgement, evidence.stage),
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
            assertDisposalIntentState(input, openAcknowledgement, evidence.acknowledgement);
            return { valid: true as const };
          case 'disposal_receipt':
            if (
              binding.prepared !== evidence.prepared ||
              binding.disposalIntent !== evidence.disposalIntent ||
              binding.acknowledgement !== evidence.acknowledgement
            )
              return { valid: false, code: 'identity_mismatch' as const };
            assertDisposalReceiptState(input, openAcknowledgement, evidence);
            return { valid: true as const };
        }
      } catch {
        return { valid: false, code: 'stale_stage' as const };
      }
    },
  });
}

function createExactArtifactPort(
  store: Pick<SandboxPreparationArtifactStore, 'write' | 'read'>,
  prepared: Readonly<PreparedToolInvocation>,
): SandboxPreparationArtifactPort {
  const exactByArtifact = new Map<
    string,
    {
      readonly reference: ReturnType<SandboxPreparationArtifactPort['write']>;
      readonly prepared: Readonly<PreparedSandboxExecution>;
    }
  >();
  return Object.freeze({
    write(candidate: Readonly<PreparedSandboxExecution>) {
      assertPreparedToolPacket(candidate, prepared);
      const rawReference = store.write(candidate);
      const reference = Object.freeze({ ...rawReference });
      if (!Object.isFrozen(reference)) {
        fail('artifact_identity_mismatch', 'Sandbox preparation Artifact reference is not frozen.');
      }
      const roundTrip = store.read(reference);
      assertArtifactRoundTrip(roundTrip, candidate);
      const existing = exactByArtifact.get(reference.artifactId);
      if (existing && (existing.prepared !== candidate || existing.reference !== reference)) {
        fail('artifact_identity_mismatch', 'Sandbox preparation Artifact identity was reused.');
      }
      exactByArtifact.set(reference.artifactId, { reference, prepared: candidate });
      return reference;
    },
    read(reference: Readonly<ReturnType<SandboxPreparationArtifactPort['write']>>) {
      const existing = exactByArtifact.get(reference.artifactId);
      if (
        !existing ||
        existing.reference !== reference ||
        existing.reference.integrityIdentifier !== reference.integrityIdentifier ||
        existing.reference.byteLength !== reference.byteLength
      ) {
        fail('artifact_identity_mismatch', 'Sandbox preparation Artifact reference is unknown.');
      }
      const roundTrip = store.read(reference);
      assertArtifactRoundTrip(roundTrip, existing.prepared);
      return existing.prepared;
    },
  });
}

function assertArtifactRoundTrip(
  roundTrip: Readonly<PreparedSandboxExecution>,
  expected: Readonly<PreparedSandboxExecution>,
): void {
  if (
    sandboxPreparedPlanDigest(roundTrip) !== sandboxPreparedPlanDigest(expected) ||
    roundTrip.invocationId !== expected.invocationId ||
    roundTrip.attempt !== expected.attempt ||
    roundTrip.planId !== expected.planId
  ) {
    fail('artifact_identity_mismatch', 'Sandbox preparation Artifact round-trip changed the plan.');
  }
}

function assertCompositionInput(input: Readonly<CreateAppToolPipelineSandboxLifecycleInput>): void {
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
    fail('invalid_composition', 'App sandbox lifecycle composition inputs are invalid.');
  }
}

function assertOpenAcknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement> | null | undefined,
): asserts acknowledgement is Readonly<ToolPipelineAttemptAcknowledgement> {
  if (
    !acknowledgement ||
    !Object.isFrozen(acknowledgement) ||
    !Object.isFrozen(acknowledgement.attempt) ||
    acknowledgement.acknowledged !== true ||
    !samePreparedAttemptIdentity(prepared, acknowledgement)
  ) {
    fail('attempt_not_acknowledged', 'The exact prepared attempt is not openly acknowledged.');
  }
}

function samePreparedAttemptIdentity(
  prepared: Readonly<PreparedToolInvocation>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
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

function assertPreparationMatchesPrepared(
  preparation: Readonly<SandboxPreparation>,
  prepared: Readonly<PreparedToolInvocation>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
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
    fail('prepared_identity_mismatch', 'Sandbox preparation does not match the prepared attempt.');
  }
}

function assertPreparedSandboxMatches(
  candidate: Readonly<PreparedSandboxExecution>,
  prepared: Readonly<PreparedSandboxExecution>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
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
    fail(
      'prepared_identity_mismatch',
      'Prepared sandbox execution is not the exact acknowledged plan.',
    );
  }
}

function assertPreparedSandboxAttemptMatches(
  candidate: Readonly<PreparedSandboxExecution>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
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
    fail(
      'prepared_identity_mismatch',
      'Prepared sandbox execution does not match the open attempt.',
    );
  }
}

function requiredPreparedSandbox(
  prepared: Readonly<PreparedSandboxExecution> | undefined,
): Readonly<PreparedSandboxExecution> {
  if (!prepared) fail('invalid_stage', 'Prepared sandbox execution is not acknowledged yet.');
  return prepared;
}

function assertPreparedToolPacket(
  candidate: Readonly<PreparedSandboxExecution>,
  prepared: Readonly<PreparedToolInvocation>,
): void {
  if (
    candidate.invocationId !== prepared.identity.invocationId ||
    candidate.attempt !== parseAttempt(prepared.identity.attemptId)
  ) {
    fail('prepared_identity_mismatch', 'Prepared sandbox Artifact belongs to another Tool packet.');
  }
}

function parseAttempt(attemptId: string): number {
  const match = /:attempt:(\d+)$/u.exec(attemptId);
  if (!match) fail('prepared_identity_mismatch', 'Prepared attempt id is invalid.');
  return Number(match[1]);
}

function currentInvocation(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistence>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  stage: string,
): InvocationState {
  const invocation =
    input.getState().capabilities.invocations[acknowledgement.attempt.invocationId];
  if (!invocation) fail('attempt_not_acknowledged', `State has no open attempt for ${stage}.`);
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
    fail('attempt_not_acknowledged', `State open attempt identity is invalid for ${stage}.`);
  }
  return invocation;
}

function assertCurrentInvocationIdentity(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistence>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  stage: string,
): void {
  currentInvocation(input, acknowledgement, stage);
}

async function persistStateEvents(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistence>,
  events: StateRuntimeEvent[],
  stage: string,
): Promise<void> {
  const before = input.getState().revision;
  let accepted: boolean;
  try {
    accepted = await input.persistEvents(events);
  } catch (error) {
    fail(
      'persistence_failed',
      `${stage} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (accepted !== true) fail('persistence_failed', `${stage} persistence was not accepted.`);
  if (input.getState().revision < before + events.length) {
    fail('state_mismatch', `${stage} persistence did not advance State.`);
  }
}

function assertPreparationIntentState(
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
    fail('state_mismatch', 'State sandbox preparation intent does not match the event.');
  }
}

function assertPreparationReadyState(
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
    fail('state_mismatch', 'State sandbox preparation ready does not match the event.');
  }
}

function assertDispatchIntentState(
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
    fail('state_mismatch', 'State sandbox dispatch intent does not match the event.');
  }
}

function assertSupervisorStartedState(
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
    fail('state_mismatch', 'State supervisor start does not match the event.');
  }
}

function assertDisposalIntentState(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistence>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  intent: Readonly<SandboxDisposalIntentAcknowledgement>,
): void {
  const invocation = currentInvocation(input, acknowledgement, 'disposal evidence');
  const state =
    intent.purpose === 'dispose'
      ? invocation.sandboxDisposal
      : invocation.sandboxPreparationAbandonment;
  if (
    state?.status !== 'pending' ||
    state.lifecycleIntentDigest !== intent.lifecycleIntentDigest ||
    state.attempts + 1 !== intent.cleanupAttempt
  ) {
    fail('state_mismatch', 'State disposal intent does not match the acknowledgement.');
  }
}

function assertDisposalReceiptState(
  input: Readonly<AppToolPipelineSandboxLifecyclePersistence>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  evidence: Extract<RuntimeHostSandboxLifecycleEvidence, { readonly stage: 'disposal_receipt' }>,
): void {
  const invocation = currentInvocation(input, acknowledgement, 'disposal receipt evidence');
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
    fail('state_mismatch', 'State disposal receipt does not match the acknowledgement.');
  }
}

function timestamp(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail('invalid_composition', 'State sandbox lifecycle timestamp is invalid.');
  }
  return value;
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function fail(code: AppToolPipelineSandboxLifecycleErrorCode, message: string): never {
  throw new AppToolPipelineSandboxLifecycleError(code, message);
}
