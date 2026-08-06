import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  EVIDENCE_GOVERNANCE_PROFILE_V1,
  type EvidenceGovernanceBindingV1,
  type EvidenceQuotaLedgerV1,
  type EvidenceRetentionWitnessV1,
  evidenceGovernanceBindingV1Schema,
  evidenceQuotaLedgerV1Schema,
  evidenceRetentionWitnessV1Schema,
} from './governance-v1';
import {
  LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1,
  type LiveAutoCompactionDurationBucketV1,
  type LiveAutoCompactionSemanticReceiptV1,
  liveAutoCompactionDurationBucketForRunWallClockSecondsV1,
  liveAutoCompactionSemanticReceiptV1Schema,
} from './live-auto-compaction-schema-v1';
import {
  L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1,
  l3LiveAutoCompactionSourceRegistryIsClosedV1,
} from './live-auto-compaction-source-registry-v1';
import {
  type DiagnosticCandidateArtifactClosureV1,
  type DiagnosticExecutionV1,
  type DiagnosticRouteIdentityV1,
  diagnosticCandidateArtifactClosureV1Schema,
  diagnosticExecutionV1Schema,
  type LiveCompatibilityObservationV1,
  liveCompatibilityObservationV1Schema,
  type QualificationAttemptIdentityV1,
  type QualificationAttemptScopeV1,
  qualificationAttemptIdentityV1Schema,
  qualificationAttemptScopeV1Schema,
  sameQualificationGovernanceBindingV1,
} from './live-observation-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);

const liveAutoCompactionObservationVerifierContextMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionObservationVerifierContextV1'),
    version: z.literal(1),
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    execution: diagnosticExecutionV1Schema,
    scope: qualificationAttemptScopeV1Schema,
    identity: qualificationAttemptIdentityV1Schema,
    governanceWitnesses: z
      .object({
        dayQuotaLedger: evidenceQuotaLedgerV1Schema,
        monthQuotaLedger: evidenceQuotaLedgerV1Schema,
        retention: evidenceRetentionWitnessV1Schema,
      })
      .strict(),
  })
  .strict();

export interface LiveAutoCompactionObservationVerifierContextMaterialV1 {
  readonly schema: 'LiveAutoCompactionObservationVerifierContextV1';
  readonly version: 1;
  readonly candidate: DiagnosticCandidateArtifactClosureV1;
  readonly governance: EvidenceGovernanceBindingV1;
  readonly execution: DiagnosticExecutionV1;
  readonly scope: QualificationAttemptScopeV1;
  readonly identity: QualificationAttemptIdentityV1;
  readonly governanceWitnesses: {
    readonly dayQuotaLedger: EvidenceQuotaLedgerV1;
    readonly monthQuotaLedger: EvidenceQuotaLedgerV1;
    readonly retention: EvidenceRetentionWitnessV1;
  };
}

function parseContextMaterial(
  material: LiveAutoCompactionObservationVerifierContextMaterialV1,
): LiveAutoCompactionObservationVerifierContextMaterialV1 {
  const parsed = liveAutoCompactionObservationVerifierContextMaterialV1Schema.parse(material);
  return {
    schema: parsed.schema,
    version: parsed.version,
    candidate: parsed.candidate,
    governance: parsed.governance,
    execution: parsed.execution,
    scope: parsed.scope,
    identity: parsed.identity,
    governanceWitnesses: parsed.governanceWitnesses,
  };
}

export function computeLiveAutoCompactionObservationVerifierContextDigestV1(
  material: LiveAutoCompactionObservationVerifierContextMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction-verifier-context.v1',
    canonicalJsonBytes(parseContextMaterial(material)),
  );
}

export const liveAutoCompactionObservationVerifierContextV1Schema =
  liveAutoCompactionObservationVerifierContextMaterialV1Schema
    .extend({ contextDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { contextDigest, ...material } = value;
      const expected = computeLiveAutoCompactionObservationVerifierContextDigestV1(material);
      if (contextDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['contextDigest'],
          message: `AQ-9B verifier context digest mismatch: expected ${expected}`,
        });
      }
    });

export interface LiveAutoCompactionObservationVerifierContextV1
  extends LiveAutoCompactionObservationVerifierContextMaterialV1 {
  readonly contextDigest: `sha256:${string}`;
}

export function buildLiveAutoCompactionObservationVerifierContextV1(
  material: LiveAutoCompactionObservationVerifierContextMaterialV1,
): LiveAutoCompactionObservationVerifierContextV1 {
  const parsed = parseContextMaterial(material);
  const verified = liveAutoCompactionObservationVerifierContextV1Schema.parse({
    ...parsed,
    contextDigest: computeLiveAutoCompactionObservationVerifierContextDigestV1(parsed),
  });
  return {
    ...verified,
    contextDigest: verified.contextDigest as `sha256:${string}`,
  };
}

export const LIVE_AUTO_COMPACTION_OBSERVATION_DIAGNOSTIC_STATES_V1 = [
  'observed',
  'blocked',
] as const;
export type LiveAutoCompactionObservationDiagnosticStateV1 =
  (typeof LIVE_AUTO_COMPACTION_OBSERVATION_DIAGNOSTIC_STATES_V1)[number];

/**
 * `phase_dispatch_unknown` intentionally has no observed outcome. The runner
 * uses it when aborting after a possibly-dispatched summary request, charges
 * conservatively, and refuses to make a primary/tail request.
 */
export const LIVE_AUTO_COMPACTION_OBSERVATION_REASON_CODES_V1 = [
  'execution_identity_untrusted',
  'duration_bucket_mismatch',
  'identity_drift',
  'input_invalid',
  'not_observed',
  'observed_cancelled',
  'observed_success',
  'phase_budget_drift',
  'phase_dispatch_unknown',
  'retention_unavailable',
] as const;
export type LiveAutoCompactionObservationReasonCodeV1 =
  (typeof LIVE_AUTO_COMPACTION_OBSERVATION_REASON_CODES_V1)[number];

const liveAutoCompactionObservationDiagnosticReportMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionObservationDiagnosticReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    verifierContextDigest: digestSchema.optional(),
    observationRecordDigest: digestSchema.optional(),
    observationReportDigest: digestSchema.optional(),
    semanticReceiptRecordDigest: digestSchema.optional(),
    semanticReceiptReportDigest: digestSchema.optional(),
    candidateClosureDigest: digestSchema.optional(),
    outcome: z.enum(['success', 'cancelled']).optional(),
    durationBucket: z.enum(LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1).optional(),
    status: z.enum(LIVE_AUTO_COMPACTION_OBSERVATION_DIAGNOSTIC_STATES_V1),
    reasonCode: z.enum(LIVE_AUTO_COMPACTION_OBSERVATION_REASON_CODES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const observed = value.status === 'observed';
    if (observed !== (value.outcome !== undefined)) {
      context.addIssue({ code: 'custom', message: 'only observed reports may carry an outcome' });
    }
    if (observed !== (value.durationBucket !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'only observed reports may retain the coarse duration bucket',
      });
    }
    if (
      (value.outcome === 'success' && value.reasonCode !== 'observed_success') ||
      (value.outcome === 'cancelled' && value.reasonCode !== 'observed_cancelled') ||
      (value.status === 'blocked' &&
        ![
          'execution_identity_untrusted',
          'duration_bucket_mismatch',
          'identity_drift',
          'input_invalid',
          'not_observed',
          'phase_budget_drift',
          'phase_dispatch_unknown',
          'retention_unavailable',
        ].includes(value.reasonCode))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'AQ-9B report status, outcome, and reason code must agree',
      });
    }
    if (
      observed &&
      (value.verifierContextDigest === undefined ||
        value.observationRecordDigest === undefined ||
        value.observationReportDigest === undefined ||
        value.semanticReceiptRecordDigest === undefined ||
        value.semanticReceiptReportDigest === undefined ||
        value.candidateClosureDigest === undefined ||
        value.durationBucket === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'observed AQ-9B report must bind context, outer observation, semantic receipt, and candidate closure digests',
      });
    }
  });

export type LiveAutoCompactionObservationDiagnosticReportMaterialV1 = z.infer<
  typeof liveAutoCompactionObservationDiagnosticReportMaterialV1Schema
>;

export function computeLiveAutoCompactionObservationDiagnosticReportDigestV1(
  material: LiveAutoCompactionObservationDiagnosticReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction-verifier-report.v1',
    canonicalJsonBytes(
      liveAutoCompactionObservationDiagnosticReportMaterialV1Schema.parse(material),
    ),
  );
}

export const liveAutoCompactionObservationDiagnosticReportV1Schema =
  liveAutoCompactionObservationDiagnosticReportMaterialV1Schema
    .extend({ reportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { reportDigest, ...material } = value;
      const expected = computeLiveAutoCompactionObservationDiagnosticReportDigestV1(material);
      if (reportDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['reportDigest'],
          message: `AQ-9B verifier report digest mismatch: expected ${expected}`,
        });
      }
    });

export type LiveAutoCompactionObservationDiagnosticReportV1 = z.infer<
  typeof liveAutoCompactionObservationDiagnosticReportV1Schema
>;

function buildReport(
  material: LiveAutoCompactionObservationDiagnosticReportMaterialV1,
): LiveAutoCompactionObservationDiagnosticReportV1 {
  const parsed = liveAutoCompactionObservationDiagnosticReportMaterialV1Schema.parse(material);
  return liveAutoCompactionObservationDiagnosticReportV1Schema.parse({
    ...parsed,
    reportDigest: computeLiveAutoCompactionObservationDiagnosticReportDigestV1(parsed),
  });
}

function sameCanonicalValueV1(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameRoute(
  left: DiagnosticRouteIdentityV1 | undefined,
  right: DiagnosticRouteIdentityV1 | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameCanonicalValueV1(left, right);
}

function sameScope(left: QualificationAttemptScopeV1, right: QualificationAttemptScopeV1): boolean {
  return (
    left.platformIdentity === right.platformIdentity &&
    left.releaseProfileDigest === right.releaseProfileDigest &&
    left.entrypoint === right.entrypoint &&
    left.testPolicyDigest === right.testPolicyDigest &&
    left.routePolicyDigest === right.routePolicyDigest &&
    sameRoute(left.route, right.route)
  );
}

function sameIdentity(
  left: QualificationAttemptIdentityV1,
  right: QualificationAttemptIdentityV1,
): boolean {
  return (
    left.matrixDigest === right.matrixDigest &&
    left.suiteDigest === right.suiteDigest &&
    left.oracleDigest === right.oracleDigest &&
    left.corpusDigest === right.corpusDigest &&
    left.evaluatorDigest === right.evaluatorDigest &&
    left.verifierDigest === right.verifierDigest &&
    left.runnerDigest === right.runnerDigest
  );
}

function sameCandidate(
  left: DiagnosticCandidateArtifactClosureV1,
  right: DiagnosticCandidateArtifactClosureV1,
): boolean {
  return left.closureDigest === right.closureDigest && sameCanonicalValueV1(left, right);
}

function sameExecution(left: DiagnosticExecutionV1, right: DiagnosticExecutionV1): boolean {
  return left.executionDigest === right.executionDigest && sameCanonicalValueV1(left, right);
}

function countersWithin(
  counters: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
  limit: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number },
): boolean {
  return (
    counters.attempts <= limit.attempts &&
    counters.tokens <= limit.tokens &&
    counters.runWallClockSeconds <= limit.runWallClockSeconds &&
    counters.costUsdMicros <= limit.costUsdMicros
  );
}

function governanceIsUsable(
  governance: EvidenceGovernanceBindingV1,
  observedAt: string,
  outcome: LiveAutoCompactionSemanticReceiptV1['outcome'],
  scope: QualificationAttemptScopeV1,
  dayQuotaLedger: EvidenceQuotaLedgerV1,
  monthQuotaLedger: EvidenceQuotaLedgerV1,
  retentionWitness: EvidenceRetentionWitnessV1,
): boolean {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
  const observedDate = new Date(observedAt);
  if (!Number.isFinite(observedDate.getTime())) return false;
  const observedIso = observedDate.toISOString();
  const expectedAttempts = outcome === 'success' ? 2 : 1;
  const dayReconciled = dayQuotaLedger.reconciled;
  const monthReconciled = monthQuotaLedger.reconciled;
  return (
    governance.retentionClass === source.governance.retentionClass &&
    governance.profileId === source.governance.profileId &&
    governance.profileDigest === source.governance.profileDigest &&
    governance.expiresAt === undefined &&
    governance.retainedArtifactDigest === undefined &&
    governance.quotaLedgerDigests !== undefined &&
    governance.storageDeletionWitnessDigest !== undefined &&
    governance.quotaLedgerDigests.day === dayQuotaLedger.recordDigest &&
    governance.quotaLedgerDigests.month === monthQuotaLedger.recordDigest &&
    governance.storageDeletionWitnessDigest === retentionWitness.recordDigest &&
    dayQuotaLedger.profileId === governance.profileId &&
    dayQuotaLedger.profileDigest === governance.profileDigest &&
    dayQuotaLedger.routePolicyDigest === source.policy.policyDigest &&
    dayQuotaLedger.period === 'day' &&
    dayQuotaLedger.periodStart === observedIso.slice(0, 10) &&
    dayQuotaLedger.status === 'reconciled' &&
    monthQuotaLedger.profileId === governance.profileId &&
    monthQuotaLedger.profileDigest === governance.profileDigest &&
    monthQuotaLedger.routePolicyDigest === source.policy.policyDigest &&
    monthQuotaLedger.period === 'month' &&
    monthQuotaLedger.periodStart === `${observedIso.slice(0, 7)}-01` &&
    monthQuotaLedger.status === 'reconciled' &&
    dayQuotaLedger.reservationId === monthQuotaLedger.reservationId &&
    dayReconciled !== undefined &&
    monthReconciled !== undefined &&
    sameCanonicalValueV1(dayQuotaLedger.reserved, source.quota) &&
    sameCanonicalValueV1(monthQuotaLedger.reserved, source.quota) &&
    countersWithin(dayQuotaLedger.reserved, profile.quotas.perRun) &&
    countersWithin(monthQuotaLedger.reserved, profile.quotas.perRun) &&
    countersWithin(dayReconciled, dayQuotaLedger.reserved) &&
    countersWithin(monthReconciled, monthQuotaLedger.reserved) &&
    sameCanonicalValueV1(dayReconciled, monthReconciled) &&
    dayReconciled.attempts === expectedAttempts &&
    retentionWitness.profileId === governance.profileId &&
    retentionWitness.profileDigest === governance.profileDigest &&
    retentionWitness.retentionClass === governance.retentionClass &&
    retentionWitness.expiresAt === undefined &&
    retentionWitness.retainedArtifactDigest === undefined &&
    retentionWitness.storage.acl === profile.storage.acl &&
    retentionWitness.storage.encryption === profile.storage.encryption &&
    retentionWitness.storage.audit === profile.storage.audit &&
    retentionWitness.deleteTrigger === profile.retention.deleteTrigger &&
    scope.routePolicyDigest === source.policy.policyDigest
  );
}

function executionMatchesSourceRegistry(
  execution: DiagnosticExecutionV1,
  reservationId: string,
): boolean {
  const expected = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1.execution;
  return (
    execution.executionId === `l3-live-auto-compaction-execution-${reservationId}` &&
    execution.platformIdentity === expected.platformIdentity &&
    execution.identity.source === 'local_synthetic' &&
    execution.identity.fixtureId === expected.fixtureId &&
    execution.identity.runner === expected.runner &&
    execution.identity.commit === expected.commit
  );
}

function contextMatchesSourceRegistry(
  context: LiveAutoCompactionObservationVerifierContextV1,
): boolean {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  return (
    sameCandidate(context.candidate, source.candidate) &&
    sameScope(context.scope, source.scope) &&
    sameIdentity(context.identity, source.identity) &&
    context.governance.retentionClass === source.governance.retentionClass &&
    context.governance.profileId === source.governance.profileId &&
    context.governance.profileDigest === source.governance.profileDigest &&
    executionMatchesSourceRegistry(
      context.execution,
      context.governanceWitnesses.dayQuotaLedger.reservationId,
    )
  );
}

function receiptMatchesSourceRegistry(
  receipt: LiveAutoCompactionSemanticReceiptV1,
  observation: LiveCompatibilityObservationV1,
  context: LiveAutoCompactionObservationVerifierContextV1,
): boolean {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  const binding = receipt.sourceBinding;
  const dayLedger = context.governanceWitnesses.dayQuotaLedger;
  const monthLedger = context.governanceWitnesses.monthQuotaLedger;
  const retention = context.governanceWitnesses.retention;
  return (
    receipt.compactAfterEstimatedTokens === source.semantic.compactAfterEstimatedTokens &&
    receipt.fullProjectionTokenBucket === '9000_10000' &&
    receipt.durationBucketPolicyDigest === source.semantic.durationBucketPolicyDigest &&
    sameCanonicalValueV1(receipt.phaseCaps, source.semantic.phaseCaps) &&
    receipt.phaseCapsDigest === source.semantic.phaseCapsDigest &&
    receipt.capabilityResolution.capabilityDeclarationDigest ===
      source.policy.capabilityDeclarationDigest &&
    receipt.capabilityResolution.contextWindowTokens ===
      source.semantic.capability.contextWindowTokens &&
    receipt.capabilityResolution.contextWindowSource ===
      source.semantic.capability.contextWindowSource &&
    receipt.capabilityResolution.maxOutputTokens === source.semantic.capability.maxOutputTokens &&
    receipt.capabilityResolution.maxOutputTokensSource ===
      source.semantic.capability.maxOutputTokensSource &&
    binding.policyDigest === source.policy.policyDigest &&
    binding.durationBucketPolicyDigest === source.semantic.durationBucketPolicyDigest &&
    binding.phaseCapsDigest === source.semantic.phaseCapsDigest &&
    binding.syntheticProjectionDigest ===
      source.semantic.syntheticProjection.syntheticProjectionDigest &&
    binding.routeIdentityDigest === source.policy.routeIdentityDigest &&
    binding.providerDataPolicyDigest === source.policy.providerDataPolicyDigest &&
    binding.capabilityDeclarationDigest === source.policy.capabilityDeclarationDigest &&
    binding.promptEnvironmentDigest === source.policy.promptEnvironmentDigest &&
    binding.routeToolCatalogDigest === source.policy.routeToolCatalogDigest &&
    binding.toolEnvironmentDigest === source.policy.toolEnvironmentDigest &&
    binding.sourceOwnedIdentityDigest === source.policy.sourceOwnedIdentityDigest &&
    binding.candidateClosureDigest === source.policy.candidateClosureDigest &&
    binding.matrixDigest === source.policy.matrixDigest &&
    binding.matrixSuiteDigest === source.policy.matrixSuiteDigest &&
    binding.suiteDigest === source.policy.suiteDigest &&
    binding.fixtureDigest === source.policy.fixtureDigest &&
    binding.corpusDigest === source.policy.corpusDigest &&
    binding.oracleDigest === source.policy.oracleDigest &&
    binding.evaluatorDigest === source.policy.evaluatorDigest &&
    binding.verifierDigest === source.policy.verifierDigest &&
    binding.runnerSourceDigest === source.policy.runnerSourceDigest &&
    binding.runnerDigest === source.policy.runnerDigest &&
    binding.transportBindingDigest === source.policy.transportBindingDigest &&
    binding.executionDigest === context.execution.executionDigest &&
    binding.governanceProfileDigest === source.governance.profileDigest &&
    binding.dayQuotaLedgerDigest === dayLedger.recordDigest &&
    binding.monthQuotaLedgerDigest === monthLedger.recordDigest &&
    binding.retentionWitnessDigest === retention.recordDigest &&
    binding.observationRecordDigest === observation.recordDigest &&
    binding.observationReportDigest === observation.reportDigest
  );
}

/**
 * Exact duration stays in the governance ledger.  The verifier projects it
 * once into a closed policy bucket before it can be retained in diagnostic
 * evidence or a diagnostic report.
 */
function durationBucketFromGovernance(
  context: LiveAutoCompactionObservationVerifierContextV1,
): LiveAutoCompactionDurationBucketV1 | undefined {
  const reconciled = context.governanceWitnesses.dayQuotaLedger.reconciled;
  return reconciled
    ? liveAutoCompactionDurationBucketForRunWallClockSecondsV1(reconciled.runWallClockSeconds)
    : undefined;
}

function parseContext(value: unknown): LiveAutoCompactionObservationVerifierContextV1 | undefined {
  const parsed = liveAutoCompactionObservationVerifierContextV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    contextDigest: parsed.data.contextDigest as `sha256:${string}`,
  };
}

function blockedReport(
  context: LiveAutoCompactionObservationVerifierContextV1 | undefined,
  reasonCode: Extract<
    LiveAutoCompactionObservationReasonCodeV1,
    | 'execution_identity_untrusted'
    | 'duration_bucket_mismatch'
    | 'identity_drift'
    | 'input_invalid'
    | 'not_observed'
    | 'phase_budget_drift'
    | 'phase_dispatch_unknown'
    | 'retention_unavailable'
  >,
  bindings: {
    observation?: LiveCompatibilityObservationV1;
    receipt?: LiveAutoCompactionSemanticReceiptV1;
  } = {},
): LiveAutoCompactionObservationDiagnosticReportV1 {
  return buildReport({
    schema: 'LiveAutoCompactionObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context ? { verifierContextDigest: context.contextDigest } : {}),
    ...(bindings.observation
      ? {
          observationRecordDigest: bindings.observation.recordDigest,
          observationReportDigest: bindings.observation.reportDigest,
          candidateClosureDigest: bindings.observation.candidate.closureDigest,
        }
      : context
        ? { candidateClosureDigest: context.candidate.closureDigest }
        : {}),
    ...(bindings.receipt
      ? {
          semanticReceiptRecordDigest: bindings.receipt.recordDigest,
          semanticReceiptReportDigest: bindings.receipt.reportDigest,
        }
      : {}),
    status: 'blocked',
    reasonCode,
  });
}

/**
 * Explicitly represent an intentionally absent/zero-network AQ-9B run. This
 * helper cannot manufacture an observed success or cancellation.
 */
export function buildLiveAutoCompactionNotObservedReportV1(
  contextInput?: unknown,
  reasonCode: 'not_observed' | 'phase_budget_drift' | 'phase_dispatch_unknown' = 'not_observed',
): LiveAutoCompactionObservationDiagnosticReportV1 {
  return blockedReport(parseContext(contextInput), reasonCode);
}

/**
 * Verify the AQ-9B companion receipt against the existing diagnostic outer
 * observation. This verifier accepts no release evidence, release bundle, or
 * release-Gate input and can only emit an independent diagnostic report.
 */
export function verifyLiveAutoCompactionObservationV1(
  observationInput: unknown,
  receiptInput: unknown,
  contextInput: unknown,
): LiveAutoCompactionObservationDiagnosticReportV1 {
  const context = parseContext(contextInput);
  if (!context) return blockedReport(undefined, 'input_invalid');
  const observationResult = liveCompatibilityObservationV1Schema.safeParse(observationInput);
  if (!observationResult.success) return blockedReport(context, 'input_invalid');
  const receiptResult = liveAutoCompactionSemanticReceiptV1Schema.safeParse(receiptInput);
  if (!receiptResult.success)
    return blockedReport(context, 'input_invalid', { observation: observationResult.data });
  const observation = observationResult.data;
  const receipt = receiptResult.data;

  if (
    !l3LiveAutoCompactionSourceRegistryIsClosedV1() ||
    !contextMatchesSourceRegistry(context) ||
    !sameQualificationGovernanceBindingV1(observation.governance, context.governance) ||
    !sameCandidate(observation.candidate, context.candidate) ||
    !sameExecution(observation.execution, context.execution) ||
    !sameScope(observation.scope, context.scope) ||
    !sameIdentity(observation.identity, context.identity) ||
    observation.observedAt !== observation.execution.identity.endedAt
  ) {
    return blockedReport(context, 'identity_drift', { observation, receipt });
  }
  if (
    !executionMatchesSourceRegistry(
      observation.execution,
      context.governanceWitnesses.dayQuotaLedger.reservationId,
    )
  ) {
    return blockedReport(context, 'execution_identity_untrusted', { observation, receipt });
  }
  if (
    observation.outcome !== receipt.outcome ||
    !receiptMatchesSourceRegistry(receipt, observation, context)
  ) {
    return blockedReport(context, 'identity_drift', { observation, receipt });
  }
  if (
    !governanceIsUsable(
      observation.governance,
      observation.observedAt,
      receipt.outcome,
      observation.scope,
      context.governanceWitnesses.dayQuotaLedger,
      context.governanceWitnesses.monthQuotaLedger,
      context.governanceWitnesses.retention,
    )
  ) {
    return blockedReport(context, 'retention_unavailable', { observation, receipt });
  }
  const durationBucket = durationBucketFromGovernance(context);
  if (!durationBucket || receipt.durationBucket !== durationBucket) {
    return blockedReport(context, 'duration_bucket_mismatch', { observation, receipt });
  }
  return buildReport({
    schema: 'LiveAutoCompactionObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    verifierContextDigest: context.contextDigest,
    observationRecordDigest: observation.recordDigest,
    observationReportDigest: observation.reportDigest,
    semanticReceiptRecordDigest: receipt.recordDigest,
    semanticReceiptReportDigest: receipt.reportDigest,
    candidateClosureDigest: observation.candidate.closureDigest,
    outcome: receipt.outcome,
    durationBucket,
    status: 'observed',
    reasonCode: receipt.outcome === 'success' ? 'observed_success' : 'observed_cancelled',
  });
}
