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
import type {
  RuntimeDataOriginRecordV1,
  RuntimeEgressAuthorityRecordV1,
  RuntimeSnapshotCodecV1,
  RuntimeUniqueReceiptV1,
} from './storage';

export interface RuntimeHostState26StorageBindingV1 {
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
        throw new Error('Runtime State 25 snapshot identity or revision is invalid.');
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
    dataOriginsForEvent(event: RuntimeEvent): readonly RuntimeDataOriginRecordV1[] {
      assertCurrentRuntimeEvent(event);
      const origins =
        event.type === 'model.invocation_prepared'
          ? event.dataOrigins
          : event.type === 'mcp.egress_decided' &&
              event.decision.admitted &&
              event.decision.reason === 'permit_consumed'
            ? event.decision.dataOrigins
            : undefined;
      if (!origins) {
        if (
          event.type === 'mcp.egress_decided' &&
          event.decision.admitted &&
          event.decision.reason === 'permit_consumed'
        ) {
          throw new Error('State26 admitted MCP receipt is missing DataOrigin lineage.');
        }
        return Object.freeze([]);
      }
      return Object.freeze(
        origins.map((origin) => {
          if (!origin.ownerProjectId) {
            throw new Error('State26 Model DataOrigin is missing its Project identity.');
          }
          return Object.freeze({
            originId: origin.originId,
            kind: origin.kind,
            classification: origin.classification,
            ownerProjectId: origin.ownerProjectId,
            parentOriginIds: Object.freeze([...origin.parentOriginIds].sort()),
            observationId: origin.observationId,
          });
        }),
      );
    },
    egressAuthoritiesForEvent(event: RuntimeEvent): readonly RuntimeEgressAuthorityRecordV1[] {
      assertCurrentRuntimeEvent(event);
      const authority =
        event.type === 'model.invocation_prepared'
          ? event.egressAuthority
          : event.type === 'mcp.egress_decided' &&
              event.decision.admitted &&
              event.decision.reason === 'permit_consumed'
            ? event.decision.egressAuthority
            : undefined;
      if (!authority) {
        if (
          event.type === 'mcp.egress_decided' &&
          event.decision.admitted &&
          event.decision.reason === 'permit_consumed'
        ) {
          throw new Error('State26 admitted MCP receipt is missing EgressAuthority.');
        }
        return Object.freeze([]);
      }
      const originIds =
        event.type === 'model.invocation_prepared'
          ? event.egressOriginIds
          : event.type === 'mcp.egress_decided'
            ? (event.decision.dataOrigins ?? []).map((origin) => origin.originId)
            : [];
      return Object.freeze([
        Object.freeze({
          egressId: authority.egressId,
          destinationId: authority.destination.destinationId,
          destinationKind: authority.destination.kind,
          routeIdentity: authority.destination.routeIdentity,
          nonceNamespace: authority.destination.nonceNamespace,
          invocationId: authority.invocationId,
          originIds: Object.freeze([...originIds].sort()),
          allowedClassifications: Object.freeze([...authority.allowedClassifications]),
          allowedOriginKinds: Object.freeze([...authority.allowedOriginKinds]),
          expiresAt: authority.expiresAt,
        }),
      ]);
    },
  });
}

function uniqueReceiptForState26Event(event: unknown): RuntimeUniqueReceiptV1 | null {
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
  const originDigest = requiredString(decision, 'originDigest');
  const routeIdentity = requiredString(decision, 'serverIdentity');
  const sourceOriginIds = Array.isArray(decision.sourceOriginIds)
    ? decision.sourceOriginIds.filter(
        (originId): originId is string => typeof originId === 'string' && originId.length > 0,
      )
    : [];
  const authority = record(decision.egressAuthority);
  const egressAuthorityId = authority ? requiredString(authority, 'egressId') : undefined;
  const expiresAt = requiredString(decision, 'permitExpiresAt')!;
  const pruneBefore = requiredString(decision, 'decidedAt');
  if (
    !invocationId ||
    !receiptDigest ||
    !originDigest ||
    !routeIdentity ||
    !egressAuthorityId ||
    sourceOriginIds.length === 0 ||
    !pruneBefore
  ) {
    throw new Error('Consumed MCP egress receipt identity is incomplete.');
  }
  return {
    nonceDigest,
    invocationId,
    receiptDigest,
    originDigest,
    sourceOriginIds: Object.freeze([...sourceOriginIds]),
    egressAuthorityId,
    routeIdentity,
    expiresAt,
    pruneBefore,
  };
}

/** Bind the current State26 Kernel format to the generic Host storage port once. */
export function createRuntimeHostState26StorageBindingV1(): RuntimeHostState26StorageBindingV1 {
  return Object.freeze({
    codec: createState26Codec(),
    uniqueReceiptForEvent: uniqueReceiptForState26Event,
  });
}
