import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'live auto-compaction metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * AQ-9B has two fixed source-owned live cases.  Failure injection belongs to
 * AQ-9A, so a provider/network failure never becomes an AQ-9B observation.
 */
export const LIVE_AUTO_COMPACTION_CASE_IDS_V1 = [
  'l3-auto-compaction-cancelled-v1',
  'l3-auto-compaction-success-v1',
] as const;
export type LiveAutoCompactionCaseIdV1 = (typeof LIVE_AUTO_COMPACTION_CASE_IDS_V1)[number];

export const LIVE_AUTO_COMPACTION_OUTCOMES_V1 = ['cancelled', 'success'] as const;
export type LiveAutoCompactionOutcomeV1 = (typeof LIVE_AUTO_COMPACTION_OUTCOMES_V1)[number];

/**
 * The receipt deliberately records only source-owned semantic labels.  It
 * never serializes a Runtime event object (whose details can contain content
 * or paths) and it cannot be extended with arbitrary text.
 */
export const LIVE_AUTO_COMPACTION_SEMANTIC_EVENTS_V1 = [
  'context_metrics_observed',
  'auto_compaction_requested',
  'summary_dispatch_started',
  'summary_dispatch_completed',
  'summary_dispatch_cancelled',
  'checkpoint_committed',
  'primary_dispatch_started',
  'primary_dispatch_completed',
  'auto_compaction_failed',
  'turn_stopped',
  'next_turn_retry_preflight',
] as const;
export type LiveAutoCompactionSemanticEventV1 =
  (typeof LIVE_AUTO_COMPACTION_SEMANTIC_EVENTS_V1)[number];

export const LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1 = [
  'context_metrics_observed',
  'auto_compaction_requested',
  'summary_dispatch_started',
  'summary_dispatch_completed',
  'checkpoint_committed',
  'primary_dispatch_started',
  'primary_dispatch_completed',
] as const satisfies readonly LiveAutoCompactionSemanticEventV1[];

export const LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1 = [
  'context_metrics_observed',
  'auto_compaction_requested',
  'summary_dispatch_started',
  'summary_dispatch_cancelled',
  'auto_compaction_failed',
  'turn_stopped',
  'next_turn_retry_preflight',
] as const satisfies readonly LiveAutoCompactionSemanticEventV1[];

/**
 * Fixed labels retain only the approved token ranges.  Exact prompt/response
 * sizes are intentionally absent from retained diagnostic metadata.
 */
export const LIVE_AUTO_COMPACTION_TOKEN_BUCKETS_V1 = [
  '0_600',
  '0_3229',
  '0_7800',
  '0_12229',
  '9000_10000',
  'not_dispatched',
  'not_observed',
] as const;
export type LiveAutoCompactionTokenBucketV1 =
  (typeof LIVE_AUTO_COMPACTION_TOKEN_BUCKETS_V1)[number];

/**
 * The governance ledger retains an exact wall-clock counter solely to enforce
 * quota.  AQ-9B evidence deliberately exposes only one fixed coarse bucket,
 * never a raw duration or timestamp-derived measurement.
 */
export const LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1 = [
  'duration_0_to_10_seconds',
  'duration_11_to_60_seconds',
  'duration_61_to_600_seconds',
] as const;
export type LiveAutoCompactionDurationBucketV1 =
  (typeof LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1)[number];

const durationBucketPolicyMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionDurationBucketPolicyV1'),
    version: z.literal(1),
    maxRunWallClockSeconds: z.literal(600),
    buckets: z.tuple([
      z.literal('duration_0_to_10_seconds'),
      z.literal('duration_11_to_60_seconds'),
      z.literal('duration_61_to_600_seconds'),
    ]),
  })
  .strict();

export type LiveAutoCompactionDurationBucketPolicyMaterialV1 = z.infer<
  typeof durationBucketPolicyMaterialV1Schema
>;

export const LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1: LiveAutoCompactionDurationBucketPolicyMaterialV1 =
  durationBucketPolicyMaterialV1Schema.parse({
    schema: 'LiveAutoCompactionDurationBucketPolicyV1',
    version: 1,
    maxRunWallClockSeconds: 600,
    buckets: LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1,
  });

export function computeLiveAutoCompactionDurationBucketPolicyDigestV1(
  policy: LiveAutoCompactionDurationBucketPolicyMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.duration-bucket-policy.v1',
    canonicalJsonBytes(durationBucketPolicyMaterialV1Schema.parse(policy)),
  );
}

export const LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_DIGEST_V1 =
  computeLiveAutoCompactionDurationBucketPolicyDigestV1(
    LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1,
  );

/**
 * This is an internal derivation from the quota ledger's raw counter.  Its
 * result is the only time-related value permitted in a receipt or report.
 */
export function liveAutoCompactionDurationBucketForRunWallClockSecondsV1(
  runWallClockSeconds: unknown,
): LiveAutoCompactionDurationBucketV1 | undefined {
  if (
    typeof runWallClockSeconds !== 'number' ||
    !Number.isSafeInteger(runWallClockSeconds) ||
    runWallClockSeconds < 0 ||
    runWallClockSeconds > LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1.maxRunWallClockSeconds
  ) {
    return undefined;
  }
  if (runWallClockSeconds <= 10) return 'duration_0_to_10_seconds';
  if (runWallClockSeconds <= 60) return 'duration_11_to_60_seconds';
  return 'duration_61_to_600_seconds';
}

/**
 * A real provider cancellation is observable only after the runner knows the
 * summary dispatch crossed its controlled model boundary.  Any ambiguity is
 * deliberately represented in the vocabulary but rejected from an observed
 * receipt: it must remain blocked/unknown and must never permit a tail call.
 */
export const LIVE_AUTO_COMPACTION_PHASE_STATES_V1 = [
  'not_started',
  'known_zero',
  'dispatched_known',
  'dispatched_unknown',
] as const;
export type LiveAutoCompactionPhaseStateV1 = (typeof LIVE_AUTO_COMPACTION_PHASE_STATES_V1)[number];

const semanticPhaseCapsV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionPhaseCapsV1'),
    version: z.literal(1),
    summaryProviderInputMax: z.literal(7_800),
    summaryOutputMax: z.literal(600),
    followUpProviderInputMax: z.literal(3_229),
    followUpOutputMax: z.literal(600),
    totalMax: z.literal(12_229),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.summaryProviderInputMax +
        value.summaryOutputMax +
        value.followUpProviderInputMax +
        value.followUpOutputMax !==
      value.totalMax
    ) {
      context.addIssue({
        code: 'custom',
        message: 'AQ-9B phase caps must exactly close the fixed per-run token ceiling',
      });
    }
  });
export type LiveAutoCompactionSemanticPhaseCapsV1 = z.infer<typeof semanticPhaseCapsV1Schema>;

export const LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_V1: LiveAutoCompactionSemanticPhaseCapsV1 =
  semanticPhaseCapsV1Schema.parse({
    schema: 'LiveAutoCompactionPhaseCapsV1',
    version: 1,
    summaryProviderInputMax: 7_800,
    summaryOutputMax: 600,
    followUpProviderInputMax: 3_229,
    followUpOutputMax: 600,
    totalMax: 12_229,
  });

export function computeLiveAutoCompactionPhaseCapsDigestV1(
  caps: LiveAutoCompactionSemanticPhaseCapsV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.phase-caps.v1',
    canonicalJsonBytes(semanticPhaseCapsV1Schema.parse(caps)),
  );
}

export const LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_DIGEST_V1 =
  computeLiveAutoCompactionPhaseCapsDigestV1(LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_V1);

const capabilityResolutionMaterialV1Schema = z
  .object({
    schema: z.literal('DiagnosticModelCapabilityResolutionV1'),
    version: z.literal(1),
    capabilityDeclarationDigest: digestSchema,
    /** AQ-9B must not infer a context window from a model name or route. */
    contextWindowTokens: z.literal('unknown'),
    contextWindowSource: z.literal('not_declared'),
    /** The 600-token value is the test-only request bound, not a provider fact. */
    maxOutputTokens: z.literal(600),
    maxOutputTokensSource: z.literal('compatibility_config'),
  })
  .strict();

export type DiagnosticModelCapabilityResolutionMaterialV1 = z.infer<
  typeof capabilityResolutionMaterialV1Schema
>;

export function computeDiagnosticModelCapabilityResolutionDigestV1(
  material: DiagnosticModelCapabilityResolutionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.capability-resolution.v1',
    canonicalJsonBytes(capabilityResolutionMaterialV1Schema.parse(material)),
  );
}

export const diagnosticModelCapabilityResolutionV1Schema = capabilityResolutionMaterialV1Schema
  .extend({ capabilityResolutionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { capabilityResolutionDigest, ...material } = value;
    const expected = computeDiagnosticModelCapabilityResolutionDigestV1(material);
    if (capabilityResolutionDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['capabilityResolutionDigest'],
        message: `diagnostic capability resolution digest mismatch: expected ${expected}`,
      });
    }
  });

export type DiagnosticModelCapabilityResolutionV1 = z.infer<
  typeof diagnosticModelCapabilityResolutionV1Schema
>;

export function buildDiagnosticModelCapabilityResolutionV1(
  material: DiagnosticModelCapabilityResolutionMaterialV1,
): DiagnosticModelCapabilityResolutionV1 {
  const parsed = capabilityResolutionMaterialV1Schema.parse(material);
  return diagnosticModelCapabilityResolutionV1Schema.parse({
    ...parsed,
    capabilityResolutionDigest: computeDiagnosticModelCapabilityResolutionDigestV1(parsed),
  });
}

const phaseObservationV1Schema = z
  .object({
    summaryPhaseState: z.enum(LIVE_AUTO_COMPACTION_PHASE_STATES_V1),
    primaryPhaseState: z.enum(LIVE_AUTO_COMPACTION_PHASE_STATES_V1),
    summaryDispatchCount: z.literal(1),
    primaryDispatchCount: z.union([z.literal(0), z.literal(1)]),
    summaryProviderInputBucket: z.literal('0_7800'),
    summaryOutputBucket: z.enum(['0_600', 'not_observed']),
    primaryProviderInputBucket: z.enum(['0_3229', 'not_dispatched']),
    primaryOutputBucket: z.enum(['0_600', 'not_dispatched']),
    invocationTokenBucket: z.literal('0_12229'),
  })
  .strict();

export type LiveAutoCompactionPhaseObservationV1 = z.infer<typeof phaseObservationV1Schema>;

const turnBindingV1Schema = z
  .object({
    requestTurnDigest: digestSchema,
    checkpointTurnDigest: digestSchema.optional(),
    primaryDispatchTurnDigest: digestSchema.optional(),
    failedTurnDigest: digestSchema.optional(),
    stoppedTurnDigest: digestSchema.optional(),
    nextTurnDigest: digestSchema.optional(),
  })
  .strict();
export type LiveAutoCompactionTurnBindingV1 = z.infer<typeof turnBindingV1Schema>;

const sourceBindingV1Schema = z
  .object({
    policyDigest: digestSchema,
    durationBucketPolicyDigest: digestSchema,
    phaseCapsDigest: digestSchema,
    syntheticProjectionDigest: digestSchema,
    routeIdentityDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    routeToolCatalogDigest: digestSchema,
    toolEnvironmentDigest: digestSchema,
    sourceOwnedIdentityDigest: digestSchema,
    candidateClosureDigest: digestSchema,
    matrixDigest: digestSchema,
    matrixSuiteDigest: digestSchema,
    suiteDigest: digestSchema,
    fixtureDigest: digestSchema,
    corpusDigest: digestSchema,
    oracleDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerSourceDigest: digestSchema,
    runnerDigest: digestSchema,
    transportBindingDigest: digestSchema,
    executionDigest: digestSchema,
    governanceProfileDigest: digestSchema,
    dayQuotaLedgerDigest: digestSchema,
    monthQuotaLedgerDigest: digestSchema,
    retentionWitnessDigest: digestSchema,
    observationRecordDigest: digestSchema,
    observationReportDigest: digestSchema,
  })
  .strict();
export type LiveAutoCompactionSourceBindingV1 = z.infer<typeof sourceBindingV1Schema>;

/**
 * Metadata-only companion receipt for the existing `LiveCompatibilityObservationV1`.
 * The outer record retains the reviewed candidate/execution identity; this
 * strict companion proves only the AQ-9B semantic branch and phase envelope.
 */
const liveAutoCompactionSemanticReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionSemanticReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    caseId: z.enum(LIVE_AUTO_COMPACTION_CASE_IDS_V1),
    outcome: z.enum(LIVE_AUTO_COMPACTION_OUTCOMES_V1),
    compactAfterEstimatedTokens: z.literal(8_192),
    fullProjectionTokenBucket: z.literal('9000_10000'),
    durationBucket: z.enum(LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1),
    durationBucketPolicyDigest: digestSchema,
    phaseCaps: semanticPhaseCapsV1Schema,
    phaseCapsDigest: digestSchema,
    capabilityResolution: diagnosticModelCapabilityResolutionV1Schema,
    semanticEvents: z.array(z.enum(LIVE_AUTO_COMPACTION_SEMANTIC_EVENTS_V1)),
    phases: phaseObservationV1Schema,
    turns: turnBindingV1Schema,
    sourceBinding: sourceBindingV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedReceiptId = `l3-live-auto-compaction-receipt:${value.caseId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'AQ-9B receipt ID must derive from its fixed source-owned case ID',
      });
    }
    const expectedPhaseDigest = computeLiveAutoCompactionPhaseCapsDigestV1(value.phaseCaps);
    if (value.phaseCapsDigest !== expectedPhaseDigest) {
      context.addIssue({
        code: 'custom',
        path: ['phaseCapsDigest'],
        message: `AQ-9B phase caps digest mismatch: expected ${expectedPhaseDigest}`,
      });
    }
    if (value.sourceBinding.phaseCapsDigest !== value.phaseCapsDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBinding', 'phaseCapsDigest'],
        message: 'AQ-9B source binding must retain the receipt phase-caps digest',
      });
    }
    if (value.sourceBinding.durationBucketPolicyDigest !== value.durationBucketPolicyDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBinding', 'durationBucketPolicyDigest'],
        message: 'AQ-9B source binding must retain the receipt duration-bucket policy digest',
      });
    }
    if (
      value.capabilityResolution.capabilityDeclarationDigest !==
      value.sourceBinding.capabilityDeclarationDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capabilityResolution', 'capabilityDeclarationDigest'],
        message: 'capability resolution must bind the same source-owned declaration digest',
      });
    }

    const success = value.outcome === 'success';
    const expectedCaseId = success
      ? 'l3-auto-compaction-success-v1'
      : 'l3-auto-compaction-cancelled-v1';
    const expectedEvents = success
      ? LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1
      : LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1;
    const sameEvents =
      value.semanticEvents.length === expectedEvents.length &&
      value.semanticEvents.every((event, index) => event === expectedEvents[index]);
    if (value.caseId !== expectedCaseId || !sameEvents) {
      context.addIssue({
        code: 'custom',
        path: ['semanticEvents'],
        message: 'AQ-9B case, outcome, and semantic event ordering must remain source-owned',
      });
    }

    if (success) {
      if (
        value.phases.summaryPhaseState !== 'dispatched_known' ||
        value.phases.primaryPhaseState !== 'dispatched_known' ||
        value.phases.primaryDispatchCount !== 1 ||
        value.phases.summaryOutputBucket !== '0_600' ||
        value.phases.primaryProviderInputBucket !== '0_3229' ||
        value.phases.primaryOutputBucket !== '0_600' ||
        value.turns.checkpointTurnDigest !== value.turns.requestTurnDigest ||
        value.turns.primaryDispatchTurnDigest !== value.turns.requestTurnDigest ||
        value.turns.failedTurnDigest !== undefined ||
        value.turns.stoppedTurnDigest !== undefined ||
        value.turns.nextTurnDigest !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'AQ-9B success must complete summary/checkpoint then dispatch the primary model on the same turn',
        });
      }
    } else if (
      value.phases.summaryPhaseState !== 'dispatched_known' ||
      value.phases.primaryPhaseState !== 'known_zero' ||
      value.phases.primaryDispatchCount !== 0 ||
      value.phases.summaryOutputBucket !== 'not_observed' ||
      value.phases.primaryProviderInputBucket !== 'not_dispatched' ||
      value.phases.primaryOutputBucket !== 'not_dispatched' ||
      value.turns.checkpointTurnDigest !== undefined ||
      value.turns.primaryDispatchTurnDigest !== undefined ||
      value.turns.failedTurnDigest !== value.turns.requestTurnDigest ||
      value.turns.stoppedTurnDigest !== value.turns.requestTurnDigest ||
      value.turns.nextTurnDigest === undefined ||
      value.turns.nextTurnDigest === value.turns.requestTurnDigest
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'AQ-9B cancellation must stop the current turn with no primary dispatch and preflight a distinct next user turn',
      });
    }
  });

export type LiveAutoCompactionSemanticReceiptMaterialV1 = z.infer<
  typeof liveAutoCompactionSemanticReceiptMaterialV1Schema
>;

export function computeLiveAutoCompactionSemanticReceiptRecordDigestV1(
  material: LiveAutoCompactionSemanticReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.semantic-receipt-record.v1',
    canonicalJsonBytes(liveAutoCompactionSemanticReceiptMaterialV1Schema.parse(material)),
  );
}

const liveAutoCompactionSemanticReceiptRecordMaterialV1Schema =
  liveAutoCompactionSemanticReceiptMaterialV1Schema.extend({ recordDigest: digestSchema }).strict();

export type LiveAutoCompactionSemanticReceiptRecordMaterialV1 = z.infer<
  typeof liveAutoCompactionSemanticReceiptRecordMaterialV1Schema
>;

export function computeLiveAutoCompactionSemanticReceiptReportDigestV1(
  material: LiveAutoCompactionSemanticReceiptRecordMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.semantic-receipt-report.v1',
    canonicalJsonBytes(liveAutoCompactionSemanticReceiptRecordMaterialV1Schema.parse(material)),
  );
}

export const liveAutoCompactionSemanticReceiptV1Schema =
  liveAutoCompactionSemanticReceiptRecordMaterialV1Schema
    .extend({ reportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { recordDigest, reportDigest, ...material } = value;
      const expectedRecordDigest = computeLiveAutoCompactionSemanticReceiptRecordDigestV1(material);
      if (recordDigest !== expectedRecordDigest) {
        context.addIssue({
          code: 'custom',
          path: ['recordDigest'],
          message: `AQ-9B semantic receipt record digest mismatch: expected ${expectedRecordDigest}`,
        });
      }
      const expectedReportDigest = computeLiveAutoCompactionSemanticReceiptReportDigestV1({
        ...material,
        recordDigest,
      });
      if (reportDigest !== expectedReportDigest) {
        context.addIssue({
          code: 'custom',
          path: ['reportDigest'],
          message: `AQ-9B semantic receipt report digest mismatch: expected ${expectedReportDigest}`,
        });
      }
    });

export type LiveAutoCompactionSemanticReceiptV1 = z.infer<
  typeof liveAutoCompactionSemanticReceiptV1Schema
>;

export function buildLiveAutoCompactionSemanticReceiptV1(
  material: LiveAutoCompactionSemanticReceiptMaterialV1,
): LiveAutoCompactionSemanticReceiptV1 {
  const parsed = liveAutoCompactionSemanticReceiptMaterialV1Schema.parse(material);
  const recordDigest = computeLiveAutoCompactionSemanticReceiptRecordDigestV1(parsed);
  return liveAutoCompactionSemanticReceiptV1Schema.parse({
    ...parsed,
    recordDigest,
    reportDigest: computeLiveAutoCompactionSemanticReceiptReportDigestV1({
      ...parsed,
      recordDigest,
    }),
  });
}
