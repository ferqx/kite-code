import {
  type ClassifiedFailureV1,
  classifyRuntimeFailureV1,
  type FailureKindV1,
  failureKindForToolParseFailureV1,
  isRuntimeFailureKindV1,
  type TerminalReasonCodeV1,
  type ToolParseFailureCodeV1,
  terminalReasonForRuntimeFailureV1,
} from '@kite/agent-kernel';

/** Generic Host bindings over the deterministic State failure taxonomy. */
export type StateClassifiedFailureV1 = ClassifiedFailureV1;
export type StateFailureKindV1 = FailureKindV1;
export type StateTerminalReasonCodeV1 = TerminalReasonCodeV1;
export type StateToolParseFailureCodeV1 = ToolParseFailureCodeV1;

export const runtimeHostStateClassifyFailureV1 = classifyRuntimeFailureV1;
export const runtimeHostStateFailureKindForToolParseFailureV1 = failureKindForToolParseFailureV1;
export const runtimeHostStateIsFailureKindV1 = isRuntimeFailureKindV1;
export const runtimeHostStateTerminalReasonForFailureV1 = terminalReasonForRuntimeFailureV1;
