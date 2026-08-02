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
  providerDataPolicyDigest: `sha256:${string}`;
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
}): ReleaseManifestV1 {
  if (input.distributionMode === 'production' && !PRODUCTION_RELEASE_ASSEMBLY_ENABLED) {
    throw new Error(
      'Production release assembly is disabled while the D-04 supported platform set is empty.',
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
  supportedProviderTypes: string[];
  behaviorInput: unknown;
}): { manifest: ReleaseManifestV1; behavior: BehaviorDigestV1 } {
  const behavior = generateBehaviorDigestV1(input.behaviorInput);
  const items = behavior.items;
  const manifest = assembleReleaseManifestV1({
    payloadBytes: input.payloadBytes,
    distributionMode:
      behavior.inputClass === 'production_resolved' ? 'production' : 'synthetic_non_distributable',
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
      providerDataPolicyDigest: items.providerDataPolicy.digest,
      releaseGatePolicyDigest: items.gatePolicy.digest,
      runtimeSchedulingPolicyDigest: items.runtimeSchedulingPolicy.digest,
      buildRecipeDigest: items.buildRecipe.digest,
      behaviorDigest: behavior.aggregateDigest,
      runtimeSchemaVersion: input.runtimeSchemaVersion,
      supportedPlatforms: input.supportedPlatforms,
      supportedProviderTypes: input.supportedProviderTypes,
    },
  });
  return { manifest, behavior };
}
