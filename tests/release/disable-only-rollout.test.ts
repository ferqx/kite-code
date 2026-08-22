import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBEDDED_RELEASE_PROFILES_V1,
  parseReleaseProfileV1,
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
  type ReleaseProfileV1,
} from '#app/config';
import {
  decodeIdentityBoundRolloutCacheV1,
  loadRolloutCacheFileV1,
  type RolloutArtifactIdentityV1,
  RolloutCacheError,
  writeRolloutCacheFileV1,
} from '../../apps/kite/src/release/rollout-cache';
import {
  DisableOnlyRolloutError,
  encodeSyntheticRolloutSignatureV1,
  ROLLOUT_MANIFEST_ENABLED_BY_DEFAULT,
  resolveDisableOnlyRolloutV1,
  verifyDisableOnlyRolloutManifestV1,
} from '../../apps/kite/src/release/rollout-manifest-loader';
import { canonicalJsonBytes } from '../../scripts/release/canonical-json';
import { signSyntheticRolloutManifestV1 } from '../../scripts/release/sign-rollout-manifest';

const roots: string[] = [];
const NOW = new Date('2026-08-02T12:00:00.000Z');
const A = `sha256:${'a'.repeat(64)}` as const;
const B = `sha256:${'b'.repeat(64)}` as const;

const ARTIFACT_IDENTITY: RolloutArtifactIdentityV1 = {
  canonicalRepository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  commit: '1'.repeat(40),
  payloadSha256: A,
  releaseProfileDigest: B,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('disable-only signed rollout', () => {
  test('defaults off and does not parse or apply remote bytes', () => {
    expect(ROLLOUT_MANIFEST_ENABLED_BY_DEFAULT).toBe(false);
    const embedded = broadProfile();
    const result = resolveDisableOnlyRolloutV1({
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: {
        status: 'available',
        manifestBytes: new TextEncoder().encode('not json'),
        signatureBytes: new TextEncoder().encode('not json'),
      },
    });
    expect(result).toEqual({
      status: 'disabled',
      source: 'embedded',
      effectiveProfile: embedded,
      cohortPercent: 50,
    });
    expect(
      resolveDisableOnlyRolloutV1({
        mandatoryAdmin: true,
        embeddedProfile: embedded,
        embeddedCohortPercent: 50,
        expectedIdentity: ARTIFACT_IDENTITY,
        now: NOW,
      }).status,
    ).toBe('denied');
  });

  test('applies only capability disable, rollout/cohort reduction and allowlist intersection', () => {
    const embedded = broadProfile();
    const signed = fixture({ sequence: 1 });
    const result = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'available', ...signed },
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected rollout application');
    expect(result.source).toBe('remote');
    expect(result.sequence).toBe(1);
    expect(result.cohortPercent).toBe(25);
    expect(result.effectiveProfile.capabilities.shell.maxRollout).toBe('off');
    expect(result.effectiveProfile.capabilities.plan.maxRollout).toBe('internal');
    expect(result.effectiveProfile.capabilities.plan.maturity).toBe('stable');
    expect(result.effectiveProfile.safety.networkAllowlist).toEqual(['api.example.test']);
    expect(result.effectiveProfile.safety.mcpProviderAllowlist).toEqual(['mcp-a']);
    expect(result.effectiveProfile.data.providerRouteAllowlist).toEqual(['route-a']);
    expect(result.cacheRecord.nonDistributable).toBe(true);
    expect(result.cacheRecord.realRolloutSigningEnabled).toBe(false);
  });

  test('rejects cohort, rollout and allowlist escalation', () => {
    const embedded = broadProfile();
    embedded.capabilities.plan.maxRollout = 'canary';
    expectVerifyFailure(fixture({ cohortPercent: 51 }), embedded, 'cohort_escalation');
    expectVerifyFailure(
      fixture({ maxRollout: { plan: 'general' } }),
      embedded,
      'restriction_escalation',
    );
    expectVerifyFailure(
      fixture({ networkAllowlist: ['new.example.test'] }),
      embedded,
      'restriction_escalation',
    );
  });

  test('rejects schema injection, manifest tampering, signature tampering and key substitution', () => {
    const embedded = broadProfile();
    const signed = fixture();
    const manifest = JSON.parse(new TextDecoder().decode(signed.manifestBytes)) as Record<
      string,
      unknown
    >;
    manifest.credential = 'injected';
    expect(() =>
      verifyDisableOnlyRolloutManifestV1({
        ...verificationInput(embedded),
        manifestBytes: canonicalJsonBytes(manifest),
        signatureBytes: signed.signatureBytes,
      }),
    ).toThrow(new DisableOnlyRolloutError('schema_invalid'));

    const tamperedManifest = JSON.parse(new TextDecoder().decode(signed.manifestBytes)) as {
      restrictions: { cohortPercent: number };
    };
    tamperedManifest.restrictions.cohortPercent = 0;
    expect(() =>
      verifyDisableOnlyRolloutManifestV1({
        ...verificationInput(embedded),
        manifestBytes: canonicalJsonBytes(tamperedManifest),
        signatureBytes: signed.signatureBytes,
      }),
    ).toThrow(new DisableOnlyRolloutError('signature_invalid'));

    const signature = { ...signed.signature, signatureBase64: Buffer.alloc(64).toString('base64') };
    expect(() =>
      verifyDisableOnlyRolloutManifestV1({
        ...verificationInput(embedded),
        manifestBytes: signed.manifestBytes,
        signatureBytes: encodeSyntheticRolloutSignatureV1(signature),
      }),
    ).toThrow(new DisableOnlyRolloutError('signature_invalid'));

    const wrongKey = { ...signed.signature, keyId: 'kite-rollout-fixture-2026-b' };
    expect(() =>
      verifyDisableOnlyRolloutManifestV1({
        ...verificationInput(embedded),
        manifestBytes: signed.manifestBytes,
        signatureBytes: encodeSyntheticRolloutSignatureV1(wrongKey),
      }),
    ).toThrow(new DisableOnlyRolloutError('signature_invalid'));
  });

  test('enforces expiry, bounded clock skew, lifetime and overlapping fixture-key rotation', () => {
    const embedded = broadProfile();
    expectVerifyFailure(
      fixture({ issuedAt: '2026-08-02T12:05:00.001Z', expiresAt: '2026-08-03T00:00:00.000Z' }),
      embedded,
      'time_invalid',
    );
    expectVerifyFailure(
      fixture({ issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: NOW.toISOString() }),
      embedded,
      'time_invalid',
    );
    expectVerifyFailure(
      fixture({ issuedAt: '2026-08-02T00:00:00.000Z', expiresAt: '2026-08-10T00:00:00.001Z' }),
      embedded,
      'time_invalid',
    );

    for (const keyId of ['kite-rollout-fixture-2026-a', 'kite-rollout-fixture-2026-b'] as const) {
      expect(
        verifyDisableOnlyRolloutManifestV1({
          ...verificationInput(embedded),
          ...fixture({ keyId }),
        }).manifest.keyId,
      ).toBe(keyId);
    }
  });

  test('rejects replay/downgrade and uses the newer valid identity-bound cache', () => {
    const embedded = broadProfile();
    const newer = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'available', ...fixture({ sequence: 2, cohortPercent: 10 }) },
    });
    if (newer.status !== 'applied') throw new Error('expected newer rollout application');

    const replay = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      cachedRecord: newer.cacheRecord,
      remote: { status: 'available', ...fixture({ sequence: 1, cohortPercent: 25 }) },
    });
    expect(replay.status).toBe('applied');
    if (replay.status !== 'applied') throw new Error('expected cached rollout application');
    expect(replay.source).toBe('cache');
    expect(replay.sequence).toBe(2);
    expect(replay.cohortPercent).toBe(10);

    const expiredHighWater = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: true,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: new Date('2026-08-04T00:00:00.000Z'),
      cachedRecord: newer.cacheRecord,
      remote: {
        status: 'available',
        ...fixture({
          sequence: 1,
          issuedAt: '2026-08-03T00:00:00.000Z',
          expiresAt: '2026-08-05T00:00:00.000Z',
        }),
      },
    });
    expect(expiredHighWater.status).toBe('denied');
  });

  test('uses embedded ceiling for optional outage and denies mandatory admin without valid cache', () => {
    const embedded = broadProfile();
    const optional = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'unavailable' },
    });
    expect(optional.status).toBe('embedded_ceiling');

    const mandatory = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: true,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'unavailable' },
    });
    expect(mandatory).toEqual({
      status: 'denied',
      source: 'mandatory_admin',
      reason: 'valid_identity_bound_rollout_unavailable',
    });
  });

  test('rejects cache identity drift and expired or tampered cached signatures', () => {
    const embedded = broadProfile();
    const applied = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'available', ...fixture() },
    });
    if (applied.status !== 'applied') throw new Error('expected rollout application');

    expect(() =>
      decodeIdentityBoundRolloutCacheV1({
        record: applied.cacheRecord,
        expectedIdentity: { ...ARTIFACT_IDENTITY, payloadSha256: B },
      }),
    ).toThrow(new RolloutCacheError('cache_identity_mismatch'));

    const tampered = {
      ...applied.cacheRecord,
      signatureBase64: Buffer.from('tampered').toString('base64'),
    };
    expect(
      resolveDisableOnlyRolloutV1({
        enabled: true,
        mandatoryAdmin: true,
        embeddedProfile: embedded,
        embeddedCohortPercent: 50,
        expectedIdentity: ARTIFACT_IDENTITY,
        now: NOW,
        cachedRecord: tampered,
        remote: { status: 'unavailable' },
      }).status,
    ).toBe('denied');

    expect(
      resolveDisableOnlyRolloutV1({
        enabled: true,
        mandatoryAdmin: true,
        embeddedProfile: embedded,
        embeddedCohortPercent: 50,
        expectedIdentity: ARTIFACT_IDENTITY,
        now: new Date('2026-08-04T00:00:00.000Z'),
        cachedRecord: applied.cacheRecord,
        remote: { status: 'unavailable' },
      }).status,
    ).toBe('denied');
  });

  test('persists canonical owner-only cache and refuses symlink targets', () => {
    const embedded = broadProfile();
    const applied = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'available', ...fixture() },
    });
    if (applied.status !== 'applied') throw new Error('expected rollout application');
    const root = mkdtempSync(join(tmpdir(), 'kite-rollout-cache-'));
    roots.push(root);
    const cachePath = join(root, 'cache', 'rollout.json');
    writeRolloutCacheFileV1(cachePath, applied.cacheRecord);
    expect(loadRolloutCacheFileV1(cachePath)).toEqual(applied.cacheRecord);
    if (process.platform !== 'win32') {
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    }
    writeRolloutCacheFileV1(cachePath, applied.cacheRecord);

    const newer = resolveDisableOnlyRolloutV1({
      enabled: true,
      mandatoryAdmin: false,
      embeddedProfile: embedded,
      embeddedCohortPercent: 50,
      expectedIdentity: ARTIFACT_IDENTITY,
      now: NOW,
      remote: { status: 'available', ...fixture({ sequence: 2 }) },
    });
    if (newer.status !== 'applied') throw new Error('expected newer rollout application');
    writeRolloutCacheFileV1(cachePath, newer.cacheRecord);
    expect(() => writeRolloutCacheFileV1(cachePath, applied.cacheRecord)).toThrow(
      new RolloutCacheError('cache_invalid'),
    );

    if (process.platform !== 'win32') {
      const symlinkPath = join(root, 'rollout-link.json');
      symlinkSync(cachePath, symlinkPath);
      expect(() => writeRolloutCacheFileV1(symlinkPath, applied.cacheRecord)).toThrow(
        new RolloutCacheError('cache_io'),
      );
      expect(() => loadRolloutCacheFileV1(symlinkPath)).toThrow(new RolloutCacheError('cache_io'));
    }
  });
});

function broadProfile(): ReleaseProfileV1 {
  const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_V1['limited-production']);
  profile.capabilities = Object.fromEntries(
    RELEASE_CAPABILITIES.map((capability) => [
      capability,
      { maturity: 'stable', maxRollout: 'general' },
    ]),
  ) as Record<ReleaseCapability, { maturity: 'stable'; maxRollout: 'general' }>;
  profile.safety.networkMode = 'allowlist';
  profile.safety.networkAllowlist = ['api.example.test', 'mcp.example.test'];
  profile.safety.mcpProviderAllowlist = ['mcp-a', 'mcp-b'];
  profile.data.providerRouteAllowlist = ['route-a', 'route-b'];
  return parseReleaseProfileV1(profile);
}

function fixture(
  overrides: {
    sequence?: number;
    issuedAt?: string;
    expiresAt?: string;
    keyId?: 'kite-rollout-fixture-2026-a' | 'kite-rollout-fixture-2026-b';
    cohortPercent?: number;
    maxRollout?: Record<string, 'off' | 'internal' | 'canary' | 'general'>;
    networkAllowlist?: string[];
  } = {},
) {
  return signSyntheticRolloutManifestV1({
    version: 1,
    kind: 'disable-only-rollout-manifest-v1',
    artifactIdentity: ARTIFACT_IDENTITY,
    sequence: overrides.sequence ?? 1,
    issuedAt: overrides.issuedAt ?? '2026-08-02T00:00:00.000Z',
    expiresAt: overrides.expiresAt ?? '2026-08-03T00:00:00.000Z',
    keyId: overrides.keyId ?? 'kite-rollout-fixture-2026-a',
    restrictions: {
      disableCapabilities: ['shell'],
      maxRollout: overrides.maxRollout ?? { plan: 'internal' },
      cohortPercent: overrides.cohortPercent ?? 25,
      networkAllowlist: overrides.networkAllowlist ?? ['api.example.test'],
      mcpProviderAllowlist: ['mcp-a'],
      providerRouteAllowlist: ['route-a'],
    },
    synthetic: true,
    nonDistributable: true,
    realRolloutSigningEnabled: false,
  });
}

function verificationInput(embeddedProfile: ReleaseProfileV1) {
  return {
    expectedIdentity: ARTIFACT_IDENTITY,
    embeddedProfile,
    embeddedCohortPercent: 50,
    now: NOW,
  };
}

function expectVerifyFailure(
  signed: ReturnType<typeof fixture>,
  embedded: ReleaseProfileV1,
  code: DisableOnlyRolloutError['code'],
): void {
  expect(() =>
    verifyDisableOnlyRolloutManifestV1({
      ...verificationInput(embedded),
      manifestBytes: signed.manifestBytes,
      signatureBytes: signed.signatureBytes,
    }),
  ).toThrow(new DisableOnlyRolloutError(code));
}
