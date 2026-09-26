import type { RuntimeEffect, RuntimeEvent, RuntimeState } from '@kite-ai/agent-kernel';
import type {
  RuntimeAgentMailboxMutation,
  RuntimeCommandCommitEvidence,
  RuntimeCrossSessionAgentMailMutation,
  RuntimeEffectLeaseExpectation,
  RuntimeSealedChildGrantPayload,
  RuntimeStoredCommandReceipt,
} from '../storage';

export interface StateRuntimeAgentMailboxCommandCommit<Event = RuntimeEvent> {
  readonly events: readonly Event[];
  readonly mutations: readonly RuntimeAgentMailboxMutation[];
  readonly evidence: RuntimeCommandCommitEvidence;
}

export interface StateRuntimeAgentMailboxFactsCommit<Event = RuntimeEvent> {
  readonly events: readonly Event[];
  readonly mutations: readonly RuntimeAgentMailboxMutation[];
}

/** Mutable in-process lease for one State 27 effect attempt. */
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
  /** Persisted Run identity, when a Run still owns this Session execution. */
  currentRunId?(): string | null;
  waitForRevisionChange?(revision: number, signal?: AbortSignal): Promise<void>;
  persistEvent(event: Event): Promise<boolean>;
  persistEvents(
    events: Event[],
    requiredEffectLease?: RuntimeEffectLeaseExpectation,
  ): Promise<boolean>;
  /** Commit one current-turn route under this exact Model effect lease. */
  commitCurrentTurnFollowupRoute?(
    events: readonly [
      Extract<RuntimeEvent, { type: 'agent.followup_routed' }>,
      Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }>,
    ],
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
  ): Promise<readonly Event[]>;
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
  /** Available only during the active run_tools effect; never exposes mutable Session. */
  commitAgentMailboxCommand?(
    input: StateRuntimeAgentMailboxCommandCommit<Event>,
  ): Promise<RuntimeStoredCommandReceipt>;
  /** Exact active Tool effect may commit child registration facts with its dispatch intent. */
  commitAgentMailboxFacts?(
    input: StateRuntimeAgentMailboxFactsCommit<Event>,
  ): Promise<readonly Event[]>;
  /** Parent intent, delegated reservation and running Task receipt share one Store transaction. */
  commitBackgroundChildAcceptance?(
    events: readonly Event[],
    requiredEffectLease: RuntimeEffectLeaseExpectation,
    sealedGrant: RuntimeSealedChildGrantPayload,
  ): Promise<boolean>;
  /** Root model Surface and mailbox watermark share one Store transaction. */
  persistAgentMailModelAdmission?(input: {
    readonly events: readonly Event[];
    readonly mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>;
  }): Promise<readonly Event[]>;
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

/** Host execution port used by the State 27 coordinator. */
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
