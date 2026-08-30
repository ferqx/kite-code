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

export {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  RuntimeLogRequestValidationError,
} from '@kite-ai/runtime-contract';
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

/** Opaque event/state codec consumed by storage adapters and owned by Host. */
export interface RuntimeSnapshotCodec<Event = unknown, State = unknown> {
  encodeEvent(event: Event): string;
  /** Re-encode already-decoded history while preserving read-only compatibility during fork. */
  encodeHistoricalEvent?(event: Event): string;
  decodeEvent(json: string): Event;
  /**
   * Decode one explicitly supported historical event into the current
   * in-memory event contract. Unknown formats return null and stay isolated
   * to their source session.
   */
  decodeCompatibleEvent?(json: string, format: RuntimeCompatibleRecordFormat): Event | null;
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
  readonly model?: { readonly provider: string; readonly name: string };
}
export interface RuntimeLogSessionReadPage {
  readonly entries: readonly RuntimeLogSessionRecord[];
  readonly nextCursor?: RuntimeLogSessionCursor;
  readonly hasMore: boolean;
}
export type RuntimeLogEventQuery = ListRuntimeLogEventsRequest;
export interface RuntimeLogQueryPort<Event = unknown> {
  listSessions(request: RuntimeLogSessionQuery): RuntimeLogSessionReadPage;
  listEvents(request: RuntimeLogEventQuery): RuntimeLogEventReadPage<Event>;
  close(): void;
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
