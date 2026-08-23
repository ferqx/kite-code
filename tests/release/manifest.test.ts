import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadReleaseManifestConsistency } from '../../apps/kite/src/release/manifest-loader';
import {
  assembleReleaseManifest,
  generateReleaseManifest,
  PRODUCTION_RELEASE_ASSEMBLY_ENABLED,
} from '../../scripts/release/generate-manifest';

const COMMIT = 'a'.repeat(40);

function fixture() {
  const behaviorInput = JSON.parse(
    readFileSync(resolve('tests/fixtures/release/behavior-digest/synthetic-input.json'), 'utf8'),
  ) as unknown;
  return generateReleaseManifest({
    payloadBytes: new TextEncoder().encode('verified synthetic payload'),
    productVersion: '0.0.0-synthetic.2',
    commitSha: COMMIT,
    buildTimestamp: '2026-08-02T01:00:00.000Z',
    bunVersion: 'synthetic-fixture',
    runtimeSchemaVersion: 21,
    supportedPlatforms: ['synthetic-platform'],
    supportedProviderTypes: ['synthetic-provider'],
    behaviorInput,
  });
}

describe('ReleaseManifest generation and Runtime consistency loader', () => {
  test('binds the payload and every resolved behavior component', () => {
    const { manifest, behavior } = fixture();
    expect(manifest.payloadSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.behaviorDigest).toBe(behavior.aggregateDigest);
    expect(manifest.releaseProfileDigest).toBe(behavior.items.releaseProfile.digest);
    expect(manifest.runtimeSchedulingPolicyDigest).toBe(
      behavior.items.runtimeSchedulingPolicy.digest,
    );
    expect(manifest.buildRecipeDigest).toBe(behavior.items.buildRecipe.digest);
  });

  test('rechecks consistency after pre-exec synthetic verification without claiming authenticity', () => {
    const { manifest, behavior } = fixture();
    const loaded = loadReleaseManifestConsistency({
      manifest,
      expectations: {
        payloadSha256: manifest.payloadSha256,
        releaseProfileDigest: behavior.items.releaseProfile.digest,
        behaviorDigest: behavior.aggregateDigest,
        providerRouteDigest: behavior.items.providerRoute.digest,
        releaseGatePolicyDigest: behavior.items.gatePolicy.digest,
        runtimeSchedulingPolicyDigest: behavior.items.runtimeSchedulingPolicy.digest,
        buildRecipeDigest: behavior.items.buildRecipe.digest,
        runtimeSchemaVersion: 21,
        platform: 'synthetic-platform',
        providerType: 'synthetic-provider',
      },
      preExecVerification: {
        verified: true,
        signatureKind: 'synthetic-ed25519-fixture-v1',
        distributable: false,
        realSigstoreSigningEnabled: false,
      },
      production: false,
    });
    expect(loaded).toEqual({
      version: 1,
      productVersion: manifest.productVersion,
      commitSha: COMMIT,
      buildTimestamp: manifest.buildTimestamp,
      profileDigest: manifest.releaseProfileDigest,
      behaviorDigest: manifest.behaviorDigest,
      runtimeSchemaVersion: 21,
      production: false,
    });
  });

  test('fails closed on digest, platform, and provider mismatch', () => {
    const { manifest, behavior } = fixture();
    const expectations = {
      payloadSha256: manifest.payloadSha256,
      releaseProfileDigest: behavior.items.releaseProfile.digest,
      behaviorDigest: behavior.aggregateDigest,
      providerRouteDigest: behavior.items.providerRoute.digest,
      releaseGatePolicyDigest: behavior.items.gatePolicy.digest,
      runtimeSchedulingPolicyDigest: behavior.items.runtimeSchedulingPolicy.digest,
      buildRecipeDigest: behavior.items.buildRecipe.digest,
      runtimeSchemaVersion: 21,
      platform: 'synthetic-platform',
      providerType: 'synthetic-provider',
    };
    const preExecVerification = {
      verified: true as const,
      signatureKind: 'synthetic-ed25519-fixture-v1' as const,
      distributable: false,
      realSigstoreSigningEnabled: false,
    };
    expect(() =>
      loadReleaseManifestConsistency({
        manifest,
        expectations: { ...expectations, behaviorDigest: `sha256:${'0'.repeat(64)}` },
        preExecVerification,
        production: false,
      }),
    ).toThrow('behaviorDigest mismatch');
    expect(() =>
      loadReleaseManifestConsistency({
        manifest,
        expectations: { ...expectations, platform: 'unknown-platform' },
        preExecVerification,
        production: false,
      }),
    ).toThrow('platform identity');
    expect(() =>
      loadReleaseManifestConsistency({
        manifest,
        expectations: { ...expectations, providerType: 'unknown-provider' },
        preExecVerification,
        production: false,
      }),
    ).toThrow('provider type');
  });

  test('cannot turn a synthetic fixture into a production trust root', () => {
    const { manifest, behavior } = fixture();
    expect(() =>
      loadReleaseManifestConsistency({
        manifest,
        expectations: {
          payloadSha256: manifest.payloadSha256,
          releaseProfileDigest: behavior.items.releaseProfile.digest,
          behaviorDigest: behavior.aggregateDigest,
          providerRouteDigest: behavior.items.providerRoute.digest,
          releaseGatePolicyDigest: behavior.items.gatePolicy.digest,
          runtimeSchedulingPolicyDigest: behavior.items.runtimeSchedulingPolicy.digest,
          buildRecipeDigest: behavior.items.buildRecipe.digest,
          runtimeSchemaVersion: 21,
          platform: 'synthetic-platform',
          providerType: 'synthetic-provider',
        },
        preExecVerification: {
          verified: true,
          signatureKind: 'synthetic-ed25519-fixture-v1',
          distributable: false,
          realSigstoreSigningEnabled: false,
        },
        production: true,
      }),
    ).toThrow('rejects synthetic');
  });

  test('binds production manifest admission to one closed distribution identity while assembly stays disabled', () => {
    const { manifest } = fixture();
    const { version: _version, payloadSha256: _payloadSha256, ...fields } = manifest;
    expect(PRODUCTION_RELEASE_ASSEMBLY_ENABLED).toBe(false);

    expect(() =>
      assembleReleaseManifest({
        payloadBytes: new TextEncoder().encode('not distributable'),
        fields: { ...fields, supportedPlatforms: ['ubuntu-24.04-x64'] },
        distributionMode: 'production',
        distributionTargetIdentity: 'ubuntu-24.04-x64',
      }),
    ).toThrow('real signing and distribution qualification');

    expect(() =>
      assembleReleaseManifest({
        payloadBytes: new TextEncoder().encode('not distributable'),
        fields: { ...fields, supportedPlatforms: ['macos-15-arm64'] },
        distributionMode: 'production',
        distributionTargetIdentity: 'future-supported-target',
      }),
    ).toThrow('distribution_target_identity_unsupported');

    expect(() =>
      assembleReleaseManifest({
        payloadBytes: new TextEncoder().encode('not distributable'),
        fields: { ...fields, supportedPlatforms: ['macos-15-arm64'] },
        distributionMode: 'production',
        distributionTargetIdentity: 'windows-2025-x64',
      }),
    ).toThrow('must equal its admitted distribution target');
  });

  test('rejects attaching a production distribution identity to a synthetic manifest', () => {
    const { manifest } = fixture();
    const { version: _version, payloadSha256: _payloadSha256, ...fields } = manifest;
    expect(() =>
      assembleReleaseManifest({
        payloadBytes: new TextEncoder().encode('synthetic'),
        fields,
        distributionMode: 'synthetic_non_distributable',
        distributionTargetIdentity: 'macos-15-arm64',
      }),
    ).toThrow('Synthetic release assembly cannot consume');
  });
});
