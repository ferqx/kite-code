import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CapabilityProfileV1,
  evaluateCapabilityProfileAdmissionV1,
  parseCapabilityProfileV1,
} from '#app/config/release-capabilities';

const profilePaths = [
  'auto-compaction-v1.json',
  'manual-compaction-v1.json',
  'mcp-write-v1.json',
  'skills-effectful-v1.json',
  'skills-readonly-v1.json',
  'verification-v1.json',
] as const;

function loadProfile(name: (typeof profilePaths)[number]): CapabilityProfileV1 {
  return parseCapabilityProfileV1(
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
    const profile = structuredClone(loadProfile('verification-v1.json')) as CapabilityProfileV1 & {
      unknown?: boolean;
    };
    profile.unknown = true;
    expect(() => parseCapabilityProfileV1(profile)).toThrow();

    const enabled = structuredClone(loadProfile('verification-v1.json'));
    enabled.state = { maturity: 'experimental', maxRollout: 'internal' };
    expect(() => parseCapabilityProfileV1(enabled)).toThrow(
      'enabled capability profiles require an explicit platform allowlist',
    );

    const unsorted = structuredClone(loadProfile('verification-v1.json'));
    unsorted.dependencies.reverse();
    expect(() => parseCapabilityProfileV1(unsorted)).toThrow(
      'dependencies must be unique and sorted',
    );

    const nonCanonical = structuredClone(loadProfile('verification-v1.json'));
    nonCanonical.profileId = ' verification-v1';
    expect(() => parseCapabilityProfileV1(nonCanonical)).toThrow(
      'identities must not contain surrounding whitespace',
    );
  });

  test('fails closed for disabled feature, embedded off ceiling, and unknown dependencies', () => {
    const profile = loadProfile('verification-v1.json');
    const decision = evaluateCapabilityProfileAdmissionV1({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verificationV1: false },
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
    const candidate = structuredClone(loadProfile('verification-v1.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfileV1(candidate);
    const dependencies = Object.fromEntries(
      profile.dependencies.map(({ dependencyId, expectedRevision }) => [
        dependencyId,
        { status: 'ready' as const, revision: expectedRevision },
      ]),
    );
    const decision = evaluateCapabilityProfileAdmissionV1({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verificationV1: true },
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
    const candidate = structuredClone(loadProfile('verification-v1.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfileV1(candidate);
    const decision = evaluateCapabilityProfileAdmissionV1({
      profile,
      embeddedCeiling: { maturity: 'experimental', maxRollout: 'canary' },
      features: { verificationV1: true },
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
    const candidate = structuredClone(loadProfile('verification-v1.json'));
    candidate.state = { maturity: 'experimental', maxRollout: 'internal' };
    candidate.platformAllowlist = ['linux-x64'];
    candidate.evidence.freshnessSeconds = 86_400;
    const profile = parseCapabilityProfileV1(candidate);
    const dependencies = Object.fromEntries(
      profile.dependencies.map(({ dependencyId, expectedRevision }) => [
        dependencyId,
        { status: 'ready' as const, revision: expectedRevision },
      ]),
    );
    expect(
      evaluateCapabilityProfileAdmissionV1({
        profile,
        embeddedCeiling: { maturity: 'experimental', maxRollout: 'canary' },
        features: { verificationV1: true },
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
