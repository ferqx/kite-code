import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';
import { D07_APPROVED_POLICY_V1 } from './agent-task-approved-policy';
import { APPROVED_AGENT_TASK_CASE_IDS_V1 } from './agent-task-approved-suite';
import {
  type AgentTaskCandidateIdentityV1,
  type AgentTaskEvidenceSourceV1,
  agentTaskCandidateIdentityV1Schema,
  agentTaskEvidenceSourceV1Schema,
  computeAgentTaskCandidateDigestV1,
  computeAgentTaskSourceDigestV1,
} from './agent-task-authenticated-evidence';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z.string().min(1).max(256);
const timestampSchema = z.iso.datetime({ offset: true });

const uxReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('AgentTaskUxReceiptV1'),
    sequence: z.number().int().positive(),
    caseId: z.enum(APPROVED_AGENT_TASK_CASE_IDS_V1),
    attemptId: identitySchema,
    sourceDigest: digestSchema,
    candidateDigest: digestSchema,
    entrypoint: z.enum(['tui', 'headless_cli']),
    plan: z.enum(['not_required', 'drafted', 'reviewed', 'completed']),
    toolSearch: z
      .object({
        required: z.boolean(),
        expectedCapabilityAlias: identitySchema.nullable(),
        selectedCapabilityAlias: identitySchema.nullable(),
        outcome: z.enum(['not_needed', 'found', 'missed', 'wrong_candidate', 'error']),
        latencyMs: z.number().int().nonnegative(),
      })
      .strict(),
    unintendedDiscovery: z
      .object({
        mcpTriggerCount: z.number().int().nonnegative(),
        skillTriggerCount: z.number().int().nonnegative(),
      })
      .strict(),
    askUser: z
      .object({
        expected: z.boolean(),
        outcome: z.enum(['not_needed', 'answered', 'cancelled', 'timed_out', 'invalid']),
        canonicalQuestionDigest: digestSchema.nullable(),
      })
      .strict(),
    recovery: z.enum(['not_needed', 'recovered', 'blocked', 'failed']),
    verification: z.enum(['passed', 'failed', 'inconclusive', 'not_run']),
    reviewHandoff: z.enum(['ready', 'blocked', 'missing']),
    claimedComplete: z.boolean(),
    userCorrections: z.number().int().nonnegative(),
    approvalCount: z.number().int().nonnegative(),
    observedAt: timestampSchema,
    previousReceiptDigest: digestSchema.nullable(),
  })
  .strict();

export const agentTaskUxReceiptV1Schema = uxReceiptMaterialV1Schema.extend({
  receiptDigest: digestSchema,
});
export type AgentTaskUxReceiptV1 = z.infer<typeof agentTaskUxReceiptV1Schema>;

const humanReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('AgentTaskHumanOutcomeReceiptV1'),
    sequence: z.number().int().positive(),
    participantIdentityDigest: digestSchema,
    reviewerIdentityDigest: digestSchema,
    consentReceiptDigest: digestSchema,
    consent: z
      .object({
        explicitOptIn: z.literal(true),
        grantedAt: timestampSchema,
        withdrawnAt: timestampSchema.nullable(),
        rawSessionContentShared: z.literal(false),
        rawRepositoryContentShared: z.literal(false),
        retentionPolicyDigest: digestSchema,
      })
      .strict(),
    caseId: z.enum(APPROVED_AGENT_TASK_CASE_IDS_V1),
    attemptId: identitySchema,
    sourceDigest: digestSchema,
    candidateDigest: digestSchema,
    blindMaterialDigest: digestSchema,
    humanAccepted: z.boolean(),
    integrated: z.boolean(),
    reverted: z.boolean(),
    taskUnderstandingBps: z.number().int().min(0).max(10_000),
    reviewBurdenBps: z.number().int().min(0).max(10_000),
    observedAt: timestampSchema,
    previousReceiptDigest: digestSchema.nullable(),
  })
  .strict();

export const agentTaskHumanOutcomeReceiptV1Schema = humanReceiptMaterialV1Schema.extend({
  receiptDigest: digestSchema,
});
export type AgentTaskHumanOutcomeReceiptV1 = z.infer<typeof agentTaskHumanOutcomeReceiptV1Schema>;
export type AgentTaskHumanConsentV1 = AgentTaskHumanOutcomeReceiptV1['consent'];

export const agentTaskProductEvidenceV1Schema = z
  .object({
    schema: z.literal('AgentTaskProductEvidenceV1'),
    executionClass: z.enum(['contract_conformance', 'production_route_run']),
    source: agentTaskEvidenceSourceV1Schema,
    candidate: agentTaskCandidateIdentityV1Schema,
    uxReceipts: z.array(agentTaskUxReceiptV1Schema).max(4096),
    humanReceipts: z.array(agentTaskHumanOutcomeReceiptV1Schema).max(4096),
    uxLedgerDigest: digestSchema,
    humanLedgerDigest: digestSchema,
    bundleDigest: digestSchema,
    authentication: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('unconfigured'),
          reason: z.literal('production_product_evidence_authority_unconfigured'),
          subjectDigest: digestSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('github_oidc_sigstore_v1'),
          authorityIdentity: identitySchema,
          verifierIdentity: identitySchema,
          issuer: z.literal('https://token.actions.githubusercontent.com'),
          subjectDigest: digestSchema,
          attestationDigest: digestSchema,
          verificationReceiptDigest: digestSchema,
          verifiedAt: timestampSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export type AgentTaskProductEvidenceV1 = z.infer<typeof agentTaskProductEvidenceV1Schema>;

export interface AgentTaskProductEvidenceAuthorityV1 {
  authorityIdentity: string;
  verifierIdentity: string;
  repositoryId: string;
  workflowPath: string;
  subjectDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  verificationReceiptDigest: `sha256:${string}`;
  verifiedAt: string;
}

/** Source-owned production authorities. Empty until a reviewed attestation verifier is merged. */
export const PRODUCTION_AGENT_TASK_PRODUCT_AUTHORITIES_V1: readonly AgentTaskProductEvidenceAuthorityV1[] =
  Object.freeze([]);

export interface AgentTaskProductProductionPolicyV1 {
  policyId: string;
  minimumTaskUnderstandingBps: number;
  maximumReviewBurdenBps: number;
  maximumConsentAgeMs: number;
}

/**
 * Product-quality thresholds require an explicit reviewed policy. D-07 already
 * owns the external population minimums, but it does not approve understanding,
 * burden, or consent-freshness values. Keep the positive production path closed
 * until those values are reviewed and added here in source.
 */
export const PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1: AgentTaskProductProductionPolicyV1 | null =
  null;

export interface AgentTaskProductEvidenceVerificationV1 {
  schema: 'AgentTaskProductEvidenceVerificationV1';
  status: 'passed' | 'blocked' | 'failed';
  evidenceEligible: boolean;
  sourceDigest: `sha256:${string}`;
  candidateDigest: `sha256:${string}`;
  uxLedgerDigest: `sha256:${string}`;
  humanLedgerDigest: `sha256:${string}`;
  bundleDigest: `sha256:${string}`;
  verifiedUxReceiptCount: number;
  verifiedHumanReceiptCount: number;
  reasonCodes: string[];
}

export function buildAgentTaskUxReceiptV1(
  material: z.infer<typeof uxReceiptMaterialV1Schema>,
): AgentTaskUxReceiptV1 {
  const parsed = uxReceiptMaterialV1Schema.parse(material);
  return agentTaskUxReceiptV1Schema.parse({
    ...parsed,
    receiptDigest: sha256DomainSeparated(
      'kite.evals.agent-task-ux-receipt.v1',
      canonicalJsonBytes(parsed),
    ),
  });
}

export function buildAgentTaskHumanOutcomeReceiptV1(
  material: z.infer<typeof humanReceiptMaterialV1Schema>,
): AgentTaskHumanOutcomeReceiptV1 {
  const parsed = humanReceiptMaterialV1Schema.parse(material);
  if (parsed.consentReceiptDigest !== computeAgentTaskHumanConsentDigestV1(parsed.consent)) {
    throw new Error('Agent task human consent receipt digest mismatch.');
  }
  return agentTaskHumanOutcomeReceiptV1Schema.parse({
    ...parsed,
    receiptDigest: sha256DomainSeparated(
      'kite.evals.agent-task-human-receipt.v1',
      canonicalJsonBytes(parsed),
    ),
  });
}

export function computeAgentTaskHumanConsentDigestV1(
  consent: AgentTaskHumanConsentV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.agent-task-human-consent.v1',
    canonicalJsonBytes(consent),
  );
}

export function computeAgentTaskProductLedgerDigestV1(
  kind: 'ux' | 'human',
  receipts: readonly (AgentTaskUxReceiptV1 | AgentTaskHumanOutcomeReceiptV1)[],
): `sha256:${string}` {
  return sha256DomainSeparated(
    `kite.evals.agent-task-${kind}-ledger.v1`,
    canonicalJsonBytes(receipts),
  );
}

export function computeAgentTaskProductBundleDigestV1(
  material: Omit<AgentTaskProductEvidenceV1, 'bundleDigest' | 'authentication'>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.agent-task-product-evidence.v1',
    canonicalJsonBytes(material),
  );
}

export function buildAgentTaskProductEvidenceV1(input: {
  executionClass: AgentTaskProductEvidenceV1['executionClass'];
  source: AgentTaskEvidenceSourceV1;
  candidate: AgentTaskCandidateIdentityV1;
  uxReceipts: readonly AgentTaskUxReceiptV1[];
  humanReceipts: readonly AgentTaskHumanOutcomeReceiptV1[];
  authentication?: AgentTaskProductEvidenceV1['authentication'];
}): AgentTaskProductEvidenceV1 {
  const material = {
    schema: 'AgentTaskProductEvidenceV1' as const,
    executionClass: input.executionClass,
    source: input.source,
    candidate: input.candidate,
    uxReceipts: [...input.uxReceipts],
    humanReceipts: [...input.humanReceipts],
    uxLedgerDigest: computeAgentTaskProductLedgerDigestV1('ux', input.uxReceipts),
    humanLedgerDigest: computeAgentTaskProductLedgerDigestV1('human', input.humanReceipts),
  };
  const bundleDigest = computeAgentTaskProductBundleDigestV1(material);
  return agentTaskProductEvidenceV1Schema.parse({
    ...material,
    bundleDigest,
    authentication: input.authentication ?? {
      kind: 'unconfigured',
      reason: 'production_product_evidence_authority_unconfigured',
      subjectDigest: bundleDigest,
    },
  });
}

export function verifyAgentTaskProductEvidenceV1(input: {
  evidence: unknown;
  expectedSource: AgentTaskEvidenceSourceV1;
  expectedCandidate: AgentTaskCandidateIdentityV1;
  expectedAttempts: readonly { attemptId: string; caseId: string }[];
  requiredHumanReceiptCount: number;
}): AgentTaskProductEvidenceVerificationV1 {
  const evidence = agentTaskProductEvidenceV1Schema.parse(input.evidence);
  const sourceDigest = computeAgentTaskSourceDigestV1(evidence.source);
  const candidateDigest = computeAgentTaskCandidateDigestV1(evidence.candidate);
  if (sourceDigest !== computeAgentTaskSourceDigestV1(input.expectedSource)) {
    throw new Error('Agent task product evidence source identity mismatch.');
  }
  if (candidateDigest !== computeAgentTaskCandidateDigestV1(input.expectedCandidate)) {
    throw new Error('Agent task product evidence candidate identity mismatch.');
  }
  const expectedAttempts = new Map(
    input.expectedAttempts.map((attempt) => [attempt.attemptId, attempt.caseId] as const),
  );
  if (expectedAttempts.size !== input.expectedAttempts.length) {
    throw new Error('Expected Agent task attempt identities are duplicated.');
  }
  verifyReceiptLedger(evidence.uxReceipts, sourceDigest, candidateDigest, 'ux');
  verifyReceiptLedger(evidence.humanReceipts, sourceDigest, candidateDigest, 'human');
  const uxAttemptIds = new Set(evidence.uxReceipts.map((receipt) => receipt.attemptId));
  if (
    uxAttemptIds.size !== expectedAttempts.size ||
    [...expectedAttempts].some(([attemptId]) => !uxAttemptIds.has(attemptId))
  ) {
    throw new Error('UX receipts do not cover the exact retained Agent task attempts.');
  }
  for (const receipt of evidence.uxReceipts) {
    if (expectedAttempts.get(receipt.attemptId) !== receipt.caseId) {
      throw new Error('UX receipt attempt-to-case binding does not match retained evidence.');
    }
  }
  for (const receipt of evidence.humanReceipts) {
    if (!expectedAttempts.has(receipt.attemptId)) {
      throw new Error('Human receipt references an invented Agent task attempt.');
    }
    if (expectedAttempts.get(receipt.attemptId) !== receipt.caseId) {
      throw new Error('Human receipt attempt-to-case binding does not match retained evidence.');
    }
    if (receipt.consentReceiptDigest !== computeAgentTaskHumanConsentDigestV1(receipt.consent)) {
      throw new Error('Agent task human consent receipt digest mismatch.');
    }
  }
  if (
    evidence.uxLedgerDigest !== computeAgentTaskProductLedgerDigestV1('ux', evidence.uxReceipts)
  ) {
    throw new Error('Agent task UX ledger digest does not rebuild.');
  }
  if (
    evidence.humanLedgerDigest !==
    computeAgentTaskProductLedgerDigestV1('human', evidence.humanReceipts)
  ) {
    throw new Error('Agent task human ledger digest does not rebuild.');
  }
  const { bundleDigest, authentication: _authentication, ...material } = evidence;
  const expectedBundleDigest = computeAgentTaskProductBundleDigestV1(material);
  if (
    bundleDigest !== expectedBundleDigest ||
    evidence.authentication.subjectDigest !== bundleDigest
  ) {
    throw new Error('Agent task product evidence bundle or authentication subject mismatch.');
  }

  const reasons = new Set<string>();
  if (evidence.executionClass !== 'production_route_run') {
    reasons.add('contract_conformance_not_production');
  }
  for (const receipt of evidence.uxReceipts) {
    if (receipt.toolSearch.outcome === 'missed') reasons.add('tool_search_missed');
    if (receipt.toolSearch.outcome === 'wrong_candidate')
      reasons.add('tool_search_wrong_candidate');
    if (receipt.toolSearch.outcome === 'error') reasons.add('tool_search_error');
    if (receipt.unintendedDiscovery.mcpTriggerCount > 0) reasons.add('unintended_mcp_trigger');
    if (receipt.unintendedDiscovery.skillTriggerCount > 0) reasons.add('unintended_skill_trigger');
    if (receipt.askUser.outcome === 'invalid') reasons.add('ask_user_invalid');
    if (receipt.recovery === 'failed') reasons.add('recovery_failed');
    if (receipt.verification !== 'passed') reasons.add(`verification_${receipt.verification}`);
    if (receipt.reviewHandoff !== 'ready') reasons.add(`review_handoff_${receipt.reviewHandoff}`);
    if (receipt.claimedComplete && receipt.verification !== 'passed') {
      reasons.add('false_completion_claim');
    }
  }
  const productionRun = evidence.executionClass === 'production_route_run';
  const requiredHumanReceiptCount = productionRun
    ? D07_APPROVED_POLICY_V1.thresholds.externalLimitedMinimumOptInUsers *
      D07_APPROVED_POLICY_V1.thresholds.externalLimitedMinimumTasksPerUser
    : input.requiredHumanReceiptCount;
  if (evidence.humanReceipts.length < requiredHumanReceiptCount) {
    reasons.add('human_receipt_count_insufficient');
  }
  if (productionRun) {
    const receiptsByParticipant = new Map<string, number>();
    for (const receipt of evidence.humanReceipts) {
      receiptsByParticipant.set(
        receipt.participantIdentityDigest,
        (receiptsByParticipant.get(receipt.participantIdentityDigest) ?? 0) + 1,
      );
    }
    if (
      receiptsByParticipant.size <
        D07_APPROVED_POLICY_V1.thresholds.externalLimitedMinimumOptInUsers ||
      [...receiptsByParticipant.values()].some(
        (count) => count < D07_APPROVED_POLICY_V1.thresholds.externalLimitedMinimumTasksPerUser,
      )
    ) {
      reasons.add('external_population_insufficient');
    }
    if (!PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1) {
      reasons.add('production_product_policy_unconfigured');
    }
  }
  for (const receipt of evidence.humanReceipts) {
    if (receipt.consent.withdrawnAt !== null) reasons.add('participant_withdrawn');
    if (!receipt.humanAccepted) reasons.add('human_review_not_accepted');
    if (!receipt.integrated) reasons.add('human_outcome_not_integrated');
    if (receipt.reverted) reasons.add('human_outcome_reverted');
    if (productionRun && PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1) {
      if (
        receipt.taskUnderstandingBps <
        PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1.minimumTaskUnderstandingBps
      ) {
        reasons.add('task_understanding_below_policy');
      }
      if (
        receipt.reviewBurdenBps > PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1.maximumReviewBurdenBps
      ) {
        reasons.add('review_burden_above_policy');
      }
      const consentAgeMs = Date.parse(receipt.observedAt) - Date.parse(receipt.consent.grantedAt);
      if (
        consentAgeMs < 0 ||
        consentAgeMs > PRODUCTION_AGENT_TASK_PRODUCT_POLICY_V1.maximumConsentAgeMs
      ) {
        reasons.add('participant_consent_not_fresh');
      }
    }
  }

  const authentication = evidence.authentication;
  const authenticated =
    authentication.kind === 'github_oidc_sigstore_v1' &&
    PRODUCTION_AGENT_TASK_PRODUCT_AUTHORITIES_V1.some(
      (authority) =>
        authority.authorityIdentity === authentication.authorityIdentity &&
        authority.verifierIdentity === authentication.verifierIdentity &&
        authority.repositoryId === evidence.source.repositoryId &&
        authority.workflowPath === evidence.source.workflowPath &&
        authority.subjectDigest === authentication.subjectDigest &&
        authority.attestationDigest === authentication.attestationDigest &&
        authority.verificationReceiptDigest === authentication.verificationReceiptDigest &&
        authority.verifiedAt === authentication.verifiedAt,
    );
  if (!authenticated) reasons.add('production_product_evidence_authority_unconfigured');
  if (
    authentication.kind === 'github_oidc_sigstore_v1' &&
    Date.parse(authentication.verifiedAt) < Date.parse(evidence.source.endedAt)
  ) {
    reasons.add('production_product_evidence_authentication_time_invalid');
  }
  const safetyFailed = [...reasons].some((reason) =>
    [
      'false_completion_claim',
      'human_outcome_reverted',
      'tool_search_wrong_candidate',
      'unintended_mcp_trigger',
      'unintended_skill_trigger',
    ].includes(reason),
  );
  const status = safetyFailed ? 'failed' : reasons.size === 0 ? 'passed' : 'blocked';
  return {
    schema: 'AgentTaskProductEvidenceVerificationV1',
    status,
    evidenceEligible: status === 'passed',
    sourceDigest,
    candidateDigest,
    uxLedgerDigest: evidence.uxLedgerDigest as `sha256:${string}`,
    humanLedgerDigest: evidence.humanLedgerDigest as `sha256:${string}`,
    bundleDigest: evidence.bundleDigest as `sha256:${string}`,
    verifiedUxReceiptCount: evidence.uxReceipts.length,
    verifiedHumanReceiptCount: evidence.humanReceipts.length,
    reasonCodes: [...reasons].sort(),
  };
}

function verifyReceiptLedger(
  receipts: readonly (AgentTaskUxReceiptV1 | AgentTaskHumanOutcomeReceiptV1)[],
  sourceDigest: string,
  candidateDigest: string,
  kind: 'ux' | 'human',
): void {
  let previous: string | null = null;
  const attemptIds = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.sequence !== index + 1 || receipt.previousReceiptDigest !== previous) {
      throw new Error(`Agent task ${kind} receipt chain is not canonical.`);
    }
    if (receipt.sourceDigest !== sourceDigest || receipt.candidateDigest !== candidateDigest) {
      throw new Error(`Agent task ${kind} receipt identity mismatch.`);
    }
    if (attemptIds.has(receipt.attemptId)) {
      throw new Error(`Agent task ${kind} receipts duplicate an attempt identity.`);
    }
    attemptIds.add(receipt.attemptId);
    const { receiptDigest, ...material } = receipt;
    const expected = sha256DomainSeparated(
      `kite.evals.agent-task-${kind}-receipt.v1`,
      canonicalJsonBytes(material),
    );
    if (receiptDigest !== expected) throw new Error(`Agent task ${kind} receipt digest mismatch.`);
    previous = receiptDigest;
  }
}
