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

/** Generic Host bindings over the deterministic State25 failure taxonomy. */
export type State25ClassifiedFailureV1 = ClassifiedFailureV1;
export type State25FailureKindV1 = FailureKindV1;
export type State25TerminalReasonCodeV1 = TerminalReasonCodeV1;
export type State25ToolParseFailureCodeV1 = ToolParseFailureCodeV1;

export const runtimeHostState25ClassifyFailureV1 = classifyRuntimeFailureV1;
export const runtimeHostState25FailureKindForToolParseFailureV1 = failureKindForToolParseFailureV1;
export const runtimeHostState25IsFailureKindV1 = isRuntimeFailureKindV1;
export const runtimeHostState25TerminalReasonForFailureV1 = terminalReasonForRuntimeFailureV1;
