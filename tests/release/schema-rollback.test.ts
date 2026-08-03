import { describe, expect, test } from 'bun:test';
import { verifyReleaseSchemaRollbackFixtureV1 } from '../../scripts/release/schema-rollback';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const facts = [
  {
    kind: 'session',
    factId: 'thread-structure',
    digest: digest('1'),
    status: 'active',
    externalEffect: false,
    replayed: false,
  },
  {
    kind: 'verification',
    factId: 'required-check',
    digest: digest('2'),
    status: 'required',
    externalEffect: false,
    replayed: false,
  },
  {
    kind: 'receipt',
    factId: 'unknown-write',
    digest: digest('3'),
    status: 'unknown',
    externalEffect: true,
    replayed: false,
  },
] as const;

const fixture = {
  schema: 'ReleaseSchemaRollbackFixtureV1',
  fixtureClass: 'synthetic_contract_only',
  sourceSchemaVersion: 21,
  candidateSchemaVersion: 22,
  rollbackSchemaVersion: 21,
  sourceArtifactDigest: digest('4'),
  candidateArtifactDigest: digest('5'),
  rollbackArtifactDigest: digest('4'),
  before: facts,
  afterUpgrade: facts,
  afterRollback: facts,
  backupCreated: true,
  irreversibleMigrationCount: 0,
} as const;

describe('Release schema rollback rehearsal', () => {
  test('preserves durable facts but never upgrades synthetic rehearsal to production evidence', () => {
    expect(verifyReleaseSchemaRollbackFixtureV1(fixture)).toMatchObject({
      status: 'contract_replay_passed',
      fixtureClass: 'synthetic_contract_only',
      productionEvidence: false,
      durableFactsPreserved: true,
      unknownExternalEffectsReplayed: 0,
      rollbackSchemaRestored: true,
    });
  });

  test('rejects deleted durable facts and replayed unknown external effects', () => {
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({
        ...fixture,
        afterRollback: facts.filter((fact) => fact.kind !== 'verification'),
      }),
    ).toThrow('deleted');
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({
        ...fixture,
        afterUpgrade: facts.map((fact) =>
          fact.factId === 'unknown-write' ? { ...fact, replayed: true } : fact,
        ),
      }),
    ).toThrow('must never be replayed');
  });

  test('rejects semantic fact mutation, injected facts, and artifact identity drift', () => {
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({
        ...fixture,
        afterUpgrade: facts.map((fact) =>
          fact.factId === 'unknown-write'
            ? { ...fact, status: 'succeeded', externalEffect: false, replayed: true }
            : fact,
        ),
      }),
    ).toThrow('changed during schema upgrade');
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({
        ...fixture,
        afterRollback: [
          ...facts,
          {
            kind: 'checkpoint',
            factId: 'injected',
            digest: digest('9'),
            status: 'complete',
            externalEffect: false,
            replayed: false,
          },
        ],
      }),
    ).toThrow('cannot inject or delete');
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({
        ...fixture,
        rollbackArtifactDigest: digest('9'),
      }),
    ).toThrow('exact source artifact identity');
  });

  test('rejects a rollback to the wrong schema or injected fields', () => {
    expect(() =>
      verifyReleaseSchemaRollbackFixtureV1({ ...fixture, rollbackSchemaVersion: 20 }),
    ).toThrow('exact source Runtime schema');
    expect(() => verifyReleaseSchemaRollbackFixtureV1({ ...fixture, hiddenGrant: true })).toThrow();
  });
});
