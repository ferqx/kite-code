import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const durableFactSchema = z
  .object({
    kind: z.enum(['session', 'plan', 'verification', 'receipt', 'checkpoint', 'worktree_handoff']),
    factId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    digest: digestSchema,
    status: z.string().trim().min(1).max(64),
    externalEffect: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

export const releaseSchemaRollbackFixtureSchema = z
  .object({
    schema: z.literal('ReleaseSchemaRollbackFixture'),
    fixtureClass: z.literal('synthetic_contract_only'),
    sourceSchemaVersion: z.number().int().positive(),
    candidateSchemaVersion: z.number().int().positive(),
    rollbackSchemaVersion: z.number().int().positive(),
    sourceArtifactDigest: digestSchema,
    candidateArtifactDigest: digestSchema,
    rollbackArtifactDigest: digestSchema,
    before: z.array(durableFactSchema).max(4096),
    afterUpgrade: z.array(durableFactSchema).max(4096),
    afterRollback: z.array(durableFactSchema).max(4096),
    backupCreated: z.literal(true),
    irreversibleMigrationCount: z.literal(0),
  })
  .strict();

export interface ReleaseSchemaRollbackReport {
  schema: 'ReleaseSchemaRollbackReport';
  status: 'contract_replay_passed';
  fixtureClass: 'synthetic_contract_only';
  productionEvidence: false;
  durableFactsPreserved: true;
  unknownExternalEffectsReplayed: 0;
  rollbackSchemaRestored: true;
  fixtureDigest: `sha256:${string}`;
  reportDigest: `sha256:${string}`;
}

export function verifyReleaseSchemaRollbackFixture(
  rawFixture: unknown,
): ReleaseSchemaRollbackReport {
  const fixture = releaseSchemaRollbackFixtureSchema.parse(rawFixture);
  if (fixture.candidateSchemaVersion < fixture.sourceSchemaVersion) {
    throw new Error('Candidate schema cannot precede the source schema.');
  }
  if (fixture.rollbackSchemaVersion !== fixture.sourceSchemaVersion) {
    throw new Error('Rollback must restore the exact source Runtime schema.');
  }
  if (fixture.rollbackArtifactDigest !== fixture.sourceArtifactDigest) {
    throw new Error('Rollback must restore the exact source artifact identity.');
  }
  const before = uniqueFacts(fixture.before, 'before');
  const upgraded = uniqueFacts(fixture.afterUpgrade, 'afterUpgrade');
  const rolledBack = uniqueFacts(fixture.afterRollback, 'afterRollback');
  for (const identity of before.keys()) {
    if (!upgraded.has(identity) || !rolledBack.has(identity)) {
      throw new Error(`Durable fact ${identity} was deleted.`);
    }
  }
  if (upgraded.size !== before.size || rolledBack.size !== before.size) {
    throw new Error('Schema rehearsal cannot inject or delete durable facts.');
  }
  const replayedUnknownEffects = [...upgraded.values(), ...rolledBack.values()].filter(
    (fact) => fact.externalEffect && fact.status === 'unknown' && fact.replayed,
  );
  if (replayedUnknownEffects.length > 0) {
    throw new Error('Unknown external effects must never be replayed during schema rehearsal.');
  }
  for (const [identity, fact] of before) {
    const upgradeFact = upgraded.get(identity);
    const rollbackFact = rolledBack.get(identity);
    if (!upgradeFact || !rollbackFact) throw new Error(`Durable fact ${identity} was deleted.`);
    if (canonicalJson(upgradeFact) !== canonicalJson(fact)) {
      throw new Error(`Durable fact ${identity} changed during schema upgrade.`);
    }
    if (canonicalJson(rollbackFact) !== canonicalJson(fact)) {
      throw new Error(`Durable fact ${identity} changed across schema rehearsal.`);
    }
  }
  const fixtureDigest = sha256DomainSeparated(
    'kite.release.schema-rollback-fixture.v1',
    canonicalJson(fixture),
  );
  const withoutDigest: Omit<ReleaseSchemaRollbackReport, 'reportDigest'> = {
    schema: 'ReleaseSchemaRollbackReport',
    status: 'contract_replay_passed',
    fixtureClass: 'synthetic_contract_only',
    productionEvidence: false,
    durableFactsPreserved: true,
    unknownExternalEffectsReplayed: 0,
    rollbackSchemaRestored: true,
    fixtureDigest,
  };
  return {
    ...withoutDigest,
    reportDigest: sha256DomainSeparated(
      'kite.release.schema-rollback-report.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

function uniqueFacts(
  facts: readonly z.infer<typeof durableFactSchema>[],
  stage: string,
): Map<string, z.infer<typeof durableFactSchema>> {
  const result = new Map<string, z.infer<typeof durableFactSchema>>();
  for (const fact of facts) {
    const identity = `${fact.kind}:${fact.factId}`;
    if (result.has(identity)) throw new Error(`${stage} repeats durable fact ${identity}.`);
    result.set(identity, fact);
  }
  return result;
}
