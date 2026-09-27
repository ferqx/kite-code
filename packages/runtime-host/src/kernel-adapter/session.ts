import { createHash } from 'node:crypto';
import {
  type AgentState,
  assertAgentStateInvariants,
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  childDelegatedUpperBoundDigest,
  childThreadIdForToolAttempt,
  type DecisionFacts,
  decide,
  digestAgentEvent,
  encodeCurrentAgentStateJson,
  finalizeAgentEvent,
  getActivePlanning,
  getEffectiveInteractionMode,
  hasLateTerminalEventForCancelledTool,
  isConcurrentAutoReviewEffectBatchCurrent,
  isConcurrentModelEffectBatchCurrent,
  isConcurrentShellEffectBatchCurrent,
  isConcurrentTaskControlEffectBatchCurrent,
  type KernelEvent,
  normalizeAgentEvent,
  normalizeCanonicalTaskCompletionFact,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeEffect,
  reduce,
  reduceAgentState,
  requiredBackgroundTaskIds,
  type SchedulerFacts,
  sameChildTaskArtifactRef,
  selectPendingEffects,
  suspendedCapabilityTerminalRequirements,
  taskIdentityAllocationKey,
  type VerificationSchemaAdmissionFact,
} from '@kite-ai/agent-kernel';
import {
  getAgentPhase,
  type RuntimeSessionRunProjection,
  type RuntimeSessionTaskProjection,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostExecutionServices,
  RuntimeLeaseRequirement,
  RuntimeTransactionAcknowledgement,
} from '../lifecycle/effect-supervisor';
import type {
  RuntimeAgentArtifactRef,
  RuntimeAgentMailboxMutation,
  RuntimeChildBudgetActivationMutation,
  RuntimeChildCreationFailureMutation,
  RuntimeChildDispatchAckMutation,
  RuntimeChildSessionIntentMutation,
  RuntimeChildTerminalCheckpointMutation,
  RuntimeChildTerminalImportMutation,
  RuntimeCommandCommitEvidence,
  RuntimeCrossSessionAgentMailMutation,
  RuntimeEventMetadata,
  RuntimeFollowupRunStartMutation,
  RuntimeRestoreBoundary,
  RuntimeRunStatus,
  RuntimeRunStorePort,
  RuntimeRunTransactionMutation,
  RuntimeSealedChildGrantPayload,
  RuntimeSessionModelRoute,
  RuntimeStoredCommandReceipt,
  RuntimeStoredCommandResourceResult,
  RuntimeStoredRun,
  RuntimeTransactionInput,
} from '../storage';
import {
  CHILD_SESSION_TASK_USER_GOAL,
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  sealChildGrantPayload,
} from '../storage';
import type {
  StateRuntimeEffectLease as BaseStateRuntimeEffectLease,
  StateRuntimeEffectPersistenceAcknowledgement,
} from './effect-runtime';
import { fundingBudgetForRun } from './resource-budget';

/** The one current State / Store format accepted by this Host session. */
export const STATE_RUNTIME_SESSION_FORMAT_ = Object.freeze({
  schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
  storeVersion: 5 as const,
  epoch: RUNTIME_STATE_FORMAT_EPOCH,
});

/** A separate Store effect lease for each sibling child acceptance. */
export function childSessionAcceptanceEffectId(childThreadId: string): string {
  if (!/^child_[a-f0-9]{64}$/u.test(childThreadId))
    throw new Error('Child Session identity is invalid.');
  return `child-session-accept:${childThreadId}`;
}

export function childTerminalReceiptDigest(input: {
  childThreadId: string;
  terminalRevision: number;
  terminalReceiptId: string;
  resultIntegrityIdentifier: string;
  unknownRecovery?: true;
}): `sha256:${string}` {
  if (
    !/^child_[a-f0-9]{64}$/u.test(input.childThreadId) ||
    !Number.isSafeInteger(input.terminalRevision) ||
    input.terminalRevision < 1 ||
    !input.terminalReceiptId ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.resultIntegrityIdentifier)
  )
    throw new Error('Child terminal receipt identity is invalid.');
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        input.unknownRecovery
          ? 'kite.child-terminal-unknown-receipt.v1'
          : 'kite.child-terminal-receipt.v1',
        input.childThreadId,
        input.terminalRevision,
        input.terminalReceiptId,
        input.resultIntegrityIdentifier,
      ]),
    )
    .digest('hex')}`;
}

function childTerminalCheckpointForState(
  state: AgentState,
  terminalRunId: string,
  followup?: Readonly<{ submissionId: string; taskId: string; targetRunId: string }>,
): RuntimeChildTerminalCheckpointMutation | undefined {
  const origin = state.childSessionOrigin;
  if (
    origin?.terminal?.status !== 'completed' ||
    state.terminalOutcome?.status !== 'completed' ||
    !terminalRunId ||
    state.session.threadId === origin.parentSessionId
  )
    throw new Error('Completed child checkpoint lacks an exact terminal Session.');
  if (followup && (followup.targetRunId !== terminalRunId || state.turn.turnId !== terminalRunId))
    throw new Error('Followup checkpoint does not match its exact terminal Run.');
  if (
    typeof state.transcript.final !== 'string' ||
    !state.transcript.messages.some((message) => {
      if (message.kind !== 'assistant' || !message.modelInvocationId) return false;
      const invocation = state.modelInvocations[message.modelInvocationId];
      return invocation?.status === 'completed' && invocation.responseArtifact !== undefined;
    })
  )
    return undefined;
  const stateJson = encodeCurrentAgentStateJson(state);
  const hash = (value: string) =>
    `sha256:${createHash('sha256').update(value).digest('hex')}` as const;
  const canonicalJson = JSON.stringify({
    artifactFormatVersion: 1,
    childSessionId: state.session.threadId,
    terminalRunId,
    terminalTaskId: followup?.taskId ?? origin.childInvocationId,
    ...(followup ? { submissionId: followup.submissionId } : {}),
    terminalRevision: state.revision,
    terminalStatus: origin.terminal.status,
    stateDigest: hash(stateJson),
    transcriptDigest: hash(JSON.stringify(state.transcript)),
    transcript: state.transcript,
  });
  const integrityIdentifier = hash(canonicalJson);
  if (Buffer.byteLength(canonicalJson, 'utf8') > 16 * 1024 * 1024) return undefined;
  return {
    ref: {
      artifactId: `pa_${integrityIdentifier.slice('sha256:'.length)}`,
      kind: 'subagent_checkpoint',
      integrityIdentifier,
      byteLength: Buffer.byteLength(canonicalJson, 'utf8'),
    },
    canonicalJson,
    terminalRunId,
    terminalTaskId: followup?.taskId ?? origin.childInvocationId,
    ...(followup ? { submissionId: followup.submissionId } : {}),
  };
}

export function assertPreDispatchChildFailureProof(
  mode: RuntimeChildCreationFailureMutation['mode'],
  childThreadId: string,
  readProof?: StateRuntimeChildCreationFailureInput['readPreDispatchChildProof'],
): void {
  if (mode === 'absent_child') return;
  const proof = readProof?.(childThreadId);
  if (
    !proof ||
    proof.childRevision !== (mode === 'activated_no_ack' ? 5 : 0) ||
    proof.ownerStatus !== 'idle' ||
    proof.cleanupConfirmed !== true
  )
    throw new Error('Created child Session is not safely abandoned before dispatch.');
}

export type StateRuntimeSessionClock = () => string;
export type StateRuntimeSessionIdSource = (kind: string) => string;

export type StateRuntimeSessionEffectLease = BaseStateRuntimeEffectLease;

export interface StateRuntimeSessionEventContext {
  readonly sessionId: string;
  readonly eventIndex: number;
  readonly state: Readonly<AgentState>;
}

export type StateRuntimeVerificationAdmission = (
  event: KernelEvent,
  context: StateRuntimeSessionEventContext,
) => readonly (VerificationSchemaAdmissionFact | null)[] | undefined;

export type StateRuntimeEventBatchPreprocessor = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => readonly KernelEvent[];

export type StateRuntimeEventBatchAdmissionValidator = (
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export type StateRuntimeToolTerminalBatchValidator = (
  effect: Extract<RuntimeEffect, { readonly type: 'run_tools' }>,
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
) => undefined | boolean;

export interface StateRuntimeNamedTurnSnapshotInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: Readonly<AgentState>;
  readonly eventPosition: number;
}

/**
 * The only Host seam for a concurrent effect that is allowed to survive an
 * unrelated State 27 revision.  The callback owns the domain-specific
 * predicate (for example, a shell sibling predicate); Host never inspects a
 * tool name or a model operation.
 */
export type StateRuntimeConcurrentEffectEventCurrent = (
  lease: Readonly<StateRuntimeSessionEffectLease>,
  event: KernelEvent,
  state: Readonly<AgentState>,
) => boolean;

/**
 * Optional pure projection paired with the concurrent-event predicate.  When
 * omitted, the Kernel reducer is used for the transient validation projection.
 * It is never persisted and never becomes a second reducer authority.
 */
export type StateRuntimeConcurrentEffectStateProjector = (
  state: Readonly<AgentState>,
  event: KernelEvent,
) => AgentState;

export interface StateRuntimeSessionInput {
  readonly state: AgentState;
  readonly services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly clock: StateRuntimeSessionClock;
  readonly id: StateRuntimeSessionIdSource;
  readonly sandboxAvailable?: boolean | (() => boolean);
  readonly verificationSchemaAdmissions?: StateRuntimeVerificationAdmission;
  readonly eventBatchPreprocessor?: StateRuntimeEventBatchPreprocessor;
  readonly eventBatchAdmissionValidator?: StateRuntimeEventBatchAdmissionValidator;
  readonly toolTerminalBatchValidator?: StateRuntimeToolTerminalBatchValidator;
  readonly onNamedTurnSnapshot?: (input: StateRuntimeNamedTurnSnapshotInput) => void;
  readonly isConcurrentEffectEventCurrent?: StateRuntimeConcurrentEffectEventCurrent;
  readonly projectConcurrentEffectState?: StateRuntimeConcurrentEffectStateProjector;
  /** Reject a late result which has become terminal for a cancelled owner. */
  readonly isLateEffectResult?: (
    lease: Readonly<StateRuntimeSessionEffectLease>,
    events: readonly KernelEvent[],
    state: Readonly<AgentState>,
  ) => boolean;
}

export interface StateRuntimeProcessEventResult {
  readonly status: 'applied' | 'duplicate';
  readonly eventId: string;
}

export interface StateRuntimeProcessEventBatchOptions {
  readonly acknowledgement?: RuntimeTransactionAcknowledgement;
  readonly requiredEffectLease?: RuntimeLeaseRequirement;
  readonly causationId?: string;
  readonly source?: 'command' | 'receipt' | 'host_fact';
  /** Single-event clock binding used by processEvent. */
  readonly occurredAt?: string;
}

export interface StateRuntimeCommandCommitResult {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly KernelEvent[];
}

export interface StateRuntimeBackgroundAgentSettlementInput {
  readonly resultEvent: Extract<KernelEvent, { type: 'subagent.background_result_persisted' }>;
  readonly resultRef: RuntimeAgentArtifactRef<'subagent_task'>;
  /** Bound Service Artifact readback; the complete report stays private. */
  readonly readResultArtifact: (
    ref: RuntimeAgentArtifactRef<'subagent_task'>,
    taskId: string,
  ) => Readonly<Record<string, unknown>>;
  /** The immutable child grant digest captured at initial dispatch. */
  readonly grantDigest: string;
  /** Store-scoped proof for this still-active exact task. */
  readonly activeTaskProof: Readonly<{ ownerGeneration: string; grantDigest: string }> | null;
  /** Metadata only, used to recognize an already-settled exact replay. */
  readonly agent: Readonly<{
    agentId: string;
    currentTaskId: string | null;
    status: 'active' | 'idle' | 'context_unavailable';
  }>;
  /** Private status-only reply committed with the same task settlement. */
  readonly reply?: Readonly<{ event: AgentMailAcceptedEvent; mutation: AcceptMailMutation }>;
}

export interface StateRuntimeChildCreationFailureInput {
  readonly mode: RuntimeChildCreationFailureMutation['mode'];
  readonly failureEvent: Extract<
    KernelEvent,
    { type: 'subagent.child_creation_failed' | 'subagent.child_pre_dispatch_cancelled' }
  >;
  readonly resultEvent: Extract<KernelEvent, { type: 'subagent.background_result_persisted' }>;
  readonly releaseEvent: Extract<KernelEvent, { type: 'resource_budget.released' }>;
  readonly readFailureArtifact: (
    ref: RuntimeAgentArtifactRef<'subagent_task'>,
    taskId: string,
  ) => Readonly<Record<string, unknown>>;
  /** Read-only preflight; Store repeats this check inside the parent receipt CAS. */
  readonly readPreDispatchChildProof?: (childThreadId: string) => Readonly<{
    childRevision: number;
    ownerStatus: 'idle' | 'active' | 'detached' | 'recovery_required';
    cleanupConfirmed: boolean;
  }> | null;
}

export interface StateRuntimeChildTerminalImportInput {
  readonly importEvent: Extract<KernelEvent, { type: 'subagent.child_terminal_imported' }>;
  readonly resultEvent: Extract<KernelEvent, { type: 'subagent.background_result_persisted' }>;
  readonly resourceEvent: Extract<
    KernelEvent,
    { type: 'resource_budget.reconciled' | 'resource_budget.unknown' }
  >;
  /** Strict Store read of the sealed child Session, not a caller-supplied status. */
  readonly readChildState: (childThreadId: string) => Readonly<AgentState>;
  readonly readResultArtifact: (
    ref: RuntimeAgentArtifactRef<'subagent_task'>,
    taskId: string,
  ) => Readonly<Record<string, unknown>>;
}

export interface StateRuntimeBackgroundAgentSettlementResult {
  readonly mode: 'joint' | 'agent_only' | 'replay';
  readonly events: readonly KernelEvent[];
}

type AgentMailAcceptedEvent = Extract<KernelEvent, { type: 'agent.mail_accepted' }>;
type AcceptMailMutation = Extract<RuntimeAgentMailboxMutation, { kind: 'accept_mail' }>;

function assertAgentMailboxAcceptance(
  events: readonly KernelEvent[],
  mutations: readonly RuntimeAgentMailboxMutation[],
): { event: AgentMailAcceptedEvent; mutation: AcceptMailMutation } {
  const accepted = events.filter(
    (event): event is AgentMailAcceptedEvent => event.type === 'agent.mail_accepted',
  );
  const mail = mutations.filter(
    (mutation): mutation is AcceptMailMutation => mutation.kind === 'accept_mail',
  );
  if (accepted.length !== 1 || mail.length !== 1)
    throw new Error('Agent mailbox transaction requires one exact accepted mail fact.');
  const event = accepted[0]!;
  const mutation = mail[0]!;
  const refMatches =
    event.bodyRef.artifactId === mutation.bodyRef.artifactId &&
    event.bodyRef.kind === mutation.bodyRef.kind &&
    event.bodyRef.integrityIdentifier === mutation.bodyRef.integrityIdentifier &&
    event.bodyRef.byteLength === mutation.bodyRef.byteLength;
  const eventAdmission = event.followupAdmissionRef;
  const mutationAdmission = mutation.followupAdmission;
  const admissionMatches =
    (eventAdmission === undefined && mutationAdmission === undefined) ||
    (eventAdmission !== undefined &&
      mutationAdmission !== undefined &&
      event.followupAdmissionDigest === mutationAdmission.digest &&
      eventAdmission.artifactId === mutationAdmission.ref.artifactId &&
      eventAdmission.kind === mutationAdmission.ref.kind &&
      eventAdmission.integrityIdentifier === mutationAdmission.ref.integrityIdentifier &&
      eventAdmission.byteLength === mutationAdmission.ref.byteLength);
  if (
    event.messageId !== mutation.messageId ||
    event.submissionId !== mutation.submissionId ||
    event.senderAgentId !== mutation.senderAgentId ||
    event.targetAgentId !== mutation.targetAgentId ||
    event.mode !== mutation.mode ||
    event.source.runId !== mutation.source.runId ||
    event.source.turnId !== mutation.source.turnId ||
    event.source.modelInvocationId !== mutation.source.modelInvocationId ||
    event.source.toolCallId !== mutation.source.toolCallId ||
    event.source.effectAttemptId !== mutation.source.effectAttemptId ||
    event.source.sourceTaskId !== mutation.source.sourceTaskId ||
    event.bodyDigest !== mutation.bodyDigest ||
    event.sequence !== mutation.sequence ||
    !refMatches ||
    !admissionMatches
  )
    throw new Error('Agent mailbox Event and private mutation identities differ.');
  return { event, mutation };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return value;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertAgentMailboxFunding(
  accepted: ReturnType<typeof assertAgentMailboxAcceptance>,
  events: readonly KernelEvent[],
  state: Readonly<AgentState>,
  nowMs: number,
): void {
  const { event, mutation } = accepted;
  const reservations = events.filter(
    (candidate): candidate is Extract<KernelEvent, { type: 'resource_budget.reserved' }> =>
      candidate.type === 'resource_budget.reserved',
  );
  if (event.mode !== 'trigger_turn') {
    if (
      reservations.length > 0 ||
      mutation.followupAdmission ||
      event.followupAdmissionRef ||
      event.followupAdmissionDigest
    )
      throw new Error('Queue-only and reply mail cannot reserve TriggerTurn funding.');
    return;
  }
  const admission = mutation.followupAdmission;
  if (!admission || !event.submissionId || reservations.length !== 1)
    throw new Error('TriggerTurn mail requires one exact backup reservation.');
  let payload: unknown;
  try {
    payload = JSON.parse(admission.canonicalJson) as unknown;
  } catch {
    throw new Error('TriggerTurn admission artifact is invalid.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('TriggerTurn admission artifact is invalid.');
  const fields = payload as Record<string, unknown>;
  const reservation = reservations[0]!.reservation;
  const fundingRunId = fields.fundingRunId;
  const backupReservationId = fields.backupReservationId;
  const deadlineAt = fields.deadlineAt;
  const authorization = fields.authorization;
  const authority =
    authorization && typeof authorization === 'object' && !Array.isArray(authorization)
      ? (authorization as Record<string, unknown>)
      : undefined;
  const currentInvocations = Object.values(state.capabilities.invocations).filter(
    (invocation) =>
      invocation.toolCallId === event.source.toolCallId && invocation.status === 'running',
  );
  const currentInvocation = currentInvocations[0];
  const firstAttemptTimeoutMs = authority?.firstAttemptTimeoutMs;
  const minimumWindow =
    typeof firstAttemptTimeoutMs === 'number'
      ? Math.max(60_000, firstAttemptTimeoutMs + 5_000)
      : Number.NaN;
  const ledger =
    typeof fundingRunId === 'string' &&
    state.resourceBudget.status === 'active' &&
    state.resourceBudget.runId === fundingRunId
      ? state.resourceBudget
      : typeof fundingRunId === 'string'
        ? state.retainedResourceBudgets[fundingRunId]
        : undefined;
  if (
    typeof fundingRunId !== 'string' ||
    !fundingRunId ||
    typeof backupReservationId !== 'string' ||
    !backupReservationId ||
    !Number.isSafeInteger(deadlineAt) ||
    !sameCanonicalValue(fields.source, event.source) ||
    fields.senderAgentId !== event.senderAgentId ||
    fields.targetAgentId !== event.targetAgentId ||
    fields.messageId !== event.messageId ||
    fields.submissionId !== event.submissionId ||
    currentInvocations.length !== 1 ||
    !currentInvocation?.admissionDigest ||
    authority?.boundedContext !== true ||
    authority.authorizationDigest !== currentInvocation.authorizationDigest ||
    authority.admissionDigest !== currentInvocation.admissionDigest ||
    authority.effectiveEffectsDigest !== currentInvocation.effectiveEffectsDigest ||
    authority.capabilityDigest !== state.capabilities.catalogRevision ||
    authority.workspaceDigest !== state.session.canonicalWorkspaceDigest ||
    authority.phaseCeiling !== getAgentPhase(getActivePlanning(state)) ||
    authority.interactionMode !== state.mode ||
    authority.interactionModeRevision !== state.interactionModeRevision ||
    authority.workspaceAccess !== state.workspaceAccess ||
    typeof authority.policyRevision !== 'string' ||
    authority.policyRevision.length === 0 ||
    !Number.isSafeInteger(authority.contextWindowTokens) ||
    (authority.contextWindowTokens as number) <= 0 ||
    !Number.isSafeInteger(authority.maxOutputTokens) ||
    (authority.maxOutputTokens as number) <= 0 ||
    (authority.contextWindowTokens as number) <= (authority.maxOutputTokens as number) ||
    !Number.isSafeInteger(firstAttemptTimeoutMs) ||
    (firstAttemptTimeoutMs as number) <= 0 ||
    !Number.isSafeInteger(minimumWindow) ||
    reservation.state !== 'reserved' ||
    reservation.resourceKind !== 'subagent' ||
    reservation.parentReservationId !== undefined ||
    reservation.runId !== fundingRunId ||
    reservation.runId !== mutation.source.runId ||
    reservation.reservationId !== backupReservationId ||
    !sameCanonicalValue(fields.executableUpperBound, reservation.executableUpperBound) ||
    !ledger ||
    Date.parse(ledger.deadlineAt) !== deadlineAt ||
    (deadlineAt as number) - nowMs < minimumWindow ||
    Object.values(ledger.reservations).some((item) => item.state === 'unknown')
  )
    throw new Error('TriggerTurn backup does not match its funding ledger and admission.');
}

function assertAgentMailboxFactMutations(
  events: readonly KernelEvent[],
  mutations: readonly RuntimeAgentMailboxMutation[],
): void {
  const pairedEvents = events.filter(
    (event) =>
      event.type === 'agent.created' ||
      event.type === 'agent.turn_started' ||
      event.type === 'agent.mail_accepted' ||
      event.type === 'agent.mail_input_prepared' ||
      event.type === 'agent.task_settled',
  );
  if (pairedEvents.length !== mutations.length)
    throw new Error('Agent mailbox facts and private mutations must pair one-to-one.');
  for (const mutation of mutations) {
    if (mutation.kind === 'accept_mail') {
      assertAgentMailboxAcceptance(events, [mutation]);
      continue;
    }
    const matches = events.filter((event) => {
      switch (mutation.kind) {
        case 'create_agent':
          return (
            event.type === 'agent.created' &&
            event.agentId === mutation.agentId &&
            event.parentAgentId === mutation.parentAgentId &&
            event.initialTaskId === mutation.initialTaskId
          );
        case 'prepare_input':
          return (
            event.type === 'agent.mail_input_prepared' &&
            event.targetAgentId === mutation.targetAgentId &&
            event.invocationId === mutation.modelInvocationId &&
            event.modelAdmissionId === mutation.modelAdmissionId &&
            event.fromSequence === mutation.fromSequence &&
            event.throughSequence === mutation.throughSequence &&
            event.messageIds.length === mutation.messageIds.length &&
            event.messageIds.every((id, index) => id === mutation.messageIds[index])
          );
        case 'turn_started':
          return (
            event.type === 'agent.turn_started' &&
            event.agentId === mutation.agentId &&
            event.taskId === mutation.taskId &&
            event.turnOrdinal === mutation.turnOrdinal &&
            event.submissionId === mutation.submissionId
          );
        case 'task_settled':
          return (
            event.type === 'agent.task_settled' &&
            event.agentId === mutation.agentId &&
            event.taskId === mutation.taskId &&
            ((event.checkpointRef === undefined && mutation.checkpointRef === undefined) ||
              (event.checkpointRef !== undefined &&
                mutation.checkpointRef !== undefined &&
                event.checkpointRef.artifactId === mutation.checkpointRef.artifactId &&
                event.checkpointRef.integrityIdentifier ===
                  mutation.checkpointRef.integrityIdentifier &&
                event.checkpointRef.byteLength === mutation.checkpointRef.byteLength))
          );
        default:
          return false;
      }
    });
    if (matches.length !== 1)
      throw new Error('Agent mailbox mutation lacks one exact canonical event.');
  }
}

export interface StateRuntimeSession {
  readonly sessionId: string;
  getState(): Readonly<AgentState>;
  waitForRevisionChange?(revision: number, signal?: AbortSignal): Promise<void>;
  /** True only when the injected storage owner has passed Store 8 preflight. */
  supportsRunStorage(): boolean;
  getLifecycleProjection(state?: Readonly<AgentState>): Readonly<{
    readonly activeTask?: RuntimeSessionTaskProjection;
    readonly currentRun?: RuntimeSessionRunProjection;
  }>;
  /** Row-only post-commit activation; Store 6/7 remain an explicit no-op. */
  activateRun(runId: string): void;
  processEvent(event: KernelEvent): StateRuntimeProcessEventResult;
  processEventBatch(
    events: readonly KernelEvent[],
    options?: StateRuntimeProcessEventBatchOptions,
  ): readonly KernelEvent[];
  /**
   * Commits an accepted command's exact State decision and applied receipt in
   * one Store transaction. This is intentionally separate from effect and
   * ordinary event paths.
   */
  commitCommandBatch(
    events: readonly KernelEvent[],
    evidence: RuntimeCommandCommitEvidence,
    sessionModelRoute?: RuntimeSessionModelRoute,
    agentMailboxMutations?: readonly RuntimeAgentMailboxMutation[],
  ): StateRuntimeCommandCommitResult;
  /** Commit non-command Agent tree/input/terminal metadata through the same State transaction. */
  commitAgentMailboxFacts(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): readonly KernelEvent[];
  commitBackgroundAgentSettlement(
    input: StateRuntimeBackgroundAgentSettlementInput,
  ): StateRuntimeBackgroundAgentSettlementResult;
  commitChildCreationFailure(input: StateRuntimeChildCreationFailureInput): readonly KernelEvent[];
  commitChildRecoveryRequired(
    event: Extract<KernelEvent, { type: 'subagent.child_recovery_required' }>,
  ): readonly KernelEvent[];
  commitChildSessionTerminalImport(
    input: StateRuntimeChildTerminalImportInput,
  ): readonly KernelEvent[];
  commitChildSessionTerminalSeal(
    event: Extract<KernelEvent, { type: 'subagent.child_terminal_sealed' }>,
  ): readonly KernelEvent[];
  commitChildFollowupRunStart(
    events: readonly KernelEvent[],
    mutation: RuntimeFollowupRunStartMutation,
  ): readonly KernelEvent[];
  commitChildFollowupTurnSettlement(
    event: Extract<KernelEvent, { type: 'agent.followup_turn_settled' }>,
  ): readonly KernelEvent[];
  commitChildCurrentTurnFollowupSettlement(
    event: Extract<KernelEvent, { type: 'agent.followup_turn_settled' }>,
  ): readonly KernelEvent[];
  commitCrossSessionFollowupRoute(
    events: readonly [
      Extract<KernelEvent, { type: 'agent.followup_routed' }>,
      Extract<KernelEvent, { type: 'agent.mail_input_prepared' }>,
    ],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
  ): readonly KernelEvent[];
  /** Commit the current-turn route inside its prepared Model effect lease. */
  commitCrossSessionFollowupRouteForModelEffect(
    lease: StateRuntimeSessionEffectLease,
    events: readonly [
      Extract<KernelEvent, { type: 'agent.followup_routed' }>,
      Extract<KernelEvent, { type: 'agent.mail_input_prepared' }>,
    ],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
  ): readonly KernelEvent[];
  commitCrossSessionFollowupFunding(
    events: readonly KernelEvent[],
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      {
        kind:
          | 'replace_followup_backup'
          | 'activate_followup_funding'
          | 'settle_followup_funding'
          | 'release_accepted_followup_backup'
          | 'release_current_turn_backup'
          | 'activate_independent_followup_turn'
          | 'settle_independent_followup_funding';
      }
    >,
  ): readonly KernelEvent[];
  commitCrossSessionFollowupUnknownAck(
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'settle_followup_funding_after_unknown_recovery' }
    >,
  ): void;
  commitChildBudgetActivation(
    events: readonly KernelEvent[],
    mutation: RuntimeChildBudgetActivationMutation,
    evidence: RuntimeCommandCommitEvidence,
  ): StateRuntimeCommandCommitResult;
  commitChildDispatchAck(childThreadId: string): readonly KernelEvent[];
  /** Exact Tool acceptance: Event, private mailbox row and receipt share one fenced transaction. */

  commitAgentMailboxCommand(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult;
  commitCrossSessionQueueMailCommand(
    lease: StateRuntimeSessionEffectLease,
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'accept_queue' }>,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult;
  commitCrossSessionFollowupCommand(
    lease: StateRuntimeSessionEffectLease,
    reservationEvent: Extract<KernelEvent, { type: 'resource_budget.reserved' }>,
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'accept_followup' }>,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult;
  commitCrossSessionInterruptCommand(
    lease: StateRuntimeSessionEffectLease,
    event: Extract<KernelEvent, { type: 'background_execution.stop_requested' }>,
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'request_interrupt' | 'request_queued_interrupt' }
    >,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult;
  commitCrossSessionInterruptTarget(
    event: Extract<
      KernelEvent,
      {
        type:
          | 'background_execution.stop_requested'
          | 'background_execution.stop_settled'
          | 'background_execution.stop_unknown';
      }
    >,
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'ack_interrupt' | 'settle_interrupt' }
    >,
  ): readonly KernelEvent[];
  commitCrossSessionQueuedInterruptSettlement(
    event: Extract<
      KernelEvent,
      { type: 'background_execution.stop_settled' | 'background_execution.stop_unknown' }
    >,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'settle_queued_interrupt' }>,
  ): readonly KernelEvent[];
  commitCrossSessionQueueMailReceive(
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_queue' }>,
  ): readonly KernelEvent[];
  commitCrossSessionFollowupReceive(
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_followup' }>,
  ): readonly KernelEvent[];
  commitCrossSessionQueueMailModelInput(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'prepare_queue_input' }>,
  ): readonly KernelEvent[];
  /** Terminal-derived reply has no command receipt, but shares the result transaction. */
  commitAgentMailboxDerived(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): readonly KernelEvent[];
  /**
   * Commits a command receipt against the exact current snapshot without
   * inventing a Kernel event or advancing State revision. This is reserved
   * for accepted lifecycle decisions such as create/resume/idle close.
   */
  commitCommandSnapshot(
    evidence: RuntimeCommandCommitEvidence,
    sessionModelRoute?: RuntimeSessionModelRoute,
  ): RuntimeStoredCommandReceipt;
  /**
   * Commit one same-command release as a single Store transaction. The event
   * contains the complete snapshot match and per-invocation receipts; callers
   * may not emulate this by looping approval.granted events.
   */
  commitApprovalBatch(
    event: Extract<KernelEvent, { readonly type: 'approval.batch_released' }>,
    expectedRevision: number,
  ): StateRuntimeProcessEventResult;
  getLastAppliedEvents(): readonly KernelEvent[];
  selectPendingEffects(
    state?: Readonly<AgentState>,
    facts?: SchedulerFacts,
  ): readonly RuntimeEffect[];
  acquireRunner(): string | null;
  releaseRunner(runnerId: string): void;
  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLease;
  isEffectLeaseCurrent(lease: Readonly<StateRuntimeSessionEffectLease>): boolean;
  isEffectEventCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    event: KernelEvent,
  ): boolean;
  applyResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyEffectResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  /**
   * Apply a durable effect batch through one explicit Store 4 acknowledgement
   * channel.  This method requires the exact in-process effect lease; stale
   * callers fail closed and cannot publish through a successor attempt.
   */

  applyEffectEvents(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  /** One receipt transaction admits the child intent and exact Task Tool disposition. */
  commitBackgroundChildAcceptance(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease: RuntimeLeaseRequirement,
    sealedGrant: RuntimeSealedChildGrantPayload,
  ): boolean;
  applyEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyEffectEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean;
  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean;
  releaseEffect(lease: Readonly<StateRuntimeSessionEffectLease>): void;
}

interface StateRuntimeSessionDefaults {
  readonly clock: StateRuntimeSessionClock;
  readonly id: StateRuntimeSessionIdSource;
}

function assertStateRuntimeSessionState(state: AgentState): void {
  if (state.recoveryState.kind === 'normal' || state.turn.status === 'aborted') {
    assertAgentStateInvariants(state);
    return;
  }

  // A failed restore is intentionally represented as a current-format hard
  // block with an active turn. The pure scheduler must be allowed to emit its
  // recovery_blocked effect so the Host can durably abort that turn. Validate
  // every other invariant by replacing only the hard-block marker.
  assertAgentStateInvariants({ ...state, recoveryState: { kind: 'normal' } });
}

/**
 * Host-owned State 27 session.  It is deliberately a thin transaction and
 * lease boundary around the pure Agent Kernel; it owns no Builtin, Model,
 * Prompt, Tool, or MCP semantics.
 */
class StateRuntimeSessionImpl implements StateRuntimeSession {
  readonly sessionId: string;
  readonly #services: RuntimeHostExecutionServices<KernelEvent, AgentState>;
  readonly #defaults: StateRuntimeSessionDefaults;
  readonly #sandboxAvailable: () => boolean;
  readonly #verificationSchemaAdmissions?: StateRuntimeVerificationAdmission;
  readonly #eventBatchPreprocessor?: StateRuntimeEventBatchPreprocessor;
  readonly #eventBatchAdmissionValidator?: StateRuntimeEventBatchAdmissionValidator;
  readonly #toolTerminalBatchValidator?: StateRuntimeToolTerminalBatchValidator;
  readonly #onNamedTurnSnapshot?: StateRuntimeSessionInput['onNamedTurnSnapshot'];
  readonly #isConcurrentEffectEventCurrent?: StateRuntimeConcurrentEffectEventCurrent;
  readonly #projectConcurrentEffectState?: StateRuntimeConcurrentEffectStateProjector;
  readonly #isLateEffectResult?: StateRuntimeSessionInput['isLateEffectResult'];
  readonly #effectLeases = new Map<string, StateRuntimeSessionEffectLease>();
  #state: AgentState;
  #lastAppliedEvents: readonly KernelEvent[] = [];
  #lastProcessedEventId: string | undefined;
  #runnerId: string | null = null;
  #currentRunId: string | undefined;
  readonly #revisionWaiters = new Set<() => void>();

  constructor(input: StateRuntimeSessionInput) {
    assertStateRuntimeSessionState(input.state);
    if (input.state.schemaVersion !== STATE_RUNTIME_SESSION_FORMAT_.schemaVersion) {
      throw new Error(
        `Runtime Host State session requires schema version ${STATE_RUNTIME_SESSION_FORMAT_.schemaVersion}.`,
      );
    }
    if (input.state.formatEpoch !== STATE_RUNTIME_SESSION_FORMAT_.epoch) {
      throw new Error('Runtime Host State session requires the current compatibility epoch.');
    }
    if (input.state.session.threadId.length === 0) {
      throw new Error('Runtime Host State session requires a non-empty session identity.');
    }
    if (input.services.sessions === undefined || input.services.transactions === undefined) {
      throw new Error('Runtime Host State session requires the injected Store services.');
    }
    if (typeof input.clock !== 'function' || typeof input.id !== 'function') {
      throw new Error('Runtime Host State session requires injected clock and id callbacks.');
    }
    this.#state = input.state;
    this.sessionId = input.state.session.threadId;
    this.#services = input.services;
    this.#defaults = {
      clock: input.clock,
      id: input.id,
    };
    this.#sandboxAvailable =
      typeof input.sandboxAvailable === 'function'
        ? input.sandboxAvailable
        : () => input.sandboxAvailable === true;
    this.#verificationSchemaAdmissions = input.verificationSchemaAdmissions;
    this.#eventBatchPreprocessor = input.eventBatchPreprocessor;
    this.#eventBatchAdmissionValidator = input.eventBatchAdmissionValidator;
    this.#toolTerminalBatchValidator = input.toolTerminalBatchValidator;
    this.#onNamedTurnSnapshot = input.onNamedTurnSnapshot;
    this.#isConcurrentEffectEventCurrent = input.isConcurrentEffectEventCurrent;
    this.#projectConcurrentEffectState = input.projectConcurrentEffectState;
    this.#isLateEffectResult = input.isLateEffectResult;
  }

  getState(): Readonly<AgentState> {
    return this.#state;
  }

  waitForRevisionChange(revision: number, signal?: AbortSignal): Promise<void> {
    if (this.#state.revision !== revision || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.#revisionWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.#revisionWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.#state.revision !== revision || signal?.aborted) finish();
    });
  }

  supportsRunStorage(): boolean {
    return this.#services.runs !== undefined;
  }

  getLifecycleProjection(exactState: Readonly<AgentState> = this.#state): Readonly<{
    readonly activeTask?: RuntimeSessionTaskProjection;
    readonly currentRun?: RuntimeSessionRunProjection;
  }> {
    const state = exactState;
    if (this.#services.runs && this.#currentRunId === undefined) {
      this.#currentRunId = resolveRuntimeExecutionRun(
        this.#services.runs,
        this.sessionId,
        state,
      )?.runId;
    }
    const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
    let run =
      this.#services.runs && this.#currentRunId
        ? this.#services.runs.get(this.sessionId, this.#currentRunId)
        : undefined;
    if (run && run.createdRevision > state.revision) {
      // A later Turn can commit while its predecessor's notifications are
      // still queued for publication. Project that older revision using the
      // Run which existed then, rather than the newly inserted current Run.
      run = runAtOrBeforeRevision(this.#services.runs!, this.sessionId, state.revision);
    }
    const activeInteractionId =
      state.interactions.kind === 'idle' ? undefined : state.interactions.interactionId;
    const visibleRun = run != null && run.lastRevision <= state.revision ? run : undefined;
    const projectedRunStatus = visibleRun
      ? visibleRun.status === 'unknown'
        ? ('recovery_required' as const)
        : visibleRun.status
      : state.turn.status === 'completed'
        ? ('completed' as const)
        : state.turn.status === 'aborted'
          ? state.turn.abortCause === 'user'
            ? ('cancelled' as const)
            : ('failed' as const)
          : state.interactions.kind === 'idle'
            ? ('running' as const)
            : ('waiting' as const);
    return Object.freeze({
      ...(task
        ? {
            activeTask: Object.freeze({
              taskId: task.taskId,
              phase:
                task.planning.kind === 'executing' ? ('building' as const) : ('planning' as const),
            }),
          }
        : {}),
      ...(run
        ? {
            currentRun: Object.freeze({
              runId: run.runId,
              initialTurnId: run.runId,
              activeTurnId: state.turn.turnId,
              ...(task ? { taskId: task.taskId } : {}),
              status: projectedRunStatus,
              revision: visibleRun ? visibleRun.lastRevision : state.revision,
              ...(projectedRunStatus === 'waiting' &&
              state.completionGuard.waitingReason?.kind === 'required_background'
                ? {
                    waitingReason: Object.freeze({
                      kind: 'required_background' as const,
                      taskIds: Object.freeze([...state.completionGuard.waitingReason.taskIds]),
                    }),
                  }
                : {}),
              ...(activeInteractionId === undefined ? {} : { activeInteractionId }),
              ...(!visibleRun || visibleRun.terminal === undefined
                ? {}
                : { outcome: Object.freeze({ ...visibleRun.terminal }) }),
            }),
          }
        : {}),
    });
  }

  activateRun(runId: string): void {
    const runs = this.#services.runs;
    if (!runs) return;
    const current = runs.get(this.sessionId, runId);
    if (!current) throw new Error(`Runtime Run activation target is missing: ${runId}.`);
    if (current.status !== 'queued') {
      if (current.status === 'running') return;
      throw new Error(`Runtime Run activation target is ${current.status}: ${runId}.`);
    }
    const startedAtMs = Math.max(current.createdAtMs, this.#clockMilliseconds());
    this.#services.transactions.commit('attempt_start', {
      sessionId: this.sessionId,
      events: [],
      snapshot: this.#state,
      runMutation: {
        type: 'transition',
        transition: {
          sessionId: this.sessionId,
          runId,
          expectedLastRevision: current.lastRevision,
          next: Object.freeze({
            ...current,
            status: 'running',
            startedAtMs,
          }),
        },
      },
    });
  }

  processEvent(event: KernelEvent): StateRuntimeProcessEventResult {
    const occurredAt = this.#eventTimestamp();
    this.#lastProcessedEventId = undefined;
    const applied = this.processEventBatch([event], { occurredAt });
    if (!this.#lastProcessedEventId) {
      throw new Error('Runtime State session did not produce an event identity.');
    }
    return {
      status: applied.length === 0 ? 'duplicate' : 'applied',
      eventId: this.#lastProcessedEventId,
    };
  }

  processEventBatch(
    events: readonly KernelEvent[],
    options: StateRuntimeProcessEventBatchOptions = {},
  ): readonly KernelEvent[] {
    return this.#processEventBatch(events, options).events;
  }

  commitCommandBatch(
    events: readonly KernelEvent[],
    evidence: RuntimeCommandCommitEvidence,
    sessionModelRoute?: RuntimeSessionModelRoute,
    agentMailboxMutations?: readonly RuntimeAgentMailboxMutation[],
  ): StateRuntimeCommandCommitResult {
    if (evidence.targetSessionId !== this.sessionId) {
      throw new Error('Runtime command receipt target does not match State session.');
    }
    const committed = this.#processEventBatch(
      events,
      { source: 'command' },
      evidence,
      sessionModelRoute,
      agentMailboxMutations,
    );
    if (!committed.receipt) {
      throw new Error('Runtime command did not produce an applied State decision.');
    }
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitAgentMailboxFacts(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): readonly KernelEvent[] {
    if (
      events.length === 0 ||
      mutations.length === 0 ||
      mutations.some((mutation) => mutation.kind === 'accept_mail')
    )
      throw new Error('Agent mailbox metadata commit requires non-mail facts and mutations.');
    const applied = this.#processEventBatch(
      events,
      {
        source: 'host_fact',
        acknowledgement: 'receipt_evidence',
        ...(requiredEffectLease ? { requiredEffectLease } : {}),
      },
      undefined,
      undefined,
      mutations,
    ).events;
    if (applied.length === 0)
      throw new Error('Agent mailbox metadata facts were not newly committed.');
    return applied;
  }

  commitBackgroundAgentSettlement(
    input: StateRuntimeBackgroundAgentSettlementInput,
  ): StateRuntimeBackgroundAgentSettlementResult {
    const event = input.resultEvent;
    const ref = input.resultRef;
    if (
      ref.kind !== 'subagent_task' ||
      !ref.artifactId ||
      !/^sha256:[a-f0-9]{64}$/u.test(ref.integrityIdentifier) ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 1 ||
      event.artifactIntegrityIdentifier !== ref.integrityIdentifier ||
      event.notificationId !== `subagent:${event.taskId}:${ref.integrityIdentifier}` ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.grantDigest) ||
      input.agent.agentId !== event.taskId ||
      input.agent.currentTaskId !== event.taskId ||
      !this.#services.runs?.get(this.sessionId, event.originRunId)
    )
      throw new Error('Background Agent settlement identity is invalid.');
    const result = input.readResultArtifact(ref, event.taskId);
    const status = result?.terminalStatus;
    if (
      !result ||
      (status !== 'completed' &&
        status !== 'failed' &&
        status !== 'cancelled' &&
        status !== 'interrupted' &&
        status !== 'exhausted' &&
        status !== 'suspended') ||
      (status === 'completed') !== (result.ok === true) ||
      (event.afterTurn && event.afterTurn.status !== status)
    )
      throw new Error('Background Agent result Artifact is inconsistent.');
    const state = this.#state;
    const call = state.tools.calls[event.originToolCallId];
    const matches = Object.values(state.capabilities.invocations).filter((invocation) => {
      const lifecycle = invocation.subagentProviderLifecycle;
      return (
        invocation.toolCallId === event.originToolCallId &&
        lifecycle?.purpose === 'start' &&
        lifecycle.status === 'cleanup_completed' &&
        lifecycle.cleanupConfirmed === true &&
        lifecycle.childInvocationId === event.taskId &&
        lifecycle.attempt === event.attempt
      );
    });
    if (call?.createdAtTurnId !== event.originTurnId || matches.length !== 1)
      throw new Error('Background Agent origin is not an exact settled child.');
    if (input.reply) {
      const { event: reply, mutation: replyMutation } = input.reply;
      assertAgentMailboxAcceptance([reply], [replyMutation]);
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      const expectedMessageId = `mail_${hash(
        JSON.stringify([
          'background_terminal_reply_v1',
          this.sessionId,
          event.taskId,
          event.notificationId,
        ]),
      )}`;
      const expectedBody = `Agent task ${event.taskId} ${status}. Use task_read with this task_id for the full result.`;
      const expectedBodyHex = hash(expectedBody);
      const expectedDigest = `sha256:${expectedBodyHex}`;
      const expectedSource = {
        runId: event.originRunId,
        turnId: event.originTurnId,
        modelInvocationId: call.modelInvocationId,
        toolCallId: event.originToolCallId,
        effectAttemptId: `${matches[0]!.invocationId}:attempt:${event.attempt}`,
        sourceTaskId: event.taskId,
      };
      if (
        reply.mode !== 'reply' ||
        reply.submissionId !== undefined ||
        reply.messageId !== expectedMessageId ||
        reply.senderAgentId !== event.taskId ||
        reply.targetAgentId !== this.sessionId ||
        !call.modelInvocationId ||
        JSON.stringify(reply.source) !== JSON.stringify(expectedSource) ||
        replyMutation.bodyText !== expectedBody ||
        reply.bodyDigest !== expectedDigest ||
        reply.bodyRef.artifactId !== `pa_${expectedBodyHex}` ||
        reply.bodyRef.integrityIdentifier !== expectedDigest ||
        reply.bodyRef.byteLength !== Buffer.byteLength(expectedBody, 'utf8') ||
        replyMutation.requestDigest !==
          hash(
            JSON.stringify([
              expectedMessageId,
              this.sessionId,
              'reply',
              expectedDigest,
              expectedSource,
            ]),
          ) ||
        !Number.isSafeInteger(reply.sequence) ||
        reply.sequence < 1 ||
        !Number.isSafeInteger(replyMutation.acceptedAtMs) ||
        replyMutation.acceptedAtMs < 0
      )
        throw new Error('Background Agent terminal reply identity is invalid.');
    }
    const prior = matches[0]!.subagentProviderLifecycle?.backgroundResult;
    if (
      prior &&
      (prior.taskId !== event.taskId ||
        prior.notificationId !== event.notificationId ||
        prior.artifactIntegrityIdentifier !== event.artifactIntegrityIdentifier ||
        prior.originRunId !== event.originRunId ||
        prior.originTurnId !== event.originTurnId ||
        prior.originToolCallId !== event.originToolCallId ||
        prior.attempt !== event.attempt ||
        JSON.stringify(prior.checkpointRef ?? null) !==
          JSON.stringify(event.checkpointRef ?? null) ||
        JSON.stringify(prior.afterTurn ?? null) !== JSON.stringify(event.afterTurn ?? null))
    )
      throw new Error('Background Agent result conflicts with its prior settlement.');
    if (input.agent.status !== 'active') {
      if (
        prior &&
        ((input.agent.status === 'idle' && event.checkpointRef !== undefined) ||
          (input.agent.status === 'context_unavailable' && event.checkpointRef === undefined))
      )
        return Object.freeze({ mode: 'replay', events: Object.freeze([]) });
      throw new Error('Background Agent task is no longer active.');
    }
    const proof = input.activeTaskProof;
    if (!proof?.ownerGeneration || proof.grantDigest !== input.grantDigest)
      throw new Error('Background Agent active task proof is unavailable.');
    const settled: Extract<KernelEvent, { type: 'agent.task_settled' }> = {
      type: 'agent.task_settled',
      agentId: event.taskId,
      taskId: event.taskId,
      ownerGeneration: proof.ownerGeneration,
      status,
      resultRef: ref,
      ...(event.checkpointRef ? { checkpointRef: event.checkpointRef } : {}),
    };
    const mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'task_settled' }> = {
      kind: 'task_settled',
      agentId: event.taskId,
      taskId: event.taskId,
      ...(event.checkpointRef ? { checkpointRef: event.checkpointRef } : {}),
    };
    const expectedEvents = [
      ...(prior ? [] : [event]),
      settled,
      ...(input.reply ? [input.reply.event] : []),
    ];
    const committed = this.#processEventBatch(
      expectedEvents,
      { source: 'host_fact', acknowledgement: 'receipt_evidence' },
      undefined,
      undefined,
      [mutation, ...(input.reply ? [input.reply.mutation] : [])],
    ).events;
    if (committed.length !== expectedEvents.length)
      throw new Error('Background Agent settlement did not commit exactly once.');
    return Object.freeze({ mode: prior ? 'agent_only' : 'joint', events: committed });
  }

  commitChildCreationFailure(input: StateRuntimeChildCreationFailureInput): readonly KernelEvent[] {
    const failure = input.failureEvent;
    const result = input.resultEvent;
    assertPreDispatchChildFailureProof(
      input.mode,
      failure.childThreadId,
      input.readPreDispatchChildProof,
    );
    const invocation = this.#state.capabilities.invocations[failure.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    const call = link ? this.#state.tools.calls[link.originToolCallId] : undefined;
    const reservation = fundingBudgetForRun(this.#state, link?.fundingRunId ?? '')?.reservations[
      link?.delegatedReservationId ?? ''
    ];
    const artifact = input.readFailureArtifact(failure.resultRef, failure.childInvocationId);
    const cancelled = failure.type === 'subagent.child_pre_dispatch_cancelled';
    const receiptDigest = cancelled ? failure.terminalReceiptDigest : failure.failureReceiptDigest;
    if (
      !link ||
      link.terminalImport ||
      link.childThreadId !== failure.childThreadId ||
      failure.mode !== input.mode ||
      invocation?.subagentProviderLifecycle?.childInvocationId !== failure.childInvocationId ||
      call?.result?.resultMeta?.taskId !== failure.childInvocationId ||
      call.result.resultMeta.taskStatus !== 'running' ||
      (reservation?.state !== 'reserved' && reservation?.state !== 'queued') ||
      input.releaseEvent.reservationId !== link.delegatedReservationId ||
      receiptDigest !== failure.resultRef.integrityIdentifier ||
      artifact.terminalStatus !== (cancelled ? 'cancelled' : 'failed') ||
      artifact.ok !== false ||
      result.taskId !== failure.childInvocationId ||
      result.artifactIntegrityIdentifier !== failure.resultRef.integrityIdentifier ||
      result.originRunId !== link.originRunId ||
      result.originTurnId !== link.originTurnId ||
      result.originToolCallId !== link.originToolCallId ||
      result.attempt !== invocation.subagentProviderLifecycle.attempt ||
      result.childTerminalStatus !== (cancelled ? 'cancelled' : 'failed') ||
      result.notificationId !==
        `subagent:${failure.childInvocationId}:${failure.resultRef.integrityIdentifier}`
    )
      throw new Error('Child Session creation failure proof is invalid.');
    const mutation: RuntimeChildCreationFailureMutation = {
      parentSessionId: this.sessionId,
      childThreadId: failure.childThreadId,
      failureReceiptDigest: receiptDigest,
      mode: input.mode,
    };
    const events = [input.releaseEvent, failure, result];
    const committed = this.#processEventBatch(
      events,
      { source: 'host_fact', acknowledgement: 'receipt_evidence' },
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== events.length)
      throw new Error('Child creation failure did not settle the exact Tool claim.');
    return committed;
  }

  commitChildSessionTerminalSeal(
    event: Extract<KernelEvent, { type: 'subagent.child_terminal_sealed' }>,
  ): readonly KernelEvent[] {
    if (event.status !== 'completed')
      return this.#processEventBatch([event], {
        source: 'host_fact',
        acknowledgement: 'receipt_evidence',
      }).events;
    return this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ).events;
  }

  commitChildFollowupRunStart(
    events: readonly KernelEvent[],
    mutation: RuntimeFollowupRunStartMutation,
  ): readonly KernelEvent[] {
    const origin = this.#state.childSessionOrigin;
    const prepared = events[0];
    const configured = events[1];
    const task = events[2];
    const turn = events[3];
    if (
      events.length !== 4 ||
      !origin?.terminal ||
      origin.terminal.status !== 'completed' ||
      origin.parentSessionId !== mutation.sourceSessionId ||
      this.#state.activeTaskId !== null ||
      this.#state.terminalOutcome?.status !== 'completed' ||
      prepared?.type !== 'agent.followup_turn_prepared' ||
      prepared.sourceSessionId !== mutation.sourceSessionId ||
      prepared.submissionId !== mutation.submissionId ||
      prepared.targetRunId !== mutation.targetRunId ||
      prepared.taskId !== mutation.taskId ||
      prepared.grantDigest !== mutation.grantDigest ||
      JSON.stringify(prepared.grantRef) !== JSON.stringify(mutation.grant.ref) ||
      mutation.grant.ref.integrityIdentifier !== mutation.grantDigest ||
      JSON.stringify(prepared.checkpointRef) !== JSON.stringify(mutation.checkpointRef) ||
      configured?.type !== 'resource_budget.configured' ||
      configured.runId !== mutation.targetRunId ||
      task?.type !== 'task.started' ||
      task.taskId !== mutation.taskId ||
      task.turnId !== mutation.targetRunId ||
      task.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
      turn?.type !== 'turn.started' ||
      turn.turnId !== mutation.targetRunId ||
      mutation.taskId === origin.childInvocationId
    )
      throw new Error('Child followup Run start lacks a fresh fenced checkpoint identity.');
    const committed = this.#processEventBatch(
      events,
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== events.length)
      throw new Error('Child followup Run start was not newly committed.');
    return committed;
  }

  commitChildFollowupTurnSettlement(
    event: Extract<KernelEvent, { type: 'agent.followup_turn_settled' }>,
  ): readonly KernelEvent[] {
    const followup = this.#state.activeFollowupTurn;
    if (
      !followup ||
      followup.sourceSessionId !== event.sourceSessionId ||
      followup.submissionId !== event.submissionId ||
      followup.targetRunId !== event.targetRunId ||
      followup.taskId !== event.taskId ||
      this.#state.turn.turnId !== event.targetRunId ||
      this.#state.turn.status === 'active' ||
      this.#state.activeTaskId !== null ||
      (event.status === 'unknown' && this.#state.tasks[event.taskId]?.status !== 'failed') ||
      (event.status === 'completed') !== (this.#state.terminalOutcome?.status === 'completed')
    )
      throw new Error('Child followup settlement lacks its exact terminal Run.');
    return this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      event.status === 'completed' ? true : undefined,
    ).events;
  }

  commitChildCurrentTurnFollowupSettlement(
    event: Extract<KernelEvent, { type: 'agent.followup_turn_settled' }>,
  ): readonly KernelEvent[] {
    const state = this.#state;
    const origin = state.childSessionOrigin;
    const terminal = origin?.terminal;
    const status =
      state.terminalOutcome?.status === 'unknown'
        ? 'unknown'
        : terminal?.status === 'completed'
          ? 'completed'
          : terminal?.status === 'cancelled'
            ? 'cancelled'
            : terminal?.status === 'unknown'
              ? 'unknown'
              : 'failed';
    if (
      !terminal ||
      origin.parentSessionId !== event.sourceSessionId ||
      origin.childInvocationId !== event.taskId ||
      state.activeFollowupTurn ||
      state.turn.turnId !== event.targetRunId ||
      state.turn.status === 'active' ||
      (state.activeTaskId !== null && state.activeTaskId !== origin.childInvocationId) ||
      event.status !== status
    )
      throw new Error('Current-turn followup settlement lacks its exact child terminal.');
    return this.#processEventBatch([event], {
      source: 'host_fact',
      acknowledgement: 'decision',
    }).events;
  }

  commitCrossSessionFollowupRoute(
    events: readonly [
      Extract<KernelEvent, { type: 'agent.followup_routed' }>,
      Extract<KernelEvent, { type: 'agent.mail_input_prepared' }>,
    ],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
  ): readonly KernelEvent[] {
    const state = this.#state;
    const followup = state.activeFollowupTurn;
    const currentRun = this.getLifecycleProjection(state).currentRun;
    const model = state.modelInvocations[mutation.invocationId];
    const reservation =
      state.resourceBudget.status === 'active'
        ? state.resourceBudget.reservations[mutation.reservationId]
        : undefined;
    const [routed, prepared] = events;
    const newTurn =
      mutation.route === 'new_turn' &&
      followup?.sourceSessionId === mutation.sourceSessionId &&
      followup.submissionId === mutation.submissionId &&
      followup.targetRunId === mutation.targetRunId &&
      followup.taskId === mutation.taskId;
    const currentTurn =
      mutation.route === 'current_turn' &&
      !followup &&
      state.childSessionOrigin?.parentSessionId === mutation.sourceSessionId &&
      state.childSessionOrigin.terminal === undefined &&
      typeof state.childSessionOrigin.grantDigest === 'string' &&
      currentRun?.runId === mutation.targetRunId &&
      (currentRun.status === 'running' || currentRun.status === 'waiting') &&
      currentRun.activeTurnId === state.turn.turnId;
    if (
      (!newTurn && !currentTurn) ||
      state.turn.turnId !== mutation.targetRunId ||
      state.turn.status !== 'active' ||
      state.activeTaskId !== mutation.taskId ||
      model?.status !== 'prepared' ||
      model.attempts !== 0 ||
      model.surfaceArtifact.kind !== 'model_surface' ||
      !Number.isSafeInteger(model.estimatedInputTokens) ||
      model.budget.kind !== 'reservation' ||
      model.budget.reservationId !== mutation.reservationId ||
      reservation?.state !== 'reserved' ||
      reservation.resourceKind !== 'model' ||
      reservation.runId !== mutation.targetRunId ||
      reservation.invocationId !== `model-invocation:${mutation.invocationId}` ||
      routed.submissionId !== mutation.submissionId ||
      routed.targetAgentId !== this.sessionId ||
      routed.route !== mutation.route ||
      routed.taskId !== mutation.taskId ||
      routed.invocationId !== mutation.invocationId ||
      routed.modelAdmissionId !== mutation.modelAdmissionId ||
      routed.reservationId !== mutation.reservationId ||
      mutation.modelAdmissionId !== mutation.reservationId ||
      prepared.targetAgentId !== this.sessionId ||
      prepared.invocationId !== mutation.invocationId ||
      prepared.modelAdmissionId !== mutation.modelAdmissionId ||
      prepared.messageIds.length !== 1 ||
      prepared.messageIds[0] !== mutation.messageId
    )
      throw new Error('Child followup route lacks its exact prepared Model and local budget.');
    return this.#processEventBatch(
      events,
      {
        source: 'host_fact',
        acknowledgement: 'decision',
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
  }

  commitCrossSessionFollowupRouteForModelEffect(
    lease: StateRuntimeSessionEffectLease,
    events: readonly [
      Extract<KernelEvent, { type: 'agent.followup_routed' }>,
      Extract<KernelEvent, { type: 'agent.mail_input_prepared' }>,
    ],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
  ): readonly KernelEvent[] {
    if (
      mutation.route !== 'current_turn' ||
      lease.effect.type !== 'call_model' ||
      lease.turnId !== mutation.targetRunId ||
      !this.isEffectLeaseCurrent(lease)
    )
      throw new Error('Current-turn route requires its exact live Model effect lease.');
    const committed = this.commitCrossSessionFollowupRoute(events, mutation);
    if (committed.length !== 2)
      throw new Error('Current-turn route did not persist both exact target facts.');
    lease.expectedRevision = this.#state.revision;
    return committed;
  }

  commitCrossSessionFollowupFunding(
    events: readonly KernelEvent[],
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      {
        kind:
          | 'replace_followup_backup'
          | 'activate_followup_funding'
          | 'settle_followup_funding'
          | 'release_accepted_followup_backup'
          | 'release_current_turn_backup'
          | 'activate_independent_followup_turn'
          | 'settle_independent_followup_funding';
      }
    >,
  ): readonly KernelEvent[] {
    const invalidEvents =
      mutation.kind === 'activate_independent_followup_turn'
        ? events.length !== 1 || events[0]?.type !== 'resource_budget.dispatch_started'
        : mutation.kind === 'settle_independent_followup_funding'
          ? events.length < 1 ||
            events.length > 2 ||
            events.at(-1)?.type !== 'agent.followup_independent_settled' ||
            (events.length === 1
              ? mutation.disposition !== 'unknown'
              : events[0]?.type !==
                (mutation.disposition === 'completed'
                  ? 'resource_budget.reconciled'
                  : mutation.disposition === 'unknown'
                    ? 'resource_budget.unknown'
                    : 'resource_budget.released'))
          : mutation.kind === 'replace_followup_backup'
            ? events.length !== 1 || events[0]?.type !== 'resource_budget.bounded_replaced'
            : mutation.kind === 'release_accepted_followup_backup' ||
                mutation.kind === 'release_current_turn_backup'
              ? events.length !== 1 || events[0]?.type !== 'resource_budget.released'
              : events.length !== 2 ||
                events.some(
                  (event) =>
                    event.type !==
                    (mutation.kind === 'activate_followup_funding'
                      ? 'resource_budget.dispatch_started'
                      : mutation.disposition === 'completed'
                        ? 'resource_budget.reconciled'
                        : mutation.disposition === 'unknown'
                          ? 'resource_budget.unknown'
                          : 'resource_budget.released'),
                );
    if (!mutation.submissionId || !mutation.targetSessionId || invalidEvents)
      throw new Error('Cross-Session followup funding transition is invalid.');
    return this.#processEventBatch(
      events,
      {
        source: 'host_fact',
        acknowledgement: 'decision',
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
  }

  /** Generic recovery already persisted both unknown budgets; only the ACK is missing. */
  commitCrossSessionFollowupUnknownAck(
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'settle_followup_funding_after_unknown_recovery' }
    >,
  ): void {
    if (
      !mutation.targetSessionId ||
      !mutation.submissionId ||
      !mutation.targetRunId ||
      !mutation.modelInvocationId ||
      !Number.isSafeInteger(mutation.targetRevision) ||
      mutation.targetRevision < 1 ||
      !Number.isSafeInteger(mutation.createdAtMs) ||
      mutation.createdAtMs < 0
    )
      throw new Error('Recovered followup unknown ACK identity is invalid.');
    assertStateRuntimeSessionState(this.#state);
    this.#services.transactions.commit('decision', {
      sessionId: this.sessionId,
      events: [],
      snapshot: this.#state,
      metadata: [],
      expectedRestoreBoundary: this.#restoreBoundary(),
      crossSessionAgentMailMutation: mutation,
    });
    this.#lastAppliedEvents = [];
    this.#lastProcessedEventId = undefined;
  }

  commitChildSessionTerminalImport(
    input: StateRuntimeChildTerminalImportInput,
  ): readonly KernelEvent[] {
    const imported = input.importEvent;
    const result = input.resultEvent;
    const invocation = this.#state.capabilities.invocations[imported.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    if (
      !link ||
      link.childThreadId !== imported.childThreadId ||
      invocation?.subagentProviderLifecycle?.childInvocationId !== imported.childInvocationId
    )
      throw new Error('Child terminal import has no exact parent creation intent.');
    if (link.terminalImport) {
      if (
        link.terminalImport.terminalRevision === imported.terminalRevision &&
        link.terminalImport.terminalReceiptDigest === imported.terminalReceiptDigest &&
        link.terminalImport.resultRef.integrityIdentifier === imported.resultRef.integrityIdentifier
      )
        return [];
      throw new Error('Child terminal import conflicts with prior settlement.');
    }
    const child = input.readChildState(imported.childThreadId);
    const origin = child.childSessionOrigin;
    const terminal = origin?.terminal;
    const artifact = input.readResultArtifact(imported.resultRef, imported.childInvocationId);
    const call = this.#state.tools.calls[link.originToolCallId];
    const funding = fundingBudgetForRun(this.#state, link.fundingRunId);
    const delegated = funding?.reservations[link.delegatedReservationId];
    const childBudget = child.resourceBudget;
    const unknownUsage =
      childBudget.status !== 'active' ||
      Object.values(childBudget.reservations).some(
        (reservation) =>
          reservation.state === 'reserved' ||
          reservation.state === 'dispatch_started' ||
          reservation.state === 'unknown',
      );
    const unknownRecovery = terminal?.status === 'unknown' && terminal.cleanupConfirmed === false;
    const cleanCancellation =
      terminal?.status === 'cancelled' &&
      terminal.cleanupConfirmed === true &&
      child.turn.status === 'aborted' &&
      child.turn.abortCause === 'user' &&
      !child.terminalOutcome;
    const expectedDigest = terminal
      ? childTerminalReceiptDigest({
          childThreadId: imported.childThreadId,
          terminalRevision: terminal.sealedRevision,
          terminalReceiptId: terminal.terminalReceiptId,
          resultIntegrityIdentifier: terminal.resultRef.integrityIdentifier,
          ...(unknownRecovery ? { unknownRecovery: true as const } : {}),
        })
      : undefined;
    if (
      child.session.threadId !== imported.childThreadId ||
      (!child.terminalOutcome && !cleanCancellation) ||
      origin?.parentSessionId !== this.sessionId ||
      origin.parentInvocationId !== imported.parentInvocationId ||
      origin.parentToolCallId !== link.originToolCallId ||
      origin.childInvocationId !== imported.childInvocationId ||
      origin.grantDigest !== link.grantDigest ||
      origin.fundingRunId !== link.fundingRunId ||
      origin.delegatedReservationId !== link.delegatedReservationId ||
      origin.delegatedUpperBoundDigest !== link.delegatedUpperBoundDigest ||
      origin.deadlineAt !== link.deadlineAt ||
      !terminal ||
      (!terminal.cleanupConfirmed && !unknownRecovery) ||
      (unknownRecovery &&
        (child.terminalOutcome?.status !== 'unknown' ||
          child.terminalOutcome?.knownExternalEffects !== 'unknown' ||
          child.turn.status === 'active' ||
          !unknownUsage ||
          input.resourceEvent.type !== 'resource_budget.unknown')) ||
      terminal.status !== imported.status ||
      terminal.resultRef.integrityIdentifier !== imported.resultRef.integrityIdentifier ||
      terminal.sealedRevision !== imported.terminalRevision ||
      imported.terminalReceiptDigest !== expectedDigest ||
      artifact.terminalStatus !== imported.status ||
      (imported.status === 'completed') !== (artifact.ok === true) ||
      call?.result?.resultMeta?.taskId !== imported.childInvocationId ||
      call.result.resultMeta.taskStatus !== 'running' ||
      !delegated ||
      (delegated.state !== 'dispatch_started' && delegated.state !== 'unknown') ||
      input.resourceEvent.reservationId !== link.delegatedReservationId ||
      (unknownUsage
        ? input.resourceEvent.type !== 'resource_budget.unknown'
        : input.resourceEvent.type !== 'resource_budget.reconciled') ||
      result.taskId !== imported.childInvocationId ||
      result.artifactIntegrityIdentifier !== imported.resultRef.integrityIdentifier ||
      result.originRunId !== link.originRunId ||
      result.originTurnId !== link.originTurnId ||
      result.originToolCallId !== link.originToolCallId ||
      result.attempt !== invocation.subagentProviderLifecycle.attempt ||
      result.childTerminalStatus !== imported.status ||
      result.notificationId !==
        `subagent:${imported.childInvocationId}:${imported.resultRef.integrityIdentifier}`
    )
      throw new Error('Child terminal seal, usage or parent receipt proof is invalid.');
    if (!unknownUsage && input.resourceEvent.type === 'resource_budget.reconciled') {
      const actual = childBudget.reconciledUsage;
      const reported = input.resourceEvent.actual;
      if (
        reported.source !== 'actual' ||
        JSON.stringify(reported.counters) !== JSON.stringify(actual.counters) ||
        actual.gauges.activeSubagents !== 0 ||
        reported.gauges.activeSubagents !== 0 ||
        Object.entries(reported.gauges).some(
          ([key, value]) =>
            key !== 'activeSubagents' && value !== actual.gauges[key as keyof typeof actual.gauges],
        )
      )
        throw new Error('Child terminal usage does not match its sealed Session ledger.');
    }
    const events = [input.resourceEvent, imported, result];
    const mutation: RuntimeChildTerminalImportMutation = {
      parentSessionId: this.sessionId,
      childThreadId: imported.childThreadId,
      terminalReceiptDigest: imported.terminalReceiptDigest,
    };
    const committed = this.#processEventBatch(
      events,
      {
        source: 'host_fact',
        acknowledgement: 'receipt_evidence',
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    const previouslyUnknown =
      input.resourceEvent.type === 'resource_budget.unknown' && delegated.state === 'unknown';
    if (
      (committed.length !== events.length &&
        !(previouslyUnknown && committed.length === events.length - 1)) ||
      committed.filter((event) => event.type === 'subagent.child_terminal_imported').length !== 1 ||
      committed.filter((event) => event.type === 'subagent.background_result_persisted').length !==
        1
    )
      throw new Error('Child terminal import did not settle the exact Tool claim.');
    return committed;
  }

  commitChildRecoveryRequired(
    event: Extract<KernelEvent, { type: 'subagent.child_recovery_required' }>,
  ): readonly KernelEvent[] {
    const invocation = this.#state.capabilities.invocations[event.parentInvocationId];
    const lifecycle = invocation?.subagentProviderLifecycle;
    const link = lifecycle?.childSession;
    if (
      event.parentSessionId !== this.sessionId ||
      !link ||
      invocation?.toolCallId !== event.originToolCallId ||
      lifecycle.childInvocationId !== event.childInvocationId ||
      lifecycle.attempt !== event.attempt ||
      link.childThreadId !== event.childThreadId ||
      link.grantDigest !== event.grantDigest ||
      link.terminalImport ||
      lifecycle.backgroundResult
    )
      throw new Error('Child recovery diagnostic has no pending exact intent.');
    if (link.recoveryDiagnostic) {
      if (link.recoveryDiagnostic.diagnosticCode === event.diagnosticCode) return [];
      throw new Error('Child recovery diagnostic conflicts with prior evidence.');
    }
    const committed = this.#processEventBatch([event], {
      source: 'host_fact',
      acknowledgement: 'receipt_evidence',
    }).events;
    if (committed.length !== 1)
      throw new Error('Child recovery diagnostic did not advance the parent revision.');
    return committed;
  }

  commitChildBudgetActivation(
    events: readonly KernelEvent[],
    mutation: RuntimeChildBudgetActivationMutation,
    evidence: RuntimeCommandCommitEvidence,
  ): StateRuntimeCommandCommitResult {
    const adopted = events.filter(
      (event): event is Extract<KernelEvent, { type: 'subagent.child_session_adopted' }> =>
        event.type === 'subagent.child_session_adopted',
    );
    const configured = events.filter(
      (event): event is Extract<KernelEvent, { type: 'resource_budget.configured' }> =>
        event.type === 'resource_budget.configured',
    );
    const taskInputs = events.filter(
      (event): event is Extract<KernelEvent, { type: 'subagent.child_task_input_admitted' }> =>
        event.type === 'subagent.child_task_input_admitted',
    );
    const turns = events.filter(
      (event): event is Extract<KernelEvent, { type: 'turn.started' }> =>
        event.type === 'turn.started',
    );
    const tasks = events.filter(
      (event): event is Extract<KernelEvent, { type: 'task.started' }> =>
        event.type === 'task.started',
    );
    if (
      !this.#state.childSessionOrigin ||
      this.#state.childSessionOrigin.terminal ||
      this.#state.childSessionOrigin.parentSessionId !== mutation.parentSessionId ||
      this.#state.childSessionOrigin.parentInvocationId !== mutation.parentInvocationId ||
      this.#state.childSessionOrigin.childInvocationId !== mutation.childInvocationId ||
      this.#state.childSessionOrigin.grantDigest !== mutation.grantDigest ||
      this.#state.childSessionOrigin.taskArtifactDigest !== mutation.taskArtifactDigest ||
      this.#state.childSessionOrigin.taskTextDigest !== mutation.taskTextDigest ||
      !sameChildTaskArtifactRef(
        this.#state.childSessionOrigin.taskArtifactRef,
        mutation.taskArtifactRef,
      ) ||
      mutation.childMayWrite !== (this.#state.childSessionOrigin.role === 'code') ||
      mutation.childMaySpawn !== false ||
      this.#state.childSessionOrigin.fundingRunId !== mutation.fundingRunId ||
      this.#state.childSessionOrigin.delegatedReservationId !== mutation.delegatedReservationId ||
      this.#state.childSessionOrigin.delegatedUpperBoundDigest !==
        mutation.delegatedUpperBoundDigest ||
      this.#state.resourceBudget.status !== 'unconfigured' ||
      mutation.childThreadId !== this.sessionId ||
      adopted.length !== 1 ||
      configured.length !== 1 ||
      taskInputs.length !== 1 ||
      turns.length !== 1 ||
      tasks.length !== 1 ||
      events.length !== 5 ||
      events[0]?.type !== 'subagent.child_session_adopted' ||
      events[1]?.type !== 'subagent.child_task_input_admitted' ||
      events[2]?.type !== 'resource_budget.configured' ||
      events[3]?.type !== 'turn.started' ||
      events[4]?.type !== 'task.started' ||
      turns[0]?.turnId !== mutation.childRunId ||
      tasks[0]?.taskId !== mutation.childInvocationId ||
      tasks[0]?.turnId !== mutation.childRunId ||
      tasks[0]?.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
      taskInputs[0]?.childInvocationId !== mutation.childInvocationId ||
      taskInputs[0]?.grantDigest !== mutation.grantDigest ||
      taskInputs[0]?.taskDigest !== mutation.taskArtifactDigest ||
      taskInputs[0]?.taskTextDigest !== mutation.taskTextDigest ||
      !sameChildTaskArtifactRef(taskInputs[0]?.taskArtifactRef, mutation.taskArtifactRef) ||
      events.some(
        (event) =>
          event.type === 'user.message_appended' || event.type === 'model.invocation_prepared',
      ) ||
      !events.some((event) => event.type === 'turn.started') ||
      adopted[0]?.parentSessionId !== mutation.parentSessionId ||
      adopted[0]?.parentInvocationId !== mutation.parentInvocationId ||
      adopted[0]?.childInvocationId !== mutation.childInvocationId ||
      adopted[0]?.grantDigest !== mutation.grantDigest ||
      adopted[0]?.fundingRunId !== mutation.fundingRunId ||
      adopted[0]?.delegatedReservationId !== mutation.delegatedReservationId ||
      adopted[0]?.delegatedUpperBoundDigest !== mutation.delegatedUpperBoundDigest ||
      configured[0]?.runId !== mutation.childRunId ||
      evidence.targetSessionId !== this.sessionId ||
      evidence.runStart?.runId !== mutation.childRunId
    )
      throw new Error('Child Session budget activation is not exact.');
    const committed = this.#processEventBatch(
      events,
      { source: 'command' },
      evidence,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    );
    if (committed.events.length !== events.length || !committed.receipt)
      throw new Error('Child Session budget activation did not commit exactly once.');
    return { events: committed.events, receipt: committed.receipt };
  }

  commitChildDispatchAck(childThreadId: string): readonly KernelEvent[] {
    const matches = Object.values(this.#state.capabilities.invocations).filter(
      (invocation) =>
        invocation.subagentProviderLifecycle?.childSession?.childThreadId === childThreadId,
    );
    if (matches.length !== 1) throw new Error('Child dispatch has no unique parent intent.');
    const lifecycle = matches[0]!.subagentProviderLifecycle!;
    const link = lifecycle.childSession!;
    const run = this.#services.runs?.get(this.sessionId, link.originRunId);
    const funding = fundingBudgetForRun(this.#state, link.fundingRunId);
    const reservation = funding?.reservations[link.delegatedReservationId];
    const reportReservations = Object.values(funding?.reservations ?? {}).filter(
      (candidate) =>
        candidate.invocationId === `model-invocation:after-turn:${lifecycle.childInvocationId}`,
    );
    const report = reportReservations[0];
    const liveRequiredRun = run?.status === 'running' || run?.status === 'waiting';
    const hasRequiredClaim = requiredBackgroundTaskIds(this.#state).includes(
      lifecycle.childInvocationId,
    );
    const deadlineMs = Date.parse(link.deadlineAt);
    if (
      link.terminalImport ||
      (link.disposition === 'required'
        ? !liveRequiredRun || !hasRequiredClaim
        : link.disposition !== 'after_turn' ||
          (!liveRequiredRun && run?.status !== 'completed') ||
          hasRequiredClaim ||
          funding?.deadlineAt !== link.deadlineAt ||
          reportReservations.length !== 1 ||
          report?.resourceKind !== 'model' ||
          report.state !== 'reserved' ||
          report.runId !== link.fundingRunId ||
          !Number.isFinite(deadlineMs) ||
          deadlineMs <= this.#clockMilliseconds()) ||
      reservation?.state !== 'reserved'
    )
      throw new Error('Child dispatch no longer has an eligible parent Run and funded intent.');
    const event: Extract<KernelEvent, { type: 'resource_budget.dispatch_started' }> = {
      type: 'resource_budget.dispatch_started',
      reservationId: link.delegatedReservationId,
    };
    const mutation: RuntimeChildDispatchAckMutation = {
      parentSessionId: this.sessionId,
      childThreadId,
      originRunId: link.originRunId,
      originToolCallId: link.originToolCallId,
      delegatedReservationId: link.delegatedReservationId,
    };
    const committed = this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'receipt_evidence' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== 1) throw new Error('Child dispatch acknowledgement was not durable.');
    return committed;
  }

  commitAgentMailboxCommand(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult {
    const accepted = assertAgentMailboxAcceptance(events, mutations);
    if (
      evidence.targetSessionId !== this.sessionId ||
      evidence.commandId !== accepted.event.messageId ||
      evidence.requestDigest !== accepted.mutation.requestDigest ||
      !this.#validRequiredLease(requiredEffectLease) ||
      !this.#services.leases.hasClaim(this.sessionId, requiredEffectLease.effectId)
    )
      throw new Error('Agent mailbox command receipt or Tool lease identity is invalid.');
    // The command gateway must look up the exact persisted receipt before
    // planning any reservation or invoking this commit-only method.
    const committed = this.#processEventBatch(
      events,
      { source: 'command', requiredEffectLease },
      evidence,
      undefined,
      mutations,
    );
    if (!committed.receipt)
      throw new Error('Agent mailbox command did not produce an applied receipt.');
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitCrossSessionQueueMailCommand(
    lease: StateRuntimeSessionEffectLease,
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'accept_queue' }>,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult {
    const state = this.#state;
    const tool = state.tools.calls[event.source.toolCallId];
    const response = state.transcript.messages.find(
      (message) => message.kind === 'assistant' && message.messageId === tool?.modelMessageId,
    );
    const invocations = Object.values(state.capabilities.invocations).filter(
      (invocation) =>
        invocation.toolCallId === event.source.toolCallId && invocation.status === 'running',
    );
    const invocation = invocations[0];
    const currentRun = this.getLifecycleProjection(state).currentRun;
    if (
      lease.effect.type !== 'run_tools' ||
      !this.isEffectLeaseCurrent(lease) ||
      !lease.effect.toolCallIds.includes(event.source.toolCallId) ||
      !this.#validRequiredLease(requiredEffectLease) ||
      !this.#services.leases.hasClaim(this.sessionId, requiredEffectLease.effectId) ||
      evidence.scopeSessionId !== this.sessionId ||
      evidence.targetSessionId !== this.sessionId ||
      evidence.commandId !== event.messageId ||
      evidence.commandId !== mutation.commandId ||
      evidence.requestDigest !== mutation.requestDigest ||
      event.mode !== 'queue_only' ||
      event.messageId !== mutation.messageId ||
      event.targetAgentId !== mutation.targetSessionId ||
      event.senderAgentId !== this.sessionId ||
      event.sequence !== mutation.sourceSequence ||
      event.source.runId !== mutation.sourceRunId ||
      event.source.turnId !== mutation.sourceTurnId ||
      event.source.modelInvocationId !== mutation.sourceModelInvocationId ||
      event.source.toolCallId !== mutation.sourceToolCallId ||
      event.source.effectAttemptId !== mutation.sourceEffectAttemptId ||
      event.source.sourceTaskId !== mutation.sourceTaskId ||
      event.source.turnId !== state.turn.turnId ||
      state.turn.status !== 'active' ||
      !currentRun ||
      currentRun.runId !== event.source.runId ||
      (currentRun.status !== 'running' && currentRun.status !== 'waiting') ||
      currentRun.activeTurnId !== state.turn.turnId ||
      !tool ||
      tool.name !== 'send_message' ||
      tool.status !== 'running' ||
      tool.createdAtTurnId !== state.turn.turnId ||
      !state.tools.active.includes(event.source.toolCallId) ||
      response?.kind !== 'assistant' ||
      response.turnId !== state.turn.turnId ||
      response.modelInvocationId !== event.source.modelInvocationId ||
      !response.toolCalls.some((call) => call.id === event.source.toolCallId) ||
      invocations.length !== 1 ||
      invocation?.capabilityId !== 'builtin:send_message' ||
      !invocation.attemptsStarted ||
      event.source.effectAttemptId !==
        `${invocation.invocationId}:attempt:${invocation.attemptsStarted}` ||
      (state.childSessionOrigin
        ? state.childSessionOrigin.terminal !== undefined ||
          state.childSessionOrigin.taskInputAdmitted !== true ||
          event.source.sourceTaskId !== state.childSessionOrigin.childInvocationId ||
          mutation.sourceGrantDigest !== state.childSessionOrigin.grantDigest ||
          !mutation.sourceGrantId
        : event.source.sourceTaskId !== undefined ||
          mutation.sourceGrantId !== undefined ||
          mutation.sourceGrantDigest !== undefined)
    )
      throw new Error('Cross-Session mail command is outside its exact active Tool attempt.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'command', requiredEffectLease },
      evidence,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    );
    if (!committed.receipt || committed.events.length !== 1)
      throw new Error('Cross-Session mail source command was not newly committed.');
    lease.expectedRevision = this.#state.revision;
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitCrossSessionFollowupCommand(
    lease: StateRuntimeSessionEffectLease,
    reservationEvent: Extract<KernelEvent, { type: 'resource_budget.reserved' }>,
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'accept_followup' }>,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult {
    const state = this.#state;
    const tool = state.tools.calls[event.source.toolCallId];
    const response = state.transcript.messages.find(
      (message) => message.kind === 'assistant' && message.messageId === tool?.modelMessageId,
    );
    const invocations = Object.values(state.capabilities.invocations).filter(
      (invocation) =>
        invocation.toolCallId === event.source.toolCallId && invocation.status === 'running',
    );
    const invocation = invocations[0];
    const currentRun = this.getLifecycleProjection(state).currentRun;
    const reservation = reservationEvent.reservation;
    if (
      lease.effect.type !== 'run_tools' ||
      !this.isEffectLeaseCurrent(lease) ||
      !lease.effect.toolCallIds.includes(event.source.toolCallId) ||
      !this.#validRequiredLease(requiredEffectLease) ||
      !this.#services.leases.hasClaim(this.sessionId, requiredEffectLease.effectId) ||
      evidence.scopeSessionId !== this.sessionId ||
      evidence.targetSessionId !== this.sessionId ||
      evidence.commandId !== event.messageId ||
      evidence.commandId !== mutation.commandId ||
      evidence.requestDigest !== mutation.requestDigest ||
      event.mode !== 'trigger_turn' ||
      event.messageId !== mutation.messageId ||
      event.targetAgentId !== mutation.targetSessionId ||
      event.senderAgentId !== this.sessionId ||
      event.sequence !== mutation.sourceSequence ||
      event.source.runId !== mutation.sourceRunId ||
      event.source.turnId !== mutation.sourceTurnId ||
      event.source.modelInvocationId !== mutation.sourceModelInvocationId ||
      event.source.toolCallId !== mutation.sourceToolCallId ||
      event.source.effectAttemptId !== mutation.sourceEffectAttemptId ||
      event.source.sourceTaskId !== undefined ||
      mutation.sourceTaskId !== undefined ||
      mutation.sourceGrantId !== undefined ||
      mutation.sourceGrantDigest !== undefined ||
      event.submissionId !== mutation.submissionId ||
      event.followupAdmissionDigest !== mutation.admission.digest ||
      JSON.stringify(event.followupAdmissionRef) !== JSON.stringify(mutation.admission.ref) ||
      reservationEvent.type !== 'resource_budget.reserved' ||
      reservation.resourceKind !== 'subagent' ||
      (reservation.state !== 'reserved' && reservation.state !== 'queued') ||
      reservation.runId !== event.source.runId ||
      reservation.invocationId !== mutation.submissionId ||
      reservation.parentReservationId !== undefined ||
      state.childSessionOrigin !== undefined ||
      event.source.turnId !== state.turn.turnId ||
      state.turn.status !== 'active' ||
      !currentRun ||
      currentRun.runId !== event.source.runId ||
      (currentRun.status !== 'running' && currentRun.status !== 'waiting') ||
      currentRun.activeTurnId !== state.turn.turnId ||
      !tool ||
      tool.name !== 'followup_task' ||
      tool.status !== 'running' ||
      tool.createdAtTurnId !== state.turn.turnId ||
      !state.tools.active.includes(event.source.toolCallId) ||
      response?.kind !== 'assistant' ||
      response.turnId !== state.turn.turnId ||
      response.modelInvocationId !== event.source.modelInvocationId ||
      !response.toolCalls.some((call) => call.id === event.source.toolCallId) ||
      invocations.length !== 1 ||
      invocation?.capabilityId !== 'builtin:followup_task' ||
      !invocation.attemptsStarted ||
      event.source.effectAttemptId !==
        `${invocation.invocationId}:attempt:${invocation.attemptsStarted}`
    )
      throw new Error('Cross-Session followup command is outside its exact active Tool attempt.');
    const committed = this.#processEventBatch(
      [reservationEvent, event],
      { source: 'command', requiredEffectLease },
      evidence,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    );
    if (!committed.receipt || committed.events.length !== 2)
      throw new Error('Cross-Session followup source command was not newly committed.');
    lease.expectedRevision = this.#state.revision;
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitCrossSessionInterruptCommand(
    lease: StateRuntimeSessionEffectLease,
    event: Extract<KernelEvent, { type: 'background_execution.stop_requested' }>,
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'request_interrupt' | 'request_queued_interrupt' }
    >,
    evidence: RuntimeCommandCommitEvidence,
    requiredEffectLease: RuntimeLeaseRequirement,
  ): StateRuntimeCommandCommitResult {
    const state = this.#state;
    const tool = state.tools.calls[mutation.sourceToolCallId];
    const response = state.transcript.messages.find(
      (message) => message.kind === 'assistant' && message.messageId === tool?.modelMessageId,
    );
    const invocations = Object.values(state.capabilities.invocations).filter(
      (invocation) =>
        invocation.toolCallId === mutation.sourceToolCallId && invocation.status === 'running',
    );
    const invocation = invocations[0];
    const currentRun = this.getLifecycleProjection(state).currentRun;
    if (
      lease.effect.type !== 'run_tools' ||
      !this.isEffectLeaseCurrent(lease) ||
      !lease.effect.toolCallIds.includes(mutation.sourceToolCallId) ||
      !this.#validRequiredLease(requiredEffectLease) ||
      !this.#services.leases.hasClaim(this.sessionId, requiredEffectLease.effectId) ||
      evidence.scopeSessionId !== this.sessionId ||
      evidence.targetSessionId !== this.sessionId ||
      evidence.commandId !== mutation.commandId ||
      evidence.requestDigest !== mutation.requestDigest ||
      event.commandId !== mutation.commandId ||
      event.executionId !== mutation.targetTaskId ||
      event.executionKind !== 'subagent' ||
      event.ownerGeneration !==
        (mutation.kind === 'request_queued_interrupt'
          ? `accepted:${mutation.queuedIntentEventId}`
          : `child:${mutation.targetOwnerGeneration}`) ||
      (mutation.kind === 'request_interrupt' &&
        (!Number.isSafeInteger(mutation.targetOwnerGeneration) ||
          mutation.targetOwnerGeneration < 1)) ||
      !Number.isSafeInteger(mutation.targetRevision) ||
      mutation.targetRevision < (mutation.kind === 'request_queued_interrupt' ? 0 : 1) ||
      state.turn.status !== 'active' ||
      state.turn.turnId !== mutation.sourceTurnId ||
      !currentRun ||
      currentRun.runId !== mutation.sourceRunId ||
      (currentRun.status !== 'running' && currentRun.status !== 'waiting') ||
      currentRun.activeTurnId !== mutation.sourceTurnId ||
      !tool ||
      tool.name !== 'interrupt_agent' ||
      tool.status !== 'running' ||
      tool.createdAtTurnId !== mutation.sourceTurnId ||
      typeof tool.args !== 'object' ||
      tool.args === null ||
      Array.isArray(tool.args) ||
      (tool.args as Record<string, unknown>).agent_id !== mutation.targetSessionId ||
      !state.tools.active.includes(mutation.sourceToolCallId) ||
      response?.kind !== 'assistant' ||
      response.turnId !== mutation.sourceTurnId ||
      response.modelInvocationId !== mutation.sourceModelInvocationId ||
      !response.toolCalls.some(
        (call) =>
          call.id === mutation.sourceToolCallId &&
          typeof call.args === 'object' &&
          call.args !== null &&
          !Array.isArray(call.args) &&
          (call.args as Record<string, unknown>).agent_id === mutation.targetSessionId,
      ) ||
      invocations.length !== 1 ||
      invocation?.capabilityId !== 'builtin:interrupt_agent' ||
      !invocation.attemptsStarted ||
      mutation.sourceEffectAttemptId !==
        `${invocation.invocationId}:attempt:${invocation.attemptsStarted}` ||
      (state.childSessionOrigin
        ? state.childSessionOrigin.terminal !== undefined ||
          state.childSessionOrigin.taskInputAdmitted !== true ||
          mutation.sourceTaskId !== state.childSessionOrigin.childInvocationId ||
          mutation.sourceGrantDigest !== state.childSessionOrigin.grantDigest
        : mutation.sourceTaskId !== undefined || mutation.sourceGrantDigest !== undefined)
    )
      throw new Error('Cross-Session interrupt is outside its exact active Tool attempt.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'command', requiredEffectLease },
      evidence,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    );
    if (!committed.receipt || committed.events.length !== 1)
      throw new Error('Cross-Session interrupt source receipt was not newly committed.');
    lease.expectedRevision = this.#state.revision;
    return Object.freeze({ receipt: committed.receipt, events: committed.events });
  }

  commitCrossSessionInterruptTarget(
    event: Extract<
      KernelEvent,
      {
        type:
          | 'background_execution.stop_requested'
          | 'background_execution.stop_settled'
          | 'background_execution.stop_unknown';
      }
    >,
    mutation: Extract<
      RuntimeCrossSessionAgentMailMutation,
      { kind: 'ack_interrupt' | 'settle_interrupt' }
    >,
  ): readonly KernelEvent[] {
    if (
      event.commandId !== mutation.commandId ||
      (mutation.kind === 'ack_interrupt' &&
        event.type !== 'background_execution.stop_requested' &&
        !(
          event.type === 'background_execution.stop_unknown' &&
          event.reason === 'target_already_idle'
        )) ||
      (mutation.kind === 'settle_interrupt' &&
        event.type !== 'background_execution.stop_settled' &&
        event.type !== 'background_execution.stop_unknown')
    )
      throw new Error('Cross-Session interrupt target Event kind is invalid.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== 1)
      throw new Error('Cross-Session interrupt target decision was not new.');
    return committed;
  }

  commitCrossSessionQueuedInterruptSettlement(
    event: Extract<
      KernelEvent,
      { type: 'background_execution.stop_settled' | 'background_execution.stop_unknown' }
    >,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'settle_queued_interrupt' }>,
  ): readonly KernelEvent[] {
    if (event.commandId !== mutation.commandId)
      throw new Error('Queued interrupt settlement command identity is invalid.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== 1)
      throw new Error('Queued interrupt settlement was not newly committed.');
    return committed;
  }

  commitCrossSessionQueueMailReceive(
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_queue' }>,
  ): readonly KernelEvent[] {
    if (
      (event.mode !== 'queue_only' && event.mode !== 'reply') ||
      event.targetAgentId !== this.sessionId ||
      event.senderAgentId !== mutation.sourceSessionId ||
      event.messageId !== mutation.messageId
    )
      throw new Error('Cross-Session mail target receipt identity is invalid.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== 1) throw new Error('Cross-Session mail target receipt was not new.');
    return committed;
  }

  commitCrossSessionFollowupReceive(
    event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_followup' }>,
  ): readonly KernelEvent[] {
    if (
      event.mode !== 'trigger_turn' ||
      event.targetAgentId !== this.sessionId ||
      event.senderAgentId !== mutation.sourceSessionId ||
      event.messageId !== mutation.messageId ||
      event.submissionId !== mutation.submissionId ||
      event.followupAdmissionRef?.kind !== 'agent_followup_admission' ||
      event.followupAdmissionDigest !== event.followupAdmissionRef.integrityIdentifier ||
      event.bodyRef.kind !== 'agent_mail' ||
      event.bodyDigest !== event.bodyRef.integrityIdentifier
    )
      throw new Error('Cross-Session followup target receipt identity is invalid.');
    const committed = this.#processEventBatch(
      [event],
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== 1)
      throw new Error('Cross-Session followup target receipt was not new.');
    return committed;
  }

  commitCrossSessionQueueMailModelInput(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'prepare_queue_input' }>,
  ): readonly KernelEvent[] {
    const model = events.filter(
      (event): event is Extract<KernelEvent, { type: 'model.invocation_prepared' }> =>
        event.type === 'model.invocation_prepared',
    );
    const mail = events.filter(
      (event): event is Extract<KernelEvent, { type: 'agent.mail_input_prepared' }> =>
        event.type === 'agent.mail_input_prepared',
    );
    const currentRun = this.getLifecycleProjection().currentRun;
    if (
      lease.effect.type !== 'call_model' ||
      !this.isEffectLeaseCurrent(lease) ||
      this.#state.turn.status !== 'active' ||
      !currentRun ||
      currentRun.runId !== mutation.currentRunId ||
      (currentRun.status !== 'running' && currentRun.status !== 'waiting') ||
      currentRun.activeTurnId !== this.#state.turn.turnId ||
      model.length !== 1 ||
      mail.length !== 1 ||
      model[0]?.invocationId !== mutation.modelInvocationId ||
      mail[0]?.targetAgentId !== this.sessionId ||
      mail[0]?.invocationId !== mutation.modelInvocationId ||
      mail[0]?.modelAdmissionId !== mutation.modelAdmissionId ||
      mail[0]?.fromSequence !== mutation.fromSequence ||
      mail[0]?.throughSequence !== mutation.throughSequence ||
      JSON.stringify(mail[0]?.messageIds) !== JSON.stringify(mutation.messageIds)
    )
      throw new Error('Cross-Session mail model admission identity is invalid.');
    const committed = this.#processEventBatch(
      events,
      { source: 'host_fact', acknowledgement: 'decision' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== events.length)
      throw new Error('Cross-Session mail model admission was not newly committed.');
    lease.expectedRevision = this.#state.revision;
    return committed;
  }

  commitAgentMailboxDerived(
    events: readonly KernelEvent[],
    mutations: readonly RuntimeAgentMailboxMutation[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): readonly KernelEvent[] {
    const accepted = assertAgentMailboxAcceptance(events, mutations);
    if (accepted.event.mode !== 'reply')
      throw new Error('Only a terminal-derived Agent reply may omit a command receipt.');
    return this.#processEventBatch(
      events,
      {
        source: 'receipt',
        acknowledgement: 'receipt_evidence',
        ...(requiredEffectLease ? { requiredEffectLease } : {}),
      },
      undefined,
      undefined,
      mutations,
    ).events;
  }

  commitCommandSnapshot(
    evidence: RuntimeCommandCommitEvidence,
    sessionModelRoute?: RuntimeSessionModelRoute,
  ): RuntimeStoredCommandReceipt {
    if (evidence.targetSessionId !== this.sessionId) {
      throw new Error('Runtime command receipt target does not match State session.');
    }
    assertStateRuntimeSessionState(this.#state);
    const receipt = createRuntimeStoredCommandReceipt(evidence, this.#state.revision);
    const input: RuntimeTransactionInput<KernelEvent, AgentState> = {
      sessionId: this.sessionId,
      events: [],
      snapshot: this.#state,
      metadata: [],
      expectedRestoreBoundary: this.#restoreBoundary(),
      commandReceipt: receipt,
      ...(sessionModelRoute === undefined ? {} : { sessionModelRoute }),
    };
    this.#lastAppliedEvents = [];
    this.#lastProcessedEventId = undefined;
    this.#services.transactions.commitCommandDecision(input);
    return receipt;
  }

  #processEventBatch(
    events: readonly KernelEvent[],
    options: StateRuntimeProcessEventBatchOptions,
    commandEvidence?: RuntimeCommandCommitEvidence,
    sessionModelRoute?: RuntimeSessionModelRoute,
    agentMailboxMutations?: readonly RuntimeAgentMailboxMutation[],
    childSessionIntent?: RuntimeChildSessionIntentMutation,
    childCreationFailure?: RuntimeChildCreationFailureMutation,
    childBudgetActivation?: RuntimeChildBudgetActivationMutation,
    childDispatchAck?: RuntimeChildDispatchAckMutation,
    childTerminalImport?: RuntimeChildTerminalImportMutation,
    crossSessionAgentMailMutation?: RuntimeCrossSessionAgentMailMutation,
    sealCompletedChildCheckpoint?: true,
    followupRunStart?: RuntimeFollowupRunStartMutation,
  ): { readonly events: readonly KernelEvent[]; readonly receipt?: RuntimeStoredCommandReceipt } {
    this.#lastProcessedEventId = undefined;
    if (options.requiredEffectLease && !this.#validRequiredLease(options.requiredEffectLease))
      throw new Error('Runtime effect lease does not match the State session.');
    if (events.length === 0) {
      this.#lastAppliedEvents = [];
      return { events: [] };
    }
    const preparedEvents = this.#preprocessEvents(events);
    if (preparedEvents.length === 0) {
      this.#lastAppliedEvents = [];
      return { events: [] };
    }
    if (
      preparedEvents.some(
        (event) =>
          event.type === 'agent.mail_accepted' || event.type === 'agent.mail_input_prepared',
      ) &&
      ((agentMailboxMutations === undefined && crossSessionAgentMailMutation === undefined) ||
        (agentMailboxMutations !== undefined && crossSessionAgentMailMutation !== undefined))
    )
      throw new Error('Agent mail facts require exactly one private Store mutation authority.');
    const previousState = this.#state;
    assertStateRuntimeSessionState(previousState);
    if (agentMailboxMutations?.some((mutation) => mutation.kind === 'accept_mail')) {
      assertAgentMailboxFunding(
        assertAgentMailboxAcceptance(preparedEvents, agentMailboxMutations),
        preparedEvents,
        previousState,
        this.#clockMilliseconds(),
      );
    }
    const facts = this.#decisionFacts(preparedEvents, previousState, options.occurredAt);
    const decision = decide(
      previousState,
      {
        source: options.source ?? 'host_fact',
        sessionId: this.sessionId,
        expectedRevision: previousState.revision,
        events: preparedEvents,
        ...(options.causationId ? { causationId: options.causationId } : {}),
      },
      facts,
    );
    if (decision.status === 'idempotent_replay') {
      this.#lastAppliedEvents = [];
      this.#lastProcessedEventId = this.#eventId(
        preparedEvents[0]!,
        previousState,
        facts.eventFacts[0]!.occurredAt,
      );
      return { events: [] };
    }
    if (decision.status === 'conflict') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State revision conflict at ${decision.currentRevision}.`);
    }
    if (decision.status === 'rejected') {
      this.#lastAppliedEvents = [];
      throw new Error(`Runtime State transition rejected: ${decision.code}.`);
    }
    if (agentMailboxMutations)
      assertAgentMailboxFactMutations(decision.events, agentMailboxMutations);
    assertAgentStateInvariants(decision.nextState);
    const childTerminalCheckpointMutation = sealCompletedChildCheckpoint
      ? childTerminalCheckpointForState(
          decision.nextState,
          this.getLifecycleProjection(previousState).currentRun?.runId ?? '',
          preparedEvents[0]?.type === 'agent.followup_turn_settled'
            ? previousState.activeFollowupTurn
            : undefined,
        )
      : undefined;
    const metadata = decision.envelopes.map(
      (envelope): RuntimeEventMetadata => ({
        eventId: envelope.eventId,
        revision: envelope.revision,
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
        occurredAt: envelope.occurredAt,
      }),
    );
    const runCommit = this.#runCommitForDecision(
      previousState,
      decision.nextState,
      decision.events,
      metadata,
      commandEvidence,
      followupRunStart,
    );
    const receiptEvidence =
      commandEvidence && runCommit?.resourceResult
        ? Object.freeze({ ...commandEvidence, resourceResult: runCommit.resourceResult })
        : commandEvidence;
    const receipt = receiptEvidence
      ? createRuntimeStoredCommandReceipt(receiptEvidence, decision.nextState.revision)
      : undefined;
    const input: RuntimeTransactionInput<KernelEvent, AgentState> = {
      sessionId: this.sessionId,
      events: decision.events,
      snapshot: decision.nextState,
      metadata,
      expectedRestoreBoundary: this.#restoreBoundary(),
      ...(receipt ? { commandReceipt: receipt } : {}),
      ...(runCommit ? { runMutation: runCommit.mutation } : {}),
      ...(sessionModelRoute === undefined ? {} : { sessionModelRoute }),
      ...(agentMailboxMutations ? { agentMailboxMutations } : {}),
      ...(childSessionIntent ? { childSessionIntent } : {}),
      ...(childCreationFailure ? { childCreationFailure } : {}),
      ...(childBudgetActivation ? { childBudgetActivation } : {}),
      ...(childDispatchAck ? { childDispatchAck } : {}),
      ...(childTerminalImport ? { childTerminalImport } : {}),
      ...(childTerminalCheckpointMutation ? { childTerminalCheckpointMutation } : {}),
      ...(followupRunStart ? { followupRunStart } : {}),
      ...(crossSessionAgentMailMutation ? { crossSessionAgentMailMutation } : {}),
      ...(receipt && options.requiredEffectLease
        ? {
            requiredEffectLease: {
              effectId: options.requiredEffectLease.effectId,
              ownerId: options.requiredEffectLease.ownerId,
              observedAtMs: this.#clockMilliseconds(),
            },
          }
        : {}),
    };
    try {
      if (
        receipt &&
        (crossSessionAgentMailMutation?.kind === 'accept_queue' ||
          crossSessionAgentMailMutation?.kind === 'accept_followup' ||
          crossSessionAgentMailMutation?.kind === 'request_interrupt' ||
          crossSessionAgentMailMutation?.kind === 'request_queued_interrupt')
      ) {
        if (
          !options.requiredEffectLease ||
          !this.#services.transactions.commitCommandReceiptEvidence
        )
          throw new Error('Cross-Session Tool receipt requires a leased receipt transaction.');
        this.#services.transactions.commitCommandReceiptEvidence(
          input,
          options.requiredEffectLease,
        );
      } else if (receipt) this.#services.transactions.commitCommandDecision(input);
      else {
        this.#services.transactions.commit(
          options.acknowledgement ?? 'decision',
          input,
          options.requiredEffectLease,
        );
      }
    } catch (error) {
      this.#lastAppliedEvents = [];
      throw error;
    }
    // The durable transaction is the publication boundary. Never expose a
    // speculative reducer result to an executor or caller before this point.
    this.#state = decision.nextState;
    for (const wake of this.#revisionWaiters) wake();
    this.#revisionWaiters.clear();
    if (runCommit?.mutation.type === 'insert') this.#currentRunId = runCommit.mutation.run.runId;
    this.#lastAppliedEvents = [...decision.events];
    this.#lastProcessedEventId = decision.envelopes[0]?.eventId;
    const completedTurn = decision.events.find(
      (event): event is Extract<KernelEvent, { readonly type: 'turn.completed' }> =>
        event.type === 'turn.completed',
    );
    if (completedTurn && this.#onNamedTurnSnapshot) {
      const eventPosition = this.#services.sessions.getLastEventPosition(this.sessionId);
      this.#onNamedTurnSnapshot({
        sessionId: this.sessionId,
        turnId: completedTurn.turnId,
        state: this.#state,
        eventPosition,
      });
    }
    return { events: this.#lastAppliedEvents, ...(receipt ? { receipt } : {}) };
  }

  commitApprovalBatch(
    event: Extract<KernelEvent, { readonly type: 'approval.batch_released' }>,
    expectedRevision: number,
  ): StateRuntimeProcessEventResult {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      event.sessionRevision !== expectedRevision ||
      this.#state.revision !== expectedRevision
    ) {
      throw new Error(`Runtime approval batch revision conflict at ${this.#state.revision}.`);
    }
    return this.processEvent(event);
  }

  getLastAppliedEvents(): readonly KernelEvent[] {
    return this.#lastAppliedEvents;
  }

  selectPendingEffects(
    state: Readonly<AgentState> = this.#state,
    facts?: SchedulerFacts,
  ): readonly RuntimeEffect[] {
    assertStateRuntimeSessionState(state);
    return selectPendingEffects(state, facts);
  }

  acquireRunner(): string | null {
    if (this.#runnerId) return null;
    const runnerId = this.#nextId('state_runner');
    this.#runnerId = runnerId;
    return runnerId;
  }

  releaseRunner(runnerId: string): void {
    if (this.#runnerId === runnerId) this.#runnerId = null;
  }

  beginEffect(effect: RuntimeEffect): StateRuntimeSessionEffectLease {
    assertStateRuntimeSessionState(this.#state);
    const effectId = this.#nextId('state_effect');
    const lease: StateRuntimeSessionEffectLease = {
      effectId,
      turnId: this.#state.turn.turnId,
      effect,
      expectedRevision: this.#state.revision,
    };
    this.#effectLeases.set(effectId, lease);
    return lease;
  }

  isEffectLeaseCurrent(lease: Readonly<StateRuntimeSessionEffectLease>): boolean {
    const owned = this.#effectLeases.get(lease.effectId);
    return Boolean(
      owned === lease &&
        lease.expectedRevision === this.#state.revision &&
        lease.turnId === this.#state.turn.turnId &&
        this.#effectLeases.has(lease.effectId),
    );
  }

  isEffectEventCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    event: KernelEvent,
  ): boolean {
    if (this.isEffectLeaseCurrent(lease)) return true;
    return this.#concurrentEventsCurrent(lease, [event]);
  }

  applyResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    if (events.length === 0) return false;
    if (
      hasLateTerminalEventForCancelledTool(this.#state, lease, events) ||
      this.#isLateEffectResult?.(lease, events, this.#state)
    ) {
      return false;
    }
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    const current = this.isEffectLeaseCurrent(lease);
    if (!current && !this.#concurrentEventsCurrent(lease, events)) return false;
    if (lease.effect.type === 'run_tools') {
      assertCapabilityToolTerminalBatch(this.#state, lease, events);
    }
    if (lease.effect.type === 'run_tools' && this.#toolTerminalBatchValidator) {
      const accepted = this.#toolTerminalBatchValidator(lease.effect, events, this.#state);
      if (accepted === false) throw new Error('Runtime Tool terminal batch was rejected.');
    }
    const applied = this.processEventBatch(events, {
      acknowledgement: 'receipt_evidence',
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    if (!this.isEffectEventCurrent(lease, event)) return false;
    const applied = this.processEventBatch([event], {
      acknowledgement: 'receipt_evidence',
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEffectResult(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    return this.applyResult(lease, events, requiredEffectLease);
  }

  commitBackgroundChildAcceptance(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    requiredEffectLease: RuntimeLeaseRequirement,
    sealedGrant: RuntimeSealedChildGrantPayload,
  ): boolean {
    if (lease.effect.type !== 'run_tools')
      throw new Error('Child Session acceptance requires a Tool effect lease.');
    const intents = events.filter(
      (event): event is Extract<KernelEvent, { type: 'subagent.child_session_intended' }> =>
        event.type === 'subagent.child_session_intended',
    );
    if (intents.length !== 1)
      throw new Error('Child Session acceptance requires one creation intent.');
    const intent = intents[0]!;
    // A sibling in the same run_tools batch may have committed its own child
    // receipt while this Tool was still executing. The stale revision is safe
    // only when the original lease remains owned and this exact Tool attempt
    // is still running in the same Turn. The full receipt/intent validator
    // below still runs against the newest State and one atomic Store commit.
    const call = this.#state.tools.calls[intent.originToolCallId];
    const invocation = this.#state.capabilities.invocations[intent.parentInvocationId];
    const concurrentSiblingCurrent =
      this.#effectLeases.get(lease.effectId) === lease &&
      lease.turnId === this.#state.turn.turnId &&
      this.#state.turn.status === 'active' &&
      lease.effect.toolCallIds.includes(intent.originToolCallId) &&
      call?.name === 'task' &&
      call.status === 'running' &&
      this.#state.tools.active.includes(intent.originToolCallId) &&
      invocation?.toolCallId === intent.originToolCallId &&
      invocation.status === 'running' &&
      invocation.subagentProviderLifecycle?.childSession === undefined;
    if (!this.isEffectLeaseCurrent(lease) && !concurrentSiblingCurrent)
      throw new Error('Child Session acceptance requires the current Tool effect lease.');
    let sealedValue: unknown;
    try {
      sealedValue = JSON.parse(sealedGrant.sealedGrantJson) as unknown;
    } catch {
      throw new Error('Sealed child grant JSON is invalid.');
    }
    const exactSealed = sealChildGrantPayload(sealedValue);
    const grantPayload = sealedValue as Record<string, unknown>;
    const taskRef = grantPayload.taskArtifact;
    const ceiling = grantPayload.capabilityCeiling;
    const authorization = grantPayload.authorization;
    if (
      exactSealed.sealedGrantJson !== sealedGrant.sealedGrantJson ||
      exactSealed.sealedGrantByteLength !== sealedGrant.sealedGrantByteLength ||
      exactSealed.sealedGrantDigest !== sealedGrant.sealedGrantDigest ||
      exactSealed.sealedGrantDigest !== intent.grantDigest ||
      grantPayload.purpose !== 'start' ||
      grantPayload.parentInvocationId !== intent.parentInvocationId ||
      grantPayload.parentToolCallId !== intent.originToolCallId ||
      grantPayload.parentAttempt !== intent.attempt ||
      grantPayload.childInvocationId !== intent.childInvocationId ||
      grantPayload.role !== intent.role ||
      grantPayload.taskDigest !== intent.taskTextDigest ||
      !sameChildTaskArtifactRef(taskRef, intent.taskArtifactRef) ||
      !ceiling ||
      typeof ceiling !== 'object' ||
      !Array.isArray((ceiling as Record<string, unknown>).allowedTools) ||
      !Array.isArray((ceiling as Record<string, unknown>).bindingIds) ||
      !authorization ||
      typeof authorization !== 'object' ||
      !grantPayload.executionBoundary ||
      !grantPayload.resource ||
      !grantPayload.model ||
      typeof grantPayload.grantId !== 'string' ||
      !grantPayload.grantId ||
      typeof grantPayload.seal !== 'string' ||
      !Number.isSafeInteger(grantPayload.expiresAtMs)
    )
      throw new Error('Sealed child grant does not match its parent Tool authority.');
    const finished = events.filter(
      (event): event is Extract<KernelEvent, { type: 'tool.finished' }> =>
        event.type === 'tool.finished' && event.toolCallId === intent.originToolCallId,
    );
    const dispatch = events.filter(
      (
        event,
      ): event is Extract<KernelEvent, { type: 'capability.subagent_dispatch_intent_recorded' }> =>
        event.type === 'capability.subagent_dispatch_intent_recorded' &&
        event.invocationId === intent.parentInvocationId,
    );
    const tool = finished[0];
    const grant = dispatch[0];
    const starts = events.filter(
      (event): event is Extract<KernelEvent, { type: 'subagent.started' }> =>
        event.type === 'subagent.started' && event.subagent.id === intent.childInvocationId,
    );
    const started = starts[0];
    const callArgs = this.#state.tools.calls[intent.originToolCallId]?.args;
    const taskArgs = callArgs as Readonly<Record<string, unknown>> | undefined;
    const delegated = events.filter(
      (event): event is Extract<KernelEvent, { type: 'resource_budget.reserved' }> =>
        event.type === 'resource_budget.reserved' &&
        event.reservation.reservationId === intent.delegatedReservationId,
    );
    const allReservations = events.filter(
      (event): event is Extract<KernelEvent, { type: 'resource_budget.reserved' }> =>
        event.type === 'resource_budget.reserved',
    );
    const reports = allReservations.filter(
      (event) =>
        event.reservation.invocationId ===
        `model-invocation:after-turn:${intent.childInvocationId}`,
    );
    const report = reports[0]?.reservation;
    const allotment = delegated[0]?.reservation;
    const funding = fundingBudgetForRun(this.#state, intent.fundingRunId);
    const transient =
      funding &&
      Object.values(funding.reservations).find(
        (reservation) =>
          reservation.resourceKind === 'subagent' &&
          reservation.invocationId === `tool:${intent.originToolCallId}`,
      );
    const transientSettlement = events.filter(
      (event): event is Extract<KernelEvent, { type: 'resource_budget.reconciled' }> =>
        event.type === 'resource_budget.reconciled' &&
        event.reservationId === transient?.reservationId,
    );
    const upperBoundDigest = allotment
      ? childDelegatedUpperBoundDigest(allotment.executableUpperBound)
      : undefined;
    if (
      intent.parentSessionId !== this.sessionId ||
      (intent.disposition !== 'required' && intent.disposition !== 'after_turn') ||
      requiredEffectLease.effectId !== childSessionAcceptanceEffectId(intent.childThreadId) ||
      !this.#validRequiredLease(requiredEffectLease) ||
      intent.childThreadId !==
        childThreadIdForToolAttempt({
          parentSessionId: this.sessionId,
          parentInvocationId: intent.parentInvocationId,
          parentToolCallId: intent.originToolCallId,
          attempt: intent.attempt,
        }) ||
      finished.length !== 1 ||
      dispatch.length !== 1 ||
      starts.length !== 1 ||
      delegated.length !== 1 ||
      allReservations.length !== (intent.disposition === 'after_turn' ? 2 : 1) ||
      reports.length !== (intent.disposition === 'after_turn' ? 1 : 0) ||
      transientSettlement.length !== 1 ||
      !tool ||
      !grant ||
      !started ||
      started.subagent.role !== intent.role ||
      started.subagent.parentToolCallId !== intent.originToolCallId ||
      taskArgs?.subagent_type !== intent.role ||
      taskArgs?.background !== true ||
      (intent.disposition === 'after_turn'
        ? taskArgs.result_disposition !== 'after_turn'
        : taskArgs.result_disposition !== undefined &&
          taskArgs.result_disposition !== 'required') ||
      !allotment ||
      !funding ||
      transient?.state !== 'dispatch_started' ||
      transientSettlement[0]?.actual.counters.toolInvocations !== 1 ||
      transientSettlement[0]?.actual.gauges.activeSubagents !== 0 ||
      funding.deadlineAt !== intent.deadlineAt ||
      allotment.runId !== intent.fundingRunId ||
      allotment.resourceKind !== 'subagent' ||
      (allotment.state !== 'reserved' && allotment.state !== 'queued') ||
      allotment.invocationId !== `child-allotment:${intent.childThreadId}` ||
      allotment.executableUpperBound.gauges.activeSubagents !== 1 ||
      (intent.role === 'code' && allotment.executableUpperBound.gauges.activeWriters < 1) ||
      (intent.role !== 'code' && allotment.executableUpperBound.gauges.activeWriters !== 0) ||
      upperBoundDigest !== intent.delegatedUpperBoundDigest ||
      (intent.disposition === 'after_turn' &&
        (!report ||
          report.runId !== intent.fundingRunId ||
          report.resourceKind !== 'model' ||
          report.state !== 'reserved' ||
          report.parentReservationId !== undefined ||
          report.executableUpperBound.source !== 'versioned_upper_bound' ||
          report.executableUpperBound.counters.modelRequests !== 1 ||
          report.executableUpperBound.counters.inputTokens < 1 ||
          report.executableUpperBound.counters.outputTokens < 1 ||
          report.executableUpperBound.gauges.activeSubagents !== 0 ||
          report.executableUpperBound.gauges.activeWriters !== 0)) ||
      tool.name !== 'task' ||
      tool.result.ok !== true ||
      tool.result.resultMeta?.taskId !== intent.childInvocationId ||
      tool.result.resultMeta?.taskStatus !== 'running' ||
      tool.result.resultMeta?.taskDisposition !== intent.disposition ||
      grant.childInvocationId !== intent.childInvocationId ||
      grant.attempt !== intent.attempt ||
      grant.taskArtifact.integrityIdentifier !== intent.taskArtifactDigest ||
      !sameChildTaskArtifactRef(grant.taskArtifact, intent.taskArtifactRef) ||
      !(
        events.indexOf(transientSettlement[0]!) < events.indexOf(delegated[0]!) &&
        (report
          ? events.indexOf(delegated[0]!) < events.indexOf(reports[0]!) &&
            events.indexOf(reports[0]!) < events.indexOf(grant)
          : events.indexOf(delegated[0]!) < events.indexOf(grant)) &&
        events.indexOf(grant) < events.indexOf(intent) &&
        events.indexOf(intent) < events.indexOf(tool)
      )
    )
      throw new Error('Child Session intent and Task receipt are not exact.');
    const projected = events.reduce((state, event) => {
      const occurredAt = this.#eventTimestamp();
      return reduceAgentState(
        state,
        finalizeAgentEvent(normalizeAgentEvent(event, state, occurredAt), occurredAt),
      );
    }, this.#state);
    const hasRequiredClaim = requiredBackgroundTaskIds(projected).includes(
      intent.childInvocationId,
    );
    if (hasRequiredClaim !== (intent.disposition === 'required'))
      throw new Error('Child Session acceptance has an inconsistent required Task claim.');
    const projectedFunding = fundingBudgetForRun(projected, intent.fundingRunId);
    if (
      !projectedFunding ||
      projectedFunding.reservations[intent.delegatedReservationId]?.state !== allotment.state ||
      (report &&
        JSON.stringify(projectedFunding.reservations[report.reservationId]) !==
          JSON.stringify(report))
    )
      throw new Error('Child Session acceptance has no exact projected funding reservations.');
    assertCapabilityToolTerminalBatch(this.#state, lease, events);
    if (this.#toolTerminalBatchValidator?.(lease.effect, events, this.#state) === false)
      throw new Error('Child Session Tool terminal batch was rejected.');
    const mutation: RuntimeChildSessionIntentMutation = {
      childThreadId: intent.childThreadId,
      parentSessionId: intent.parentSessionId,
      parentInvocationId: intent.parentInvocationId,
      originRunId: intent.originRunId,
      originTurnId: intent.originTurnId,
      originToolCallId: intent.originToolCallId,
      attempt: intent.attempt,
      childInvocationId: intent.childInvocationId,
      grantDigest: intent.grantDigest,
      sealedGrantJson: sealedGrant.sealedGrantJson,
      sealedGrantByteLength: sealedGrant.sealedGrantByteLength,
      sealedGrantDigest: sealedGrant.sealedGrantDigest,
      taskArtifactRef: intent.taskArtifactRef,
      taskArtifactDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      disposition: intent.disposition,
      role: intent.role,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
      deadlineAt: intent.deadlineAt,
    };
    const committed = this.#processEventBatch(
      events,
      {
        acknowledgement: 'receipt_evidence',
        source: 'receipt',
        requiredEffectLease,
      },
      undefined,
      undefined,
      undefined,
      mutation,
    ).events;
    if (committed.length !== events.length)
      throw new Error('Child Session acceptance did not commit one exact Tool receipt.');
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEffectEvents(
    lease: StateRuntimeSessionEffectLease,
    events: readonly KernelEvent[],
    acknowledgement: StateRuntimeEffectPersistenceAcknowledgement,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    if (events.length === 0) return false;
    const current = this.isEffectLeaseCurrent(lease);
    if (
      !current &&
      (acknowledgement === 'attempt_start' || !this.#concurrentEventsCurrent(lease, events))
    ) {
      return false;
    }
    if (requiredEffectLease && !this.#validRequiredLease(requiredEffectLease)) return false;
    if (acknowledgement !== 'attempt_start' && lease.effect.type === 'run_tools') {
      if (
        hasLateTerminalEventForCancelledTool(this.#state, lease, events) ||
        this.#isLateEffectResult?.(lease, events, this.#state)
      ) {
        return false;
      }
      assertCapabilityToolTerminalBatch(this.#state, lease, events);
      if (this.#toolTerminalBatchValidator) {
        const accepted = this.#toolTerminalBatchValidator(lease.effect, events, this.#state);
        if (accepted === false) throw new Error('Runtime Tool terminal batch was rejected.');
      }
    }
    const applied = this.processEventBatch(events, {
      acknowledgement,
      ...(requiredEffectLease ? { requiredEffectLease } : {}),
      source: 'receipt',
    });
    if (applied.length === 0) return false;
    lease.expectedRevision = this.#state.revision;
    return true;
  }

  applyEffectEvent(
    lease: StateRuntimeSessionEffectLease,
    event: KernelEvent,
    requiredEffectLease?: RuntimeLeaseRequirement,
  ): boolean {
    return this.applyEvent(lease, event, requiredEffectLease);
  }

  applyLateResourceReconciliation(events: readonly KernelEvent[]): boolean {
    if (
      events.length === 0 ||
      this.#state.resourceBudget.status !== 'active' ||
      events.some((event) => event.type !== 'resource_budget.reconciled')
    ) {
      return false;
    }
    for (const event of events) {
      if (event.type !== 'resource_budget.reconciled') return false;
      const reservation = this.#state.resourceBudget.reservations[event.reservationId];
      if (
        !reservation ||
        (reservation.state !== 'dispatch_started' && reservation.state !== 'unknown')
      ) {
        return false;
      }
    }
    const applied = this.processEventBatch(events, {
      acknowledgement: 'receipt_evidence',
      source: 'receipt',
    });
    return applied.length === events.length;
  }

  releaseEffect(lease: Readonly<StateRuntimeSessionEffectLease>): void {
    const owned = this.#effectLeases.get(lease.effectId);
    if (owned !== lease) return;
    this.#effectLeases.delete(lease.effectId);
  }

  #preprocessEvents(events: readonly KernelEvent[]): readonly KernelEvent[] {
    const prepared = this.#eventBatchPreprocessor
      ? this.#eventBatchPreprocessor(events, this.#state)
      : events;
    const copied = [...prepared];
    const requirements = suspendedCapabilityTerminalRequirements(this.#state, copied);
    const finishedAtByInvocationId: Record<string, string> = {};
    for (const requirement of requirements) {
      finishedAtByInvocationId[requirement.invocationId] = this.#eventTimestamp();
    }
    const withSuspendedTerminals = attachSuspendedCapabilityTerminals(
      this.#state,
      copied,
      finishedAtByInvocationId,
    );
    const accepted = this.#eventBatchAdmissionValidator?.(withSuspendedTerminals, this.#state);
    if (accepted === false) throw new Error('Runtime State event batch admission was rejected.');
    return withSuspendedTerminals;
  }

  #decisionFacts(
    events: readonly KernelEvent[],
    state: Readonly<AgentState>,
    occurredAt?: string,
  ): DecisionFacts {
    const eventFacts = events.map((event, eventIndex) => {
      const admissions =
        event.type === 'verification.requested'
          ? this.#verificationSchemaAdmissions?.(event, {
              sessionId: this.sessionId,
              eventIndex,
              state,
            })
          : undefined;
      return {
        occurredAt: occurredAt ?? this.#eventTimestamp(),
        ...(admissions !== undefined ? { verificationSchemaAdmissions: [...admissions] } : {}),
      };
    });
    const allocatedIds: Record<string, string> = {};
    let activeTaskId = state.activeTaskId;
    for (const [eventIndex, event] of events.entries()) {
      if (event.type === 'task.started') activeTaskId = event.taskId;
      if (
        (event.type === 'task.completed' ||
          event.type === 'task.cancelled' ||
          event.type === 'task.failed') &&
        event.taskId === activeTaskId
      ) {
        activeTaskId = null;
      }
      if (event.type === 'user.message_appended' && activeTaskId === null) {
        const taskId = this.#nextId('task');
        allocatedIds[taskIdentityAllocationKey(eventIndex, event.messageId)] = taskId;
        activeTaskId = taskId;
      }
    }
    return {
      schema: 'kite.kernel-decision-facts.v1',
      eventFacts,
      knownEventIds: [...state.appliedEventIds],
      allocatedIds,
      workspace: { root: state.session.workspace },
      policy: {
        interactionMode: getEffectiveInteractionMode(state),
        sandboxAvailable: this.#sandboxFact(),
      },
      provider: { semantics: 'current' },
      protectedPath: { semantics: 'current' },
      network: { semantics: 'current' },
      executionBoundary: { semantics: 'current' },
      attempt: { runnerId: this.#runnerId },
    };
  }

  #concurrentEventsCurrent(
    lease: Readonly<StateRuntimeSessionEffectLease>,
    events: readonly KernelEvent[],
  ): boolean {
    if (!this.#isConcurrentEffectEventCurrent) {
      try {
        if (lease.effect.type === 'run_tools') {
          return (
            isConcurrentShellEffectBatchCurrent(this.#state, lease, events, () =>
              this.#eventTimestamp(),
            ) ||
            isConcurrentTaskControlEffectBatchCurrent(this.#state, lease, events, () =>
              this.#eventTimestamp(),
            )
          );
        }
        if (lease.effect.type === 'call_model') {
          return isConcurrentModelEffectBatchCurrent(this.#state, lease, events, () =>
            this.#eventTimestamp(),
          );
        }
        if (lease.effect.type === 'run_auto_review') {
          return (
            isConcurrentAutoReviewEffectBatchCurrent(this.#state, lease, events) ||
            isConcurrentModelEffectBatchCurrent(this.#state, lease, events, () =>
              this.#eventTimestamp(),
            )
          );
        }
        return false;
      } catch {
        return false;
      }
    }
    let projected = this.#state;
    for (const event of events) {
      try {
        if (!this.#isConcurrentEffectEventCurrent(lease, event, projected)) return false;
        projected = this.#projectConcurrentEffectState
          ? this.#projectConcurrentEffectState(projected, event)
          : reduce(projected, [event]);
        assertAgentStateInvariants(projected);
      } catch {
        return false;
      }
    }
    return true;
  }

  #validRequiredLease(required: RuntimeLeaseRequirement): boolean {
    return (
      typeof required.sessionId === 'string' &&
      required.sessionId === this.sessionId &&
      typeof required.effectId === 'string' &&
      required.effectId.length > 0 &&
      typeof required.ownerId === 'string' &&
      required.ownerId.length > 0
    );
  }

  #restoreBoundary(): RuntimeRestoreBoundary {
    const record = this.#services.sessions.loadSnapshotRecord<AgentState>(this.sessionId);
    return {
      snapshot: record?.metadata ?? null,
      lastEventPosition: this.#services.sessions.getLastEventPosition(this.sessionId),
    };
  }

  #runCommitForDecision(
    previousState: Readonly<AgentState>,
    nextState: Readonly<AgentState>,
    events: readonly KernelEvent[],
    metadata: readonly RuntimeEventMetadata[],
    commandEvidence?: RuntimeCommandCommitEvidence,
    followupRunStart?: RuntimeFollowupRunStartMutation,
  ):
    | {
        readonly mutation: RuntimeRunTransactionMutation;
        readonly resourceResult?: RuntimeStoredCommandResourceResult;
      }
    | undefined {
    const runStart =
      commandEvidence?.runStart ??
      (followupRunStart
        ? { runId: followupRunStart.targetRunId, phase: followupRunStart.phase }
        : undefined);
    if (runStart) {
      if (!this.#services.runs) {
        throw new Error('Runtime start Run evidence requires Store 8 authority.');
      }
      if (commandEvidence?.resourceResult !== undefined) {
        throw new Error('Runtime start Run resource result is Host-owned.');
      }
      if (
        nextState.turn.turnId !== runStart.runId ||
        nextState.turn.status !== 'active' ||
        nextState.revision <= previousState.revision ||
        (runStart.originSessionId === undefined) !== (runStart.originRunId === undefined) ||
        (runStart.originSessionId !== undefined &&
          (nextState.childSessionOrigin?.parentSessionId !== runStart.originSessionId ||
            nextState.childSessionOrigin.fundingRunId !== runStart.originRunId))
      ) {
        throw new Error('Runtime start Run evidence does not match the accepted State decision.');
      }
      const run: RuntimeStoredRun = Object.freeze({
        sessionId: this.sessionId,
        runId: runStart.runId,
        ...(runStart.originSessionId
          ? { originSessionId: runStart.originSessionId, originRunId: runStart.originRunId }
          : {}),
        startCommandId: commandEvidence?.commandId ?? `followup:${followupRunStart!.submissionId}`,
        phase: runStart.phase,
        status: 'queued',
        createdRevision: nextState.revision,
        lastRevision: nextState.revision,
        createdAtMs: timestampMilliseconds(metadata.at(-1)?.occurredAt),
      });
      return Object.freeze({
        mutation: Object.freeze({ type: 'insert', run }),
        resourceResult: createRuntimeRunStartResourceResult(run),
      });
    }

    // Initial root Agent registration is a Session metadata command. A fresh
    // Session has no admitted Run to resolve yet; the Store transaction still
    // validates its exact create_agent row and command receipt atomically.
    if (
      events.length === 1 &&
      events[0]?.type === 'agent.created' &&
      events[0].agentId === this.sessionId &&
      events[0].parentAgentId === null &&
      previousState.turn.turnId === nextState.turn.turnId &&
      previousState.turn.status === nextState.turn.status
    )
      return undefined;

    const runs = this.#services.runs;
    if (!runs || !previousState.turn.turnId) return undefined;
    const current = resolveRuntimeExecutionRun(runs, this.sessionId, previousState);
    if (!current || isFinalRunStatus(current.status)) return undefined;
    const handle = runtimeExecutionHandle(current, previousState);
    const completion = events.find(
      (event): event is Extract<KernelEvent, { readonly type: 'run.completed' }> =>
        event.type === 'run.completed',
    );
    if (
      completion &&
      !normalizeCanonicalTaskCompletionFact(previousState, completion, handle.runId)
    ) {
      throw new Error('Runtime Task completion could not be normalized against its stable Run.');
    }
    const continuationAdvanced =
      nextState.turn.status === 'active' && previousState.turn.turnId !== nextState.turn.turnId;
    const status =
      projectRunStatus(previousState, nextState, current.status, events) ??
      (continuationAdvanced ? current.status : undefined);
    if (!status || (status === current.status && !continuationAdvanced)) return undefined;
    if (current.status === 'unknown' && !isPreciseTerminalRunStatus(status)) return undefined;
    const occurredAtMs = Math.max(
      current.startedAtMs ?? current.createdAtMs,
      timestampMilliseconds(metadata.at(-1)?.occurredAt),
    );
    const terminal = isTerminalRunStatus(status);
    const next: RuntimeStoredRun = Object.freeze({
      ...current,
      status,
      lastRevision: nextState.revision,
      ...(current.status === 'queued' && status !== 'queued' ? { startedAtMs: occurredAtMs } : {}),
      ...(terminal
        ? {
            finishedAtMs:
              current.status === 'unknown' && current.finishedAtMs !== undefined
                ? current.finishedAtMs
                : occurredAtMs,
          }
        : {}),
      ...(terminal
        ? {
            terminal: projectRunTerminal(nextState, status),
          }
        : {}),
    });
    return Object.freeze({
      mutation: Object.freeze({
        type: 'transition',
        transition: Object.freeze({
          sessionId: this.sessionId,
          runId: handle.runId,
          expectedLastRevision: current.lastRevision,
          next,
        }),
      }),
    });
  }

  #eventTimestamp(): string {
    const value = this.#defaults.clock();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
      throw new Error('Runtime Host clock returned an invalid State timestamp.');
    }
    return value;
  }

  #clockMilliseconds(): number {
    return timestampMilliseconds(this.#eventTimestamp());
  }

  #sandboxFact(): boolean {
    const value = this.#sandboxAvailable();
    if (typeof value !== 'boolean') {
      throw new Error('Runtime Host sandbox fact is invalid.');
    }
    return value;
  }

  #nextId(kind: string): string {
    const value = this.#defaults.id(kind);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Runtime Host id source returned an invalid ${kind} identity.`);
    }
    return value;
  }

  #eventId(event: KernelEvent, state: Readonly<AgentState>, occurredAt: string): string {
    return digestAgentEvent(
      finalizeAgentEvent(normalizeAgentEvent(event, state, occurredAt), occurredAt),
    );
  }
}

interface RuntimeExecutionHandle {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly initialTurnId: string;
  readonly activeTurnId: string;
  readonly startCommandId: string;
}

/**
 * Build the process-local execution handle from current durable facts. V1
 * uses the accepted initial Turn as the Run identity; a continuation advances
 * activeTurnId without creating or guessing a second Run.
 */
function runtimeExecutionHandle(
  run: Readonly<RuntimeStoredRun>,
  state: Readonly<AgentState>,
): RuntimeExecutionHandle {
  if (
    run.sessionId !== state.session.threadId ||
    run.createdRevision > state.revision ||
    run.lastRevision > state.revision ||
    state.turn.turnId.length === 0
  ) {
    throw new Error('Runtime Run authority does not match the current Session revision and Turn.');
  }
  const taskId = state.activeTaskId;
  return Object.freeze({
    sessionId: run.sessionId,
    ...(taskId === null ? {} : { taskId }),
    runId: run.runId,
    initialTurnId: run.runId,
    activeTurnId: state.turn.turnId,
    startCommandId: run.startCommandId,
  });
}

function resolveRuntimeExecutionRun(
  runs: RuntimeRunStorePort,
  sessionId: string,
  state: Readonly<AgentState>,
): RuntimeStoredRun | undefined {
  const active = runs.getActive(sessionId);
  if (active) return active;

  // An unknown row deliberately sits outside getActive(): it blocks admission
  // until explicit reconciliation. Refine it only when the Store proves there
  // is exactly one candidate, including after a continuation changed Turn id.
  const unknown = runs.list({ sessionId, status: 'unknown', limit: 2 }).entries;
  if (unknown.length === 1) {
    const candidate = unknown[0]!;
    if (candidate.createdRevision > state.revision || candidate.lastRevision > state.revision) {
      throw new Error('Recovered Runtime Run is ahead of the current Session revision.');
    }
    return candidate;
  }
  if (unknown.length > 1) return undefined;

  // Hydration must retain the most recently settled Run as the authoritative
  // currentRun projection.  It is needed for a restarted TUI to render the
  // final answer and to fence late ephemeral packets even when no Run is active.
  // Walk all keyset pages: a long-lived Session can have more than the Store's
  // page limit of settled Runs.
  let candidate: RuntimeStoredRun | undefined;
  let cursor: { readonly createdRevision: number; readonly runId: string } | undefined;
  for (;;) {
    const page = runs.list({
      sessionId,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const entry of page.entries) {
      if (isFinalRunStatus(entry.status)) candidate = entry;
    }
    if (!page.hasMore) break;
    if (
      page.nextCursor === undefined ||
      (cursor !== undefined &&
        page.nextCursor.createdRevision === cursor.createdRevision &&
        page.nextCursor.runId === cursor.runId)
    ) {
      throw new Error('Runtime Run hydration pagination did not advance.');
    }
    cursor = page.nextCursor;
  }
  if (!candidate) return undefined;
  if (candidate.createdRevision > state.revision || candidate.lastRevision > state.revision) {
    throw new Error('Settled Runtime Run is ahead of the current Session revision.');
  }
  return candidate;
}

function runAtOrBeforeRevision(
  runs: RuntimeRunStorePort,
  sessionId: string,
  revision: number,
): RuntimeStoredRun | undefined {
  let candidate: RuntimeStoredRun | undefined;
  let cursor: { readonly createdRevision: number; readonly runId: string } | undefined;
  for (;;) {
    const page = runs.list({ sessionId, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const entry of page.entries) {
      if (entry.createdRevision > revision) return candidate;
      candidate = entry;
    }
    if (!page.hasMore) return candidate;
    if (!page.nextCursor) throw new Error('Runtime Run projection pagination did not advance.');
    cursor = page.nextCursor;
  }
}

function projectRunStatus(
  previousState: Readonly<AgentState>,
  nextState: Readonly<AgentState>,
  current: RuntimeRunStatus,
  events: readonly KernelEvent[],
): RuntimeRunStatus | undefined {
  if (nextState.turn.status === 'completed') return 'completed';
  if (nextState.turn.status === 'aborted') {
    if (nextState.terminalOutcome?.status === 'unknown') return 'unknown';
    return nextState.turn.abortCause === 'user' ? 'cancelled' : 'failed';
  }
  if (nextState.turn.status !== 'active') return undefined;
  if (nextState.interactions.kind !== 'idle') return 'waiting';
  if (
    events.some(
      (event) =>
        event.type === 'completion.blocked' &&
        event.code === 'tool_pending' &&
        (event.nextAction === 'wait_for_tool' || event.nextAction === 'wait_for_background'),
    )
  )
    return 'waiting';
  if (current === 'waiting' && events.some((event) => event.type === 'model.invocation_prepared'))
    return 'running';
  if (current === 'waiting' && previousState.interactions.kind !== 'idle') return 'running';
  return undefined;
}

function projectRunTerminal(
  state: Readonly<AgentState>,
  status: RuntimeRunStatus,
): NonNullable<RuntimeStoredRun['terminal']> {
  const outcome = state.terminalOutcome;
  if (outcome) {
    return Object.freeze({
      reasonCode: outcome.reasonCode,
      safeRetry: outcome.safeRetry,
      recoveryEntry: outcome.recoveryEntry,
    });
  }
  switch (status) {
    case 'completed':
      return Object.freeze({ reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' });
    case 'cancelled':
      return Object.freeze({
        reasonCode: 'cancelled',
        safeRetry: false,
        recoveryEntry: 'new_run',
      });
    case 'unknown':
      return Object.freeze({
        reasonCode: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      });
    default:
      return Object.freeze({
        reasonCode: 'runtime_failed',
        safeRetry: false,
        recoveryEntry: 'new_run',
      });
  }
}

function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'unknown'
  );
}

function isPreciseTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isFinalRunStatus(status: RuntimeRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function timestampMilliseconds(value: string | undefined): number {
  if (value === undefined) throw new Error('Runtime Run transition requires event commit time.');
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error('Runtime Run transition timestamp is invalid.');
  }
  return milliseconds;
}

export function createRuntimeHostStateSession(
  input: StateRuntimeSessionInput,
): StateRuntimeSession {
  return new StateRuntimeSessionImpl(input);
}
