import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../../release/canonical-json';
import {
  type ReleaseArtifactIdentityV1,
  releaseArtifactIdentityV1Schema,
} from '../../release/evidence-schema';

export const SEMANTIC_RUBRIC_VERSION = 'compaction-semantic-rubric-v1' as const;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const blindIdSchema = z.string().regex(/^blind_[0-9a-f]{32}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const trackedInputPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'tracked input path must be normalized and repository-relative',
  );

export const PINNED_SEMANTIC_REPOSITORY = 'ferqx/kite-code' as const;
export const PINNED_SEMANTIC_REPOSITORY_ID = 'R_kgDOSKbi8g' as const;
export const PINNED_SEMANTIC_REPOSITORY_NUMERIC_ID = '1218896626' as const;
export const PINNED_SEMANTIC_WORKFLOW_PATH =
  '.github/workflows/compaction-semantic-evaluation.yml' as const;

const semanticItemSchema = z
  .object({
    version: z.literal(1),
    blindId: blindIdSchema,
    caseCommitmentDigest: digestSchema,
    referenceContentDigest: digestSchema,
    candidateContentDigest: digestSchema,
    itemDigest: digestSchema,
  })
  .strict();

export const semanticEvaluationRequestV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('compaction_semantic_evaluation_request'),
    rubricVersion: z.literal(SEMANTIC_RUBRIC_VERSION),
    evaluatorRouteDigest: digestSchema,
    evaluatorConfigDigest: digestSchema,
    suiteDigest: digestSchema,
    scorerDigest: digestSchema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    fixtureDigest: digestSchema,
    candidateSetDigest: digestSchema,
    minimumScoreBasisPoints: z.number().int().min(0).max(10_000),
    maximumUncertaintyBasisPoints: z.number().int().min(0).max(10_000),
    items: z.array(semanticItemSchema).min(1).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const blindIds = value.items.map((item) => item.blindId);
    if (new Set(blindIds).size !== blindIds.length) {
      context.addIssue({ code: 'custom', message: 'blindId must be unique.' });
    }
    for (const [index, item] of value.items.entries()) {
      const expected = semanticItemDigest(item);
      if (item.itemDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'itemDigest'],
          message: 'itemDigest does not match the blinded item.',
        });
      }
    }
    const expectedCandidateSetDigest = semanticCandidateSetDigest(value.items);
    if (value.candidateSetDigest !== expectedCandidateSetDigest) {
      context.addIssue({
        code: 'custom',
        path: ['candidateSetDigest'],
        message: 'candidateSetDigest does not bind every blinded case and candidate content.',
      });
    }
  });

export type SemanticEvaluationRequestV1 = z.infer<typeof semanticEvaluationRequestV1Schema>;

const semanticReceiptSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    blindId: blindIdSchema,
    itemDigest: digestSchema,
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    uncertaintyBasisPoints: z.number().int().min(0).max(10_000),
    evaluatorResponseDigest: digestSchema,
    previousReceiptDigest: digestSchema.nullable(),
    receiptDigest: digestSchema,
  })
  .strict();

const semanticEvaluatorResultSchema = z
  .object({
    version: z.literal(1),
    blindId: blindIdSchema,
    itemDigest: digestSchema,
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    uncertaintyBasisPoints: z.number().int().min(0).max(10_000),
    evaluatorResponseDigest: digestSchema,
  })
  .strict();

const deterministicSafetySchema = z
  .object({
    outcome: z.enum(['passed', 'failed']),
    reportDigest: digestSchema,
  })
  .strict();

export const semanticEvaluationProducerInputV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('compaction_semantic_evaluation_producer_input'),
    request: semanticEvaluationRequestV1Schema,
    evaluations: z.array(semanticEvaluatorResultSchema).min(1).max(128),
    deterministicSafety: deterministicSafetySchema,
  })
  .strict();

export type SemanticEvaluationProducerInputV1 = z.infer<
  typeof semanticEvaluationProducerInputV1Schema
>;

export const semanticEvaluationSourceIdentityV1Schema = z
  .object({
    canonicalRepository: z.literal(PINNED_SEMANTIC_REPOSITORY),
    repositoryId: z.literal(PINNED_SEMANTIC_REPOSITORY_ID),
    repositoryNumericId: z.literal(PINNED_SEMANTIC_REPOSITORY_NUMERIC_ID),
    workflowPath: z.literal(PINNED_SEMANTIC_WORKFLOW_PATH),
    workflowRef: z.string().min(1),
    workflowSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    headSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1).max(256),
    retainedArtifactId: z.string().regex(/^[1-9][0-9]*$/),
    retainedArtifactName: z.string().min(1).max(256),
    trackedInputPath: trackedInputPathSchema,
    trackedInputGitBlobId: z.string().regex(/^[a-f0-9]{40,64}$/),
    trackedInputSha256: digestSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .strict()
  .superRefine((source, context) => {
    const expectedWorkflowRef = `${PINNED_SEMANTIC_REPOSITORY}/${PINNED_SEMANTIC_WORKFLOW_PATH}@${source.ref}`;
    if (source.workflowRef !== expectedWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'workflowRef must bind the pinned workflow path to the exact ref.',
      });
    }
    if (Date.parse(source.endedAt) < Date.parse(source.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt must not precede startedAt.',
      });
    }
  });

export type SemanticEvaluationSourceIdentityV1 = z.infer<
  typeof semanticEvaluationSourceIdentityV1Schema
>;

const semanticSourceSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('github_actions_unsigned_contract'),
    canonicalRepository: z.literal(PINNED_SEMANTIC_REPOSITORY),
    repositoryId: z.literal(PINNED_SEMANTIC_REPOSITORY_ID),
    repositoryNumericId: z.literal(PINNED_SEMANTIC_REPOSITORY_NUMERIC_ID),
    workflowPath: z.literal(PINNED_SEMANTIC_WORKFLOW_PATH),
    workflowRef: z.string().min(1),
    workflowSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    headSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1).max(256),
    retainedArtifactId: z.string().regex(/^[1-9][0-9]*$/),
    retainedArtifactName: z.string().min(1).max(256),
    trackedInputPath: trackedInputPathSchema,
    trackedInputGitBlobId: z.string().regex(/^[a-f0-9]{40,64}$/),
    trackedInputSha256: digestSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    boundPayloadDigest: digestSchema,
    signature: z
      .object({
        kind: z.literal('unconfigured'),
        algorithm: z.literal('none'),
        reason: z.literal('production_sigstore_unconfigured'),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    const expectedWorkflowRef = `${PINNED_SEMANTIC_REPOSITORY}/${PINNED_SEMANTIC_WORKFLOW_PATH}@${source.ref}`;
    if (source.workflowRef !== expectedWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'workflowRef must bind the pinned workflow path to the exact ref.',
      });
    }
  });

export const semanticEvaluationEvidenceV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('compaction_semantic_evaluation_evidence'),
    request: semanticEvaluationRequestV1Schema,
    receipts: z.array(semanticReceiptSchema).min(1).max(128),
    summary: z
      .object({
        itemCount: z.number().int().positive(),
        meanScoreBasisPoints: z.number().int().min(0).max(10_000),
        maximumUncertaintyBasisPoints: z.number().int().min(0).max(10_000),
        semanticOutcome: z.enum(['passed', 'failed', 'inconclusive']),
        receiptLedgerDigest: digestSchema,
      })
      .strict(),
    deterministicSafety: deterministicSafetySchema,
    source: semanticSourceSchema,
    payloadDigest: digestSchema,
  })
  .strict();

export type SemanticEvaluationEvidenceV1 = z.infer<typeof semanticEvaluationEvidenceV1Schema>;

export interface SemanticEvidenceExpectedIdentityV1 {
  canonicalRepository: typeof PINNED_SEMANTIC_REPOSITORY;
  repositoryId: typeof PINNED_SEMANTIC_REPOSITORY_ID;
  repositoryNumericId: typeof PINNED_SEMANTIC_REPOSITORY_NUMERIC_ID;
  workflowPath: typeof PINNED_SEMANTIC_WORKFLOW_PATH;
  workflowRef: string;
  headSha: string;
  ref: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
  jobName: string;
  retainedArtifactId: string;
  retainedArtifactName: string;
  trackedInputPath: string;
  trackedInputGitBlobId: string;
  trackedInputSha256: string;
  artifactIdentity: ReleaseArtifactIdentityV1;
  evaluatorRouteDigest: string;
  evaluatorConfigDigest: string;
  suiteDigest: string;
  scorerDigest: string;
  fixtureDigest: string;
  candidateSetDigest: string;
  deterministicReportDigest: string;
  deterministicOutcome: 'passed' | 'failed';
}

export interface SemanticEvidenceVerificationV1 {
  version: 1;
  kind: 'compaction_semantic_evidence_verification';
  status: 'blocked' | 'failed';
  semanticOutcome: 'passed' | 'failed' | 'inconclusive';
  deterministicOutcome: 'passed' | 'failed';
  evidenceEligible: false;
  authenticatedEvaluatorRoute: false;
  sigstoreTrustConfigured: false;
  milestone: null;
  rebuiltPayloadDigest: `sha256:${string}`;
  rebuiltReceiptLedgerDigest: `sha256:${string}`;
  reasonCodes: string[];
  verificationDigest: `sha256:${string}`;
}

export class SemanticEvidenceVerificationError extends Error {
  readonly code: 'evidence_invalid' | 'identity_mismatch' | 'ledger_mismatch';

  constructor(code: 'evidence_invalid' | 'identity_mismatch' | 'ledger_mismatch') {
    super(`Semantic evidence verification failed: ${code}`);
    this.name = 'SemanticEvidenceVerificationError';
    this.code = code;
  }
}

export function semanticItemDigest(item: {
  version: 1;
  blindId: string;
  caseCommitmentDigest: string;
  referenceContentDigest: string;
  candidateContentDigest: string;
}): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.compaction.semantic-item.v1',
    canonicalJson({
      version: item.version,
      blindId: item.blindId,
      caseCommitmentDigest: item.caseCommitmentDigest,
      referenceContentDigest: item.referenceContentDigest,
      candidateContentDigest: item.candidateContentDigest,
    }),
  );
}

export function semanticReceiptDigest(
  receipt: Omit<z.infer<typeof semanticReceiptSchema>, 'receiptDigest'>,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.compaction.semantic-receipt.v1', canonicalJson(receipt));
}

export function semanticCandidateSetDigest(
  items: Array<{
    blindId: string;
    caseCommitmentDigest: string;
    candidateContentDigest: string;
  }>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.compaction.semantic-candidate-set.v1',
    canonicalJson(
      items.map((item) => ({
        blindId: item.blindId,
        caseCommitmentDigest: item.caseCommitmentDigest,
        candidateContentDigest: item.candidateContentDigest,
      })),
    ),
  );
}

/**
 * Builds a canonical, blinded receipt ledger from retained evaluator results.
 * This producer does not authenticate the evaluator or its attestation. That
 * trust decision is intentionally reserved for the independent verifier.
 */
export function produceSemanticEvaluationEvidenceV1(input: {
  producerInput: unknown;
  sourceIdentity: unknown;
}): SemanticEvaluationEvidenceV1 {
  const producerInput = semanticEvaluationProducerInputV1Schema.parse(input.producerInput);
  const sourceIdentity = semanticEvaluationSourceIdentityV1Schema.parse(input.sourceIdentity);
  if (
    sourceIdentity.headSha !== producerInput.request.artifactIdentity.commit ||
    sourceIdentity.canonicalRepository !==
      producerInput.request.artifactIdentity.canonicalRepository ||
    sourceIdentity.repositoryId !== producerInput.request.artifactIdentity.repositoryId
  ) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }
  if (producerInput.evaluations.length !== producerInput.request.items.length) {
    throw new SemanticEvidenceVerificationError('ledger_mismatch');
  }

  let previousReceiptDigest: string | null = null;
  const receipts = producerInput.request.items.map((item, index) => {
    const evaluation = producerInput.evaluations[index];
    if (
      !evaluation ||
      evaluation.blindId !== item.blindId ||
      evaluation.itemDigest !== item.itemDigest
    ) {
      throw new SemanticEvidenceVerificationError('ledger_mismatch');
    }
    const withoutDigest = {
      version: 1 as const,
      sequence: index + 1,
      blindId: evaluation.blindId,
      itemDigest: evaluation.itemDigest,
      scoreBasisPoints: evaluation.scoreBasisPoints,
      uncertaintyBasisPoints: evaluation.uncertaintyBasisPoints,
      evaluatorResponseDigest: evaluation.evaluatorResponseDigest,
      previousReceiptDigest,
    };
    const receipt = { ...withoutDigest, receiptDigest: semanticReceiptDigest(withoutDigest) };
    previousReceiptDigest = receipt.receiptDigest;
    return receipt;
  });
  const summary = semanticSummary(producerInput.request, receipts);
  const partial = {
    version: 1 as const,
    kind: 'compaction_semantic_evaluation_evidence' as const,
    request: producerInput.request,
    receipts,
    summary,
    deterministicSafety: producerInput.deterministicSafety,
  };
  const payloadDigest = semanticPayloadDigest(partial);
  return semanticEvaluationEvidenceV1Schema.parse({
    ...partial,
    source: {
      version: 1,
      source: 'github_actions_unsigned_contract',
      ...sourceIdentity,
      boundPayloadDigest: payloadDigest,
      signature: {
        kind: 'unconfigured',
        algorithm: 'none',
        reason: 'production_sigstore_unconfigured',
      },
    },
    payloadDigest,
  });
}

export function semanticExpectedIdentityV1(input: {
  producerInput: unknown;
  sourceIdentity: unknown;
}): SemanticEvidenceExpectedIdentityV1 {
  const producerInput = semanticEvaluationProducerInputV1Schema.parse(input.producerInput);
  const source = semanticEvaluationSourceIdentityV1Schema.parse(input.sourceIdentity);
  return {
    canonicalRepository: source.canonicalRepository,
    repositoryId: source.repositoryId,
    repositoryNumericId: source.repositoryNumericId,
    workflowPath: source.workflowPath,
    workflowRef: source.workflowRef,
    headSha: source.headSha,
    ref: source.ref,
    workflowSha: source.workflowSha,
    runId: source.runId,
    runAttempt: source.runAttempt,
    jobName: source.jobName,
    retainedArtifactId: source.retainedArtifactId,
    retainedArtifactName: source.retainedArtifactName,
    trackedInputPath: source.trackedInputPath,
    trackedInputGitBlobId: source.trackedInputGitBlobId,
    trackedInputSha256: source.trackedInputSha256,
    artifactIdentity: producerInput.request.artifactIdentity,
    evaluatorRouteDigest: producerInput.request.evaluatorRouteDigest,
    evaluatorConfigDigest: producerInput.request.evaluatorConfigDigest,
    suiteDigest: producerInput.request.suiteDigest,
    scorerDigest: producerInput.request.scorerDigest,
    fixtureDigest: producerInput.request.fixtureDigest,
    candidateSetDigest: producerInput.request.candidateSetDigest,
    deterministicReportDigest: producerInput.deterministicSafety.reportDigest,
    deterministicOutcome: producerInput.deterministicSafety.outcome,
  };
}

export function semanticSourceIdentityFromEnvironmentV1(
  environment: Record<string, string | undefined>,
  endedAt = new Date().toISOString(),
): SemanticEvaluationSourceIdentityV1 {
  const required = (name: string): string => {
    const value = environment[name];
    if (!value) throw new Error(`Missing required semantic evidence environment value: ${name}`);
    return value;
  };
  return semanticEvaluationSourceIdentityV1Schema.parse({
    canonicalRepository: required('GITHUB_REPOSITORY'),
    repositoryId: required('SEMANTIC_REPOSITORY_NODE_ID'),
    repositoryNumericId: required('GITHUB_REPOSITORY_ID'),
    workflowPath: required('SEMANTIC_WORKFLOW_PATH'),
    workflowRef: required('GITHUB_WORKFLOW_REF'),
    workflowSha: required('GITHUB_WORKFLOW_SHA'),
    ref: required('GITHUB_REF'),
    headSha: required('GITHUB_SHA'),
    runId: required('GITHUB_RUN_ID'),
    runAttempt: Number(required('GITHUB_RUN_ATTEMPT')),
    jobName: required('SEMANTIC_JOB_NAME'),
    retainedArtifactId: required('SEMANTIC_RETAINED_ARTIFACT_ID'),
    retainedArtifactName: required('SEMANTIC_RETAINED_ARTIFACT_NAME'),
    trackedInputPath: required('SEMANTIC_TRACKED_INPUT_PATH'),
    trackedInputGitBlobId: required('SEMANTIC_TRACKED_INPUT_GIT_BLOB_ID'),
    trackedInputSha256: required('SEMANTIC_TRACKED_INPUT_SHA256'),
    startedAt: required('SEMANTIC_STARTED_AT'),
    endedAt,
  });
}

export function verifyTrackedSemanticInputSnapshotV1(
  path: string,
  sourceIdentity: SemanticEvaluationSourceIdentityV1,
): void {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== sourceIdentity.trackedInputSha256) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }
}

/**
 * Rebuilds every retained fact from the blinded ledger. It deliberately cannot
 * authenticate Sigstore/GitHub attestations yet, so a structurally valid pass
 * remains blocked and evidence-ineligible.
 */
export function verifySemanticEvaluationEvidenceV1(input: {
  evidence: unknown;
  expected: SemanticEvidenceExpectedIdentityV1;
}): SemanticEvidenceVerificationV1 {
  const parsed = semanticEvaluationEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) throw new SemanticEvidenceVerificationError('evidence_invalid');
  const evidence = parsed.data;
  assertExpectedIdentity(evidence, input.expected);
  if (
    evidence.source.canonicalRepository !== evidence.request.artifactIdentity.canonicalRepository ||
    evidence.source.repositoryId !== evidence.request.artifactIdentity.repositoryId ||
    evidence.source.headSha !== evidence.request.artifactIdentity.commit ||
    Date.parse(evidence.source.endedAt) < Date.parse(evidence.source.startedAt)
  ) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }

  const expectedItems = new Map(evidence.request.items.map((item) => [item.blindId, item]));
  if (evidence.receipts.length !== expectedItems.size) {
    throw new SemanticEvidenceVerificationError('ledger_mismatch');
  }
  let previousReceiptDigest: string | null = null;
  const seen = new Set<string>();
  for (const [index, receipt] of evidence.receipts.entries()) {
    const item = expectedItems.get(receipt.blindId);
    if (
      !item ||
      seen.has(receipt.blindId) ||
      receipt.sequence !== index + 1 ||
      receipt.itemDigest !== item.itemDigest ||
      receipt.previousReceiptDigest !== previousReceiptDigest
    ) {
      throw new SemanticEvidenceVerificationError('ledger_mismatch');
    }
    const { receiptDigest, ...withoutDigest } = receipt;
    if (receiptDigest !== semanticReceiptDigest(withoutDigest)) {
      throw new SemanticEvidenceVerificationError('ledger_mismatch');
    }
    seen.add(receipt.blindId);
    previousReceiptDigest = receiptDigest;
  }

  const rebuiltReceiptLedgerDigest = sha256DomainSeparated(
    'kite.compaction.semantic-receipt-ledger.v1',
    canonicalJson(evidence.receipts),
  );
  const scoreTotal = evidence.receipts.reduce((sum, receipt) => sum + receipt.scoreBasisPoints, 0);
  const meanScoreBasisPoints = Math.floor(scoreTotal / evidence.receipts.length);
  const maximumUncertaintyBasisPoints = Math.max(
    ...evidence.receipts.map((receipt) => receipt.uncertaintyBasisPoints),
  );
  const semanticOutcome =
    maximumUncertaintyBasisPoints > evidence.request.maximumUncertaintyBasisPoints
      ? ('inconclusive' as const)
      : evidence.receipts.every(
            (receipt) => receipt.scoreBasisPoints >= evidence.request.minimumScoreBasisPoints,
          )
        ? ('passed' as const)
        : ('failed' as const);
  if (
    evidence.summary.itemCount !== evidence.receipts.length ||
    evidence.summary.meanScoreBasisPoints !== meanScoreBasisPoints ||
    evidence.summary.maximumUncertaintyBasisPoints !== maximumUncertaintyBasisPoints ||
    evidence.summary.semanticOutcome !== semanticOutcome ||
    evidence.summary.receiptLedgerDigest !== rebuiltReceiptLedgerDigest
  ) {
    throw new SemanticEvidenceVerificationError('ledger_mismatch');
  }

  const rebuiltPayloadDigest = semanticPayloadDigest(evidence);
  if (
    evidence.payloadDigest !== rebuiltPayloadDigest ||
    evidence.source.boundPayloadDigest !== rebuiltPayloadDigest
  ) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }

  const reasonCodes = [
    'authenticated_semantic_evaluator_not_configured',
    'sigstore_attestation_trust_not_configured',
  ];
  if (semanticOutcome === 'failed') reasonCodes.push('semantic_threshold_failed');
  if (semanticOutcome === 'inconclusive') reasonCodes.push('semantic_uncertainty_exceeded');
  if (evidence.deterministicSafety.outcome === 'failed') {
    reasonCodes.push('deterministic_safety_failed');
  }
  reasonCodes.sort();
  const status =
    semanticOutcome === 'failed' || evidence.deterministicSafety.outcome === 'failed'
      ? ('failed' as const)
      : ('blocked' as const);
  const withoutDigest = {
    version: 1 as const,
    kind: 'compaction_semantic_evidence_verification' as const,
    status,
    semanticOutcome,
    deterministicOutcome: evidence.deterministicSafety.outcome,
    evidenceEligible: false as const,
    authenticatedEvaluatorRoute: false as const,
    sigstoreTrustConfigured: false as const,
    milestone: null,
    rebuiltPayloadDigest,
    rebuiltReceiptLedgerDigest,
    reasonCodes,
  };
  return {
    ...withoutDigest,
    verificationDigest: sha256DomainSeparated(
      'kite.compaction.semantic-verification.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

export function semanticPayloadDigest(
  evidence: Pick<
    SemanticEvaluationEvidenceV1,
    'version' | 'kind' | 'request' | 'receipts' | 'summary' | 'deterministicSafety'
  >,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.compaction.semantic-evidence-payload.v1',
    canonicalJson({
      version: evidence.version,
      kind: evidence.kind,
      request: evidence.request,
      receipts: evidence.receipts,
      summary: evidence.summary,
      deterministicSafety: evidence.deterministicSafety,
    }),
  );
}

function assertExpectedIdentity(
  evidence: SemanticEvaluationEvidenceV1,
  expected: SemanticEvidenceExpectedIdentityV1,
): void {
  const source = evidence.source;
  const request = evidence.request;
  if (
    source.canonicalRepository !== expected.canonicalRepository ||
    source.repositoryId !== expected.repositoryId ||
    source.repositoryNumericId !== expected.repositoryNumericId ||
    source.workflowPath !== expected.workflowPath ||
    source.workflowRef !== expected.workflowRef ||
    source.headSha !== expected.headSha ||
    source.ref !== expected.ref ||
    source.workflowSha !== expected.workflowSha ||
    source.runId !== expected.runId ||
    source.runAttempt !== expected.runAttempt ||
    source.jobName !== expected.jobName ||
    source.retainedArtifactId !== expected.retainedArtifactId ||
    source.retainedArtifactName !== expected.retainedArtifactName ||
    source.trackedInputPath !== expected.trackedInputPath ||
    source.trackedInputGitBlobId !== expected.trackedInputGitBlobId ||
    source.trackedInputSha256 !== expected.trackedInputSha256 ||
    canonicalJson(request.artifactIdentity) !== canonicalJson(expected.artifactIdentity) ||
    request.evaluatorRouteDigest !== expected.evaluatorRouteDigest ||
    request.evaluatorConfigDigest !== expected.evaluatorConfigDigest ||
    request.suiteDigest !== expected.suiteDigest ||
    request.scorerDigest !== expected.scorerDigest ||
    request.fixtureDigest !== expected.fixtureDigest ||
    request.candidateSetDigest !== expected.candidateSetDigest ||
    evidence.deterministicSafety.reportDigest !== expected.deterministicReportDigest ||
    evidence.deterministicSafety.outcome !== expected.deterministicOutcome
  ) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }
}

function semanticSummary(
  request: SemanticEvaluationRequestV1,
  receipts: SemanticEvaluationEvidenceV1['receipts'],
): SemanticEvaluationEvidenceV1['summary'] {
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
  return {
    itemCount: receipts.length,
    meanScoreBasisPoints: Math.floor(
      receipts.reduce((sum, receipt) => sum + receipt.scoreBasisPoints, 0) / receipts.length,
    ),
    maximumUncertaintyBasisPoints,
    semanticOutcome,
    receiptLedgerDigest,
  };
}
