import { sha256DomainSeparated } from './canonical-json';
import { buildReleaseEvidenceBundleV1 } from './evidence-bundle';
import type { ReleaseArtifactIdentityV1 } from './evidence-schema';
import { buildReleaseGatePolicyV1, evaluateReleaseGateV1 } from './gate-evaluator';

const SYNTHETIC_COMMIT = '0000000000000000000000000000000000000000';
const FIXTURE_TIME = '1970-01-01T00:00:00.000Z';

function fixtureDigest(subject: string): `sha256:${string}` {
  return sha256DomainSeparated(`foundation-gate-fixture/${subject}`, subject);
}

export function buildSyntheticFoundationGateRecordV1() {
  const policy = buildReleaseGatePolicyV1({
    schema: 'ReleaseGatePolicyV1',
    policyId: 'release-contract-foundation-v1',
    mode: 'synthetic_foundation',
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    releaseWorkflowPath: '.github/workflows/release-candidate.yml',
    releaseWorkflowSha: SYNTHETIC_COMMIT,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    allowedRefPrefixes: ['refs/tags/v'],
    capabilities: [],
    requirements: [
      {
        requirementId: 'g0-pre-exec-verifier-contract',
        evidenceId: 'synthetic-bootstrap-verifier',
        kind: 'execution_conformance',
        gate: 'G0',
      },
      {
        requirementId: 'g1-release-foundation-tests',
        evidenceId: 'synthetic-release-tests',
        kind: 'unit_contract',
        gate: 'G1',
      },
    ],
  });
  const artifactIdentity: ReleaseArtifactIdentityV1 = {
    canonicalRepository: policy.canonicalRepository,
    repositoryId: policy.repositoryId,
    commit: SYNTHETIC_COMMIT,
    payloadSha256: fixtureDigest('payload'),
    canonicalManifestDigest: fixtureDigest('manifest'),
    behaviorDigest: fixtureDigest('behavior'),
    profileDigest: fixtureDigest('profile'),
    gatePolicyDigest: policy.policyDigest,
  };
  const result = (
    evidenceId: string,
    kind: 'execution_conformance' | 'unit_contract',
    gate: 'G0' | 'G1',
  ) => ({
    evidenceId,
    kind,
    gate,
    status: 'passed' as const,
    artifactIdentity,
    executionIdentity: {
      source: 'local_synthetic' as const,
      fixtureId: 'release-contract-foundation-v1',
      runner: 'bun-test',
      commit: SYNTHETIC_COMMIT,
      startedAt: FIXTURE_TIME,
      endedAt: FIXTURE_TIME,
    },
    suiteIdentity: `${evidenceId}-v1`,
    record: {
      uri: `https://example.invalid/kite-release-foundation/${evidenceId}.json`,
      digest: fixtureDigest(evidenceId),
    },
    summary: 'Non-distributable synthetic release-contract qualification fixture.',
  });
  const evidence = buildReleaseEvidenceBundleV1({
    schema: 'ReleaseEvidenceV1',
    evidenceBundleId: 'release-contract-foundation-v1',
    generatedAt: FIXTURE_TIME,
    artifactIdentity,
    nonDistributable: true,
    syntheticTrustRoot: true,
    results: [
      result('synthetic-bootstrap-verifier', 'execution_conformance', 'G0'),
      result('synthetic-release-tests', 'unit_contract', 'G1'),
    ],
    risks: [],
    exceptions: [],
  });
  const decision = evaluateReleaseGateV1({
    policy,
    evidence,
    artifactIdentity,
    evaluatedAt: FIXTURE_TIME,
  });
  return Object.freeze({
    schema: 'ReleaseFoundationGateRecordV1' as const,
    fixtureClass: 'synthetic_non_production' as const,
    distributable: false as const,
    realSigningEnabled: false as const,
    policy,
    evidence,
    decision,
    milestone: decision.overall === 'approved_foundation' ? ('MS:2A-F' as const) : null,
  });
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(buildSyntheticFoundationGateRecordV1(), null, 2)}\n`);
}
