import { z } from 'zod';

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
