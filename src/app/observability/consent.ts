import type { MetricNameV1 } from '@/core/observability/metrics';

export const TELEMETRY_METRIC_CATEGORIES_V1 = [
  'run_turn',
  'model_usage',
  'tool_mcp_skill',
  'runtime_resource',
  'release_rollout',
] as const;
export type TelemetryMetricCategoryV1 = (typeof TELEMETRY_METRIC_CATEGORIES_V1)[number];

export const TELEMETRY_METRICS_BY_CATEGORY_V1 = Object.freeze({
  run_turn: Object.freeze(['run_total', 'run_duration_ms', 'turn_total']),
  model_usage: Object.freeze(['model_request_total', 'model_duration_ms', 'model_tokens_total']),
  tool_mcp_skill: Object.freeze([
    'tool_total',
    'mcp_total',
    'skill_total',
    'plan_total',
    'verification_total',
    'agent_task_stage_total',
  ]),
  runtime_resource: Object.freeze([
    'compaction_total',
    'compaction_duration_ms',
    'runtime_hard_block_total',
    'runtime_late_terminal_rejection_total',
    'runtime_cancel_incomplete_total',
    'runtime_orphan_total',
    'runtime_recovery_total',
    'runtime_rss_bytes',
    'runtime_event_loop_lag_ms',
    'runtime_listener_count',
    'runtime_fd_count',
    'runtime_handle_count',
    'resource_active_invocations',
    'resource_reserved_invocations',
    'process_tree_high_water',
    'process_tree_limit_termination_total',
    'read_batch_size',
    'concurrency_wait_ms',
    'concurrency_saturation_total',
    'approval_sibling_total',
    'budget_exhausted_total',
    'artifact_bytes_total',
    'session_log_bytes_total',
    'telemetry_dropped_total',
  ]),
  release_rollout: Object.freeze(['release_rollout_total']),
} satisfies Readonly<Record<TelemetryMetricCategoryV1, readonly MetricNameV1[]>>);

export function allowedMetricNamesForConsentV1(
  categories: readonly TelemetryMetricCategoryV1[],
): ReadonlySet<MetricNameV1> {
  return new Set(categories.flatMap((category) => TELEMETRY_METRICS_BY_CATEGORY_V1[category]));
}
export type TelemetryEndpointPolicyV1 = 'disabled' | 'vendor_managed' | 'admin_managed';

export interface TelemetryConsentGrantV1 {
  state: 'granted' | 'withdrawn';
  metricCategories: readonly TelemetryMetricCategoryV1[];
  receiver: string;
  retentionDays: number;
  withdrawalMethod: string;
  canaryOptIn: boolean;
}

export interface UserTelemetryConfigV1 {
  enabled?: boolean;
  endpointPolicy?: TelemetryEndpointPolicyV1;
  /** Accepted by the transport composition but never exposed by status. */
  endpointSecret?: string;
  consent?: TelemetryConsentGrantV1;
  contentLoggingConsent?: boolean;
  modelProviderConsent?: boolean;
}

export interface ProjectTelemetryConfigV1 {
  enabled?: boolean;
}

export interface AdminObservabilityPolicyV1 {
  forceTelemetryDisabled?: boolean;
  endpointPolicy?: 'disabled' | 'admin_managed';
  mandatoryAudit?: {
    required: boolean;
    available: boolean;
  };
}

export interface TelemetryConsentStatusV1 {
  enabled: boolean;
  consent: 'granted' | 'not_granted' | 'withdrawn';
  endpointPolicy: TelemetryEndpointPolicyV1;
  metricCategories: readonly TelemetryMetricCategoryV1[];
  receiver?: string;
  retentionDays?: number;
  withdrawalMethod?: string;
  reason:
    | 'enabled'
    | 'default_off'
    | 'user_disabled'
    | 'consent_missing'
    | 'consent_withdrawn'
    | 'canary_opt_in_missing'
    | 'project_enable_forbidden'
    | 'project_disabled'
    | 'admin_forced_off'
    | 'endpoint_disabled';
  managedSessionAdmission: 'admitted' | 'denied';
  mandatoryAudit: 'not_required' | 'available' | 'unavailable';
}

export function resolveTelemetryConsentV1(input: {
  releaseChannel: 'development' | 'internal' | 'limited' | 'canary' | 'ga';
  user?: UserTelemetryConfigV1;
  project?: ProjectTelemetryConfigV1;
  admin?: AdminObservabilityPolicyV1;
}): TelemetryConsentStatusV1 {
  const audit = input.admin?.mandatoryAudit;
  const mandatoryAudit = !audit?.required
    ? 'not_required'
    : audit.available
      ? 'available'
      : 'unavailable';
  const managedSessionAdmission = mandatoryAudit === 'unavailable' ? 'denied' : 'admitted';
  const disabled = (
    reason: Exclude<TelemetryConsentStatusV1['reason'], 'enabled'>,
    consent: TelemetryConsentStatusV1['consent'] = 'not_granted',
  ): TelemetryConsentStatusV1 => ({
    enabled: false,
    consent,
    endpointPolicy: input.admin?.endpointPolicy ?? input.user?.endpointPolicy ?? 'disabled',
    metricCategories: Object.freeze([]),
    reason,
    managedSessionAdmission,
    mandatoryAudit,
  });

  if (input.admin?.forceTelemetryDisabled || input.admin?.endpointPolicy === 'disabled') {
    return disabled('admin_forced_off');
  }
  if (input.project?.enabled === true) return disabled('project_enable_forbidden');
  if (input.project?.enabled === false) return disabled('project_disabled');
  if (input.user?.enabled !== true) {
    return disabled(input.user?.enabled === false ? 'user_disabled' : 'default_off');
  }
  const consent = input.user.consent;
  if (!consent) return disabled('consent_missing');
  if (consent.state === 'withdrawn') return disabled('consent_withdrawn', 'withdrawn');
  if (input.releaseChannel === 'canary' && !consent.canaryOptIn) {
    return disabled('canary_opt_in_missing');
  }
  const endpointPolicy = input.admin?.endpointPolicy ?? input.user.endpointPolicy ?? 'disabled';
  if (endpointPolicy === 'disabled') return disabled('endpoint_disabled');
  if (!Number.isInteger(consent.retentionDays) || consent.retentionDays < 0) {
    throw new Error('Telemetry retentionDays must be a non-negative integer.');
  }
  if (!consent.receiver.trim() || !consent.withdrawalMethod.trim()) {
    throw new Error('Telemetry consent must identify receiver and withdrawal method.');
  }
  const categories = [...new Set(consent.metricCategories)];
  if (
    categories.length === 0 ||
    categories.some((category) => !TELEMETRY_METRIC_CATEGORIES_V1.includes(category))
  ) {
    throw new Error('Telemetry consent contains unknown or empty metric categories.');
  }
  return Object.freeze({
    enabled: true,
    consent: 'granted' as const,
    endpointPolicy,
    metricCategories: Object.freeze(categories),
    receiver: consent.receiver,
    retentionDays: consent.retentionDays,
    withdrawalMethod: consent.withdrawalMethod,
    reason: 'enabled' as const,
    managedSessionAdmission,
    mandatoryAudit,
  });
}

/** Safe CLI/TUI projection: endpoint material and unrelated consents are absent by construction. */
export function projectTelemetryStatusV1(status: TelemetryConsentStatusV1): Readonly<{
  enabled: boolean;
  consent: TelemetryConsentStatusV1['consent'];
  endpointPolicy: TelemetryEndpointPolicyV1;
  metricCategories: readonly TelemetryMetricCategoryV1[];
  receiver?: string;
  retentionDays?: number;
  withdrawalMethod?: string;
  reason: TelemetryConsentStatusV1['reason'];
  managedSessionAdmission: TelemetryConsentStatusV1['managedSessionAdmission'];
  mandatoryAudit: TelemetryConsentStatusV1['mandatoryAudit'];
}> {
  return Object.freeze({
    enabled: status.enabled,
    consent: status.consent,
    endpointPolicy: status.endpointPolicy,
    metricCategories: status.metricCategories,
    ...(status.receiver ? { receiver: status.receiver } : {}),
    ...(status.retentionDays !== undefined ? { retentionDays: status.retentionDays } : {}),
    ...(status.withdrawalMethod ? { withdrawalMethod: status.withdrawalMethod } : {}),
    reason: status.reason,
    managedSessionAdmission: status.managedSessionAdmission,
    mandatoryAudit: status.mandatoryAudit,
  });
}
