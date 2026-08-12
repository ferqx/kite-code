import { createHash } from 'node:crypto';

export const CONTEXT_STRATEGY_PROFILES_V1 = [
  'raw',
  'rolling_summary',
  'local_projection',
  'progressive',
] as const;

export type ContextStrategyProfileV1 = (typeof CONTEXT_STRATEGY_PROFILES_V1)[number];

export interface ContextStrategyAttemptV1 {
  caseId: string;
  attempt: number;
  profile: ContextStrategyProfileV1;
  terminal: 'completed' | 'failed' | 'timed_out' | 'overflow';
  taskSucceeded: boolean;
  invariantFailureCount: number;
  unauthorizedSideEffectCount: number;
  totalBilledTokens: number | null;
  endToEndMs: number | null;
  selectedTierCounts: {
    micro: number;
    workingSet: number;
    offload: number;
    summary: number;
  };
}

export interface ContextStrategyEvaluationInputV1 {
  suiteDigest: string;
  routeDigest: string;
  configDigest: string;
  fixtureDigest: string;
  attempts: readonly ContextStrategyAttemptV1[];
}

export interface ContextStrategyEvaluationOutcomeV1 {
  status: 'passed' | 'failed' | 'inconclusive';
  reasons: readonly string[];
  successDeltaLowerBound: Readonly<Partial<Record<'local_projection' | 'progressive', number>>>;
  progressiveMedianTokenReduction: number | null;
  progressiveForcedStopReduction: number | null;
  progressiveP95LatencyIncrease: number | null;
  notExercised: readonly ('micro' | 'workingSet' | 'offload' | 'summary')[];
}

const REQUIRED_PROFILES = new Set<string>(CONTEXT_STRATEGY_PROFILES_V1);
const MAX_BOOTSTRAP_SAMPLES = 10_000;

function digest(value: unknown): string {
  return createHash('sha256')
    .update('progressive-context-strategy-evaluation:v1\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

/** Deterministic PRNG: the evaluator report must be replayable without an external statistics tool. */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function lowerBootstrapBound(deltas: readonly number[], seed: string): number | null {
  if (deltas.length === 0) return null;
  const samples: number[] = [];
  const random = seededRandom(seed);
  for (let sample = 0; sample < MAX_BOOTSTRAP_SAMPLES; sample++) {
    let total = 0;
    for (let index = 0; index < deltas.length; index++) {
      total += deltas[Math.floor(random() * deltas.length)]!;
    }
    samples.push(total / deltas.length);
  }
  return percentile(samples, 0.025);
}

function pairedAttempts(
  attempts: readonly ContextStrategyAttemptV1[],
): Map<string, Map<ContextStrategyProfileV1, ContextStrategyAttemptV1>> {
  const pairs = new Map<string, Map<ContextStrategyProfileV1, ContextStrategyAttemptV1>>();
  for (const item of attempts) {
    const key = `${item.caseId}\0${item.attempt}`;
    const pair = pairs.get(key) ?? new Map<ContextStrategyProfileV1, ContextStrategyAttemptV1>();
    if (pair.has(item.profile))
      throw new Error(`Duplicate strategy attempt '${key}/${item.profile}'.`);
    pair.set(item.profile, item);
    pairs.set(key, pair);
  }
  return pairs;
}

function exactCoverage(
  pairs: ReadonlyMap<string, ReadonlyMap<ContextStrategyProfileV1, ContextStrategyAttemptV1>>,
): boolean {
  return (
    pairs.size > 0 &&
    [...pairs.values()].every(
      (pair) =>
        pair.size === REQUIRED_PROFILES.size &&
        CONTEXT_STRATEGY_PROFILES_V1.every((profile) => pair.has(profile)),
    )
  );
}

function numericMetric(
  pairs: ReadonlyMap<string, ReadonlyMap<ContextStrategyProfileV1, ContextStrategyAttemptV1>>,
  profile: ContextStrategyProfileV1,
  metric: 'totalBilledTokens' | 'endToEndMs',
): number[] | null {
  const values = [...pairs.values()].map((pair) => pair.get(profile)?.[metric]);
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? (values as number[])
    : null;
}

/**
 * Evaluates only aggregate/digest-safe attempt facts. It deliberately cannot
 * consume prompts, model output, tool result bodies, credentials, or paths.
 */
export function evaluateProgressiveContextStrategyV1(
  input: ContextStrategyEvaluationInputV1,
): ContextStrategyEvaluationOutcomeV1 {
  const pairs = pairedAttempts(input.attempts);
  const reasons: string[] = [];
  if (!exactCoverage(pairs)) reasons.push('incomplete_paired_coverage');
  if (
    input.attempts.some(
      (item) =>
        !REQUIRED_PROFILES.has(item.profile) ||
        !Number.isSafeInteger(item.attempt) ||
        item.attempt < 1 ||
        item.invariantFailureCount < 0 ||
        item.unauthorizedSideEffectCount < 0,
    )
  )
    reasons.push('invalid_attempt');
  if (input.attempts.some((item) => item.invariantFailureCount > 0))
    reasons.push('invariant_failure');
  if (input.attempts.some((item) => item.unauthorizedSideEffectCount > 0))
    reasons.push('unauthorized_side_effect');

  const lowerBounds: Partial<Record<'local_projection' | 'progressive', number>> = {};
  for (const profile of ['local_projection', 'progressive'] as const) {
    const deltas = [...pairs.values()].map((pair) => {
      const treatment = pair.get(profile);
      const baseline = pair.get('rolling_summary');
      return treatment && baseline
        ? Number(treatment.taskSucceeded) - Number(baseline.taskSucceeded)
        : NaN;
    });
    if (deltas.some((delta) => !Number.isFinite(delta))) {
      reasons.push(`${profile}_success_delta_unavailable`);
      continue;
    }
    const lowerBound = lowerBootstrapBound(deltas, `${input.suiteDigest}:${profile}:success`);
    if (lowerBound == null) reasons.push(`${profile}_success_delta_unavailable`);
    else {
      lowerBounds[profile] = lowerBound;
      if (lowerBound < -0.05) reasons.push(`${profile}_success_noninferior_failed`);
    }
  }

  const rollingTokens = numericMetric(pairs, 'rolling_summary', 'totalBilledTokens');
  const progressiveTokens = numericMetric(pairs, 'progressive', 'totalBilledTokens');
  const rollingLatency = numericMetric(pairs, 'rolling_summary', 'endToEndMs');
  const progressiveLatency = numericMetric(pairs, 'progressive', 'endToEndMs');
  const progressiveMedianTokenReduction =
    rollingTokens && progressiveTokens && median(rollingTokens)! > 0
      ? 1 - median(progressiveTokens)! / median(rollingTokens)!
      : null;
  const rollingForcedStops = [...pairs.values()].filter((pair) => {
    const terminal = pair.get('rolling_summary')?.terminal;
    return terminal === 'overflow' || terminal === 'timed_out';
  }).length;
  const progressiveForcedStops = [...pairs.values()].filter((pair) => {
    const terminal = pair.get('progressive')?.terminal;
    return terminal === 'overflow' || terminal === 'timed_out';
  }).length;
  const progressiveForcedStopReduction =
    rollingForcedStops > 0 ? 1 - progressiveForcedStops / rollingForcedStops : null;
  const progressiveP95LatencyIncrease =
    rollingLatency && progressiveLatency && percentile(rollingLatency, 0.95)! > 0
      ? percentile(progressiveLatency, 0.95)! / percentile(rollingLatency, 0.95)! - 1
      : null;
  if (progressiveMedianTokenReduction == null || progressiveP95LatencyIncrease == null)
    reasons.push('progressive_cost_or_latency_unavailable');
  else {
    if (
      progressiveMedianTokenReduction < 0.15 &&
      (progressiveForcedStopReduction == null || progressiveForcedStopReduction < 0.25)
    )
      reasons.push('progressive_benefit_not_met');
    if (progressiveP95LatencyIncrease > 0.15) reasons.push('progressive_latency_regression');
  }

  const tierTotals = input.attempts.reduce(
    (total, item) => ({
      micro: total.micro + item.selectedTierCounts.micro,
      workingSet: total.workingSet + item.selectedTierCounts.workingSet,
      offload: total.offload + item.selectedTierCounts.offload,
      summary: total.summary + item.selectedTierCounts.summary,
    }),
    { micro: 0, workingSet: 0, offload: 0, summary: 0 },
  );
  const notExercised = (
    Object.entries(tierTotals) as Array<['micro' | 'workingSet' | 'offload' | 'summary', number]>
  )
    .filter(([, count]) => count === 0)
    .map(([tier]) => tier);

  const failed = reasons.some((reason) =>
    [
      'invariant_failure',
      'unauthorized_side_effect',
      'success_noninferior_failed',
      'benefit_not_met',
      'latency_regression',
    ].some((suffix) => reason.endsWith(suffix)),
  );
  const inconclusive = reasons.some(
    (reason) =>
      reason === 'incomplete_paired_coverage' ||
      reason === 'invalid_attempt' ||
      reason.endsWith('_unavailable'),
  );
  return {
    status: failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed',
    reasons,
    successDeltaLowerBound: lowerBounds,
    progressiveMedianTokenReduction,
    progressiveForcedStopReduction,
    progressiveP95LatencyIncrease,
    notExercised,
  };
}

export function progressiveContextStrategyEvaluationDigestV1(
  input: ContextStrategyEvaluationInputV1,
): string {
  return digest(input);
}
