import type { RuntimeEffect, RuntimeEvent, RuntimeState } from '@kite/agent-kernel';
import type { RuntimeEffectLeaseExpectationV1 } from './storage';

/** Mutable in-process lease for one State 25 effect attempt. */
export interface State26RuntimeEffectLeaseV1 {
  readonly effectId: string;
  expectedRevision: number;
  readonly turnId: string;
  readonly effect: RuntimeEffect;
}

/**
 * Effect persistence acknowledgements are deliberately narrower than the
 * command/decision channel.  A runner may publish only one of these through
 * an effect lease; command decisions continue to use the State26 session's
 * normal processEvent/processEventBatch surface.
 */
export type State26RuntimeEffectPersistenceAcknowledgementV1 =
  | 'attempt_start'
  | 'receipt_evidence'
  | 'terminal_recovery';

export type State26RuntimeEffectEventSinkV1<Event = RuntimeEvent> = (event: Event) => void;

export interface State26RuntimeEffectExecutionContextV1<
  State = RuntimeState,
  Event = RuntimeEvent,
> {
  readonly reservationIds: readonly string[];
  getState?(): Readonly<State>;
  persistEvent(event: Event): Promise<boolean>;
  persistEvents(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
  ): Promise<boolean>;
  /** Persist effect-attempt facts through Store 4's attempt_start channel. */
  persistAttemptStartEvents?(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
  ): Promise<boolean>;
  /** Persist unknown/cancellation recovery facts through terminal_recovery. */
  persistTerminalRecoveryEvents?(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectationV1,
  ): Promise<boolean>;
  persistLateResourceReconciliation?(
    event: Extract<Event, { type: 'resource_budget.reconciled' }>,
  ): Promise<boolean>;
}

/** Explicit non-terminal result for an effect still owned by another Host attempt. */
export interface State26RuntimeEffectDeferredV1<Event = RuntimeEvent> extends Array<Event> {
  deferred: {
    reason: string;
    retryAfterMs: number;
  };
}

export function deferredState26RuntimeEffectV1(
  reason: string,
  retryAfterMs: number,
): State26RuntimeEffectDeferredV1<never> {
  return Object.assign([], { deferred: { reason, retryAfterMs } });
}

export function isState26RuntimeEffectDeferredV1<Event>(
  result: Event[],
): result is State26RuntimeEffectDeferredV1<Event> {
  return 'deferred' in result;
}

/** Host execution port used by the State 25 coordinator. */
export type State26RuntimeEffectExecutorV1<
  State = RuntimeState,
  Event = RuntimeEvent,
  Effect = RuntimeEffect,
> = (
  effect: Effect,
  state: Readonly<State>,
  emit?: State26RuntimeEffectEventSinkV1<Event>,
  context?: State26RuntimeEffectExecutionContextV1<State, Event>,
) => Promise<Event[]>;
