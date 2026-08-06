import { describe, expect, test } from 'bun:test';
import {
  buildL2NativeCandidateIdentityV1,
  buildL2NativeExecutionV1,
  buildL2NativeIndependentPlatformProjectionV1,
  deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1,
  l2NativeVerifiedProbeBindingV1Schema,
} from '../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import {
  buildL2NativeConformanceAdapterObservationV1,
  type L2NativeConformanceAdapterObservationV1,
  reconstructL2NativeStandaloneKeyringDisabledProvenanceV1,
  verifyL2NativeCandidateStandaloneKeyringMarkerV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1';
import {
  buildL2NativeConformanceEvaluatorV1,
  evaluateL2NativeConformanceCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  type L2NativeApprovedExecutionRegistryV1,
  type L2NativeConformanceCaseV1,
  type L2NativeConformanceTargetV1,
  parseL2NativeApprovedExecutionRegistryV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import type { ReleaseEvidenceExecutionIdentityV1 } from '../../../scripts/release/evidence-identity-primitives';
import { verifiedCandidateWithStandaloneKeyringMarkerV1 } from './helpers/l2-verified-candidate';

const COMMIT = 'a'.repeat(40);
const STARTED_AT = '2026-08-06T00:00:00.000Z';
const ENDED_AT = '2026-08-06T00:00:01.000Z';

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function verifiedPlatformProjectionFor(
  execution: ReturnType<typeof buildL2NativeExecutionV1>,
  evidenceDigest: `sha256:${string}`,
  outcome: 'supported' | 'read_only_only' | 'excluded',
) {
  if (execution.identity.source !== 'github_actions') {
    throw new Error('l2_native_contract_fixture_execution_source_missing');
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

function targetIndex(target: L2NativeConformanceTargetV1): number {
  const index = L2_NATIVE_CONFORMANCE_TARGETS_V1.findIndex(
    (candidate) => candidate.distributionTargetId === target.distributionTargetId,
  );
  if (index < 0) throw new Error('test_l2_target_missing');
  return index;
}

type GitHubExecutionIdentityV1 = Extract<
  ReleaseEvidenceExecutionIdentityV1,
  { source: 'github_actions' }
>;

function githubIdentityForTarget(target: L2NativeConformanceTargetV1): GitHubExecutionIdentityV1 {
  const index = targetIndex(target);
  return {
    source: 'github_actions',
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: '1218896626',
    workflowPath: L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
    workflowRef: `ferqx/kite-code/${L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1}@refs/heads/main`,
    workflowSha: COMMIT,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    ref: 'refs/heads/main',
    runId: String(100 + index),
    runAttempt: 1,
    job: L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
    commit: COMMIT,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
  };
}

function fixtureForTarget(target: L2NativeConformanceTargetV1) {
  const index = targetIndex(target);
  const artifact = {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: '1218896626',
    commit: COMMIT,
    payloadSha256: digest(String(index + 1)),
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
    identity: githubIdentityForTarget(target),
  });
  const probe = deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
    execution,
    independentProjection: verifiedPlatformProjectionFor(
      execution,
      digest(String(index + 6)),
      'excluded',
    ),
  });
  return { candidate, execution, probe };
}

function observationForCase(
  entry: L2NativeConformanceCaseV1,
  observedOutcome: 'passed' | 'failed' | 'not_observed' = 'passed',
): L2NativeConformanceAdapterObservationV1 {
  const fixture = fixtureForTarget(entry.target);
  const keyring = entry.capabilityId === 'standalone_keyring_unavailable';
  return buildL2NativeConformanceAdapterObservationV1({
    case: entry,
    ...fixture,
    observedOutcome,
    disabledProof:
      keyring && observedOutcome === 'passed'
        ? 'all_entrypoints_rejected_and_disclosed'
        : 'not_applicable',
    ...(keyring
      ? {
          candidateKeyringMarkerDigest: verifyL2NativeCandidateStandaloneKeyringMarkerV1({
            candidate: fixture.candidate,
            verifiedCandidate: verifiedCandidateWithStandaloneKeyringMarkerV1(fixture.candidate),
          }),
          standaloneKeyringProvenance: reconstructL2NativeStandaloneKeyringDisabledProvenanceV1(),
        }
      : {}),
  });
}

function completeObservations(): L2NativeConformanceAdapterObservationV1[] {
  return L2_NATIVE_CONFORMANCE_CASES_V1.map((entry) => observationForCase(entry));
}

describe('AQ-7 L2 source-derived native conformance contract', () => {
  test('reads the approved D-04 registry as a strict, pinned empty source artifact', () => {
    const approvedRegistry: L2NativeApprovedExecutionRegistryV1 = {
      version: 1,
      decisionId: 'D-04',
      revision: 'd04-empty-2026-07-31',
      status: 'accepted_empty_support_set',
      selectedNetworkMode: 'off',
      evidenceCommit: 'a4bdf22aa7c2a987734524c278c4750e7b9faa96',
      digest: 'sha256:6c33ab090cd138d0eb26cdcbdc97ef92bc794adb3b1690fd7e8d2d24a4510656',
      qualifications: [],
    };
    expect(parseL2NativeApprovedExecutionRegistryV1(approvedRegistry)).toEqual(approvedRegistry);
    expect(() =>
      parseL2NativeApprovedExecutionRegistryV1({
        ...approvedRegistry,
        digest: digest('0'),
      }),
    ).toThrow();
    expect(() =>
      parseL2NativeApprovedExecutionRegistryV1({
        ...approvedRegistry,
        qualifications: [{}],
      }),
    ).toThrow();
    expect(() =>
      parseL2NativeApprovedExecutionRegistryV1({ ...approvedRegistry, unexpected: true }),
    ).toThrow();
  });

  test('uses the exact three product-owned distribution targets and a complete platform/capability corpus', () => {
    expect(L2_NATIVE_CONFORMANCE_TARGETS_V1).toEqual([
      {
        distributionTargetId: 'macos-15-arm64',
        candidateTargetId: 'macos-arm64',
        platform: 'darwin',
        arch: 'arm64',
        nativeRunner: 'macos-15',
        runnerClass: 'macos-15-arm64-github-hosted',
      },
      {
        distributionTargetId: 'ubuntu-24.04-x64',
        candidateTargetId: 'linux-x64',
        platform: 'linux',
        arch: 'x64',
        nativeRunner: 'ubuntu-24.04',
        runnerClass: 'ubuntu-24.04-x64-github-hosted',
      },
      {
        distributionTargetId: 'windows-2025-x64',
        candidateTargetId: 'windows-x64',
        platform: 'win32',
        arch: 'x64',
        nativeRunner: 'windows-2025',
        runnerClass: 'windows-2025-x64-github-hosted',
      },
    ]);
    expect(L2_NATIVE_CONFORMANCE_CASES_V1).toHaveLength(15);
    expect(buildL2NativeConformanceSourceRegistryV1().declaredEffectfulTargetIds).toEqual([]);
    expect(buildL2NativeConformanceSuiteV1().suiteId).toBe(
      'qualification-l2-native-conformance-v1',
    );
  });

  test('does not turn the current empty support declaration into a global pass', () => {
    const report = evaluateL2NativeConformanceCorpusV1({
      evaluator: buildL2NativeConformanceEvaluatorV1(),
      observations: completeObservations(),
    });

    expect(report.status).toBe('complete');
    expect(report.results.filter((result) => result.status === 'qualified')).toHaveLength(0);
    expect(report.results.filter((result) => result.status === 'unsupported')).toHaveLength(12);
    expect(report.results.filter((result) => result.status === 'verified_disabled')).toHaveLength(
      3,
    );
  });

  test('does not hide a missing or failed native observation behind an unsupported source declaration', () => {
    const observations = completeObservations();
    const missingIndex = observations.findIndex(
      (entry) => entry.case.capabilityId === 'candidate_cli_smoke',
    );
    const failedIndex = observations.findIndex(
      (entry) => entry.case.capabilityId === 'candidate_tui_smoke',
    );
    const missingCase = L2_NATIVE_CONFORMANCE_CASES_V1[missingIndex]!;
    const failedCase = L2_NATIVE_CONFORMANCE_CASES_V1[failedIndex]!;
    observations[missingIndex] = observationForCase(missingCase, 'not_observed');
    observations[failedIndex] = observationForCase(failedCase, 'failed');

    const report = evaluateL2NativeConformanceCorpusV1({
      evaluator: buildL2NativeConformanceEvaluatorV1(),
      observations,
    });
    expect(report.status).toBe('blocked');
    expect(report.results[missingIndex]).toMatchObject({
      status: 'blocked',
      reasonCode: 'not_observed',
    });
    expect(report.results[failedIndex]).toMatchObject({
      status: 'failed',
      reasonCode: 'native_assertion_failed',
    });
  });

  test('rejects another platform candidate or a mismatched observed runner before an observation exists', () => {
    const macosCase = L2_NATIVE_CONFORMANCE_CASES_V1.find(
      (entry) => entry.target.distributionTargetId === 'macos-15-arm64',
    )!;
    const linuxTarget = L2_NATIVE_CONFORMANCE_TARGETS_V1.find(
      (target) => target.distributionTargetId === 'ubuntu-24.04-x64',
    )!;
    const linuxFixture = fixtureForTarget(linuxTarget);
    expect(() =>
      buildL2NativeConformanceAdapterObservationV1({
        case: macosCase,
        ...linuxFixture,
        observedOutcome: 'passed',
        disabledProof: 'not_applicable',
      }),
    ).toThrow('cannot borrow');

    const target = macosCase.target;
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: 'linux',
          arch: 'x64',
        },
        identity: fixtureForTarget(target).execution.identity,
      }),
    ).toThrow('observed runner');
  });

  test('requires the fixed protected workflow path, job, ref, and candidate commit', () => {
    const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: target.platform,
          arch: target.arch,
        },
        identity: { ...githubIdentityForTarget(target), job: 'other-job' },
      }),
    ).toThrow('exact protected diagnostic workflow');
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: target.platform,
          arch: target.arch,
        },
        identity: { ...githubIdentityForTarget(target), ref: 'refs/heads/release' },
      }),
    ).toThrow('exact protected diagnostic workflow');
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: target.platform,
          arch: target.arch,
        },
        identity: { ...githubIdentityForTarget(target), workflowSha: 'b'.repeat(40) },
      }),
    ).toThrow('workflow SHA');
  });

  test('pins candidate/execution to the source-owned repository identity and monotonic run clock', () => {
    const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    const fixture = fixtureForTarget(target);
    expect(() =>
      buildL2NativeCandidateIdentityV1({
        target,
        artifact: { ...fixture.candidate.artifact, canonicalRepository: 'fork/example' },
      }),
    ).toThrow('canonical repository identity');
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: target.platform,
          arch: target.arch,
        },
        identity: { ...githubIdentityForTarget(target), repositoryId: '999' },
      }),
    ).toThrow('canonical repository identity');
    expect(() =>
      buildL2NativeExecutionV1({
        target,
        observedRunner: {
          runnerClass: target.runnerClass,
          platform: target.platform,
          arch: target.arch,
        },
        identity: {
          ...githubIdentityForTarget(target),
          startedAt: ENDED_AT,
          endedAt: STARTED_AT,
        },
      }),
    ).toThrow('end time');
  });

  test('requires every retained platform probe binding to name the fixed independent projection', () => {
    const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
    const probe = fixtureForTarget(target).probe;
    const { probeBindingDigest: _probeBindingDigest, ...probeMaterial } = probe;
    expect(() =>
      l2NativeVerifiedProbeBindingV1Schema.parse({
        ...probeMaterial,
        platformVerifierDigest: digest('0'),
        probeBindingDigest: probe.probeBindingDigest,
      }),
    ).toThrow('fixed independent projection contract');
  });
});
