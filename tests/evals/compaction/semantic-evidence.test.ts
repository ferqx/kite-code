import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256DomainSeparated } from '../../../scripts/release/canonical-json';
import {
  PINNED_SEMANTIC_OIDC_ISSUER,
  PINNED_SEMANTIC_REPOSITORY,
  PINNED_SEMANTIC_WORKFLOW_PATH,
  type SemanticEvaluationEvidenceV1,
  type SemanticEvaluationRequestV1,
  semanticCandidateSetDigest,
  semanticEvaluationRequestV1Schema,
  semanticItemDigest,
  semanticPayloadDigest,
  semanticReceiptDigest,
  verifySemanticEvaluationEvidenceV1,
} from './semantic-evidence';

const D = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const HEAD = '1'.repeat(40);
const WORKFLOW_SHA = '2'.repeat(40);
const REF = 'refs/heads/main';

function artifactIdentity() {
  return {
    canonicalRepository: PINNED_SEMANTIC_REPOSITORY,
    repositoryId: 'R_kgDOSKbi8g',
    commit: HEAD,
    payloadSha256: D('e'),
    canonicalManifestDigest: D('1'),
    behaviorDigest: D('2'),
    profileDigest: D('3'),
    gatePolicyDigest: D('4'),
  } as const;
}

function fixture(
  overrides: {
    deterministicOutcome?: 'passed' | 'failed';
    scores?: number[];
    uncertainties?: number[];
  } = {},
): {
  evidence: SemanticEvaluationEvidenceV1;
  expected: Parameters<typeof verifySemanticEvaluationEvidenceV1>[0]['expected'];
} {
  const requestWithoutItems = {
    version: 1 as const,
    kind: 'compaction_semantic_evaluation_request' as const,
    rubricVersion: 'compaction-semantic-rubric-v1' as const,
    evaluatorRouteDigest: D('a'),
    evaluatorConfigDigest: D('b'),
    suiteDigest: D('c'),
    scorerDigest: D('d'),
    artifactIdentity: artifactIdentity(),
    fixtureDigest: D('f'),
    minimumScoreBasisPoints: 8_000,
    maximumUncertaintyBasisPoints: 1_000,
  };
  const items = ['a'.repeat(32), 'b'.repeat(32)].map((opaqueId, index) => {
    const item = {
      version: 1 as const,
      blindId: `blind_${opaqueId}`,
      caseCommitmentDigest: D(String(index + 5)),
      referenceContentDigest: D(String(index + 7)),
      candidateContentDigest: D(index === 0 ? '9' : '0'),
    };
    return { ...item, itemDigest: semanticItemDigest(item) };
  });
  const request: SemanticEvaluationRequestV1 = {
    ...requestWithoutItems,
    candidateSetDigest: semanticCandidateSetDigest(items),
    items,
  };
  let previousReceiptDigest: string | null = null;
  const receipts = items.map((item, index) => {
    const withoutDigest = {
      version: 1 as const,
      sequence: index + 1,
      blindId: item.blindId,
      itemDigest: item.itemDigest,
      scoreBasisPoints: overrides.scores?.[index] ?? 9_000,
      uncertaintyBasisPoints: overrides.uncertainties?.[index] ?? 500,
      evaluatorResponseDigest: D(String(index + 7)),
      previousReceiptDigest,
    };
    const receipt = { ...withoutDigest, receiptDigest: semanticReceiptDigest(withoutDigest) };
    previousReceiptDigest = receipt.receiptDigest;
    return receipt;
  });
  const receiptLedgerDigest = sha256DomainSeparated(
    'kite.compaction.semantic-receipt-ledger.v1',
    canonicalJson(receipts),
  );
  const maximumUncertaintyBasisPoints = Math.max(
    ...receipts.map((receipt) => receipt.uncertaintyBasisPoints),
  );
  const semanticOutcome =
    maximumUncertaintyBasisPoints > request.maximumUncertaintyBasisPoints
      ? ('inconclusive' as const)
      : receipts.every((receipt) => receipt.scoreBasisPoints >= request.minimumScoreBasisPoints)
        ? ('passed' as const)
        : ('failed' as const);
  const partial = {
    version: 1 as const,
    kind: 'compaction_semantic_evaluation_evidence' as const,
    request,
    receipts,
    summary: {
      itemCount: receipts.length,
      meanScoreBasisPoints: Math.floor(
        receipts.reduce((sum, receipt) => sum + receipt.scoreBasisPoints, 0) / receipts.length,
      ),
      maximumUncertaintyBasisPoints,
      semanticOutcome,
      receiptLedgerDigest,
    },
    deterministicSafety: {
      outcome: overrides.deterministicOutcome ?? ('passed' as const),
      reportDigest: D('9'),
    },
  };
  const payloadDigest = semanticPayloadDigest(partial);
  const evidence: SemanticEvaluationEvidenceV1 = {
    ...partial,
    source: {
      version: 1,
      source: 'github_actions_oidc',
      canonicalRepository: PINNED_SEMANTIC_REPOSITORY,
      repositoryId: 'R_kgDOSKbi8g',
      workflowPath: PINNED_SEMANTIC_WORKFLOW_PATH,
      workflowRef: `${PINNED_SEMANTIC_REPOSITORY}/${PINNED_SEMANTIC_WORKFLOW_PATH}@${REF}`,
      workflowSha: WORKFLOW_SHA,
      ref: REF,
      headSha: HEAD,
      runId: '1234',
      runAttempt: 1,
      jobName: 'semantic-evaluation',
      artifactId: '5678',
      artifactName: 'compaction-semantic-evaluation-1234-1',
      oidcIssuer: PINNED_SEMANTIC_OIDC_ISSUER,
      startedAt: '2026-08-02T00:00:00.000Z',
      endedAt: '2026-08-02T01:00:00.000Z',
      attestedPayloadDigest: payloadDigest,
      attestationBundleDigest: D('8'),
    },
    payloadDigest,
  };
  return {
    evidence,
    expected: {
      headSha: HEAD,
      ref: REF,
      workflowSha: WORKFLOW_SHA,
      runId: '1234',
      runAttempt: 1,
      jobName: 'semantic-evaluation',
      artifactId: '5678',
      artifactName: 'compaction-semantic-evaluation-1234-1',
      artifactIdentity: request.artifactIdentity,
      evaluatorRouteDigest: request.evaluatorRouteDigest,
      evaluatorConfigDigest: request.evaluatorConfigDigest,
      suiteDigest: request.suiteDigest,
      scorerDigest: request.scorerDigest,
      fixtureDigest: request.fixtureDigest,
      candidateSetDigest: request.candidateSetDigest,
      deterministicReportDigest: partial.deterministicSafety.reportDigest,
      deterministicOutcome: partial.deterministicSafety.outcome,
    },
  };
}

describe('authenticated compaction semantic evidence contract', () => {
  test('rebuilds a complete blind ledger but cannot authenticate it locally', () => {
    const input = fixture();
    const result = verifySemanticEvaluationEvidenceV1(input);
    expect(result.status).toBe('blocked');
    expect(result.semanticOutcome).toBe('passed');
    expect(result.evidenceEligible).toBeFalse();
    expect(result.milestone).toBeNull();
    expect(result.reasonCodes).toEqual(['authenticated_semantic_evaluator_not_configured']);
    expect(JSON.stringify(input.evidence.request.items)).not.toContain('control');
    expect(JSON.stringify(input.evidence.request.items)).not.toContain('treatment');
  });

  test('rejects source, route, config, artifact and deterministic identity substitution', () => {
    const fields = [
      'headSha',
      'workflowSha',
      'artifactId',
      'evaluatorRouteDigest',
      'evaluatorConfigDigest',
      'deterministicReportDigest',
      'candidateSetDigest',
    ] as const;
    for (const field of fields) {
      const input = fixture();
      expect(() =>
        verifySemanticEvaluationEvidenceV1({
          ...input,
          expected: { ...input.expected, [field]: field.endsWith('Sha') ? '3'.repeat(40) : D('6') },
        }),
      ).toThrow('identity_mismatch');
    }
    const artifact = fixture();
    expect(() =>
      verifySemanticEvaluationEvidenceV1({
        ...artifact,
        expected: {
          ...artifact.expected,
          artifactIdentity: {
            ...artifact.expected.artifactIdentity,
            behaviorDigest: D('6'),
          },
        },
      }),
    ).toThrow('identity_mismatch');
  });

  test('rejects a jointly spliced artifact repository that conflicts with the pinned source', () => {
    const input = fixture();
    const artifactIdentity = {
      ...input.evidence.request.artifactIdentity,
      canonicalRepository: 'attacker/repository',
      repositoryId: 'R_attacker',
    };
    const evidence = {
      ...input.evidence,
      request: { ...input.evidence.request, artifactIdentity },
    };
    const payloadDigest = semanticPayloadDigest(evidence);
    evidence.payloadDigest = payloadDigest;
    evidence.source = { ...evidence.source, attestedPayloadDigest: payloadDigest };
    expect(() =>
      verifySemanticEvaluationEvidenceV1({
        evidence,
        expected: { ...input.expected, artifactIdentity },
      }),
    ).toThrow('identity_mismatch');
  });

  test('rejects semantic experiment labels instead of trusting fixture naming', () => {
    const input = fixture();
    for (const blindId of ['control', 'treatment', 'baseline', 'candidate']) {
      expect(
        semanticEvaluationRequestV1Schema.safeParse({
          ...input.evidence.request,
          items: [{ ...input.evidence.request.items[0], blindId }],
        }).success,
      ).toBeFalse();
    }
  });

  test('rejects missing, duplicate, reordered and mutated receipts', () => {
    for (const mutate of [
      (value: SemanticEvaluationEvidenceV1) => ({ ...value, receipts: value.receipts.slice(1) }),
      (value: SemanticEvaluationEvidenceV1) => ({
        ...value,
        receipts: [value.receipts[0]!, value.receipts[0]!],
      }),
      (value: SemanticEvaluationEvidenceV1) => ({
        ...value,
        receipts: [value.receipts[1]!, value.receipts[0]!],
      }),
      (value: SemanticEvaluationEvidenceV1) => ({
        ...value,
        receipts: [{ ...value.receipts[0]!, scoreBasisPoints: 10_000 }, value.receipts[1]!],
      }),
    ]) {
      const input = fixture();
      expect(() =>
        verifySemanticEvaluationEvidenceV1({ ...input, evidence: mutate(input.evidence) }),
      ).toThrow('ledger_mismatch');
    }
  });

  test('rejects self-reported aggregate or attested payload tampering', () => {
    const summary = fixture();
    expect(() =>
      verifySemanticEvaluationEvidenceV1({
        ...summary,
        evidence: {
          ...summary.evidence,
          summary: { ...summary.evidence.summary, meanScoreBasisPoints: 10_000 },
        },
      }),
    ).toThrow('ledger_mismatch');

    const payload = fixture();
    expect(() =>
      verifySemanticEvaluationEvidenceV1({
        ...payload,
        evidence: {
          ...payload.evidence,
          source: { ...payload.evidence.source, attestedPayloadDigest: D('5') },
        },
      }),
    ).toThrow('identity_mismatch');
  });

  test('semantic scoring cannot override a critical deterministic failure', () => {
    const result = verifySemanticEvaluationEvidenceV1(fixture({ deterministicOutcome: 'failed' }));
    expect(result.semanticOutcome).toBe('passed');
    expect(result.deterministicOutcome).toBe('failed');
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toContain('deterministic_safety_failed');
    expect(result.evidenceEligible).toBeFalse();
  });

  test('rejects a self-reported deterministic pass against a trusted failed outcome', () => {
    const input = fixture();
    expect(() =>
      verifySemanticEvaluationEvidenceV1({
        ...input,
        expected: { ...input.expected, deterministicOutcome: 'failed' },
      }),
    ).toThrow('identity_mismatch');
  });

  test('fails below threshold and blocks excessive evaluator uncertainty', () => {
    const failed = verifySemanticEvaluationEvidenceV1(fixture({ scores: [7_999, 9_000] }));
    expect(failed.status).toBe('failed');
    expect(failed.reasonCodes).toContain('semantic_threshold_failed');

    const uncertain = verifySemanticEvaluationEvidenceV1(fixture({ uncertainties: [1_001, 500] }));
    expect(uncertain.status).toBe('blocked');
    expect(uncertain.semanticOutcome).toBe('inconclusive');
    expect(uncertain.reasonCodes).toContain('semantic_uncertainty_exceeded');
  });
});
