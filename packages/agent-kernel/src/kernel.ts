import { assertCurrentRuntimeEvent } from './codec';
import type { KernelEvent, KernelEventEnvelope } from './events';
import { sha256Hex } from './hash';
import {
  type AgentReducerFacts,
  digestAgentEvent,
  finalizeAgentEvent,
  normalizeAgentEvent,
  type PendingEffect,
  reduceAgentState,
  selectPendingEffects as selectStatePendingEffects,
} from './reducer';
import type { SchedulerFacts } from './scheduler';
import type { AgentState } from './state';
import type { VerificationSchemaAdmissionFact } from './verification-schema-facts';

export type { KernelEvent, KernelEventEnvelope, RuntimeEvent } from './events';
export type { SchedulerFacts } from './scheduler';
export type { AgentState, RuntimeState } from './state';

/** Minimal RM single-use execution identity. */
export interface AuthorizedEffect {
  readonly schema: 'kite.authorized-effect.rmv1';
  readonly sessionId: string;
  readonly operationId: string;
  readonly operation: 'turn' | 'compaction';
  readonly committedRevision: number;
}

export function authorizeEffect(input: Omit<AuthorizedEffect, 'schema'>): AuthorizedEffect {
  if (
    !input.sessionId ||
    !input.operationId ||
    !Number.isSafeInteger(input.committedRevision) ||
    input.committedRevision < 0
  ) {
    throw new Error('AuthorizedEffect identity is invalid.');
  }
  return Object.freeze({ schema: 'kite.authorized-effect.rmv1', ...input });
}

/** Host may carry a private command-observation DTO before Kernel translation;
 * only `decide` accepts the persisted KernelEvent union. */
export type KernelInput<Event = KernelEvent> = {
  readonly source: 'command' | 'receipt' | 'host_fact';
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly events: readonly Event[];
  readonly causationId?: string;
};

export interface DecisionEventFact {
  readonly occurredAt: string;
  /** Host-compiled schema admissions for one verification.requested payload. */
  readonly verificationSchemaAdmissions?: readonly (VerificationSchemaAdmissionFact | null)[];
}

/** Canonical, JSON-safe facts projected by Host; never callbacks or handles. */
export interface DecisionFacts {
  readonly schema: 'kite.kernel-decision-facts.v1';
  readonly eventFacts: readonly DecisionEventFact[];
  readonly knownEventIds: readonly string[];
  readonly allocatedIds: Readonly<Record<string, string>>;
  readonly workspace: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly protectedPath: Readonly<Record<string, unknown>>;
  readonly network: Readonly<Record<string, unknown>>;
  readonly executionBoundary: Readonly<Record<string, unknown>>;
  readonly attempt: Readonly<Record<string, unknown>>;
  /** Host-projected, immutable scheduling facts; never persisted in State. */
  readonly scheduler?: SchedulerFacts;
}

/** Stable transient-fact key for a Task identity allocated for one user event. */
export function taskIdentityAllocationKey(eventIndex: number, messageId: string): string {
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0 || !messageId) {
    throw new Error('Task identity allocation key input is invalid.');
  }
  return `task:user-message:${eventIndex}:${sha256Hex(messageId)}`;
}

export type KernelDecision<
  State extends AgentState = AgentState,
  Event extends KernelEvent = KernelEvent,
  Effect extends PendingEffect = PendingEffect,
> =
  | {
      readonly status: 'applied';
      readonly events: readonly Event[];
      readonly envelopes: readonly KernelEventEnvelope<Event>[];
      readonly nextState: State;
      readonly pendingEffects: readonly Effect[];
    }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly events?: readonly Event[];
      readonly pendingEffects?: readonly Effect[];
    }
  | { readonly status: 'conflict'; readonly code: string; readonly currentRevision: number }
  | { readonly status: 'idempotent_replay'; readonly originalRevision: number };

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isCanonicalJsonValue(entry, ancestors));
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(
      (descriptor) =>
        'value' in descriptor &&
        descriptor.enumerable &&
        isCanonicalJsonValue(descriptor.value, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

function validVerificationSchemaAdmissions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (entry === null) return true;
    if (!isPlainRecord(entry)) return false;
    const keys = Object.keys(entry);
    if (
      keys.length === 0 ||
      keys.some(
        (key) =>
          key !== 'schemaDigest' &&
          key !== 'schemaDiagnostic' &&
          key !== 'outputSchemaDigest' &&
          key !== 'outputSchemaDiagnostic',
      )
    ) {
      return false;
    }
    const hasSchemaDigest = Object.hasOwn(entry, 'schemaDigest');
    const hasSchemaDiagnostic = Object.hasOwn(entry, 'schemaDiagnostic');
    const hasOutputSchemaDigest = Object.hasOwn(entry, 'outputSchemaDigest');
    const hasOutputSchemaDiagnostic = Object.hasOwn(entry, 'outputSchemaDiagnostic');
    if (
      hasSchemaDigest !== hasSchemaDiagnostic ||
      hasOutputSchemaDigest !== hasOutputSchemaDiagnostic
    ) {
      return false;
    }
    return keys.every((key) => {
      const projected = entry[key];
      if (key === 'schemaDigest' || key === 'outputSchemaDigest') {
        return typeof projected === 'string' && /^[a-f0-9]{64}$/u.test(projected);
      }
      return projected === null || (typeof projected === 'string' && projected.length > 0);
    });
  });
}

function validDecisionFacts(facts: DecisionFacts): boolean {
  if (!isPlainRecord(facts) || facts.schema !== 'kite.kernel-decision-facts.v1') return false;
  if (
    !Array.isArray(facts.eventFacts) ||
    !facts.eventFacts.every(
      (fact) =>
        isPlainRecord(fact) &&
        typeof fact.occurredAt === 'string' &&
        validTimestamp(fact.occurredAt) &&
        validVerificationSchemaAdmissions(fact.verificationSchemaAdmissions),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(facts.knownEventIds) ||
    !facts.knownEventIds.every((eventId) => typeof eventId === 'string' && eventId.length > 0)
  ) {
    return false;
  }
  if (!isPlainRecord(facts.allocatedIds)) {
    return false;
  }
  const allocatedEntries = Object.entries(facts.allocatedIds);
  if (
    !allocatedEntries.every(
      ([key, value]) => key.length > 0 && typeof value === 'string' && value.length > 0,
    ) ||
    new Set(allocatedEntries.map(([, value]) => value)).size !== allocatedEntries.length
  )
    return false;
  return [
    facts.workspace,
    facts.policy,
    facts.provider,
    facts.protectedPath,
    facts.network,
    facts.executionBoundary,
    facts.attempt,
  ].every((value) => isPlainRecord(value) && isCanonicalJsonValue(value, new Set<object>()));
}

/**
 * Decide a State 25 transition. Domain ownership is compile-time fixed in
 * reduceAgentState; there is intentionally no caller-supplied reducer parameter.
 */
export function decide<
  State extends AgentState = AgentState,
  Event extends KernelEvent = KernelEvent,
  Effect extends PendingEffect = PendingEffect,
>(
  state: Readonly<State>,
  input: KernelInput<Event>,
  facts: DecisionFacts,
): KernelDecision<State, Event, Effect> {
  if (input.sessionId !== state.session.threadId) {
    return { status: 'rejected', code: 'session_identity_mismatch' };
  }
  if (input.expectedRevision !== state.revision) {
    return { status: 'conflict', code: 'revision_conflict', currentRevision: state.revision };
  }
  if (!validDecisionFacts(facts) || facts.eventFacts.length !== input.events.length) {
    return { status: 'rejected', code: 'invalid_decision_facts' };
  }

  let nextState = state as State;
  const seen = new Set([...(state.appliedEventIds ?? []), ...facts.knownEventIds]);
  const payloads: Event[] = [];
  const envelopes: KernelEventEnvelope<Event>[] = [];
  for (const [index, candidate] of input.events.entries()) {
    assertCurrentRuntimeEvent(candidate);
    const eventFact = facts.eventFacts[index]!;
    const normalized = normalizeAgentEvent(candidate, nextState, eventFact.occurredAt);
    const eventId = digestAgentEvent(normalized);
    if (seen.has(eventId)) continue;
    const payload = finalizeAgentEvent(normalized, eventFact.occurredAt) as Event;
    let reducerFacts: AgentReducerFacts =
      payload.type === 'verification.requested'
        ? { verificationSchemaAdmissions: eventFact.verificationSchemaAdmissions }
        : {};
    if (
      payload.type !== 'verification.requested' &&
      eventFact.verificationSchemaAdmissions !== undefined
    ) {
      return { status: 'rejected', code: 'unexpected_verification_schema_admission_facts' };
    }
    if (payload.type === 'user.message_appended' && nextState.activeTaskId === null) {
      const messageId = (payload as unknown as Readonly<Record<string, unknown>>).messageId;
      if (typeof messageId !== 'string' || messageId.length === 0) {
        return { status: 'rejected', code: 'allocated_task_identity_invalid' };
      }
      const allocationKey = taskIdentityAllocationKey(index, messageId);
      const allocatedTaskId = facts.allocatedIds[allocationKey];
      if (!allocatedTaskId) {
        return { status: 'rejected', code: 'allocated_task_identity_missing' };
      }
      if (nextState.tasks[allocatedTaskId]) {
        return { status: 'rejected', code: 'allocated_task_identity_conflict' };
      }
      reducerFacts = { ...reducerFacts, allocatedTaskId };
    }
    const revision = nextState.revision + 1;
    const reduced = reduceAgentState(nextState, payload, reducerFacts) as State;
    if (
      reducerFacts.allocatedTaskId !== undefined &&
      reduced.activeTaskId !== reducerFacts.allocatedTaskId
    ) {
      return { status: 'rejected', code: 'allocated_task_identity_not_applied' };
    }
    nextState = {
      ...reduced,
      revision,
      lastAppliedEventId: eventId,
      appliedEventIds: [...reduced.appliedEventIds, eventId].slice(-4096),
    } as State;
    seen.add(eventId);
    payloads.push(payload);
    envelopes.push({
      eventId,
      sessionId: input.sessionId,
      revision,
      occurredAt: eventFact.occurredAt,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      payload,
    });
  }
  if (payloads.length === 0) {
    return { status: 'idempotent_replay', originalRevision: state.revision };
  }
  return {
    status: 'applied',
    events: payloads,
    envelopes,
    nextState,
    pendingEffects: selectStatePendingEffects(nextState, facts.scheduler) as readonly Effect[],
  };
}

export function reduce<
  State extends AgentState = AgentState,
  Event extends KernelEvent = KernelEvent,
>(state: Readonly<State>, events: readonly Event[]): State {
  let nextState = state as State;
  for (const event of events) nextState = reduceAgentState(nextState, event) as State;
  return nextState;
}

export function selectPendingEffects<State extends AgentState = AgentState>(
  state: Readonly<State>,
  facts?: SchedulerFacts,
): readonly PendingEffect[] {
  return selectStatePendingEffects(state, facts);
}
