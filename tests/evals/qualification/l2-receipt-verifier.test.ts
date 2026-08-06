import { describe, expect, test } from 'bun:test';
import {
  discoverSourceOwnedL2NativeConformanceBindingsV1,
  generateSourceOwnedFeatureMatrixV1,
} from '../../../release/qualification/source-owned-surface-v1';
import { agentQualificationEvidenceV1Schema } from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  verifyAgentQualificationEvidenceV1,
  verifyL2NativeConformanceReceiptV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  buildL2NativeCandidateIdentityV1,
  buildL2NativeExecutionV1,
  buildL2NativeIndependentPlatformProjectionV1,
  deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import {
  buildL2NativeConformanceAdapterObservationV1,
  reconstructL2NativeStandaloneKeyringDisabledProvenanceV1,
  verifyL2NativeCandidateStandaloneKeyringMarkerV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1';
import {
  buildL2NativeConformanceEvaluatorV1,
  evaluateL2NativeConformanceCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1';
import {
  buildL2NativeConformanceReceiptV1,
  reconstructL2NativeConformanceProvenanceV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-evidence-v1';
import {
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import { verifiedCandidateWithStandaloneKeyringMarkerV1 } from './helpers/l2-verified-candidate';

const COMMIT = 'a'.repeat(40);
const OBSERVED_AT = '2026-08-06T00:00:00.000Z';

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function verifiedPlatformProjectionFor(
  execution: ReturnType<typeof buildL2NativeExecutionV1>,
  evidenceDigest: `sha256:${string}`,
  outcome: 'supported' | 'read_only_only' | 'excluded',
) {
  if (execution.identity.source !== 'github_actions') {
    throw new Error('l2_receipt_verifier_fixture_execution_source_missing');
  }
  return buildL2NativeIndependentPlatformProjectionV1({
    schema: 'L2NativeIndependentPlatformProjectionV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    source: {
      repository: execution.identity.canonicalRepository,
      repositoryId: execution.identity.repositoryId,
      headSha: execution.identity.commit,
      ref: execution.identity.ref,
      workflow: execution.identity.workflowPath,
      workflowRef: execution.identity.workflowRef,
      workflowSha: execution.identity.workflowSha,
      runId: execution.identity.runId,
      runAttempt: String(execution.identity.runAttempt),
      runnerClass: execution.observedRunner.runnerClass,
    },
    probeDigest: evidenceDigest,
    outcome,
    productionSupported: false,
  });
}

function protectedGovernance() {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.protected_ci_retained;
  const counters = { attempts: 1, tokens: 1, runWallClockSeconds: 1, costUsdMicros: 1 };
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'day',
    periodStart: '2026-08-06',
    reservationId: 'l2-receipt-verifier-day',
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
    reservationId: 'l2-receipt-verifier-month',
    status: 'reconciled',
    reserved: counters,
    reconciled: counters,
  });
  const retention = buildEvidenceRetentionWitnessV1({
    schema: 'EvidenceRetentionWitnessV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    retentionClass: 'protected_ci_retained',
    storage: profile.storage,
    deleteTrigger: 'artifact_expiry',
    observedAt: OBSERVED_AT,
    expiresAt: '2026-08-20T00:00:00.000Z',
    retainedArtifactDigest: digest('f'),
  });
  return {
    retention,
    binding: {
      retentionClass: 'protected_ci_retained' as const,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      expiresAt: '2026-08-20T00:00:00.000Z',
      retainedArtifactDigest: digest('f'),
      quotaLedgerDigests: {
        day: dayQuotaLedger.recordDigest,
        month: monthQuotaLedger.recordDigest,
      },
      storageDeletionWitnessDigest: retention.recordDigest,
    },
  };
}

function observationForCase(index: number) {
  const entry = L2_NATIVE_CONFORMANCE_CASES_V1[index]!;
  const target = entry.target;
  const targetIndex = L2_NATIVE_CONFORMANCE_TARGETS_V1.findIndex(
    (candidate) => candidate.distributionTargetId === target.distributionTargetId,
  );
  const artifact = {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: '1218896626',
    commit: COMMIT,
    payloadSha256: digest(String(targetIndex + 1)),
    canonicalManifestDigest: digest('b'),
    behaviorDigest: digest('c'),
    profileDigest: digest('d'),
    gatePolicyDigest: digest('e'),
  };
  const candidate = buildL2NativeCandidateIdentityV1({ target, artifact });
  const execution = buildL2NativeExecutionV1({
    target,
    observedRunner: {
      runnerClass: target.runnerClass,
      platform: target.platform,
      arch: target.arch,
    },
    identity: {
      source: 'github_actions',
      canonicalRepository: artifact.canonicalRepository,
      repositoryId: artifact.repositoryId,
      workflowPath: L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
      workflowRef: `ferqx/kite-code/${L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1}@refs/heads/main`,
      workflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      ref: 'refs/heads/main',
      runId: String(700 + targetIndex),
      runAttempt: 1,
      job: L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
      commit: COMMIT,
      startedAt: OBSERVED_AT,
      endedAt: '2026-08-06T00:00:01.000Z',
    },
  });
  const probe = deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
    execution,
    independentProjection: verifiedPlatformProjectionFor(
      execution,
      digest(String(targetIndex + 7)),
      'excluded',
    ),
  });
  const keyring = entry.capabilityId === 'standalone_keyring_unavailable';
  return buildL2NativeConformanceAdapterObservationV1({
    case: entry,
    candidate,
    execution,
    probe,
    observedOutcome: 'passed',
    disabledProof: keyring ? 'all_entrypoints_rejected_and_disclosed' : 'not_applicable',
    ...(keyring
      ? {
          candidateKeyringMarkerDigest: verifyL2NativeCandidateStandaloneKeyringMarkerV1({
            candidate,
            verifiedCandidate: verifiedCandidateWithStandaloneKeyringMarkerV1(candidate),
          }),
          standaloneKeyringProvenance: reconstructL2NativeStandaloneKeyringDisabledProvenanceV1(),
        }
      : {}),
  });
}

function fixture() {
  const observations = L2_NATIVE_CONFORMANCE_CASES_V1.map((_entry, index) =>
    observationForCase(index),
  );
  const evaluator = buildL2NativeConformanceEvaluatorV1();
  const evaluatorReport = evaluateL2NativeConformanceCorpusV1({ evaluator, observations });
  const governance = protectedGovernance();
  const matrix = generateSourceOwnedFeatureMatrixV1();
  const provenance = reconstructL2NativeConformanceProvenanceV1({
    matrixDigest: matrix.matrixDigest as `sha256:${string}`,
    governance: governance.binding,
  });
  const observation = observations.find(
    (candidate) => candidate.case.capabilityId === 'standalone_keyring_unavailable',
  );
  if (!observation) throw new Error('l2_receipt_verifier_keyring_case_missing');
  const binding = discoverSourceOwnedL2NativeConformanceBindingsV1().find(
    (candidate) => candidate.assertionId === observation.case.caseId,
  );
  if (!binding) throw new Error('l2_receipt_verifier_source_binding_missing');
  const receipt = buildL2NativeConformanceReceiptV1({
    sourceSurfaceId: binding.sourceSurfaceId,
    featureId: binding.featureId,
    assertionId: binding.assertionId,
    sourceBindingDigest: binding.sourceDigest,
    scope: {
      platformIdentity: observation.case.target.distributionTargetId,
      releaseProfileDigest: observation.candidate.artifact.profileDigest,
      entrypoint: observation.case.entrypoint,
    },
    provenance,
    observation,
    evaluatorReport,
  });
  return {
    binding,
    evaluator,
    evaluatorReport,
    governance,
    matrix,
    observations,
    provenance,
    receipt,
  };
}

describe('AQ-7 source-owned L2 receipt verifier', () => {
  test('closes the exact receipt but remains blocked without an atomic protected control-plane witness', () => {
    const value = fixture();
    const report = verifyL2NativeConformanceReceiptV1({
      schema: 'L2NativeConformanceReceiptVerificationInputV1',
      version: 1,
      receipt: value.receipt,
      provenance: value.provenance,
      evaluatorReport: value.evaluatorReport,
    });

    expect(report).toMatchObject({
      schema: 'AgentQualificationDiagnosticReportV1',
      authority: 'diagnostic',
      evidenceEligible: false,
      results: [
        {
          featureId: value.binding.featureId,
          assertionId: value.binding.assertionId,
          status: 'blocked',
          reasonCode: 'retention_unavailable',
        },
      ],
    });
    expect(agentQualificationEvidenceV1Schema.safeParse(value.receipt).success).toBe(false);
  }, 20_000);

  test('rejects caller-supplied source mapping, provenance, and report substitutions fail-closed', () => {
    const value = fixture();
    const firstBinding = discoverSourceOwnedL2NativeConformanceBindingsV1().find(
      (candidate) => candidate.assertionId !== value.binding.assertionId,
    );
    if (!firstBinding) throw new Error('l2_receipt_verifier_alternate_binding_missing');
    const observation = value.observations.find(
      (candidate) => candidate.case.caseId === value.binding.assertionId,
    );
    if (!observation) throw new Error('l2_receipt_verifier_observation_missing');
    const splicedReceipt = buildL2NativeConformanceReceiptV1({
      sourceSurfaceId: firstBinding.sourceSurfaceId,
      featureId: firstBinding.featureId,
      assertionId: value.binding.assertionId,
      sourceBindingDigest: firstBinding.sourceDigest,
      scope: {
        platformIdentity: observation.case.target.distributionTargetId,
        releaseProfileDigest: observation.candidate.artifact.profileDigest,
        entrypoint: observation.case.entrypoint,
      },
      provenance: value.provenance,
      observation,
      evaluatorReport: value.evaluatorReport,
    });
    const alternateObservation = value.observations[0]!;
    const {
      observationDigest: _observationDigest,
      reasonCode: _reasonCode,
      ...alternateMaterial
    } = alternateObservation;
    const blockedAlternateObservation = buildL2NativeConformanceAdapterObservationV1({
      ...alternateMaterial,
      observedOutcome: 'not_observed',
      disabledProof: 'not_applicable',
    });
    const substitutedReport = evaluateL2NativeConformanceCorpusV1({
      evaluator: value.evaluator,
      observations: [blockedAlternateObservation, ...value.observations.slice(1)],
    });
    const wrongProvenance = reconstructL2NativeConformanceProvenanceV1({
      matrixDigest: digest('0'),
      governance: value.governance.binding,
    });

    for (const input of [
      {
        schema: 'L2NativeConformanceReceiptVerificationInputV1',
        version: 1,
        receipt: splicedReceipt,
        provenance: value.provenance,
        evaluatorReport: value.evaluatorReport,
      },
      {
        schema: 'L2NativeConformanceReceiptVerificationInputV1',
        version: 1,
        receipt: value.receipt,
        provenance: wrongProvenance,
        evaluatorReport: value.evaluatorReport,
      },
      {
        schema: 'L2NativeConformanceReceiptVerificationInputV1',
        version: 1,
        receipt: value.receipt,
        provenance: value.provenance,
        evaluatorReport: substitutedReport,
      },
      {
        schema: 'L2NativeConformanceReceiptVerificationInputV1',
        version: 1,
        receipt: value.receipt,
        provenance: value.provenance,
        evaluatorReport: value.evaluatorReport,
        sourceSurfaceId: value.binding.sourceSurfaceId,
      },
    ]) {
      expect(verifyL2NativeConformanceReceiptV1(input).results).toEqual([
        expect.objectContaining({ status: 'blocked' }),
      ]);
    }
  }, 20_000);

  test('leaves the generic verifier GitHub path fail-closed', () => {
    const value = fixture();
    const report = verifyAgentQualificationEvidenceV1(value.receipt, value.provenance);
    expect(report.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);
  }, 20_000);
});
