import { describe, expect, test } from 'bun:test';
import {
  createSourceOwnedQualificationCatalogV1,
  discoverSourceOwnedL0ContractBindingsV1,
} from '../../../release/qualification/source-owned-surface-v1';
import {
  buildAgentQualificationEvidenceV1,
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildQualificationAttemptV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  buildQualificationVerifierContextV1,
  verifyAgentQualificationEvidenceV1,
  verifyL0ContractEvidenceV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import { generateAgentFeatureQualificationMatrixV1 } from '../../../scripts/evals/contracts/qualification/feature-matrix';
import {
  buildL0ContractReceiptV1,
  l0ContractReceiptBindingV1,
  runL0ContractAdapterV1,
  runL0ContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l0-contract-adapter-v1';

const createdAt = '2026-08-05T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function fixture() {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === 'qualification-l0-contract-v1',
  );
  if (!suite) throw new Error('fixture_l0_suite_missing');
  const bindings = discoverSourceOwnedL0ContractBindingsV1();
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
  const counters = { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 };
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'day',
    periodStart: '2026-08-05',
    reservationId: 'l0-reservation-001',
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
    reservationId: 'l0-reservation-001',
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
    observedAt: createdAt,
  });
  const governance = {
    retentionClass: 'ephemeral_local' as const,
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    quotaLedgerDigests: { day: dayQuotaLedger.recordDigest, month: monthQuotaLedger.recordDigest },
    storageDeletionWitnessDigest: retention.recordDigest,
  };
  const execution = buildDiagnosticExecutionV1({
    executionId: 'l0-execution-linux-001',
    platformIdentity: 'linux-x64',
    identity: {
      source: 'local_synthetic',
      fixtureId: 'l0-contract-fixture-v1',
      runner: 'qualification-l0-contract-runner-v1',
      commit: COMMIT,
      startedAt: createdAt,
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
  const evaluatorReport = runL0ContractCorpusV1({ evaluator: catalog.l0Evaluator });
  const receipts = bindings.map((binding) =>
    buildL0ContractReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      suiteDigest: suite.suiteDigest,
      evaluatorReport,
      adapterResult: runL0ContractAdapterV1(binding.binding),
    }),
  );
  const identity = {
    matrixDigest: matrix.matrixDigest,
    suiteDigest: suite.suiteDigest,
    oracleDigest: suite.oracleDigest,
    corpusDigest: suite.corpusDigest,
    evaluatorDigest: suite.evaluatorDigest,
    verifierDigest: catalog.l0Evaluator.verifierDigest,
    runnerDigest: catalog.l0Evaluator.runnerDependencyDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt,
    candidate,
    governance,
    suite: { suiteId: suite.suiteId, suiteDigest: suite.suiteDigest, role: 'behavioral' },
    executions: [execution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts[index]!;
      return buildQualificationAttemptV1({
        attemptId: `l0-attempt-${String(index + 1).padStart(2, '0')}`,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'contract',
        status: 'passed',
        executionId: execution.executionId,
        candidateArtifact: candidate.artifacts[0]!,
        scope,
        identity,
        receipt: l0ContractReceiptBindingV1(receipt),
      });
    }),
  });
  return {
    catalog,
    matrix,
    suite,
    bindings,
    candidate,
    governance,
    execution,
    scope,
    dayQuotaLedger,
    monthQuotaLedger,
    retention,
    evaluatorReport,
    receipts,
    evidence,
    identity,
  };
}

function singleRecord(value: ReturnType<typeof fixture>, index: number) {
  const binding = value.bindings[index]!;
  return {
    schema: 'L0ContractEvidenceVerificationInputV1' as const,
    version: 1 as const,
    evidence: buildAgentQualificationEvidenceV1({
      schema: 'AgentQualificationEvidenceV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      createdAt,
      candidate: value.candidate,
      governance: value.governance,
      suite: {
        suiteId: value.suite.suiteId,
        suiteDigest: value.suite.suiteDigest,
        role: 'behavioral',
      },
      executions: [value.execution],
      attempts: [value.evidence.attempts[index]!],
    }),
    trusted: {
      candidate: value.candidate,
      governance: value.governance,
      executions: [value.execution],
      governanceWitnesses: {
        dayQuotaLedger: value.dayQuotaLedger,
        monthQuotaLedger: value.monthQuotaLedger,
        retention: value.retention,
      },
    },
    sourceSurfaceId: binding.sourceSurfaceId,
    scopes: [{ sourceSurfaceId: binding.sourceSurfaceId, scope: value.scope }],
    receipts: [value.receipts[index]!],
  };
}

describe('source-owned L0 behavioral evidence', () => {
  test('derives a diagnostic-only positive result from exact source-owned receipts', () => {
    const value = fixture();
    const report = verifyL0ContractEvidenceV1(
      singleRecord(value, 0),
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBeFalse();
    expect(report.results).toEqual([
      expect.objectContaining({
        featureId: value.bindings[0]!.featureId,
        status: 'qualified',
      }),
    ]);
    expect(value.receipts.map((receipt) => receipt.outcome)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
  });

  test('does not allow the generic verifier to promote an arbitrary behavioral context', () => {
    const value = fixture();
    const binding = value.bindings[0]!;
    const receipt = value.receipts[0]!;
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: value.candidate,
      governance: value.governance,
      executions: [value.execution],
      suite: {
        suiteId: value.suite.suiteId,
        suiteDigest: value.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: {
        dayQuotaLedger: value.dayQuotaLedger,
        monthQuotaLedger: value.monthQuotaLedger,
        retention: value.retention,
      },
      requirements: [
        {
          requirementId: 'l0-generic-deny',
          featureId: binding.featureId,
          assertionId: binding.binding.assertionId,
          layer: 'contract',
          scope: value.scope,
          identity: value.identity,
          receipt: l0ContractReceiptBindingV1(receipt),
          expectedDisposition: 'behavioral_required',
        },
      ],
    });
    expect(verifyAgentQualificationEvidenceV1(value.evidence, context).results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'behavioral_context_untrusted' }),
    ]);
  });

  test('fails closed when a source-owned receipt is spliced or a required source scope is omitted', () => {
    const value = fixture();
    const input = singleRecord(value, 0);
    const spliced = verifyL0ContractEvidenceV1(
      { ...input, receipts: [value.receipts[1]!] },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(spliced.results.every((result) => result.status === 'blocked')).toBe(true);
    const missingScope = verifyL0ContractEvidenceV1(
      { ...input, scopes: input.scopes.slice(1) },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(missingScope.results.every((result) => result.status === 'blocked')).toBe(true);
  });

  test('does not accept a caller-supplied evaluator report instead of rerunning the sealed corpus', () => {
    const value = fixture();
    const input = singleRecord(value, 0);
    const forgedInput = {
      ...input,
      // A persisted report is not an L0 verifier input. The wrapper rebuilds
      // the corpus report from its source-owned evaluator identity, so this
      // additional field must fail the strict input schema.
      evaluatorReport: value.evaluatorReport,
    };
    const report = verifyL0ContractEvidenceV1(forgedInput, new Date('2026-08-05T01:00:00.000Z'));
    expect(report.results.every((result) => result.status === 'blocked')).toBe(true);
  });
});
