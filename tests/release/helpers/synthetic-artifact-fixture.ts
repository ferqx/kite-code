import { createPrivateKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  encodeReleaseManifest,
  encodeSyntheticSignature,
  type ReleaseManifest,
  releaseArtifactLayout,
  SYNTHETIC_PUBLIC_KEY_SHA256,
  SYNTHETIC_SIGNATURE_KIND,
  SYNTHETIC_TRUST_ROOT_ID,
  type SyntheticSignatureBundle,
} from '../../../scripts/release/artifact-layout';
import { sha256Digest } from '../../../scripts/release/canonical-json';

// Public fixture material matching the retained synthetic verifier's pinned key.
// It cannot establish distribution or production signing authority.
const fixturePrivateKey = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`);

/** Write fixed test data into a caller-owned empty temporary directory. */
export function writeSyntheticArtifactFixture(directory: string) {
  const layout = releaseArtifactLayout(directory);
  const payload = new TextEncoder().encode('synthetic release payload fixture\n');
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const manifest: ReleaseManifest = {
    version: 1,
    productVersion: '0.0.0-synthetic.1',
    commitSha: '0'.repeat(40),
    buildTimestamp: '1970-01-01T00:00:00.000Z',
    bunVersion: 'synthetic-fixture',
    payloadSha256: sha256Digest(payload),
    releaseProfileDigest: digest,
    lockfileDigest: digest,
    agentContractDigest: digest,
    modelVisibleToolRegistryDigest: digest,
    defaultConfigDigest: digest,
    providerRouteDigest: digest,
    releaseGatePolicyDigest: digest,
    runtimeSchedulingPolicyDigest: digest,
    buildRecipeDigest: digest,
    behaviorDigest: digest,
    runtimeSchemaVersion: 1,
    supportedPlatforms: [],
    supportedProviderTypes: [],
  };
  const manifestBytes = encodeReleaseManifest(manifest);
  const signature: SyntheticSignatureBundle = {
    version: 1,
    kind: SYNTHETIC_SIGNATURE_KIND,
    signedObject: 'canonical-release-manifest-v1',
    algorithm: 'ed25519',
    trustRootId: SYNTHETIC_TRUST_ROOT_ID,
    publicKeySha256: SYNTHETIC_PUBLIC_KEY_SHA256,
    manifestSha256: sha256Digest(manifestBytes),
    signatureBase64: sign(null, manifestBytes, fixturePrivateKey).toString('base64'),
    distributable: false,
    realSigstoreSigningEnabled: false,
  };
  writeFileSync(layout.payload, payload, { flag: 'wx', mode: 0o600 });
  writeFileSync(layout.manifest, manifestBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(layout.signature, encodeSyntheticSignature(signature), {
    flag: 'wx',
    mode: 0o600,
  });
  return { layout, manifest, signature };
}
