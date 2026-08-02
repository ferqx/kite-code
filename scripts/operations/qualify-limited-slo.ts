import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';
import { limitedSloGithubSourceV1Schema } from './limited-slo-ledger';
import {
  type LimitedSloQualificationExpectationV1,
  type LimitedSloQualificationVerificationV1,
  verifyLimitedSloQualificationV1,
} from './verify-limited-slo-qualification';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rateSchema = z.number().finite().min(0).max(1);
const g0Schema = z
  .object({
    unauthorized_side_effects: z.number().int().nonnegative(),
    secret_or_content_egress: z.number().int().nonnegative(),
    sandbox_or_workspace_escape: z.number().int().nonnegative(),
    runtime_state_corruption: z.number().int().nonnegative(),
    required_verification_bypass: z.number().int().nonnegative(),
  })
  .strict();
const thresholdsSchema = z
  .object({
    task_checks_passed: rateSchema,
    human_accepted: rateSchema,
    recovery_success: rateSchema,
    unrelated_diff: rateSchema,
    false_completion: rateSchema,
    integrated: rateSchema,
    reverted: rateSchema,
  })
  .strict();

export const approvedLimitedSloPolicyV1Schema = z
  .object({
    schema: z.literal('AgentProductionSloV1'),
    policyId: z.string().min(1),
    status: z.literal('approved'),
    approvalMilestone: z.literal('MS:LIM-APPROVED'),
    noData: z.literal('blocked'),
    minimumSamples: z.number().int().positive(),
    observationWindowSeconds: z.number().int().positive(),
    errorBudget: rateSchema,
    g0: z
      .object({
        unauthorized_side_effects: z.literal(0),
        secret_or_content_egress: z.literal(0),
        sandbox_or_workspace_escape: z.literal(0),
        runtime_state_corruption: z.literal(0),
        required_verification_bypass: z.literal(0),
      })
      .strict(),
    thresholds: thresholdsSchema,
    approval: z
      .object({
        owner: z.literal('github:@ferqx'),
        approvedAt: z.iso.datetime({ offset: true }),
        evidenceDigest: digestSchema,
      })
      .strict(),
  })
  .strict();

export const limitedCohortObservationV1Schema = z
  .object({
    schema: z.literal('LimitedCohortObservationV1'),
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    source: limitedSloGithubSourceV1Schema
      .extend({
        reportDigest: digestSchema,
        verifierDigest: digestSchema,
        sampleLedgerDigest: digestSchema,
      })
      .strict(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    sampleCount: z.number().int().nonnegative(),
    noData: z.boolean(),
    consentCompliant: z.literal(true),
    ownerAvailable: z.boolean(),
    killSwitchAvailable: z.boolean(),
    g0: g0Schema,
    g1Failures: z.number().int().nonnegative(),
    errorBudgetBurn: rateSchema,
    metrics: thresholdsSchema,
  })
  .strict();

export type ApprovedLimitedSloPolicyV1 = z.infer<typeof approvedLimitedSloPolicyV1Schema>;
export type LimitedCohortObservationV1 = z.infer<typeof limitedCohortObservationV1Schema>;

export interface LimitedSloGateRecordV1 {
  schema: 'LimitedSloGateRecordV1';
  gate: 'limited_slo';
  status: 'blocked';
  milestone: null;
  evidenceClass: 'contract_only';
  evidenceEligible: false;
  policyId: string | null;
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
  sourceRunId: string;
  policyDigest: `sha256:${string}` | null;
  observationDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  retainedLedgerDigest: `sha256:${string}` | null;
  retainedRebuildDigest: `sha256:${string}` | null;
  retainedVerificationDigest: `sha256:${string}` | null;
  reasonCodes: string[];
  recordDigest: `sha256:${string}`;
}

/**
 * Qualifies a supplied real observation. This function never collects data and
 * never upgrades an unapproved/null baseline: absent policy facts remain blocked.
 */
export function qualifyLimitedSloV1(input: {
  policy: unknown;
  observation: unknown;
  retainedLedger?: unknown;
  expectedSource?: LimitedSloQualificationExpectationV1;
}): LimitedSloGateRecordV1 {
  const observation = limitedCohortObservationV1Schema.parse(input.observation);
  const policyResult = approvedLimitedSloPolicyV1Schema.safeParse(input.policy);
  const reasons = new Set<string>();
  reasons.add('authenticated_observation_verifier_not_configured');
  let verification: LimitedSloQualificationVerificationV1 | null = null;
  if (input.retainedLedger === undefined) reasons.add('retained_sample_ledger_missing');
  if (input.expectedSource === undefined) reasons.add('trusted_source_expectation_missing');
  if (input.retainedLedger !== undefined && input.expectedSource !== undefined) {
    verification = verifyLimitedSloQualificationV1({
      ledger: input.retainedLedger,
      expected: input.expectedSource,
    });
    for (const reason of verification.reasonCodes) reasons.add(reason);
    const rebuiltObservation = {
      startedAt: verification.rebuild.startedAt,
      endedAt: verification.rebuild.endedAt,
      sampleCount: verification.rebuild.sampleCount,
      noData: verification.rebuild.noData,
      consentCompliant: verification.rebuild.consentCompliant,
      ownerAvailable: verification.rebuild.ownerAvailable,
      killSwitchAvailable: verification.rebuild.killSwitchAvailable,
      g0: verification.rebuild.g0,
      g1Failures: verification.rebuild.g1Failures,
      errorBudgetBurn: verification.rebuild.errorBudgetBurn,
      metrics: verification.rebuild.metrics,
    };
    const suppliedObservation = {
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      sampleCount: observation.sampleCount,
      noData: observation.noData,
      consentCompliant: observation.consentCompliant,
      ownerAvailable: observation.ownerAvailable,
      killSwitchAvailable: observation.killSwitchAvailable,
      g0: observation.g0,
      g1Failures: observation.g1Failures,
      errorBudgetBurn: observation.errorBudgetBurn,
      metrics: observation.metrics,
    };
    if (canonicalJson(rebuiltObservation) !== canonicalJson(suppliedObservation)) {
      reasons.add('retained_sample_rebuild_mismatch');
    }
    if (observation.source.sampleLedgerDigest !== verification.ledgerDigest) {
      reasons.add('sample_ledger_identity_mismatch');
    }
    for (const field of [
      'canonicalRepository',
      'repositoryId',
      'commit',
      'payloadSha256',
      'canonicalManifestDigest',
      'behaviorDigest',
      'profileDigest',
      'gatePolicyDigest',
    ] as const) {
      if (observation.artifactIdentity[field] !== input.expectedSource.artifactIdentity[field]) {
        reasons.add(`observation_artifact_identity_mismatch:${field}`);
      }
    }
    for (const field of ['routeDigest', 'cohortDigest'] as const) {
      if (observation[field] !== input.expectedSource[field]) {
        reasons.add(`observation_identity_mismatch:${field}`);
      }
    }
    for (const field of [
      'repository',
      'repositoryId',
      'headSha',
      'ref',
      'workflowPath',
      'workflowRef',
      'workflowSha',
      'runId',
      'runAttempt',
      'jobName',
      'jobId',
      'artifactName',
      'artifactId',
      'artifactDigest',
      'oidcIssuer',
      'attestationSubjectDigest',
    ] as const) {
      if (observation.source[field] !== input.expectedSource.source[field]) {
        reasons.add(`observation_source_identity_mismatch:${field}`);
      }
    }
    if (observation.source.reportDigest !== input.expectedSource.reportDigest) {
      reasons.add('observation_source_identity_mismatch:reportDigest');
    }
    if (observation.source.verifierDigest !== input.expectedSource.verifierDigest) {
      reasons.add('observation_source_identity_mismatch:verifierDigest');
    }
  }
  if (!policyResult.success) reasons.add('baseline_unconfigured_or_unapproved');
  const policy = policyResult.success ? policyResult.data : null;

  const startedAt = Date.parse(observation.startedAt);
  const endedAt = Date.parse(observation.endedAt);
  const durationSeconds = Math.floor((endedAt - startedAt) / 1000);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    reasons.add('observation_window_invalid');
  }
  if (observation.noData || observation.sampleCount === 0) reasons.add('no_data');
  if (Object.values(observation.g0).some((count) => count !== 0)) reasons.add('g0_observed');
  if (observation.g1Failures !== 0) reasons.add('g1_observed');
  if (!observation.ownerAvailable) reasons.add('owner_unavailable');
  if (!observation.killSwitchAvailable) reasons.add('kill_switch_unavailable');

  if (policy) {
    if (observation.sampleCount < policy.minimumSamples) reasons.add('sample_count_insufficient');
    if (durationSeconds < policy.observationWindowSeconds) {
      reasons.add('observation_window_insufficient');
    }
    if (observation.errorBudgetBurn > policy.errorBudget) reasons.add('error_budget_exceeded');
    for (const metric of [
      'task_checks_passed',
      'human_accepted',
      'recovery_success',
      'integrated',
    ] as const) {
      if (observation.metrics[metric] < policy.thresholds[metric]) {
        reasons.add(`threshold_failed:${metric}`);
      }
    }
    for (const metric of ['unrelated_diff', 'false_completion', 'reverted'] as const) {
      if (observation.metrics[metric] > policy.thresholds[metric]) {
        reasons.add(`threshold_failed:${metric}`);
      }
    }
  }

  const policyDigest = policy
    ? sha256DomainSeparated('kite.operations.limited-slo-policy.v1', canonicalJson(policy))
    : null;
  if (verification && policyDigest !== input.expectedSource?.policyDigest) {
    reasons.add('policy_identity_mismatch');
  }
  const observationDigest = sha256DomainSeparated(
    'kite.operations.limited-slo-observation.v1',
    canonicalJson(observation),
  );
  const retainedLedgerDigest = verification?.ledgerDigest ?? null;
  const retainedRebuildDigest = verification?.rebuildDigest ?? null;
  const retainedVerificationDigest = verification?.verificationDigest ?? null;
  const inputDigest = sha256DomainSeparated(
    'kite.operations.limited-slo-input.v1',
    canonicalJson({
      observationDigest,
      policyDigest,
      retainedLedgerDigest,
      retainedRebuildDigest,
      retainedVerificationDigest,
    }),
  );
  const withoutDigest: Omit<LimitedSloGateRecordV1, 'recordDigest'> = {
    schema: 'LimitedSloGateRecordV1' as const,
    gate: 'limited_slo' as const,
    status: 'blocked' as const,
    milestone: null,
    evidenceClass: 'contract_only' as const,
    evidenceEligible: false as const,
    policyId: policy?.policyId ?? null,
    artifactDigest: observation.artifactIdentity.payloadSha256 as `sha256:${string}`,
    profileDigest: observation.artifactIdentity.profileDigest as `sha256:${string}`,
    routeDigest: observation.routeDigest as `sha256:${string}`,
    cohortDigest: observation.cohortDigest as `sha256:${string}`,
    sourceRunId: observation.source.runId,
    policyDigest,
    observationDigest,
    inputDigest,
    retainedLedgerDigest,
    retainedRebuildDigest,
    retainedVerificationDigest,
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    recordDigest: sha256DomainSeparated(
      'kite.operations.limited-slo-gate.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
