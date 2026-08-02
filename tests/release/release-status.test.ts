import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/app/cli/index';
import {
  createReleaseControlledAgentConfigV1,
  resolveReleaseCompositionV1,
} from '../../src/app/release/composition-root';
import {
  formatReleaseStatusV1,
  projectReleaseStatusV1,
} from '../../src/app/release/status-projection';
import type { AgentConfig } from '../../src/core/config';

function config(releaseProfileV1 = false): AgentConfig {
  return {
    apiKey: 'must-not-appear',
    baseURL: 'https://secret-route.example.test',
    modelName: 'private-model',
    providerName: 'private-provider',
    providerType: 'openai-compatible',
    features: { releaseProfileV1 },
    sandbox: { enabled: true },
  };
}

describe('App release composition and status projection', () => {
  test('keeps ordinary development entrypoints inactive without artifact authority', () => {
    const composition = resolveReleaseCompositionV1({
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
    expect(formatReleaseStatusV1(projectReleaseStatusV1({ composition }))).toContain(
      'Release control: inactive (artifact_disabled)',
    );
  });

  test('composes an artifact-authorized internal ceiling before Runtime creation', () => {
    const composition = resolveReleaseCompositionV1({
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
    const controlled = createReleaseControlledAgentConfigV1({
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

  test('blocks production composition while D-04 support remains empty', () => {
    const composition = resolveReleaseCompositionV1({
      config: config(true),
      artifactReleaseProfileV1Enabled: true,
      profileId: 'limited-production',
      production: true,
    });
    expect(composition).toEqual({
      version: 1,
      active: false,
      production: true,
      reason: 'production_support_set_empty',
    });
    expect(() =>
      createReleaseControlledAgentConfigV1({ config: config(true), composition }),
    ).toThrow('production_support_set_empty');
  });

  test('status reveals release decisions but no credentials, paths, or route identities', () => {
    const composition = resolveReleaseCompositionV1({
      config: config(true),
      artifactReleaseProfileV1Enabled: true,
      profileId: 'internal-dogfood',
      production: false,
    });
    const serialized = JSON.stringify(projectReleaseStatusV1({ composition }));
    expect(serialized).toContain('internal-dogfood');
    expect(serialized).not.toContain('must-not-appear');
    expect(serialized).not.toContain('secret-route');
    expect(serialized).not.toContain('private-provider');
  });

  test('CLI can tighten releaseProfileV1 but cannot grant artifact authority', () => {
    expect(() => parseArgs(['run', '--feature', 'releaseProfileV1=true'])).toThrow(
      'release-controlled',
    );
    expect(parseArgs(['run', '--feature', 'releaseProfileV1=false']).featureOverrides).toEqual({
      releaseProfileV1: false,
    });
    expect(parseArgs(['run', '--release-status']).releaseStatus).toBe(true);
  });
});
