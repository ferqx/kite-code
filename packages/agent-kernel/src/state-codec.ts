import type { KernelEvent } from './events';
import { assertAgentStateInvariants } from './invariants';
import { createToolRecoveryJournalV1 } from './recovery';
import { eventRecord, recordField, stringField } from './reducer-utils';
import { type AgentState, RUNTIME_STATE_FORMAT_EPOCH, RUNTIME_STATE_SCHEMA_VERSION } from './state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact current-format marker used by SQLite/App snapshot codecs. */
export function isCurrentAgentStateSnapshot(value: unknown): value is AgentState {
  return (
    isRecord(value) &&
    value.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
    value.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH
  );
}

export function decodeCurrentAgentStateJson(serialized: string): AgentState {
  const value = JSON.parse(serialized) as unknown;
  if (!isCurrentAgentStateSnapshot(value)) {
    throw new Error('Runtime snapshot is not State25/current-epoch data.');
  }
  assertAgentStateInvariants(value);
  return value;
}

export function encodeCurrentAgentStateJson(state: AgentState): string {
  assertAgentStateInvariants(state);
  const encoded = JSON.stringify(state);
  if (encoded === undefined) throw new Error('Runtime snapshot could not be encoded.');
  return encoded;
}

function cloneState(state: AgentState): AgentState {
  return decodeCurrentAgentStateJson(encodeCurrentAgentStateJson(state));
}

/**
 * State25 fork sanitization. Cleanup authority and approval/binding state stay
 * owned by the source session; only the durable conversation/work projection
 * is copied into the target session.
 */
export function rebindForkAgentState(
  sourceState: AgentState,
  targetThreadId: string,
  targetRecoveryIdentityKey: string,
): AgentState {
  const forkState = cloneState(sourceState) as unknown as Record<string, unknown>;
  const session = forkState.session as Record<string, unknown>;
  session.threadId = targetThreadId;

  const authorization = forkState.authorization as Record<string, unknown>;
  authorization.mode = 'default';
  authorization.commandGrants = {};
  delete authorization.modeSource;
  delete authorization.modeGrantedAt;
  if (forkState.mode === 'full') forkState.mode = 'accept_edits';

  const capabilities = forkState.capabilities as Record<string, unknown>;
  capabilities.bindings = {};
  capabilities.disclosures = {};
  delete capabilities.pendingSearch;
  const invocations = recordField(capabilities, 'invocations');
  if (invocations) {
    for (const invocation of Object.values(invocations)) {
      if (!isRecord(invocation)) continue;
      const lifecycle = recordField(invocation, 'subagentProviderLifecycle');
      if (lifecycle && stringField(lifecycle, 'status') === 'cleanup_completed') {
        delete invocation.subagentProviderLifecycle;
      }
    }
  }

  const providerAdmission = forkState.providerAdmission as Record<string, unknown>;
  providerAdmission.pending = [];
  providerAdmission.waivers = {};
  forkState.interactions = { kind: 'idle' };
  forkState.tools = {
    ...(forkState.tools as AgentState['tools']),
    queue: [],
    active: [],
  };
  forkState.suspendedSubagents = {};
  forkState.toolRecovery = createToolRecoveryJournalV1(targetRecoveryIdentityKey);
  const rebound = forkState as unknown as AgentState;
  assertAgentStateInvariants(rebound);
  return rebound;
}

export function hasPendingSandboxCleanupAuthority(state: AgentState): boolean {
  const invocations = recordField(state.capabilities, 'invocations') ?? {};
  return Object.values(invocations).some((invocation) => {
    if (!isRecord(invocation)) return false;
    const ready = recordField(invocation, 'sandboxPreparationReady');
    if (ready) {
      return (
        stringField(recordField(invocation, 'sandboxDisposal') ?? {}, 'status') !== 'completed'
      );
    }
    return (
      recordField(invocation, 'sandboxPreparationIntent') !== undefined &&
      stringField(recordField(invocation, 'sandboxPreparationAbandonment') ?? {}, 'status') !==
        'completed'
    );
  });
}

export function hasPendingSubagentCleanupAuthority(state: AgentState): boolean {
  const invocations = recordField(state.capabilities, 'invocations') ?? {};
  return Object.values(invocations).some(
    (invocation) =>
      isRecord(invocation) &&
      recordField(invocation, 'subagentProviderLifecycle') !== undefined &&
      stringField(recordField(invocation, 'subagentProviderLifecycle') ?? {}, 'status') !==
        'cleanup_completed',
  );
}

export function canForkAgentState(state: AgentState): boolean {
  return !hasPendingSandboxCleanupAuthority(state) && !hasPendingSubagentCleanupAuthority(state);
}

/** Exclude the single pending interaction request from a sanitized current fork. */
export function isCurrentPendingInteractionRequest(
  sourceState: AgentState,
  event: KernelEvent,
): boolean {
  const interaction = sourceState.interactions;
  const kind = stringField(interaction, 'kind');
  const interactionId = stringField(interaction, 'interactionId');
  if (!kind || !interactionId) return false;
  const payload = eventRecord(event);
  switch (kind) {
    case 'awaiting_user_input':
      return (
        event.type === 'user_input.requested' &&
        stringField(payload, 'interactionId') === interactionId
      );
    case 'awaiting_tool_approval':
      return (
        event.type === 'approval.requested' &&
        stringField(payload, 'interactionId') === interactionId
      );
    case 'awaiting_review':
      return (
        event.type === 'plan.review_requested' &&
        stringField(payload, 'interactionId') === interactionId
      );
    case 'awaiting_provider_action':
      return (
        event.type === 'provider.action_required' &&
        stringField(payload, 'interactionId') === interactionId
      );
    case 'awaiting_provider_admission':
      return (
        event.type === 'provider.admission_required' &&
        stringField(payload, 'interactionId') === interactionId
      );
    case 'awaiting_auto_review':
      return (
        event.type === 'auto_review.requested' && stringField(payload, 'reviewId') === interactionId
      );
    default:
      return false;
  }
}
