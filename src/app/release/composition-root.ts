import {
  type AgentConfig,
  admitEmbeddedReleaseProfileV1,
  admitProductionReleaseSupportIdentityV1,
  composeReleaseProfileV1,
  type EmbeddedReleaseProfileIdV1,
  ProductionReleaseProfileAdmissionError,
  type ReleaseProfileRestrictionLayerV1,
  type ReleaseProfileV1,
} from '@/core/config';
import { getFeatureFlags } from '@/core/config/features';

export type ReleaseCompositionInactiveReasonV1 =
  | 'artifact_disabled'
  | 'rollout_disabled'
  | 'production_support_set_empty'
  | 'production_support_identity_missing'
  | 'production_support_identity_unsupported'
  | 'production_internal_profile';

export type ReleaseCompositionV1 =
  | {
      version: 1;
      active: false;
      production: boolean;
      reason: ReleaseCompositionInactiveReasonV1;
    }
  | {
      version: 1;
      active: true;
      production: false;
      profile: ReleaseProfileV1;
    }
  | {
      version: 1;
      active: true;
      production: true;
      productionSupportIdentity: string;
      profile: ReleaseProfileV1;
    };

export interface ReleaseControlledAgentConfigV1 extends AgentConfig {
  readonly releaseControl:
    | {
        readonly version: 1;
        readonly production: false;
        readonly effectiveProfile: ReleaseProfileV1;
      }
    | {
        readonly version: 1;
        readonly production: true;
        readonly productionSupportIdentity: string;
        readonly effectiveProfile: ReleaseProfileV1;
      };
}

/**
 * App-owned release composition gate. Artifact authority is independent from
 * project/user config; ordinary config and CLI layers can only tighten it.
 */
export function resolveReleaseCompositionV1(input: {
  config: AgentConfig;
  artifactReleaseProfileV1Enabled: boolean;
  profileId: EmbeddedReleaseProfileIdV1;
  production: boolean;
  productionSupportIdentity?: string;
  restrictionLayers?: readonly ReleaseProfileRestrictionLayerV1[];
}): ReleaseCompositionV1 {
  if (!input.artifactReleaseProfileV1Enabled) {
    return { version: 1, active: false, production: input.production, reason: 'artifact_disabled' };
  }
  if (!getFeatureFlags(input.config).releaseProfileV1) {
    return { version: 1, active: false, production: input.production, reason: 'rollout_disabled' };
  }
  try {
    const embedded = admitEmbeddedReleaseProfileV1({
      profileId: input.profileId,
      releaseProfileV1Enabled: true,
      production: input.production,
      productionSupportIdentity: input.productionSupportIdentity,
    });
    const profile = composeReleaseProfileV1({
      embedded,
      layers: input.restrictionLayers,
    });
    if (input.production) {
      const productionSupportIdentity = admitProductionReleaseSupportIdentityV1({
        profile,
        production: true,
        productionSupportIdentity: input.productionSupportIdentity,
      });
      return {
        version: 1,
        active: true,
        production: true,
        productionSupportIdentity,
        profile,
      };
    }
    return { version: 1, active: true, production: false, profile };
  } catch (error) {
    if (
      error instanceof ProductionReleaseProfileAdmissionError &&
      (error.reason === 'production_support_set_empty' ||
        error.reason === 'production_support_identity_missing' ||
        error.reason === 'production_support_identity_unsupported' ||
        error.reason === 'production_internal_profile')
    ) {
      return {
        version: 1,
        active: false,
        production: input.production,
        reason: error.reason,
      };
    }
    throw error;
  }
}

/** Only an active composition can create the config passed to Runtime/providers. */
export function createReleaseControlledAgentConfigV1(input: {
  config: AgentConfig;
  composition: ReleaseCompositionV1;
}): ReleaseControlledAgentConfigV1 {
  if (!input.composition.active) {
    throw new Error(`Release-controlled Runtime creation denied: ${input.composition.reason}.`);
  }
  if (input.composition.production) {
    const productionSupportIdentity = admitProductionReleaseSupportIdentityV1({
      profile: input.composition.profile,
      production: true,
      productionSupportIdentity: input.composition.productionSupportIdentity,
    });
    return {
      ...input.config,
      releaseControl: Object.freeze({
        version: 1 as const,
        production: true as const,
        productionSupportIdentity,
        effectiveProfile: input.composition.profile,
      }),
    };
  }
  admitProductionReleaseSupportIdentityV1({
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
