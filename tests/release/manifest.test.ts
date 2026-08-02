import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateReleaseManifestV1 } from '../../scripts/release/generate-manifest';
import { loadReleaseManifestConsistencyV1 } from '../../src/app/release/manifest-loader';

const COMMIT = 'a'.repeat(40);

function fixture() {
  const behaviorInput = JSON.parse(
    readFileSync(resolve('tests/fixtures/release/behavior-digest/synthetic-input-v1.json'), 'utf8'),
  ) as unknown;
  return generateReleaseManifestV1({
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

describe('ReleaseManifestV1 generation and Runtime consistency loader', () => {
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
    const loaded = loadReleaseManifestConsistencyV1({
      manifest,
      expectations: {
        payloadSha256: manifest.payloadSha256,
        releaseProfileDigest: behavior.items.releaseProfile.digest,
        behaviorDigest: behavior.aggregateDigest,
        providerDataPolicyDigest: behavior.items.providerDataPolicy.digest,
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
      providerDataPolicyDigest: behavior.items.providerDataPolicy.digest,
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
      loadReleaseManifestConsistencyV1({
        manifest,
        expectations: { ...expectations, behaviorDigest: `sha256:${'0'.repeat(64)}` },
        preExecVerification,
        production: false,
      }),
    ).toThrow('behaviorDigest mismatch');
    expect(() =>
      loadReleaseManifestConsistencyV1({
        manifest,
        expectations: { ...expectations, platform: 'unknown-platform' },
        preExecVerification,
        production: false,
      }),
    ).toThrow('platform identity');
    expect(() =>
      loadReleaseManifestConsistencyV1({
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
      loadReleaseManifestConsistencyV1({
        manifest,
        expectations: {
          payloadSha256: manifest.payloadSha256,
          releaseProfileDigest: behavior.items.releaseProfile.digest,
          behaviorDigest: behavior.aggregateDigest,
          providerDataPolicyDigest: behavior.items.providerDataPolicy.digest,
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
});
