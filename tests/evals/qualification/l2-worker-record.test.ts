import { describe, expect, test } from 'bun:test';
import {
  agentQualificationEvidenceV1Schema,
  liveCompatibilityObservationV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  buildL2NativeCandidateIdentityV1,
  buildL2NativeExecutionV1,
  buildL2NativeIndependentPlatformProjectionV1,
  deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1,
  type L2NativeCandidateIdentityV1,
  type L2NativeExecutionV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import {
  buildL2NativeConformanceAdapterObservationV1,
  type L2NativeConformanceAdapterObservationV1,
  reconstructL2NativeStandaloneKeyringDisabledProvenanceV1,
  verifyL2NativeCandidateStandaloneKeyringMarkerV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1';
import { evaluateL2NativeConformanceCorpusV1 } from '../../../scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1';
import {
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  type L2NativeConformanceTargetV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import {
  assembleL2NativeConformanceWorkerRecordsV1,
  buildL2NativeConformanceBlockedWorkerTransportV1,
  buildL2NativeConformanceWorkerRecordV1,
  type L2NativeConformanceWorkerRecordV1,
  l2NativeConformanceCasesForTargetV1,
  parseL2NativeConformanceBlockedWorkerTransportV1,
  parseL2NativeConformanceWorkerRecordV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1';
import type { ReleaseEvidenceExecutionIdentityV1 } from '../../../scripts/release/evidence-identity-primitives';
import { parseReleaseEvidenceV1 } from '../../../scripts/release/evidence-schema';
import { verifiedCandidateWithStandaloneKeyringMarkerV1 } from './helpers/l2-verified-candidate';

const COMMIT = 'a'.repeat(40);
const STARTED_AT = '2026-08-06T00:00:00.000Z';
const ENDED_AT = '2026-08-06T00:00:01.000Z';

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function verifiedPlatformProjectionFor(
  execution: L2NativeExecutionV1,
  evidenceDigest: `sha256:${string}`,
  outcome: 'supported' | 'read_only_only' | 'excluded',
) {
  if (execution.identity.source !== 'github_actions') {
    throw new Error('l2_worker_fixture_execution_source_missing');
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

type GitHubExecutionIdentityV1 = Extract<
  ReleaseEvidenceExecutionIdentityV1,
  { source: 'github_actions' }
>;

function targetIndex(target: L2NativeConformanceTargetV1): number {
  const index = L2_NATIVE_CONFORMANCE_TARGETS_V1.findIndex(
    (entry) => entry.distributionTargetId === target.distributionTargetId,
  );
  if (index < 0) throw new Error('test_l2_worker_target_missing');
  return index;
}

function fixtureForTarget(
  target: L2NativeConformanceTargetV1,
  payloadCharacter = String(targetIndex(target) + 1),
): {
  candidate: L2NativeCandidateIdentityV1;
  execution: L2NativeExecutionV1;
  observations: readonly L2NativeConformanceAdapterObservationV1[];
} {
  const index = targetIndex(target);
  const artifact = {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: '1218896626',
    commit: COMMIT,
    payloadSha256: digest(payloadCharacter),
    canonicalManifestDigest: digest(String(index + 4)),
    behaviorDigest: digest('b'),
    profileDigest: digest('c'),
    gatePolicyDigest: digest('d'),
  };
  const candidate = buildL2NativeCandidateIdentityV1({ target, artifact });
  const identity: GitHubExecutionIdentityV1 = {
    source: 'github_actions',
    canonicalRepository: artifact.canonicalRepository,
    repositoryId: artifact.repositoryId,
    workflowPath: L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
    workflowRef: `ferqx/kite-code/${L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1}@refs/heads/main`,
    workflowSha: COMMIT,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    ref: 'refs/heads/main',
    runId: String(400 + index),
    runAttempt: 1,
    job: L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
    commit: COMMIT,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
  };
  const execution = buildL2NativeExecutionV1({
    target,
    observedRunner: {
      runnerClass: target.runnerClass,
      platform: target.platform,
      arch: target.arch,
    },
    identity,
  });
  const probe = deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
    execution,
    independentProjection: verifiedPlatformProjectionFor(
      execution,
      digest(String(index + 7)),
      'excluded',
    ),
  });
  const observations = l2NativeConformanceCasesForTargetV1(target).map((entry) => {
    const isKeyring = entry.capabilityId === 'standalone_keyring_unavailable';
    return buildL2NativeConformanceAdapterObservationV1({
      case: entry,
      candidate,
      execution,
      probe,
      observedOutcome: 'passed',
      disabledProof: isKeyring ? 'all_entrypoints_rejected_and_disclosed' : 'not_applicable',
      ...(isKeyring
        ? {
            candidateKeyringMarkerDigest: verifyL2NativeCandidateStandaloneKeyringMarkerV1({
              candidate,
              verifiedCandidate: verifiedCandidateWithStandaloneKeyringMarkerV1(candidate),
            }),
            standaloneKeyringProvenance: reconstructL2NativeStandaloneKeyringDisabledProvenanceV1(),
          }
        : {}),
    });
  });
  return { candidate, execution, observations };
}

function recordForTarget(
  target: L2NativeConformanceTargetV1,
  payloadCharacter?: string,
): L2NativeConformanceWorkerRecordV1 {
  const fixture = fixtureForTarget(target, payloadCharacter);
  return buildL2NativeConformanceWorkerRecordV1({
    target,
    candidate: fixture.candidate,
    execution: fixture.execution,
    observations: fixture.observations,
  });
}

describe('AQ-7 L2 native worker transport record', () => {
  test('seals exactly five local observations as metadata-only diagnostic transport', () => {
    const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    const record = recordForTarget(target);

    expect(record).toMatchObject({
      schema: 'L2NativeConformanceWorkerRecordV1',
      authority: 'diagnostic',
      evidenceEligible: false,
      target: { distributionTargetId: target.distributionTargetId },
    });
    expect(record.observations).toHaveLength(5);
    expect(
      record.observations.every(
        (observation) =>
          observation.case.target.distributionTargetId === target.distributionTargetId,
      ),
    ).toBe(true);
    const encoded = JSON.stringify(record);
    expect(encoded).not.toContain('AgentQualificationEvidenceV1');
    expect(encoded).not.toContain('L2NativeConformanceReceiptV1');
    expect(encoded).not.toContain('sourceFiles');
    expect(() =>
      parseL2NativeConformanceWorkerRecordV1({ ...record, receipt: 'forbidden' }),
    ).toThrow('Unrecognized key');
  });

  test('rejects cross-target observations before any aggregate evaluation occurs', () => {
    const macos = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    const linux = L2_NATIVE_CONFORMANCE_TARGETS_V1[1]!;
    const local = fixtureForTarget(macos);
    const foreign = fixtureForTarget(linux);
    expect(() =>
      buildL2NativeConformanceWorkerRecordV1({
        target: macos,
        candidate: local.candidate,
        execution: local.execution,
        observations: foreign.observations,
      }),
    ).toThrow('exact five local target/capability observations');
  });

  test('requires all three records before producing the complete evaluator input', () => {
    const records = L2_NATIVE_CONFORMANCE_TARGETS_V1.map((target) => recordForTarget(target));
    expect(() =>
      assembleL2NativeConformanceWorkerRecordsV1({ workerRecords: records.slice(0, 2) }),
    ).toThrow('exact_three_target_records');

    const aggregate = assembleL2NativeConformanceWorkerRecordsV1({ workerRecords: records });
    expect(aggregate.workerRecordDigests).toHaveLength(3);
    expect(aggregate.observations).toHaveLength(15);
    const report = evaluateL2NativeConformanceCorpusV1({
      evaluator: aggregate.evaluator,
      observations: aggregate.observations,
    });
    expect(report.status).toBe('complete');
    expect(report.results.filter((result) => result.status === 'qualified')).toHaveLength(0);
  });

  test('rejects reuse of one candidate payload as another platform candidate', () => {
    const records = L2_NATIVE_CONFORMANCE_TARGETS_V1.map((target) => recordForTarget(target, 'f'));
    expect(() => assembleL2NativeConformanceWorkerRecordsV1({ workerRecords: records })).toThrow(
      'cross_target_candidate_payload_reuse',
    );
  });

  test('emits only a non-retention governance-preflight block when the control plane is unavailable', () => {
    const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    const blocked = buildL2NativeConformanceBlockedWorkerTransportV1({ target });
    expect(blocked).toMatchObject({
      schema: 'L2NativeConformanceBlockedWorkerTransportV1',
      authority: 'diagnostic',
      evidenceEligible: false,
      requestedGovernanceProfile: { retentionClass: 'protected_ci_retained' },
      governancePreflight: 'unavailable',
      reasonCode: 'protected_ci_governance_control_plane_unavailable',
    });
    expect(Object.keys(blocked)).not.toContain('candidate');
    expect(Object.keys(blocked)).not.toContain('execution');
    expect(Object.keys(blocked)).not.toContain('observations');
    expect(Object.keys(blocked)).not.toContain('receipt');
    expect(Object.keys(blocked)).not.toContain('report');
    expect(Object.keys(blocked)).not.toContain('retainedArtifactDigest');
    for (const forbiddenField of [
      'candidate',
      'execution',
      'observations',
      'receipt',
      'report',
      'artifact',
      'retentionWitness',
      'quotaLedger',
    ]) {
      expect(() =>
        parseL2NativeConformanceBlockedWorkerTransportV1({
          ...blocked,
          [forbiddenField]: 'forbidden',
        }),
      ).toThrow('Unrecognized key');
    }
    expect(agentQualificationEvidenceV1Schema.safeParse(blocked).success).toBe(false);
    expect(liveCompatibilityObservationV1Schema.safeParse(blocked).success).toBe(false);
    expect(() => parseReleaseEvidenceV1(blocked)).toThrow();
  });
});
