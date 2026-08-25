import { z } from 'zod';
import { type ReleaseCapability, releaseCapabilitySchema } from '#app/config/release-capabilities';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const MATURITY_EVIDENCE_DIGEST_DOMAIN = 'kite.release.capability-maturity-evidence.v1';
const MATURITY_GATE_DECISION_DIGEST_DOMAIN = 'kite.release.capability-maturity-gate.v1';
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), 'identity must not contain surrounding whitespace');
const recordIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const SINGLE_MAINTAINER_IDENTITY = 'github:@ferqx';

export const CAPABILITY_MATURITY_STAGES_ = Object.freeze(['canary', 'beta', 'stable'] as const);
export type CapabilityMaturityStage = (typeof CAPABILITY_MATURITY_STAGES_)[number];

const maturityStageSchema = z.enum(CAPABILITY_MATURITY_STAGES_);

/** Exact release/evaluator identity shared by every decision in one maturity chain. */
export const capabilityMaturityIdentitySchema = z
  .object({
    payloadDigest: digestSchema,
    profileDigest: digestSchema,
    routeDigest: digestSchema,
    platformIdentity: identitySchema,
    capability: releaseCapabilitySchema,
    capabilityContractDigest: digestSchema,
    evaluatorIdentity: z
      .object({
        evaluatorId: identitySchema,
        evaluatorDigest: digestSchema,
        suiteDigest: digestSchema,
      })
      .strict(),
  })
  .strict();

export type CapabilityMaturityIdentity = z.infer<typeof capabilityMaturityIdentitySchema>;

const previousMaturityDecisionSchema = z
  .object({
    schema: z.literal('CapabilityMaturityPreviousDecision'),
    stage: maturityStageSchema,
    status: z.literal('passed'),
    decisionId: recordIdSchema,
    windowId: recordIdSchema,
    decidedAt: timestampSchema,
    identity: capabilityMaturityIdentitySchema,
    decisionDigest: digestSchema,
  })
  .strict();

const preregistrationSchema = z
  .object({
    registrationId: recordIdSchema,
    registeredAt: timestampSchema,
    windowStartsAt: timestampSchema,
    windowEndsAt: timestampSchema,
    minimumWindowSeconds: z.number().int().positive(),
    minimumSamples: z.number().int().positive(),
    maximumErrorBudgetBps: z.number().int().min(0).max(10_000),
    minimumUserUnderstandingSamples: z.number().int().positive(),
    minimumUserUnderstandingBps: z.number().int().min(1).max(10_000),
    requiredHumanApprovalCount: z.literal(1),
    freshnessSeconds: z.number().int().positive(),
  })
  .strict();

const humanApprovalSchema = z
  .object({
    approvalId: recordIdSchema,
    approverIdentity: z.literal(SINGLE_MAINTAINER_IDENTITY),
    approvedAt: timestampSchema,
    outcome: z.literal('approved'),
    reviewMode: z.literal('single_maintainer'),
    recordDigest: digestSchema,
  })
  .strict();

const maturityObservationSchema = z
  .object({
    evidenceClass: z.enum(['contract_only', 'production_observation']),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sampleCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    errorBudgetConsumedBps: z.number().int().min(0).max(10_000),
    retainedSampleLedgerDigest: digestSchema,
    gates: z
      .object({
        G3: z.enum(['passed', 'failed', 'blocked', 'not_run']),
        G4: z.enum(['passed', 'failed', 'blocked', 'not_run']),
        G5: z.enum(['passed', 'failed', 'blocked', 'not_run']),
      })
      .strict(),
    humanApprovals: z.array(humanApprovalSchema).length(1),
    userUnderstanding: z
      .object({
        responseCount: z.number().int().nonnegative(),
        understoodCount: z.number().int().nonnegative(),
        understandingBps: z.number().int().min(0).max(10_000),
        retainedResponseLedgerDigest: digestSchema,
      })
      .strict(),
    rollback: z
      .object({
        status: z.enum(['passed', 'failed', 'not_run']),
        rehearsalId: recordIdSchema,
        rehearsedAt: timestampSchema,
        recordDigest: digestSchema,
        disablesNewAdmission: z.literal(true),
        cohortPercentAfterRollback: z.literal(0),
      })
      .strict(),
  })
  .strict();

export const capabilityMaturityEvidenceMaterialSchema = z
  .object({
    schema: z.literal('CapabilityMaturityEvidenceMaterial'),
    decisionId: recordIdSchema,
    windowId: recordIdSchema,
    targetStage: maturityStageSchema,
    identity: capabilityMaturityIdentitySchema,
    previousDecision: previousMaturityDecisionSchema.nullable(),
    preregistration: preregistrationSchema,
    observation: maturityObservationSchema,
  })
  .strict();

export type CapabilityMaturityEvidenceMaterial = z.infer<
  typeof capabilityMaturityEvidenceMaterialSchema
>;

const maturityAuthenticationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('unconfigured'),
      subjectDigest: digestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('github_oidc_sigstore_v1'),
      authorityIdentity: identitySchema,
      verifierIdentity: identitySchema,
      subjectDigest: digestSchema,
      attestationDigest: digestSchema,
      verificationReceiptDigest: digestSchema,
      verifiedAt: timestampSchema,
    })
    .strict(),
]);

export const capabilityMaturityEvidenceSchema = z
  .object({
    schema: z.literal('CapabilityMaturityEvidence'),
    material: capabilityMaturityEvidenceMaterialSchema,
    materialDigest: digestSchema,
    authentication: maturityAuthenticationSchema,
  })
  .strict();

export type CapabilityMaturityEvidence = z.infer<typeof capabilityMaturityEvidenceSchema>;

// No production maturity producer/attestation authority has been approved. This
// registry is deliberately source-owned and cannot be injected by a caller.
interface TrustedCapabilityMaturityAuthority {
  authorityIdentity: string;
  verifierIdentity: string;
  capabilities: readonly ReleaseCapability[];
  subjectDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  verificationReceiptDigest: `sha256:${string}`;
  verifiedAt: string;
}
const TRUSTED_CAPABILITY_MATURITY_AUTHORITIES_: readonly TrustedCapabilityMaturityAuthority[] =
  Object.freeze([]);
/**
 * Deliberately empty until prior-decision and maintainer-approval
 * artifact verifiers exist. Populating only the authority allowlist above can
 * never make caller-authored chain or approval summaries eligible.
 */
const VERIFIED_CAPABILITY_MATURITY_PREVIOUS_DECISIONS_: readonly string[] = Object.freeze([]);
const VERIFIED_CAPABILITY_MATURITY_MAINTAINER_APPROVALS_: readonly string[] = Object.freeze([]);
const PRODUCTION_CAPABILITY_MATURITY_EXACT_RECORD_LOOKUP_IMPLEMENTED_ = true as const;

export interface CapabilityMaturityGateDecision {
  schema: 'CapabilityMaturityGateDecision';
  status: 'passed' | 'blocked';
  promotionEligible: boolean;
  targetStage: CapabilityMaturityStage;
  identity: CapabilityMaturityIdentity;
  decisionId: string | null;
  windowId: string | null;
  evidenceDigest: `sha256:${string}` | null;
  trustRegistryDigest: `sha256:${string}`;
  reasonCodes: string[];
  decisionDigest: `sha256:${string}`;
}

export function computeCapabilityMaturityEvidenceDigest(rawMaterial: unknown): `sha256:${string}` {
  const material = capabilityMaturityEvidenceMaterialSchema.parse(rawMaterial);
  return sha256DomainSeparated(MATURITY_EVIDENCE_DIGEST_DOMAIN, canonicalJson(material));
}

/** Strictly rebuild the signed subject before any Gate interpretation. */
export function verifyCapabilityMaturityEvidence(rawEvidence: unknown): CapabilityMaturityEvidence {
  const evidence = capabilityMaturityEvidenceSchema.parse(rawEvidence);
  const rebuiltDigest = computeCapabilityMaturityEvidenceDigest(evidence.material);
  if (evidence.materialDigest !== rebuiltDigest) {
    throw new Error(`Capability maturity material digest mismatch: expected ${rebuiltDigest}.`);
  }
  if (evidence.authentication.subjectDigest !== evidence.materialDigest) {
    throw new Error('Capability maturity authentication subject does not match material digest.');
  }
  return evidence;
}

/**
 * Gate-only projection. It never writes capability decisions or changes a
 * profile. The exact-record lookup path is implemented, but it is not a
 * cryptographic attestation verifier. The source-owned authority,
 * prior-decision and maintainer-approval registries remain empty until real signed
 * evidence is verified and reviewed.
 */
export function evaluateCapabilityMaturityGate(input: {
  targetStage: CapabilityMaturityStage;
  expectedIdentity: CapabilityMaturityIdentity;
  evaluatedAt: string;
  evidence?: unknown;
}): CapabilityMaturityGateDecision {
  const targetStage = maturityStageSchema.parse(input.targetStage);
  const expectedIdentity = capabilityMaturityIdentitySchema.parse(input.expectedIdentity);
  const evaluatedAtMs = parseTimestamp(input.evaluatedAt, 'Gate evaluation time');
  const trustRegistryDigest = sha256DomainSeparated(
    'kite.release.capability-maturity-authority-registry.v1',
    canonicalJson({
      authorities: TRUSTED_CAPABILITY_MATURITY_AUTHORITIES_,
      previousDecisions: VERIFIED_CAPABILITY_MATURITY_PREVIOUS_DECISIONS_,
      maintainerApprovals: VERIFIED_CAPABILITY_MATURITY_MAINTAINER_APPROVALS_,
      exactRecordLookupImplemented: PRODUCTION_CAPABILITY_MATURITY_EXACT_RECORD_LOOKUP_IMPLEMENTED_,
    }),
  );
  const reasons = new Set<string>();
  if (TRUSTED_CAPABILITY_MATURITY_AUTHORITIES_.length === 0) {
    reasons.add('authenticated_maturity_authority_not_configured');
  }
  let evidence: CapabilityMaturityEvidence | undefined;

  if (input.evidence === undefined) {
    reasons.add('maturity_evidence_missing');
  } else {
    evidence = verifyCapabilityMaturityEvidence(input.evidence);
    evaluateEvidence({ evidence, expectedIdentity, targetStage, evaluatedAtMs, reasons });
  }

  const promotionEligible = reasons.size === 0;
  const withoutDigest = {
    schema: 'CapabilityMaturityGateDecision' as const,
    status: promotionEligible ? ('passed' as const) : ('blocked' as const),
    promotionEligible,
    targetStage,
    identity: expectedIdentity,
    decisionId: evidence?.material.decisionId ?? null,
    windowId: evidence?.material.windowId ?? null,
    evidenceDigest: (evidence?.materialDigest as `sha256:${string}` | undefined) ?? null,
    trustRegistryDigest,
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    decisionDigest: sha256DomainSeparated(
      MATURITY_GATE_DECISION_DIGEST_DOMAIN,
      canonicalJson(withoutDigest),
    ),
  };
}

function evaluateEvidence(input: {
  evidence: CapabilityMaturityEvidence;
  expectedIdentity: CapabilityMaturityIdentity;
  targetStage: CapabilityMaturityStage;
  evaluatedAtMs: number;
  reasons: Set<string>;
}): void {
  const { material, authentication } = input.evidence;
  const { observation, preregistration, previousDecision } = material;
  if (material.targetStage !== input.targetStage) input.reasons.add('target_stage_mismatch');
  compareIdentity(material.identity, input.expectedIdentity, 'evidence', input.reasons);

  if (authentication.kind === 'unconfigured') {
    input.reasons.add('evidence_authentication_unconfigured');
  } else if (
    !TRUSTED_CAPABILITY_MATURITY_AUTHORITIES_.some(
      (authority) =>
        authority.authorityIdentity === authentication.authorityIdentity &&
        authority.verifierIdentity === authentication.verifierIdentity &&
        authority.capabilities.includes(material.identity.capability) &&
        authority.subjectDigest === authentication.subjectDigest &&
        authority.attestationDigest === authentication.attestationDigest &&
        authority.verificationReceiptDigest === authentication.verificationReceiptDigest &&
        authority.verifiedAt === authentication.verifiedAt,
    )
  ) {
    input.reasons.add('evidence_authority_untrusted');
  }
  if (observation.evidenceClass !== 'production_observation') {
    input.reasons.add('real_observation_missing');
  }

  const expectedPrevious: Record<CapabilityMaturityStage, CapabilityMaturityStage | null> = {
    canary: null,
    beta: 'canary',
    stable: 'beta',
  };
  const requiredPrevious = expectedPrevious[input.targetStage];
  if (requiredPrevious === null) {
    if (previousDecision !== null) input.reasons.add('canary_must_start_new_decision_chain');
  } else if (!previousDecision) {
    input.reasons.add(`previous_${requiredPrevious}_decision_missing`);
  } else {
    if (previousDecision.stage !== requiredPrevious)
      input.reasons.add('maturity_stage_skip_detected');
    if (previousDecision.decisionId === material.decisionId)
      input.reasons.add('decision_id_reused');
    if (previousDecision.windowId === material.windowId)
      input.reasons.add('observation_window_id_reused');
    compareIdentity(previousDecision.identity, input.expectedIdentity, 'previous', input.reasons);
    if (
      !VERIFIED_CAPABILITY_MATURITY_PREVIOUS_DECISIONS_.includes(previousDecision.decisionDigest)
    ) {
      input.reasons.add('verified_previous_maturity_decision_not_configured');
    }
  }

  const registeredAt = parseTimestamp(preregistration.registeredAt, 'Registration time');
  const windowStartsAt = parseTimestamp(preregistration.windowStartsAt, 'Window start');
  const windowEndsAt = parseTimestamp(preregistration.windowEndsAt, 'Window end');
  const observedStartsAt = parseTimestamp(observation.startedAt, 'Observation start');
  const observedEndsAt = parseTimestamp(observation.endedAt, 'Observation end');
  if (
    previousDecision &&
    parseTimestamp(previousDecision.decidedAt, 'Previous decision time') >= registeredAt
  ) {
    input.reasons.add('previous_decision_not_before_current_registration');
  }
  if (registeredAt >= windowStartsAt) input.reasons.add('window_not_preregistered_before_start');
  if (windowEndsAt <= windowStartsAt) input.reasons.add('preregistered_window_invalid');
  if (
    observedStartsAt < windowStartsAt ||
    observedEndsAt > windowEndsAt ||
    observedEndsAt <= observedStartsAt
  ) {
    input.reasons.add('observation_outside_preregistered_window');
  }
  if ((observedEndsAt - observedStartsAt) / 1_000 < preregistration.minimumWindowSeconds) {
    input.reasons.add('observation_window_too_short');
  }
  if (observation.sampleCount < preregistration.minimumSamples)
    input.reasons.add('sample_count_below_preregistered_minimum');
  if (observation.errorCount > observation.sampleCount)
    input.reasons.add('error_count_exceeds_samples');
  const rebuiltErrorBps = ratioBps(observation.errorCount, observation.sampleCount);
  if (observation.errorBudgetConsumedBps !== rebuiltErrorBps)
    input.reasons.add('error_budget_rate_mismatch');
  if (rebuiltErrorBps > preregistration.maximumErrorBudgetBps)
    input.reasons.add('error_budget_exceeded');

  for (const gate of ['G3', 'G4', 'G5'] as const) {
    if (observation.gates[gate] !== 'passed') input.reasons.add(`${gate.toLowerCase()}_not_passed`);
  }

  const approvalIds = new Set(observation.humanApprovals.map(({ approvalId }) => approvalId));
  const approvers = new Set(
    observation.humanApprovals.map(({ approverIdentity }) => approverIdentity),
  );
  if (
    approvalIds.size !== observation.humanApprovals.length ||
    approvers.size !== observation.humanApprovals.length
  ) {
    input.reasons.add('human_approval_not_unique');
  }
  if (approvers.size < preregistration.requiredHumanApprovalCount)
    input.reasons.add('human_approval_count_below_preregistered_minimum');
  if (
    observation.humanApprovals.some(
      ({ recordDigest }) =>
        !VERIFIED_CAPABILITY_MATURITY_MAINTAINER_APPROVALS_.includes(recordDigest),
    )
  ) {
    input.reasons.add('verified_maintainer_approval_not_configured');
  }
  if (
    observation.humanApprovals.some(
      ({ approvedAt }) => parseTimestamp(approvedAt, 'Approval time') < observedEndsAt,
    )
  ) {
    input.reasons.add('human_approval_precedes_observation_completion');
  }
  if (
    observation.humanApprovals.some(
      ({ approvedAt }) => parseTimestamp(approvedAt, 'Approval time') > input.evaluatedAtMs,
    )
  ) {
    input.reasons.add('human_approval_time_in_future');
  }

  const understanding = observation.userUnderstanding;
  if (understanding.understoodCount > understanding.responseCount)
    input.reasons.add('user_understanding_count_invalid');
  const rebuiltUnderstandingBps = ratioBps(
    understanding.understoodCount,
    understanding.responseCount,
  );
  if (understanding.understandingBps !== rebuiltUnderstandingBps)
    input.reasons.add('user_understanding_rate_mismatch');
  if (understanding.responseCount < preregistration.minimumUserUnderstandingSamples)
    input.reasons.add('user_understanding_sample_count_below_minimum');
  if (rebuiltUnderstandingBps < preregistration.minimumUserUnderstandingBps)
    input.reasons.add('user_understanding_below_preregistered_minimum');

  if (observation.rollback.status !== 'passed') input.reasons.add('rollback_rehearsal_not_passed');
  const rehearsedAt = parseTimestamp(observation.rollback.rehearsedAt, 'Rollback rehearsal time');
  if (rehearsedAt < observedEndsAt)
    input.reasons.add('rollback_rehearsal_precedes_observation_completion');

  if (input.evaluatedAtMs < observedEndsAt)
    input.reasons.add('evaluation_precedes_observation_completion');
  if ((input.evaluatedAtMs - observedEndsAt) / 1_000 > preregistration.freshnessSeconds) {
    input.reasons.add('maturity_evidence_stale');
  }
  if (authentication.kind === 'github_oidc_sigstore_v1') {
    const verifiedAt = parseTimestamp(
      authentication.verifiedAt,
      'Authentication verification time',
    );
    if (verifiedAt < observedEndsAt || verifiedAt > input.evaluatedAtMs) {
      input.reasons.add('authentication_time_invalid');
    }
  }
}

function compareIdentity(
  actual: CapabilityMaturityIdentity,
  expected: CapabilityMaturityIdentity,
  prefix: string,
  reasons: Set<string>,
): void {
  for (const field of [
    'payloadDigest',
    'profileDigest',
    'routeDigest',
    'platformIdentity',
    'capability',
    'capabilityContractDigest',
  ] as const) {
    if (actual[field] !== expected[field]) reasons.add(`${prefix}_identity_mismatch:${field}`);
  }
  for (const field of ['evaluatorId', 'evaluatorDigest', 'suiteDigest'] as const) {
    if (actual.evaluatorIdentity[field] !== expected.evaluatorIdentity[field]) {
      reasons.add(`${prefix}_identity_mismatch:evaluator.${field}`);
    }
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be ISO-8601.`);
  return parsed;
}

function ratioBps(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.ceil((numerator * 10_000) / denominator);
}

export type { ReleaseCapability };
