import { describe, expect, test } from 'bun:test';
import {
  admitEmbeddedReleaseProfileV1,
  EMBEDDED_RELEASE_PROFILES_V1,
  ProductionReleaseProfileAdmissionError,
  parseReleaseProfileV1,
  RELEASE_CAPABILITIES,
  SUPPORTED_PRODUCTION_RELEASE_TARGETS_V1,
} from '../../src/core/config';
import { getFeatureFlags } from '../../src/core/config/features';

describe('ReleaseProfileV1', () => {
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
    const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_V1['limited-production']);
    profile.capabilities.plan = { maturity: 'stable', maxRollout: 'canary' };
    expect(parseReleaseProfileV1(profile).capabilities.plan).toEqual({
      maturity: 'stable',
      maxRollout: 'canary',
    });

    profile.capabilities.plan = { maturity: 'under_development', maxRollout: 'internal' };
    expect(() => parseReleaseProfileV1(profile)).toThrow(
      'under_development capabilities cannot roll out to internal',
    );
    profile.capabilities.plan = { maturity: 'experimental', maxRollout: 'general' };
    expect(() => parseReleaseProfileV1(profile)).toThrow(
      'experimental capabilities cannot roll out to general',
    );
  });

  test('rejects non-finite, negative, fractional and unknown security fields', () => {
    for (const invalid of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_V1['internal-dogfood']);
      profile.resources.maxTurns = invalid;
      expect(() => parseReleaseProfileV1(profile)).toThrow();
    }

    const unknownNested = structuredClone(
      EMBEDDED_RELEASE_PROFILES_V1['internal-dogfood'],
    ) as unknown as Record<string, unknown>;
    (unknownNested.safety as Record<string, unknown>).allowUnknownFutureBoundary = true;
    expect(() => parseReleaseProfileV1(unknownNested)).toThrow();

    const missingCapability = structuredClone(
      EMBEDDED_RELEASE_PROFILES_V1['internal-dogfood'],
    ) as unknown as { capabilities: Record<string, unknown> };
    delete missingCapability.capabilities.shell;
    expect(() => parseReleaseProfileV1(missingCapability)).toThrow();
  });

  test('ships four fail-closed embedded ceilings under the D-04 empty support set', () => {
    expect(Object.keys(EMBEDDED_RELEASE_PROFILES_V1).sort()).toEqual([
      'capability-canary',
      'general-availability',
      'internal-dogfood',
      'limited-production',
    ]);
    expect(SUPPORTED_PRODUCTION_RELEASE_TARGETS_V1).toEqual([]);
    for (const profile of Object.values(EMBEDDED_RELEASE_PROFILES_V1)) {
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

  test('defaults the flag off and rejects production before composition starts', () => {
    expect(getFeatureFlags().releaseProfileV1).toBe(false);
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'internal-dogfood',
        releaseProfileV1Enabled: false,
      }),
    ).toThrow(ProductionReleaseProfileAdmissionError);
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
      }),
    ).toThrow('production_support_set_empty');

    const internal = admitEmbeddedReleaseProfileV1({
      profileId: 'internal-dogfood',
      releaseProfileV1Enabled: true,
    });
    expect(internal.channel).toBe('internal');
  });

  test('requires production to use a supported non-internal identity', () => {
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'internal-dogfood',
        releaseProfileV1Enabled: true,
        production: true,
        productionSupportIdentity: 'future-supported-target',
      }),
    ).toThrow('production_internal_profile');
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
        production: true,
      }),
    ).toThrow('production_support_identity_missing');
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'limited-production',
        releaseProfileV1Enabled: true,
        production: true,
        productionSupportIdentity: 'future-supported-target',
      }),
    ).toThrow('production_support_set_empty');
  });

  test('allows no unknown embedded profile identity', () => {
    expect(() =>
      admitEmbeddedReleaseProfileV1({
        profileId: 'unknown' as 'internal-dogfood',
        releaseProfileV1Enabled: true,
      }),
    ).toThrow('profile_not_embedded');
  });
});
