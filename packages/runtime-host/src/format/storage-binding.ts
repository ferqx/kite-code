import {
  type AgentState,
  assertAgentStateInvariants,
  assertCurrentRuntimeEvent,
  assertCurrentRuntimeEventForWrite,
  canForkAgentState,
  classifyAgentStateFormat,
  convertLegacyRuntimeEventJson,
  decodeAgentStateWithCompatibility,
  decodeCurrentAgentStateJson,
  decodeCurrentRuntimeEventJson,
  encodeCurrentAgentStateJson,
  encodeCurrentRuntimeEventJson,
  hasUnresolvedToolFailures,
  isCurrentAgentStateSnapshot,
  isCurrentPendingInteractionRequest,
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeEvent,
  rebindForkAgentState,
} from '@kite-ai/agent-kernel';
import type { RuntimeCompatibleRecordFormat, RuntimeSnapshotCodec } from '../storage';

export interface RuntimeHostStateStorageBinding {
  readonly codec: RuntimeSnapshotCodec<RuntimeEvent, AgentState>;
}

const TERMINAL_TOOL_STATUSES = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);
const TERMINAL_APPROVAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

/** Exact State half of a Runtime Store generation offline-maintenance barrier. */
export function isRuntimeHostStateSettledForMigration(state: Readonly<AgentState>): boolean {
  if (state.turn.status === 'active' || state.interactions.kind !== 'idle') return false;
  if (state.terminalOutcome?.knownExternalEffects === 'unknown') return false;
  if (
    Object.values(state.tools.calls).some((call) => !TERMINAL_TOOL_STATUSES.has(call.status)) ||
    Object.values(state.capabilities.invocations).some((invocation) =>
      ['recorded', 'running', 'unknown'].includes(invocation.status),
    ) ||
    Object.values(state.modelInvocations).some((invocation) =>
      ['prepared', 'dispatching'].includes(invocation.status),
    ) ||
    Object.values(state.providerReadiness).some((readiness) =>
      ['prepared', 'attempted'].includes(readiness.status),
    ) ||
    [...state.pendingApprovals.values()].some(
      (approval) => !TERMINAL_APPROVAL_STATUSES.has(approval.status),
    ) ||
    [...state.approvalReceipts.values()].some((receipt) => receipt.status !== 'terminal') ||
    Object.values(state.skills.frames).some((frame) => frame.status === 'active') ||
    Object.keys(state.suspendedSubagents).length !== 0 ||
    state.providerAdmission.pending.length !== 0 ||
    hasUnresolvedToolFailures(state.toolRecovery) ||
    !canForkAgentState(state)
  ) {
    return false;
  }
  return true;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requireState(value: unknown): AgentState {
  if (!isCurrentAgentStateSnapshot(value)) {
    throw new Error('Runtime snapshot is not State/current-epoch data.');
  }
  assertAgentStateInvariants(value);
  return value;
}

function createStateCodec(): RuntimeSnapshotCodec<RuntimeEvent, AgentState> {
  return Object.freeze({
    encodeEvent(event: RuntimeEvent): string {
      assertCurrentRuntimeEventForWrite(event);
      return encodeCurrentRuntimeEventJson(event);
    },
    encodeHistoricalEvent(event: RuntimeEvent): string {
      assertCurrentRuntimeEvent(event);
      return encodeCurrentRuntimeEventJson(event);
    },
    decodeEvent(json: string): RuntimeEvent {
      return decodeCurrentRuntimeEventJson(json);
    },
    decodeCompatibleEvent(
      json: string,
      format: RuntimeCompatibleRecordFormat,
    ): RuntimeEvent | null {
      if (
        format.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
        format.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH
      ) {
        try {
          return decodeCurrentRuntimeEventJson(json);
        } catch {
          return null;
        }
      }
      const converted = convertLegacyRuntimeEventJson(json);
      if (
        format.schemaVersion !== LEGACY_STATE26_SCHEMA_VERSION ||
        format.formatEpoch !== LEGACY_STATE26_FORMAT_EPOCH ||
        converted.status !== 'converted'
      )
        return null;
      try {
        assertCurrentRuntimeEvent(converted.event);
        return converted.event;
      } catch {
        return null;
      }
    },
    encodeState(state: AgentState): string {
      return encodeCurrentAgentStateJson(requireState(state));
    },
    decodeState<T = AgentState>(json: string): T {
      return decodeCurrentAgentStateJson(json) as unknown as T;
    },
    decodeCompatibleState(json: string, format: RuntimeCompatibleRecordFormat): AgentState | null {
      let value: unknown;
      try {
        value = JSON.parse(json) as unknown;
      } catch {
        return null;
      }
      const classification = classifyAgentStateFormat(value);
      if (
        classification === 'current' &&
        format.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
        format.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH
      ) {
        try {
          return decodeCurrentAgentStateJson(json);
        } catch {
          return null;
        }
      }
      if (
        classification !== 'state26' ||
        format.schemaVersion !== LEGACY_STATE26_SCHEMA_VERSION ||
        format.formatEpoch !== LEGACY_STATE26_FORMAT_EPOCH
      )
        return null;
      const migrated = decodeAgentStateWithCompatibility(json);
      return migrated.status === 'migrated' ? migrated.state : null;
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
      const candidate = requireState(state);
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
        throw new Error('State session project identity is missing.');
      }
      return {
        projectId: session.projectId,
        canonicalWorkspaceDigest: session.canonicalWorkspaceDigest,
      };
    },
    recoveryIdentity(state: AgentState): string {
      return requireState(state).toolRecovery.identityKey;
    },
    validateSnapshot(input: {
      readonly state: AgentState;
      readonly sessionId: string;
      readonly eventPosition: number;
      readonly stateRevision: number;
      readonly schemaVersion: number;
      readonly eventRevision: number;
    }) {
      const state = requireState(input.state);
      if (
        state.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        state.formatEpoch !== RUNTIME_STATE_FORMAT_EPOCH ||
        state.session.threadId !== input.sessionId ||
        state.revision !== input.stateRevision ||
        input.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        input.eventRevision !== input.stateRevision ||
        input.eventPosition < 0
      ) {
        throw new Error('Runtime State snapshot identity or revision is invalid.');
      }
    },
    rebindForkState(
      state: AgentState,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
    ): AgentState {
      return rebindForkAgentState(requireState(state), targetSessionId, targetRecoveryIdentityKey);
    },
    canFork(state: AgentState): boolean {
      return canForkAgentState(requireState(state));
    },
    isCurrentPendingInteractionRequest(state: AgentState, event: RuntimeEvent): boolean {
      assertCurrentRuntimeEvent(event);
      return isCurrentPendingInteractionRequest(requireState(state), event);
    },
  });
}

/** Bind the current State Kernel format to the generic Host storage port once. */
export function createRuntimeHostStateStorageBinding(): RuntimeHostStateStorageBinding {
  return Object.freeze({
    codec: createStateCodec(),
  });
}
