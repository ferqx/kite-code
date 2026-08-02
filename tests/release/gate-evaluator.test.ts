import { describe, expect, test } from 'bun:test';
import { sha256Digest } from '../../scripts/release/canonical-json';
import { buildReleaseEvidenceBundleV1 } from '../../scripts/release/evidence-bundle';
import type {
  ReleaseArtifactIdentityV1,
  ReleaseEvidenceResultV1,
} from '../../scripts/release/evidence-schema';
import { buildSyntheticFoundationGateRecordV1 } from '../../scripts/release/foundation-gate';
import {
  buildReleaseGatePolicyV1,
  evaluateReleaseGateV1,
  type ReleaseGatePolicyV1,
} from '../../scripts/release/gate-evaluator';

const COMMIT = 'a'.repeat(40);
const EVALUATED_AT = '2026-08-02T01:00:00.000Z';

function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}

function policy(
  mode: 'synthetic_foundation' | 'github_release' = 'synthetic_foundation',
): ReleaseGatePolicyV1 {
  return buildReleaseGatePolicyV1({
    schema: 'ReleaseGatePolicyV1',
    policyId: 'release-foundation-policy-v1',
    mode,
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    releaseWorkflowPath: '.github/workflows/release-candidate.yml',
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
              requirementId: 'g5-independent-security-review',
              evidenceId: 'independent-security-review',
              kind: 'third_party_security_review' as const,
              gate: 'G5' as const,
              maxAgeSeconds: 3600,
            },
          ]
        : []),
    ],
  });
}

function artifactIdentity(gatePolicyDigest: string): ReleaseArtifactIdentityV1 {
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
  identity: ReleaseArtifactIdentityV1,
  input: Pick<ReleaseEvidenceResultV1, 'evidenceId' | 'kind' | 'gate'> &
    Partial<Pick<ReleaseEvidenceResultV1, 'capability' | 'status'>>,
): ReleaseEvidenceResultV1 {
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
  const evidence = buildReleaseEvidenceBundleV1({
    schema: 'ReleaseEvidenceV1',
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
  identity: ReleaseArtifactIdentityV1,
  input: Pick<ReleaseEvidenceResultV1, 'evidenceId' | 'kind' | 'gate'> &
    Partial<Pick<ReleaseEvidenceResultV1, 'capability' | 'status'>> & {
      endedAt?: string;
      startedAt?: string;
      reviewerIdentity?: string;
    },
): ReleaseEvidenceResultV1 {
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
  if (input.kind === 'third_party_security_review') {
    return {
      ...common,
      executionIdentity: {
        source: 'external',
        reviewerIdentity: input.reviewerIdentity ?? 'security-reviewer:independent-firm',
        recordIdentity: 'security-review-record-2026-08-02',
        commit: COMMIT,
        startedAt: input.startedAt ?? '2026-08-02T00:30:00.000Z',
        endedAt: input.endedAt ?? '2026-08-02T00:45:00.000Z',
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
  securityEndedAt?: string;
  securityStartedAt?: string;
  securityStatus?: 'passed' | 'failed';
  waiveSecurityFailure?: boolean;
  extraResult?: boolean;
  omitG0?: boolean;
}) {
  const gatePolicy = policy('github_release');
  const identity = artifactIdentity(gatePolicy.policyDigest);
  const results: ReleaseEvidenceResultV1[] = [
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
        evidenceId: 'independent-security-review',
        kind: 'third_party_security_review',
        gate: 'G5',
        reviewerIdentity: options?.securityReviewer,
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
        kind: 'third_party_security_review',
        gate: 'G5',
      }),
    );
  }
  const evidence = buildReleaseEvidenceBundleV1({
    schema: 'ReleaseEvidenceV1',
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
            evidenceId: 'independent-security-review',
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
    const record = buildSyntheticFoundationGateRecordV1();
    expect(record.fixtureClass).toBe('synthetic_non_production');
    expect(record.distributable).toBe(false);
    expect(record.realSigningEnabled).toBe(false);
    expect(record.decision.overall).toBe('approved_foundation');
    expect(record.milestone).toBe('MS:2A-F');
  });

  test('replays an identity-bound synthetic foundation decision', () => {
    const { gatePolicy, identity, evidence } = fixture();
    const first = evaluateReleaseGateV1({
      policy: gatePolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    const replay = evaluateReleaseGateV1({
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
    const decision = evaluateReleaseGateV1({
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
    const missingDecision = evaluateReleaseGateV1({
      policy: missing.gatePolicy,
      evidence: missing.evidence,
      artifactIdentity: missing.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(missingDecision.overall).toBe('blocked');
    expect(missingDecision.requirements[0]?.reasons).toContain('missing_evidence');

    const complete = fixture();
    const mismatched = { ...complete.identity, profileDigest: digest('other-profile') };
    const mismatchDecision = evaluateReleaseGateV1({
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
    const evidence = buildReleaseEvidenceBundleV1({
      ...syntheticMaterial,
      artifactIdentity: identity,
      results: synthetic.evidence.results.map((entry) => ({
        ...entry,
        artifactIdentity: identity,
      })),
    });
    const decision = evaluateReleaseGateV1({
      policy: githubPolicy,
      evidence,
      artifactIdentity: identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requiredManualApprovals).toEqual(['independent_third_party_security_review']);
    expect(decision.gates[0]?.reasons).toContain('github_release_rejects_synthetic_evidence');
  });

  test('requires exactly one fresh global third-party security review policy item', () => {
    const material = {
      schema: 'ReleaseGatePolicyV1' as const,
      policyId: 'invalid-github-policy',
      mode: 'github_release' as const,
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      releaseWorkflowPath: '.github/workflows/release-candidate.yml',
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
    expect(() => buildReleaseGatePolicyV1(material)).toThrow('exactly one');
    expect(() =>
      buildReleaseGatePolicyV1({
        ...material,
        requirements: [
          ...material.requirements,
          {
            requirementId: 'security-a',
            evidenceId: 'security-a',
            kind: 'third_party_security_review',
            gate: 'G5',
            maxAgeSeconds: 3600,
          },
          {
            requirementId: 'security-b',
            evidenceId: 'security-b',
            kind: 'third_party_security_review',
            gate: 'G5',
            maxAgeSeconds: 3600,
          },
        ],
      }),
    ).toThrow('exactly one');
  });

  test('keeps a candidate-bound external review blocked until a real reviewer trust root exists', () => {
    const valid = githubFixture();
    const decision = evaluateReleaseGateV1({
      policy: valid.gatePolicy,
      evidence: valid.evidence,
      artifactIdentity: valid.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requiredManualApprovals).toEqual(['independent_third_party_security_review']);
    expect(decision.requirements.at(-1)?.status).toBe('blocked');
    expect(decision.requirements.at(-1)?.reasons).toContain(
      'security_review_trust_root_unconfigured',
    );

    const missing = githubFixture({ omitSecurityReview: true });
    const missingDecision = evaluateReleaseGateV1({
      policy: missing.gatePolicy,
      evidence: missing.evidence,
      artifactIdentity: missing.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(missingDecision.overall).toBe('blocked');
    expect(missingDecision.requiredManualApprovals).toEqual([
      'independent_third_party_security_review',
    ]);

    const mismatchedIdentity = { ...valid.identity, behaviorDigest: digest('other-behavior') };
    const mismatchedDecision = evaluateReleaseGateV1({
      policy: valid.gatePolicy,
      evidence: valid.evidence,
      artifactIdentity: mismatchedIdentity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(mismatchedDecision.overall).toBe('blocked');
    expect(mismatchedDecision.requiredManualApprovals).toEqual([
      'independent_third_party_security_review',
    ]);
  });

  test('rejects maintainer self-review and stale external review evidence', () => {
    for (const [fixtureValue, reason] of [
      [
        githubFixture({ securityReviewer: 'github:@ferqx' }),
        'security_review_requires_independent_reviewer',
      ],
      [
        githubFixture({
          securityStartedAt: '2026-08-01T00:30:00.000Z',
          securityEndedAt: '2026-08-01T00:45:00.000Z',
        }),
        'stale_evidence',
      ],
    ] as const) {
      const decision = evaluateReleaseGateV1({
        policy: fixtureValue.gatePolicy,
        evidence: fixtureValue.evidence,
        artifactIdentity: fixtureValue.identity,
        evaluatedAt: EVALUATED_AT,
      });
      expect(decision.overall).toBe('blocked');
      expect(decision.requirements.at(-1)?.reasons).toContain(reason);
      expect(decision.requiredManualApprovals).toEqual(['independent_third_party_security_review']);
    }
  });

  test('does not allow an exception to waive the security review', () => {
    const fixtureValue = githubFixture({
      securityStatus: 'failed',
      waiveSecurityFailure: true,
    });
    const decision = evaluateReleaseGateV1({
      policy: fixtureValue.gatePolicy,
      evidence: fixtureValue.evidence,
      artifactIdentity: fixtureValue.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requirements.at(-1)).toMatchObject({
      status: 'blocked',
    });
    expect(decision.requirements.at(-1)?.reasons).toEqual([
      'security_review_trust_root_unconfigured',
      'evidence_failed',
    ]);
    expect(decision.requiredManualApprovals).toEqual(['independent_third_party_security_review']);
  });

  test('rejects extra unrequired results instead of treating them as approval', () => {
    const fixtureValue = githubFixture({ omitSecurityReview: true, extraResult: true });
    const decision = evaluateReleaseGateV1({
      policy: fixtureValue.gatePolicy,
      evidence: fixtureValue.evidence,
      artifactIdentity: fixtureValue.identity,
      evaluatedAt: EVALUATED_AT,
    });
    expect(decision.overall).toBe('blocked');
    expect(decision.requiredManualApprovals).toEqual(['independent_third_party_security_review']);
    expect(decision.gates[0]?.reasons).toContain('unexpected_evidence:unrequired-security-claim');
  });

  test('disables every capability on any global failure', () => {
    const fixtureValue = githubFixture({ omitG0: true });
    const decision = evaluateReleaseGateV1({
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
        reasons: [
          'g0-execution:missing_evidence',
          'g5-independent-security-review:security_review_trust_root_unconfigured',
          'manual_approval_missing:independent_third_party_security_review',
        ],
      },
    ]);
  });

  test('keeps a capability disabled when its policy has no applicable requirement', () => {
    const gatePolicy = buildReleaseGatePolicyV1({
      schema: 'ReleaseGatePolicyV1',
      policyId: 'synthetic-no-applicable-capability-requirement',
      mode: 'synthetic_foundation',
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      releaseWorkflowPath: '.github/workflows/release-candidate.yml',
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      allowedRefPrefixes: ['refs/tags/v'],
      capabilities: ['verification'],
      requirements: [],
    });
    const identity = artifactIdentity(gatePolicy.policyDigest);
    const evidence = buildReleaseEvidenceBundleV1({
      schema: 'ReleaseEvidenceV1',
      evidenceBundleId: 'synthetic-no-applicable-capability-requirement',
      generatedAt: EVALUATED_AT,
      artifactIdentity: identity,
      nonDistributable: true,
      syntheticTrustRoot: true,
      results: [],
      risks: [],
      exceptions: [],
    });
    const decision = evaluateReleaseGateV1({
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
