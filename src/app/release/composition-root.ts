import {
  type AgentConfig,
  admitEmbeddedReleaseProfileV1,
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
  | 'production_support_set_empty';

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
      production: boolean;
      profile: ReleaseProfileV1;
    };

export interface ReleaseControlledAgentConfigV1 extends AgentConfig {
  readonly releaseControl: {
    readonly version: 1;
    readonly production: boolean;
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
    });
    const profile = composeReleaseProfileV1({
      embedded,
      layers: input.restrictionLayers,
    });
    return { version: 1, active: true, production: input.production, profile };
  } catch (error) {
    if (
      error instanceof ProductionReleaseProfileAdmissionError &&
      error.reason === 'production_support_set_empty'
    ) {
      return {
        version: 1,
        active: false,
        production: input.production,
        reason: 'production_support_set_empty',
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
  return {
    ...input.config,
    releaseControl: Object.freeze({
      version: 1 as const,
      production: input.composition.production,
      effectiveProfile: input.composition.profile,
    }),
  };
}
