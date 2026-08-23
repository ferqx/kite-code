import { describe, expect, test } from 'bun:test';
import {
  type AgentConfig,
  EMBEDDED_RELEASE_PROFILES_,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_,
} from '#app/config';
import { parseArgs } from '../../apps/kite/src/cli/index';
import {
  createReleaseControlledAgentConfig,
  type ReleaseComposition,
  resolveReleaseComposition,
} from '../../apps/kite/src/release/composition-root';
import {
  formatReleaseStatus,
  projectReleaseStatus,
} from '../../apps/kite/src/release/status-projection';

function config(releaseProfile = false): AgentConfig {
  return {
    apiKey: 'must-not-appear',
    baseURL: 'https://secret-route.example.test',
    modelName: 'private-model',
    providerName: 'private-provider',
    providerType: 'openai-compatible',
    features: { releaseProfile },
    sandbox: { enabled: true },
  };
}

describe('App release composition and status projection', () => {
  test('keeps ordinary development entrypoints inactive without artifact authority', () => {
    const composition = resolveReleaseComposition({
      config: config(true),
      artifactReleaseProfileV1Enabled: false,
      profileId: 'internal-dogfood',
      production: false,
    });
    expect(composition).toEqual({
      version: 1,
      active: false,
      production: false,
      reason: 'artifact_disabled',
    });
    expect(formatReleaseStatus(projectReleaseStatus({ composition }))).toContain(
      'Release control: inactive (artifact_disabled)',
    );
  });

  test('composes an artifact-authorized internal ceiling before Runtime creation', () => {
    const composition = resolveReleaseComposition({
      config: config(true),
      artifactReleaseProfileV1Enabled: true,
      profileId: 'internal-dogfood',
      production: false,
      restrictionLayers: [
        {
          source: 'project',
          restrictions: { resources: { maxTurns: 0 }, telemetry: { allowed: false } },
        },
      ],
    });
    expect(composition.active).toBe(true);
    const controlled = createReleaseControlledAgentConfig({
      config: config(true),
      composition,
    });
    expect(controlled.releaseControl.effectiveProfile.profileId).toBe('internal-dogfood');
    expect(
      Object.values(controlled.releaseControl.effectiveProfile.capabilities).every(
        ({ maxRollout }) => maxRollout === 'off',
      ),
    ).toBe(true);
  });

  test('keeps distribution candidates separate from artifact authority and execution support', () => {
    const composition = resolveReleaseComposition({
      config: config(true),
      artifactReleaseProfileV1Enabled: true,
      profileId: 'limited-production',
      production: true,
      distributionTargetIdentity: 'ubuntu-24.04-x64',
    });
    expect(composition).toEqual({
      version: 1,
      active: false,
      production: true,
      reason: 'production_artifact_authority_unconfigured',
    });
    expect(SUPPORTED_PRODUCTION_EXECUTION_TARGETS_).toEqual([]);
  });

  test('rejects every production profile before an authenticated artifact receipt exists', () => {
    expect(
      resolveReleaseComposition({
        config: config(true),
        artifactReleaseProfileV1Enabled: true,
        profileId: 'limited-production',
        production: true,
      }),
    ).toEqual({
      version: 1,
      active: false,
      production: true,
      reason: 'production_artifact_authority_unconfigured',
    });
    expect(
      resolveReleaseComposition({
        config: config(true),
        artifactReleaseProfileV1Enabled: true,
        profileId: 'internal-dogfood',
        production: true,
        distributionTargetIdentity: 'macos-15-arm64',
      }),
    ).toEqual({
      version: 1,
      active: false,
      production: true,
      reason: 'production_artifact_authority_unconfigured',
    });
  });

  test('controlled config revalidates forged active production compositions', () => {
    const forgedInternal = {
      version: 1,
      active: true,
      production: true,
      distributionTargetIdentity: 'macos-15-arm64',
      profile: EMBEDDED_RELEASE_PROFILES_['internal-dogfood'],
    } as const satisfies ReleaseComposition;
    expect(() =>
      createReleaseControlledAgentConfig({
        config: config(true),
        composition: forgedInternal,
      }),
    ).toThrow('production_artifact_authority_unconfigured');

    const forgedMissingIdentity = {
      version: 1,
      active: true,
      production: true,
      profile: EMBEDDED_RELEASE_PROFILES_['limited-production'],
    } as unknown as ReleaseComposition;
    expect(() =>
      createReleaseControlledAgentConfig({
        config: config(true),
        composition: forgedMissingIdentity,
      }),
    ).toThrow('production_artifact_authority_unconfigured');

    const forgedUnsupportedIdentity = {
      version: 1,
      active: true,
      production: true,
      distributionTargetIdentity: 'future-supported-target',
      profile: EMBEDDED_RELEASE_PROFILES_['limited-production'],
    } as unknown as ReleaseComposition;
    expect(() =>
      createReleaseControlledAgentConfig({
        config: config(true),
        composition: forgedUnsupportedIdentity,
      }),
    ).toThrow('production_artifact_authority_unconfigured');

    const forgedEnabledCapability = structuredClone(
      EMBEDDED_RELEASE_PROFILES_['limited-production'],
    );
    forgedEnabledCapability.capabilities.shell = {
      maturity: 'experimental',
      maxRollout: 'canary',
    };
    expect(() =>
      createReleaseControlledAgentConfig({
        config: config(true),
        composition: {
          version: 1,
          active: true,
          production: true,
          distributionTargetIdentity: 'ubuntu-24.04-x64',
          profile: forgedEnabledCapability,
        },
      }),
    ).toThrow('production_artifact_authority_unconfigured');
  });

  test('status reveals release decisions but no credentials, paths, or route identities', () => {
    const composition = resolveReleaseComposition({
      config: config(true),
      artifactReleaseProfileV1Enabled: true,
      profileId: 'internal-dogfood',
      production: false,
    });
    const serialized = JSON.stringify(projectReleaseStatus({ composition }));
    expect(serialized).toContain('internal-dogfood');
    expect(serialized).not.toContain('must-not-appear');
    expect(serialized).not.toContain('secret-route');
    expect(serialized).not.toContain('private-provider');
  });

  test('CLI can tighten releaseProfile but cannot grant artifact authority', () => {
    expect(() => parseArgs(['run', '--feature', 'releaseProfile=true'])).toThrow(
      'release-controlled',
    );
    expect(parseArgs(['run', '--feature', 'releaseProfile=false']).featureOverrides).toEqual({
      releaseProfile: false,
    });
    expect(parseArgs(['run', '--release-status']).releaseStatus).toBe(true);
  });
});
