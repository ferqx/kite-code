import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encodeReleaseManifest,
  encodeSyntheticSignature,
  type ReleaseArtifactLayout,
  type ReleaseManifest,
  releaseArtifactLayout,
  SYNTHETIC_PUBLIC_KEY_SHA256,
  SYNTHETIC_SIGNATURE_KIND,
  SYNTHETIC_TRUST_ROOT_ID,
  type SyntheticSignatureBundle,
} from './artifact-layout';
import { canonicalJsonBytes, sha256Digest, sha256DomainSeparated } from './canonical-json';
import { assembleReleaseManifest } from './generate-manifest';

const SYNTHETIC_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`;

const DEFAULT_SYNTHETIC_PAYLOAD = new TextEncoder().encode(
  '#!/usr/bin/env bun\nprocess.stdout.write("synthetic release payload fixture\\n");\n',
);

export interface BuildSyntheticArtifactOptions {
  directory: string;
  payload?: Uint8Array;
  manifest?: Omit<ReleaseManifest, 'payloadSha256' | 'version'>;
}

export interface BuiltSyntheticArtifact {
  layout: ReleaseArtifactLayout;
  manifest: ReleaseManifest;
  signature: SyntheticSignatureBundle;
}

/**
 * Build a deterministic, test-only artifact. The embedded private key makes
 * this fixture intentionally unsuitable for distribution or production trust.
 */
export function buildSyntheticArtifact(
  options: BuildSyntheticArtifactOptions,
): BuiltSyntheticArtifact {
  const layout = releaseArtifactLayout(options.directory);
  mkdirSync(layout.directory, { recursive: true, mode: 0o700 });
  assertWritableFixtureTarget(layout.payload);
  assertWritableFixtureTarget(layout.manifest);
  assertWritableFixtureTarget(layout.signature);

  const payload = new Uint8Array(options.payload ?? DEFAULT_SYNTHETIC_PAYLOAD);
  const manifest = assembleReleaseManifest({
    payloadBytes: payload,
    fields: options.manifest ?? defaultSyntheticManifestFields(),
    distributionMode: 'synthetic_non_distributable',
  });
  const manifestBytes = encodeReleaseManifest(manifest);
  const signatureBytes = sign(null, manifestBytes, createPrivateKey(SYNTHETIC_PRIVATE_KEY_PEM));
  const signature: SyntheticSignatureBundle = {
    version: 1,
    kind: SYNTHETIC_SIGNATURE_KIND,
    signedObject: 'canonical-release-manifest-v1',
    algorithm: 'ed25519',
    trustRootId: SYNTHETIC_TRUST_ROOT_ID,
    publicKeySha256: SYNTHETIC_PUBLIC_KEY_SHA256,
    manifestSha256: sha256Digest(manifestBytes),
    signatureBase64: signatureBytes.toString('base64'),
    distributable: false,
    realSigstoreSigningEnabled: false,
  };

  writeFileSync(layout.payload, payload, { mode: 0o600 });
  writeFileSync(layout.manifest, encodeReleaseManifest(manifest), { mode: 0o600 });
  writeFileSync(layout.signature, encodeSyntheticSignature(signature), { mode: 0o600 });
  return { layout, manifest, signature };
}

export function defaultSyntheticManifestFields(): Omit<
  ReleaseManifest,
  'payloadSha256' | 'version'
> {
  return {
    productVersion: '0.0.0-synthetic.1',
    commitSha: '0000000000000000000000000000000000000000',
    buildTimestamp: '1970-01-01T00:00:00.000Z',
    bunVersion: 'synthetic-fixture',
    releaseProfileDigest: fixtureDigest('release-profile'),
    lockfileDigest: fixtureDigest('lockfile'),
    agentContractDigest: fixtureDigest('agent-contract'),
    modelVisibleToolRegistryDigest: fixtureDigest('model-visible-tool-registry'),
    defaultConfigDigest: fixtureDigest('default-config'),
    providerRouteDigest: fixtureDigest('provider-route'),
    releaseGatePolicyDigest: fixtureDigest('release-gate-policy'),
    runtimeSchedulingPolicyDigest: fixtureDigest('runtime-scheduling-policy'),
    buildRecipeDigest: fixtureDigest('build-recipe'),
    behaviorDigest: fixtureDigest('behavior'),
    runtimeSchemaVersion: 1,
    supportedPlatforms: [],
    supportedProviderTypes: [],
  };
}

function fixtureDigest(subject: string): `sha256:${string}` {
  return sha256DomainSeparated(
    `synthetic-fixture/${subject}`,
    canonicalJsonBytes({ subject, synthetic: true, version: 1 }),
  );
}

function assertWritableFixtureTarget(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite non-regular synthetic artifact path: ${path}`);
  }
}

if (import.meta.main) {
  const outputDirectory = resolve(process.argv[2] ?? 'dist/release-synthetic');
  const payloadPath = process.argv[3];
  const payload = payloadPath ? readFileSync(resolve(payloadPath)) : undefined;
  const built = buildSyntheticArtifact({ directory: outputDirectory, payload });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'synthetic_fixture_only',
        distributable: false,
        realSigstoreSigningEnabled: false,
        directory: built.layout.directory,
        payloadSha256: built.manifest.payloadSha256,
        manifestSha256: built.signature.manifestSha256,
      },
      null,
      2,
    )}\n`,
  );
}
