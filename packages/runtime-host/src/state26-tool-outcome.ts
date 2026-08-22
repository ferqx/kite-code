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

export type State26ToolDispatchStateV1 = ToolDispatchStateV1;
export type State26ToolExternalEffectsV1 = ToolExternalEffectsV1;
export type State26ToolOutcomeDetailCodeV1 = ToolOutcomeDetailCodeV1;
export type State26ToolOutcomeStatusV1 = ToolOutcomeStatusV1;
export type State26ToolOutcomeV1 = ToolOutcomeV1;
export type State26ToolRecoveryDispositionV1 = ToolRecoveryDispositionV1;
export type State26UnknownToolFieldsObservationV1 = UnknownToolFieldsObservationV1;
export type State26ToolOutcomeEventV1 = Extract<KernelEvent, { outcomeV1?: unknown }>;

export const runtimeHostState26ClassifyToolOutcomeV1 = classifyToolOutcomeV1;

/** Validate and project the Kernel-owned canonical State26 ToolOutcome. */
export function runtimeHostState26CanonicalToolOutcomeV1(
  event: State26ToolOutcomeEventV1,
): ToolOutcomeV1 {
  assertCanonicalToolOutcomeEvent(event);
  return event.outcomeV1 as ToolOutcomeV1;
}

/** Normalize the exact State26 terminal Tool event before Host persistence. */
export function runtimeHostState26NormalizeToolOutcomeEventV1(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  return normalizeAgentToolOutcomeEvent(event, state, occurredAt);
}
