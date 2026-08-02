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
});
