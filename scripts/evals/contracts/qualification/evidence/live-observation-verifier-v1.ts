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
  type DiagnosticCandidateArtifactClosureV1,
  type DiagnosticExecutionV1,
  type DiagnosticRouteIdentityV1,
  diagnosticCandidateArtifactClosureV1Schema,
  diagnosticExecutionV1Schema,
  liveCompatibilityObservationV1Schema,
  type QualificationAttemptIdentityV1,
  type QualificationAttemptScopeV1,
  qualificationAttemptIdentityV1Schema,
  qualificationAttemptScopeV1Schema,
  sameQualificationGovernanceBindingV1,
} from './live-observation-schema-v1';
import {
  L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1,
  l3LiveObservationSourceRegistryIsClosedV1,
} from './live-observation-source-registry-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);

const liveObservationVerifierContextMaterialV1Schema = z
  .object({
    schema: z.literal('LiveCompatibilityObservationVerifierContextV1'),
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

const liveObservationVerifierContextV1Schema = liveObservationVerifierContextMaterialV1Schema
  .extend({ contextDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { contextDigest, ...material } = value;
    const expected = computeLiveCompatibilityObservationVerifierContextDigestV1(material);
    if (contextDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['contextDigest'],
        message: `live observation verifier context digest mismatch: expected ${expected}`,
      });
    }
  });

export interface LiveCompatibilityObservationVerifierContextMaterialV1 {
  readonly schema: 'LiveCompatibilityObservationVerifierContextV1';
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

export interface LiveCompatibilityObservationVerifierContextV1
  extends LiveCompatibilityObservationVerifierContextMaterialV1 {
  readonly contextDigest: `sha256:${string}`;
}

function parseContextMaterial(
  material: LiveCompatibilityObservationVerifierContextMaterialV1,
): LiveCompatibilityObservationVerifierContextMaterialV1 {
  const parsed = liveObservationVerifierContextMaterialV1Schema.parse(material);
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

/**
 * Preserve the v1 digest domain while parsing only the small L3 context.  No
 * aggregate AgentQualificationEvidence or release evaluator can enter here.
 */
export function computeLiveCompatibilityObservationVerifierContextDigestV1(
  material: LiveCompatibilityObservationVerifierContextMaterialV1,
): `sha256:${string}` {
  const parsed = parseContextMaterial(material);
  return sha256DomainSeparated(
    'kite.qualification.live-observation-verifier-context.v1',
    canonicalJsonBytes(parsed),
  );
}

export function buildLiveCompatibilityObservationVerifierContextV1(
  material: LiveCompatibilityObservationVerifierContextMaterialV1,
): LiveCompatibilityObservationVerifierContextV1 {
  const parsed = parseContextMaterial(material);
  return {
    ...parsed,
    contextDigest: computeLiveCompatibilityObservationVerifierContextDigestV1(parsed),
  };
}

export const LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1 = ['observed', 'blocked'] as const;
export type LiveCompatibilityObservationDiagnosticStateV1 =
  (typeof LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1)[number];

export const LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1 = [
  'execution_identity_untrusted',
  'identity_drift',
  'input_invalid',
  'not_observed',
  'observed_cancelled',
  'observed_success',
  'retention_unavailable',
] as const;
export type LiveCompatibilityObservationReasonCodeV1 =
  (typeof LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1)[number];

const liveCompatibilityObservationDiagnosticReportMaterialV1Schema = z
  .object({
    schema: z.literal('LiveCompatibilityObservationDiagnosticReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    verifierContextDigest: digestSchema.optional(),
    observationRecordDigest: digestSchema.optional(),
    candidateClosureDigest: digestSchema.optional(),
    outcome: z.enum(['success', 'cancelled']).optional(),
    status: z.enum(LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1),
    reasonCode: z.enum(LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const observed = value.status === 'observed';
    if (observed !== (value.outcome !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'only observed reports may carry an outcome',
      });
    }
    if (
      (value.outcome === 'success' && value.reasonCode !== 'observed_success') ||
      (value.outcome === 'cancelled' && value.reasonCode !== 'observed_cancelled') ||
      (value.status === 'blocked' &&
        ![
          'execution_identity_untrusted',
          'identity_drift',
          'input_invalid',
          'not_observed',
          'retention_unavailable',
        ].includes(value.reasonCode))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live observation status, outcome, and reason code must agree',
      });
    }
    if (
      value.status === 'observed' &&
      (value.verifierContextDigest === undefined ||
        value.observationRecordDigest === undefined ||
        value.candidateClosureDigest === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'observed report must bind context, observation record, and candidate closure digests',
      });
    }
  });

export type LiveCompatibilityObservationDiagnosticReportMaterialV1 = z.infer<
  typeof liveCompatibilityObservationDiagnosticReportMaterialV1Schema
>;

export function computeLiveCompatibilityObservationDiagnosticReportDigestV1(
  material: LiveCompatibilityObservationDiagnosticReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-observation-verifier-report.v1',
    canonicalJsonBytes(
      liveCompatibilityObservationDiagnosticReportMaterialV1Schema.parse(material),
    ),
  );
}

export const liveCompatibilityObservationDiagnosticReportV1Schema =
  liveCompatibilityObservationDiagnosticReportMaterialV1Schema
    .extend({ reportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { reportDigest, ...material } = value;
      const expected = computeLiveCompatibilityObservationDiagnosticReportDigestV1(material);
      if (reportDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['reportDigest'],
          message: `live observation verifier report digest mismatch: expected ${expected}`,
        });
      }
    });

export type LiveCompatibilityObservationDiagnosticReportV1 = z.infer<
  typeof liveCompatibilityObservationDiagnosticReportV1Schema
>;

function buildLiveCompatibilityObservationDiagnosticReport(
  material: LiveCompatibilityObservationDiagnosticReportMaterialV1,
): LiveCompatibilityObservationDiagnosticReportV1 {
  const parsed = liveCompatibilityObservationDiagnosticReportMaterialV1Schema.parse(material);
  return liveCompatibilityObservationDiagnosticReportV1Schema.parse({
    ...parsed,
    reportDigest: computeLiveCompatibilityObservationDiagnosticReportDigestV1(parsed),
  });
}

export function buildLiveCompatibilityNotObservedReportV1(
  contextInput?: unknown,
): LiveCompatibilityObservationDiagnosticReportV1 {
  const context = parseContext(contextInput);
  return buildLiveCompatibilityObservationDiagnosticReport({
    schema: 'LiveCompatibilityObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context ? { verifierContextDigest: context.contextDigest } : {}),
    ...(context ? { candidateClosureDigest: context.candidate.closureDigest } : {}),
    status: 'blocked',
    reasonCode: 'not_observed',
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
  limits: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number },
): boolean {
  return (
    counters.attempts <= limits.attempts &&
    counters.tokens <= limits.tokens &&
    counters.runWallClockSeconds <= limits.runWallClockSeconds &&
    counters.costUsdMicros <= limits.costUsdMicros
  );
}

function countersNoGreaterThan(
  counters: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
  reserved: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
): boolean {
  return (
    counters.attempts <= reserved.attempts &&
    counters.tokens <= reserved.tokens &&
    counters.runWallClockSeconds <= reserved.runWallClockSeconds &&
    counters.costUsdMicros <= reserved.costUsdMicros
  );
}

function governanceIsUsable(
  governance: EvidenceGovernanceBindingV1,
  observedAt: string,
  now: Date,
  scope: QualificationAttemptScopeV1,
  dayQuotaLedger: EvidenceQuotaLedgerV1,
  monthQuotaLedger: EvidenceQuotaLedgerV1,
  retentionWitness: EvidenceRetentionWitnessV1,
): boolean {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
  const expected = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1;
  if (
    !Number.isFinite(now.getTime()) ||
    governance.retentionClass !== expected.governance.retentionClass ||
    governance.profileId !== expected.governance.profileId ||
    governance.profileDigest !== expected.governance.profileDigest ||
    governance.expiresAt !== undefined ||
    governance.retainedArtifactDigest !== undefined ||
    governance.quotaLedgerDigests === undefined ||
    governance.storageDeletionWitnessDigest === undefined ||
    governance.quotaLedgerDigests.day !== dayQuotaLedger.recordDigest ||
    governance.quotaLedgerDigests.month !== monthQuotaLedger.recordDigest ||
    governance.storageDeletionWitnessDigest !== retentionWitness.recordDigest ||
    dayQuotaLedger.profileId !== governance.profileId ||
    dayQuotaLedger.profileDigest !== governance.profileDigest ||
    dayQuotaLedger.period !== 'day' ||
    dayQuotaLedger.status !== 'reconciled' ||
    monthQuotaLedger.profileId !== governance.profileId ||
    monthQuotaLedger.profileDigest !== governance.profileDigest ||
    monthQuotaLedger.period !== 'month' ||
    monthQuotaLedger.status !== 'reconciled' ||
    retentionWitness.profileId !== governance.profileId ||
    retentionWitness.profileDigest !== governance.profileDigest ||
    retentionWitness.retentionClass !== governance.retentionClass ||
    retentionWitness.expiresAt !== undefined ||
    retentionWitness.retainedArtifactDigest !== undefined
  ) {
    return false;
  }
  const observedAtDate = new Date(observedAt);
  if (!Number.isFinite(observedAtDate.getTime())) return false;
  const observedAtIso = observedAtDate.toISOString();
  const expectedDayPeriodStart = observedAtIso.slice(0, 10);
  const expectedMonthPeriodStart = `${observedAtIso.slice(0, 7)}-01`;
  if (
    dayQuotaLedger.routePolicyDigest !== expected.policy.policyDigest ||
    monthQuotaLedger.routePolicyDigest !== expected.policy.policyDigest ||
    scope.routePolicyDigest !== expected.policy.policyDigest ||
    dayQuotaLedger.reservationId !== monthQuotaLedger.reservationId ||
    dayQuotaLedger.periodStart !== expectedDayPeriodStart ||
    monthQuotaLedger.periodStart !== expectedMonthPeriodStart
  ) {
    return false;
  }
  const dayReconciled = dayQuotaLedger.reconciled;
  const monthReconciled = monthQuotaLedger.reconciled;
  if (!dayReconciled || !monthReconciled) return false;
  const requested = expected.quota;
  return (
    sameCanonicalValueV1(dayQuotaLedger.reserved, requested) &&
    sameCanonicalValueV1(monthQuotaLedger.reserved, requested) &&
    countersWithin(dayQuotaLedger.reserved, profile.quotas.perRun) &&
    countersWithin(dayReconciled, dayQuotaLedger.reserved) &&
    countersWithin(monthQuotaLedger.reserved, profile.quotas.perRun) &&
    countersWithin(monthReconciled, monthQuotaLedger.reserved) &&
    countersNoGreaterThan(dayReconciled, dayQuotaLedger.reserved) &&
    countersNoGreaterThan(monthReconciled, monthQuotaLedger.reserved) &&
    sameCanonicalValueV1(dayReconciled, monthReconciled) &&
    dayReconciled.attempts === 1
  );
}

function executionMatchesSourceRegistry(
  execution: DiagnosticExecutionV1,
  reservationId: string,
): boolean {
  const expected = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1.execution;
  return (
    execution.executionId === `l3-live-execution-${reservationId}` &&
    execution.platformIdentity === expected.platformIdentity &&
    execution.identity.source === 'local_synthetic' &&
    execution.identity.fixtureId === expected.fixtureId &&
    execution.identity.runner === expected.runner &&
    execution.identity.commit === expected.commit
  );
}

function contextMatchesSourceRegistry(
  context: LiveCompatibilityObservationVerifierContextV1,
): boolean {
  const expected = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1;
  return (
    sameCandidate(context.candidate, expected.candidate) &&
    sameScope(context.scope, expected.scope) &&
    sameIdentity(context.identity, expected.identity) &&
    context.governance.retentionClass === expected.governance.retentionClass &&
    context.governance.profileId === expected.governance.profileId &&
    context.governance.profileDigest === expected.governance.profileDigest &&
    executionMatchesSourceRegistry(
      context.execution,
      context.governanceWitnesses.dayQuotaLedger.reservationId,
    )
  );
}

function parseContext(value: unknown): LiveCompatibilityObservationVerifierContextV1 | undefined {
  const raw = liveObservationVerifierContextV1Schema.safeParse(value);
  if (!raw.success) return undefined;
  try {
    return {
      ...raw.data,
      contextDigest: raw.data.contextDigest as `sha256:${string}`,
    };
  } catch {
    return undefined;
  }
}

function invalidLiveObservationReport(
  context: LiveCompatibilityObservationVerifierContextV1 | undefined,
): LiveCompatibilityObservationDiagnosticReportV1 {
  return buildLiveCompatibilityObservationDiagnosticReport({
    schema: 'LiveCompatibilityObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context ? { verifierContextDigest: context.contextDigest } : {}),
    ...(context ? { candidateClosureDigest: context.candidate.closureDigest } : {}),
    status: 'blocked',
    reasonCode: 'input_invalid',
  });
}

/**
 * Verify exactly one local L3 observation against source-owned, fixed
 * declarations. This accepts neither aggregate qualification evidence nor a
 * release bundle/gate vocabulary, and cannot produce a production admission.
 */
export function verifyLiveCompatibilityObservationV1(
  observationInput: unknown,
  contextInput: unknown,
  now = new Date(),
): LiveCompatibilityObservationDiagnosticReportV1 {
  const context = parseContext(contextInput);
  if (!context) return invalidLiveObservationReport(undefined);
  const observationResult = liveCompatibilityObservationV1Schema.safeParse(observationInput);
  if (!observationResult.success) return invalidLiveObservationReport(context);
  const observation = observationResult.data;
  const base = {
    schema: 'LiveCompatibilityObservationDiagnosticReportV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    verifierContextDigest: context.contextDigest,
    observationRecordDigest: observation.recordDigest,
    candidateClosureDigest: observation.candidate.closureDigest,
  };
  if (
    !l3LiveObservationSourceRegistryIsClosedV1() ||
    !contextMatchesSourceRegistry(context) ||
    !sameQualificationGovernanceBindingV1(observation.governance, context.governance) ||
    !sameCandidate(observation.candidate, context.candidate) ||
    !sameExecution(observation.execution, context.execution) ||
    !sameScope(observation.scope, context.scope) ||
    !sameIdentity(observation.identity, context.identity) ||
    observation.observedAt !== observation.execution.identity.endedAt
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
  }
  if (
    !executionMatchesSourceRegistry(
      observation.execution,
      context.governanceWitnesses.dayQuotaLedger.reservationId,
    )
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'execution_identity_untrusted',
    });
  }
  if (
    !governanceIsUsable(
      observation.governance,
      observation.observedAt,
      now,
      observation.scope,
      context.governanceWitnesses.dayQuotaLedger,
      context.governanceWitnesses.monthQuotaLedger,
      context.governanceWitnesses.retention,
    )
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'retention_unavailable',
    });
  }
  return buildLiveCompatibilityObservationDiagnosticReport({
    ...base,
    outcome: observation.outcome,
    status: 'observed',
    reasonCode: observation.outcome === 'success' ? 'observed_success' : 'observed_cancelled',
  });
}
