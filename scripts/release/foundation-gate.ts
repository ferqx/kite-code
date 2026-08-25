import { sha256DomainSeparated } from './canonical-json';
import { buildReleaseEvidenceBundle } from './evidence-bundle';
import type { ReleaseArtifactIdentity } from './evidence-schema';
import { buildReleaseGatePolicy, evaluateReleaseGate } from './gate-evaluator';

const SYNTHETIC_COMMIT = '0000000000000000000000000000000000000000';
const FIXTURE_TIME = '1970-01-01T00:00:00.000Z';

function fixtureDigest(subject: string): `sha256:${string}` {
  return sha256DomainSeparated(`foundation-gate-fixture/${subject}`, subject);
}

export function buildSyntheticFoundationGateRecord() {
  const policy = buildReleaseGatePolicy({
    schema: 'ReleaseGatePolicy',
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
  const artifactIdentity: ReleaseArtifactIdentity = {
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
  const evidence = buildReleaseEvidenceBundle({
    schema: 'ReleaseEvidence',
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
  const decision = evaluateReleaseGate({
    policy,
    evidence,
    artifactIdentity,
    evaluatedAt: FIXTURE_TIME,
  });
  return Object.freeze({
    schema: 'ReleaseFoundationGateRecord' as const,
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
  process.stdout.write(`${JSON.stringify(buildSyntheticFoundationGateRecord(), null, 2)}\n`);
}
