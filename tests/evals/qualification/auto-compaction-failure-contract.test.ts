import { describe, expect, test } from 'bun:test';
import {
  buildAgentQualificationEvidenceV1,
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildQualificationAttemptV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  reconstructSourceOwnedL1AutoCompactionFailureV1,
  verifyL1AutoCompactionFailureEvidenceV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  buildL1AutoCompactionFailureEvaluatorV1,
  runL1AutoCompactionFailureAdaptersV1,
  runL1AutoCompactionFailureContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-auto-compaction-failure-adapter-v1';
import {
  buildL1AutoCompactionFailureSuiteV1,
  L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1,
  L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1,
} from '../../../scripts/evals/contracts/qualification/l1-auto-compaction-failure-schema-v1';

const CREATED_AT = '2026-08-05T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}` as `sha256:${string}`;
}

describe('AQ-9A L1 automatic compaction failure qualification', () => {
  test('uses only local transport faults while proving same-turn stop and next-user-turn retry', async () => {
    const results = await runL1AutoCompactionFailureAdaptersV1();
    expect(results).toEqual(
      L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );

    const report = await runL1AutoCompactionFailureContractCorpusV1({
      evaluator: buildL1AutoCompactionFailureEvaluatorV1(),
    });
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
    expect(report.observations.map((observation) => observation.caseId)).toEqual([
      ...L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1,
    ]);
  });

  test('keeps the AQ-9A self-contract diagnostic and separate from a Matrix receipt suite', () => {
    const suite = buildL1AutoCompactionFailureSuiteV1();
    expect(suite.suiteId).toBe('qualification-l1-auto-compaction-failure-v1');
    expect(suite.assertionIds).toEqual(
      L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.map((entry) => entry.assertionId),
    );
    expect(suite.suiteDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('rebuilds each source-owned receipt through the independent diagnostic verifier', async () => {
    const reconstructed = await reconstructSourceOwnedL1AutoCompactionFailureV1();
    const sourceSurfaceId = 'model-context:auto-compaction-failure';
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === sourceSurfaceId,
    );
    const receipts = reconstructed.receipts.filter(
      (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
    );
    expect(bindings).toHaveLength(3);
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authority: 'diagnostic', evidenceEligible: false }),
      ]),
    );

    const candidate = buildDiagnosticCandidateArtifactClosureV1({
      schema: 'DiagnosticCandidateArtifactClosureV1',
      version: 1,
      artifacts: [
        {
          platformIdentity: 'linux-x64',
          artifact: {
            canonicalRepository: 'ferqx/kite-code',
            repositoryId: 'R_kgDOKite',
            commit: COMMIT,
            payloadSha256: digest('a'),
            canonicalManifestDigest: digest('b'),
            behaviorDigest: digest('c'),
            profileDigest: digest('d'),
            gatePolicyDigest: digest('e'),
          },
        },
      ],
    });
    const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    const counters = {
      attempts: bindings.length,
      tokens: 30,
      runWallClockSeconds: 3,
      costUsdMicros: 3,
    };
    const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'day',
      periodStart: '2026-08-05',
      reservationId: 'l1-auto-compaction-reservation',
      status: 'reconciled',
      reserved: counters,
      reconciled: counters,
    });
    const monthQuotaLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'month',
      periodStart: '2026-08-01',
      reservationId: 'l1-auto-compaction-reservation',
      status: 'reconciled',
      reserved: counters,
      reconciled: counters,
    });
    const retention = buildEvidenceRetentionWitnessV1({
      schema: 'EvidenceRetentionWitnessV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      retentionClass: 'ephemeral_local',
      storage: profile.storage,
      deleteTrigger: 'process_exit',
      observedAt: CREATED_AT,
    });
    const governance = {
      retentionClass: 'ephemeral_local' as const,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      quotaLedgerDigests: {
        day: dayQuotaLedger.recordDigest,
        month: monthQuotaLedger.recordDigest,
      },
      storageDeletionWitnessDigest: retention.recordDigest,
    };
    const execution = buildDiagnosticExecutionV1({
      executionId: 'l1-auto-compaction-execution',
      platformIdentity: 'linux-x64',
      identity: {
        source: 'local_synthetic',
        fixtureId: 'l1-auto-compaction-failure-fixture-v1',
        runner: 'qualification-l1-auto-compaction-failure-runner-v1',
        commit: COMMIT,
        startedAt: CREATED_AT,
        endedAt: '2026-08-05T00:00:01.000Z',
      },
    });
    const scope = {
      platformIdentity: 'linux-x64',
      releaseProfileDigest: digest('d'),
      entrypoint: 'runtime' as const,
      testPolicyDigest: digest('1'),
      routePolicyDigest: digest('1'),
    };
    const identity = {
      matrixDigest: reconstructed.matrix.matrixDigest,
      suiteDigest: reconstructed.suite.suiteDigest,
      oracleDigest: reconstructed.suite.oracleDigest,
      corpusDigest: reconstructed.suite.corpusDigest,
      evaluatorDigest: reconstructed.suite.evaluatorDigest,
      verifierDigest: reconstructed.evaluator.verifierDigest,
      runnerDigest: reconstructed.evaluator.runnerDigest,
    };
    const evidence = buildAgentQualificationEvidenceV1({
      schema: 'AgentQualificationEvidenceV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      createdAt: CREATED_AT,
      candidate,
      governance,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      executions: [execution],
      attempts: bindings.map((binding, index) => {
        const receipt = receipts.find(
          (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
        );
        if (!receipt) throw new Error('l1_auto_compaction_test_receipt_missing');
        return buildQualificationAttemptV1({
          attemptId: `l1-auto-compaction-attempt-${index + 1}`,
          featureId: binding.featureId,
          assertionId: binding.binding.assertionId,
          layer: 'scripted_runtime',
          status: 'passed',
          executionId: execution.executionId,
          candidateArtifact: candidate.artifacts[0]!,
          scope,
          identity,
          receipt: { receiptId: receipt.receiptId, receiptDigest: receipt.receiptDigest },
        });
      }),
    });
    const report = await verifyL1AutoCompactionFailureEvidenceV1({
      schema: 'L1AutoCompactionFailureEvidenceVerificationInputV1',
      version: 1,
      evidence,
      trusted: {
        candidate,
        governance,
        executions: [execution],
        governanceWitnesses: { dayQuotaLedger, monthQuotaLedger, retention },
      },
      sourceSurfaceId,
      scopes: [{ sourceSurfaceId, scope }],
      receipts,
    });
    expect(report).toMatchObject({ authority: 'diagnostic', evidenceEligible: false });
    expect(report.results).toHaveLength(3);
    expect(
      report.results.every((result) => result.reasonCode === 'behavioral_evidence_registered'),
    ).toBe(true);
  }, 10_000);
});
