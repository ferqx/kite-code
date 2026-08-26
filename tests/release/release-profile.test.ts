import { describe, expect, test } from 'bun:test';
import {
  admitEmbeddedReleaseProfile,
  EMBEDDED_RELEASE_PROFILES_,
  PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_,
  PRODUCTION_DISTRIBUTION_TARGETS_,
  ProductionReleaseProfileAdmissionError,
  parseReleaseProfile,
  RELEASE_CAPABILITIES,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_,
} from '#kite-cli/config';
import { getFeatureFlags } from '#kite-cli/config/features';

describe('ReleaseProfile', () => {
  test('keeps the release capability identifiers stable', () => {
    expect(RELEASE_CAPABILITIES).toEqual([
      'builtin_read_tools',
      'builtin_write_tools',
      'shell',
      'plan',
      'tool_search',
      'mcp_read',
      'mcp_write',
      'skills_readonly',
      'skills_effectful',
      'verification',
      'manual_compaction',
      'auto_compaction',
      'full_interaction_mode',
      'content_session_logging',
      'remote_telemetry',
    ]);
  });

  test('validates maturity and rollout independently while rejecting illegal pairs', () => {
    const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_['limited-production']);
    profile.capabilities.plan = { maturity: 'stable', maxRollout: 'canary' };
    expect(parseReleaseProfile(profile).capabilities.plan).toEqual({
      maturity: 'stable',
      maxRollout: 'canary',
    });

    profile.capabilities.plan = { maturity: 'under_development', maxRollout: 'internal' };
    expect(() => parseReleaseProfile(profile)).toThrow(
      'under_development capabilities cannot roll out to internal',
    );
    profile.capabilities.plan = { maturity: 'experimental', maxRollout: 'general' };
    expect(() => parseReleaseProfile(profile)).toThrow(
      'experimental capabilities cannot roll out to general',
    );
  });

  test('rejects non-finite, negative, fractional and unknown security fields', () => {
    for (const invalid of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_['internal-dogfood']);
      profile.resources.maxTurns = invalid;
      expect(() => parseReleaseProfile(profile)).toThrow();
    }

    const unknownNested = structuredClone(
      EMBEDDED_RELEASE_PROFILES_['internal-dogfood'],
    ) as unknown as Record<string, unknown>;
    (unknownNested.safety as Record<string, unknown>).allowUnknownFutureBoundary = true;
    expect(() => parseReleaseProfile(unknownNested)).toThrow();

    const missingCapability = structuredClone(
      EMBEDDED_RELEASE_PROFILES_['internal-dogfood'],
    ) as unknown as { capabilities: Record<string, unknown> };
    delete missingCapability.capabilities.shell;
    expect(() => parseReleaseProfile(missingCapability)).toThrow();
  });

  test('ships closed distribution identities independently from fail-closed ceilings', () => {
    expect(Object.keys(EMBEDDED_RELEASE_PROFILES_).sort()).toEqual([
      'capability-canary',
      'general-availability',
      'internal-dogfood',
      'limited-production',
    ]);
    expect(PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_).toEqual([
      'macos-15-arm64',
      'ubuntu-24.04-x64',
      'windows-2025-x64',
    ]);
    expect(PRODUCTION_DISTRIBUTION_TARGETS_).toEqual({
      'macos-15-arm64': {
        identity: 'macos-15-arm64',
        platform: 'macos',
        arch: 'arm64',
        nativeRunner: 'macos-15',
      },
      'ubuntu-24.04-x64': {
        identity: 'ubuntu-24.04-x64',
        platform: 'linux',
        arch: 'x64',
        nativeRunner: 'ubuntu-24.04',
      },
      'windows-2025-x64': {
        identity: 'windows-2025-x64',
        platform: 'windows',
        arch: 'x64',
        nativeRunner: 'windows-2025',
      },
    });
    expect(Object.isFrozen(PRODUCTION_DISTRIBUTION_TARGETS_)).toBe(true);
    expect(
      Object.values(PRODUCTION_DISTRIBUTION_TARGETS_).every((target) => Object.isFrozen(target)),
    ).toBe(true);
    expect(SUPPORTED_PRODUCTION_EXECUTION_TARGETS_).toEqual([]);
    for (const profile of Object.values(EMBEDDED_RELEASE_PROFILES_)) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.capabilities)).toBe(true);
      expect(Object.values(profile.capabilities).every((state) => state.maxRollout === 'off')).toBe(
        true,
      );
      expect(Object.values(profile.resources).every((limit) => limit === 0)).toBe(true);
      expect(profile.safety.networkMode).toBe('off');
      expect(profile.data.providerRouteAllowlist).toEqual([]);
    }
  });

  test('defaults the flag off while allowing a non-production profile ceiling', () => {
    expect(getFeatureFlags().releaseProfile).toBe(false);
    expect(() =>
      admitEmbeddedReleaseProfile({
        profileId: 'internal-dogfood',
        releaseProfileV1Enabled: false,
      }),
    ).toThrow(ProductionReleaseProfileAdmissionError);
    expect(
      admitEmbeddedReleaseProfile({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
      }).channel,
    ).toBe('limited');

    const internal = admitEmbeddedReleaseProfile({
      profileId: 'internal-dogfood',
      releaseProfileV1Enabled: true,
    });
    expect(internal.channel).toBe('internal');
  });

  test('requires production to use a closed distribution identity without enabling capabilities', () => {
    expect(() =>
      admitEmbeddedReleaseProfile({
        profileId: 'internal-dogfood',
        releaseProfileV1Enabled: true,
        production: true,
        distributionTargetIdentity: 'macos-15-arm64',
      }),
    ).toThrow('production_internal_profile');
    expect(() =>
      admitEmbeddedReleaseProfile({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
        production: true,
      }),
    ).toThrow('distribution_target_identity_missing');
    expect(() =>
      admitEmbeddedReleaseProfile({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
        production: true,
        distributionTargetIdentity: 'future-supported-target',
      }),
    ).toThrow('distribution_target_identity_unsupported');

    const admitted = admitEmbeddedReleaseProfile({
      profileId: 'limited-production',
      releaseProfileV1Enabled: true,
      production: true,
      distributionTargetIdentity: 'ubuntu-24.04-x64',
    });
    expect(Object.values(admitted.capabilities).every((state) => state.maxRollout === 'off')).toBe(
      true,
    );
    expect(Object.values(admitted.resources).every((limit) => limit === 0)).toBe(true);
    expect(SUPPORTED_PRODUCTION_EXECUTION_TARGETS_).toEqual([]);
  });

  test('allows no unknown embedded profile identity', () => {
    expect(() =>
      admitEmbeddedReleaseProfile({
        profileId: 'unknown' as 'internal-dogfood',
        releaseProfileV1Enabled: true,
      }),
    ).toThrow('profile_not_embedded');
  });
});
