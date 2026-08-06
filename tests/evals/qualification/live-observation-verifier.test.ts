import { describe, expect, test } from 'bun:test';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildLiveCompatibilityObservationV1,
  type DiagnosticCandidateArtifactClosureV1,
  type QualificationAttemptIdentityV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-observation-schema-v1';
import {
  L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1,
  l3LiveObservationSourceRegistryIsClosedV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-observation-source-registry-v1';
import {
  buildLiveCompatibilityObservationVerifierContextV1,
  verifyLiveCompatibilityObservationV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-observation-verifier-v1';

const OBSERVED_AT = '2026-08-06T00:00:01.000Z';
const STARTED_AT = '2026-08-06T00:00:00.000Z';
const RESERVATION_ID = 'l3-00000000-0000-4000-8000-000000000001';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function sourceBoundFacts(
  overrides: {
    candidate?: DiagnosticCandidateArtifactClosureV1;
    identity?: QualificationAttemptIdentityV1;
  } = {},
) {
  const source = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1;
  const candidate = overrides.candidate ?? source.candidate;
  const identity = overrides.identity ?? source.identity;
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    routePolicyDigest: source.policy.policyDigest,
    period: 'day',
    periodStart: '2026-08-06',
    reservationId: RESERVATION_ID,
    status: 'reconciled',
    reserved: source.quota,
    reconciled: { attempts: 1, tokens: 12, runWallClockSeconds: 1, costUsdMicros: 250_000 },
  });
  const monthQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    routePolicyDigest: source.policy.policyDigest,
    period: 'month',
    periodStart: '2026-08-01',
    reservationId: RESERVATION_ID,
    status: 'reconciled',
    reserved: source.quota,
    reconciled: { attempts: 1, tokens: 12, runWallClockSeconds: 1, costUsdMicros: 250_000 },
  });
  const retention = buildEvidenceRetentionWitnessV1({
    schema: 'EvidenceRetentionWitnessV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    retentionClass: 'ephemeral_local',
    storage: {
      acl: 'local_owner_only',
      encryption: 'local_owner_disk_encryption',
      audit: 'local_metadata_audit',
    },
    deleteTrigger: 'process_exit',
    observedAt: STARTED_AT,
  });
  const governance = {
    retentionClass: 'ephemeral_local' as const,
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    quotaLedgerDigests: {
      day: dayQuotaLedger.recordDigest,
      month: monthQuotaLedger.recordDigest,
    },
    storageDeletionWitnessDigest: retention.recordDigest,
  };
  const execution = buildDiagnosticExecutionV1({
    executionId: `l3-live-execution-${RESERVATION_ID}`,
    platformIdentity: source.execution.platformIdentity,
    identity: {
      source: 'local_synthetic',
      fixtureId: source.execution.fixtureId,
      runner: source.execution.runner,
      commit: source.execution.commit,
      startedAt: STARTED_AT,
      endedAt: OBSERVED_AT,
    },
  });
  const context = buildLiveCompatibilityObservationVerifierContextV1({
    schema: 'LiveCompatibilityObservationVerifierContextV1',
    version: 1,
    candidate,
    governance,
    execution,
    scope: source.scope,
    identity,
    governanceWitnesses: { dayQuotaLedger, monthQuotaLedger, retention },
  });
  const observation = buildLiveCompatibilityObservationV1({
    schema: 'LiveCompatibilityObservationV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    observedAt: OBSERVED_AT,
    candidate,
    governance,
    execution,
    scope: source.scope,
    identity,
    outcome: 'success',
  });
  return { context, observation };
}

describe('AQ-8 specialized L3 live-observation verifier', () => {
  test('reconstructs the fixed L3 policy, route, Matrix, suite, candidate, fixture, corpus, oracle, evaluator, verifier, runner, and ledger closure', () => {
    const { context, observation } = sourceBoundFacts();
    expect(l3LiveObservationSourceRegistryIsClosedV1()).toBe(true);
    expect(
      verifyLiveCompatibilityObservationV1(observation, context, new Date(OBSERVED_AT)),
    ).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'observed',
      reasonCode: 'observed_success',
      outcome: 'success',
      candidateClosureDigest: L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1.candidate.closureDigest,
    });
  });

  test('blocks a self-consistent forged context whose Matrix identity differs from the source-owned L3 registry', () => {
    const forgedIdentity = {
      ...L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1.identity,
      matrixDigest: digest('a'),
    };
    const { context, observation } = sourceBoundFacts({ identity: forgedIdentity });
    const report = verifyLiveCompatibilityObservationV1(
      observation,
      context,
      new Date(OBSERVED_AT),
    );
    expect(report).toMatchObject({
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
    expect(report.outcome).toBeUndefined();
  });

  test('blocks a self-consistent forged candidate closure even when its record and context digests recompute', () => {
    const sourceCandidate = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1.candidate;
    const sourceArtifact = sourceCandidate.artifacts[0]!.artifact;
    const forgedCandidate = buildDiagnosticCandidateArtifactClosureV1({
      schema: 'DiagnosticCandidateArtifactClosureV1',
      version: 1,
      artifacts: [
        {
          platformIdentity: sourceCandidate.artifacts[0]!.platformIdentity,
          artifact: {
            ...sourceArtifact,
            behaviorDigest: digest('b'),
          },
        },
      ],
    });
    const { context, observation } = sourceBoundFacts({ candidate: forgedCandidate });
    const report = verifyLiveCompatibilityObservationV1(
      observation,
      context,
      new Date(OBSERVED_AT),
    );
    expect(report).toMatchObject({
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
    expect(report.outcome).toBeUndefined();
  });
});
