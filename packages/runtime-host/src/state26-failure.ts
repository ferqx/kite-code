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

/** Generic Host bindings over the deterministic State26 failure taxonomy. */
export type State26ClassifiedFailureV1 = ClassifiedFailureV1;
export type State26FailureKindV1 = FailureKindV1;
export type State26TerminalReasonCodeV1 = TerminalReasonCodeV1;
export type State26ToolParseFailureCodeV1 = ToolParseFailureCodeV1;

export const runtimeHostState26ClassifyFailureV1 = classifyRuntimeFailureV1;
export const runtimeHostState26FailureKindForToolParseFailureV1 = failureKindForToolParseFailureV1;
export const runtimeHostState26IsFailureKindV1 = isRuntimeFailureKindV1;
export const runtimeHostState26TerminalReasonForFailureV1 = terminalReasonForRuntimeFailureV1;
