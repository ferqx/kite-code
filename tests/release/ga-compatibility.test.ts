import { describe, expect, test } from 'bun:test';
import { verifyGaCompatibilityFixture } from '../../scripts/release/ga-compatibility';

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
  schema: 'GACompatibilityFixture',
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
    expect(verifyGaCompatibilityFixture(fixture)).toMatchObject({
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
      verifyGaCompatibilityFixture({
        ...fixture,
        afterRollbackFacts: facts.filter((fact) => fact.kind !== 'verification'),
      }),
    ).toThrow('deleted');
    expect(() =>
      verifyGaCompatibilityFixture({
        ...fixture,
        afterUpgradeFacts: facts.map((fact) =>
          fact.factId === 'unknown-write' ? { ...fact, replayed: true } : fact,
        ),
      }),
    ).toThrow('was replayed');
  });

  test('rejects schema downgrade drift and hidden fields', () => {
    expect(() => verifyGaCompatibilityFixture({ ...fixture, rollbackRuntimeSchema: 20 })).toThrow(
      'exact source Runtime schema',
    );
    expect(() => verifyGaCompatibilityFixture({ ...fixture, hiddenMigration: true })).toThrow();
  });
});
