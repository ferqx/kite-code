import { type McpProviderError, mcpProviderFailurePolicyFacts } from '@kite-ai/builtin-runtime/mcp';
import {
  runtimeHostStateClassifyFailure,
  runtimeHostStateFailureKindForToolParseFailure,
  runtimeHostStateIsFailureKind,
  runtimeHostStateTerminalReasonForFailure,
  type StateClassifiedFailure,
  type StateFailureKind,
  type StateTerminalReasonCode,
  type StateToolParseFailureCode,
} from '@kite-ai/runtime-host/kernel-adapter';

/** App-only provider/logging projection over the Kernel-owned State taxonomy. */

export type FailureKind = StateFailureKind;
export type TerminalReasonCode = StateTerminalReasonCode;
export type ClassifiedFailure = StateClassifiedFailure;
export type ToolParseFailureCode = StateToolParseFailureCode;

export interface RuntimeFailureContext {
  kind: FailureKind;
  message: string;
  phase: 'planning' | 'building';
  turnId: string;
  effectId?: string;
  toolCallId?: string;
  interactionId?: string;
  userVisible?: boolean;
  parseFailureCode?: ToolParseFailureCode;
}

export interface RuntimeFailureRecord extends RuntimeFailureContext {
  failure: ClassifiedFailure;
  userVisible: boolean;
}

export const isFailureKind = runtimeHostStateIsFailureKind;
export const terminalReasonForFailure = runtimeHostStateTerminalReasonForFailure;
export const classifyFailure = runtimeHostStateClassifyFailure;
export const failureKindForToolParseFailure = runtimeHostStateFailureKindForToolParseFailure;

export function classifyMcpProviderError(error: McpProviderError): ClassifiedFailure {
  const facts = mcpProviderFailurePolicyFacts(error);
  return {
    ...classifyFailure(facts.kind, facts.message),
    ...facts,
  };
}

/** Create one structured failure record for logging and public error mapping. */
export function recordRuntimeFailure(input: RuntimeFailureContext): RuntimeFailureRecord {
  const failure = classifyFailure(input.kind, input.message, input.parseFailureCode);
  return {
    ...input,
    failure,
    userVisible: input.userVisible ?? failure.needsUserIntervention,
  };
}
