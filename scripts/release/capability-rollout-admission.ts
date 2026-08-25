import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const ROLLOUT_CAPABILITIES_ = Object.freeze([
  'verification',
  'mcp_write',
  'skills_readonly',
  'skills_effectful',
  'manual_compaction',
] as const);
export type RolloutCapability = (typeof ROLLOUT_CAPABILITIES_)[number];

export const ROLLOUT_STAGES_ = Object.freeze(['internal', 'external_canary'] as const);
export type RolloutStage = (typeof ROLLOUT_STAGES_)[number];

const COMMON_INTERNAL_DEPENDENCIES = ['evaluation', 'operations_dashboard', 'kill_switch'] as const;
const COMMON_EXTERNAL_DEPENDENCIES = [
  'internal_rollout',
  'limited_approved',
  'limited_slo',
  'telemetry_consent',
  'provider_data_policy',
  'incident_rehearsal',
] as const;

const CAPABILITY_DEPENDENCIES: Readonly<Record<RolloutCapability, readonly string[]>> =
  Object.freeze({
    verification: [...COMMON_INTERNAL_DEPENDENCIES],
    mcp_write: [
      ...COMMON_INTERNAL_DEPENDENCIES,
      'verification_stable',
      'write_route_qualified',
      'write_recovery_conformance',
    ],
    skills_readonly: [
      ...COMMON_INTERNAL_DEPENDENCIES,
      'readonly_effect_classification',
      'skill_workflow_conformance',
    ],
    skills_effectful: [
      ...COMMON_INTERNAL_DEPENDENCIES,
      'verification_stable',
      'skills_readonly_stable',
      'effectful_skill_conformance',
      'high_risk_cohort_exclusivity',
    ],
    manual_compaction: [
      ...COMMON_INTERNAL_DEPENDENCIES,
      'route_qualification',
      'semantic_evaluation',
      'continuation_non_inferiority',
    ],
  });

const rolloutIdentitySchema = z
  .object({
    artifactDigest: digestSchema,
    profileDigest: digestSchema,
    routeDigest: digestSchema,
    platformDigest: digestSchema,
    cohortDigest: digestSchema,
    capabilityContractDigest: digestSchema,
  })
  .strict();

const dependencyDecisionSchema = rolloutIdentitySchema
  .extend({
    schema: z.literal('CapabilityRolloutDependencyDecision'),
    dependency: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
    status: z.literal('passed'),
    verifiedAt: timestampSchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    decisionDigest: digestSchema,
  })
  .strict();

export const capabilityRolloutAdmissionInputSchema = z
  .object({
    schema: z.literal('CapabilityRolloutAdmissionInput'),
    capability: z.enum(ROLLOUT_CAPABILITIES_),
    stage: z.enum(ROLLOUT_STAGES_),
    identity: rolloutIdentitySchema,
    dependencies: z.array(dependencyDecisionSchema).max(64),
    safety: z
      .object({
        g0Count: z.number().int().nonnegative(),
        g1Count: z.number().int().nonnegative(),
        duplicateOrUnauthorizedEffectCount: z.number().int().nonnegative(),
        verificationBypassCount: z.number().int().nonnegative(),
        retainedLedgerDigest: digestSchema,
      })
      .strict(),
  })
  .strict();

export type CapabilityRolloutAdmissionInput = z.infer<typeof capabilityRolloutAdmissionInputSchema>;

export interface CapabilityRolloutAdmissionDecision {
  schema: 'CapabilityRolloutAdmissionDecision';
  capability: RolloutCapability;
  requestedStage: RolloutStage;
  status: 'blocked';
  admissionEligible: false;
  effectiveRollout: 'off';
  cohortPercent: 0;
  identity: z.infer<typeof rolloutIdentitySchema>;
  dependencyDecisionDigests: `sha256:${string}`[];
  reasonCodes: string[];
  decisionDigest: `sha256:${string}`;
}

export function requiredRolloutDependencies(
  capability: RolloutCapability,
  stage: RolloutStage,
): readonly string[] {
  const capabilityDependencies = CAPABILITY_DEPENDENCIES[capability];
  return stage === 'internal'
    ? capabilityDependencies
    : [...capabilityDependencies, ...COMMON_EXTERNAL_DEPENDENCIES];
}

/**
 * Admission-only Gate. It never changes a profile, expands a cohort, or trusts
 * caller-authored dependency summaries as production authority.
 */
export function evaluateCapabilityRolloutAdmission(
  rawInput: unknown,
): CapabilityRolloutAdmissionDecision {
  const input = capabilityRolloutAdmissionInputSchema.parse(rawInput);
  const reasons = new Set<string>(['authenticated_rollout_authority_not_configured']);
  const decisions = new Map<string, (typeof input.dependencies)[number]>();

  for (const dependency of input.dependencies) {
    if (decisions.has(dependency.dependency)) {
      throw new Error(`Capability rollout dependency ${dependency.dependency} is duplicated.`);
    }
    decisions.set(dependency.dependency, dependency);
    for (const field of [
      'artifactDigest',
      'profileDigest',
      'routeDigest',
      'platformDigest',
      'cohortDigest',
      'capabilityContractDigest',
    ] as const) {
      if (dependency[field] !== input.identity[field]) {
        reasons.add(`dependency_identity_mismatch:${dependency.dependency}:${field}`);
      }
    }
  }

  for (const dependency of requiredRolloutDependencies(input.capability, input.stage)) {
    if (!decisions.has(dependency)) reasons.add(`dependency_missing:${dependency}`);
  }
  if (input.safety.g0Count > 0) reasons.add('g0_observed');
  if (input.safety.g1Count > 0) reasons.add('g1_observed');
  if (input.safety.duplicateOrUnauthorizedEffectCount > 0) {
    reasons.add('duplicate_or_unauthorized_effect_observed');
  }
  if (input.safety.verificationBypassCount > 0) reasons.add('verification_bypass_observed');

  const withoutDigest: Omit<CapabilityRolloutAdmissionDecision, 'decisionDigest'> = {
    schema: 'CapabilityRolloutAdmissionDecision',
    capability: input.capability,
    requestedStage: input.stage,
    status: 'blocked',
    admissionEligible: false,
    effectiveRollout: 'off',
    cohortPercent: 0,
    identity: input.identity,
    dependencyDecisionDigests: input.dependencies
      .map((dependency) => dependency.decisionDigest as `sha256:${string}`)
      .sort(),
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    decisionDigest: sha256DomainSeparated(
      'kite.release.capability-rollout-admission.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
