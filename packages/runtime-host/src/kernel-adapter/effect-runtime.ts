import type { RuntimeEffect, RuntimeEvent, RuntimeState } from '@kite/agent-kernel';
import type { RuntimeEffectLeaseExpectation } from '../storage';

/** Mutable in-process lease for one State 25 effect attempt. */
export interface StateRuntimeEffectLease {
  readonly effectId: string;
  expectedRevision: number;
  readonly turnId: string;
  readonly effect: RuntimeEffect;
}

/**
 * Effect persistence acknowledgements are deliberately narrower than the
 * command/decision channel.  A runner may publish only one of these through
 * an effect lease; command decisions continue to use the State session's
 * normal processEvent/processEventBatch surface.
 */
export type StateRuntimeEffectPersistenceAcknowledgement =
  | 'attempt_start'
  | 'receipt_evidence'
  | 'terminal_recovery';

export type StateRuntimeEffectEventSink<Event = RuntimeEvent> = (event: Event) => void;

export interface StateRuntimeEffectExecutionContext<State = RuntimeState, Event = RuntimeEvent> {
  readonly reservationIds: readonly string[];
  getState?(): Readonly<State>;
  persistEvent(event: Event): Promise<boolean>;
  persistEvents(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): Promise<boolean>;
  /** Persist effect-attempt facts through Store 4's attempt_start channel. */
  persistAttemptStartEvents?(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): Promise<boolean>;
  /** Persist unknown/cancellation recovery facts through terminal_recovery. */
  persistTerminalRecoveryEvents?(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): Promise<boolean>;
  persistLateResourceReconciliation?(
    event: Extract<Event, { type: 'resource_budget.reconciled' }>,
  ): Promise<boolean>;
}

/** Explicit non-terminal result for an effect still owned by another Host attempt. */
export interface StateRuntimeEffectDeferred<Event = RuntimeEvent> extends Array<Event> {
  deferred: {
    reason: string;
    retryAfterMs: number;
  };
}

export function deferredStateRuntimeEffect(
  reason: string,
  retryAfterMs: number,
): StateRuntimeEffectDeferred<never> {
  return Object.assign([], { deferred: { reason, retryAfterMs } });
}

export function isStateRuntimeEffectDeferred<Event>(
  result: Event[],
): result is StateRuntimeEffectDeferred<Event> {
  return 'deferred' in result;
}

/** Host execution port used by the State 25 coordinator. */
export type StateRuntimeEffectExecutor<
  State = RuntimeState,
  Event = RuntimeEvent,
  Effect = RuntimeEffect,
> = (
  effect: Effect,
  state: Readonly<State>,
  emit?: StateRuntimeEffectEventSink<Event>,
  context?: StateRuntimeEffectExecutionContext<State, Event>,
) => Promise<Event[]>;
