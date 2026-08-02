import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

export type ObservedBoolean = boolean | 'not_observed';

export interface AgentTaskAttemptV1 {
  version: 1;
  attemptIndex: number;
  attemptId: string;
  caseId: string;
  startedAt: string;
  finishedAt: string;
  attempted: boolean;
  producedChange: boolean;
  checksPassed: boolean;
  humanAccepted: ObservedBoolean;
  integrated: ObservedBoolean;
  reverted: ObservedBoolean;
  failureKinds: string[];
  oracleDigest: `sha256:${string}` | null;
  metrics: {
    latencyMs: number | null;
    modelCalls: number | null;
    toolCalls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    approvalCount: number | null;
    userCorrections: number | null;
  };
}

export interface SyntheticRepeatedRunConfigV1 {
  version: 1;
  executionClass: 'synthetic_fixture';
  caseId: string;
  suiteDigest: `sha256:${string}`;
  routeIdentity: string;
  configDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  contractDigest: `sha256:${string}`;
  schemaDigest: `sha256:${string}`;
  repetitionCount: number;
  evaluatorSeed: number;
  decision: {
    id: 'D-07';
    status: 'unconfigured';
    approvedAt: null;
  };
}

export interface AgentTaskRepeatedReportV1 {
  version: 1;
  reportSchema: 'agent-task-repeated-report-v1';
  executionClass: 'synthetic_fixture';
  caseId: string;
  suiteDigest: `sha256:${string}`;
  routeIdentity: string;
  configDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  contractDigest: `sha256:${string}`;
  schemaDigest: `sha256:${string}`;
  evaluatorSeed: number;
  providerRandomnessControlled: false;
  evidenceEligible: false;
  gateStatus: 'blocked_unconfigured';
  attempts: AgentTaskAttemptV1[];
  counts: {
    scheduled: number;
    attempted: number;
    producedChange: number;
    checksPassed: number;
    humanAccepted: StageCountV1;
    integrated: StageCountV1;
    reverted: StageCountV1;
  };
  checkSuccessRate: number;
  checkSuccessWilson95: { lower: number; upper: number };
  latencyMs: DistributionV1;
  usage: {
    modelCalls: DistributionV1;
    toolCalls: DistributionV1;
    inputTokens: DistributionV1;
    outputTokens: DistributionV1;
    approvalCount: DistributionV1;
    userCorrections: DistributionV1;
  };
  failureTaxonomy: Array<{ kind: string; count: number }>;
  digest: `sha256:${string}`;
}

interface StageCountV1 {
  true: number;
  false: number;
  notObserved: number;
}

interface DistributionV1 {
  total: number | null;
  observed: number;
  notObserved: number;
  p50: number | null;
  p95: number | null;
}

export interface AttemptContextV1 {
  version: 1;
  attemptIndex: number;
  attemptId: string;
  evaluatorSeed: number;
  providerRandomnessControlled: false;
}

export type AttemptExecutor = (
  context: AttemptContextV1,
) => Promise<Omit<AgentTaskAttemptV1, 'attemptId' | 'attemptIndex' | 'caseId' | 'version'>>;

/** Append-only in-memory ledger; snapshots clone every attempt and expose no replacement API. */
export class RepeatedRunLedgerV1 {
  readonly caseId: string;
  readonly expectedAttempts: number;
  readonly #attempts: AgentTaskAttemptV1[] = [];

  constructor(caseId: string, expectedAttempts: number) {
    this.caseId = caseId;
    this.expectedAttempts = expectedAttempts;
    if (!caseId || !Number.isSafeInteger(expectedAttempts) || expectedAttempts < 1) {
      throw new Error('Repeated-run ledger identity is invalid.');
    }
  }

  append(attempt: AgentTaskAttemptV1): void {
    validateAttempt(attempt, this.caseId, this.#attempts.length);
    if (this.#attempts.length >= this.expectedAttempts) {
      throw new Error('Repeated-run ledger is already complete.');
    }
    this.#attempts.push(structuredClone(attempt));
  }

  snapshot(): AgentTaskAttemptV1[] {
    return structuredClone(this.#attempts);
  }
}

export async function runSyntheticRepeatedEvaluation(
  config: SyntheticRepeatedRunConfigV1,
  execute: AttemptExecutor,
): Promise<AgentTaskRepeatedReportV1> {
  validateConfig(config);
  const ledger = new RepeatedRunLedgerV1(config.caseId, config.repetitionCount);
  for (let attemptIndex = 0; attemptIndex < config.repetitionCount; attemptIndex += 1) {
    const attemptId = sha256Digest(
      canonicalJsonBytes({
        caseId: config.caseId,
        evaluatorSeed: config.evaluatorSeed,
        attemptIndex,
        suiteDigest: config.suiteDigest,
      }),
    ).slice('sha256:'.length, 'sha256:'.length + 24);
    let body: Omit<AgentTaskAttemptV1, 'attemptId' | 'attemptIndex' | 'caseId' | 'version'>;
    const invokedAt = new Date().toISOString();
    try {
      body = await execute({
        version: 1,
        attemptIndex,
        attemptId,
        evaluatorSeed: config.evaluatorSeed,
        providerRandomnessControlled: false,
      });
    } catch {
      body = {
        startedAt: invokedAt,
        finishedAt: new Date().toISOString(),
        attempted: true,
        producedChange: false,
        checksPassed: false,
        humanAccepted: 'not_observed',
        integrated: 'not_observed',
        reverted: 'not_observed',
        failureKinds: ['runner_error'],
        oracleDigest: null,
        metrics: {
          latencyMs: null,
          modelCalls: null,
          toolCalls: null,
          inputTokens: null,
          outputTokens: null,
          approvalCount: null,
          userCorrections: null,
        },
      };
    }
    ledger.append({
      version: 1,
      attemptIndex,
      attemptId,
      caseId: config.caseId,
      ...body,
    });
  }
  return buildRepeatedRunReport(config, ledger.snapshot());
}

export function buildRepeatedRunReport(
  config: SyntheticRepeatedRunConfigV1,
  attempts: AgentTaskAttemptV1[],
): AgentTaskRepeatedReportV1 {
  validateConfig(config);
  if (attempts.length !== config.repetitionCount) {
    throw new Error(
      'Repeated report requires every scheduled attempt; partial/best-only input refused.',
    );
  }
  attempts.forEach((attempt, index) => {
    validateAttempt(attempt, config.caseId, index);
  });
  const retainedAttempts = structuredClone(attempts);
  const metric = (key: keyof AgentTaskAttemptV1['metrics']): Array<number | null> =>
    retainedAttempts.map((attempt) => attempt.metrics[key]);
  const checkPasses = retainedAttempts.filter((attempt) => attempt.checksPassed).length;
  const failures = new Map<string, number>();
  for (const attempt of retainedAttempts) {
    for (const kind of attempt.failureKinds) failures.set(kind, (failures.get(kind) ?? 0) + 1);
  }
  const withoutDigest = {
    version: 1 as const,
    reportSchema: 'agent-task-repeated-report-v1' as const,
    executionClass: 'synthetic_fixture' as const,
    caseId: config.caseId,
    suiteDigest: config.suiteDigest,
    routeIdentity: config.routeIdentity,
    configDigest: config.configDigest,
    artifactDigest: config.artifactDigest,
    contractDigest: config.contractDigest,
    schemaDigest: config.schemaDigest,
    evaluatorSeed: config.evaluatorSeed,
    providerRandomnessControlled: false as const,
    evidenceEligible: false as const,
    gateStatus: 'blocked_unconfigured' as const,
    attempts: retainedAttempts,
    counts: {
      scheduled: config.repetitionCount,
      attempted: retainedAttempts.filter((attempt) => attempt.attempted).length,
      producedChange: retainedAttempts.filter((attempt) => attempt.producedChange).length,
      checksPassed: checkPasses,
      humanAccepted: stageCount(retainedAttempts.map((attempt) => attempt.humanAccepted)),
      integrated: stageCount(retainedAttempts.map((attempt) => attempt.integrated)),
      reverted: stageCount(retainedAttempts.map((attempt) => attempt.reverted)),
    },
    checkSuccessRate: checkPasses / config.repetitionCount,
    checkSuccessWilson95: wilson95(checkPasses, config.repetitionCount),
    latencyMs: distribution(metric('latencyMs')),
    usage: {
      modelCalls: distribution(metric('modelCalls')),
      toolCalls: distribution(metric('toolCalls')),
      inputTokens: distribution(metric('inputTokens')),
      outputTokens: distribution(metric('outputTokens')),
      approvalCount: distribution(metric('approvalCount')),
      userCorrections: distribution(metric('userCorrections')),
    },
    failureTaxonomy: [...failures.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => ({ kind, count })),
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

/** Rebuilds every aggregate from retained attempts; any drift or unknown field fails closed. */
export function verifySyntheticRepeatedRunReport(
  report: AgentTaskRepeatedReportV1,
  config: SyntheticRepeatedRunConfigV1,
): void {
  const rebuilt = buildRepeatedRunReport(config, report.attempts);
  if (sha256Digest(canonicalJsonBytes(report)) !== sha256Digest(canonicalJsonBytes(rebuilt))) {
    throw new Error('Repeated report does not rebuild exactly from all retained attempts.');
  }
}

function validateConfig(config: SyntheticRepeatedRunConfigV1): void {
  assertExactKeys(config, [
    'artifactDigest',
    'caseId',
    'configDigest',
    'contractDigest',
    'decision',
    'evaluatorSeed',
    'executionClass',
    'repetitionCount',
    'routeIdentity',
    'schemaDigest',
    'suiteDigest',
    'version',
  ]);
  assertExactKeys(config.decision, ['approvedAt', 'id', 'status']);
  if (
    config.version !== 1 ||
    config.executionClass !== 'synthetic_fixture' ||
    !stableIdentifier(config.caseId) ||
    !stableIdentifier(config.routeIdentity) ||
    !Number.isSafeInteger(config.repetitionCount) ||
    config.repetitionCount < 1 ||
    config.repetitionCount > 1_000 ||
    !Number.isSafeInteger(config.evaluatorSeed) ||
    config.evaluatorSeed < 0 ||
    config.evaluatorSeed > 0xffff_ffff ||
    config.decision.id !== 'D-07' ||
    config.decision.status !== 'unconfigured' ||
    config.decision.approvedAt !== null
  ) {
    throw new Error('Synthetic repeated-run config is invalid or claims an approved decision.');
  }
  for (const digest of [
    config.suiteDigest,
    config.configDigest,
    config.artifactDigest,
    config.contractDigest,
    config.schemaDigest,
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
      throw new Error('Repeated-run identity digest is invalid.');
  }
}

function validateAttempt(attempt: AgentTaskAttemptV1, caseId: string, expectedIndex: number): void {
  assertExactKeys(attempt, [
    'attemptId',
    'attemptIndex',
    'attempted',
    'caseId',
    'checksPassed',
    'failureKinds',
    'finishedAt',
    'humanAccepted',
    'integrated',
    'metrics',
    'oracleDigest',
    'producedChange',
    'reverted',
    'startedAt',
    'version',
  ]);
  assertExactKeys(attempt.metrics, [
    'approvalCount',
    'inputTokens',
    'latencyMs',
    'modelCalls',
    'outputTokens',
    'toolCalls',
    'userCorrections',
  ]);
  const metrics = Object.values(attempt.metrics);
  if (
    attempt.version !== 1 ||
    attempt.caseId !== caseId ||
    attempt.attemptIndex !== expectedIndex ||
    !stableIdentifier(attempt.attemptId) ||
    !canonicalTimestamp(attempt.startedAt) ||
    !canonicalTimestamp(attempt.finishedAt) ||
    Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt) ||
    metrics.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
    !validObserved(attempt.humanAccepted) ||
    !validObserved(attempt.integrated) ||
    !validObserved(attempt.reverted)
  ) {
    throw new Error(`Repeated-run attempt ${expectedIndex} is invalid.`);
  }
  const sortedFailures = [...attempt.failureKinds].sort();
  if (
    attempt.failureKinds.some(
      (kind, index) =>
        !/^[a-z][a-z0-9_]{0,127}$/.test(kind) ||
        kind !== sortedFailures[index] ||
        kind === attempt.failureKinds[index - 1],
    )
  ) {
    throw new Error(`Repeated-run attempt ${expectedIndex} failure taxonomy is invalid.`);
  }
  if (!attempt.attempted && (attempt.producedChange || attempt.checksPassed)) {
    throw new Error('An unattempted run cannot produce a change or passing checks.');
  }
  if (attempt.humanAccepted === true && !attempt.checksPassed) {
    throw new Error('Human acceptance cannot precede passing deterministic checks.');
  }
  if (attempt.integrated === true && attempt.humanAccepted !== true) {
    throw new Error('Integration cannot precede observed human acceptance.');
  }
  if (attempt.reverted === true && attempt.integrated !== true) {
    throw new Error('A revert cannot precede observed integration.');
  }
  if (
    attempt.failureKinds.length === 0 &&
    (!attempt.attempted ||
      !attempt.checksPassed ||
      attempt.humanAccepted === false ||
      attempt.integrated === false ||
      attempt.reverted === true)
  ) {
    throw new Error('Non-success attempts require a failure taxonomy entry.');
  }
  if (attempt.checksPassed && attempt.oracleDigest === null) {
    throw new Error('Passing checks require a deterministic oracle digest.');
  }
  if (attempt.oracleDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(attempt.oracleDigest)) {
    throw new Error('Attempt oracle digest is invalid.');
  }
}

function stageCount(values: ObservedBoolean[]): StageCountV1 {
  return {
    true: values.filter((value) => value === true).length,
    false: values.filter((value) => value === false).length,
    notObserved: values.filter((value) => value === 'not_observed').length,
  };
}

function distribution(values: Array<number | null>): DistributionV1 {
  const observed = values.filter((value): value is number => value !== null);
  if (observed.length === 0) {
    return { total: null, observed: 0, notObserved: values.length, p50: null, p95: null };
  }
  const percentile = percentiles(observed);
  return {
    total: observed.reduce((sum, value) => sum + value, 0),
    observed: observed.length,
    notObserved: values.length - observed.length,
    ...percentile,
  };
}

function percentiles(values: number[]): { p50: number; p95: number } {
  if (values.length === 0) throw new Error('Cannot summarize an empty distribution.');
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95) };
}

function nearestRank(sorted: number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error('Percentile index is outside the distribution.');
  return value;
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function canonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validObserved(value: ObservedBoolean): boolean {
  return value === true || value === false || value === 'not_observed';
}

function stableIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,255}$/.test(value);
}

function assertExactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('Repeated-run schema has missing or unknown fields.');
  }
}
