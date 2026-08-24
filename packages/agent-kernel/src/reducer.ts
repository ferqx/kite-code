import { assertCurrentRuntimeEvent } from './codec';
import { reduceAuthorizationState } from './core/authorization/reducer';
import { reduceCompletionState } from './core/completion/reducer';
import { reduceIntentState } from './core/intent/reducer';
import { reduceLeaseState } from './core/lease/reducer';
import { reduceLifecycleState } from './core/lifecycle/reducer';
import { reduceCapabilityState } from './domains/capability/reducer';
import { reduceContextState } from './domains/context/reducer';
import { reduceInteractionState } from './domains/interaction/reducer';
import { reduceRecoveryState } from './domains/recovery/reducer';
import { reduceVerificationState } from './domains/verification/reducer';
import { reduceWorkState } from './domains/work/reducer';
import type { RuntimeEffect } from './effects';
import type { KernelEvent } from './events';
import { sha256Hex } from './hash';
import {
  assertCanonicalToolOutcomeEvent,
  normalizeAgentToolOutcomeEvent,
  normalizeTerminalAgentEvent,
} from './normalization';
import type { SchedulerFacts } from './scheduler';
import { selectPendingEffects as selectScheduledEffects } from './scheduler';
import type { AgentState } from './state';
import type { VerificationSchemaAdmissionFact } from './verification-schema-facts';

export type PendingEffect = RuntimeEffect;

/** Transient, Host-projected facts consumed during one fixed reducer pass. */
export interface AgentReducerFacts {
  readonly allocatedTaskId?: string;
  /** Index-aligned with VerificationSpec.checks; never persisted in State. */
  readonly verificationSchemaAdmissions?: readonly (VerificationSchemaAdmissionFact | null)[];
}

type AgentStateReducer = (
  state: AgentState,
  event: KernelEvent,
  facts?: AgentReducerFacts,
) => AgentState;

/**
 * The order is part of the State 27 replay contract.  It is a literal,
 * compile-time list: there is no reducer registration, injection, or module
 * discovery API.
 */
export const FIXED_AGENT_STATE_REDUCERS: readonly AgentStateReducer[] = Object.freeze([
  reduceLifecycleState,
  reduceAuthorizationState,
  // Recovery must observe the pre-transition Tool lifecycle status. This
  // preserves the State 27 rule that late terminal events are complete no-ops
  // while the Intent reducer remains the sole owner of Tool call projection.
  reduceRecoveryState,
  reduceIntentState,
  reduceLeaseState,
  reduceCompletionState,
  reduceWorkState,
  reduceInteractionState,
  reduceCapabilityState,
  reduceContextState,
  reduceVerificationState,
]);

const FINALIZED_CREATED_AT_EVENTS: readonly string[] = [
  'user.message_appended',
  'model.responded',
  'tool.finished',
  'tool.failed',
  'tool.rejected',
  'tool.cancelled',
  'tool.queued',
  'tool.started',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'auto_review.requested',
  'auto_review.completed',
];

/** Normalize current terminal facts without reading ambient time or identity. */
export function normalizeAgentEvent<Event extends KernelEvent>(
  event: Event,
  _state: Readonly<AgentState>,
  _occurredAt: string,
): Event {
  assertCurrentRuntimeEvent(event);
  return normalizeAgentToolOutcomeEvent(
    normalizeTerminalAgentEvent(event),
    _state,
    _occurredAt,
  ) as Event;
}

/** Add only the legacy optional createdAt fact supplied by Host. */
export function finalizeAgentEvent<Event extends KernelEvent>(
  event: Event,
  occurredAt: string,
): Event {
  if (FINALIZED_CREATED_AT_EVENTS.includes(event.type)) {
    if (!Object.hasOwn(event, 'createdAt')) {
      return { ...event, createdAt: occurredAt };
    }
  }
  return event;
}

/** State 27 event identity: SHA-256(JSON.stringify(event)) with no canonical rewrite. */
export function digestAgentEvent(event: KernelEvent): string {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) throw new Error('Runtime event cannot be serialized.');
  return sha256Hex(serialized);
}

/** Apply the fixed eleven-domain reducer list; callers cannot supply a domain. */
export function reduceAgentState(
  state: AgentState,
  event: KernelEvent,
  facts: AgentReducerFacts = {},
): AgentState {
  assertCurrentRuntimeEvent(event);
  const normalized = normalizeTerminalAgentEvent(event);
  assertCanonicalToolOutcomeEvent(normalized);
  let next = state;
  for (const reducer of FIXED_AGENT_STATE_REDUCERS) next = reducer(next, normalized, facts);
  return next;
}

/** Select effects from State 27 queue order, without inspecting tool names. */
export function selectPendingEffects(
  state: Readonly<AgentState>,
  facts?: SchedulerFacts,
): readonly PendingEffect[] {
  return selectScheduledEffects(state as AgentState, facts);
}
