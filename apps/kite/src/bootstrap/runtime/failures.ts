import { type McpProviderError, mcpProviderFailurePolicyFactsV1 } from '@kite/builtin-runtime/mcp';
import {
  runtimeHostState25ClassifyFailureV1,
  runtimeHostState25FailureKindForToolParseFailureV1,
  runtimeHostState25IsFailureKindV1,
  runtimeHostState25TerminalReasonForFailureV1,
  type State25ClassifiedFailureV1,
  type State25FailureKindV1,
  type State25TerminalReasonCodeV1,
  type State25ToolParseFailureCodeV1,
} from '@kite/runtime-host';

/** App-only provider/logging projection over the Kernel-owned State25 taxonomy. */

export type FailureKind = State25FailureKindV1;
export type TerminalReasonCodeV1 = State25TerminalReasonCodeV1;
export type ClassifiedFailure = State25ClassifiedFailureV1;
export type ToolParseFailureCodeV1 = State25ToolParseFailureCodeV1;

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

export const isFailureKind = runtimeHostState25IsFailureKindV1;
export const terminalReasonForFailureV1 = runtimeHostState25TerminalReasonForFailureV1;
export const classifyFailure = runtimeHostState25ClassifyFailureV1;
export const failureKindForToolParseFailure = runtimeHostState25FailureKindForToolParseFailureV1;

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
