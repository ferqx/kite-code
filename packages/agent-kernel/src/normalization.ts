import type { KernelEvent } from './events';
import { sha256Hex } from './hash';
import { eventRecord, recordField, stringField } from './reducer-utils';
import type { AgentState, AgentTerminalReasonCode } from './state';

/** State ToolOutcome format identity within the Store RA epoch. */
export const TOOL_OUTCOME_SCHEMA_VERSION = 1 as const;

const FAILURE_KINDS = [
  'model_invalid_tool_args',
  'model_refused',
  'model_timeout',
  'model_rate_limited',
  'model_server_error',
  'policy_denied',
  'phase_deferred',
  'phase_denied',
  'approval_rejected',
  'auto_review_rejected',
  'plan_revision_requested',
  'tool_runtime_error',
  'tool_timeout',
  'tool_invalid_args',
  'tool_not_found',
  'provider_auth_required',
  'provider_approval_required',
  'provider_unavailable',
  'provider_capability_changed',
  'user_input_cancelled',
  'user_input_timeout',
  'sandbox_error',
  'checkpoint_restore_error',
  'transcript_invariant_error',
  'loop_exhausted',
  'budget_exceeded',
  'artifact_invalid',
  'profile_invalid',
  'digest_invalid',
  'workspace_untrusted',
  'network_unavailable',
  'worktree_unavailable',
  'model_retry_exhausted',
  'mcp_unavailable',
  'persistence_unavailable',
  'resource_saturated',
  'process_limit_exceeded',
  'cancel_incomplete',
  'compaction_unqualified',
  'compaction_failed',
  'verification_failed',
  'verification_inconclusive',
  'mandatory_policy_unavailable',
  'unknown',
] as const;
/** Canonical State failure-kind vocabulary owned by agent-kernel. */
export const TOOL_OUTCOME_FAILURE_KINDS_ = FAILURE_KINDS;
const DETAIL_CODES = [
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
/** Canonical State low-cardinality detail-code vocabulary owned by agent-kernel. */
export const TOOL_OUTCOME_DETAIL_CODES_ = DETAIL_CODES;

export type FailureKind = (typeof FAILURE_KINDS)[number];
export type ToolOutcomeDetailCode = (typeof DETAIL_CODES)[number];
type DetailCode = ToolOutcomeDetailCode;
export type FailureStrategy = {
  readonly retryable: boolean;
  readonly modelFixable: boolean;
  readonly needsUserIntervention: boolean;
  readonly terminatesTurn: boolean;
  readonly journal: boolean;
};
export type ClassifiedFailure = FailureStrategy & {
  readonly kind: FailureKind;
  readonly message: string;
  readonly parseFailureCode?: ToolParseFailureCode;
};
export type ToolParseFailureCode =
  | 'invalid_json'
  | 'invalid_arguments'
  | 'unknown_tool'
  | 'tool_unavailable';
export type TerminalReasonCode = AgentTerminalReasonCode;
export interface ToolOutcomeClassifierAdvice {
  readonly detailCode?: string;
  readonly disposition?: ToolRecoveryDisposition;
  readonly maximumAdditionalCalls?: number;
  readonly safeAutomaticRetry?: boolean;
  readonly requiresNewModelResponse?: boolean;
  readonly retryAfterMs?: number;
  readonly capabilityIntent?: string;
}
type ToolAdvice = ToolOutcomeClassifierAdvice;
export type ToolOutcomeStatus =
  | 'success'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'exhausted'
  | 'unknown';
export type ToolDispatchState = 'not_started' | 'started' | 'unknown';
export type ToolExternalEffects = 'none' | 'known' | 'unknown';
export type ToolReplaySafety = 'none' | 'pre_dispatch' | 'safe_read' | 'idempotency_receipt';
export type ToolRecoveryDisposition =
  | 'never'
  | 'correct_args'
  | 'retry_once'
  | 'alternative'
  | 'user_action';
export interface ToolRecovery {
  disposition: ToolRecoveryDisposition;
  maximumAdditionalCalls: 0 | 1;
  requiresNewModelResponse: boolean;
  safeAutomaticRetry: boolean;
  retryAfterMs?: number;
  capabilityIntent?: string;
}
export interface ToolOutcomeTiming {
  source: 'runtime_boundary' | 'legacy_unknown';
  queueMs?: number;
  executionMs?: number;
  approvalWaitMs?: number;
  totalActiveMs?: number;
}
export interface UnknownToolFieldsObservation {
  hasUnknown: boolean;
  count: number;
  toolClass: 'builtin_read' | 'builtin_write' | 'builtin_execute' | 'builtin_other' | 'mcp_tool';
  schemaRevision: string;
}
export interface ToolOutcome {
  schemaVersion: typeof TOOL_OUTCOME_SCHEMA_VERSION;
  status: ToolOutcomeStatus;
  failure?: { kind: FailureKind; detailCode: ToolOutcomeDetailCode };
  dispatchState: ToolDispatchState;
  externalEffects: ToolExternalEffects;
  replaySafety?: ToolReplaySafety;
  recovery: ToolRecovery;
  lineage?: { failureInstanceId?: string; recoveryOf?: string };
  timing: ToolOutcomeTiming;
  unknownFields?: UnknownToolFieldsObservation;
  diagnosticCodes?: readonly (
    | 'classifier_missing'
    | 'classifier_threw'
    | 'classifier_conflict'
    | 'classifier_invalid'
  )[];
}
export interface ToolOutcomeAuthority {
  readonly dispatchState: ToolDispatchState;
  readonly externalEffects: ToolExternalEffects;
  readonly replaySafety?: ToolReplaySafety;
  readonly policyDenied?: boolean;
  readonly approvalDenied?: boolean;
}
export type ToolOutcomeClassifierDiagnostic =
  | 'classifier_missing'
  | 'classifier_threw'
  | 'classifier_conflict'
  | 'classifier_invalid';
export interface ToolOutcomeClassificationInput {
  readonly status: ToolOutcomeStatus;
  readonly failure?: ClassifiedFailure;
  readonly authority: ToolOutcomeAuthority;
  readonly toolAdvice?: ToolOutcomeClassifierAdvice;
  readonly lineage?: ToolOutcome['lineage'];
  readonly timing?: Partial<Omit<ToolOutcomeTiming, 'source'>>;
  readonly unknownFields?: UnknownToolFieldsObservation;
  readonly classifierDiagnostic?: ToolOutcomeClassifierDiagnostic;
}
type ToolAuthority = ToolOutcomeAuthority;
type UnknownOutcome = ToolOutcome;

export const TOOL_OUTCOME_NEVER_RECOVERY_: ToolRecovery = Object.freeze({
  disposition: 'never',
  maximumAdditionalCalls: 0,
  requiresNewModelResponse: false,
  safeAutomaticRetry: false,
});
const NEVER_RECOVERY = TOOL_OUTCOME_NEVER_RECOVERY_;

/* The aliases below keep the reducer's existing private vocabulary pointed at
 * the public State types; they do not define a second outcome contract. */

/** Pure projections for protocol, metrics, and UI adapters. */
export function toolOutcomeSucceeded(outcome: ToolOutcome): boolean {
  return outcome.status === 'success';
}

export function toolOutcomeProtocolStatus(
  outcome: ToolOutcome,
): 'success' | 'error' | 'cancelled' | 'timeout' | 'exhausted' {
  switch (outcome.status) {
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

export function toolOutcomeMetricStatus(outcome: ToolOutcome): ToolOutcomeStatus {
  return outcome.status;
}

const STRATEGIES: Readonly<Record<FailureKind, FailureStrategy>> = {
  model_invalid_tool_args: {
    retryable: true,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  model_refused: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  model_timeout: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  model_rate_limited: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  model_server_error: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  policy_denied: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  phase_deferred: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  phase_denied: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  approval_rejected: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  auto_review_rejected: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: false,
    journal: true,
  },
  plan_revision_requested: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: true,
    terminatesTurn: false,
    journal: true,
  },
  tool_runtime_error: {
    retryable: true,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  tool_timeout: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  tool_invalid_args: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  tool_not_found: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  provider_auth_required: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: false,
    journal: true,
  },
  provider_approval_required: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: false,
    journal: true,
  },
  provider_unavailable: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  },
  provider_capability_changed: {
    retryable: false,
    modelFixable: true,
    needsUserIntervention: true,
    terminatesTurn: false,
    journal: true,
  },
  user_input_cancelled: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  user_input_timeout: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: false,
  },
  sandbox_error: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  checkpoint_restore_error: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  transcript_invariant_error: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  loop_exhausted: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  budget_exceeded: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  artifact_invalid: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  profile_invalid: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  digest_invalid: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  workspace_untrusted: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  network_unavailable: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  worktree_unavailable: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  model_retry_exhausted: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  mcp_unavailable: {
    retryable: true,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  persistence_unavailable: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  resource_saturated: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  process_limit_exceeded: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  cancel_incomplete: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  compaction_unqualified: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  compaction_failed: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  verification_failed: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  verification_inconclusive: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  mandatory_policy_unavailable: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
  unknown: {
    retryable: false,
    modelFixable: false,
    needsUserIntervention: true,
    terminatesTurn: true,
    journal: true,
  },
};

const DETAIL_BY_KIND: Readonly<Record<FailureKind, readonly DetailCode[]>> = {
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
};

export function isToolFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value);
}
export const isRuntimeFailureKind = isToolFailureKind;
export function isToolOutcomeDetailCode(value: unknown): value is ToolOutcomeDetailCode {
  return typeof value === 'string' && (DETAIL_CODES as readonly string[]).includes(value);
}
export function isToolParseFailureCode(value: unknown): value is ToolParseFailureCode {
  return (
    value === 'invalid_json' ||
    value === 'invalid_arguments' ||
    value === 'unknown_tool' ||
    value === 'tool_unavailable'
  );
}
const isFailureKind = isToolFailureKind;
const isDetailCode = isToolOutcomeDetailCode;
export function classifyRuntimeFailure(
  kind: FailureKind,
  message: string,
  parseFailureCode?: ToolParseFailureCode,
): ClassifiedFailure {
  return { kind, message, ...STRATEGIES[kind], ...(parseFailureCode ? { parseFailureCode } : {}) };
}
const classifyFailure = classifyRuntimeFailure;

export function failureKindForToolParseFailure(
  code: ToolParseFailureCode,
): 'tool_invalid_args' | 'tool_not_found' {
  return code === 'unknown_tool' || code === 'tool_unavailable'
    ? 'tool_not_found'
    : 'tool_invalid_args';
}

const TERMINAL_REASON_BY_FAILURE_: Readonly<Partial<Record<FailureKind, TerminalReasonCode>>> =
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

export function terminalReasonForRuntimeFailure(kind: FailureKind): TerminalReasonCode {
  return TERMINAL_REASON_BY_FAILURE_[kind] ?? 'blocked';
}
function suppliedFailure(
  value: Readonly<Record<string, unknown>> | undefined,
): ClassifiedFailure | undefined {
  const kind = stringField(value ?? {}, 'kind');
  if (!isFailureKind(kind)) return undefined;
  const strategy = STRATEGIES[kind];
  const parseFailureCode = stringField(value ?? {}, 'parseFailureCode');
  return {
    kind,
    message: stringField(value ?? {}, 'message') ?? 'Runtime failure.',
    retryable: typeof value?.retryable === 'boolean' ? value.retryable : strategy.retryable,
    modelFixable:
      typeof value?.modelFixable === 'boolean' ? value.modelFixable : strategy.modelFixable,
    needsUserIntervention:
      typeof value?.needsUserIntervention === 'boolean'
        ? value.needsUserIntervention
        : strategy.needsUserIntervention,
    terminatesTurn:
      typeof value?.terminatesTurn === 'boolean' ? value.terminatesTurn : strategy.terminatesTurn,
    journal: typeof value?.journal === 'boolean' ? value.journal : strategy.journal,
    ...(isToolParseFailureCode(parseFailureCode) ? { parseFailureCode } : {}),
  };
}
function failureFor(event: KernelEvent): ClassifiedFailure | undefined {
  const payload = eventRecord(event);
  const supplied = suppliedFailure(recordField(payload, 'failure'));
  if (supplied) return supplied;
  if (event.type === 'tool.finished') {
    const result = recordField(payload, 'result');
    const reason = stringField(result ?? {}, 'terminationReason');
    if (reason === 'timed_out')
      return classifyFailure('tool_timeout', 'Tool execution exceeded its Runtime deadline.');
    if (reason === 'cancelled')
      return classifyFailure('user_input_cancelled', 'Tool execution was cancelled.');
    if (reason === 'sandbox_denied')
      return classifyFailure('sandbox_error', 'Sandbox denied tool execution.');
    if (result?.ok === false)
      return classifyFailure('tool_runtime_error', 'Tool returned a failed result.');
    return undefined;
  }
  if (event.type === 'tool.rejected')
    return classifyFailure('policy_denied', stringField(payload, 'reason') ?? 'Tool was rejected.');
  if (event.type === 'tool.cancelled')
    return classifyFailure(
      'user_input_cancelled',
      stringField(payload, 'reason') ?? 'Tool execution was cancelled.',
    );
  if (event.type === 'approval.rejected')
    return classifyFailure(
      'approval_rejected',
      stringField(payload, 'reason') ?? 'Approval was rejected.',
    );
  if (event.type === 'auto_review.completed')
    return classifyFailure('auto_review_rejected', 'Auto-review rejected the tool.');
  return classifyFailure('unknown', 'Runtime failure.');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(',')}}`;
}
function digestFailureIdentity(
  toolCallId: string,
  fingerprint: string,
  outcome: UnknownOutcome,
): string {
  return sha256Hex(
    stableStringify({
      toolCallId,
      invocationFingerprint: fingerprint,
      status: outcome.status,
      detailCode: outcome.failure?.detailCode ?? 'success',
    }),
  );
}
function epochMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number(match[7] ?? '0');
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis;
}
function durationBetween(start: string | undefined, end: string): number | undefined {
  const startMillis = epochMillis(start);
  const endMillis = epochMillis(end);
  return startMillis === undefined || endMillis === undefined || endMillis < startMillis
    ? undefined
    : endMillis - startMillis;
}
function finiteDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function baseRecovery(failure: ClassifiedFailure): ToolRecovery {
  if (failure.modelFixable)
    return {
      disposition: 'correct_args',
      maximumAdditionalCalls: 1,
      requiresNewModelResponse: true,
      safeAutomaticRetry: false,
    };
  if (failure.retryable)
    return {
      disposition: 'retry_once',
      maximumAdditionalCalls: 1,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    };
  if (failure.needsUserIntervention)
    return {
      disposition: 'user_action',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    };
  return NEVER_RECOVERY;
}
function automaticRetryAuthoritative(authority: ToolAuthority): boolean {
  if (authority.dispatchState === 'not_started' && authority.externalEffects === 'none')
    return true;
  if (authority.dispatchState !== 'started' || authority.externalEffects === 'unknown')
    return false;
  return authority.replaySafety === 'safe_read' || authority.replaySafety === 'idempotency_receipt';
}
function detailForFailure(failure: ClassifiedFailure): DetailCode {
  if (failure.parseFailureCode === 'invalid_json') return 'invalid_json';
  if (failure.parseFailureCode === 'unknown_tool') return 'unknown_tool';
  if (failure.parseFailureCode === 'tool_unavailable') return 'tool_unavailable';
  if (failure.parseFailureCode === 'invalid_arguments') return 'invalid_arguments';
  const mapped: Partial<Record<FailureKind, DetailCode>> = {
    model_invalid_tool_args: 'invalid_arguments',
    tool_invalid_args: 'invalid_arguments',
    tool_not_found: 'unknown_tool',
    policy_denied: 'policy_denied',
    mandatory_policy_unavailable: 'policy_denied',
    approval_rejected: 'approval_rejected',
    auto_review_rejected: 'auto_review_rejected',
    phase_deferred: 'phase_deferred',
    phase_denied: 'phase_denied',
    user_input_cancelled: 'cancelled_by_user',
    user_input_timeout: 'timed_out',
    tool_timeout: 'timed_out',
    model_timeout: 'timed_out',
    provider_unavailable: 'provider_unavailable',
    mcp_unavailable: 'provider_unavailable',
    provider_capability_changed: 'capability_changed',
    sandbox_error: 'sandbox_denied',
    persistence_unavailable: 'persistence_unavailable',
    budget_exceeded: 'resource_exhausted',
    resource_saturated: 'resource_exhausted',
    loop_exhausted: 'resource_exhausted',
    cancel_incomplete: 'process_cleanup_unknown',
    tool_runtime_error: 'runtime_exception',
    unknown: 'unknown',
  };
  return mapped[failure.kind] ?? 'unknown';
}
export function trustedToolTiming(
  input?: Partial<Omit<ToolOutcomeTiming, 'source'>>,
): ToolOutcomeTiming {
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
const trustedTiming = trustedToolTiming;

export function classifyToolOutcome(input: ToolOutcomeClassificationInput): ToolOutcome {
  if (input.status === 'success')
    return {
      schemaVersion: 1,
      status: 'success',
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      ...(input.authority.replaySafety ? { replaySafety: input.authority.replaySafety } : {}),
      recovery: NEVER_RECOVERY,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedTiming(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
    };
  const advice = input.toolAdvice;
  const invalidAdvice =
    (advice?.detailCode != null && !isDetailCode(advice.detailCode)) ||
    (advice?.maximumAdditionalCalls != null &&
      advice.maximumAdditionalCalls !== 0 &&
      advice.maximumAdditionalCalls !== 1);
  const conflictingAdviceDetail =
    input.failure != null &&
    advice?.detailCode != null &&
    isDetailCode(advice.detailCode) &&
    !DETAIL_BY_KIND[input.failure.kind].includes(advice.detailCode);
  const diagnostic = invalidAdvice
    ? 'classifier_invalid'
    : conflictingAdviceDetail
      ? 'classifier_conflict'
      : input.classifierDiagnostic;
  if (diagnostic)
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: diagnostic },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER_RECOVERY,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedTiming(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: [diagnostic],
    };
  const failure = input.failure;
  if (!failure)
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_missing' },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER_RECOVERY,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedTiming(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: ['classifier_missing'],
    };
  let recovery = baseRecovery(failure);
  if (
    input.authority.policyDenied ||
    input.authority.approvalDenied ||
    input.status === 'cancelled' ||
    input.status === 'timed_out' ||
    input.status === 'exhausted' ||
    input.authority.externalEffects === 'unknown'
  )
    recovery = NEVER_RECOVERY;
  const adviceDisposition = advice?.disposition;
  const conflictsWithCeiling =
    (advice?.maximumAdditionalCalls === 1 && recovery.maximumAdditionalCalls === 0) ||
    (advice?.safeAutomaticRetry === true &&
      (!automaticRetryAuthoritative(input.authority) || recovery.disposition !== 'retry_once')) ||
    (advice?.requiresNewModelResponse === false && recovery.requiresNewModelResponse) ||
    (advice?.retryAfterMs != null && recovery.disposition !== 'retry_once') ||
    (adviceDisposition != null &&
      adviceDisposition !== 'never' &&
      adviceDisposition !== recovery.disposition &&
      !(recovery.disposition === 'correct_args' && adviceDisposition === 'alternative'));
  if (conflictsWithCeiling)
    return {
      schemaVersion: 1,
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_conflict' },
      dispatchState: input.authority.dispatchState,
      externalEffects: input.authority.externalEffects,
      recovery: NEVER_RECOVERY,
      ...(input.lineage ? { lineage: input.lineage } : {}),
      timing: trustedTiming(input.timing),
      ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
      diagnosticCodes: ['classifier_conflict'],
    };
  if (adviceDisposition === 'never') recovery = NEVER_RECOVERY;
  if (
    recovery.disposition === 'retry_once' &&
    adviceDisposition != null &&
    adviceDisposition !== 'retry_once'
  )
    recovery = NEVER_RECOVERY;
  if (recovery.disposition === 'correct_args' && adviceDisposition === 'alternative')
    recovery = { ...recovery, disposition: 'alternative', maximumAdditionalCalls: 1 };
  if (recovery.disposition === 'retry_once') {
    const safe =
      automaticRetryAuthoritative(input.authority) && advice?.safeAutomaticRetry !== false;
    recovery = safe
      ? {
          ...recovery,
          safeAutomaticRetry: true,
          ...(finiteDuration(advice?.retryAfterMs) != null
            ? { retryAfterMs: finiteDuration(advice?.retryAfterMs) }
            : {}),
        }
      : NEVER_RECOVERY;
  }
  if (advice?.maximumAdditionalCalls === 0) recovery = NEVER_RECOVERY;
  if (advice?.capabilityIntent && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(advice.capabilityIntent))
    recovery = { ...recovery, capabilityIntent: advice.capabilityIntent };
  return {
    schemaVersion: 1,
    status: input.status,
    failure: {
      kind: failure.kind,
      detailCode:
        advice?.detailCode && isDetailCode(advice.detailCode)
          ? advice.detailCode
          : detailForFailure(failure),
    },
    dispatchState: input.authority.dispatchState,
    externalEffects: input.authority.externalEffects,
    ...(input.authority.replaySafety ? { replaySafety: input.authority.replaySafety } : {}),
    recovery,
    ...(input.lineage ? { lineage: input.lineage } : {}),
    timing: trustedTiming(input.timing),
    ...(input.unknownFields ? { unknownFields: input.unknownFields } : {}),
  };
}
function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict persisted-envelope validator. Unknown V1 fields fail closed. */
export function isToolOutcome(value: unknown): value is ToolOutcome {
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
  )
    return false;
  const status = String(value.status) as ToolOutcomeStatus;
  const dispatchState = String(value.dispatchState) as ToolAuthority['dispatchState'];
  const externalEffects = String(value.externalEffects) as ToolAuthority['externalEffects'];
  const replaySafety = value.replaySafety == null ? undefined : String(value.replaySafety);
  if (
    replaySafety != null &&
    !['none', 'pre_dispatch', 'safe_read', 'idempotency_receipt'].includes(replaySafety)
  )
    return false;
  if (
    (replaySafety === 'pre_dispatch' &&
      (dispatchState !== 'not_started' || externalEffects !== 'none')) ||
    (replaySafety === 'safe_read' && (dispatchState !== 'started' || externalEffects !== 'none')) ||
    (replaySafety === 'idempotency_receipt' &&
      (dispatchState !== 'started' || externalEffects === 'unknown')) ||
    (externalEffects === 'unknown' && replaySafety != null && replaySafety !== 'none') ||
    (dispatchState === 'not_started' && externalEffects !== 'none')
  )
    return false;
  if (status === 'success') {
    if (value.failure != null) return false;
  } else if (
    !isRecord(value.failure) ||
    !exactKeys(value.failure, ['kind', 'detailCode']) ||
    !isFailureKind(value.failure.kind) ||
    !isDetailCode(value.failure.detailCode)
  )
    return false;
  const recovery = value.recovery;
  if (
    !isRecord(recovery) ||
    !exactKeys(recovery, [
      'disposition',
      'maximumAdditionalCalls',
      'requiresNewModelResponse',
      'safeAutomaticRetry',
      'retryAfterMs',
      'capabilityIntent',
    ]) ||
    !['never', 'correct_args', 'retry_once', 'alternative', 'user_action'].includes(
      String(recovery.disposition),
    ) ||
    (recovery.maximumAdditionalCalls !== 0 && recovery.maximumAdditionalCalls !== 1) ||
    typeof recovery.requiresNewModelResponse !== 'boolean' ||
    typeof recovery.safeAutomaticRetry !== 'boolean' ||
    (recovery.retryAfterMs != null && finiteDuration(recovery.retryAfterMs) == null) ||
    (recovery.capabilityIntent != null &&
      (typeof recovery.capabilityIntent !== 'string' ||
        !/^[a-z][a-z0-9_.:-]{0,63}$/u.test(recovery.capabilityIntent)))
  )
    return false;
  let recoveryMatrixValid = false;
  switch (recovery.disposition) {
    case 'never':
      recoveryMatrixValid =
        recovery.maximumAdditionalCalls === 0 &&
        recovery.requiresNewModelResponse === false &&
        recovery.safeAutomaticRetry === false &&
        recovery.retryAfterMs == null;
      break;
    case 'correct_args':
      recoveryMatrixValid =
        recovery.maximumAdditionalCalls === 1 &&
        recovery.requiresNewModelResponse === true &&
        recovery.safeAutomaticRetry === false &&
        recovery.retryAfterMs == null;
      break;
    case 'retry_once':
      recoveryMatrixValid =
        recovery.maximumAdditionalCalls === 1 &&
        recovery.requiresNewModelResponse === false &&
        recovery.safeAutomaticRetry === true &&
        ((dispatchState === 'not_started' && externalEffects === 'none') ||
          (dispatchState === 'started' &&
            externalEffects !== 'unknown' &&
            (replaySafety === 'safe_read' || replaySafety === 'idempotency_receipt')));
      break;
    case 'alternative':
      recoveryMatrixValid =
        recovery.maximumAdditionalCalls === 1 &&
        recovery.requiresNewModelResponse === true &&
        recovery.safeAutomaticRetry === false &&
        recovery.retryAfterMs == null;
      break;
    case 'user_action':
      recoveryMatrixValid =
        recovery.maximumAdditionalCalls === 0 &&
        recovery.requiresNewModelResponse === false &&
        recovery.safeAutomaticRetry === false &&
        recovery.retryAfterMs == null;
      break;
  }
  if (
    !recoveryMatrixValid ||
    (status === 'success' && recovery.disposition !== 'never') ||
    (status === 'rejected' && recovery.disposition === 'retry_once') ||
    (['cancelled', 'timed_out', 'exhausted', 'unknown'].includes(status) &&
      recovery.disposition !== 'never')
  )
    return false;
  if (status !== 'success' && status !== 'unknown' && isRecord(value.failure)) {
    const kind = value.failure.kind as FailureKind;
    const detailCode = value.failure.detailCode as DetailCode;
    const recoveryDetail = ['recovery_not_allowed', 'recovery_exhausted', 'no_progress'].includes(
      detailCode,
    );
    if (!DETAIL_BY_KIND[kind].includes(detailCode) && !(status === 'exhausted' && recoveryDetail))
      return false;
    const authoritative = baseRecovery(classifyFailure(kind, 'redacted'));
    if (
      [
        'policy_denied',
        'mandatory_policy_unavailable',
        'approval_rejected',
        'auto_review_rejected',
      ].includes(kind) &&
      recovery.disposition !== 'never'
    )
      return false;
    if (
      recovery.disposition !== 'never' &&
      recovery.disposition !== authoritative.disposition &&
      !(authoritative.disposition === 'correct_args' && recovery.disposition === 'alternative')
    )
      return false;
  }
  const timing = value.timing;
  if (
    !isRecord(timing) ||
    !exactKeys(timing, ['source', 'queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs']) ||
    !['runtime_boundary', 'legacy_unknown'].includes(String(timing.source)) ||
    ['queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs'].some(
      (key) => timing[key] != null && finiteDuration(timing[key]) == null,
    )
  )
    return false;
  if (
    (timing.source === 'legacy_unknown' &&
      ['queueMs', 'executionMs', 'approvalWaitMs', 'totalActiveMs'].some(
        (key) => timing[key] != null,
      )) ||
    (timing.totalActiveMs != null &&
      ((timing.queueMs ?? 0) > timing.totalActiveMs ||
        (timing.executionMs ?? 0) > timing.totalActiveMs ||
        (timing.approvalWaitMs ?? 0) > timing.totalActiveMs))
  )
    return false;
  if (
    value.lineage != null &&
    (!isRecord(value.lineage) ||
      !exactKeys(value.lineage, ['failureInstanceId', 'recoveryOf']) ||
      Object.values(value.lineage).some(
        (identity) => typeof identity !== 'string' || !/^[a-f0-9]{64}$/u.test(identity),
      ))
  )
    return false;
  if (value.unknownFields != null) {
    const unknown = value.unknownFields;
    if (
      !isRecord(unknown) ||
      !exactKeys(unknown, ['hasUnknown', 'count', 'toolClass', 'schemaRevision']) ||
      typeof unknown.hasUnknown !== 'boolean' ||
      typeof unknown.count !== 'number' ||
      !Number.isInteger(unknown.count) ||
      unknown.count < 0 ||
      unknown.count > 255 ||
      !['builtin_read', 'builtin_write', 'builtin_execute', 'builtin_other', 'mcp_tool'].includes(
        String(unknown.toolClass),
      ) ||
      typeof unknown.schemaRevision !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,64}$/u.test(unknown.schemaRevision) ||
      unknown.hasUnknown !== unknown.count > 0
    )
      return false;
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
  )
    return false;
  if (status === 'unknown') {
    const diagnosticCode = Array.isArray(value.diagnosticCodes)
      ? value.diagnosticCodes[0]
      : undefined;
    if (
      !isRecord(value.failure) ||
      value.failure.kind !== 'unknown' ||
      ![
        'classifier_missing',
        'classifier_threw',
        'classifier_conflict',
        'classifier_invalid',
      ].includes(String(value.failure.detailCode)) ||
      diagnosticCode !== value.failure.detailCode
    )
      return false;
  } else if (value.diagnosticCodes != null) return false;
  return true;
}
function assertCanonicalOutcome(value: unknown, eventType: string): void {
  if (!isToolOutcome(value)) throw new Error(`${eventType} has invalid canonical ToolOutcome.`);
}

/** Reject non-canonical terminal evidence before the pure reducer consumes it. */
export function assertCanonicalToolOutcomeEvent(event: KernelEvent): void {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
    case 'tool.retry_recorded':
    case 'approval.rejected':
      assertCanonicalOutcome(payload.outcome, event.type);
      return;
    case 'auto_review.completed': {
      const result = recordField(payload, 'result');
      if (result?.ok === true && result.approved !== true && result.escalatedToUser !== true)
        assertCanonicalOutcome(payload.outcome, event.type);
      else if (Object.hasOwn(payload, 'outcome'))
        throw new Error('Non-terminal auto_review.completed cannot carry ToolOutcome.');
      return;
    }
    default:
      return;
  }
}

function normalizeToolTerminalEvent(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  const payload = eventRecord(event);
  const toolCallId = stringField(payload, 'toolCallId') ?? '';
  const call = state.tools.calls[toolCallId];
  const result = recordField(payload, 'result');
  const reason = stringField(result ?? {}, 'terminationReason');
  const supplied = suppliedFailure(recordField(payload, 'failure'));
  const failure = supplied ?? failureFor(event);
  const status: ToolOutcomeStatus =
    event.type === 'tool.finished'
      ? reason === 'timed_out'
        ? 'timed_out'
        : reason === 'cancelled'
          ? 'cancelled'
          : stringField(result ?? {}, 'status') === 'exhausted'
            ? 'exhausted'
            : result?.ok === true
              ? 'success'
              : 'failed'
      : event.type === 'tool.rejected'
        ? 'rejected'
        : event.type === 'tool.cancelled'
          ? 'cancelled'
          : failure?.kind === 'tool_timeout' || failure?.kind === 'user_input_timeout'
            ? 'timed_out'
            : failure?.kind === 'loop_exhausted' || failure?.kind === 'budget_exceeded'
              ? 'exhausted'
              : 'failed';
  const createdAt = stringField(payload, 'createdAt') ?? occurredAt;
  const previouslyStarted = call?.startedAt != null || state.tools.active.includes(toolCallId);
  const dispatchState: ToolAuthority['dispatchState'] =
    call?.status === 'queued' ||
    ((call?.status === 'approved' || call?.status === 'authorized_queued') && !previouslyStarted)
      ? 'not_started'
      : call?.status === 'running' || previouslyStarted
        ? 'started'
        : 'unknown';
  const externalEffects: ToolAuthority['externalEffects'] =
    dispatchState === 'not_started'
      ? 'none'
      : event.type === 'tool.rejected' ||
          event.type === 'tool.cancelled' ||
          event.type === 'tool.failed'
        ? dispatchState === 'started'
          ? 'unknown'
          : 'none'
        : call?.sideEffect
          ? recordField(result ?? {}, 'resultMeta')?.processCleanupConfirmed === false
            ? 'unknown'
            : result?.ok === true
              ? 'known'
              : 'unknown'
          : 'none';
  const replaySafety: ToolAuthority['replaySafety'] =
    dispatchState === 'not_started' && externalEffects === 'none'
      ? 'pre_dispatch'
      : dispatchState === 'started' &&
          call?.effectClass === 'read_only' &&
          externalEffects !== 'unknown'
        ? 'safe_read'
        : 'none';
  const recoveryBlocked = call?.recoveryAdmission != null && call.recoveryAdmission !== 'admitted';
  const advice = recoveryBlocked
    ? {
        detailCode: call.recoveryAdmission,
        disposition: 'never' as const,
        maximumAdditionalCalls: 0,
        safeAutomaticRetry: false,
      }
    : event.type === 'tool.finished' && result?.ok === false
      ? (recordField(payload, 'classifierAdvice') as ToolAdvice | undefined)
      : undefined;
  const classifierDiagnostic =
    event.type === 'tool.finished' &&
    status === 'failed' &&
    failure?.kind === 'tool_runtime_error' &&
    !recoveryBlocked
      ? ((stringField(payload, 'classifierDiagnostic') as
          | 'classifier_missing'
          | 'classifier_threw'
          | 'classifier_conflict'
          | 'classifier_invalid'
          | undefined) ?? (advice ? undefined : 'classifier_missing'))
      : undefined;
  const outcome = classifyToolOutcome({
    status,
    failure: status === 'success' ? undefined : failure,
    authority: {
      dispatchState,
      externalEffects,
      replaySafety,
      policyDenied:
        failure?.kind === 'policy_denied' || failure?.kind === 'mandatory_policy_unavailable',
      approvalDenied:
        failure?.kind === 'approval_rejected' || failure?.kind === 'auto_review_rejected',
    },
    lineage: call?.recoveryOf ? { recoveryOf: call.recoveryOf } : undefined,
    timing: {
      queueMs: durationBetween(call?.queuedAt, call?.startedAt ?? createdAt),
      executionMs: durationBetween(call?.startedAt, createdAt),
      approvalWaitMs: call?.approvalWaitMs,
      totalActiveMs: durationBetween(call?.queuedAt, createdAt),
    },
    unknownFields: call?.unknownFields,
    ...(advice ? { toolAdvice: advice } : {}),
    ...(classifierDiagnostic ? { classifierDiagnostic } : {}),
  });
  const outcomeWithLineage =
    status !== 'success' && call?.invocationFingerprint
      ? {
          ...outcome,
          lineage: {
            ...outcome.lineage,
            failureInstanceId: digestFailureIdentity(
              toolCallId,
              call.invocationFingerprint,
              outcome,
            ),
          },
        }
      : outcome;
  return { ...event, createdAt, outcome: outcomeWithLineage } as unknown as KernelEvent;
}
function normalizeApprovalRejected(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  const payload = eventRecord(event);
  const toolCallId = stringField(payload, 'toolCallId');
  const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
  const createdAt = stringField(payload, 'createdAt') ?? occurredAt;
  return {
    ...event,
    createdAt,
    outcome: classifyToolOutcome({
      status: 'rejected',
      failure:
        suppliedFailure(recordField(payload, 'failure')) ??
        classifyFailure(
          'approval_rejected',
          stringField(payload, 'reason') ?? 'Approval was rejected.',
        ),
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        approvalDenied: true,
      },
      timing: {
        queueMs: durationBetween(call?.queuedAt, createdAt),
        approvalWaitMs: durationBetween(call?.approvalRequestedAt, createdAt),
        totalActiveMs: durationBetween(call?.queuedAt, createdAt),
      },
      unknownFields: call?.unknownFields,
    }),
  } as unknown as KernelEvent;
}
function normalizeAutoReviewCompleted(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  const payload = eventRecord(event);
  const result = recordField(payload, 'result');
  if (result?.ok !== true || result.approved === true || result.escalatedToUser === true) {
    const { outcome: _outcome, ...nonTerminal } = payload;
    return { type: event.type, ...nonTerminal } as unknown as KernelEvent;
  }
  const toolCallId = stringField(payload, 'toolCallId');
  const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
  const createdAt = stringField(payload, 'createdAt') ?? occurredAt;
  const queueMs = durationBetween(call?.queuedAt, createdAt);
  const approvalWaitMs = finiteDuration(result.durationMs);
  const totalActiveMs = Math.max(queueMs ?? 0, approvalWaitMs ?? 0);
  return {
    ...event,
    createdAt,
    outcome: classifyToolOutcome({
      status: 'rejected',
      failure: classifyFailure('auto_review_rejected', 'Auto-review rejected the tool.'),
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        approvalDenied: true,
      },
      timing: { queueMs, approvalWaitMs, totalActiveMs },
      unknownFields: call?.unknownFields,
    }),
  } as unknown as KernelEvent;
}

/** Pure equivalent of the legacy terminal outcome normalizer. */
export function normalizeTerminalAgentEvent(event: KernelEvent): KernelEvent {
  const payload = eventRecord(event);
  if (event.type === 'run.completed' && !Object.hasOwn(payload, 'outcome'))
    return {
      ...event,
      outcome: {
        version: 1,
        status: 'completed',
        reasonCode: 'completed',
        knownExternalEffects: 'known',
        safeRetry: false,
        recoveryEntry: 'none',
        pendingVerification: false,
      },
    } as unknown as KernelEvent;
  if (event.type === 'run.error' && !Object.hasOwn(payload, 'outcome')) {
    const failure =
      suppliedFailure(recordField(payload, 'failure')) ??
      failureFor(event) ??
      classifyFailure('unknown', 'Runtime failure.');
    const reasonByKind: Partial<Record<FailureKind, string>> = {
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
    };
    const reasonCode = reasonByKind[failure.kind] ?? 'blocked';
    const knownExternalEffects = failure.kind === 'unknown' ? 'unknown' : 'known';
    const supplied = recordField(payload, 'failure');
    return {
      ...event,
      failure: supplied ?? {
        ...failure,
        message: stringField(payload, 'message') ?? failure.message,
      },
      outcome: {
        version: 1,
        status:
          reasonCode === 'budget_exhausted' || reasonCode === 'resource_saturated'
            ? reasonCode
            : failure.kind === 'unknown'
              ? 'unknown'
              : failure.needsUserIntervention
                ? 'blocked'
                : 'aborted',
        reasonCode,
        knownExternalEffects,
        safeRetry: failure.retryable && knownExternalEffects !== 'unknown',
        recoveryEntry:
          knownExternalEffects === 'unknown'
            ? 'reconcile'
            : failure.retryable
              ? 'retry'
              : failure.needsUserIntervention
                ? 'operator_action'
                : 'new_run',
        pendingVerification: false,
      },
    } as unknown as KernelEvent;
  }
  return event;
}

/** Pure equivalent of the legacy ToolOutcome canonicalization boundary. */
export function normalizeAgentToolOutcomeEvent(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
      return normalizeToolTerminalEvent(event, state, occurredAt);
    case 'approval.rejected':
      return normalizeApprovalRejected(event, state, occurredAt);
    case 'auto_review.completed':
      return normalizeAutoReviewCompleted(event, state, occurredAt);
    default:
      return event;
  }
}
/** Preserve the baseline order: terminal normalization, then ToolOutcome normalization. */
export function normalizeAgentEvent(
  event: KernelEvent,
  state: Readonly<AgentState>,
  occurredAt: string,
): KernelEvent {
  return normalizeAgentToolOutcomeEvent(normalizeTerminalAgentEvent(event), state, occurredAt);
}
