import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const durableFactSchema = z
  .object({
    kind: z.enum([
      'transcript',
      'plan',
      'receipt',
      'verification',
      'checkpoint',
      'capability_revision',
    ]),
    factId: z.string().min(1).max(128),
    digest: digestSchema,
    status: z.enum(['active', 'completed', 'failed', 'inconclusive', 'required', 'unknown']),
    externalEffect: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

export const gaCompatibilityFixtureV1Schema = z
  .object({
    schema: z.literal('GACompatibilityFixtureV1'),
    fixtureClass: z.literal('synthetic_contract_only'),
    fromArtifactDigest: digestSchema,
    gaArtifactDigest: digestSchema,
    rollbackArtifactDigest: digestSchema,
    fromRuntimeSchema: z.number().int().positive(),
    gaRuntimeSchema: z.number().int().positive(),
    rollbackRuntimeSchema: z.number().int().positive(),
    beforeFacts: z.array(durableFactSchema).min(1),
    afterUpgradeFacts: z.array(durableFactSchema).min(1),
    afterRollbackFacts: z.array(durableFactSchema).min(1),
    disabledCapabilities: z.array(z.string().min(1).max(64)),
    newAdmissionsForDisabledCapabilities: z.literal(0),
  })
  .strict();

export interface GACompatibilityReportV1 {
  schema: 'GACompatibilityReportV1';
  fixtureClass: 'synthetic_contract_only';
  status: 'contract_replay_passed';
  productionEvidence: false;
  durableFactsPreserved: true;
  unknownExternalEffectsReplayed: 0;
  newAdmissionsForDisabledCapabilities: 0;
  reportDigest: `sha256:${string}`;
}

export function verifyGaCompatibilityFixtureV1(rawFixture: unknown): GACompatibilityReportV1 {
  const fixture = gaCompatibilityFixtureV1Schema.parse(rawFixture);
  if (fixture.gaRuntimeSchema < fixture.fromRuntimeSchema) {
    throw new Error('GA upgrade fixture moves the Runtime schema backwards.');
  }
  if (fixture.rollbackRuntimeSchema !== fixture.fromRuntimeSchema) {
    throw new Error('Rollback fixture must return to the exact source Runtime schema.');
  }
  const before = factMap(fixture.beforeFacts, 'before');
  const upgrade = factMap(fixture.afterUpgradeFacts, 'upgrade');
  const rollback = factMap(fixture.afterRollbackFacts, 'rollback');
  for (const [identity, fact] of before) {
    const upgraded = upgrade.get(identity);
    const rolledBack = rollback.get(identity);
    if (!upgraded || !rolledBack) throw new Error(`Durable fact ${identity} was deleted.`);
    if (upgraded.digest !== fact.digest || rolledBack.digest !== fact.digest) {
      throw new Error(`Durable fact ${identity} changed identity across compatibility replay.`);
    }
    if (fact.status === 'unknown' && fact.externalEffect) {
      if (upgraded.replayed || rolledBack.replayed) {
        throw new Error(`Unknown external effect ${identity} was replayed.`);
      }
      if (upgraded.status !== 'unknown' || rolledBack.status !== 'unknown') {
        throw new Error(`Unknown external effect ${identity} was falsely reconciled.`);
      }
    }
    if (fact.kind === 'verification' && fact.status === 'required') {
      if (upgraded.status !== 'required' || rolledBack.status !== 'required') {
        throw new Error(`Required Verification ${identity} was removed.`);
      }
    }
  }
  const withoutDigest: Omit<GACompatibilityReportV1, 'reportDigest'> = {
    schema: 'GACompatibilityReportV1',
    fixtureClass: 'synthetic_contract_only',
    status: 'contract_replay_passed',
    productionEvidence: false,
    durableFactsPreserved: true,
    unknownExternalEffectsReplayed: 0,
    newAdmissionsForDisabledCapabilities: 0,
  };
  return {
    ...withoutDigest,
    reportDigest: sha256DomainSeparated(
      'kite.release.ga-compatibility-report.v1',
      canonicalJson({ fixture, report: withoutDigest }),
    ),
  };
}

function factMap(
  facts: z.infer<typeof durableFactSchema>[],
  stage: string,
): Map<string, z.infer<typeof durableFactSchema>> {
  const result = new Map<string, z.infer<typeof durableFactSchema>>();
  for (const fact of facts) {
    const identity = `${fact.kind}:${fact.factId}`;
    if (result.has(identity)) throw new Error(`${stage} facts repeat ${identity}.`);
    result.set(identity, fact);
  }
  return result;
}
