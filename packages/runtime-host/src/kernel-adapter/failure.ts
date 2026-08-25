import {
  type ClassifiedFailure,
  classifyRuntimeFailure,
  type FailureKind,
  failureKindForToolParseFailure,
  isRuntimeFailureKind,
  type TerminalReasonCode,
  type ToolParseFailureCode,
  terminalReasonForRuntimeFailure,
} from '@kite-ai/agent-kernel';

/** Generic Host bindings over the deterministic State failure taxonomy. */
export type StateClassifiedFailure = ClassifiedFailure;
export type StateFailureKind = FailureKind;
export type StateTerminalReasonCode = TerminalReasonCode;
export type StateToolParseFailureCode = ToolParseFailureCode;

export const runtimeHostStateClassifyFailure = classifyRuntimeFailure;
export const runtimeHostStateFailureKindForToolParseFailure = failureKindForToolParseFailure;
export const runtimeHostStateIsFailureKind = isRuntimeFailureKind;
export const runtimeHostStateTerminalReasonForFailure = terminalReasonForRuntimeFailure;
