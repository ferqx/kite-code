import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../../../scripts/release/canonical-json';
import {
  type ReleaseArtifactIdentityV1,
  releaseArtifactIdentityV1Schema,
} from '../../../scripts/release/evidence-schema';
import { SEMANTIC_RUBRIC_VERSION } from './semantic-evaluator';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const blindIdSchema = z.string().regex(/^blind_[0-9a-f]{32}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const PINNED_SEMANTIC_REPOSITORY = 'ferqx/kite-code' as const;
export const PINNED_SEMANTIC_REPOSITORY_ID = 'R_kgDOSKbi8g' as const;
export const PINNED_SEMANTIC_WORKFLOW_PATH =
  '.github/workflows/compaction-semantic-evaluation.yml' as const;
export const PINNED_SEMANTIC_OIDC_ISSUER = 'https://token.actions.githubusercontent.com' as const;

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

const semanticSourceSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('github_actions_oidc'),
    canonicalRepository: z.literal(PINNED_SEMANTIC_REPOSITORY),
    repositoryId: z.literal(PINNED_SEMANTIC_REPOSITORY_ID),
    workflowPath: z.literal(PINNED_SEMANTIC_WORKFLOW_PATH),
    workflowRef: z.string().min(1),
    workflowSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    headSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1).max(256),
    artifactId: z.string().regex(/^[1-9][0-9]*$/),
    artifactName: z.string().min(1).max(256),
    oidcIssuer: z.literal(PINNED_SEMANTIC_OIDC_ISSUER),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    attestedPayloadDigest: digestSchema,
    attestationBundleDigest: digestSchema,
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
    deterministicSafety: z
      .object({
        outcome: z.enum(['passed', 'failed']),
        reportDigest: digestSchema,
      })
      .strict(),
    source: semanticSourceSchema,
    payloadDigest: digestSchema,
  })
  .strict();

export type SemanticEvaluationEvidenceV1 = z.infer<typeof semanticEvaluationEvidenceV1Schema>;

export interface SemanticEvidenceExpectedIdentityV1 {
  headSha: string;
  ref: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
  jobName: string;
  artifactId: string;
  artifactName: string;
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
    evidence.source.attestedPayloadDigest !== rebuiltPayloadDigest
  ) {
    throw new SemanticEvidenceVerificationError('identity_mismatch');
  }

  const reasonCodes = ['authenticated_semantic_evaluator_not_configured'];
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
    source.headSha !== expected.headSha ||
    source.ref !== expected.ref ||
    source.workflowSha !== expected.workflowSha ||
    source.runId !== expected.runId ||
    source.runAttempt !== expected.runAttempt ||
    source.jobName !== expected.jobName ||
    source.artifactId !== expected.artifactId ||
    source.artifactName !== expected.artifactName ||
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
