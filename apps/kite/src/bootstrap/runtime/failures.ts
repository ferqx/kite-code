import { type McpProviderError, mcpProviderFailurePolicyFactsV1 } from '@kite/builtin-runtime/mcp';
import {
  runtimeHostStateClassifyFailureV1,
  runtimeHostStateFailureKindForToolParseFailureV1,
  runtimeHostStateIsFailureKindV1,
  runtimeHostStateTerminalReasonForFailureV1,
  type StateClassifiedFailureV1,
  type StateFailureKindV1,
  type StateTerminalReasonCodeV1,
  type StateToolParseFailureCodeV1,
} from '@kite/runtime-host';

/** App-only provider/logging projection over the Kernel-owned State taxonomy. */

export type FailureKind = StateFailureKindV1;
export type TerminalReasonCodeV1 = StateTerminalReasonCodeV1;
export type ClassifiedFailure = StateClassifiedFailureV1;
export type ToolParseFailureCodeV1 = StateToolParseFailureCodeV1;

export interface RuntimeFailureContext {
  kind: FailureKind;
  message: string;
  phase: 'planning' | 'building';
  turnId: string;
  effectId?: string;
  toolCallId?: string;
  interactionId?: string;
  userVisible?: boolean;
  parseFailureCode?: ToolParseFailureCodeV1;
}

export interface RuntimeFailureRecord extends RuntimeFailureContext {
  failure: ClassifiedFailure;
  userVisible: boolean;
}

export const isFailureKind = runtimeHostStateIsFailureKindV1;
export const terminalReasonForFailureV1 = runtimeHostStateTerminalReasonForFailureV1;
export const classifyFailure = runtimeHostStateClassifyFailureV1;
export const failureKindForToolParseFailure = runtimeHostStateFailureKindForToolParseFailureV1;

export function classifyMcpProviderError(error: McpProviderError): ClassifiedFailure {
  const facts = mcpProviderFailurePolicyFactsV1(error);
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
