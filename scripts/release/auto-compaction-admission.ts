import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const AUTO_COMPACTION_DEPENDENCIES_ = [
  'manual_stable',
  'internal_auto_fresh',
  'limited_approved',
  'limited_slo',
  'external_shadow',
  'owner_approval',
  'kill_switch',
  'consent_provider_policy',
  'incident_rehearsal',
] as const;
type AutoCompactionDependency = (typeof AUTO_COMPACTION_DEPENDENCIES_)[number];

interface TrustedAutoCompactionVerifier {
  dependency: AutoCompactionDependency;
  verifierIdentity: string;
  decisionDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
  verifiedAt: string;
}

const TRUSTED_AUTO_COMPACTION_VERIFIERS_: readonly TrustedAutoCompactionVerifier[] = Object.freeze(
  [],
);

interface TrustedAutoCompactionSafetyObservation {
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
  g0Count: 0;
  g1Count: 0;
  ledgerDigest: `sha256:${string}`;
}

const TRUSTED_AUTO_COMPACTION_SAFETY_OBSERVATIONS_: readonly TrustedAutoCompactionSafetyObservation[] =
  Object.freeze([]);

export const autoCompactionAdmissionInputSchema = z
  .object({
    schema: z.literal('AutoCompactionAdmissionInput'),
    artifactDigest: digestSchema,
    profileDigest: digestSchema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    dependencies: z.array(
      z
        .object({
          schema: z.literal('AutoCompactionDependencyDecision'),
          dependency: z.enum(AUTO_COMPACTION_DEPENDENCIES_),
          status: z.literal('passed'),
          artifactDigest: digestSchema,
          profileDigest: digestSchema,
          routeDigest: digestSchema,
          cohortDigest: digestSchema,
          verifiedAt: z.iso.datetime({ offset: true }),
          verifierIdentity: z.string().min(1).max(256),
          decisionDigest: digestSchema,
        })
        .strict(),
    ),
    safetyObservation: z
      .object({
        g0Count: z.number().int().nonnegative(),
        g1Count: z.number().int().nonnegative(),
        ledgerDigest: digestSchema,
      })
      .strict(),
  })
  .strict();

export interface AutoCompactionAdmissionDecision {
  schema: 'AutoCompactionAdmissionDecision';
  status: 'passed' | 'blocked';
  liveAdmissionEligible: boolean;
  summaryDispatches: 0;
  checkpointWrites: 0;
  profileDiff: {
    capability: 'auto_compaction';
    maxRollout: 'off' | 'canary';
    cohortMaximum: 0 | 1;
  };
  reasonCodes: string[];
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
  dependencyDecisionDigests: `sha256:${string}`[];
  safetyLedgerDigest: `sha256:${string}`;
  decisionDigest: `sha256:${string}`;
}

/** Admission-only Gate: it never invokes a model and never writes a checkpoint. */
export function evaluateAutoCompactionAdmission(
  rawInput: unknown,
): AutoCompactionAdmissionDecision {
  const input = autoCompactionAdmissionInputSchema.parse(rawInput);
  const reasons: string[] = [];
  if (TRUSTED_AUTO_COMPACTION_VERIFIERS_.length === 0) {
    reasons.push('authenticated_auto_compaction_verifier_not_configured');
  }
  const trustedSafetyObservation = TRUSTED_AUTO_COMPACTION_SAFETY_OBSERVATIONS_.some(
    (trusted) =>
      trusted.artifactDigest === input.artifactDigest &&
      trusted.profileDigest === input.profileDigest &&
      trusted.routeDigest === input.routeDigest &&
      trusted.cohortDigest === input.cohortDigest &&
      trusted.g0Count === input.safetyObservation.g0Count &&
      trusted.g1Count === input.safetyObservation.g1Count &&
      trusted.ledgerDigest === input.safetyObservation.ledgerDigest,
  );
  if (!trustedSafetyObservation) {
    reasons.push('authenticated_auto_compaction_safety_observation_not_configured');
  }
  const decisions = new Map<string, (typeof input.dependencies)[number]>();
  for (const dependency of input.dependencies) {
    if (decisions.has(dependency.dependency)) {
      throw new Error(`Auto-compaction dependency ${dependency.dependency} is duplicated.`);
    }
    decisions.set(dependency.dependency, dependency);
    if (
      TRUSTED_AUTO_COMPACTION_VERIFIERS_.length > 0 &&
      !TRUSTED_AUTO_COMPACTION_VERIFIERS_.some(
        (trusted) =>
          trusted.dependency === dependency.dependency &&
          trusted.verifierIdentity === dependency.verifierIdentity &&
          trusted.decisionDigest === dependency.decisionDigest &&
          trusted.artifactDigest === dependency.artifactDigest &&
          trusted.profileDigest === dependency.profileDigest &&
          trusted.routeDigest === dependency.routeDigest &&
          trusted.cohortDigest === dependency.cohortDigest &&
          trusted.verifiedAt === dependency.verifiedAt,
      )
    ) {
      reasons.push(`dependency_verifier_untrusted:${dependency.dependency}`);
    }
    if (
      dependency.artifactDigest !== input.artifactDigest ||
      dependency.profileDigest !== input.profileDigest ||
      dependency.routeDigest !== input.routeDigest ||
      dependency.cohortDigest !== input.cohortDigest
    ) {
      reasons.push(`dependency_identity_mismatch:${dependency.dependency}`);
    }
  }
  const missingReason: Record<(typeof AUTO_COMPACTION_DEPENDENCIES_)[number], string> = {
    manual_stable: 'ms_manual_stable_missing',
    internal_auto_fresh: 'ms_internal_auto_fresh_missing',
    limited_approved: 'ms_limited_approved_missing',
    limited_slo: 'ms_limited_slo_missing',
    external_shadow: 'external_shadow_missing',
    owner_approval: 'owner_approval_missing',
    kill_switch: 'kill_switch_unavailable',
    consent_provider_policy: 'consent_or_provider_policy_invalid',
    incident_rehearsal: 'incident_rehearsal_missing',
  };
  for (const dependency of AUTO_COMPACTION_DEPENDENCIES_) {
    if (!decisions.has(dependency)) reasons.push(missingReason[dependency]);
  }
  if (input.safetyObservation.g0Count !== 0) reasons.push('g0_observed');
  if (input.safetyObservation.g1Count !== 0) reasons.push('g1_observed');
  reasons.sort();
  const status: AutoCompactionAdmissionDecision['status'] =
    reasons.length === 0 ? 'passed' : 'blocked';
  const withoutDigest: Omit<AutoCompactionAdmissionDecision, 'decisionDigest'> = {
    schema: 'AutoCompactionAdmissionDecision',
    status,
    liveAdmissionEligible: status === 'passed',
    summaryDispatches: 0,
    checkpointWrites: 0,
    profileDiff: {
      capability: 'auto_compaction',
      maxRollout: status === 'passed' ? 'canary' : 'off',
      cohortMaximum: status === 'passed' ? 1 : 0,
    },
    reasonCodes: reasons,
    artifactDigest: input.artifactDigest as `sha256:${string}`,
    profileDigest: input.profileDigest as `sha256:${string}`,
    routeDigest: input.routeDigest as `sha256:${string}`,
    cohortDigest: input.cohortDigest as `sha256:${string}`,
    dependencyDecisionDigests: input.dependencies
      .map((dependency) => dependency.decisionDigest as `sha256:${string}`)
      .sort(),
    safetyLedgerDigest: input.safetyObservation.ledgerDigest as `sha256:${string}`,
  };
  return {
    ...withoutDigest,
    decisionDigest: sha256DomainSeparated(
      'kite.release.auto-compaction-admission.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
