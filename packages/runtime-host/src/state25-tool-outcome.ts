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

export type State25ToolDispatchStateV1 = ToolDispatchStateV1;
export type State25ToolExternalEffectsV1 = ToolExternalEffectsV1;
export type State25ToolOutcomeDetailCodeV1 = ToolOutcomeDetailCodeV1;
export type State25ToolOutcomeStatusV1 = ToolOutcomeStatusV1;
export type State25ToolOutcomeV1 = ToolOutcomeV1;
export type State25ToolRecoveryDispositionV1 = ToolRecoveryDispositionV1;
export type State25UnknownToolFieldsObservationV1 = UnknownToolFieldsObservationV1;
export type State25ToolOutcomeEventV1 = Extract<KernelEvent, { outcomeV1?: unknown }>;

export const runtimeHostState25ClassifyToolOutcomeV1 = classifyToolOutcomeV1;

/** Validate and project the Kernel-owned canonical State25 ToolOutcome. */
export function runtimeHostState25CanonicalToolOutcomeV1(
  event: State25ToolOutcomeEventV1,
): ToolOutcomeV1 {
  assertCanonicalToolOutcomeEvent(event);
  return event.outcomeV1 as ToolOutcomeV1;
}

/** Normalize the exact State25 terminal Tool event before Host persistence. */
export function runtimeHostState25NormalizeToolOutcomeEventV1(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  return normalizeAgentToolOutcomeEvent(event, state, occurredAt);
}
