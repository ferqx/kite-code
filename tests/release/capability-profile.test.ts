import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CapabilityProfile,
  evaluateCapabilityProfileAdmission,
  parseCapabilityProfile,
} from '#kite-service/config/release-capabilities';

const profilePaths = [
  'auto-compaction.json',
  'manual-compaction.json',
  'mcp-write.json',
  'skills-effectful.json',
  'skills-readonly.json',
  'verification.json',
] as const;

function loadProfile(name: (typeof profilePaths)[number]): CapabilityProfile {
  return parseCapabilityProfile(
    JSON.parse(
      readFileSync(join(import.meta.dir, '../../release/capability-profiles', name), 'utf8'),
    ),
  );
}

describe('capability profile contract', () => {
  test('ships every local capability track off without maturity evidence', () => {
    const profiles = profilePaths.map(loadProfile);
    expect(profiles.map(({ capability }) => capability).sort()).toEqual([
      'auto_compaction',
      'manual_compaction',
      'mcp_write',
      'skills_effectful',
      'skills_readonly',
      'verification',
    ]);
    for (const profile of profiles) {
      expect(profile.state).toEqual({ maturity: 'under_development', maxRollout: 'off' });
      expect(profile.routeAllowlist).toEqual([]);
      expect(profile.platformAllowlist).toEqual([]);
      expect(profile.evidence).toEqual({
        freshnessSeconds: 0,
        requiredGates: ['G3', 'G4', 'G5'],
      });
      expect(profile.rollback).toEqual({
        disableNewAdmission: true,
        preserveReceipts: true,
        preserveRequiredVerification: true,
        cohortPercent: 0,
      });
    }
  });

  test('is strict, canonical, and requires explicit platform/freshness before enabling', () => {
    const profile = structuredClone(loadProfile('verification.json')) as CapabilityProfile & {
      unknown?: boolean;
    };
    profile.unknown = true;
    expect(() => parseCapabilityProfile(profile)).toThrow();

    const enabled = structuredClone(loadProfile('verification.json'));
    enabled.state = { maturity: 'experimental', maxRollout: 'internal' };
    expect(() => parseCapabilityProfile(enabled)).toThrow(
      'enabled capability profiles require an explicit platform allowlist',
    );

    const unsorted = structuredClone(loadProfile('verification.json'));
    unsorted.dependencies.reverse();
    expect(() => parseCapabilityProfile(unsorted)).toThrow(
      'dependencies must be unique and sorted',
    );

    const nonCanonical = structuredClone(loadProfile('verification.json'));
    nonCanonical.profileId = ' verification-v1';
    expect(() => parseCapabilityProfile(nonCanonical)).toThrow(
      'identities must not contain surrounding whitespace',
    );
  });

  test('fails closed for disabled feature, embedded off ceiling, and unknown dependencies', () => {
    const profile = loadProfile('verification.json');
    const decision = evaluateCapabilityProfileAdmission({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verification: false },
      dependencies: {},
    });
    expect(decision).toEqual({
      admitted: false,
      capability: 'verification',
      maturity: 'under_development',
      rollout: 'off',
      reasons: [
        'dependency_unknown',
        'embedded_ceiling_off',
        'feature_disabled',
        'profile_rollout_off',
      ],
      unknownDependencies: ['runtime.required-verification', 'runtime.schema'],
    });
  });

  test('cannot widen the embedded ceiling even when every dependency is ready', () => {
    const candidate = structuredClone(loadProfile('verification.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfile(candidate);
    const dependencies = Object.fromEntries(
      profile.dependencies.map(({ dependencyId, expectedRevision }) => [
        dependencyId,
        { status: 'ready' as const, revision: expectedRevision },
      ]),
    );
    const decision = evaluateCapabilityProfileAdmission({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verification: true },
      dependencies,
      platform: 'linux-x64',
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toEqual([
      'embedded_ceiling_off',
      'evidence_unknown',
      'maturity_exceeds_embedded_ceiling',
      'rollout_exceeds_embedded_ceiling',
    ]);
  });

  test('requires exact dependency revisions and admitted platform identity', () => {
    const candidate = structuredClone(loadProfile('verification.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfile(candidate);
    const decision = evaluateCapabilityProfileAdmission({
      profile,
      embeddedCeiling: { maturity: 'experimental', maxRollout: 'canary' },
      features: { verification: true },
      dependencies: {
        'runtime.required-verification': { status: 'ready', revision: 'stale' },
        'runtime.schema': { status: 'blocked', revision: '21' },
      },
      platform: 'darwin-arm64',
    });
    expect(decision).toMatchObject({
      admitted: false,
      reasons: [
        'dependency_blocked',
        'dependency_revision_mismatch',
        'evidence_unknown',
        'platform_not_admitted',
      ],
    });
  });

  test('admits only when every feature, dependency, Gate, platform, and freshness fact passes', () => {
    const candidate = structuredClone(loadProfile('verification.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfile(candidate);
    const dependencies = Object.fromEntries(
      profile.dependencies.map(({ dependencyId, expectedRevision }) => [
        dependencyId,
        { status: 'ready' as const, revision: expectedRevision },
      ]),
    );
    expect(
      evaluateCapabilityProfileAdmission({
        profile,
        embeddedCeiling: { maturity: 'experimental', maxRollout: 'canary' },
        features: { verification: true },
        dependencies,
        platform: 'linux-x64',
        evidence: {
          ageSeconds: 60,
          gates: { G3: 'passed', G4: 'passed', G5: 'passed' },
        },
      }),
    ).toMatchObject({ admitted: true, reasons: [] });
  });
});
