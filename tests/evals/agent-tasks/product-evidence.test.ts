import { describe, expect, test } from 'bun:test';
import {
  createAgentTaskContractConformanceInputV1,
  produceContractAgentTaskProductEvidenceV1,
  produceUnsignedAgentTaskEvidenceV1,
} from '../../../scripts/evals/agent-task-evidence-producer';
import {
  type AgentTaskEvidenceSourceV1,
  computeAgentTaskCandidateDigestV1,
  computeAgentTaskSourceDigestV1,
} from '../../../scripts/evals/contracts/agent-task-authenticated-evidence';
import {
  type AgentTaskProductEvidenceV1,
  buildAgentTaskHumanOutcomeReceiptV1,
  buildAgentTaskUxReceiptV1,
  computeAgentTaskHumanConsentDigestV1,
  computeAgentTaskProductBundleDigestV1,
  computeAgentTaskProductLedgerDigestV1,
  verifyAgentTaskProductEvidenceV1,
} from '../../../scripts/evals/contracts/agent-task-product-evidence';
import { verifyFormalAgentTaskProductCompanionV1 } from '../../../scripts/evals/verify-agent-task-product-evidence';
import { sha256DomainSeparated } from '../../../scripts/release/canonical-json';

const HEAD = 'a'.repeat(40);
const digest = (label: string): `sha256:${string}` =>
  sha256DomainSeparated('kite.evals.agent-task-product-test.v1', label);

function fixture() {
  const retained = createAgentTaskContractConformanceInputV1({
    repository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    headSha: HEAD,
    stage: 'pinned_route_or_baseline_change',
    startedAt: '2026-08-03T00:00:00.000Z',
  });
  const source: AgentTaskEvidenceSourceV1 = {
    schema: 'AgentTaskEvidenceSourceV1',
    repository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    headSha: HEAD,
    ref: 'refs/heads/main',
    workflowPath: '.github/workflows/agent-task-evidence.yml',
    workflowRef: 'ferqx/kite-code/.github/workflows/agent-task-evidence.yml@refs/heads/main',
    workflowSha: HEAD,
    runId: '123',
    runAttempt: 1,
    job: 'agent-task-evidence',
    artifactId: '456',
    artifactName: 'agent-task-evidence-123',
    startedAt: retained.startedAt,
    endedAt: retained.endedAt,
  };
  const attemptId = retained.caseLedgers[0]!.attempts[0]!.attemptId;
  const caseId = retained.caseLedgers[0]!.caseId;
  const sourceDigest = computeAgentTaskSourceDigestV1(source);
  const candidateDigest = computeAgentTaskCandidateDigestV1(retained.candidate);
  const ux = buildAgentTaskUxReceiptV1({
    schema: 'AgentTaskUxReceiptV1',
    sequence: 1,
    caseId,
    attemptId,
    sourceDigest,
    candidateDigest,
    entrypoint: 'headless_cli',
    plan: 'reviewed',
    toolSearch: {
      required: true,
      expectedCapabilityAlias: 'builtin.read',
      selectedCapabilityAlias: 'builtin.read',
      outcome: 'found',
      latencyMs: 12,
    },
    unintendedDiscovery: { mcpTriggerCount: 0, skillTriggerCount: 0 },
    askUser: { expected: false, outcome: 'not_needed', canonicalQuestionDigest: null },
    recovery: 'recovered',
    verification: 'passed',
    reviewHandoff: 'ready',
    claimedComplete: false,
    userCorrections: 0,
    approvalCount: 1,
    observedAt: source.endedAt,
    previousReceiptDigest: null,
  });
  const consent = {
    explicitOptIn: true as const,
    grantedAt: source.startedAt,
    withdrawnAt: null,
    rawSessionContentShared: false as const,
    rawRepositoryContentShared: false as const,
    retentionPolicyDigest: digest('retention'),
  };
  const human = buildAgentTaskHumanOutcomeReceiptV1({
    schema: 'AgentTaskHumanOutcomeReceiptV1',
    sequence: 1,
    participantIdentityDigest: digest('participant'),
    reviewerIdentityDigest: digest('reviewer'),
    consentReceiptDigest: computeAgentTaskHumanConsentDigestV1(consent),
    consent,
    caseId,
    attemptId,
    sourceDigest,
    candidateDigest,
    blindMaterialDigest: digest('blind-material'),
    humanAccepted: true,
    integrated: true,
    reverted: false,
    taskUnderstandingBps: 10_000,
    reviewBurdenBps: 1_000,
    observedAt: source.endedAt,
    previousReceiptDigest: null,
  });
  const material = {
    schema: 'AgentTaskProductEvidenceV1' as const,
    executionClass: 'contract_conformance' as const,
    source,
    candidate: retained.candidate,
    uxReceipts: [ux],
    humanReceipts: [human],
    uxLedgerDigest: computeAgentTaskProductLedgerDigestV1('ux', [ux]),
    humanLedgerDigest: computeAgentTaskProductLedgerDigestV1('human', [human]),
  };
  const bundleDigest = computeAgentTaskProductBundleDigestV1(material);
  return {
    evidence: {
      ...material,
      bundleDigest,
      authentication: {
        kind: 'unconfigured' as const,
        reason: 'production_product_evidence_authority_unconfigured' as const,
        subjectDigest: bundleDigest,
      },
    },
    expectedSource: source,
    expectedCandidate: retained.candidate,
    expectedAttempts: [{ attemptId, caseId }],
    requiredHumanReceiptCount: 1,
  };
}

describe('Agent task product evidence companion', () => {
  test('rebuilds UX and human ledgers but remains blocked without production authority', () => {
    const result = verifyAgentTaskProductEvidenceV1(fixture());
    expect(result).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      verifiedUxReceiptCount: 1,
      verifiedHumanReceiptCount: 1,
      reasonCodes: [
        'contract_conformance_not_production',
        'production_product_evidence_authority_unconfigured',
      ],
    });
  });

  test('rejects receipt coverage gaps and canonical ledger tampering', () => {
    const missing = fixture();
    missing.expectedAttempts.push({
      attemptId: 'missing-attempt',
      caseId: missing.expectedAttempts[0]!.caseId,
    });
    expect(() => verifyAgentTaskProductEvidenceV1(missing)).toThrow('exact retained');

    const tampered = fixture();
    tampered.evidence.uxReceipts[0]!.toolSearch.latencyMs = 999;
    expect(() => verifyAgentTaskProductEvidenceV1(tampered)).toThrow('receipt digest mismatch');
  });

  test('marks false completion and unintended discovery as failed', () => {
    const candidate = fixture();
    const original = candidate.evidence.uxReceipts[0]!;
    const { receiptDigest: _receiptDigest, ...originalMaterial } = original;
    const replacement = buildAgentTaskUxReceiptV1({
      ...originalMaterial,
      verification: 'failed',
      claimedComplete: true,
      unintendedDiscovery: { mcpTriggerCount: 1, skillTriggerCount: 1 },
    });
    candidate.evidence.uxReceipts = [replacement];
    candidate.evidence.uxLedgerDigest = computeAgentTaskProductLedgerDigestV1('ux', [replacement]);
    const { bundleDigest: _old, authentication: _authentication, ...material } = candidate.evidence;
    candidate.evidence.bundleDigest = computeAgentTaskProductBundleDigestV1(material);
    candidate.evidence.authentication.subjectDigest = candidate.evidence.bundleDigest;
    const result = verifyAgentTaskProductEvidenceV1(candidate);
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'false_completion_claim',
        'unintended_mcp_trigger',
        'unintended_skill_trigger',
      ]),
    );
  });

  test('accepts the production authentication shape but not caller-authored trust', () => {
    const candidate = fixture();
    const {
      bundleDigest: _old,
      authentication: _oldAuthentication,
      ...material
    } = candidate.evidence;
    const productionMaterial = {
      ...material,
      executionClass: 'production_route_run' as const,
    };
    const bundleDigest = computeAgentTaskProductBundleDigestV1(productionMaterial);
    const evidence: AgentTaskProductEvidenceV1 = {
      ...productionMaterial,
      bundleDigest,
      authentication: {
        kind: 'github_oidc_sigstore_v1',
        authorityIdentity: 'github-actions:keyless-product-evidence',
        verifierIdentity: 'sigstore-verifier-v1',
        issuer: 'https://token.actions.githubusercontent.com',
        subjectDigest: bundleDigest,
        attestationDigest: digest('product-attestation'),
        verificationReceiptDigest: digest('product-verification-receipt'),
        verifiedAt: '2026-08-03T00:00:00.000Z',
      },
    };
    const result = verifyAgentTaskProductEvidenceV1({
      ...candidate,
      evidence,
      requiredHumanReceiptCount: 0,
    });
    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'external_population_insufficient',
        'human_receipt_count_insufficient',
        'production_product_evidence_authentication_time_invalid',
        'production_product_evidence_authority_unconfigured',
        'production_product_policy_unconfigured',
      ]),
    );
  });

  test('rejects invented human attempts, case remapping, and consent tampering', () => {
    const invented = fixture();
    const originalHuman = invented.evidence.humanReceipts[0]!;
    const { receiptDigest: _receiptDigest, ...originalHumanMaterial } = originalHuman;
    const inventedReceipt = buildAgentTaskHumanOutcomeReceiptV1({
      ...originalHumanMaterial,
      attemptId: 'invented-attempt',
    });
    invented.evidence.humanReceipts = [inventedReceipt];
    invented.evidence.humanLedgerDigest = computeAgentTaskProductLedgerDigestV1('human', [
      inventedReceipt,
    ]);
    const {
      bundleDigest: _inventedBundle,
      authentication: _inventedAuthentication,
      ...inventedMaterial
    } = invented.evidence;
    invented.evidence.bundleDigest = computeAgentTaskProductBundleDigestV1(inventedMaterial);
    invented.evidence.authentication.subjectDigest = invented.evidence.bundleDigest;
    expect(() => verifyAgentTaskProductEvidenceV1(invented)).toThrow('invented');

    const remapped = fixture();
    remapped.expectedAttempts[0] = {
      ...remapped.expectedAttempts[0]!,
      caseId: 'approved.12-workspace-adversarial.v1',
    };
    expect(() => verifyAgentTaskProductEvidenceV1(remapped)).toThrow('attempt-to-case binding');

    expect(() =>
      buildAgentTaskHumanOutcomeReceiptV1({
        ...originalHumanMaterial,
        consent: {
          ...originalHumanMaterial.consent,
          grantedAt: '2026-08-02T00:00:00.000Z',
        },
      }),
    ).toThrow('consent receipt digest mismatch');
  });

  test('formal producer and independent verifier bind all 96 contract attempts', () => {
    const retained = createAgentTaskContractConformanceInputV1({
      repository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      headSha: HEAD,
      stage: 'pinned_route_or_baseline_change',
      startedAt: '2026-08-03T00:00:00.000Z',
    });
    const source = fixture().expectedSource;
    source.startedAt = retained.startedAt;
    source.endedAt = retained.endedAt;
    const formalEvidence = produceUnsignedAgentTaskEvidenceV1({
      retainedInput: retained,
      source: {
        schema: source.schema,
        repository: source.repository,
        repositoryId: source.repositoryId,
        headSha: source.headSha,
        ref: source.ref,
        workflowPath: source.workflowPath,
        workflowRef: source.workflowRef,
        workflowSha: source.workflowSha,
        runId: source.runId,
        runAttempt: source.runAttempt,
        job: source.job,
        artifactId: source.artifactId,
        artifactName: source.artifactName,
      },
      signedAt: retained.endedAt,
    });
    const productEvidence = produceContractAgentTaskProductEvidenceV1({
      retainedInput: retained,
      formalEvidence,
    });
    const report = verifyFormalAgentTaskProductCompanionV1({
      formalEvidence,
      productEvidence,
      expectedSource: source,
      requiredHumanReceiptCount: 0,
    });
    expect(report).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      expectedAttemptCount: 96,
    });
    expect(report.productVerification).toMatchObject({
      verifiedUxReceiptCount: 96,
      verifiedHumanReceiptCount: 0,
    });
  });
});
