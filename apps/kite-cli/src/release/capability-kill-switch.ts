import {
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
  type ReleaseProfileRestrictionLayer,
} from '#kite-cli/config';

const CAPABILITY_SET = new Set<string>(RELEASE_CAPABILITIES);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type KillSwitchReason =
  | 'g0_incident'
  | 'required_ci_failed'
  | 'error_budget_burn'
  | 'provider_outage'
  | 'operator_containment';

export interface CapabilityKillSwitchRequest {
  version: 1;
  reason: KillSwitchReason;
  disableCapabilities: readonly ReleaseCapability[];
  cohortPercent: 0;
  rollbackArtifactDigest?: string;
  preserveMetadataEvidence: true;
}

export interface CapabilityKillSwitchDecision {
  version: 1;
  admitted: true;
  cohortPercent: 0;
  rollbackArtifactDigest?: string;
  preserveMetadataEvidence: true;
  restrictionLayer: ReleaseProfileRestrictionLayer;
}

/**
 * Builds a disable-only release restriction. It cannot enable a capability,
 * increase a cohort, loosen network policy, or authorize a new artifact.
 */
export function buildCapabilityKillSwitchDecision(
  input: CapabilityKillSwitchRequest,
): CapabilityKillSwitchDecision {
  if (input.version !== 1 || input.cohortPercent !== 0 || !input.preserveMetadataEvidence) {
    throw new Error('Kill-switch request must be disable-only and preserve metadata evidence.');
  }
  const capabilities = [...new Set(input.disableCapabilities)];
  for (const capability of capabilities) {
    if (!CAPABILITY_SET.has(capability)) {
      throw new Error(`Unknown release capability: ${String(capability)}`);
    }
  }
  if (
    input.rollbackArtifactDigest !== undefined &&
    !SHA256_PATTERN.test(input.rollbackArtifactDigest)
  ) {
    throw new Error('Rollback artifact digest must be a canonical sha256 identity.');
  }

  return Object.freeze({
    version: 1 as const,
    admitted: true as const,
    cohortPercent: 0 as const,
    ...(input.rollbackArtifactDigest
      ? { rollbackArtifactDigest: input.rollbackArtifactDigest }
      : {}),
    preserveMetadataEvidence: true as const,
    restrictionLayer: Object.freeze({
      source: 'rollout' as const,
      restrictions: Object.freeze({
        capabilities: Object.freeze(
          Object.fromEntries(
            capabilities
              .sort()
              .map((capability) => [
                capability,
                Object.freeze({ enabled: false as const, maxRollout: 'off' as const }),
              ]),
          ),
        ),
        safety: Object.freeze({ networkMode: 'off' as const, networkAllowlist: [] }),
        data: Object.freeze({
          providerRouteAllowlist: [],
        }),
        telemetry: Object.freeze({ allowed: false }),
      }),
    }),
  });
}
