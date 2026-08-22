import { type McpProviderError, mcpProviderFailurePolicyFactsV1 } from '@kite/builtin-runtime/mcp';
import {
  runtimeHostState26ClassifyFailureV1,
  runtimeHostState26FailureKindForToolParseFailureV1,
  runtimeHostState26IsFailureKindV1,
  runtimeHostState26TerminalReasonForFailureV1,
  type State26ClassifiedFailureV1,
  type State26FailureKindV1,
  type State26TerminalReasonCodeV1,
  type State26ToolParseFailureCodeV1,
} from '@kite/runtime-host';

/** App-only provider/logging projection over the Kernel-owned State26 taxonomy. */

export type FailureKind = State26FailureKindV1;
export type TerminalReasonCodeV1 = State26TerminalReasonCodeV1;
export type ClassifiedFailure = State26ClassifiedFailureV1;
export type ToolParseFailureCodeV1 = State26ToolParseFailureCodeV1;

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

export const isFailureKind = runtimeHostState26IsFailureKindV1;
export const terminalReasonForFailureV1 = runtimeHostState26TerminalReasonForFailureV1;
export const classifyFailure = runtimeHostState26ClassifyFailureV1;
export const failureKindForToolParseFailure = runtimeHostState26FailureKindForToolParseFailureV1;

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
