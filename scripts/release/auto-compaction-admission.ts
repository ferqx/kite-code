import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const autoCompactionAdmissionInputV1Schema = z
  .object({
    schema: z.literal('AutoCompactionAdmissionInputV1'),
    artifactDigest: digestSchema,
    profileDigest: digestSchema,
    routeQualificationDigest: digestSchema,
    internalAutoEvidenceDigest: digestSchema,
    manualStableDecisionDigest: digestSchema,
    limitedSloEvidenceDigest: digestSchema,
    incidentRehearsalDigest: digestSchema,
    dependencies: z
      .object({
        msManualStable: z.boolean(),
        msInternalAutoFresh: z.boolean(),
        msLimitedApproved: z.boolean(),
        msLimitedSlo: z.boolean(),
        externalShadowPassed: z.boolean(),
        ownerApprovalValid: z.boolean(),
        killSwitchAvailable: z.boolean(),
        consentAndProviderPolicyValid: z.boolean(),
        g0Count: z.number().int().nonnegative(),
        g1Count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export interface AutoCompactionAdmissionDecisionV1 {
  schema: 'AutoCompactionAdmissionDecisionV1';
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
  routeQualificationDigest: `sha256:${string}`;
  decisionDigest: `sha256:${string}`;
}

/** Admission-only Gate: it never invokes a model and never writes a checkpoint. */
export function evaluateAutoCompactionAdmissionV1(
  rawInput: unknown,
): AutoCompactionAdmissionDecisionV1 {
  const input = autoCompactionAdmissionInputV1Schema.parse(rawInput);
  const reasons: string[] = [];
  const required = [
    ['ms_manual_stable_missing', input.dependencies.msManualStable],
    ['ms_internal_auto_fresh_missing', input.dependencies.msInternalAutoFresh],
    ['ms_limited_approved_missing', input.dependencies.msLimitedApproved],
    ['ms_limited_slo_missing', input.dependencies.msLimitedSlo],
    ['external_shadow_missing', input.dependencies.externalShadowPassed],
    ['owner_approval_missing', input.dependencies.ownerApprovalValid],
    ['kill_switch_unavailable', input.dependencies.killSwitchAvailable],
    ['consent_or_provider_policy_invalid', input.dependencies.consentAndProviderPolicyValid],
  ] as const;
  for (const [reason, present] of required) if (!present) reasons.push(reason);
  if (input.dependencies.g0Count !== 0) reasons.push('g0_observed');
  if (input.dependencies.g1Count !== 0) reasons.push('g1_observed');
  reasons.sort();
  const status: AutoCompactionAdmissionDecisionV1['status'] =
    reasons.length === 0 ? 'passed' : 'blocked';
  const withoutDigest: Omit<AutoCompactionAdmissionDecisionV1, 'decisionDigest'> = {
    schema: 'AutoCompactionAdmissionDecisionV1',
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
    routeQualificationDigest: input.routeQualificationDigest as `sha256:${string}`,
  };
  return {
    ...withoutDigest,
    decisionDigest: sha256DomainSeparated(
      'kite.release.auto-compaction-admission.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
