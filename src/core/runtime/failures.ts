import type { McpProviderError } from '@/core/mcp/provider-errors';

export type FailureKind =
  | 'model_invalid_tool_args'
  | 'model_refused'
  | 'model_timeout'
  | 'model_rate_limited'
  | 'model_server_error'
  | 'policy_denied'
  | 'phase_deferred'
  | 'phase_denied'
  | 'approval_rejected'
  | 'auto_review_rejected'
  | 'plan_revision_requested'
  | 'tool_runtime_error'
  | 'tool_timeout'
  | 'tool_invalid_args'
  | 'tool_not_found'
  | 'provider_auth_required'
  | 'provider_approval_required'
  | 'provider_unavailable'
  | 'provider_capability_changed'
  | 'user_input_cancelled'
  | 'user_input_timeout'
  | 'sandbox_error'
  | 'checkpoint_restore_error'
  | 'transcript_invariant_error'
  | 'loop_exhausted'
  | 'budget_exceeded'
  | 'artifact_invalid'
  | 'profile_invalid'
  | 'digest_invalid'
  | 'workspace_untrusted'
  | 'network_unavailable'
  | 'worktree_unavailable'
  | 'model_retry_exhausted'
  | 'mcp_unavailable'
  | 'persistence_unavailable'
  | 'resource_saturated'
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'compaction_unqualified'
  | 'compaction_failed'
  | 'verification_failed'
  | 'verification_inconclusive'
  | 'mandatory_policy_unavailable'
  | 'unknown';

export type TerminalReasonCodeV1 =
  | 'completed'
  | 'artifact_invalid'
  | 'profile_invalid'
  | 'digest_invalid'
  | 'workspace_untrusted'
  | 'sandbox_unavailable'
  | 'network_unavailable'
  | 'worktree_unavailable'
  | 'model_retry_exhausted'
  | 'provider_unavailable'
  | 'mcp_unavailable'
  | 'persistence_unavailable'
  | 'budget_exhausted'
  | 'resource_saturated'
  | 'tool_concurrency_saturated'
  | 'shell_concurrency_saturated'
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'compaction_unqualified'
  | 'compaction_failed'
  | 'verification_failed'
  | 'verification_inconclusive'
  | 'mandatory_policy_unavailable'
  | 'blocked'
  | 'unknown';

export interface ClassifiedFailure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  modelFixable: boolean;
  needsUserIntervention: boolean;
  terminatesTurn: boolean;
  journal: boolean;
  /** Original structured failure code from Registry.parseToolCall,
   *  propagated through InvalidToolRequest for diagnostic observability. */
  parseFailureCode?: import('@/core/tools/registry/registry').ParseFailureCode;
}

export interface RuntimeFailureContext {
  kind: FailureKind;
  message: string;
  phase: 'planning' | 'building';
  turnId: string;
  effectId?: string;
  toolCallId?: string;
  interactionId?: string;
  userVisible?: boolean;
  parseFailureCode?: import('@/core/tools/registry/registry').ParseFailureCode;
}

export interface RuntimeFailureRecord extends RuntimeFailureContext {
  failure: ClassifiedFailure;
  userVisible: boolean;
}

type FailureStrategy = Omit<ClassifiedFailure, 'kind' | 'message'>;
const retryable: FailureStrategy = {
  retryable: true,
  modelFixable: false,
  needsUserIntervention: false,
  terminatesTurn: false,
  journal: false,
};
const terminal: FailureStrategy = {
  retryable: false,
  modelFixable: false,
  needsUserIntervention: true,
  terminatesTurn: true,
  journal: true,
};
const STRATEGIES: Record<FailureKind, FailureStrategy> = {
  model_invalid_tool_args: { ...retryable, modelFixable: true, journal: true },
  model_refused: terminal,
  model_timeout: retryable,
  model_rate_limited: retryable,
  model_server_error: retryable,
  policy_denied: {
    ...terminal,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  phase_deferred: {
    ...terminal,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  phase_denied: {
    ...terminal,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  approval_rejected: { ...terminal, needsUserIntervention: false, terminatesTurn: false },
  auto_review_rejected: { ...terminal, terminatesTurn: false },
  plan_revision_requested: { ...terminal, modelFixable: true, terminatesTurn: false },
  tool_runtime_error: { ...retryable, modelFixable: true, journal: true },
  tool_timeout: { ...retryable, journal: true },
  tool_invalid_args: {
    ...terminal,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  tool_not_found: terminal,
  provider_auth_required: { ...terminal, terminatesTurn: false },
  provider_approval_required: { ...terminal, terminatesTurn: false },
  provider_unavailable: {
    ...terminal,
    retryable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  provider_capability_changed: {
    ...terminal,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
  },
  user_input_cancelled: {
    ...terminal,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  user_input_timeout: {
    ...terminal,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  sandbox_error: terminal,
  checkpoint_restore_error: terminal,
  transcript_invariant_error: terminal,
  loop_exhausted: terminal,
  budget_exceeded: terminal,
  artifact_invalid: terminal,
  profile_invalid: terminal,
  digest_invalid: terminal,
  workspace_untrusted: terminal,
  network_unavailable: terminal,
  worktree_unavailable: terminal,
  model_retry_exhausted: terminal,
  mcp_unavailable: { ...terminal, retryable: true },
  persistence_unavailable: terminal,
  resource_saturated: terminal,
  process_limit_exceeded: terminal,
  cancel_incomplete: terminal,
  compaction_unqualified: terminal,
  compaction_failed: terminal,
  verification_failed: terminal,
  verification_inconclusive: terminal,
  mandatory_policy_unavailable: terminal,
  unknown: terminal,
};

export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && Object.hasOwn(STRATEGIES, value);
}

const TERMINAL_REASON_BY_FAILURE: Readonly<Partial<Record<FailureKind, TerminalReasonCodeV1>>> =
  Object.freeze({
    artifact_invalid: 'artifact_invalid',
    profile_invalid: 'profile_invalid',
    digest_invalid: 'digest_invalid',
    workspace_untrusted: 'workspace_untrusted',
    sandbox_error: 'sandbox_unavailable',
    network_unavailable: 'network_unavailable',
    worktree_unavailable: 'worktree_unavailable',
    model_retry_exhausted: 'model_retry_exhausted',
    provider_unavailable: 'provider_unavailable',
    mcp_unavailable: 'mcp_unavailable',
    persistence_unavailable: 'persistence_unavailable',
    budget_exceeded: 'budget_exhausted',
    resource_saturated: 'resource_saturated',
    process_limit_exceeded: 'process_limit_exceeded',
    cancel_incomplete: 'cancel_incomplete',
    compaction_unqualified: 'compaction_unqualified',
    compaction_failed: 'compaction_failed',
    verification_failed: 'verification_failed',
    verification_inconclusive: 'verification_inconclusive',
    mandatory_policy_unavailable: 'mandatory_policy_unavailable',
    unknown: 'unknown',
  });

export function terminalReasonForFailureV1(kind: FailureKind): TerminalReasonCodeV1 {
  return TERMINAL_REASON_BY_FAILURE[kind] ?? 'blocked';
}

export function classifyFailure(
  kind: FailureKind,
  message: string,
  parseFailureCode?: import('@/core/tools/registry/registry').ParseFailureCode,
): ClassifiedFailure {
  return {
    kind,
    message,
    ...STRATEGIES[kind],
    ...(parseFailureCode ? { parseFailureCode } : {}),
  };
}

export function failureKindForToolParseFailure(
  code: import('@/core/tools/registry/registry').ParseFailureCode,
): 'tool_invalid_args' | 'tool_not_found' {
  return code === 'unknown_tool' || code === 'tool_unavailable'
    ? 'tool_not_found'
    : 'tool_invalid_args';
}

export function classifyMcpProviderError(error: McpProviderError): ClassifiedFailure {
  return {
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    modelFixable: error.kind === 'provider_capability_changed',
    needsUserIntervention:
      error.kind === 'provider_auth_required' || error.kind === 'provider_approval_required',
    terminatesTurn: false,
    journal: true,
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
