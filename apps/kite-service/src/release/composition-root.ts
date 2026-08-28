import {
  type AgentConfig,
  admitEmbeddedReleaseProfile,
  admitProductionDistributionTargetIdentity,
  composeReleaseProfile,
  type EmbeddedReleaseProfileId,
  type ProductionDistributionTargetIdentity,
  type ReleaseProfile,
  type ReleaseProfileRestrictionLayer,
} from '#kite-service/config';
import { getFeatureFlags } from '#kite-service/config/features';

export type ReleaseCompositionInactiveReason =
  | 'artifact_disabled'
  | 'rollout_disabled'
  | 'distribution_target_capabilities_not_off'
  | 'distribution_target_identity_missing'
  | 'distribution_target_identity_unsupported'
  | 'production_internal_profile'
  | 'production_artifact_authority_unconfigured';

export type ReleaseComposition =
  | {
      version: 1;
      active: false;
      production: boolean;
      reason: ReleaseCompositionInactiveReason;
    }
  | {
      version: 1;
      active: true;
      production: false;
      profile: ReleaseProfile;
    }
  | {
      version: 1;
      active: true;
      production: true;
      distributionTargetIdentity: ProductionDistributionTargetIdentity;
      profile: ReleaseProfile;
    };

export interface ReleaseControlledAgentConfig extends AgentConfig {
  readonly releaseControl:
    | {
        readonly version: 1;
        readonly production: false;
        readonly effectiveProfile: ReleaseProfile;
      }
    | {
        readonly version: 1;
        readonly production: true;
        readonly distributionTargetIdentity: ProductionDistributionTargetIdentity;
        readonly effectiveProfile: ReleaseProfile;
      };
}

/**
 * App-owned release composition gate. Artifact authority is independent from
 * project/user config; ordinary config and CLI layers can only tighten it.
 */
export function resolveReleaseComposition(input: {
  config: AgentConfig;
  artifactReleaseProfileV1Enabled: boolean;
  profileId: EmbeddedReleaseProfileId;
  production: boolean;
  distributionTargetIdentity?: string;
  restrictionLayers?: readonly ReleaseProfileRestrictionLayer[];
}): ReleaseComposition {
  if (!input.artifactReleaseProfileV1Enabled) {
    return { version: 1, active: false, production: input.production, reason: 'artifact_disabled' };
  }
  if (!getFeatureFlags(input.config).releaseProfile) {
    return { version: 1, active: false, production: input.production, reason: 'rollout_disabled' };
  }
  if (input.production) {
    return {
      version: 1,
      active: false,
      production: true,
      reason: 'production_artifact_authority_unconfigured',
    };
  }
  const embedded = admitEmbeddedReleaseProfile({
    profileId: input.profileId,
    releaseProfileV1Enabled: true,
    production: false,
  });
  const profile = composeReleaseProfile({
    embedded,
    layers: input.restrictionLayers,
  });
  return { version: 1, active: true, production: false, profile };
}

/** Only an active composition can create the config passed to Runtime/providers. */
export function createReleaseControlledAgentConfig(input: {
  config: AgentConfig;
  composition: ReleaseComposition;
}): ReleaseControlledAgentConfig {
  if (!input.composition.active) {
    throw new Error(`Release-controlled Runtime creation denied: ${input.composition.reason}.`);
  }
  if (input.composition.production) {
    throw new Error(
      'Release-controlled Runtime creation denied: production_artifact_authority_unconfigured.',
    );
  }
  admitProductionDistributionTargetIdentity({
    profile: input.composition.profile,
    production: false,
  });
  return {
    ...input.config,
    releaseControl: Object.freeze({
      version: 1 as const,
      production: false as const,
      effectiveProfile: input.composition.profile,
    }),
  };
}
