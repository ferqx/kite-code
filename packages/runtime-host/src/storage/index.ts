import type {
  RuntimeLogSessionCursor as ContractRuntimeLogSessionCursor,
  ListRuntimeLogEventsRequest,
  ListRuntimeLogSessionsRequest,
  RuntimeLogErrorCode,
} from '@kite-ai/runtime-contract';

import {
  assertRuntimeStoredCommandResourceResult,
  type RuntimeRunPhase,
  type RuntimeRunStorePort,
  type RuntimeRunTransactionMutation,
  type RuntimeStoredCommandResourceResult,
} from './runtime-run';

/** Exact terminal marker shared by Host decisions and Store proof verification. */
export const CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED =
  'Child followup deadline expired before first Model dispatch.';

export type {
  ListRuntimeLogSessionsRequest,
  RuntimeLogSessionPage,
} from '@kite-ai/runtime-contract';
export {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  RuntimeLogRequestValidationError,
} from '@kite-ai/runtime-contract';
export {
  canonicalSealedChildGrantJson,
  type RuntimeSealedChildGrantPayload,
  sealChildGrantPayload,
} from './child-grant';
export {
  type FollowupChildApprovalParentToolIdentity,
  followupChildApprovalParentToolCallId,
  parseFollowupChildApprovalParentToolCallId,
} from './followup-child-approval-identity';
export * from './runtime-run';

/**
 * Persistence contracts owned by Runtime Host.
 *
 * These contracts deliberately contain no SQLite, Kernel, Provider, or App
 * types. The App composition root binds generic payloads to the current state
 * and RuntimeEvent types at the App composition root.
 */

export interface RuntimeStorageBoundary {
  readonly adapterId: string;
  readonly stateSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly formatEpoch: string;
}

/**
 * Persisted record identity supplied only to the read-side compatibility
 * decoder.  The current writer never selects a format through this object.
 */
export interface RuntimeCompatibleRecordFormat {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
}

/** Persistence-order context required to synthesize deterministic legacy identities. */
export interface RuntimeCompatibleEventContext {
  readonly sequence: number;
}

/** Opaque event/state codec consumed by storage adapters and owned by Host. */
export interface RuntimeSnapshotCodec<Event = unknown, State = unknown> {
  encodeEvent(event: Event): string;
  /** Re-encode already-decoded history while preserving read-only compatibility during fork. */
  encodeHistoricalEvent?(event: Event): string;
  decodeEvent(json: string, context?: RuntimeCompatibleEventContext): Event;
  /**
   * Decode one explicitly supported historical event into the current
   * in-memory event contract. Unknown formats return null and stay isolated
   * to their source session.
   */
  decodeCompatibleEvent?(
    json: string,
    format: RuntimeCompatibleRecordFormat,
    context?: RuntimeCompatibleEventContext,
  ): Event | null;
  encodeState(state: State): string;
  decodeState<T = State>(json: string): T;
  /** Read-side State migration. Current encodeState remains single-format. */
  decodeCompatibleState?(json: string, format: RuntimeCompatibleRecordFormat): State | null;
  eventSummary?(event: Event): {
    readonly isSessionNameCandidate?: boolean;
    readonly searchText?: string;
  } | null;
  snapshotMetadata(state: State): {
    readonly stateRevision: number;
    readonly schemaVersion: number;
  };
  /** State session identity required before a Store row may be created. */
  sessionIdentity?(state: State): {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
  /** Current-format private identity used to verify the fork source. */
  recoveryIdentity?(state: State): string;
  validateSnapshot?(input: {
    readonly state: State;
    readonly sessionId: string;
    readonly eventPosition: number;
    readonly stateRevision: number;
    readonly schemaVersion: number;
    readonly eventRevision: number;
  }): void;
  rebindForkState(state: State, targetSessionId: string, targetRecoveryIdentityKey: string): State;
  canFork?(state: State): boolean;
  isCurrentPendingInteractionRequest?(state: State, event: Event): boolean;
}

export interface RuntimeEventMetadata {
  readonly eventId: string;
  readonly revision: number;
  readonly causationId?: string;
  readonly occurredAt?: string;
}

/** Scoped persistent identity for a Runtime command retry. */
export interface RuntimeCommandReceiptLookupInput {
  readonly scopeSessionId: string;
  readonly commandId: string;
  readonly requestDigest: string;
}

/** Exact applied Contract receipt persisted with the State decision. */
export interface RuntimeAppliedCommandReceipt {
  readonly status: 'applied';
  readonly commandId: string;
  readonly sessionId: string;
  readonly revision: number;
}

/** Store-owned record; command bodies never enter this persistence contract. */
export interface RuntimeStoredCommandReceipt extends RuntimeCommandReceiptLookupInput {
  readonly targetSessionId: string;
  readonly originalReceiptJson: string;
  readonly committedRevision: number;
  readonly committedAt: number;
  readonly resourceResult?: RuntimeStoredCommandResourceResult;
}

export type RuntimeCommandReceiptLookup =
  | { readonly status: 'missing' }
  | { readonly status: 'replay'; readonly receipt: RuntimeStoredCommandReceipt }
  | { readonly status: 'digest_mismatch'; readonly receipt: RuntimeStoredCommandReceipt };

/** Host-owned durable receipt reader. It is intentionally not a generic metadata store. */
export interface RuntimeCommandReceiptPort {
  lookup(input: RuntimeCommandReceiptLookupInput): RuntimeCommandReceiptLookup;
}

/**
 * Command facts supplied to the State transaction before it computes the
 * applied revision. StateRuntimeSession constructs the persisted receipt only
 * after its decision has been accepted.
 */
export interface RuntimeCommandCommitEvidence extends RuntimeCommandReceiptLookupInput {
  readonly targetSessionId: string;
  readonly committedAt: number;
  readonly resourceResult?: RuntimeStoredCommandResourceResult;
  readonly runStart?: {
    readonly runId: string;
    readonly phase: RuntimeRunPhase;
    /** Only a verified child activation may bind a Run to its parent origin. */
    readonly originSessionId?: string;
    readonly originRunId?: string;
  };
}

export function createRuntimeStoredCommandReceipt(
  evidence: RuntimeCommandCommitEvidence,
  committedRevision: number,
): RuntimeStoredCommandReceipt {
  assertCommandReceiptText(evidence.scopeSessionId, 'scope session identity');
  assertCommandReceiptText(evidence.commandId, 'command identity');
  if (!/^[a-f0-9]{64}$/u.test(evidence.requestDigest)) {
    throw new Error('Runtime command receipt digest is invalid.');
  }
  assertCommandReceiptText(evidence.targetSessionId, 'target session identity');
  if (!Number.isSafeInteger(evidence.committedAt) || evidence.committedAt < 0) {
    throw new Error('Runtime command receipt committed time is invalid.');
  }
  if (!Number.isSafeInteger(committedRevision) || committedRevision < 0) {
    throw new Error('Runtime command receipt committed revision is invalid.');
  }
  if (evidence.resourceResult !== undefined) {
    assertRuntimeStoredCommandResourceResult(evidence.resourceResult);
  }
  const originalReceipt: RuntimeAppliedCommandReceipt = Object.freeze({
    status: 'applied',
    commandId: evidence.commandId,
    sessionId: evidence.targetSessionId,
    revision: committedRevision,
  });
  return Object.freeze({
    scopeSessionId: evidence.scopeSessionId,
    commandId: evidence.commandId,
    requestDigest: evidence.requestDigest,
    targetSessionId: evidence.targetSessionId,
    originalReceiptJson: JSON.stringify(originalReceipt),
    committedRevision,
    committedAt: evidence.committedAt,
    ...(evidence.resourceResult === undefined
      ? {}
      : { resourceResult: Object.freeze({ ...evidence.resourceResult }) }),
  });
}

function assertCommandReceiptText(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`Runtime command receipt ${field} is invalid.`);
  }
}

export interface RuntimeSnapshotMetadata {
  readonly eventPosition: number;
  readonly stateRevision: number;
  readonly stateChecksum: string;
  readonly schemaVersion: number;
}

export interface RuntimeRestoreBoundary {
  readonly snapshot: RuntimeSnapshotMetadata | null;
  readonly lastEventPosition: number;
}

export interface StoredRuntimeEvent<Event> {
  readonly id: number;
  readonly thread_id: string;
  readonly event: Event;
  readonly created_at: number;
  readonly event_id?: string;
  readonly revision?: number;
  readonly causation_id?: string;
  readonly occurred_at?: string;
}

export interface RuntimeSessionInfo {
  readonly threadId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly needsSmartName: boolean;
}

export interface RuntimeSessionModelRoute {
  readonly provider: string;
  readonly name: string;
}

/** Receipt-bearing deletion remains a single Store transaction. */
export interface RuntimeSessionDeletionInput {
  readonly expectedRevision: number;
  readonly commandReceipt: RuntimeStoredCommandReceipt;
}

export interface RuntimeCheckpointEntry {
  readonly snapshotId: string;
  readonly eventPosition: number;
  readonly createdAt: number;
  readonly targetMessage?: string;
  readonly targetMessageCreatedAt?: number;
  readonly affectedFileCount?: number;
}

export interface RuntimeFileRestoreMaterial {
  readonly path: string;
  readonly content: string | null;
  readonly existed: boolean;
  readonly postHash: string | null;
  readonly postExisted: boolean | null;
}

/** Host storage mechanism port used by concrete Workspace mutation executors. */
export type RuntimeHostFilePreimageRecorder = ((
  path: string,
  content: string | null,
  existed: boolean,
) => void) & {
  recordPostimage?: (path: string, content: string | null, existed: boolean) => void;
};

/** Session journal, committed-state reads, and App-visible session metadata. */
export interface SessionStore<Event = unknown, State = unknown> {
  appendEvents(
    sessionId: string,
    events: readonly Event[],
    metadata?: readonly RuntimeEventMetadata[],
  ): void;
  loadEventsStrict(sessionId: string, since?: number): StoredRuntimeEvent<Event>[];
  saveSnapshot(sessionId: string, state: State): void;
  loadSnapshot<T = State>(sessionId: string): T | null;
  loadSnapshotRecord<T = State>(
    sessionId: string,
  ): { state: T; metadata: RuntimeSnapshotMetadata } | null;
  getLastEventPosition(sessionId: string): number;
  listSessions(query?: string, limit?: number): RuntimeSessionInfo[];
  setSessionName(sessionId: string, name: string): void;
  getSessionModelRoute(sessionId: string): RuntimeSessionModelRoute | null;
  setSessionModelRoute(sessionId: string, route: RuntimeSessionModelRoute): void;
  deleteSession(sessionId: string, deletion?: RuntimeSessionDeletionInput): void;
}

/**
 * Read-only durable log query boundary. This is intentionally separate from
 * SessionStore: callers cannot obtain mutation, transaction, effect,
 * checkpoint, Artifact, or deletion capabilities through a log reader.
 */
export interface RuntimeLogEventRecord<Event = unknown> {
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly causationId?: string;
  readonly occurredAt?: string;
  readonly createdAt: number;
  /** Current-codec decoded event; never raw SQLite JSON. */
  readonly event: Event;
}

export interface RuntimeLogEventReadPage<Event = unknown> {
  readonly entries: readonly RuntimeLogEventRecord<Event>[];
  readonly nextCursor?: number;
  readonly hasMore: boolean;
  readonly observedLastSequence: number;
}

export type RuntimeLogQueryErrorCode = RuntimeLogErrorCode;
export type RuntimeLogSessionCursor = ContractRuntimeLogSessionCursor;
export type RuntimeLogSessionQuery = ListRuntimeLogSessionsRequest;
export interface RuntimeLogSessionRecord {
  readonly sessionId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
  /** Store-owned content generation, advanced by every event row mutation. */
  readonly historyGeneration?: number;
  readonly model?: { readonly provider: string; readonly name: string };
}
export interface RuntimeLogSessionReadPage {
  readonly entries: readonly RuntimeLogSessionRecord[];
  readonly nextCursor?: RuntimeLogSessionCursor;
  readonly hasMore: boolean;
}
export type RuntimeLogEventQuery = ListRuntimeLogEventsRequest;
export interface RuntimeLogQueryPort<Event = unknown> {
  /** Indexed metadata lookup when supported by the Store reader. */
  getSession?(sessionId: string): RuntimeLogSessionRecord | null;
  listSessions(request: RuntimeLogSessionQuery): RuntimeLogSessionReadPage;
  listEvents(request: RuntimeLogEventQuery): RuntimeLogEventReadPage<Event>;
  close(): void;
}

export interface RuntimeAgentArtifactRef<Kind extends string> {
  readonly artifactId: string;
  readonly kind: Kind;
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

/** Private mailbox rows committed with the same Session State transaction. */
export type RuntimeAgentMailboxMutation =
  | Readonly<{
      kind: 'create_agent';
      agentId: string;
      parentAgentId: string | null;
      initialTaskId?: string;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'accept_mail';
      messageId: string;
      submissionId?: string;
      senderAgentId: string;
      targetAgentId: string;
      mode: 'queue_only' | 'trigger_turn' | 'reply';
      source: Readonly<{
        runId: string;
        turnId: string;
        modelInvocationId: string;
        toolCallId: string;
        effectAttemptId: string;
        sourceTaskId?: string;
      }>;
      bodyRef: RuntimeAgentArtifactRef<'agent_mail'>;
      bodyDigest: string;
      /** Private body: never copied into a Kernel event, State, or client projection. */
      bodyText: string;
      requestDigest: string;
      sequence: number;
      acceptedAtMs: number;
      followupAdmission?: Readonly<{
        ref: RuntimeAgentArtifactRef<'agent_followup_admission'>;
        digest: string;
        canonicalJson: string;
        createdAt: number;
      }>;
    }>
  | Readonly<{
      kind: 'prepare_input';
      targetAgentId: string;
      modelInvocationId: string;
      modelAdmissionId: string;
      fromSequence: number;
      throughSequence: number;
      messageIds: readonly string[];
    }>
  | Readonly<{
      kind: 'turn_started';
      agentId: string;
      taskId: string;
      turnOrdinal: number;
      submissionId?: string;
    }>
  | Readonly<{
      kind: 'task_settled';
      agentId: string;
      taskId: string;
      checkpointRef?: RuntimeAgentArtifactRef<'subagent_checkpoint'>;
    }>;

/** Store11 cross-Session QueueOnly steps, each committed under its own Session owner. */
export type RuntimeCrossSessionAgentMailMutation =
  | Readonly<{
      kind: 'accept_queue';
      messageId: string;
      targetSessionId: string;
      commandId: string;
      requestDigest: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceModelInvocationId: string;
      sourceToolCallId: string;
      sourceEffectAttemptId: string;
      sourceTaskId?: string;
      sourceGrantId?: string;
      sourceGrantDigest?: string;
      sourceSequence: number;
      bodyText: string;
      acceptedAtMs: number;
    }>
  | Readonly<{
      kind: 'accept_followup';
      messageId: string;
      targetSessionId: string;
      commandId: string;
      requestDigest: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceModelInvocationId: string;
      sourceToolCallId: string;
      sourceEffectAttemptId: string;
      sourceTaskId?: string;
      sourceGrantId?: string;
      sourceGrantDigest?: string;
      sourceSequence: number;
      bodyText: string;
      acceptedAtMs: number;
      submissionId: string;
      admission: Readonly<{
        ref: RuntimeAgentArtifactRef<'agent_followup_admission'>;
        digest: string;
        canonicalJson: string;
        createdAt: number;
      }>;
    }>
  | Readonly<{
      kind: 'activate_independent_followup_turn';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      grantDigest: string;
      targetRevision: number;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'settle_independent_followup_funding';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      targetRevision: number;
      disposition: 'completed' | 'unknown' | 'pre_dispatch_released';
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'request_interrupt';
      commandId: string;
      requestDigest: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceModelInvocationId: string;
      sourceToolCallId: string;
      sourceEffectAttemptId: string;
      sourceTaskId?: string;
      sourceGrantDigest?: string;
      targetSessionId: string;
      targetRunId: string;
      targetTaskId: string;
      targetOwnerGeneration: number;
      targetRevision: number;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'request_queued_interrupt';
      commandId: string;
      requestDigest: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceModelInvocationId: string;
      sourceToolCallId: string;
      sourceEffectAttemptId: string;
      sourceTaskId?: string;
      sourceGrantDigest?: string;
      targetSessionId: string;
      targetRunId: null;
      targetTaskId: string;
      targetOwnerGeneration: null;
      queuedIntentEventId: string;
      targetRevision: 0;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'settle_queued_interrupt';
      commandId: string;
      targetSessionId: string;
    }>
  | Readonly<{
      kind: 'ack_interrupt';
      sourceSessionId: string;
      commandId: string;
      targetGeneration: number;
    }>
  | Readonly<{
      kind: 'settle_interrupt';
      sourceSessionId: string;
      commandId: string;
      targetGeneration: number;
    }>
  | Readonly<{
      kind: 'receive_queue';
      sourceSessionId: string;
      messageId: string;
      receivedAtMs: number;
    }>
  | Readonly<{
      kind: 'receive_followup';
      sourceSessionId: string;
      messageId: string;
      submissionId: string;
      receivedAtMs: number;
    }>
  | Readonly<{
      kind: 'prepare_queue_input';
      modelInvocationId: string;
      modelAdmissionId: string;
      currentRunId: string;
      fromSequence: number;
      throughSequence: number;
      messageIds: readonly string[];
    }>
  | Readonly<{
      kind: 'replace_followup_backup';
      targetSessionId: string;
      messageId: string;
      submissionId: string;
      targetRunId: string;
      modelInvocationId: string;
      targetRevision: number;
      surfaceArtifact: RuntimeAgentArtifactRef<'model_surface'>;
      surfaceInputTokens: number;
      surfaceMaxOutputTokens: number;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'activate_followup_funding';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      modelInvocationId: string;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'settle_followup_funding';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      modelInvocationId: string;
      targetRevision: number;
      disposition: 'completed' | 'unknown' | 'pre_dispatch_released';
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'settle_followup_funding_after_unknown_recovery';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      modelInvocationId: string;
      targetRevision: number;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'release_accepted_followup_backup';
      targetSessionId: string;
      submissionId: string;
      reason:
        | 'tool_failed'
        | 'expired'
        | 'context_unavailable'
        | 'authorization_changed'
        | 'capacity_timeout';
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'release_current_turn_backup';
      targetSessionId: string;
      submissionId: string;
      targetRunId: string;
      invocationId: string;
      modelAdmissionId: string;
      reservationId: string;
      targetRevision: number;
      createdAtMs: number;
    }>
  | Readonly<{
      kind: 'route_followup';
      sourceSessionId: string;
      messageId: string;
      submissionId: string;
      route: 'current_turn' | 'new_turn';
      targetRunId: string;
      taskId: string;
      invocationId: string;
      modelAdmissionId: string;
      reservationId: string;
      createdAtMs: number;
    }>;

/** The child owner seals a replayable terminal checkpoint with its exact seal event. */
export interface RuntimeChildTerminalCheckpointMutation {
  readonly ref: RuntimeAgentArtifactRef<'subagent_checkpoint'>;
  readonly canonicalJson: string;
  readonly terminalRunId: string;
  readonly terminalTaskId: string;
  readonly submissionId?: string;
}

/** Target-owned new Run start; Store validates the settled checkpoint and source admission. */
export interface RuntimeFollowupRunStartMutation {
  readonly sourceSessionId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly taskId: string;
  readonly phase: 'planning' | 'building';
  readonly checkpointRef: RuntimeAgentArtifactRef<'subagent_checkpoint'>;
  readonly grantDigest: string;
  readonly grant: Readonly<{
    ref: RuntimeAgentArtifactRef<'agent_followup_grant'>;
    canonicalJson: string;
    createdAt: number;
  }>;
}

/** Parent receipt evidence that authorizes one private child Session creation. */
export interface RuntimeChildSessionIntentMutation {
  readonly childThreadId: string;
  readonly parentSessionId: string;
  readonly parentInvocationId: string;
  readonly originRunId: string;
  readonly originTurnId: string;
  readonly originToolCallId: string;
  readonly attempt: number;
  readonly childInvocationId: string;
  readonly grantDigest: string;
  readonly sealedGrantJson: string;
  readonly sealedGrantByteLength: number;
  readonly sealedGrantDigest: `sha256:${string}`;
  readonly taskArtifactRef: RuntimeAgentArtifactRef<'subagent_task'>;
  readonly taskArtifactDigest: string;
  readonly taskTextDigest: string;
  readonly disposition: 'required' | 'after_turn';
  readonly role: 'explore' | 'plan' | 'code' | 'review';
  readonly fundingRunId: string;
  readonly delegatedReservationId: string;
  readonly delegatedUpperBoundDigest: string;
  readonly deadlineAt: string;
}

/** CAS proving no child Session was created before a permanent failure settles its Tool claim. */
export interface RuntimeChildCreationFailureMutation {
  readonly parentSessionId: string;
  readonly childThreadId: string;
  readonly failureReceiptDigest: string;
  readonly mode: 'absent_child' | 'created_unactivated' | 'activated_no_ack';
}

export interface RuntimeChildBudgetActivationMutation {
  readonly childThreadId: string;
  readonly parentSessionId: string;
  readonly parentInvocationId: string;
  readonly childInvocationId: string;
  readonly grantDigest: string;
  readonly taskArtifactRef: RuntimeAgentArtifactRef<'subagent_task'>;
  readonly taskArtifactDigest: string;
  readonly taskTextDigest: string;
  readonly fundingRunId: string;
  readonly delegatedReservationId: string;
  readonly delegatedUpperBoundDigest: string;
  readonly childRunId: string;
  readonly childMaySpawn: boolean;
  readonly childMayWrite: boolean;
}

/** Public, fixed Task label; the delegated task body remains in its private Artifact. */
export const CHILD_SESSION_TASK_USER_GOAL = 'Complete the delegated task.';

export interface RuntimeChildDispatchAckMutation {
  readonly parentSessionId: string;
  readonly childThreadId: string;
  readonly originRunId: string;
  readonly originToolCallId: string;
  readonly delegatedReservationId: string;
}

export interface RuntimeChildTerminalImportMutation {
  readonly parentSessionId: string;
  readonly childThreadId: string;
  readonly terminalReceiptDigest: string;
}

/** Private parent command decision for one exact child-owned approval request. */
export interface RuntimeChildApprovalProxyDecisionMutation {
  readonly proxyInteractionId: string;
  readonly childRequestRevision: number;
  readonly childGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly decision: 'approve_once' | 'reject';
}

export interface RuntimeTransactionInput<Event = unknown, State = unknown> {
  readonly sessionId: string;
  readonly events: readonly Event[];
  readonly snapshot: State;
  readonly metadata?: readonly RuntimeEventMetadata[];
  readonly snapshotMetadata?: RuntimeSnapshotMetadata;
  readonly expectedRestoreBoundary?: RuntimeRestoreBoundary;
  readonly requiredEffectLease?: RuntimeEffectLeaseExpectation;
  /** Only command-decision commits may include this Store 6 record. */
  readonly commandReceipt?: RuntimeStoredCommandReceipt;
  /** Store 8-only Run row change committed by the same transaction owner. */
  readonly runMutation?: RuntimeRunTransactionMutation;
  /** Session model metadata committed with the same accepted command decision. */
  readonly sessionModelRoute?: RuntimeSessionModelRoute;
  /** Store11 Agent facts; private bodies share the State/receipt transaction. */
  readonly agentMailboxMutations?: readonly RuntimeAgentMailboxMutation[];
  /** One source or target QueueOnly mailbox step in the same Session State transaction. */
  readonly crossSessionAgentMailMutation?: RuntimeCrossSessionAgentMailMutation;
  /** Immutable Store row committed with the exact parent Task Tool terminal receipt. */
  readonly childSessionIntent?: RuntimeChildSessionIntentMutation;
  readonly childCreationFailure?: RuntimeChildCreationFailureMutation;
  readonly childBudgetActivation?: RuntimeChildBudgetActivationMutation;
  readonly childDispatchAck?: RuntimeChildDispatchAckMutation;
  readonly childTerminalImport?: RuntimeChildTerminalImportMutation;
  readonly childTerminalCheckpointMutation?: RuntimeChildTerminalCheckpointMutation;
  readonly followupRunStart?: RuntimeFollowupRunStartMutation;
  /** Requires the parent command receipt in this exact decision transaction. */
  readonly childApprovalProxyDecision?: RuntimeChildApprovalProxyDecisionMutation;
}

/** Store 4 lease predicate checked atomically with the guarded commit. */
export interface RuntimeEffectLeaseExpectation {
  readonly effectId: string;
  readonly ownerId: string;
  readonly observedAtMs: number;
}

/**
 * Four durable acknowledgement classes. Store 4 maps every class to the same
 * atomic event + rolling-snapshot primitive; the distinct methods prevent a
 * future Host from dispatching an effect through an unacknowledged path.
 */
export interface RuntimeTransactionPort<Event = unknown, State = unknown> {
  commitDecision(input: RuntimeTransactionInput<Event, State>): void;
  commitAttemptStart(input: RuntimeTransactionInput<Event, State>): void;
  commitReceiptEvidence(input: RuntimeTransactionInput<Event, State>): void;
  commitTerminalRecovery(input: RuntimeTransactionInput<Event, State>): void;
}

export interface EffectLeasePort {
  tryAcquireEffectLease(
    sessionId: string,
    effectId: string,
    ownerId: string,
    expiresAtMs: number,
  ): boolean;
  renewEffectLease(
    sessionId: string,
    effectId: string,
    ownerId: string,
    expiresAtMs: number,
  ): boolean;
  releaseEffectLease(sessionId: string, effectId: string, ownerId: string): void;
}

/** App projection metadata kept outside the canonical Runtime State contract. */
export interface SessionMetadataPort<Value extends object> {
  save(sessionId: string, value: Readonly<Value>): void;
  loadAll(): readonly { sessionId: string; value: Value }[];
  close(): void;
}

/**
 * Host-owned private recovery identity persistence.  The implementation must
 * use the same Store connection as the RuntimeStorage owner; it must not open
 * a second database or derive an identity from a session identifier.
 */
export interface RuntimeRecoveryIdentityPort {
  read(sessionId: string): string | null;
  getOrCreate(sessionId: string, allocate: () => string): string;
  remove(sessionId: string): void;
}

export interface RuntimeCommandForkInput {
  readonly sourceSessionId: string;
  readonly snapshotId: string;
  readonly targetSessionId: string;
  readonly targetRecoveryIdentityKey: string;
  readonly commandEvidence: RuntimeCommandCommitEvidence;
}

export type RuntimeCommandForkResult =
  | { readonly status: 'applied'; readonly receipt: RuntimeStoredCommandReceipt }
  | { readonly status: 'unavailable' };

export interface CheckpointPort<State = unknown> {
  saveNamedSnapshot(sessionId: string, name: string, state: State, eventPosition?: number): void;
  loadNamedSnapshot<T = State>(sessionId: string, name: string): T | null;
  listNamedSnapshots(sessionId: string): RuntimeCheckpointEntry[];
  getNamedSnapshotEntry(sessionId: string, snapshotId: string): RuntimeCheckpointEntry | null;
  restoreNamedSnapshot(sessionId: string, snapshotId: string): boolean;
  forkSession(
    sourceSessionId: string,
    snapshotId: string,
    targetSessionId: string,
    targetRecoveryIdentityKey: string,
  ): boolean;
  /** Store 6 clone + scoped receipt in one transaction; ordinary fork never writes a receipt. */
  forkSessionForCommand(input: RuntimeCommandForkInput): RuntimeCommandForkResult;
  forkCurrentSession(
    sourceSessionId: string,
    targetSessionId: string,
    targetRecoveryIdentityKey: string,
  ): boolean;
  recordFilePreimage(
    sessionId: string,
    path: string,
    content: string | null,
    existed: boolean,
  ): void;
  recordFilePostimage(
    sessionId: string,
    path: string,
    contentHash: string | null,
    existed: boolean,
  ): void;
  fileRestorePlan(sessionId: string, eventPosition: number): RuntimeFileRestoreMaterial[];
}

/** A strong, typed namespace remains responsible for validating its own refs. */
export interface ArtifactNamespacePort<Access extends object = object> {
  readonly namespace: string;
  readonly access: Access;
}

/**
 * Type-erased registry only at the Host boundary. Each returned access object
 * remains the existing strongly typed artifact store; namespace lookup never
 * converts or reinterprets a reference from another namespace.
 */
export interface ArtifactPort {
  getNamespace<Access extends object = object>(namespace: string): Access | null;
  listNamespaces(): readonly string[];
}

export interface RuntimeStorage<Event = unknown, State = unknown> extends RuntimeStorageBoundary {
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeTransactionPort<Event, State>;
  readonly effects: EffectLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly artifacts: ArtifactPort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPort;
  /** Store 6 persistent replay authority; no in-memory or optional fallback exists. */
  readonly commandReceipts: RuntimeCommandReceiptPort;
  /** Present only for a fully preflighted Store 8 owner. */
  readonly runs?: RuntimeRunStorePort;
  close(): void;
}

export function createArtifactPort(
  namespaces: readonly ArtifactNamespacePort[] = [],
): ArtifactPort {
  const entries = new Map<string, object>();
  for (const entry of namespaces) {
    if (!entry.namespace || entries.has(entry.namespace)) {
      throw new Error(`Artifact namespace is invalid or duplicated: ${entry.namespace}`);
    }
    entries.set(entry.namespace, entry.access);
  }
  const names = Object.freeze([...entries.keys()].sort());
  return Object.freeze({
    getNamespace<Access extends object = object>(namespace: string): Access | null {
      return (entries.get(namespace) as Access | undefined) ?? null;
    },
    listNamespaces(): readonly string[] {
      return names;
    },
  });
}
export { childDelegatedUpperBoundDigest } from '@kite-ai/agent-kernel';
export { assertChildBudgetWithinDelegation } from '../kernel-adapter/resource-budget';
