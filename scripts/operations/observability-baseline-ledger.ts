import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const controlledAliasSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
const MAX_RETAINED_SAMPLES = 10_000;

export const OBSERVABILITY_BASELINE_METRICS_V1 = Object.freeze([
  'task_checks_passed',
  'human_accepted',
  'recovery_success',
  'unrelated_diff',
  'false_completion',
  'integrated',
  'reverted',
] as const);

export type ObservabilityBaselineMetricV1 = (typeof OBSERVABILITY_BASELINE_METRICS_V1)[number];

export const observabilityBaselinePolicyIdentityV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselinePolicyIdentityV1'),
    policyId: controlledAliasSchema,
    revision: z.number().int().positive(),
    policyDigest: digestSchema,
    owner: z.literal('github:@ferqx'),
    minimumSamples: z.number().int().positive(),
    minimumObservationWindowSeconds: z.number().int().positive(),
    approvedAt: timestampSchema,
  })
  .strict();

export const observabilityBaselineRouteIdentityV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselineRouteIdentityV1'),
    routeAlias: controlledAliasSchema,
    routeDigest: digestSchema,
    providerRouteDigest: digestSchema,
  })
  .strict();

export const observabilityBaselineGithubSourceV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselineGithubSourceV1'),
    repository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('R_kgDOSKbi8g'),
    headSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    workflowRef: z.string().includes('/.github/workflows/'),
    workflowSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1),
    jobId: z.string().regex(/^[1-9][0-9]*$/),
    retainedArtifactName: z.string().min(1),
    retainedArtifactId: z.string().regex(/^[1-9][0-9]*$/),
    retainedArtifactDigest: digestSchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    producerIdentity: z.string().min(1),
    attestationDigest: digestSchema,
    attestationSubjectDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workflowRef !== `${value.repository}/${value.workflowPath}@${value.ref}`) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'Workflow ref must bind the canonical repository, workflow path, and ref.',
      });
    }
  });

export const observabilityBaselineG0V1Schema = z
  .object({
    unauthorized_side_effects: z.number().int().nonnegative(),
    secret_or_content_egress: z.number().int().nonnegative(),
    sandbox_or_workspace_escape: z.number().int().nonnegative(),
    runtime_state_corruption: z.number().int().nonnegative(),
    required_verification_bypass: z.number().int().nonnegative(),
  })
  .strict();

const baselineSampleMaterialSchema = z
  .object({
    schema: z.literal('ObservabilityBaselineSampleReceiptV1'),
    sequence: z.number().int().positive().max(MAX_RETAINED_SAMPLES),
    sampleId: z.string().regex(/^baseline_sample_[a-f0-9]{32}$/),
    previousReceiptDigest: digestSchema.nullable(),
    observedAt: timestampSchema,
    outcomeReceiptDigest: digestSchema,
    taskChecksPassed: z.boolean().nullable(),
    humanAccepted: z.boolean().nullable(),
    recoveryRequired: z.boolean(),
    recoverySucceeded: z.boolean().nullable(),
    unrelatedDiff: z.boolean().nullable(),
    falseCompletion: z.boolean().nullable(),
    integrated: z.boolean().nullable(),
    reverted: z.boolean().nullable(),
    g0: observabilityBaselineG0V1Schema,
    g1Failures: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.recoveryRequired && value.recoverySucceeded !== null) {
      context.addIssue({
        code: 'custom',
        path: ['recoverySucceeded'],
        message: 'Recovery outcome must be unknown when recovery was not required.',
      });
    }
    if (value.recoveryRequired && value.recoverySucceeded === null) {
      context.addIssue({
        code: 'custom',
        path: ['recoverySucceeded'],
        message: 'Required recovery must retain an observed outcome.',
      });
    }
    if (value.reverted === true && value.integrated !== true) {
      context.addIssue({
        code: 'custom',
        path: ['reverted'],
        message: 'A non-integrated sample cannot be reverted.',
      });
    }
  });

export const observabilityBaselineSampleReceiptV1Schema = baselineSampleMaterialSchema.safeExtend({
  receiptDigest: digestSchema,
});

const baselineLedgerMaterialSchema = z
  .object({
    schema: z.literal('ObservabilityBaselineLedgerV1'),
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeIdentity: observabilityBaselineRouteIdentityV1Schema,
    policyIdentity: observabilityBaselinePolicyIdentityV1Schema,
    source: observabilityBaselineGithubSourceV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    declaredSampleCount: z.number().int().nonnegative().max(MAX_RETAINED_SAMPLES),
    droppedSampleCount: z.literal(0),
    samples: z.array(observabilityBaselineSampleReceiptV1Schema).max(MAX_RETAINED_SAMPLES),
  })
  .strict();

export const observabilityBaselineLedgerV1Schema = baselineLedgerMaterialSchema.extend({
  ledgerDigest: digestSchema,
});

export const observabilityBaselineExpectationV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselineExpectationV1'),
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeIdentity: observabilityBaselineRouteIdentityV1Schema,
    policyIdentity: observabilityBaselinePolicyIdentityV1Schema,
    source: observabilityBaselineGithubSourceV1Schema,
  })
  .strict();

export type ObservabilityBaselinePolicyIdentityV1 = z.infer<
  typeof observabilityBaselinePolicyIdentityV1Schema
>;
export type ObservabilityBaselineRouteIdentityV1 = z.infer<
  typeof observabilityBaselineRouteIdentityV1Schema
>;
export type ObservabilityBaselineGithubSourceV1 = z.infer<
  typeof observabilityBaselineGithubSourceV1Schema
>;
export type ObservabilityBaselineSampleMaterialV1 = z.infer<typeof baselineSampleMaterialSchema>;
export type ObservabilityBaselineSampleReceiptV1 = z.infer<
  typeof observabilityBaselineSampleReceiptV1Schema
>;
export type ObservabilityBaselineLedgerMaterialV1 = z.infer<typeof baselineLedgerMaterialSchema>;
export type ObservabilityBaselineLedgerV1 = z.infer<typeof observabilityBaselineLedgerV1Schema>;
export type ObservabilityBaselineExpectationV1 = z.infer<
  typeof observabilityBaselineExpectationV1Schema
>;

export interface ObservabilityBaselineRateV1 {
  observedCount: number;
  positiveCount: number;
  rate: number | null;
}

export interface ObservabilityBaselineRebuildV1 {
  schema: 'ObservabilityBaselineRebuildV1';
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  sampleCount: number;
  noData: boolean;
  droppedSampleCount: 0;
  unknownMetrics: ObservabilityBaselineMetricV1[];
  metrics: Record<ObservabilityBaselineMetricV1, ObservabilityBaselineRateV1>;
  g0: z.infer<typeof observabilityBaselineG0V1Schema>;
  g1Failures: number;
  ledgerDigest: `sha256:${string}`;
  rebuildDigest: `sha256:${string}`;
}

export function computeObservabilityBaselineSampleDigestV1(
  input: ObservabilityBaselineSampleMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.operations.observability-baseline-sample.v1',
    canonicalJson(baselineSampleMaterialSchema.parse(input)),
  );
}

export function buildObservabilityBaselineSampleReceiptV1(
  input: ObservabilityBaselineSampleMaterialV1,
): ObservabilityBaselineSampleReceiptV1 {
  const material = baselineSampleMaterialSchema.parse(input);
  return observabilityBaselineSampleReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeObservabilityBaselineSampleDigestV1(material),
  });
}

export function computeObservabilityBaselineLedgerDigestV1(
  input: ObservabilityBaselineLedgerMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.operations.observability-baseline-ledger.v1',
    canonicalJson(baselineLedgerMaterialSchema.parse(input)),
  );
}

export function buildObservabilityBaselineLedgerV1(
  input: ObservabilityBaselineLedgerMaterialV1,
): ObservabilityBaselineLedgerV1 {
  const material = baselineLedgerMaterialSchema.parse(input);
  const ledger = observabilityBaselineLedgerV1Schema.parse({
    ...material,
    ledgerDigest: computeObservabilityBaselineLedgerDigestV1(material),
  });
  return verifyObservabilityBaselineLedgerV1(ledger);
}

export function verifyObservabilityBaselineLedgerV1(raw: unknown): ObservabilityBaselineLedgerV1 {
  const ledger = observabilityBaselineLedgerV1Schema.parse(raw);
  const startedAt = Date.parse(ledger.startedAt);
  const endedAt = Date.parse(ledger.endedAt);
  if (endedAt < startedAt) throw new Error('Observability baseline window is invalid.');
  if (Date.parse(ledger.policyIdentity.approvedAt) > startedAt) {
    throw new Error('Observability baseline policy was not approved before collection started.');
  }
  if (ledger.declaredSampleCount !== ledger.samples.length) {
    throw new Error(
      'Observability baseline declared sample count does not match retained receipts.',
    );
  }
  assertSourceArtifactBinding(ledger);

  const sampleIds = new Set<string>();
  let previousDigest: string | null = null;
  let previousObservedAt = Number.NEGATIVE_INFINITY;
  for (const [index, sample] of ledger.samples.entries()) {
    if (sample.sequence !== index + 1) {
      throw new Error('Observability baseline sample sequence is not contiguous.');
    }
    if (sample.previousReceiptDigest !== previousDigest) {
      throw new Error('Observability baseline sample digest chain is broken.');
    }
    if (sampleIds.has(sample.sampleId)) {
      throw new Error('Observability baseline contains a duplicate sample identity.');
    }
    sampleIds.add(sample.sampleId);
    const { receiptDigest, ...material } = sample;
    if (receiptDigest !== computeObservabilityBaselineSampleDigestV1(material)) {
      throw new Error('Observability baseline sample digest mismatch.');
    }
    const observedAt = Date.parse(sample.observedAt);
    if (observedAt < startedAt || observedAt > endedAt) {
      throw new Error('Observability baseline sample falls outside the observation window.');
    }
    if (observedAt < previousObservedAt) {
      throw new Error('Observability baseline sample timestamps are not non-decreasing.');
    }
    previousObservedAt = observedAt;
    previousDigest = receiptDigest;
  }

  const { ledgerDigest, ...material } = ledger;
  if (ledgerDigest !== computeObservabilityBaselineLedgerDigestV1(material)) {
    throw new Error('Observability baseline ledger digest mismatch.');
  }
  return ledger;
}

export function rebuildObservabilityBaselineV1(raw: unknown): ObservabilityBaselineRebuildV1 {
  const ledger = verifyObservabilityBaselineLedgerV1(raw);
  const metrics = {
    task_checks_passed: aggregate(ledger.samples.map((sample) => sample.taskChecksPassed)),
    human_accepted: aggregate(ledger.samples.map((sample) => sample.humanAccepted)),
    recovery_success: aggregate(
      ledger.samples
        .filter((sample) => sample.recoveryRequired)
        .map((sample) => sample.recoverySucceeded),
    ),
    unrelated_diff: aggregate(ledger.samples.map((sample) => sample.unrelatedDiff)),
    false_completion: aggregate(ledger.samples.map((sample) => sample.falseCompletion)),
    integrated: aggregate(ledger.samples.map((sample) => sample.integrated)),
    reverted: aggregate(ledger.samples.map((sample) => sample.reverted)),
  } satisfies Record<ObservabilityBaselineMetricV1, ObservabilityBaselineRateV1>;
  const g0 = {
    unauthorized_side_effects: 0,
    secret_or_content_egress: 0,
    sandbox_or_workspace_escape: 0,
    runtime_state_corruption: 0,
    required_verification_bypass: 0,
  };
  let g1Failures = 0;
  for (const sample of ledger.samples) {
    for (const key of Object.keys(g0) as Array<keyof typeof g0>) g0[key] += sample.g0[key];
    g1Failures += sample.g1Failures;
  }
  const withoutDigest = {
    schema: 'ObservabilityBaselineRebuildV1' as const,
    startedAt: ledger.startedAt,
    endedAt: ledger.endedAt,
    durationSeconds: Math.floor((Date.parse(ledger.endedAt) - Date.parse(ledger.startedAt)) / 1000),
    sampleCount: ledger.samples.length,
    noData: ledger.samples.length === 0,
    droppedSampleCount: ledger.droppedSampleCount,
    unknownMetrics: OBSERVABILITY_BASELINE_METRICS_V1.filter(
      (metric) => metrics[metric].rate === null,
    ),
    metrics,
    g0,
    g1Failures,
    ledgerDigest: ledger.ledgerDigest as `sha256:${string}`,
  };
  return {
    ...withoutDigest,
    rebuildDigest: sha256DomainSeparated(
      'kite.operations.observability-baseline-rebuild.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

function aggregate(values: Array<boolean | null>): ObservabilityBaselineRateV1 {
  const observed = values.filter((value): value is boolean => value !== null);
  const positiveCount = observed.filter(Boolean).length;
  return {
    observedCount: observed.length,
    positiveCount,
    rate: observed.length === 0 ? null : positiveCount / observed.length,
  };
}

function assertSourceArtifactBinding(ledger: ObservabilityBaselineLedgerV1): void {
  const { artifactIdentity, source } = ledger;
  if (
    source.repository !== artifactIdentity.canonicalRepository ||
    source.repositoryId !== artifactIdentity.repositoryId ||
    source.headSha !== artifactIdentity.commit ||
    source.workflowSha !== artifactIdentity.commit ||
    source.attestationSubjectDigest !== artifactIdentity.payloadSha256
  ) {
    throw new Error('Observability baseline source does not bind the exact release artifact.');
  }
}
