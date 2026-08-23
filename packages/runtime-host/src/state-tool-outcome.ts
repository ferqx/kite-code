import {
  type AgentState,
  assertCanonicalToolOutcomeEvent,
  classifyToolOutcomeV1,
  type KernelEvent,
  normalizeAgentToolOutcomeEvent,
  type ToolDispatchStateV1,
  type ToolExternalEffectsV1,
  type ToolOutcomeDetailCodeV1,
  type ToolOutcomeStatusV1,
  type ToolOutcomeV1,
  type ToolRecoveryDispositionV1,
  type UnknownToolFieldsObservationV1,
} from '@kite/agent-kernel';

export type StateToolDispatchStateV1 = ToolDispatchStateV1;
export type StateToolExternalEffectsV1 = ToolExternalEffectsV1;
export type StateToolOutcomeDetailCodeV1 = ToolOutcomeDetailCodeV1;
export type StateToolOutcomeStatusV1 = ToolOutcomeStatusV1;
export type StateToolOutcomeV1 = ToolOutcomeV1;
export type StateToolRecoveryDispositionV1 = ToolRecoveryDispositionV1;
export type StateUnknownToolFieldsObservationV1 = UnknownToolFieldsObservationV1;
export type StateToolOutcomeEventV1 = Extract<KernelEvent, { outcomeV1?: unknown }>;

export const runtimeHostStateClassifyToolOutcomeV1 = classifyToolOutcomeV1;

/** Validate and project the Kernel-owned canonical State ToolOutcome. */
export function runtimeHostStateCanonicalToolOutcomeV1(
  event: StateToolOutcomeEventV1,
): ToolOutcomeV1 {
  assertCanonicalToolOutcomeEvent(event);
  return event.outcomeV1 as ToolOutcomeV1;
}

/** Normalize the exact State terminal Tool event before Host persistence. */
export function runtimeHostStateNormalizeToolOutcomeEventV1(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  return normalizeAgentToolOutcomeEvent(event, state, occurredAt);
}
