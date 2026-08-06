import { describe, expect, test } from 'bun:test';
import {
  buildL2NativeExecutionV1,
  buildL2NativeIndependentPlatformProjectionV1,
  deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1,
  type L2NativeExecutionV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import {
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  type L2NativeConformanceTargetV1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';

const COMMIT = 'a'.repeat(40);

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function executionFor(target: L2NativeConformanceTargetV1): L2NativeExecutionV1 {
  const targetIndex = L2_NATIVE_CONFORMANCE_TARGETS_V1.findIndex(
    (candidate) => candidate.distributionTargetId === target.distributionTargetId,
  );
  return buildL2NativeExecutionV1({
    target,
    observedRunner: {
      runnerClass: target.runnerClass,
      platform: target.platform,
      arch: target.arch,
    },
    identity: {
      source: 'github_actions',
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: '1218896626',
      workflowPath: L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
      workflowRef: `ferqx/kite-code/${L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1}@refs/heads/main`,
      workflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      ref: 'refs/heads/main',
      runId: String(900 + targetIndex),
      runAttempt: 1,
      job: L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
      commit: COMMIT,
      startedAt: '2026-08-06T00:00:00.000Z',
      endedAt: '2026-08-06T00:00:01.000Z',
    },
  });
}

function verifiedFor(execution: L2NativeExecutionV1) {
  if (execution.identity.source !== 'github_actions') {
    throw new Error('l2_verified_platform_test_execution_source_missing');
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
    probeDigest: digest('e'),
    outcome: 'excluded',
    productionSupported: false,
  });
}

describe('AQ-7 independently verified platform probe adapter', () => {
  test('derives a metadata-only opaque binding from the exact verified GitHub projection', () => {
    const execution = executionFor(L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!);
    const verified = verifiedFor(execution);
    const binding = deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
      execution,
      independentProjection: verified,
    });

    expect(binding).toMatchObject({
      schema: 'L2NativeVerifiedProbeBindingV1',
      target: { distributionTargetId: execution.target.distributionTargetId },
      executionDigest: execution.executionDigest,
      probeDigest: verified.probeDigest,
      outcome: verified.outcome,
    });
    expect(Object.keys(binding).sort()).toEqual([
      'executionDigest',
      'outcome',
      'platformVerifierDigest',
      'probeBindingDigest',
      'probeDigest',
      'schema',
      'target',
      'version',
    ]);
    expect(JSON.stringify(binding)).not.toContain('L2NativeIndependentPlatformProjectionV1');
    expect(JSON.stringify(binding)).not.toContain('workflowRef');
  });

  test('rejects every verified GitHub source splice, foreign target, malformed outcome, and production support', () => {
    const execution = executionFor(L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!);
    const verified = verifiedFor(execution);
    const mutations: Array<Record<string, string>> = [
      { repository: 'fork/example' },
      { repositoryId: '999' },
      { headSha: 'b'.repeat(40) },
      { ref: 'refs/heads/other' },
      { workflow: '.github/workflows/other.yml' },
      { workflowRef: 'ferqx/kite-code/.github/workflows/other.yml@refs/heads/main' },
      { workflowSha: 'b'.repeat(40) },
      { runId: '9999' },
      { runAttempt: '2' },
      { runnerClass: 'ubuntu-24.04-x64-github-hosted' },
    ];
    for (const mutation of mutations) {
      const { projectionDigest: _projectionDigest, ...projectionMaterial } = verified;
      expect(() =>
        deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
          execution,
          independentProjection: buildL2NativeIndependentPlatformProjectionV1({
            ...projectionMaterial,
            source: { ...verified.source, ...mutation },
          }),
        }),
      ).toThrow('source_execution_mismatch');
    }
    expect(() =>
      deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
        execution: executionFor(L2_NATIVE_CONFORMANCE_TARGETS_V1[1]!),
        independentProjection: verified,
      }),
    ).toThrow('source_execution_mismatch');
    expect(() =>
      deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
        execution,
        independentProjection: { ...verified, productionSupported: true } as never,
      }),
    ).toThrow();
    expect(() =>
      deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1({
        execution,
        independentProjection: { ...verified, outcome: 'other' } as never,
      }),
    ).toThrow();
  });
});
