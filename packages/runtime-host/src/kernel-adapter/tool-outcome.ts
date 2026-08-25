import {
  type AgentState,
  assertCanonicalToolOutcomeEvent,
  classifyToolOutcome,
  type KernelEvent,
  normalizeAgentToolOutcomeEvent,
  type ToolDispatchState,
  type ToolExternalEffects,
  type ToolOutcome,
  type ToolOutcomeDetailCode,
  type ToolOutcomeStatus,
  type ToolRecoveryDisposition,
  type UnknownToolFieldsObservation,
} from '@kite-ai/agent-kernel';

export type StateToolDispatchState = ToolDispatchState;
export type StateToolExternalEffects = ToolExternalEffects;
export type StateToolOutcomeDetailCode = ToolOutcomeDetailCode;
export type StateToolOutcomeStatus = ToolOutcomeStatus;
export type StateToolOutcome = ToolOutcome;
export type StateToolRecoveryDisposition = ToolRecoveryDisposition;
export type StateUnknownToolFieldsObservation = UnknownToolFieldsObservation;
export type StateToolOutcomeEvent = Extract<KernelEvent, { outcome?: unknown }>;

export const runtimeHostStateClassifyToolOutcome = classifyToolOutcome;

/** Validate and project the Kernel-owned canonical State ToolOutcome. */
export function runtimeHostStateCanonicalToolOutcome(event: StateToolOutcomeEvent): ToolOutcome {
  assertCanonicalToolOutcomeEvent(event);
  return event.outcome as ToolOutcome;
}

/** Normalize the exact State terminal Tool event before Host persistence. */
export function runtimeHostStateNormalizeToolOutcomeEvent(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  return normalizeAgentToolOutcomeEvent(event, state, occurredAt);
}
