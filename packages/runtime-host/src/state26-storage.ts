import {
  type AgentState,
  assertAgentStateInvariants,
  assertCurrentRuntimeEvent,
  canForkAgentState,
  decodeCurrentAgentStateJson,
  decodeCurrentRuntimeEventJson,
  encodeCurrentAgentStateJson,
  encodeCurrentRuntimeEventJson,
  isCurrentAgentStateSnapshot,
  isCurrentPendingInteractionRequest,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeEvent,
  rebindForkAgentState,
} from '@kite/agent-kernel';
import type { RuntimeSnapshotCodecV1 } from './storage';

export interface RuntimeHostState26StorageBindingV1 {
  readonly codec: RuntimeSnapshotCodecV1<RuntimeEvent, AgentState>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requireState26(value: unknown): AgentState {
  if (!isCurrentAgentStateSnapshot(value)) {
    throw new Error('Runtime snapshot is not State26/current-epoch data.');
  }
  assertAgentStateInvariants(value);
  return value;
}

function createState26Codec(): RuntimeSnapshotCodecV1<RuntimeEvent, AgentState> {
  return Object.freeze({
    encodeEvent(event: RuntimeEvent): string {
      assertCurrentRuntimeEvent(event);
      return encodeCurrentRuntimeEventJson(event);
    },
    decodeEvent(json: string): RuntimeEvent {
      return decodeCurrentRuntimeEventJson(json);
    },
    encodeState(state: AgentState): string {
      return encodeCurrentAgentStateJson(requireState26(state));
    },
    decodeState<T = AgentState>(json: string): T {
      return decodeCurrentAgentStateJson(json) as unknown as T;
    },
    eventSummary(event: RuntimeEvent) {
      assertCurrentRuntimeEvent(event);
      if (event.type !== 'user.message_appended') return null;
      const content = record(event)?.content;
      return typeof content === 'string'
        ? { isSessionNameCandidate: true, searchText: content }
        : null;
    },
    snapshotMetadata(state: AgentState) {
      const candidate = requireState26(state);
      return {
        stateRevision: candidate.revision,
        schemaVersion: candidate.schemaVersion,
      };
    },
    sessionIdentity(state: AgentState) {
      const session = state.session as AgentState['session'] & {
        readonly projectId?: string;
        readonly canonicalWorkspaceDigest?: string;
      };
      if (!session.projectId || !session.canonicalWorkspaceDigest) {
        throw new Error('State26 session project identity is missing.');
      }
      return {
        projectId: session.projectId,
        canonicalWorkspaceDigest: session.canonicalWorkspaceDigest,
      };
    },
    recoveryIdentity(state: AgentState): string {
      return requireState26(state).toolRecovery.identityKey;
    },
    validateSnapshot(input: {
      readonly state: AgentState;
      readonly sessionId: string;
      readonly eventPosition: number;
      readonly stateRevision: number;
      readonly schemaVersion: number;
      readonly eventRevision: number;
    }) {
      const state = requireState26(input.state);
      if (
        state.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        state.formatEpoch !== RUNTIME_STATE_FORMAT_EPOCH ||
        state.session.threadId !== input.sessionId ||
        state.revision !== input.stateRevision ||
        input.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        input.eventRevision !== input.stateRevision ||
        input.eventPosition < 0
      ) {
        throw new Error('Runtime State26 snapshot identity or revision is invalid.');
      }
    },
    rebindForkState(
      state: AgentState,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
    ): AgentState {
      return rebindForkAgentState(
        requireState26(state),
        targetSessionId,
        targetRecoveryIdentityKey,
      );
    },
    canFork(state: AgentState): boolean {
      return canForkAgentState(requireState26(state));
    },
    isCurrentPendingInteractionRequest(state: AgentState, event: RuntimeEvent): boolean {
      assertCurrentRuntimeEvent(event);
      return isCurrentPendingInteractionRequest(requireState26(state), event);
    },
  });
}

/** Bind the current State26 Kernel format to the generic Host storage port once. */
export function createRuntimeHostState26StorageBindingV1(): RuntimeHostState26StorageBindingV1 {
  return Object.freeze({
    codec: createState26Codec(),
  });
}
