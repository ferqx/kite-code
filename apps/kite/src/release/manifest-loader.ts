import type { ReleaseManifestV1 } from './artifact-layout';

export interface PreExecReleaseVerificationV1 {
  verified: true;
  signatureKind: 'synthetic-ed25519-fixture-v1' | 'sigstore-keyless-v1';
  distributable: boolean;
  realSigstoreSigningEnabled: boolean;
}

export interface ReleaseManifestConsistencyExpectationsV1 {
  payloadSha256: string;
  releaseProfileDigest: string;
  behaviorDigest: string;
  providerDataPolicyDigest: string;
  releaseGatePolicyDigest: string;
  runtimeSchedulingPolicyDigest: string;
  buildRecipeDigest: string;
  runtimeSchemaVersion: number;
  platform: string;
  providerType: string;
}

export interface LoadedReleaseManifestV1 {
  version: 1;
  productVersion: string;
  commitSha: string;
  buildTimestamp: string;
  profileDigest: string;
  behaviorDigest: string;
  runtimeSchemaVersion: number;
  production: boolean;
}

/**
 * Runtime-side consistency recheck. Supply-chain authenticity belongs to the
 * launcher/bootstrap verifier and cannot be established by this loader.
 */
export function loadReleaseManifestConsistencyV1(input: {
  manifest: ReleaseManifestV1;
  expectations: ReleaseManifestConsistencyExpectationsV1;
  preExecVerification: PreExecReleaseVerificationV1;
  production: boolean;
}): LoadedReleaseManifestV1 {
  if (!input.preExecVerification.verified) {
    throw new Error('Release payload reached the Runtime without pre-exec verification.');
  }
  if (input.production) {
    if (
      input.preExecVerification.signatureKind !== 'sigstore-keyless-v1' ||
      !input.preExecVerification.distributable ||
      !input.preExecVerification.realSigstoreSigningEnabled
    ) {
      throw new Error('Production Runtime rejects synthetic or non-distributable trust roots.');
    }
    throw new Error(
      'Production Runtime admission is disabled while the supported platform set is empty.',
    );
  }

  const checks: Array<[label: string, actual: string | number, expected: string | number]> = [
    ['payloadSha256', input.manifest.payloadSha256, input.expectations.payloadSha256],
    [
      'releaseProfileDigest',
      input.manifest.releaseProfileDigest,
      input.expectations.releaseProfileDigest,
    ],
    ['behaviorDigest', input.manifest.behaviorDigest, input.expectations.behaviorDigest],
    [
      'providerDataPolicyDigest',
      input.manifest.providerDataPolicyDigest,
      input.expectations.providerDataPolicyDigest,
    ],
    [
      'releaseGatePolicyDigest',
      input.manifest.releaseGatePolicyDigest,
      input.expectations.releaseGatePolicyDigest,
    ],
    [
      'runtimeSchedulingPolicyDigest',
      input.manifest.runtimeSchedulingPolicyDigest,
      input.expectations.runtimeSchedulingPolicyDigest,
    ],
    ['buildRecipeDigest', input.manifest.buildRecipeDigest, input.expectations.buildRecipeDigest],
    [
      'runtimeSchemaVersion',
      input.manifest.runtimeSchemaVersion,
      input.expectations.runtimeSchemaVersion,
    ],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw new Error(`Release manifest ${label} mismatch.`);
  }
  if (!input.manifest.supportedPlatforms.includes(input.expectations.platform)) {
    throw new Error('Release manifest does not admit the selected platform identity.');
  }
  if (!input.manifest.supportedProviderTypes.includes(input.expectations.providerType)) {
    throw new Error('Release manifest does not admit the selected provider type.');
  }

  return Object.freeze({
    version: 1,
    productVersion: input.manifest.productVersion,
    commitSha: input.manifest.commitSha,
    buildTimestamp: input.manifest.buildTimestamp,
    profileDigest: input.manifest.releaseProfileDigest,
    behaviorDigest: input.expectations.behaviorDigest,
    runtimeSchemaVersion: input.manifest.runtimeSchemaVersion,
    production: false,
  });
}
