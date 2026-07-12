export type FailureKind =
  | 'model_invalid_tool_args'
  | 'model_refused'
  | 'model_timeout'
  | 'model_rate_limited'
  | 'model_server_error'
  | 'policy_denied'
  | 'approval_rejected'
  | 'auto_review_rejected'
  | 'plan_revision_requested'
  | 'tool_runtime_error'
  | 'tool_timeout'
  | 'tool_invalid_args'
  | 'tool_not_found'
  | 'user_input_cancelled'
  | 'user_input_timeout'
  | 'sandbox_error'
  | 'checkpoint_restore_error'
  | 'transcript_invariant_error'
  | 'loop_exhausted'
  | 'budget_exceeded'
  | 'unknown';

export interface ClassifiedFailure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  modelFixable: boolean;
  needsUserIntervention: boolean;
  terminatesTurn: boolean;
  journal: boolean;
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
  unknown: terminal,
};

export function classifyFailure(kind: FailureKind, message: string): ClassifiedFailure {
  return { kind, message, ...STRATEGIES[kind] };
}
