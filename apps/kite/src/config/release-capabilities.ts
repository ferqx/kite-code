import { z } from 'zod';
import { type FeatureFlagName, isFeatureFlagName } from './features';

/** Stable release-governance capability identifiers. Do not reorder or rename. */
export const RELEASE_CAPABILITIES = Object.freeze([
  'builtin_read_tools',
  'builtin_write_tools',
  'shell',
  'plan',
  'tool_search',
  'mcp_read',
  'mcp_write',
  'skills_readonly',
  'skills_effectful',
  'verification',
  'manual_compaction',
  'auto_compaction',
  'full_interaction_mode',
  'content_session_logging',
  'remote_telemetry',
] as const);

export const CAPABILITY_MATURITIES = Object.freeze([
  'under_development',
  'experimental',
  'beta',
  'stable',
] as const);

export const ROLLOUT_STAGES = Object.freeze(['off', 'internal', 'canary', 'general'] as const);

export const releaseCapabilitySchema = z.enum(RELEASE_CAPABILITIES);
export const capabilityMaturitySchema = z.enum(CAPABILITY_MATURITIES);
export const rolloutStageSchema = z.enum(ROLLOUT_STAGES);

export type ReleaseCapability = z.infer<typeof releaseCapabilitySchema>;
export type CapabilityMaturity = z.infer<typeof capabilityMaturitySchema>;
export type RolloutStage = z.infer<typeof rolloutStageSchema>;

export const CAPABILITY_MATURITY_RANK: Readonly<Record<CapabilityMaturity, number>> = Object.freeze(
  {
    under_development: 0,
    experimental: 1,
    beta: 2,
    stable: 3,
  },
);

export const ROLLOUT_STAGE_RANK: Readonly<Record<RolloutStage, number>> = Object.freeze({
  off: 0,
  internal: 1,
  canary: 2,
  general: 3,
});

const MAX_ROLLOUT_BY_MATURITY: Readonly<Record<CapabilityMaturity, RolloutStage>> = Object.freeze({
  under_development: 'off',
  experimental: 'canary',
  beta: 'general',
  stable: 'general',
});

/** Maturity and rollout are orthogonal, but not every pair is releasable. */
export function isCapabilityReleaseStateValid(
  maturity: CapabilityMaturity,
  maxRollout: RolloutStage,
): boolean {
  return ROLLOUT_STAGE_RANK[maxRollout] <= ROLLOUT_STAGE_RANK[MAX_ROLLOUT_BY_MATURITY[maturity]];
}

export const capabilityReleaseStateSchema = z
  .object({
    maturity: capabilityMaturitySchema,
    maxRollout: rolloutStageSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (!isCapabilityReleaseStateValid(state.maturity, state.maxRollout)) {
      context.addIssue({
        code: 'custom',
        path: ['maxRollout'],
        message: `${state.maturity} capabilities cannot roll out to ${state.maxRollout}`,
      });
    }
  });

export type CapabilityReleaseState = z.infer<typeof capabilityReleaseStateSchema>;

export function parseCapabilityReleaseState(value: unknown): CapabilityReleaseState {
  return capabilityReleaseStateSchema.parse(value);
}

export const CAPABILITY_PROFILE_VERSION_ = 1 as const;
export const CAPABILITY_PROFILE_GATES_ = Object.freeze(['G3', 'G4', 'G5'] as const);

const capabilityProfileIdentitySchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value === value.trim(), 'identities must not contain surrounding whitespace');
const capabilityProfileSortedIdentityListSchema = z
  .array(capabilityProfileIdentitySchema)
  .max(64)
  .superRefine((values, context) => {
    const normalized = [...new Set(values)].sort(compareCapabilityIdentity);
    if (
      normalized.length !== values.length ||
      normalized.some((value, index) => value !== values[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'identity lists must be unique and sorted by code unit',
      });
    }
  });

const capabilityProfileDependencySchema = z
  .object({
    dependencyId: capabilityProfileIdentitySchema,
    expectedRevision: capabilityProfileIdentitySchema,
  })
  .strict();

/**
 * Capability-specific release ceiling. This is a contract, not evidence that
 * the capability has passed an internal, canary, beta, or stable Gate.
 */
export const capabilityProfileSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_PROFILE_VERSION_),
    profileId: capabilityProfileIdentitySchema,
    capability: releaseCapabilitySchema,
    requiredFeatureFlags: capabilityProfileSortedIdentityListSchema.min(1),
    state: capabilityReleaseStateSchema,
    dependencies: z.array(capabilityProfileDependencySchema).max(32),
    routeAllowlist: capabilityProfileSortedIdentityListSchema,
    platformAllowlist: capabilityProfileSortedIdentityListSchema,
    evidence: z
      .object({
        freshnessSeconds: z.number().finite().int().nonnegative(),
        requiredGates: z.tuple([
          z.literal(CAPABILITY_PROFILE_GATES_[0]),
          z.literal(CAPABILITY_PROFILE_GATES_[1]),
          z.literal(CAPABILITY_PROFILE_GATES_[2]),
        ]),
      })
      .strict(),
    rollback: z
      .object({
        disableNewAdmission: z.literal(true),
        preserveReceipts: z.literal(true),
        preserveRequiredVerification: z.literal(true),
        cohortPercent: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const dependencyIds = profile.dependencies.map(({ dependencyId }) => dependencyId);
    const sorted = [...new Set(dependencyIds)].sort(compareCapabilityIdentity);
    if (
      sorted.length !== dependencyIds.length ||
      sorted.some((dependencyId, index) => dependencyId !== dependencyIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'dependencies must be unique and sorted by dependencyId',
      });
    }
    if (profile.state.maxRollout !== 'off') {
      if (profile.platformAllowlist.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['platformAllowlist'],
          message: 'enabled capability profiles require an explicit platform allowlist',
        });
      }
      if (profile.evidence.freshnessSeconds === 0) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'freshnessSeconds'],
          message: 'enabled capability profiles require a non-zero evidence freshness window',
        });
      }
      if (profile.capability === 'mcp_write' && profile.routeAllowlist.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['routeAllowlist'],
          message: 'enabled MCP write profiles require an explicit route allowlist',
        });
      }
    }
    for (const [index, featureFlag] of profile.requiredFeatureFlags.entries()) {
      if (!isFeatureFlagName(featureFlag)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredFeatureFlags', index],
          message: `unknown feature flag ${featureFlag}`,
        });
      }
    }
  });

export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

export interface CapabilityProfileDependencyState {
  status: 'ready' | 'blocked';
  revision: string;
}

export type CapabilityProfileAdmissionReason =
  | 'dependency_blocked'
  | 'dependency_revision_mismatch'
  | 'dependency_unknown'
  | 'embedded_ceiling_off'
  | 'evidence_stale'
  | 'evidence_unknown'
  | 'feature_disabled'
  | 'feature_unknown'
  | 'maturity_exceeds_embedded_ceiling'
  | 'platform_not_admitted'
  | 'platform_unknown'
  | 'profile_rollout_off'
  | 'rollout_exceeds_embedded_ceiling'
  | 'required_gate_not_passed'
  | 'route_not_admitted'
  | 'route_unknown';

export interface CapabilityProfileAdmissionDecision {
  admitted: boolean;
  capability: ReleaseCapability;
  maturity: CapabilityMaturity;
  rollout: RolloutStage;
  reasons: readonly CapabilityProfileAdmissionReason[];
  unknownDependencies: readonly string[];
}

export function parseCapabilityProfile(value: unknown): CapabilityProfile {
  return capabilityProfileSchema.parse(value);
}

/**
 * Admission is a pure intersection with the already admitted embedded
 * ceiling. Missing dependency, platform, or route facts never become grants.
 */
export function evaluateCapabilityProfileAdmission(input: {
  profile: CapabilityProfile;
  embeddedCeiling: CapabilityReleaseState;
  features: Readonly<Partial<Record<FeatureFlagName, boolean>>>;
  dependencies: Readonly<Record<string, CapabilityProfileDependencyState | undefined>>;
  evidence?: {
    ageSeconds: number;
    gates: Readonly<
      Record<(typeof CAPABILITY_PROFILE_GATES_)[number], 'passed' | 'failed' | 'not_observed'>
    >;
  };
  platform?: string;
  route?: string;
}): CapabilityProfileAdmissionDecision {
  const profile = parseCapabilityProfile(input.profile);
  const ceiling = parseCapabilityReleaseState(input.embeddedCeiling);
  const reasons = new Set<CapabilityProfileAdmissionReason>();
  const unknownDependencies: string[] = [];

  for (const featureFlag of profile.requiredFeatureFlags as FeatureFlagName[]) {
    const enabled = input.features[featureFlag];
    if (enabled === undefined) reasons.add('feature_unknown');
    else if (!enabled) reasons.add('feature_disabled');
  }
  if (profile.state.maxRollout === 'off') reasons.add('profile_rollout_off');
  if (ceiling.maxRollout === 'off') reasons.add('embedded_ceiling_off');
  if (
    CAPABILITY_MATURITY_RANK[profile.state.maturity] > CAPABILITY_MATURITY_RANK[ceiling.maturity]
  ) {
    reasons.add('maturity_exceeds_embedded_ceiling');
  }
  if (ROLLOUT_STAGE_RANK[profile.state.maxRollout] > ROLLOUT_STAGE_RANK[ceiling.maxRollout]) {
    reasons.add('rollout_exceeds_embedded_ceiling');
  }
  if (profile.state.maxRollout !== 'off') {
    if (!input.evidence) reasons.add('evidence_unknown');
    else {
      if (
        !Number.isFinite(input.evidence.ageSeconds) ||
        input.evidence.ageSeconds < 0 ||
        input.evidence.ageSeconds > profile.evidence.freshnessSeconds
      ) {
        reasons.add('evidence_stale');
      }
      if (profile.evidence.requiredGates.some((gate) => input.evidence?.gates[gate] !== 'passed')) {
        reasons.add('required_gate_not_passed');
      }
    }
  }

  for (const dependency of profile.dependencies) {
    const actual = input.dependencies[dependency.dependencyId];
    if (!actual) {
      reasons.add('dependency_unknown');
      unknownDependencies.push(dependency.dependencyId);
    } else if (actual.status !== 'ready') {
      reasons.add('dependency_blocked');
    } else if (actual.revision !== dependency.expectedRevision) {
      reasons.add('dependency_revision_mismatch');
    }
  }

  if (profile.platformAllowlist.length > 0) {
    if (!input.platform) reasons.add('platform_unknown');
    else if (!profile.platformAllowlist.includes(input.platform))
      reasons.add('platform_not_admitted');
  }
  if (profile.routeAllowlist.length > 0) {
    if (!input.route) reasons.add('route_unknown');
    else if (!profile.routeAllowlist.includes(input.route)) reasons.add('route_not_admitted');
  }

  const normalizedReasons = [...reasons].sort(compareCapabilityIdentity);
  return Object.freeze({
    admitted: normalizedReasons.length === 0,
    capability: profile.capability,
    maturity: profile.state.maturity,
    rollout: profile.state.maxRollout,
    reasons: Object.freeze(normalizedReasons),
    unknownDependencies: Object.freeze(unknownDependencies.sort(compareCapabilityIdentity)),
  });
}

function compareCapabilityIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
