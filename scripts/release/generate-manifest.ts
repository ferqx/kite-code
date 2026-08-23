import {
  type ProductionDistributionTargetIdentityV1,
  parseProductionDistributionTargetIdentityV1,
} from '#app/config/release-profile';
import { type ReleaseManifestV1, validateReleaseManifest } from './artifact-layout';
import { type BehaviorDigestV1, generateBehaviorDigestV1 } from './behavior-digest';
import { sha256Digest } from './canonical-json';

export const PRODUCTION_RELEASE_ASSEMBLY_ENABLED = false as const;

export interface ReleaseManifestIdentityFieldsV1 {
  productVersion: string;
  commitSha: string;
  buildTimestamp: string;
  bunVersion: string;
  releaseProfileDigest: `sha256:${string}`;
  lockfileDigest: `sha256:${string}`;
  agentContractDigest: `sha256:${string}`;
  modelVisibleToolRegistryDigest: `sha256:${string}`;
  defaultConfigDigest: `sha256:${string}`;
  providerRouteDigest: `sha256:${string}`;
  releaseGatePolicyDigest: `sha256:${string}`;
  runtimeSchedulingPolicyDigest: `sha256:${string}`;
  buildRecipeDigest: `sha256:${string}`;
  behaviorDigest: `sha256:${string}`;
  runtimeSchemaVersion: number;
  supportedPlatforms: string[];
  supportedProviderTypes: string[];
}

export function assembleReleaseManifestV1(input: {
  payloadBytes: Uint8Array;
  fields: ReleaseManifestIdentityFieldsV1;
  distributionMode: 'synthetic_non_distributable' | 'production';
  distributionTargetIdentity?: string;
}): ReleaseManifestV1 {
  if (input.distributionMode === 'synthetic_non_distributable') {
    if (input.distributionTargetIdentity !== undefined) {
      throw new Error(
        'Synthetic release assembly cannot consume a production distribution target.',
      );
    }
  } else {
    const distributionTargetIdentity = parseProductionDistributionTargetIdentityV1(
      input.distributionTargetIdentity,
    );
    if (
      input.fields.supportedPlatforms.length !== 1 ||
      input.fields.supportedPlatforms[0] !== distributionTargetIdentity
    ) {
      throw new Error(
        'Production manifest platform identity must equal its admitted distribution target.',
      );
    }
  }
  if (input.distributionMode === 'production' && !PRODUCTION_RELEASE_ASSEMBLY_ENABLED) {
    throw new Error(
      'Production release assembly is disabled until real signing and distribution qualification are enabled.',
    );
  }
  const manifest: ReleaseManifestV1 = {
    version: 1,
    ...structuredClone(input.fields),
    payloadSha256: sha256Digest(input.payloadBytes),
  };
  validateReleaseManifest(manifest);
  return Object.freeze(manifest);
}

export function generateReleaseManifestV1(input: {
  payloadBytes: Uint8Array;
  productVersion: string;
  commitSha: string;
  buildTimestamp: string;
  bunVersion: string;
  runtimeSchemaVersion: number;
  supportedPlatforms: string[];
  distributionTargetIdentity?: string;
  supportedProviderTypes: string[];
  behaviorInput: unknown;
}): { manifest: ReleaseManifestV1; behavior: BehaviorDigestV1 } {
  const behavior = generateBehaviorDigestV1(input.behaviorInput);
  const items = behavior.items;
  const distributionMode =
    behavior.inputClass === 'production_resolved'
      ? ('production' as const)
      : ('synthetic_non_distributable' as const);
  let distributionTargetIdentity: ProductionDistributionTargetIdentityV1 | undefined;
  let supportedPlatforms = input.supportedPlatforms;
  if (distributionMode === 'production') {
    distributionTargetIdentity = parseProductionDistributionTargetIdentityV1(
      input.distributionTargetIdentity,
    );
    supportedPlatforms = [distributionTargetIdentity];
  } else if (input.distributionTargetIdentity !== undefined) {
    throw new Error(
      'Synthetic release generation cannot consume a production distribution target.',
    );
  }
  const manifest = assembleReleaseManifestV1({
    payloadBytes: input.payloadBytes,
    distributionMode,
    distributionTargetIdentity,
    fields: {
      productVersion: input.productVersion,
      commitSha: input.commitSha,
      buildTimestamp: input.buildTimestamp,
      bunVersion: input.bunVersion,
      releaseProfileDigest: items.releaseProfile.digest,
      lockfileDigest: items.lockfile.digest,
      agentContractDigest: items.agentSystemContract.digest,
      modelVisibleToolRegistryDigest: items.toolRegistry.digest,
      defaultConfigDigest: items.defaultConfiguration.digest,
      providerRouteDigest: items.providerRoute.digest,
      releaseGatePolicyDigest: items.gatePolicy.digest,
      runtimeSchedulingPolicyDigest: items.runtimeSchedulingPolicy.digest,
      buildRecipeDigest: items.buildRecipe.digest,
      behaviorDigest: behavior.aggregateDigest,
      runtimeSchemaVersion: input.runtimeSchemaVersion,
      supportedPlatforms,
      supportedProviderTypes: input.supportedProviderTypes,
    },
  });
  return { manifest, behavior };
}
