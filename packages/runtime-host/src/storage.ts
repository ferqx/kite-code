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

/** Opaque event/state codec consumed by storage adapters and owned by Host. */
export interface RuntimeSnapshotCodec<Event = unknown, State = unknown> {
  encodeEvent(event: Event): string;
  decodeEvent(json: string): Event;
  encodeState(state: State): string;
  decodeState<T = State>(json: string): T;
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
  deleteSession(sessionId: string): void;
}

export interface RuntimeTransactionInput<Event = unknown, State = unknown> {
  readonly sessionId: string;
  readonly events: readonly Event[];
  readonly snapshot: State;
  readonly metadata?: readonly RuntimeEventMetadata[];
  readonly snapshotMetadata?: RuntimeSnapshotMetadata;
  readonly expectedRestoreBoundary?: RuntimeRestoreBoundary;
  readonly requiredEffectLease?: RuntimeEffectLeaseExpectation;
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
  close(): void;
}

/**
 * Flat Store 4 compatibility shape used by the staged Core callers while
 * they migrate to the nested RuntimeStorage ports above.
 *
 * This is a type-only bridge: the SQLite adapter remains the sole concrete
 * storage owner and exposes the nested RuntimeStorage contract.
 */
export interface RuntimeSessionStoragePort<Event = unknown, State = unknown>
  extends SessionStore<Event, State>,
    EffectLeasePort,
    CheckpointPort<State> {
  appendEventsAndSnapshot(
    sessionId: string,
    events: readonly Event[],
    nextState: State,
    metadata?: readonly RuntimeEventMetadata[],
    snapshotMetadata?: RuntimeSnapshotMetadata,
    expectedRestoreBoundary?: RuntimeRestoreBoundary,
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): void;
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
