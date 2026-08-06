import { describe, expect, test } from 'bun:test';
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
  l2NativeConformanceReceiptBindingV1,
  l2NativeConformanceReceiptV1Schema,
  reconstructL2NativeConformanceProvenanceV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-evidence-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  computeL2NativeConformanceSourceRegistryDigestV1,
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  l2NativeConformanceSourceRegistryV1Schema,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import { parseReleaseEvidenceV1 } from '../../../scripts/release/evidence-schema';
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
    throw new Error('l2_evidence_fixture_execution_source_missing');
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

function governance() {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.protected_ci_retained;
  const counters = { attempts: 1, tokens: 1, runWallClockSeconds: 1, costUsdMicros: 1 };
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'day',
    periodStart: '2026-08-06',
    reservationId: 'l2-native-day-reservation',
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
    reservationId: 'l2-native-month-reservation',
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
      runId: String(300 + targetIndex),
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

function completeFixture() {
  const observations = L2_NATIVE_CONFORMANCE_CASES_V1.map((_entry, index) =>
    observationForCase(index),
  );
  const evaluator = buildL2NativeConformanceEvaluatorV1();
  const report = evaluateL2NativeConformanceCorpusV1({ evaluator, observations });
  const governanceValue = governance();
  const provenance = reconstructL2NativeConformanceProvenanceV1({
    matrixDigest: digest('9'),
    governance: governanceValue.binding,
  });
  return { observations, report, governance: governanceValue, provenance };
}

describe('AQ-7 L2 opaque diagnostic receipt', () => {
  test('binds current provenance, candidate/execution/probe, governance, and evaluator identities without becoming aggregate evidence', () => {
    const fixture = completeFixture();
    const observation = fixture.observations[0]!;
    const receipt = buildL2NativeConformanceReceiptV1({
      sourceSurfaceId: `distribution-target:${observation.case.target.distributionTargetId}`,
      featureId: 'RELEASE-DISTRIBUTION_TARGET-001',
      assertionId: observation.case.caseId,
      sourceBindingDigest: digest('8'),
      scope: {
        platformIdentity: observation.case.target.distributionTargetId,
        releaseProfileDigest: observation.candidate.artifact.profileDigest,
        entrypoint: observation.case.entrypoint,
      },
      provenance: fixture.provenance,
      observation,
      evaluatorReport: fixture.report,
    });

    expect(receipt).toMatchObject({
      schema: 'L2NativeConformanceReceiptV1',
      authority: 'diagnostic',
      evidenceEligible: false,
      candidate: { candidateDigest: observation.candidate.candidateDigest },
      execution: { executionDigest: observation.execution.executionDigest },
      probe: { probeBindingDigest: observation.probe.probeBindingDigest },
      platformVerifierDigest: observation.probe.platformVerifierDigest,
      governance: fixture.governance.binding,
    });
    expect(l2NativeConformanceReceiptBindingV1(receipt)).toEqual({
      receiptId: receipt.receiptId,
      receiptDigest: receipt.receiptDigest,
    });
    expect(() => parseReleaseEvidenceV1(receipt)).toThrow();
    expect(() =>
      l2NativeConformanceReceiptV1Schema.parse({ ...receipt, receiptDigest: digest('0') }),
    ).toThrow('receipt digest mismatch');
  });

  test('rejects a profile splice even when all candidate/probe digests are otherwise valid', () => {
    const fixture = completeFixture();
    const observation = fixture.observations[0]!;
    expect(() =>
      buildL2NativeConformanceReceiptV1({
        sourceSurfaceId: `distribution-target:${observation.case.target.distributionTargetId}`,
        featureId: 'RELEASE-DISTRIBUTION_TARGET-001',
        assertionId: observation.case.caseId,
        sourceBindingDigest: digest('8'),
        scope: {
          platformIdentity: observation.case.target.distributionTargetId,
          releaseProfileDigest: digest('0'),
          entrypoint: observation.case.entrypoint,
        },
        provenance: fixture.provenance,
        observation,
        evaluatorReport: fixture.report,
      }),
    ).toThrow('candidate profile digest');
  });

  test('rejects provenance tampering for the source-owned standalone keyring disabled proof', () => {
    const entryIndex = L2_NATIVE_CONFORMANCE_CASES_V1.findIndex(
      (entry) => entry.capabilityId === 'standalone_keyring_unavailable',
    );
    const entry = L2_NATIVE_CONFORMANCE_CASES_V1[entryIndex]!;
    const observation = observationForCase(entryIndex);
    const tampered = { provenanceDigest: digest('0') };
    const {
      observationDigest: _observationDigest,
      reasonCode: _reasonCode,
      ...observationInput
    } = observation;
    expect(() =>
      buildL2NativeConformanceAdapterObservationV1({
        ...observationInput,
        case: entry,
        standaloneKeyringProvenance: tampered,
      }),
    ).toThrow('provenance drifted');
    expect(JSON.stringify(observation)).not.toContain('sourceFiles');
    expect(JSON.stringify(observation)).not.toContain('standalone-keyring-unavailable.ts');
    expect(JSON.stringify(observation)).not.toContain('KNOWN_LIMITATIONS.md');
  });

  test('rejects a recomputed source-registry record when its D-04 support declaration digest drifts', () => {
    const registry = buildL2NativeConformanceSourceRegistryV1();
    const { sourceRegistryDigest: _digest, ...material } = registry;
    const tamperedMaterial = { ...material, supportDeclarationDigest: digest('0') };
    expect(() =>
      l2NativeConformanceSourceRegistryV1Schema.parse({
        ...tamperedMaterial,
        sourceRegistryDigest: computeL2NativeConformanceSourceRegistryDigestV1(tamperedMaterial),
      }),
    ).toThrow('D-04 support declaration');
  });
});
