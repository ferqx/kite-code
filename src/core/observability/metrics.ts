export const OBSERVABILITY_METRICS_VERSION = 1 as const;
export const MAX_METRIC_SAMPLE_BYTES_V1 = 1_024 as const;

export type MetricKindV1 = 'counter' | 'gauge' | 'histogram';
export type MetricPriorityV1 = 'low' | 'normal' | 'critical';
export type MetricPrivacyV1 = 'non_content_low_cardinality';

export const METRIC_ATTRIBUTE_KEYS = [
  'outcome',
  'reason',
  'resource',
  'route',
  'profile',
  'cohort',
  'capability',
  'source',
  'status',
  'stage',
] as const;
export type MetricAttributeKeyV1 = (typeof METRIC_ATTRIBUTE_KEYS)[number];
export type MetricAttributesV1 = Readonly<Partial<Record<MetricAttributeKeyV1, string>>>;
export type MetricDynamicAliasKeyV1 = 'route' | 'capability';
export type MetricControlledAliasRegistryV1 = Readonly<
  Partial<Record<MetricDynamicAliasKeyV1, ReadonlySet<string>>>
>;

const CONTROLLED_ALIAS_PATTERN_V1 = /^[a-z0-9][a-z0-9._:-]{0,47}$/;
const FIXED_DYNAMIC_ALIASES_V1 = new Set(['custom/unknown', 'other']);

const FINITE_ATTRIBUTE_VALUES: Readonly<
  Partial<Record<MetricAttributeKeyV1, ReadonlySet<string>>>
> = Object.freeze({
  outcome: new Set([
    'completed',
    'cancelled',
    'failed',
    'success',
    'retry',
    'timeout',
    'terminated',
    'active',
    'unknown',
    'started',
    'closed',
    'invalidated',
    'drafted',
    'rejected',
    'passed',
    'inconclusive',
    'waived',
    'reset',
    'cleared',
    'admitted',
    'blocked',
    'rolled_back',
    'timed_out',
    'not_dispatched',
    'aborted',
    'budget_exhausted',
    'resource_saturated',
  ]),
  reason: new Set([
    'completed',
    'model',
    'policy',
    'tool',
    'provider',
    'sandbox',
    'runtime',
    'budget',
    'resource',
    'compaction',
    'verification',
    'cancellation',
    'late_or_stale_action',
    'queue_full',
    'exporter_failure',
    'unknown',
  ]),
  resource: new Set([
    'tool',
    'shell_invocation',
    'shell_descendant',
    'input',
    'output',
    'run_duration',
    'turn',
    'model_request',
    'token',
    'artifact',
    'unknown',
  ]),
  profile: new Set(['internal', 'limited', 'canary', 'ga']),
  cohort: new Set(['internal', 'limited', 'canary', 'general', 'unknown']),
  source: new Set(['runtime', 'session_logger', 'checkpoint', 'hard_block']),
  status: new Set(['ready', 'blocked', 'active', 'unknown']),
  stage: new Set(['checks', 'human_accepted', 'integrated', 'reverted']),
});

export interface MetricDefinitionV1 {
  version: 1;
  name: string;
  kind: MetricKindV1;
  allowedAttributes: readonly MetricAttributeKeyV1[];
  cardinalityLimit: number;
  producer: string;
  consumers: readonly string[];
  privacy: MetricPrivacyV1;
  priority: MetricPriorityV1;
}

function metric(
  name: string,
  kind: MetricKindV1,
  allowedAttributes: readonly MetricAttributeKeyV1[],
  cardinalityLimit: number,
  producer: string,
  consumers: readonly string[],
  priority: MetricPriorityV1 = 'normal',
): MetricDefinitionV1 {
  return Object.freeze({
    version: OBSERVABILITY_METRICS_VERSION,
    name,
    kind,
    allowedAttributes: Object.freeze([...allowedAttributes]),
    cardinalityLimit,
    producer,
    consumers: Object.freeze([...consumers]),
    privacy: 'non_content_low_cardinality' as const,
    priority,
  });
}

export const METRIC_DEFINITIONS_V1 = Object.freeze({
  run_total: metric('run_total', 'counter', ['outcome', 'reason'], 64, 'Runtime terminal', ['SLO']),
  run_duration_ms: metric('run_duration_ms', 'histogram', ['outcome'], 8, 'Runtime terminal', [
    'SLO',
  ]),
  turn_total: metric('turn_total', 'counter', ['outcome'], 8, 'Runtime Event', ['SLO']),
  model_request_total: metric(
    'model_request_total',
    'counter',
    ['outcome', 'route'],
    64,
    'model metadata',
    ['SLO'],
  ),
  model_duration_ms: metric(
    'model_duration_ms',
    'histogram',
    ['outcome', 'route'],
    64,
    'model metadata',
    ['SLO'],
  ),
  model_tokens_total: metric(
    'model_tokens_total',
    'counter',
    ['resource', 'route'],
    64,
    'model usage',
    ['budget'],
    'low',
  ),
  tool_total: metric('tool_total', 'counter', ['outcome', 'capability'], 96, 'Runtime Event', [
    'SLO',
  ]),
  mcp_total: metric('mcp_total', 'counter', ['outcome', 'capability'], 96, 'Receipt metadata', [
    'SLO',
  ]),
  skill_total: metric('skill_total', 'counter', ['outcome'], 8, 'Runtime Event', ['SLO']),
  plan_total: metric('plan_total', 'counter', ['outcome'], 12, 'Runtime Event', ['SLO']),
  verification_total: metric('verification_total', 'counter', ['outcome'], 12, 'Runtime Event', [
    'release_gate',
  ]),
  compaction_total: metric(
    'compaction_total',
    'counter',
    ['outcome', 'reason'],
    48,
    'Runtime Event',
    ['SLO', 'alert'],
  ),
  compaction_duration_ms: metric(
    'compaction_duration_ms',
    'histogram',
    ['outcome'],
    8,
    'compaction metadata',
    ['SLO'],
  ),
  runtime_hard_block_total: metric(
    'runtime_hard_block_total',
    'counter',
    ['reason'],
    32,
    'Runtime Event',
    ['G0', 'alert'],
    'critical',
  ),
  runtime_late_terminal_rejection_total: metric(
    'runtime_late_terminal_rejection_total',
    'counter',
    ['reason'],
    32,
    'Runtime metadata',
    ['G0'],
    'critical',
  ),
  runtime_cancel_incomplete_total: metric(
    'runtime_cancel_incomplete_total',
    'counter',
    ['reason'],
    32,
    'Runtime cancellation metadata',
    ['G0', 'alert'],
    'critical',
  ),
  runtime_orphan_total: metric(
    'runtime_orphan_total',
    'counter',
    ['resource'],
    8,
    'Runtime cancellation metadata',
    ['G0', 'alert'],
    'critical',
  ),
  runtime_recovery_total: metric(
    'runtime_recovery_total',
    'counter',
    ['source', 'outcome'],
    24,
    'Runtime lifecycle metadata',
    ['SLO'],
  ),
  runtime_rss_bytes: metric('runtime_rss_bytes', 'gauge', [], 1, 'App resource metadata', [
    'SLO',
    'alert',
  ]),
  runtime_event_loop_lag_ms: metric(
    'runtime_event_loop_lag_ms',
    'histogram',
    [],
    1,
    'App resource metadata',
    ['SLO', 'alert'],
  ),
  runtime_listener_count: metric(
    'runtime_listener_count',
    'gauge',
    [],
    1,
    'App resource metadata',
    ['SLO'],
  ),
  runtime_fd_count: metric('runtime_fd_count', 'gauge', [], 1, 'App resource metadata', ['SLO']),
  runtime_handle_count: metric('runtime_handle_count', 'gauge', [], 1, 'App resource metadata', [
    'SLO',
  ]),
  resource_active_invocations: metric(
    'resource_active_invocations',
    'gauge',
    ['resource'],
    12,
    'ResourceBudgetV1',
    ['SLO'],
  ),
  resource_reserved_invocations: metric(
    'resource_reserved_invocations',
    'gauge',
    ['resource'],
    12,
    'ResourceBudgetV1',
    ['SLO'],
  ),
  process_tree_high_water: metric('process_tree_high_water', 'gauge', [], 1, 'sandbox metadata', [
    'SLO',
  ]),
  process_tree_limit_termination_total: metric(
    'process_tree_limit_termination_total',
    'counter',
    ['outcome'],
    4,
    'ClassifiedFailure',
    ['G0', 'alert'],
    'critical',
  ),
  read_batch_size: metric(
    'read_batch_size',
    'histogram',
    [],
    1,
    'scheduler metadata',
    ['SLO'],
    'low',
  ),
  concurrency_wait_ms: metric(
    'concurrency_wait_ms',
    'histogram',
    ['resource', 'outcome'],
    24,
    'ResourceBudgetV1',
    ['SLO'],
  ),
  concurrency_saturation_total: metric(
    'concurrency_saturation_total',
    'counter',
    ['resource'],
    12,
    'ResourceBudgetV1',
    ['SLO', 'alert'],
  ),
  approval_sibling_total: metric(
    'approval_sibling_total',
    'counter',
    ['outcome'],
    8,
    'scheduler metadata',
    ['G0'],
  ),
  budget_exhausted_total: metric(
    'budget_exhausted_total',
    'counter',
    ['resource'],
    12,
    'ResourceBudgetV1',
    ['SLO', 'alert'],
    'critical',
  ),
  artifact_bytes_total: metric(
    'artifact_bytes_total',
    'counter',
    ['source'],
    12,
    'artifact metadata',
    ['SLO'],
  ),
  session_log_bytes_total: metric(
    'session_log_bytes_total',
    'counter',
    ['source'],
    8,
    'session logger metadata',
    ['SLO'],
  ),
  agent_task_stage_total: metric(
    'agent_task_stage_total',
    'counter',
    ['stage', 'outcome'],
    24,
    'evaluation metadata',
    ['SLO', 'release_gate'],
  ),
  release_rollout_total: metric(
    'release_rollout_total',
    'counter',
    ['profile', 'cohort', 'outcome'],
    64,
    'Release Profile projection',
    ['SLO', 'release_gate'],
  ),
  telemetry_dropped_total: metric(
    'telemetry_dropped_total',
    'counter',
    ['reason'],
    12,
    'bounded reporter',
    ['alert'],
    'critical',
  ),
});

export type MetricNameV1 = keyof typeof METRIC_DEFINITIONS_V1;

export interface MetricSampleV1 {
  version: 1;
  name: MetricNameV1;
  kind: MetricKindV1;
  value: number;
  observedAt: string;
  attributes: MetricAttributesV1;
}

const METRIC_SAMPLE_KEYS_V1 = [
  'attributes',
  'kind',
  'name',
  'observedAt',
  'value',
  'version',
] as const;

/**
 * Rebuild an untrusted sample at the reporter boundary. TypeScript types are
 * not a privacy boundary, so unknown fields and caller-supplied kind/version
 * values must be rejected before anything reaches an exporter.
 */
export function parseMetricSampleV1(
  value: unknown,
  controlledAliases: MetricControlledAliasRegistryV1 = {},
): MetricSampleV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Metric sample must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== METRIC_SAMPLE_KEYS_V1.length ||
    keys.some((key, index) => key !== METRIC_SAMPLE_KEYS_V1[index])
  ) {
    throw new Error('Metric sample has missing or unknown fields.');
  }
  if (typeof record.name !== 'string' || !Object.hasOwn(METRIC_DEFINITIONS_V1, record.name)) {
    throw new Error('Metric sample name is not allowlisted.');
  }
  if (
    !record.attributes ||
    typeof record.attributes !== 'object' ||
    Array.isArray(record.attributes)
  ) {
    throw new Error('Metric sample attributes must be an object.');
  }
  const normalizedAttributes = Object.fromEntries(
    Object.entries(record.attributes).map(([key, entry]) => {
      if (key !== 'route' && key !== 'capability') return [key, entry];
      if (typeof entry !== 'string') return [key, entry];
      if (FIXED_DYNAMIC_ALIASES_V1.has(entry)) return [key, entry];
      return [key, controlledAliases[key]?.has(entry) ? entry : 'custom/unknown'];
    }),
  ) as MetricAttributesV1;
  const rebuilt = createMetricSampleV1({
    name: record.name as MetricNameV1,
    value: record.value as number,
    observedAt: record.observedAt as string,
    attributes: normalizedAttributes,
  });
  if (record.version !== rebuilt.version || record.kind !== rebuilt.kind) {
    throw new Error('Metric sample version or kind does not match its definition.');
  }
  return rebuilt;
}

export function createMetricSampleV1(input: {
  name: MetricNameV1;
  value?: number;
  observedAt: string;
  attributes?: MetricAttributesV1;
}): MetricSampleV1 {
  const definition = METRIC_DEFINITIONS_V1[input.name];
  const value = input.value ?? 1;
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Metric value must be finite and non-negative.');
  if (
    input.observedAt.length > 32 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    throw new Error('Metric observedAt must be ISO-8601.');
  const attributes = input.attributes ?? {};
  const allowed = new Set(definition.allowedAttributes);
  for (const [key, entry] of Object.entries(attributes)) {
    if (
      !METRIC_ATTRIBUTE_KEYS.includes(key as MetricAttributeKeyV1) ||
      !allowed.has(key as MetricAttributeKeyV1)
    ) {
      throw new Error(`Metric ${input.name} does not allow attribute ${key}.`);
    }
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) {
      throw new Error(`Metric ${input.name} attribute ${key} is invalid.`);
    }
    const finiteValues = FINITE_ATTRIBUTE_VALUES[key as MetricAttributeKeyV1];
    if (finiteValues && !finiteValues.has(entry)) {
      throw new Error(`Metric ${input.name} attribute ${key} has an unknown enum value.`);
    }
    if (
      (key === 'route' || key === 'capability') &&
      entry !== 'custom/unknown' &&
      entry !== 'other' &&
      !CONTROLLED_ALIAS_PATTERN_V1.test(entry)
    ) {
      throw new Error(`Metric ${input.name} attribute ${key} is not a controlled alias.`);
    }
  }
  return Object.freeze({
    version: OBSERVABILITY_METRICS_VERSION,
    name: input.name,
    kind: definition.kind,
    value,
    observedAt: input.observedAt,
    attributes: Object.freeze({ ...attributes }),
  });
}

export function metricPriorityV1(sample: MetricSampleV1): MetricPriorityV1 {
  return METRIC_DEFINITIONS_V1[sample.name].priority;
}
