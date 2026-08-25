import { describe, expect, test } from 'bun:test';
import { sha256Digest } from '../../scripts/release/canonical-json';
import { buildReleaseEvidenceBundle } from '../../scripts/release/evidence-bundle';
import {
  buildMaintainerSecurityReviewRecord,
  type ReleaseArtifactIdentity,
  type ReleaseEvidenceResult,
} from '../../scripts/release/evidence-schema';
import { buildSyntheticFoundationGateRecord } from '../../scripts/release/foundation-gate';
import {
  buildReleaseGatePolicy,
  evaluateReleaseGate,
  type ReleaseGatePolicy,
} from '../../scripts/release/gate-evaluator';

const COMMIT = 'a'.repeat(40);
const EVALUATED_AT = '2026-08-02T01:00:00.000Z';

function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}

function policy(
  mode: 'synthetic_foundation' | 'github_release' = 'synthetic_foundation',
): ReleaseGatePolicy {
  return buildReleaseGatePolicy({
    schema: 'ReleaseGatePolicy',
    policyId: 'release-foundation-policy-v1',
    mode,
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    releaseWorkflowPath: '.github/workflows/release-candidate.yml',
    releaseWorkflowSha: COMMIT,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    allowedRefPrefixes: ['refs/tags/v'],
    capabilities: ['verification'],
    requirements: [
      {
        requirementId: 'g0-execution',
        evidenceId: 'execution-conformance',
        kind: 'execution_conformance',
        gate: 'G0',
        maxAgeSeconds: 3600,
      },
      {
        requirementId: 'g1-required',
        evidenceId: 'required-ci',
        kind: 'required_ci',
        gate: 'G1',
        maxAgeSeconds: 3600,
      },
      {
        requirementId: 'g3-verification',
        evidenceId: 'verification-suite',
        kind: 'agent_task_suite',
        gate: 'G3',
        capability: 'verification',
        maxAgeSeconds: 3600,
      },
      ...(mode === 'github_release'
        ? [
            {
              requirementId: 'g5-maintainer-security-review',
              evidenceId: 'maintainer-security-review',
              kind: 'maintainer_security_review' as const,
              gate: 'G5' as const,
              maxAgeSeconds: 3600,
              requiredRouteIdentity: 'route:deepseek-v4-flash',
              requiredPlatformIdentity: 'ubuntu-24.04-x64',
            },
          ]
        : []),
    ],
  });
}

function artifactIdentity(gatePolicyDigest: string): ReleaseArtifactIdentity {
  return {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    commit: COMMIT,
    payloadSha256: digest('payload'),
    canonicalManifestDigest: digest('manifest'),
    behaviorDigest: digest('behavior'),
    profileDigest: digest('profile'),
    gatePolicyDigest,
  };
}

function result(
  identity: ReleaseArtifactIdentity,
  input: Pick<ReleaseEvidenceResult, 'evidenceId' | 'kind' | 'gate'> &
    Partial<Pick<ReleaseEvidenceResult, 'capability' | 'status'>>,
): ReleaseEvidenceResult {
  return {
    evidenceId: input.evidenceId,
    kind: input.kind,
    gate: input.gate,
    ...(input.capability ? { capability: input.capability } : {}),
    status: input.status ?? 'passed',
    artifactIdentity: identity,
    executionIdentity: {
      source: 'local_synthetic',
      fixtureId: 'release-foundation-v1',
      runner: 'bun-test',
      commit: COMMIT,
      startedAt: '2026-08-02T00:30:00.000Z',
      endedAt: '2026-08-02T00:45:00.000Z',
    },
    suiteIdentity: `${input.evidenceId}-suite-v1`,
    record: {
      uri: `https://example.invalid/evidence/${input.evidenceId}.json`,
      digest: digest(`${input.evidenceId}-record`),
    },
    summary: 'Synthetic foundation result.',
  };
}

function fixture(options?: { verificationStatus?: 'passed' | 'failed'; omitG0?: boolean }) {
  const gatePolicy = policy();
  const identity = artifactIdentity(gatePolicy.policyDigest);
  const results = [
    result(identity, {
      evidenceId: 'required-ci',
      kind: 'required_ci',
      gate: 'G1',
    }),
    result(identity, {
      evidenceId: 'verification-suite',
      kind: 'agent_task_suite',
      gate: 'G3',
      capability: 'verification',
      status: options?.verificationStatus ?? 'passed',
    }),
  ];
  if (!options?.omitG0) {
    results.unshift(
      result(identity, {
        evidenceId: 'execution-conformance',
        kind: 'execution_conformance',
        gate: 'G0',
      }),
    );
  }
  const evidence = buildReleaseEvidenceBundle({
    schema: 'ReleaseEvidence',
    evidenceBundleId: 'release-foundation-v1',
    generatedAt: EVALUATED_AT,
    artifactIdentity: identity,
    nonDistributable: true,
    syntheticTrustRoot: true,
    results,
    risks: [],
    exceptions: [],
  });
  return { gatePolicy, identity, evidence };
}

function githubResult(
  identity: ReleaseArtifactIdentity,
  input: Pick<ReleaseEvidenceResult, 'evidenceId' | 'kind' | 'gate'> &
    Partial<Pick<ReleaseEvidenceResult, 'capability' | 'status'>> & {
      endedAt?: string;
      startedAt?: string;
      actorIdentity?: string;
      reviewerIdentity?: string;
      workflowSha?: string;
    },
): ReleaseEvidenceResult {
  const common = {
    evidenceId: input.evidenceId,
    kind: input.kind,
    gate: input.gate,
    ...(input.capability ? { capability: input.capability } : {}),
    status: input.status ?? ('passed' as const),
    artifactIdentity: identity,
    suiteIdentity: `${input.evidenceId}-suite-v1`,
    record: {
      uri: `https://example.invalid/evidence/${input.evidenceId}.json`,
      digest: digest(`${input.evidenceId}-record`),
    },
    summary: 'Candidate-bound release evidence.',
  };
  if (input.kind === 'maintainer_security_review') {
    const reviewerIdentity = input.reviewerIdentity ?? 'github:@ferqx';
    const reviewedAt = input.endedAt ?? '2026-08-02T00:45:00.000Z';
    const reviewExecution = {
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      workflowPath: '.github/workflows/release-candidate.yml',
      workflowRef: 'ferqx/kite-code/.github/workflows/release-candidate.yml@refs/tags/v1.0.0',
      workflowSha: input.workflowSha ?? COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com' as const,
      ref: 'refs/tags/v1.0.0',
      runId: '12345',
      runAttempt: 1,
      actorIdentity: input.actorIdentity ?? reviewerIdentity,
    };
    const maintainerReview = buildMaintainerSecurityReviewRecord({
      schema: 'MaintainerSecurityReviewRecord',
      reviewMode: 'single_maintainer',
      reviewerIdentity,
      reviewedAt,
      outcome: input.status === 'failed' ? 'failed' : 'passed',
      candidate: identity,
      execution: reviewExecution,
      ref: 'refs/tags/v1.0.0',
      trustedVerifierCommit: COMMIT,
      routeIdentity: 'route:deepseek-v4-flash',
      platformIdentity: 'ubuntu-24.04-x64',
      rollbackReportDigest: digest('rollback-report'),
      compatibilityReportDigest: digest('compatibility-report'),
      scope: [
        'architecture',
        'security_boundaries',
        'artifact_identity',
        'rollback',
        'adversarial_bypass',
      ],
      unresolvedP0: 0,
      unresolvedP1: 0,
      p2Dispositions: [],
    });
    return {
      ...common,
      routeIdentity: maintainerReview.routeIdentity,
      platformIdentity: maintainerReview.platformIdentity,
      record: {
        ...common.record,
        digest: maintainerReview.recordDigest,
      },
      maintainerReview,
      executionIdentity: {
        source: 'github_maintainer_review',
        ...reviewExecution,
        reviewerIdentity,
        recordIdentity: 'security-review-record-2026-08-02',
        commit: COMMIT,
        startedAt: input.startedAt ?? '2026-08-02T00:30:00.000Z',
        endedAt: reviewedAt,
      },
    };
  }
  return {
    ...common,
    executionIdentity: {
      source: 'github_actions',
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      workflowPath: '.github/workflows/release-candidate.yml',
      workflowRef: 'ferqx/kite-code/.github/workflows/release-candidate.yml@refs/tags/v1.0.0',
      workflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      ref: 'refs/tags/v1.0.0',
      runId: '12345',
      runAttempt: 1,
      job: input.evidenceId,
      commit: COMMIT,
      startedAt: '2026-08-02T00:30:00.000Z',
      endedAt: input.endedAt ?? '2026-08-02T00:45:00.000Z',
    },
  };
}

function githubFixture(options?: {
  omitSecurityReview?: boolean;
  securityReviewer?: string;
  securityActor?: string;
  securityWorkflowSha?: string;
  securityEndedAt?: string;
  securityStartedAt?: string;
  securityStatus?: 'passed' | 'failed';
  waiveSecurityFailure?: boolean;
  extraResult?: boolean;
  omitG0?: boolean;
}) {
  const gatePolicy = policy('github_release');
  const identity = artifactIdentity(gatePolicy.policyDigest);
  const results: ReleaseEvidenceResult[] = [
    githubResult(identity, {
      evidenceId: 'required-ci',
      kind: 'required_ci',
      gate: 'G1',
    }),
    githubResult(identity, {
      evidenceId: 'verification-suite',
      kind: 'agent_task_suite',
      gate: 'G3',
      capability: 'verification',
    }),
  ];
  if (!options?.omitG0) {
    results.unshift(
      githubResult(identity, {
        evidenceId: 'execution-conformance',
        kind: 'execution_conformance',
        gate: 'G0',
      }),
    );
  }
  if (!options?.omitSecurityReview) {
    results.push(
      githubResult(identity, {
        evidenceId: 'maintainer-security-review',
        kind: 'maintainer_security_review',
        gate: 'G5',
        reviewerIdentity: options?.securityReviewer,
        actorIdentity: options?.securityActor,
        workflowSha: options?.securityWorkflowSha,
        startedAt: options?.securityStartedAt,
        endedAt: options?.securityEndedAt,
        status: options?.securityStatus,
      }),
    );
  }
  if (options?.extraResult) {
    results.push(
      githubResult(identity, {
        evidenceId: 'unrequired-security-claim',
        kind: 'maintainer_security_review',
        gate: 'G5',
      }),
    );
  }
  const evidence = buildReleaseEvidenceBundle({
    schema: 'ReleaseEvidence',
    evidenceBundleId: 'github-release-candidate-v1',
    generatedAt: EVALUATED_AT,
    artifactIdentity: identity,
    nonDistributable: false,
    syntheticTrustRoot: false,
    results,
    risks: [],
    exceptions: options?.waiveSecurityFailure
      ? [
          {
            exceptionId: 'attempted-security-review-waiver',
            evidenceId: 'maintainer-security-review',
            gate: 'G5',
            approvedBy: 'github:@ferqx',
            reason: 'A release security review is not waivable.',
            approvedAt: '2026-08-02T00:50:00.000Z',
            expiresAt: '2026-08-02T01:30:00.000Z',
            record: {
              uri: 'https://example.invalid/exceptions/security-review.json',
              digest: digest('attempted-security-review-waiver'),
            },
          },
        ]
      : [],
  });
  return { gatePolicy, identity, evidence };
}

describe('deterministic release Gate evaluator', () => {
  test('produces the non-distributable MS:2A-F foundation record', () => {
    const record = buildSyntheticFoundationGateRecord();
    expect(record.fixtureClass).toBe('synthetic_non_production');
    expect(record.distributable).toBe(false);
    expect(record.realSigningEnabled).toBe(false);
    expect(record.decision.overall).toBe('approved_foundation');
    expect(record.milestone).toBe('MS:2A-F');
  });

  test('replays an identity-bound synthetic foundation decision', () => {
    const { gatePolicy, identity, evidence } = fixture();
    const first = evaluateReleaseGate({
      policy: gatePolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    const replay = evaluateReleaseGate({
      policy: structuredClone(gatePolicy),
      evidence: structuredClone(evidence),
      artifactIdentity: structuredClone(identity),
      evaluatedAt: EVALUATED_AT,
    });
    expect(first).toEqual(replay);
    expect(first.overall).toBe('approved_foundation');
    expect(first.gates.filter(({ gate }) => gate === 'G0' || gate === 'G1')).toEqual([
      { gate: 'G0', status: 'passed', reasons: [] },
      { gate: 'G1', status: 'passed', reasons: [] },
    ]);
    expect(
      first.gates
        .filter(({ gate }) => gate !== 'G0' && gate !== 'G1')
        .every(({ status }) => status === 'not_applicable'),
    ).toBe(true);
    expect(first.decisionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('disables only the affected capability for a G3 failure', () => {
    const { gatePolicy, identity, evidence } = fixture({ verificationStatus: 'failed' });
    const decision = evaluateReleaseGate({
      policy: gatePolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('approved_foundation');
    expect(decision.capabilities).toEqual([
      {
        capability: 'verification',
        status: 'disabled',
        reasons: ['g3-verification:evidence_failed'],
      },
    ]);
  });

  test('blocks missing global evidence and artifact/policy identity mismatch', () => {
    const missing = fixture({ omitG0: true });
    const missingDecision = evaluateReleaseGate({
      policy: missing.gatePolicy,
      evidence: missing.evidence,
      artifactIdentity: missing.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(missingDecision.overall).toBe('blocked');
    expect(missingDecision.requirements[0]?.reasons).toContain('missing_evidence');

    const complete = fixture();
    const mismatched = { ...complete.identity, profileDigest: digest('other-profile') };
    const mismatchDecision = evaluateReleaseGate({
      policy: complete.gatePolicy,
      evidence: complete.evidence,
      artifactIdentity: mismatched,
      evaluatedAt: EVALUATED_AT,
    });
    expect(mismatchDecision.overall).toBe('blocked');
    expect(mismatchDecision.gates[0]?.reasons).toContain('artifact_identity_mismatch');
  });

  test('never treats synthetic evidence as a GitHub release candidate', () => {
    const githubPolicy = policy('github_release');
    const identity = artifactIdentity(githubPolicy.policyDigest);
    const synthetic = fixture();
    const { bundleDigest: _bundleDigest, ...syntheticMaterial } = synthetic.evidence;
    const evidence = buildReleaseEvidenceBundle({
      ...syntheticMaterial,
      artifactIdentity: identity,
      results: synthetic.evidence.results.map((entry) => ({
        ...entry,
        artifactIdentity: identity,
      })),
    });
    const decision = evaluateReleaseGate({
      policy: githubPolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);
    expect(decision.gates[0]?.reasons).toContain('github_release_rejects_synthetic_evidence');
  });

  test('requires exactly one fresh global maintainer security review policy item', () => {
    const material = {
      schema: 'ReleaseGatePolicy' as const,
      policyId: 'invalid-github-policy',
      mode: 'github_release' as const,
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      releaseWorkflowPath: '.github/workflows/release-candidate.yml',
      releaseWorkflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com' as const,
      allowedRefPrefixes: ['refs/tags/v'],
      capabilities: ['verification'],
      requirements: [
        {
          requirementId: 'g1-required',
          evidenceId: 'required-ci',
          kind: 'required_ci' as const,
          gate: 'G1' as const,
          maxAgeSeconds: 3600,
        },
      ],
    };
    expect(() => buildReleaseGatePolicy(material)).toThrow('exactly one');
    expect(() =>
      buildReleaseGatePolicy({
        ...material,
        requirements: [
          ...material.requirements,
          {
            requirementId: 'security-a',
            evidenceId: 'security-a',
            kind: 'maintainer_security_review',
            gate: 'G5',
            maxAgeSeconds: 3600,
            requiredRouteIdentity: 'route:deepseek-v4-flash',
            requiredPlatformIdentity: 'ubuntu-24.04-x64',
          },
          {
            requirementId: 'security-b',
            evidenceId: 'security-b',
            kind: 'maintainer_security_review',
            gate: 'G5',
            maxAgeSeconds: 3600,
            requiredRouteIdentity: 'route:deepseek-v4-flash',
            requiredPlatformIdentity: 'ubuntu-24.04-x64',
          },
        ],
      }),
    ).toThrow('exactly one');
  });

  test('accepts a fresh candidate-bound single-maintainer review', () => {
    const valid = githubFixture();
    const decision = evaluateReleaseGate({
      policy: valid.gatePolicy,
      evidence: valid.evidence,
      artifactIdentity: valid.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('approved_candidate');
    expect(decision.requiredManualApprovals).toEqual([]);
    expect(decision.requirements.at(-1)?.status).toBe('passed');

    const missing = githubFixture({ omitSecurityReview: true });
    const missingDecision = evaluateReleaseGate({
      policy: missing.gatePolicy,
      evidence: missing.evidence,
      artifactIdentity: missing.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(missingDecision.overall).toBe('blocked');
    expect(missingDecision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);

    const mismatchedIdentity = { ...valid.identity, behaviorDigest: digest('other-behavior') };
    const mismatchedDecision = evaluateReleaseGate({
      policy: valid.gatePolicy,
      evidence: valid.evidence,
      artifactIdentity: mismatchedIdentity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(mismatchedDecision.overall).toBe('blocked');
    expect(mismatchedDecision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);
  });

  test('rejects a non-maintainer identity and stale maintainer review evidence', () => {
    for (const [fixtureValue, reason] of [
      [
        githubFixture({ securityReviewer: 'github:@someone-else' }),
        'security_review_maintainer_identity_mismatch',
      ],
      [
        githubFixture({ securityActor: 'github:@someone-else' }),
        'security_review_maintainer_identity_mismatch',
      ],
      [
        githubFixture({ securityWorkflowSha: '2'.repeat(40) }),
        'security_review_github_identity_mismatch',
      ],
      [
        githubFixture({
          securityStartedAt: '2026-08-01T00:30:00.000Z',
          securityEndedAt: '2026-08-01T00:45:00.000Z',
        }),
        'stale_evidence',
      ],
    ] as const) {
      const decision = evaluateReleaseGate({
        policy: fixtureValue.gatePolicy,
        evidence: fixtureValue.evidence,
        artifactIdentity: fixtureValue.identity,
        evaluatedAt: EVALUATED_AT,
      });
      expect(decision.overall).toBe('blocked');
      expect(decision.requirements.at(-1)?.reasons).toContain(reason);
      expect(decision.requiredManualApprovals).toEqual([
        'candidate_bound_maintainer_security_review',
      ]);
    }
  });

  test('does not allow an exception to waive the security review', () => {
    const fixtureValue = githubFixture({
      securityStatus: 'failed',
      waiveSecurityFailure: true,
    });
    const decision = evaluateReleaseGate({
      policy: fixtureValue.gatePolicy,
      evidence: fixtureValue.evidence,
      artifactIdentity: fixtureValue.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requirements.at(-1)).toMatchObject({
      status: 'blocked',
    });
    expect(decision.requirements.at(-1)?.reasons).toEqual(['evidence_failed']);
    expect(decision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);
  });

  test('does not allow maintainer acceptance to close a P0 or P1 risk', () => {
    const valid = githubFixture();
    const { bundleDigest: _bundleDigest, ...material } = valid.evidence;
    const evidence = buildReleaseEvidenceBundle({
      ...material,
      risks: [
        {
          riskId: 'candidate-auth-bypass',
          severity: 'P1',
          status: 'accepted',
          summary: 'The maintainer cannot accept an unresolved P1 for release.',
        },
      ],
    });
    const decision = evaluateReleaseGate({
      policy: valid.gatePolicy,
      evidence,
      artifactIdentity: valid.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.gates[0]?.reasons).toContain('unresolved_p1_risk:candidate-auth-bypass');
    expect(decision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);
  });

  test('rejects extra unrequired results instead of treating them as approval', () => {
    const fixtureValue = githubFixture({ omitSecurityReview: true, extraResult: true });
    const decision = evaluateReleaseGate({
      policy: fixtureValue.gatePolicy,
      evidence: fixtureValue.evidence,
      artifactIdentity: fixtureValue.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requiredManualApprovals).toEqual([
      'candidate_bound_maintainer_security_review',
    ]);
    expect(decision.gates[0]?.reasons).toContain('unexpected_evidence:unrequired-security-claim');
  });

  test('disables every capability on any global failure', () => {
    const fixtureValue = githubFixture({ omitG0: true });
    const decision = evaluateReleaseGate({
      policy: fixtureValue.gatePolicy,
      evidence: fixtureValue.evidence,
      artifactIdentity: fixtureValue.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.capabilities).toEqual([
      {
        capability: 'verification',
        status: 'disabled',
        reasons: ['g0-execution:missing_evidence'],
      },
    ]);
  });

  test('keeps a capability disabled when its policy has no applicable requirement', () => {
    const gatePolicy = buildReleaseGatePolicy({
      schema: 'ReleaseGatePolicy',
      policyId: 'synthetic-no-applicable-capability-requirement',
      mode: 'synthetic_foundation',
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      releaseWorkflowPath: '.github/workflows/release-candidate.yml',
      releaseWorkflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      allowedRefPrefixes: ['refs/tags/v'],
      capabilities: ['verification'],
      requirements: [],
    });
    const identity = artifactIdentity(gatePolicy.policyDigest);
    const evidence = buildReleaseEvidenceBundle({
      schema: 'ReleaseEvidence',
      evidenceBundleId: 'synthetic-no-applicable-capability-requirement',
      generatedAt: EVALUATED_AT,
      artifactIdentity: identity,
      nonDistributable: true,
      syntheticTrustRoot: true,
      results: [],
      risks: [],
      exceptions: [],
    });
    const decision = evaluateReleaseGate({
      policy: gatePolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.capabilities).toEqual([
      {
        capability: 'verification',
        status: 'disabled',
        reasons: ['no_applicable_requirement'],
      },
    ]);
  });
});
