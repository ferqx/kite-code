import {
  type AgentState,
  APPLIED_EVENT_ID_TAIL_LIMIT,
  assertAgentStateInvariants,
  type CreateAgentStateInput,
  createInitialAgentState,
  isCurrentAgentStateSnapshot,
  type KernelEvent,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  reduce,
} from '@kite/agent-kernel';
import type { RuntimeRestoreBoundary, SessionStore, StoredRuntimeEvent } from '../storage';

export type StateRuntimeRestoreSource = 'fresh' | 'restored' | 'incompatible' | 'corrupted';

interface StateRuntimeRestoreInputBase {
  readonly sessions: SessionStore<KernelEvent, AgentState>;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  /** Host-allocated identity for a fresh State session. */
  readonly turnId: string;
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: AgentState['mode'];
  readonly phase?: 'planning' | 'building';
  readonly workspaceAccess?: AgentState['workspaceAccess'];
  /**
   * A composed owner may validate Builtin artifact evidence here. Host treats
   * failure as corrupted State data and never interprets the evidence.
   */
  readonly validateRestoredState?: (state: Readonly<AgentState>) => void;
}

export type StateRuntimeRestoreInput =
  | (StateRuntimeRestoreInputBase & {
      readonly authorizationMode?: 'default';
      readonly authorizationSource?: CreateAgentStateInput['authorizationSource'];
      readonly modeGrantedAt?: never;
    })
  | (StateRuntimeRestoreInputBase & {
      readonly authorizationMode: 'full_access';
      readonly authorizationSource: NonNullable<CreateAgentStateInput['authorizationSource']>;
      readonly modeGrantedAt: string;
    });

export interface StateRuntimeRestoreResult {
  readonly state: AgentState;
  readonly restoreBoundary: RuntimeRestoreBoundary;
  readonly source: StateRuntimeRestoreSource;
}

function formatMismatchState(freshState: AgentState, snapshot: unknown): AgentState {
  const candidate = snapshot as {
    readonly schemaVersion?: unknown;
    readonly formatEpoch?: unknown;
  };
  return {
    ...freshState,
    recoveryState: {
      kind: 'incompatible',
      schemaVersion: typeof candidate?.schemaVersion === 'number' ? candidate.schemaVersion : null,
      formatEpoch: typeof candidate?.formatEpoch === 'string' ? candidate.formatEpoch : null,
    },
  };
}

function corruptedState(freshState: AgentState, reason: string): AgentState {
  return {
    ...freshState,
    recoveryState: { kind: 'corrupted', reason },
  };
}

function replayCurrentStateTail(
  state: AgentState,
  tail: readonly StoredRuntimeEvent<KernelEvent>[],
  sessionId: string,
): AgentState {
  let current = state;
  for (const entry of tail) {
    if (!entry.event_id || !entry.revision || !entry.occurred_at) {
      throw new Error(`Runtime event ${entry.id} is missing envelope metadata.`);
    }
    if (entry.thread_id !== sessionId) {
      throw new Error(`Runtime event ${entry.id} belongs to another thread.`);
    }
    if (entry.revision !== current.revision + 1) {
      throw new Error(
        `Runtime event ${entry.id} revision mismatch: expected ${current.revision + 1}, received ${entry.revision}.`,
      );
    }
    if (entry.event.type === 'user.message_appended' && current.activeTaskId === null) {
      throw new Error(
        `Runtime event ${entry.id} requires the State snapshot that owns its Host-allocated Task identity.`,
      );
    }
    const reduced = reduce(current, [entry.event]);
    current = {
      ...reduced,
      revision: entry.revision,
      lastAppliedEventId: entry.event_id,
      appliedEventIds: [...reduced.appliedEventIds, entry.event_id].slice(
        -APPLIED_EVENT_ID_TAIL_LIMIT,
      ),
    };
    assertAgentStateInvariants(current);
  }
  return current;
}

function freshState(input: StateRuntimeRestoreInput): AgentState {
  const common = {
    threadId: input.sessionId,
    userId: input.userId,
    workspace: input.workspace,
    projectId: input.projectId,
    canonicalWorkspaceDigest: input.canonicalWorkspaceDigest,
    turnId: input.turnId,
    recoveryIdentityKey: input.recoveryIdentityKey,
    interactionMode: input.interactionMode,
    phase: input.phase,
    workspaceAccess: input.workspaceAccess,
  };
  return input.authorizationMode === 'full_access'
    ? createInitialAgentState({
        ...common,
        authorizationMode: 'full_access',
        authorizationSource: input.authorizationSource,
        modeGrantedAt: input.modeGrantedAt,
      })
    : createInitialAgentState({
        ...common,
        authorizationMode: input.authorizationMode,
        authorizationSource: input.authorizationSource,
      });
}

/** Restore only State / Store / the current RA epoch from injected Host services. */
export function restoreRuntimeHostStateSession(
  input: StateRuntimeRestoreInput,
): StateRuntimeRestoreResult {
  const restoredState = freshState(input);
  const snapshotRecord = input.sessions.loadSnapshotRecord<unknown>(input.sessionId);
  const lastEventPosition = input.sessions.getLastEventPosition(input.sessionId);
  const restoreBoundary: RuntimeRestoreBoundary = {
    snapshot: snapshotRecord?.metadata ?? null,
    lastEventPosition,
  };

  if (!snapshotRecord) {
    if (lastEventPosition === 0) {
      return { state: restoredState, restoreBoundary, source: 'fresh' };
    }
    return {
      state: corruptedState(
        restoredState,
        'Runtime events exist without a current-format snapshot.',
      ),
      restoreBoundary,
      source: 'corrupted',
    };
  }

  const candidate = snapshotRecord.state as {
    readonly schemaVersion?: unknown;
    readonly formatEpoch?: unknown;
  };
  if (
    candidate.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    snapshotRecord.metadata.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    candidate.formatEpoch !== RUNTIME_STATE_FORMAT_EPOCH
  ) {
    return {
      state: formatMismatchState(restoredState, snapshotRecord.state),
      restoreBoundary,
      source: 'incompatible',
    };
  }

  let state: AgentState;
  try {
    if (!isCurrentAgentStateSnapshot(snapshotRecord.state)) {
      throw new Error('Runtime snapshot is not an exact current State record.');
    }
    state = snapshotRecord.state;
    assertAgentStateInvariants(state);
    if (state.toolRecovery.identityKey !== input.recoveryIdentityKey) {
      throw new Error('Runtime snapshot recovery identity does not match Host storage authority.');
    }
    if (state.session.threadId !== input.sessionId) {
      throw new Error('Runtime snapshot belongs to another thread.');
    }
    if (input.projectId !== undefined && state.session.projectId !== input.projectId) {
      throw new Error('Runtime snapshot belongs to another project.');
    }
    if (
      input.canonicalWorkspaceDigest !== undefined &&
      state.session.canonicalWorkspaceDigest !== input.canonicalWorkspaceDigest
    ) {
      throw new Error('Runtime snapshot workspace identity does not match the Host project.');
    }
    if (snapshotRecord.metadata.eventPosition > lastEventPosition) {
      throw new Error('Runtime snapshot event position exceeds the last durable event position.');
    }
    if (
      snapshotRecord.metadata.stateRevision !== state.revision ||
      snapshotRecord.metadata.schemaVersion !== state.schemaVersion
    ) {
      throw new Error('Runtime snapshot metadata does not match the State payload.');
    }
    state = replayCurrentStateTail(
      state,
      input.sessions.loadEventsStrict(input.sessionId, snapshotRecord.metadata.eventPosition),
      input.sessionId,
    );
    input.validateRestoredState?.(state);
  } catch (error) {
    return {
      state: corruptedState(restoredState, error instanceof Error ? error.message : String(error)),
      restoreBoundary,
      source: 'corrupted',
    };
  }

  if (input.interactionMode !== undefined && state.mode !== input.interactionMode) {
    state = { ...state, mode: input.interactionMode };
  }
  if (
    input.authorizationMode !== undefined &&
    state.authorization.mode !== input.authorizationMode
  ) {
    state = {
      ...state,
      authorization:
        input.authorizationMode === 'full_access'
          ? {
              ...state.authorization,
              mode: 'full_access',
              modeSource: input.authorizationSource,
              modeGrantedAt: input.modeGrantedAt,
            }
          : { ...state.authorization, mode: 'default' },
    };
  }
  assertAgentStateInvariants(state);
  return { state, restoreBoundary, source: 'restored' };
}
