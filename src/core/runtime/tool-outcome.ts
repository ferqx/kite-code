import {
  type ClassifiedFailure,
  classifyFailure,
  type FailureKind,
  isFailureKind,
} from './failures';

export const TOOL_OUTCOME_SCHEMA_VERSION = 1 as const;

export type ToolOutcomeStatusV1 =
  | 'success'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'exhausted'
  | 'unknown';

export type ToolDispatchStateV1 = 'not_started' | 'started' | 'unknown';
export type ToolExternalEffectsV1 = 'none' | 'known' | 'unknown';
export type ToolReplaySafetyV1 = 'none' | 'pre_dispatch' | 'safe_read' | 'idempotency_receipt';

/** Versioned, low-cardinality classifier output. Never add provider/tool text here. */
export const TOOL_OUTCOME_DETAIL_CODES_V1 = [
  'success',
  'legacy_unclassified',
  'invalid_json',
  'invalid_arguments',
  'unknown_tool',
  'tool_unavailable',
  'policy_denied',
  'approval_rejected',
  'auto_review_rejected',
  'phase_deferred',
  'phase_denied',
  'cancelled_by_user',
  'timed_out',
  'provider_unavailable',
  'capability_changed',
  'sandbox_denied',
  'sandbox_capability_missing',
  'protected_path_denied',
  'git_operation_unsupported',
  'managed_network_setup_required',
  'repository_invalid',
  'repository_hostile',
  'binary_untrusted',
  'repository_dirty',
  'repository_no_change',
  'repository_conflict',
  'repository_lock',
  'receipt_invalid',
  'persistence_unavailable',
  'resource_exhausted',
  'process_cleanup_unknown',
  'tool_reported_failure',
  'runtime_exception',
  'classifier_missing',
  'classifier_threw',
  'classifier_conflict',
  'classifier_invalid',
  'recovery_not_allowed',
  'recovery_exhausted',
  'no_progress',
  'unknown',
] as const;

export type ToolOutcomeDetailCodeV1 = (typeof TOOL_OUTCOME_DETAIL_CODES_V1)[number];

const DETAIL_CODES = new Set<string>(TOOL_OUTCOME_DETAIL_CODES_V1);

export function isToolOutcomeDetailCodeV1(value: unknown): value is ToolOutcomeDetailCodeV1 {
  return typeof value === 'string' && DETAIL_CODES.has(value);
}

export type ToolRecoveryDispositionV1 =
  | 'never'
  | 'correct_args'
  | 'retry_once'
  | 'alternative'
  | 'user_action';

export interface ToolRecoveryV1 {
  disposition: ToolRecoveryDispositionV1;
  maximumAdditionalCalls: 0 | 1;
  requiresNewModelResponse: boolean;
  safeAutomaticRetry: boolean;
  retryAfterMs?: number;
  /** Stable allowlisted intent only; never an executable/provider identity. */
  capabilityIntent?: string;
}

export interface ToolOutcomeTimingV1 {
  source: 'runtime_boundary' | 'legacy_unknown';
  queueMs?: number;
  executionMs?: number;
  approvalWaitMs?: number;
  totalActiveMs?: number;
}

export interface UnknownToolFieldsObservationV1 {
  hasUnknown: boolean;
  count: number;
  toolClass: 'builtin_read' | 'builtin_write' | 'builtin_execute' | 'builtin_other' | 'mcp_tool';
  schemaRevision: string;
}

export interface ToolOutcomeV1 {
  schemaVersion: typeof TOOL_OUTCOME_SCHEMA_VERSION;
  status: ToolOutcomeStatusV1;
  failure?: { kind: FailureKind; detailCode: ToolOutcomeDetailCodeV1 };
  dispatchState: ToolDispatchStateV1;
  externalEffects: ToolExternalEffectsV1;
  replaySafety?: ToolReplaySafetyV1;
  recovery: ToolRecoveryV1;
  lineage?: { failureInstanceId?: string; recoveryOf?: string };
  timing: ToolOutcomeTimingV1;
  unknownFields?: UnknownToolFieldsObservationV1;
  diagnosticCodes?: Array<
    'classifier_missing' | 'classifier_threw' | 'classifier_conflict' | 'classifier_invalid'
  >;
}

export interface ToolOutcomeClassifierAdviceV1 {
  detailCode?: string;
  disposition?: ToolRecoveryDispositionV1;
  maximumAdditionalCalls?: number;
  safeAutomaticRetry?: boolean;
  requiresNewModelResponse?: boolean;
  retryAfterMs?: number;
  capabilityIntent?: string;
}

export interface ToolOutcomeAuthorityV1 {
  dispatchState: ToolDispatchStateV1;
  externalEffects: ToolExternalEffectsV1;
  replaySafety?: ToolReplaySafetyV1;
  policyDenied?: boolean;
  approvalDenied?: boolean;
}

export function toolOutcomeSucceededV1(outcome: ToolOutcomeV1 | undefined): boolean {
  return outcome?.status === 'success';
}

export function toolOutcomeProtocolStatusV1(
  outcome: ToolOutcomeV1 | undefined,
): 'success' | 'error' | 'cancelled' | 'timeout' | 'exhausted' {
  switch (outcome?.status) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timeout';
    case 'exhausted':
      return 'exhausted';
    default:
      return 'error';
  }
}

export function toolOutcomeMetricStatusV1(
  outcome: ToolOutcomeV1 | undefined,
): ToolOutcomeStatusV1 | 'failed' {
  return outcome?.status ?? 'failed';
}

const NEVER: ToolRecoveryV1 = Object.freeze({
  disposition: 'never',
  maximumAdditionalCalls: 0,
  requiresNewModelResponse: false,
  safeAutomaticRetry: false,
});

function detailForFailure(failure: ClassifiedFailure): ToolOutcomeDetailCodeV1 {
  if (failure.parseFailureCode === 'invalid_json') return 'invalid_json';
  if (failure.parseFailureCode === 'unknown_tool') return 'unknown_tool';
  if (failure.parseFailureCode === 'tool_unavailable') return 'tool_unavailable';
  if (failure.parseFailureCode === 'invalid_arguments') return 'invalid_arguments';
  switch (failure.kind) {
    case 'model_invalid_tool_args':
    case 'tool_invalid_args':
      return 'invalid_arguments';
    case 'tool_not_found':
      return 'unknown_tool';
    case 'policy_denied':
    case 'mandatory_policy_unavailable':
      return 'policy_denied';
    case 'approval_rejected':
      return 'approval_rejected';
    case 'auto_review_rejected':
      return 'auto_review_rejected';
    case 'phase_deferred':
      return 'phase_deferred';
    case 'phase_denied':
      return 'phase_denied';
    case 'user_input_cancelled':
      return 'cancelled_by_user';
    case 'tool_timeout':
    case 'model_timeout':
    case 'user_input_timeout':
      return 'timed_out';
    case 'provider_unavailable':
    case 'mcp_unavailable':
      return 'provider_unavailable';
    case 'provider_capability_changed':
      return 'capability_changed';
    case 'sandbox_error':
      return 'sandbox_denied';
    case 'persistence_unavailable':
      return 'persistence_unavailable';
    case 'budget_exceeded':
    case 'resource_saturated':
    case 'loop_exhausted':
      return 'resource_exhausted';
    case 'cancel_incomplete':
      return 'process_cleanup_unknown';
    case 'tool_runtime_error':
      return 'runtime_exception';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

const ALLOWED_DETAIL_CODES_BY_FAILURE_KIND_V1: Readonly<
  Record<FailureKind, readonly ToolOutcomeDetailCodeV1[]>
> = Object.freeze({
  model_invalid_tool_args: ['invalid_json', 'invalid_arguments'],
  model_refused: ['unknown'],
  model_timeout: ['timed_out'],
  model_rate_limited: ['unknown'],
  model_server_error: ['unknown'],
  policy_denied: ['policy_denied'],
  phase_deferred: ['phase_deferred'],
  phase_denied: ['phase_denied'],
  approval_rejected: ['approval_rejected'],
  auto_review_rejected: ['auto_review_rejected'],
  plan_revision_requested: ['unknown'],
  tool_runtime_error: [
    'runtime_exception',
    'tool_reported_failure',
    'legacy_unclassified',
    'sandbox_capability_missing',
    'protected_path_denied',
    'git_operation_unsupported',
    'managed_network_setup_required',
    'repository_invalid',
    'repository_hostile',
    'binary_untrusted',
    'repository_dirty',
    'repository_no_change',
    'repository_conflict',
    'repository_lock',
    'receipt_invalid',
  ],
  tool_timeout: ['timed_out'],
  tool_invalid_args: ['invalid_json', 'invalid_arguments'],
  tool_not_found: ['unknown_tool', 'tool_unavailable'],
  provider_auth_required: ['unknown'],
  provider_approval_required: ['unknown'],
  provider_unavailable: ['provider_unavailable'],
  provider_capability_changed: ['capability_changed'],
  user_input_cancelled: ['cancelled_by_user'],
  user_input_timeout: ['timed_out'],
  sandbox_error: ['sandbox_denied'],
  checkpoint_restore_error: ['unknown'],
  transcript_invariant_error: ['unknown'],
  loop_exhausted: [
    'resource_exhausted',
    'recovery_not_allowed',
    'recovery_exhausted',
    'no_progress',
  ],
  budget_exceeded: ['resource_exhausted'],
  artifact_invalid: ['unknown'],
  profile_invalid: ['unknown'],
  digest_invalid: ['unknown'],
  workspace_untrusted: ['unknown'],
  network_unavailable: ['unknown'],
  worktree_unavailable: ['unknown'],
  model_retry_exhausted: ['unknown'],
  mcp_unavailable: ['provider_unavailable'],
  persistence_unavailable: ['persistence_unavailable'],
  resource_saturated: ['resource_exhausted'],
  process_limit_exceeded: ['unknown'],
  cancel_incomplete: ['process_cleanup_unknown'],
  compaction_unqualified: ['unknown'],
  compaction_failed: ['unknown'],
  verification_failed: ['unknown'],
  verification_inconclusive: ['unknown'],
  mandatory_policy_unavailable: ['policy_denied'],
  unknown: ['unknown'],
});

function baseRecovery(failure: ClassifiedFailure): ToolRecoveryV1 {
  if (failure.modelFixable) {
    return {
      disposition: 'correct_args',
      maximumAdditionalCalls: 1,
      requiresNewModelResponse: true,
      safeAutomaticRetry: false,
    };
  }
  if (failure.retryable) {
    return {
      disposition: 'retry_once',
      maximumAdditionalCalls: 1,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    };
  }
  if (failure.needsUserIntervention) {
    return {
      disposition: 'user_action',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    };
  }
  return NEVER;
}

function automaticRetryIsAuthoritative(authority: ToolOutcomeAuthorityV1): boolean {
  if (authority.dispatchState === 'not_started' && authority.externalEffects === 'none')
    return true;
  if (authority.dispatchState !== 'started' || authority.externalEffects === 'unknown')
    return false;
  return authority.replaySafety === 'safe_read' || authority.replaySafety === 'idempotency_receipt';
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function trustedToolTimingV1(
  input?: Partial<Omit<ToolOutcomeTimingV1, 'source'>>,
): ToolOutcomeTimingV1 {
  if (!input) return { source: 'legacy_unknown' };
  const queueMs = finiteDuration(input.queueMs);
  const executionMs = finiteDuration(input.executionMs);
  const approvalWaitMs = finiteDuration(input.approvalWaitMs);
  const totalActiveMs = finiteDuration(input.totalActiveMs);
  return {
    source: 'runtime_boundary',
    ...(queueMs != null ? { queueMs } : {}),
    ...(executionMs != null ? { executionMs } : {}),
    ...(approvalWaitMs != null ? { approvalWaitMs } : {}),
    ...(totalActiveMs != null ? { totalActiveMs } : {}),
  };
}

/**
 * Runtime-authoritative fail-closed classifier. Tool advice can only tighten the Runtime ceiling.
 * It never reads tool output, stderr, commands, paths, or provider bodies.
 */
export function classifyToolOutcomeV1(input: {
  status: ToolOutcomeStatusV1;
  failure?: ClassifiedFailure;
  authority: ToolOutcomeAuthorityV1;
  toolAdvice?: ToolOutcomeClassifierAdviceV1;
  lineage?: ToolOutcomeV1['lineage'];
  timing?: Partial<Omit<ToolOutcomeTimingV1, 'source'>>;
  unknownFields?: UnknownToolFieldsObservationV1;
  classifierDiagnostic?:
    | 'classifier_missing'
    | 'classifier_threw'
    | 'classifier_conflict'
    | 'classifier_invalid';
}): ToolOutcomeV1 {
  if (input.status === 'success') {
    return {
      schemaVersion: 1,
      status: 'success',
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      ...(input.authority.replaySafety ? { replaySafety: input.authority.replaySafety } : {}),
      recovery: NEVER,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedToolTimingV1(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
    };
  }

  const failure = input.failure;
  const invalidAdvice =
    (input.toolAdvice?.detailCode != null &&
      !isToolOutcomeDetailCodeV1(input.toolAdvice.detailCode)) ||
    (input.toolAdvice?.maximumAdditionalCalls != null &&
      input.toolAdvice.maximumAdditionalCalls !== 0 &&
      input.toolAdvice.maximumAdditionalCalls !== 1);
  const conflictingAdviceDetail =
    failure != null &&
    input.toolAdvice?.detailCode != null &&
    isToolOutcomeDetailCodeV1(input.toolAdvice.detailCode) &&
    !ALLOWED_DETAIL_CODES_BY_FAILURE_KIND_V1[failure.kind].includes(input.toolAdvice.detailCode);
  const diagnostic = invalidAdvice
    ? 'classifier_invalid'
    : conflictingAdviceDetail
      ? 'classifier_conflict'
      : input.classifierDiagnostic;
  if (diagnostic) {
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: diagnostic },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedToolTimingV1(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: [diagnostic],
    };
  }

  if (!failure) {
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_missing' },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedToolTimingV1(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: ['classifier_missing'],
    };
  }

  let recovery = baseRecovery(failure);
  if (
    input.authority.policyDenied ||
    input.authority.approvalDenied ||
    input.status === 'cancelled' ||
    input.status === 'timed_out' ||
    input.status === 'exhausted' ||
    input.authority.externalEffects === 'unknown'
  ) {
    recovery = NEVER;
  }

  const conflictsWithRuntimeCeiling =
    (input.toolAdvice?.maximumAdditionalCalls === 1 && recovery.maximumAdditionalCalls === 0) ||
    (input.toolAdvice?.safeAutomaticRetry === true &&
      (!automaticRetryIsAuthoritative(input.authority) || recovery.disposition !== 'retry_once')) ||
    (input.toolAdvice?.requiresNewModelResponse === false && recovery.requiresNewModelResponse) ||
    (input.toolAdvice?.retryAfterMs != null && recovery.disposition !== 'retry_once') ||
    (input.toolAdvice?.disposition != null &&
      input.toolAdvice.disposition !== 'never' &&
      input.toolAdvice.disposition !== recovery.disposition &&
      !(recovery.disposition === 'correct_args' && input.toolAdvice.disposition === 'alternative'));
  if (conflictsWithRuntimeCeiling) {
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_conflict' },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedToolTimingV1(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: ['classifier_conflict'],
    };
  }

  // A ToolSpec/classifier may only tighten the Runtime-owned ceiling.
  if (input.toolAdvice?.disposition === 'never') recovery = NEVER;
  if (
    recovery.disposition === 'retry_once' &&
    input.toolAdvice?.disposition != null &&
    input.toolAdvice.disposition !== 'retry_once'
  ) {
    recovery = NEVER;
  }
  if (recovery.disposition === 'correct_args' && input.toolAdvice?.disposition === 'alternative') {
    recovery = { ...recovery, disposition: 'alternative', maximumAdditionalCalls: 1 };
  }

  if (recovery.disposition === 'retry_once') {
    const safe =
      automaticRetryIsAuthoritative(input.authority) &&
      input.toolAdvice?.safeAutomaticRetry !== false;
    recovery = safe
      ? {
          ...recovery,
          maximumAdditionalCalls: 1,
          safeAutomaticRetry: true,
          ...(finiteDuration(input.toolAdvice?.retryAfterMs) != null
            ? { retryAfterMs: finiteDuration(input.toolAdvice?.retryAfterMs) }
            : {}),
        }
      : NEVER;
  }

  if (input.toolAdvice?.maximumAdditionalCalls === 0) recovery = NEVER;
  const capabilityIntent = input.toolAdvice?.capabilityIntent;
  if (capabilityIntent && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(capabilityIntent)) {
    recovery = { ...recovery, capabilityIntent };
  }

  return {
    schemaVersion: 1,
    status: input.status,
    failure: {
      kind: failure.kind,
      detailCode:
        input.toolAdvice?.detailCode && isToolOutcomeDetailCodeV1(input.toolAdvice.detailCode)
          ? input.toolAdvice.detailCode
          : detailForFailure(failure),
    },
    dispatchState: input.authority.dispatchState,
    externalEffects: input.authority.externalEffects,
    ...(input.authority.replaySafety ? { replaySafety: input.authority.replaySafety } : {}),
    recovery,
    ...(input.lineage ? { lineage: input.lineage } : {}),
    timing: trustedToolTimingV1(input.timing),
    ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
  };
}

export function legacyToolOutcomeV1(
  status: Exclude<ToolOutcomeStatusV1, 'unknown'>,
): ToolOutcomeV1 {
  if (status === 'success') {
    return {
      schemaVersion: 1,
      status,
      dispatchState: 'unknown',
      externalEffects: 'unknown',
      recovery: NEVER,
      timing: { source: 'legacy_unknown' },
    };
  }
  return {
    schemaVersion: 1,
    status,
    failure: { kind: 'tool_runtime_error', detailCode: 'legacy_unclassified' },
    dispatchState: 'unknown',
    externalEffects: 'unknown',
    recovery: NEVER,
    timing: { source: 'legacy_unknown' },
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict persisted-envelope validator. Unknown V1 JSON fields fail closed. */
export function isToolOutcomeV1(value: unknown): value is ToolOutcomeV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'failure',
      'dispatchState',
      'externalEffects',
      'replaySafety',
      'recovery',
      'lineage',
      'timing',
      'unknownFields',
      'diagnosticCodes',
    ]) ||
    value.schemaVersion !== 1 ||
    !['success', 'failed', 'rejected', 'cancelled', 'timed_out', 'exhausted', 'unknown'].includes(
      String(value.status),
    ) ||
    !['not_started', 'started', 'unknown'].includes(String(value.dispatchState)) ||
    !['none', 'known', 'unknown'].includes(String(value.externalEffects))
  ) {
    return false;
  }
  const status = value.status as ToolOutcomeStatusV1;
  const dispatchState = value.dispatchState as ToolDispatchStateV1;
  const externalEffects = value.externalEffects as ToolExternalEffectsV1;
  if (
    value.replaySafety != null &&
    !['none', 'pre_dispatch', 'safe_read', 'idempotency_receipt'].includes(
      String(value.replaySafety),
    )
  ) {
    return false;
  }
  const replaySafety = value.replaySafety as ToolReplaySafetyV1 | undefined;
  if (
    (replaySafety === 'pre_dispatch' &&
      (dispatchState !== 'not_started' || externalEffects !== 'none')) ||
    (replaySafety === 'safe_read' && (dispatchState !== 'started' || externalEffects !== 'none')) ||
    (replaySafety === 'idempotency_receipt' &&
      (dispatchState !== 'started' || externalEffects === 'unknown')) ||
    (externalEffects === 'unknown' && replaySafety != null && replaySafety !== 'none') ||
    (dispatchState === 'not_started' && externalEffects !== 'none')
  ) {
    return false;
  }
  if (value.status === 'success') {
    if (value.failure != null) return false;
  } else if (
    !isRecord(value.failure) ||
    !exactKeys(value.failure, ['kind', 'detailCode']) ||
    !isFailureKind(value.failure.kind) ||
    !isToolOutcomeDetailCodeV1(value.failure.detailCode)
  ) {
    return false;
  }
  if (
    !isRecord(value.recovery) ||
    !exactKeys(value.recovery, [
      'disposition',
      'maximumAdditionalCalls',
      'requiresNewModelResponse',
      'safeAutomaticRetry',
      'retryAfterMs',
      'capabilityIntent',
    ]) ||
    !['never', 'correct_args', 'retry_once', 'alternative', 'user_action'].includes(
      String(value.recovery.disposition),
    ) ||
    (value.recovery.maximumAdditionalCalls !== 0 && value.recovery.maximumAdditionalCalls !== 1) ||
    typeof value.recovery.requiresNewModelResponse !== 'boolean' ||
    typeof value.recovery.safeAutomaticRetry !== 'boolean' ||
    (value.recovery.retryAfterMs != null && finiteDuration(value.recovery.retryAfterMs) == null) ||
    (value.recovery.capabilityIntent != null &&
      (typeof value.recovery.capabilityIntent !== 'string' ||
        !/^[a-z][a-z0-9_.:-]{0,63}$/u.test(value.recovery.capabilityIntent)))
  ) {
    return false;
  }
  const recovery = value.recovery as unknown as ToolRecoveryV1;
  const recoveryMatrixValid = (() => {
    switch (recovery.disposition) {
      case 'never':
        return (
          recovery.maximumAdditionalCalls === 0 &&
          !recovery.requiresNewModelResponse &&
          !recovery.safeAutomaticRetry &&
          recovery.retryAfterMs == null
        );
      case 'correct_args':
        return (
          recovery.maximumAdditionalCalls === 1 &&
          recovery.requiresNewModelResponse &&
          !recovery.safeAutomaticRetry &&
          recovery.retryAfterMs == null
        );
      case 'retry_once':
        return (
          recovery.maximumAdditionalCalls === 1 &&
          !recovery.requiresNewModelResponse &&
          recovery.safeAutomaticRetry &&
          ((dispatchState === 'not_started' && externalEffects === 'none') ||
            (dispatchState === 'started' &&
              externalEffects !== 'unknown' &&
              (replaySafety === 'safe_read' || replaySafety === 'idempotency_receipt')))
        );
      case 'alternative':
        return (
          recovery.maximumAdditionalCalls === 1 &&
          recovery.requiresNewModelResponse &&
          !recovery.safeAutomaticRetry &&
          recovery.retryAfterMs == null
        );
      case 'user_action':
        return (
          recovery.maximumAdditionalCalls === 0 &&
          !recovery.requiresNewModelResponse &&
          !recovery.safeAutomaticRetry &&
          recovery.retryAfterMs == null
        );
    }
  })();
  if (
    !recoveryMatrixValid ||
    (status === 'success' && recovery.disposition !== 'never') ||
    (status === 'rejected' && recovery.disposition === 'retry_once') ||
    (['cancelled', 'timed_out', 'exhausted', 'unknown'].includes(status) &&
      recovery.disposition !== 'never')
  ) {
    return false;
  }
  if (status !== 'success' && status !== 'unknown' && isRecord(value.failure)) {
    const kind = value.failure.kind as FailureKind;
    const detailCode = value.failure.detailCode as ToolOutcomeDetailCodeV1;
    const details = ALLOWED_DETAIL_CODES_BY_FAILURE_KIND_V1[kind];
    const recoveryDetail = ['recovery_not_allowed', 'recovery_exhausted', 'no_progress'].includes(
      detailCode,
    );
    if (!details.includes(detailCode) && !(status === 'exhausted' && recoveryDetail)) {
      return false;
    }
    const authoritativeRecovery = baseRecovery(classifyFailure(kind, 'redacted'));
    if (
      [
        'policy_denied',
        'mandatory_policy_unavailable',
        'approval_rejected',
        'auto_review_rejected',
      ].includes(kind) &&
      recovery.disposition !== 'never'
    ) {
      return false;
    }
    if (
      recovery.disposition !== 'never' &&
      recovery.disposition !== authoritativeRecovery.disposition &&
      !(
        authoritativeRecovery.disposition === 'correct_args' &&
        recovery.disposition === 'alternative'
      )
    ) {
      return false;
    }
  }
  const timing = value.timing;
  if (
    !isRecord(timing) ||
    !exactKeys(timing, ['source', 'queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs']) ||
    !['runtime_boundary', 'legacy_unknown'].includes(String(timing.source)) ||
    ['queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs'].some(
      (key) => timing[key] != null && finiteDuration(timing[key]) == null,
    )
  ) {
    return false;
  }
  if (
    (timing.source === 'legacy_unknown' &&
      ['queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs'].some(
        (key) => timing[key] != null,
      )) ||
    (timing.totalActiveMs != null &&
      ((timing.queueMs ?? 0) > timing.totalActiveMs ||
        (timing.executionMs ?? 0) > timing.totalActiveMs ||
        (timing.approvalWaitMs ?? 0) > timing.totalActiveMs))
  ) {
    return false;
  }
  if (value.lineage != null) {
    if (
      !isRecord(value.lineage) ||
      !exactKeys(value.lineage, ['failureInstanceId', 'recoveryOf']) ||
      Object.values(value.lineage).some(
        (identity) => typeof identity !== 'string' || !/^[a-f0-9]{64}$/u.test(identity),
      )
    ) {
      return false;
    }
  }
  if (value.unknownFields != null) {
    const observation = value.unknownFields;
    if (
      !isRecord(observation) ||
      !exactKeys(observation, ['hasUnknown', 'count', 'toolClass', 'schemaRevision']) ||
      typeof observation.hasUnknown !== 'boolean' ||
      typeof observation.count !== 'number' ||
      !Number.isInteger(observation.count) ||
      observation.count < 0 ||
      observation.count > 255 ||
      !['builtin_read', 'builtin_write', 'builtin_execute', 'builtin_other', 'mcp_tool'].includes(
        String(observation.toolClass),
      ) ||
      typeof observation.schemaRevision !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,64}$/u.test(observation.schemaRevision)
    ) {
      return false;
    }
  }
  if (
    value.diagnosticCodes != null &&
    (!Array.isArray(value.diagnosticCodes) ||
      value.diagnosticCodes.length !== 1 ||
      value.diagnosticCodes.some(
        (code) =>
          ![
            'classifier_missing',
            'classifier_threw',
            'classifier_conflict',
            'classifier_invalid',
          ].includes(String(code)),
      ))
  ) {
    return false;
  }
  if (value.unknownFields != null) {
    const observation = value.unknownFields as unknown as UnknownToolFieldsObservationV1;
    if (observation.hasUnknown !== observation.count > 0) return false;
  }
  if (status === 'unknown') {
    const diagnosticCode = (value.diagnosticCodes as string[] | undefined)?.[0];
    if (
      value.failure?.kind !== 'unknown' ||
      ![
        'classifier_missing',
        'classifier_threw',
        'classifier_conflict',
        'classifier_invalid',
      ].includes(String(value.failure?.detailCode)) ||
      diagnosticCode !== value.failure?.detailCode
    ) {
      return false;
    }
  } else if (value.diagnosticCodes != null) {
    return false;
  }
  return true;
}

function toolClassV1(toolName: string): UnknownToolFieldsObservationV1['toolClass'] {
  if (toolName.startsWith('mcp__')) return 'mcp_tool';
  if (/^(read|search|list)_/u.test(toolName)) return 'builtin_read';
  if (/^(write|edit|update)_/u.test(toolName)) return 'builtin_write';
  if (toolName === 'shell_execute' || toolName === 'task') return 'builtin_execute';
  return 'builtin_other';
}

export function observeUnknownToolFieldsV1(input: {
  toolName: string;
  args: unknown;
  knownFields: readonly string[];
  schemaRevision: string;
}): UnknownToolFieldsObservationV1 {
  const keys =
    input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? Object.keys(input.args as Record<string, unknown>)
      : [];
  const known = new Set(input.knownFields);
  const count = keys.reduce((total, key) => total + (known.has(key) ? 0 : 1), 0);
  return {
    hasUnknown: count > 0,
    count: Math.min(count, 255),
    toolClass: toolClassV1(input.toolName),
    schemaRevision: /^[a-zA-Z0-9_.:-]{1,64}$/u.test(input.schemaRevision)
      ? input.schemaRevision
      : 'unknown',
  };
}
