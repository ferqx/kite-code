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
import type { RuntimeSnapshotCodecV1, RuntimeUniqueReceiptV1 } from './storage';

export interface RuntimeHostState25StorageBindingV1 {
  readonly codec: RuntimeSnapshotCodecV1<RuntimeEvent, AgentState>;
  readonly uniqueReceiptForEvent: (event: unknown) => RuntimeUniqueReceiptV1 | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function requireState25(value: unknown): AgentState {
  if (!isCurrentAgentStateSnapshot(value)) {
    throw new Error('Runtime snapshot is not State25/current-epoch data.');
  }
  assertAgentStateInvariants(value);
  return value;
}

function createState25Codec(): RuntimeSnapshotCodecV1<RuntimeEvent, AgentState> {
  return Object.freeze({
    encodeEvent(event: RuntimeEvent): string {
      assertCurrentRuntimeEvent(event);
      return encodeCurrentRuntimeEventJson(event);
    },
    decodeEvent(json: string): RuntimeEvent {
      return decodeCurrentRuntimeEventJson(json);
    },
    encodeState(state: AgentState): string {
      return encodeCurrentAgentStateJson(requireState25(state));
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
      const candidate = requireState25(state);
      return {
        stateRevision: candidate.revision,
        schemaVersion: candidate.schemaVersion,
      };
    },
    recoveryIdentity(state: AgentState): string {
      return requireState25(state).toolRecovery.identityKey;
    },
    validateSnapshot(input: {
      readonly state: AgentState;
      readonly sessionId: string;
      readonly eventPosition: number;
      readonly stateRevision: number;
      readonly schemaVersion: number;
      readonly eventRevision: number;
    }) {
      const state = requireState25(input.state);
      if (
        state.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        state.formatEpoch !== RUNTIME_STATE_FORMAT_EPOCH ||
        state.session.threadId !== input.sessionId ||
        state.revision !== input.stateRevision ||
        input.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
        input.eventRevision !== input.stateRevision ||
        input.eventPosition < 0
      ) {
        throw new Error('Runtime State 25 snapshot identity or revision is invalid.');
      }
    },
    rebindForkState(
      state: AgentState,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
    ): AgentState {
      return rebindForkAgentState(
        requireState25(state),
        targetSessionId,
        targetRecoveryIdentityKey,
      );
    },
    canFork(state: AgentState): boolean {
      return canForkAgentState(requireState25(state));
    },
    isCurrentPendingInteractionRequest(state: AgentState, event: RuntimeEvent): boolean {
      assertCurrentRuntimeEvent(event);
      return isCurrentPendingInteractionRequest(requireState25(state), event);
    },
  });
}

function uniqueReceiptForState25Event(event: unknown): RuntimeUniqueReceiptV1 | null {
  assertCurrentRuntimeEvent(event);
  if (event.type !== 'mcp.egress_decided') return null;
  const decision = record(record(event)?.decision);
  if (
    decision?.admitted !== true ||
    decision.reason !== 'permit_consumed' ||
    !requiredString(decision, 'nonceDigest') ||
    !requiredString(decision, 'permitExpiresAt')
  ) {
    return null;
  }
  const nonceDigest = requiredString(decision, 'nonceDigest')!;
  const invocationId = requiredString(decision, 'invocationId');
  const receiptDigest = requiredString(decision, 'receiptDigest');
  const expiresAt = requiredString(decision, 'permitExpiresAt')!;
  const pruneBefore = requiredString(decision, 'decidedAt');
  if (!invocationId || !receiptDigest || !pruneBefore) {
    throw new Error('Consumed MCP egress receipt identity is incomplete.');
  }
  return { nonceDigest, invocationId, receiptDigest, expiresAt, pruneBefore };
}

/** Bind the current State25 Kernel format to the generic Host storage port once. */
export function createRuntimeHostState25StorageBindingV1(): RuntimeHostState25StorageBindingV1 {
  return Object.freeze({
    codec: createState25Codec(),
    uniqueReceiptForEvent: uniqueReceiptForState25Event,
  });
}
