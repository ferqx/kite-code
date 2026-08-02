import { describe, expect, test } from 'bun:test';
import { verifyGaCompatibilityFixtureV1 } from '../../scripts/release/ga-compatibility';

const digest = `sha256:${'c'.repeat(64)}` as const;
const facts = [
  {
    kind: 'transcript',
    factId: 'thread-structure',
    digest,
    status: 'active',
    externalEffect: false,
    replayed: false,
  },
  {
    kind: 'verification',
    factId: 'required-check',
    digest,
    status: 'required',
    externalEffect: false,
    replayed: false,
  },
  {
    kind: 'receipt',
    factId: 'unknown-write',
    digest,
    status: 'unknown',
    externalEffect: true,
    replayed: false,
  },
] as const;
const fixture = {
  schema: 'GACompatibilityFixtureV1',
  fixtureClass: 'synthetic_contract_only',
  fromArtifactDigest: digest,
  gaArtifactDigest: digest,
  rollbackArtifactDigest: digest,
  fromRuntimeSchema: 21,
  gaRuntimeSchema: 22,
  rollbackRuntimeSchema: 21,
  beforeFacts: facts,
  afterUpgradeFacts: facts,
  afterRollbackFacts: facts,
  disabledCapabilities: ['mcp_write', 'skills_effectful', 'auto_compaction'],
  newAdmissionsForDisabledCapabilities: 0,
} as const;

describe('GA upgrade/downgrade compatibility contract', () => {
  test('preserves durable facts and never treats synthetic replay as production evidence', () => {
    expect(verifyGaCompatibilityFixtureV1(fixture)).toMatchObject({
      status: 'contract_replay_passed',
      fixtureClass: 'synthetic_contract_only',
      productionEvidence: false,
      durableFactsPreserved: true,
      unknownExternalEffectsReplayed: 0,
      newAdmissionsForDisabledCapabilities: 0,
    });
  });

  test('rejects deleted required Verification and replayed unknown external effects', () => {
    expect(() =>
      verifyGaCompatibilityFixtureV1({
        ...fixture,
        afterRollbackFacts: facts.filter((fact) => fact.kind !== 'verification'),
      }),
    ).toThrow('deleted');
    expect(() =>
      verifyGaCompatibilityFixtureV1({
        ...fixture,
        afterUpgradeFacts: facts.map((fact) =>
          fact.factId === 'unknown-write' ? { ...fact, replayed: true } : fact,
        ),
      }),
    ).toThrow('was replayed');
  });

  test('rejects schema downgrade drift and hidden fields', () => {
    expect(() => verifyGaCompatibilityFixtureV1({ ...fixture, rollbackRuntimeSchema: 20 })).toThrow(
      'exact source Runtime schema',
    );
    expect(() => verifyGaCompatibilityFixtureV1({ ...fixture, hiddenMigration: true })).toThrow();
  });
});
