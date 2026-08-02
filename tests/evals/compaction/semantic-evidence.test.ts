import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256DomainSeparated } from '../../../scripts/release/canonical-json';
import {
  PINNED_SEMANTIC_REPOSITORY,
  PINNED_SEMANTIC_WORKFLOW_PATH,
  produceSemanticEvaluationEvidenceV1,
  type SemanticEvaluationEvidenceV1,
  type SemanticEvaluationProducerInputV1,
  type SemanticEvaluationRequestV1,
  semanticCandidateSetDigest,
  semanticEvaluationRequestV1Schema,
  semanticExpectedIdentityV1,
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
      source: 'github_actions_unsigned_contract',
      canonicalRepository: PINNED_SEMANTIC_REPOSITORY,
      repositoryId: 'R_kgDOSKbi8g',
      repositoryNumericId: '1218896626',
      workflowPath: PINNED_SEMANTIC_WORKFLOW_PATH,
      workflowRef: `${PINNED_SEMANTIC_REPOSITORY}/${PINNED_SEMANTIC_WORKFLOW_PATH}@${REF}`,
      workflowSha: WORKFLOW_SHA,
      ref: REF,
      headSha: HEAD,
      runId: '1234',
      runAttempt: 1,
      jobName: 'semantic-evaluation',
      retainedArtifactId: '5678',
      retainedArtifactName: 'compaction-semantic-contract-input-1234-1',
      trackedInputPath: 'tests/fixtures/evals/compaction/producer-input.json',
      trackedInputGitBlobId: '3'.repeat(40),
      trackedInputSha256: D('7'),
      startedAt: '2026-08-02T00:00:00.000Z',
      endedAt: '2026-08-02T01:00:00.000Z',
      boundPayloadDigest: payloadDigest,
      signature: {
        kind: 'unconfigured',
        algorithm: 'none',
        reason: 'production_sigstore_unconfigured',
      },
    },
    payloadDigest,
  };
  return {
    evidence,
    expected: {
      canonicalRepository: PINNED_SEMANTIC_REPOSITORY,
      repositoryId: 'R_kgDOSKbi8g',
      repositoryNumericId: '1218896626',
      workflowPath: PINNED_SEMANTIC_WORKFLOW_PATH,
      workflowRef: `${PINNED_SEMANTIC_REPOSITORY}/${PINNED_SEMANTIC_WORKFLOW_PATH}@${REF}`,
      headSha: HEAD,
      ref: REF,
      workflowSha: WORKFLOW_SHA,
      runId: '1234',
      runAttempt: 1,
      jobName: 'semantic-evaluation',
      retainedArtifactId: '5678',
      retainedArtifactName: 'compaction-semantic-contract-input-1234-1',
      trackedInputPath: 'tests/fixtures/evals/compaction/producer-input.json',
      trackedInputGitBlobId: '3'.repeat(40),
      trackedInputSha256: D('7'),
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
    expect(result.reasonCodes).toEqual([
      'authenticated_semantic_evaluator_not_configured',
      'sigstore_attestation_trust_not_configured',
    ]);
    expect(JSON.stringify(input.evidence.request.items)).not.toContain('control');
    expect(JSON.stringify(input.evidence.request.items)).not.toContain('treatment');
  });

  test('producer creates a canonical ledger while the independent verifier remains blocked', () => {
    const input = fixture();
    const producerInput = producerInputFrom(input.evidence);
    const sourceIdentity = sourceIdentityFrom(input.evidence);
    const evidence = produceSemanticEvaluationEvidenceV1({ producerInput, sourceIdentity });
    const expected = semanticExpectedIdentityV1({ producerInput, sourceIdentity });
    const verification = verifySemanticEvaluationEvidenceV1({ evidence, expected });

    expect(evidence.receipts).toEqual(input.evidence.receipts);
    expect(evidence.payloadDigest).toBe(input.evidence.payloadDigest);
    expect(verification.status).toBe('blocked');
    expect(verification.evidenceEligible).toBeFalse();
    expect(verification.authenticatedEvaluatorRoute).toBeFalse();
    expect(verification.sigstoreTrustConfigured).toBeFalse();
  });

  test('CLI verifier takes source expectations from its environment, not from evidence', () => {
    const input = fixture();
    const producerInput = producerInputFrom(input.evidence);
    const directory = mkdtempSync(join(tmpdir(), 'kite-semantic-evidence-'));
    const producerInputPath = join(directory, 'producer-input.json');
    const evidencePath = join(directory, 'evidence.json');
    const verificationPath = join(directory, 'verification.json');
    const mismatchPath = join(directory, 'mismatch.json');
    const producerInputBytes = JSON.stringify(producerInput);
    writeFileSync(producerInputPath, producerInputBytes);
    const environment = semanticCliEnvironment(input.evidence);
    environment.SEMANTIC_TRACKED_INPUT_SHA256 = `sha256:${createHash('sha256').update(producerInputBytes).digest('hex')}`;
    const repositoryRoot = resolve(import.meta.dir, '../../..');

    try {
      const produced = Bun.spawnSync({
        cmd: [
          process.execPath,
          'run',
          'scripts/evals/produce-compaction-semantic-evidence.ts',
          '--input',
          producerInputPath,
          '--output',
          evidencePath,
        ],
        cwd: repositoryRoot,
        env: { ...process.env, ...environment },
      });
      expect(produced.exitCode).toBe(0);

      const verified = Bun.spawnSync({
        cmd: [
          process.execPath,
          'run',
          'scripts/evals/verify-compaction-semantic-evidence.ts',
          '--evidence',
          evidencePath,
          '--expectation-input',
          producerInputPath,
          '--output',
          verificationPath,
        ],
        cwd: repositoryRoot,
        env: { ...process.env, ...environment },
      });
      expect(verified.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(verificationPath, 'utf8'))).toMatchObject({
        status: 'blocked',
        evidenceEligible: false,
      });

      const mismatch = Bun.spawnSync({
        cmd: [
          process.execPath,
          'run',
          'scripts/evals/verify-compaction-semantic-evidence.ts',
          '--evidence',
          evidencePath,
          '--expectation-input',
          producerInputPath,
          '--output',
          mismatchPath,
        ],
        cwd: repositoryRoot,
        env: { ...process.env, ...environment, GITHUB_RUN_ID: '9999' },
      });
      expect(mismatch.exitCode).not.toBe(0);
      expect(mismatch.stderr.toString()).toContain('identity_mismatch');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps the semantic workflow manual, unsigned, and bound to the upload artifact ID', () => {
    const workflow = readFileSync('.github/workflows/compaction-semantic-evaluation.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+(push|pull_request|schedule):/);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('attestations: write');
    expect(workflow).not.toContain('attestation_bundle_digest');
    expect(workflow).toContain('steps.retained-input.outputs.artifact-id');
    expect(workflow).toContain('github_actions_unsigned_contract');
    expect(workflow).toContain('snapshot-tracked-semantic-input.ts');
    expect(workflow).toContain('--commit "$GITHUB_SHA"');
    expect(workflow).toContain('--input "$SEMANTIC_PRODUCER_INPUT_PATH"');
    expect(workflow).toContain('--input "$SEMANTIC_SNAPSHOT_PATH"');
    expect(workflow).toContain('--expectation-input "$SEMANTIC_SNAPSHOT_PATH"');
    expect(workflow).not.toContain('path: ${{ env.SEMANTIC_PRODUCER_INPUT_PATH }}');
  });

  test('rejects source, route, config, artifact and deterministic identity substitution', () => {
    const fields = [
      'headSha',
      'workflowSha',
      'retainedArtifactId',
      'trackedInputGitBlobId',
      'trackedInputSha256',
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
    evidence.source = { ...evidence.source, boundPayloadDigest: payloadDigest };
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

  test('rejects self-reported aggregate or bound payload tampering', () => {
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
          source: { ...payload.evidence.source, boundPayloadDigest: D('5') },
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

function producerInputFrom(
  evidence: SemanticEvaluationEvidenceV1,
): SemanticEvaluationProducerInputV1 {
  return {
    version: 1,
    kind: 'compaction_semantic_evaluation_producer_input',
    request: evidence.request,
    evaluations: evidence.receipts.map((receipt) => ({
      version: 1,
      blindId: receipt.blindId,
      itemDigest: receipt.itemDigest,
      scoreBasisPoints: receipt.scoreBasisPoints,
      uncertaintyBasisPoints: receipt.uncertaintyBasisPoints,
      evaluatorResponseDigest: receipt.evaluatorResponseDigest,
    })),
    deterministicSafety: evidence.deterministicSafety,
  };
}

function sourceIdentityFrom(evidence: SemanticEvaluationEvidenceV1) {
  const {
    version: _version,
    source: _source,
    boundPayloadDigest: _boundPayload,
    signature: _signature,
    ...identity
  } = evidence.source;
  return identity;
}

function semanticCliEnvironment(evidence: SemanticEvaluationEvidenceV1): Record<string, string> {
  return {
    GITHUB_REPOSITORY: evidence.source.canonicalRepository,
    GITHUB_REPOSITORY_ID: evidence.source.repositoryNumericId,
    SEMANTIC_REPOSITORY_NODE_ID: evidence.source.repositoryId,
    GITHUB_WORKFLOW_REF: evidence.source.workflowRef,
    GITHUB_WORKFLOW_SHA: evidence.source.workflowSha,
    GITHUB_REF: evidence.source.ref,
    GITHUB_SHA: evidence.source.headSha,
    GITHUB_RUN_ID: evidence.source.runId,
    GITHUB_RUN_ATTEMPT: String(evidence.source.runAttempt),
    SEMANTIC_WORKFLOW_PATH: evidence.source.workflowPath,
    SEMANTIC_JOB_NAME: evidence.source.jobName,
    SEMANTIC_RETAINED_ARTIFACT_ID: evidence.source.retainedArtifactId,
    SEMANTIC_RETAINED_ARTIFACT_NAME: evidence.source.retainedArtifactName,
    SEMANTIC_TRACKED_INPUT_PATH: evidence.source.trackedInputPath,
    SEMANTIC_TRACKED_INPUT_GIT_BLOB_ID: evidence.source.trackedInputGitBlobId,
    SEMANTIC_TRACKED_INPUT_SHA256: evidence.source.trackedInputSha256,
    SEMANTIC_STARTED_AT: evidence.source.startedAt,
  };
}
