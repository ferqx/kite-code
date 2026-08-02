import {
  CAPABILITY_EVALUATION_REPOSITORY,
  CAPABILITY_EVALUATION_REPOSITORY_ID,
  CAPABILITY_EVALUATION_WORKFLOW_PATH,
  type CapabilityEvaluationCapabilityV1,
  type CapabilityEvaluationEvidenceV1,
  type CapabilityEvaluationExpectedIdentityV1,
  type CapabilityEvaluationRetainedReceiptV1,
  capabilityEvaluationRetainedReceiptV1Schema,
  computeCapabilityArtifactIdentityDigestV1,
  computeCapabilityEvaluationBundleDigestV1,
  computeCapabilityEvaluationLedgerDigestV1,
  computeCapabilityEvaluationReceiptDigestV1,
  computeCapabilityEvaluationSourceDigestV1,
  computeCapabilityEvaluatorIdentityDigestV1,
} from '../../../scripts/evals/contracts/capability-evaluation-evidence';
import { sha256Digest } from '../../../scripts/release/canonical-json';

export const fixtureDigest = (label: string): `sha256:${string}` => sha256Digest(label);

type SafetyOverride = Readonly<Record<string, number>>;

export function buildCapabilityEvidenceFixtureV1(
  capability: CapabilityEvaluationCapabilityV1,
  safetyOverride: SafetyOverride = {},
): {
  evidence: CapabilityEvaluationEvidenceV1;
  expected: CapabilityEvaluationExpectedIdentityV1;
} {
  const headSha = 'a'.repeat(40);
  const ref = 'refs/heads/main';
  const source = {
    schema: 'CapabilityEvaluationSourceV1' as const,
    canonicalRepository: CAPABILITY_EVALUATION_REPOSITORY,
    repositoryId: CAPABILITY_EVALUATION_REPOSITORY_ID,
    headSha,
    ref,
    workflowPath: CAPABILITY_EVALUATION_WORKFLOW_PATH,
    workflowRef: `${CAPABILITY_EVALUATION_REPOSITORY}/${CAPABILITY_EVALUATION_WORKFLOW_PATH}@${ref}`,
    workflowSha: 'b'.repeat(40),
    runId: '30750000000',
    runAttempt: 1,
    job: `evaluate-${capability}`,
    retainedArtifactId: '8840000000',
    retainedArtifactName: `capability-evaluation-${capability}-30750000000`,
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T00:10:00.000Z',
  };
  const profileDigest = fixtureDigest(`profile:${capability}`);
  const artifactIdentity = {
    canonicalRepository: CAPABILITY_EVALUATION_REPOSITORY,
    repositoryId: CAPABILITY_EVALUATION_REPOSITORY_ID,
    commit: headSha,
    payloadSha256: fixtureDigest('payload'),
    canonicalManifestDigest: fixtureDigest('manifest'),
    behaviorDigest: fixtureDigest('behavior'),
    profileDigest,
    gatePolicyDigest: fixtureDigest('gate-policy'),
  };
  const routeDigest = fixtureDigest(`route:${capability}`);
  const evaluatorIdentity = {
    schema: 'CapabilityEvaluatorIdentityV1' as const,
    evaluatorIdentity: `fixture-evaluator:${capability}`,
    evaluatorRouteDigest: fixtureDigest('evaluator-route'),
    evaluatorConfigDigest: fixtureDigest('evaluator-config'),
    rubricDigest: fixtureDigest(`rubric:${capability}`),
    verifierRevision: 'capability-evidence-verifier-v1',
  };
  const sourceDigest = computeCapabilityEvaluationSourceDigestV1(source);
  const artifactIdentityDigest = computeCapabilityArtifactIdentityDigestV1(artifactIdentity);
  const evaluatorIdentityDigest = computeCapabilityEvaluatorIdentityDigestV1(evaluatorIdentity);
  const common = {
    schema: 'CapabilityEvaluationRetainedReceiptV1' as const,
    sequence: 1,
    receiptId: `receipt-${capability}-1`,
    caseId: `case-${capability}-1`,
    retained: true as const,
    outcome: 'passed' as const,
    artifactIdentityDigest,
    routeDigest,
    profileDigest,
    evaluatorIdentityDigest,
    sourceDigest,
    observedResultDigest: fixtureDigest(`observed-result:${capability}`),
    previousReceiptDigest: null,
  };
  let receiptMaterial: Omit<CapabilityEvaluationRetainedReceiptV1, 'receiptDigest'>;
  if (capability === 'verification') {
    receiptMaterial = {
      ...common,
      capability,
      safety: {
        falsePass: 0,
        requiredVerificationBypass: 0,
        fabricatedEvidence: 0,
        unknownEffectResolvedAsSuccess: 0,
        ...safetyOverride,
      },
    };
  } else if (capability === 'mcp_write') {
    receiptMaterial = {
      ...common,
      capability,
      safety: {
        falseCompletion: 0,
        duplicateEffect: 0,
        unauthorizedEffect: 0,
        dataBoundaryViolation: 0,
        unknownEffectResolvedAsSuccess: 0,
        ...safetyOverride,
      },
    };
  } else {
    receiptMaterial = {
      ...common,
      capability,
      safety: {
        falseCompletion: 0,
        maliciousInstructionAccepted: 0,
        invalidShadowingAccepted: 0,
        dependencyRevisionDrift: 0,
        referenceBoundaryViolation: 0,
        duplicateEffect: 0,
        unknownEffectResolvedAsSuccess: 0,
        ...safetyOverride,
      },
    };
  }
  const receipt = capabilityEvaluationRetainedReceiptV1Schema.parse({
    ...receiptMaterial,
    receiptDigest: computeCapabilityEvaluationReceiptDigestV1(receiptMaterial),
  });
  const receipts = [receipt];
  const bundleMaterial = {
    schema: 'CapabilityEvaluationEvidenceV1' as const,
    executionClass: 'contract_conformance' as const,
    capability,
    source,
    artifactIdentity,
    routeDigest,
    profileDigest,
    evaluatorIdentity,
    receipts,
    receiptLedgerDigest: computeCapabilityEvaluationLedgerDigestV1(receipts),
    observedAt: source.endedAt,
    freshnessSeconds: 86_400,
    expiresAt: '2026-08-03T00:10:00.000Z',
  };
  const evidence: CapabilityEvaluationEvidenceV1 = {
    ...bundleMaterial,
    bundleDigest: computeCapabilityEvaluationBundleDigestV1(bundleMaterial),
    authentication: {
      kind: 'unconfigured',
      algorithm: 'none',
      reason: 'production_oidc_sigstore_authority_unconfigured',
    },
  };
  return {
    evidence,
    expected: {
      capability,
      source,
      artifactIdentity,
      routeDigest,
      profileDigest,
      evaluatorIdentityDigest,
      freshnessSeconds: 86_400,
      now: '2026-08-02T12:00:00.000Z',
    },
  };
}
