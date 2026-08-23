import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';
import { verifyReleaseEvidenceBundle } from './evidence-bundle';
import {
  RELEASE_EVIDENCE_KINDS,
  RELEASE_GATES,
  type ReleaseArtifactIdentity,
  type ReleaseEvidence,
  type ReleaseEvidenceException,
  type ReleaseEvidenceResult,
  type ReleaseGate,
  releaseArtifactIdentitySchema,
} from './evidence-schema';

const GATE_POLICY_SCHEMA = 'ReleaseGatePolicy' as const;
const GATE_POLICY_DIGEST_DOMAIN = 'release-gate-policy-v1';
const GATE_DECISION_DIGEST_DOMAIN = 'release-gate-decision-v1';
const SINGLE_MAINTAINER_IDENTITY = 'github:@ferqx';
const MAINTAINER_SECURITY_APPROVAL = 'candidate_bound_maintainer_security_review';
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonEmptySchema = z.string().trim().min(1);

export const releaseGateRequirementSchema = z
  .object({
    requirementId: nonEmptySchema,
    evidenceId: nonEmptySchema,
    kind: z.enum(RELEASE_EVIDENCE_KINDS),
    gate: z.enum(RELEASE_GATES),
    capability: nonEmptySchema.optional(),
    maxAgeSeconds: z.number().int().positive().optional(),
    requiredRouteIdentity: nonEmptySchema.optional(),
    requiredPlatformIdentity: nonEmptySchema.optional(),
  })
  .strict();

export const releaseGatePolicySchema = z
  .object({
    schema: z.literal(GATE_POLICY_SCHEMA),
    policyId: nonEmptySchema,
    mode: z.enum(['synthetic_foundation', 'github_release']),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    releaseWorkflowPath: nonEmptySchema,
    releaseWorkflowSha: z.string().regex(/^[a-f0-9]{40}$/),
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    allowedRefPrefixes: z.array(nonEmptySchema).min(1),
    capabilities: z.array(nonEmptySchema),
    requirements: z.array(releaseGateRequirementSchema),
    policyDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Gate policy capabilities must be unique.',
      });
    }
    const requirementIds = new Set<string>();
    const evidenceIds = new Set<string>();
    for (const [index, requirement] of value.requirements.entries()) {
      if (requirementIds.has(requirement.requirementId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'requirementId'],
          message: 'Gate requirement IDs must be unique.',
        });
      }
      requirementIds.add(requirement.requirementId);
      if (evidenceIds.has(requirement.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'evidenceId'],
          message: 'Each required evidence ID may satisfy only one requirement.',
        });
      }
      evidenceIds.add(requirement.evidenceId);
      if (requirement.capability && !value.capabilities.includes(requirement.capability)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'capability'],
          message: 'Requirement capability must be declared by the policy.',
        });
      }
    }
    if (value.mode === 'github_release') {
      const securityRequirements = value.requirements.filter(
        (requirement) => requirement.kind === 'maintainer_security_review',
      );
      if (securityRequirements.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message:
            'GitHub release policies require exactly one maintainer security review requirement.',
        });
      }
      const securityRequirement = securityRequirements[0];
      if (securityRequirement?.capability !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message: 'The maintainer security review must be a global requirement.',
        });
      }
      if (securityRequirement?.maxAgeSeconds === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message: 'The maintainer security review must declare a maximum evidence age.',
        });
      }
      if (
        securityRequirement?.requiredRouteIdentity === undefined ||
        securityRequirement.requiredPlatformIdentity === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message: 'The maintainer security review must bind exact route and platform identities.',
        });
      }
    }
  });

export type ReleaseGatePolicy = z.infer<typeof releaseGatePolicySchema>;
export type ReleaseGatePolicyInput = Omit<ReleaseGatePolicy, 'policyDigest'>;

export interface ReleaseGateDecisionItem {
  requirementId: string;
  evidenceId: string;
  gate: ReleaseGate;
  capability?: string;
  status: 'passed' | 'blocked' | 'waived';
  reasons: string[];
}

export interface ReleaseGateDecision {
  schema: 'ReleaseGateDecision';
  evaluatedAt: string;
  policyDigest: string;
  evidenceBundleDigest: string;
  artifactIdentity: ReleaseArtifactIdentity;
  overall: 'approved_foundation' | 'approved_candidate' | 'blocked';
  gates: Array<{
    gate: ReleaseGate;
    status: 'passed' | 'blocked' | 'not_applicable';
    reasons: string[];
  }>;
  capabilities: Array<{
    capability: string;
    status: 'enabled' | 'disabled';
    reasons: string[];
  }>;
  requirements: ReleaseGateDecisionItem[];
  requiredManualApprovals: string[];
  decisionDigest: string;
}

export const releaseGateDecisionSchema = z
  .object({
    schema: z.literal('ReleaseGateDecision'),
    evaluatedAt: z.iso.datetime({ offset: true }),
    policyDigest: digestSchema,
    evidenceBundleDigest: digestSchema,
    artifactIdentity: releaseArtifactIdentitySchema,
    overall: z.enum(['approved_foundation', 'approved_candidate', 'blocked']),
    gates: z
      .array(
        z
          .object({
            gate: z.enum(RELEASE_GATES),
            status: z.enum(['passed', 'blocked', 'not_applicable']),
            reasons: z.array(nonEmptySchema),
          })
          .strict(),
      )
      .length(RELEASE_GATES.length),
    capabilities: z.array(
      z
        .object({
          capability: nonEmptySchema,
          status: z.enum(['enabled', 'disabled']),
          reasons: z.array(nonEmptySchema),
        })
        .strict(),
    ),
    requirements: z.array(
      z
        .object({
          requirementId: nonEmptySchema,
          evidenceId: nonEmptySchema,
          gate: z.enum(RELEASE_GATES),
          capability: nonEmptySchema.optional(),
          status: z.enum(['passed', 'blocked', 'waived']),
          reasons: z.array(nonEmptySchema),
        })
        .strict(),
    ),
    requiredManualApprovals: z.array(nonEmptySchema),
    decisionDigest: digestSchema,
  })
  .strict();

export function verifyReleaseGateDecision(value: unknown): ReleaseGateDecision {
  const parsed = releaseGateDecisionSchema.parse(value);
  const { decisionDigest, ...material } = parsed;
  const expected = sha256DomainSeparated(GATE_DECISION_DIGEST_DOMAIN, canonicalJsonBytes(material));
  if (decisionDigest !== expected) {
    throw new Error(`Release Gate decision digest mismatch: expected ${expected}.`);
  }
  return parsed as ReleaseGateDecision;
}

export function computeReleaseGatePolicyDigest(input: ReleaseGatePolicyInput): `sha256:${string}` {
  return sha256DomainSeparated(GATE_POLICY_DIGEST_DOMAIN, canonicalJsonBytes(input));
}

export function buildReleaseGatePolicy(input: ReleaseGatePolicyInput): ReleaseGatePolicy {
  return releaseGatePolicySchema.parse({
    ...input,
    policyDigest: computeReleaseGatePolicyDigest(input),
  });
}

export function verifyReleaseGatePolicy(value: unknown): ReleaseGatePolicy {
  const parsed = releaseGatePolicySchema.parse(value);
  const { policyDigest, ...material } = parsed;
  const expected = computeReleaseGatePolicyDigest(material);
  if (policyDigest !== expected) {
    throw new Error(`Release Gate policy digest mismatch: expected ${expected}.`);
  }
  return parsed;
}

export function evaluateReleaseGate(input: {
  policy: unknown;
  evidence: unknown;
  artifactIdentity: ReleaseArtifactIdentity;
  evaluatedAt: string;
}): ReleaseGateDecision {
  const policy = verifyReleaseGatePolicy(input.policy);
  const evidence = verifyReleaseEvidenceBundle(input.evidence);
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('Gate evaluation time must be ISO-8601.');

  const globalReasons: string[] = [];
  if (!sameArtifactIdentity(evidence.artifactIdentity, input.artifactIdentity)) {
    globalReasons.push('artifact_identity_mismatch');
  }
  if (input.artifactIdentity.gatePolicyDigest !== policy.policyDigest) {
    globalReasons.push('gate_policy_identity_mismatch');
  }
  if (
    input.artifactIdentity.canonicalRepository !== policy.canonicalRepository ||
    input.artifactIdentity.repositoryId !== policy.repositoryId
  ) {
    globalReasons.push('repository_identity_mismatch');
  }
  if (policy.mode === 'synthetic_foundation') {
    if (!evidence.nonDistributable || !evidence.syntheticTrustRoot) {
      globalReasons.push('synthetic_foundation_requires_non_distributable_trust_root');
    }
  } else if (evidence.nonDistributable || evidence.syntheticTrustRoot) {
    globalReasons.push('github_release_rejects_synthetic_evidence');
  }

  const resultsById = new Map(evidence.results.map((result) => [result.evidenceId, result]));
  const requiredEvidenceIds = new Set(
    policy.requirements.map((requirement) => requirement.evidenceId),
  );
  for (const result of evidence.results) {
    if (!requiredEvidenceIds.has(result.evidenceId)) {
      globalReasons.push(`unexpected_evidence:${result.evidenceId}`);
    }
  }
  const requirements = policy.requirements.map((requirement): ReleaseGateDecisionItem => {
    const result = resultsById.get(requirement.evidenceId);
    const reasons: string[] = [];
    if (!result) {
      reasons.push('missing_evidence');
      return {
        requirementId: requirement.requirementId,
        evidenceId: requirement.evidenceId,
        gate: requirement.gate,
        ...(requirement.capability ? { capability: requirement.capability } : {}),
        status: 'blocked',
        reasons,
      };
    }
    validateRequirementIdentity({ policy, evidence, requirement, result, evaluatedAtMs, reasons });
    if (result.status !== 'passed') reasons.push(`evidence_${result.status}`);

    const exception = matchingException(evidence, result, evaluatedAtMs);
    const waivable =
      result.kind !== 'maintainer_security_review' && result.gate !== 'G0' && result.gate !== 'G1';
    const status =
      reasons.length === 0
        ? 'passed'
        : waivable && exception && exception.gate === requirement.gate
          ? 'waived'
          : 'blocked';
    return {
      requirementId: requirement.requirementId,
      evidenceId: requirement.evidenceId,
      gate: requirement.gate,
      ...(requirement.capability ? { capability: requirement.capability } : {}),
      status,
      reasons: status === 'waived' ? [...reasons, `waived_by:${exception?.exceptionId}`] : reasons,
    };
  });

  const maintainerReview = evidence.results.find(
    (result) => result.kind === 'maintainer_security_review',
  )?.maintainerReview;
  const p2Dispositions = new Map(
    maintainerReview?.p2Dispositions.map((disposition) => [disposition.riskId, disposition]) ?? [],
  );
  for (const risk of evidence.risks) {
    if (risk.status === 'open') {
      globalReasons.push(`open_${risk.severity.toLowerCase()}_risk:${risk.riskId}`);
    } else if (risk.status === 'accepted' && (risk.severity === 'P0' || risk.severity === 'P1')) {
      globalReasons.push(`unresolved_${risk.severity.toLowerCase()}_risk:${risk.riskId}`);
    } else if (risk.severity === 'P2' && risk.status === 'accepted') {
      const disposition = p2Dispositions.get(risk.riskId);
      if (disposition?.disposition !== 'accepted') {
        globalReasons.push(`p2_disposition_missing:${risk.riskId}`);
      }
    }
  }
  for (const disposition of p2Dispositions.values()) {
    const risk = evidence.risks.find((candidate) => candidate.riskId === disposition.riskId);
    if (risk?.severity !== 'P2' || risk.status !== disposition.disposition) {
      globalReasons.push(`p2_disposition_mismatch:${disposition.riskId}`);
    }
  }
  const requiredManualApprovals = collectRequiredManualApprovals(
    policy,
    requirements,
    globalReasons,
  );
  if (requiredManualApprovals.length > 0) {
    globalReasons.push(
      ...requiredManualApprovals.map((approval) => `manual_approval_missing:${approval}`),
    );
  }

  const globalRequirementFailures = requirements.filter(
    (item) => item.capability === undefined && item.status === 'blocked',
  );
  const capabilities = policy.capabilities.map((capability) => {
    const capabilityRequirements = requirements.filter((item) => item.capability === capability);
    const blocked = capabilityRequirements.filter((item) => item.status === 'blocked');
    const globalCapabilityReasons = [
      ...globalReasons,
      ...globalRequirementFailures.flatMap((item) =>
        item.reasons.map((reason) => `${item.requirementId}:${reason}`),
      ),
    ];
    const reasons = [
      ...globalCapabilityReasons,
      ...(capabilityRequirements.length === 0 ? ['no_applicable_requirement'] : []),
      ...blocked.flatMap((item) => item.reasons.map((reason) => `${item.requirementId}:${reason}`)),
    ];
    return {
      capability,
      status: reasons.length === 0 ? ('enabled' as const) : ('disabled' as const),
      reasons: [...new Set(reasons)].sort(),
    };
  });

  const gates = RELEASE_GATES.map((gate) => {
    const gateItems = requirements.filter((item) => item.gate === gate && !item.capability);
    const blockedItems = requirements.filter(
      (item) => item.gate === gate && item.status === 'blocked' && !item.capability,
    );
    const reasons = blockedItems.flatMap((item) =>
      item.reasons.map((reason) => `${item.requirementId}:${reason}`),
    );
    if (globalReasons.length > 0) reasons.push(...globalReasons);
    return {
      gate,
      status:
        reasons.length > 0
          ? ('blocked' as const)
          : gateItems.length === 0
            ? ('not_applicable' as const)
            : ('passed' as const),
      reasons: [...new Set(reasons)].sort(),
    };
  });

  const globallyBlocked = gates.some(({ status }) => status === 'blocked');
  const material = {
    schema: 'ReleaseGateDecision' as const,
    evaluatedAt: input.evaluatedAt,
    policyDigest: policy.policyDigest,
    evidenceBundleDigest: evidence.bundleDigest,
    artifactIdentity: input.artifactIdentity,
    overall: globallyBlocked
      ? ('blocked' as const)
      : policy.mode === 'synthetic_foundation'
        ? ('approved_foundation' as const)
        : ('approved_candidate' as const),
    gates,
    capabilities,
    requirements,
    requiredManualApprovals,
  };
  return {
    ...material,
    decisionDigest: sha256DomainSeparated(
      GATE_DECISION_DIGEST_DOMAIN,
      canonicalJsonBytes(material),
    ),
  };
}

function validateRequirementIdentity(input: {
  policy: ReleaseGatePolicy;
  evidence: ReleaseEvidence;
  requirement: ReleaseGatePolicy['requirements'][number];
  result: ReleaseEvidenceResult;
  evaluatedAtMs: number;
  reasons: string[];
}): void {
  const { policy, evidence, requirement, result, evaluatedAtMs, reasons } = input;
  if (result.kind !== requirement.kind) reasons.push('evidence_kind_mismatch');
  if (result.gate !== requirement.gate) reasons.push('evidence_gate_mismatch');
  if (result.capability !== requirement.capability) reasons.push('evidence_capability_mismatch');
  if (requirement.requiredRouteIdentity !== result.routeIdentity) {
    reasons.push('route_identity_mismatch');
  }
  if (requirement.requiredPlatformIdentity !== result.platformIdentity) {
    reasons.push('platform_identity_mismatch');
  }
  if (!sameArtifactIdentity(result.artifactIdentity, evidence.artifactIdentity)) {
    reasons.push('result_artifact_identity_mismatch');
  }
  const endedAtMs = Date.parse(result.executionIdentity.endedAt);
  if (requirement.maxAgeSeconds !== undefined) {
    const oldestAllowed = evaluatedAtMs - requirement.maxAgeSeconds * 1000;
    if (endedAtMs < oldestAllowed || endedAtMs > evaluatedAtMs) reasons.push('stale_evidence');
  }
  if (result.expiresAt && Date.parse(result.expiresAt) <= evaluatedAtMs) {
    reasons.push('expired_evidence');
  }
  if (policy.mode === 'synthetic_foundation') {
    if (result.executionIdentity.source !== 'local_synthetic') {
      reasons.push('non_synthetic_execution_identity');
    }
    return;
  }
  if (result.kind === 'maintainer_security_review') {
    if (result.executionIdentity.source !== 'github_maintainer_review') {
      reasons.push('security_review_requires_maintainer_identity');
    } else {
      const execution = result.executionIdentity;
      if (
        execution.reviewerIdentity !== SINGLE_MAINTAINER_IDENTITY ||
        execution.actorIdentity !== SINGLE_MAINTAINER_IDENTITY
      ) {
        reasons.push('security_review_maintainer_identity_mismatch');
      }
      if (!matchesGithubReleaseExecutionIdentity(execution, policy)) {
        reasons.push('security_review_github_identity_mismatch');
      }
      const latestAutomaticEvidenceEnd = Math.max(
        ...evidence.results
          .filter((candidate) => candidate.kind !== 'maintainer_security_review')
          .map((candidate) => Date.parse(candidate.executionIdentity.endedAt)),
      );
      if (Number.isFinite(latestAutomaticEvidenceEnd) && endedAtMs < latestAutomaticEvidenceEnd) {
        reasons.push('security_review_precedes_automatic_evidence');
      }
    }
    return;
  }
  if (result.executionIdentity.source !== 'github_actions') {
    reasons.push('non_github_execution_identity');
    return;
  }
  const execution = result.executionIdentity;
  if (!matchesGithubReleaseExecutionIdentity(execution, policy)) {
    reasons.push('github_release_identity_mismatch');
  }
}

function matchesGithubReleaseExecutionIdentity(
  execution: Extract<
    ReleaseEvidenceResult['executionIdentity'],
    { source: 'github_actions' | 'github_maintainer_review' }
  >,
  policy: ReleaseGatePolicy,
): boolean {
  return (
    execution.canonicalRepository === policy.canonicalRepository &&
    execution.repositoryId === policy.repositoryId &&
    execution.workflowPath === policy.releaseWorkflowPath &&
    execution.workflowRef ===
      `${execution.canonicalRepository}/${execution.workflowPath}@${execution.ref}` &&
    execution.oidcIssuer === policy.oidcIssuer &&
    execution.workflowSha === policy.releaseWorkflowSha &&
    policy.allowedRefPrefixes.some((prefix) => execution.ref.startsWith(prefix))
  );
}

function matchingException(
  evidence: ReleaseEvidence,
  result: ReleaseEvidenceResult,
  evaluatedAtMs: number,
): ReleaseEvidenceException | undefined {
  return evidence.exceptions.find(
    (exception) =>
      exception.evidenceId === result.evidenceId &&
      exception.gate === result.gate &&
      exception.capability === result.capability &&
      Date.parse(exception.approvedAt) <= evaluatedAtMs &&
      Date.parse(exception.expiresAt) > evaluatedAtMs,
  );
}

function collectRequiredManualApprovals(
  policy: ReleaseGatePolicy,
  requirements: ReleaseGateDecisionItem[],
  globalReasons: string[],
): string[] {
  if (policy.mode === 'synthetic_foundation') return [];
  const securityRequirement = policy.requirements.find(
    (requirement) => requirement.kind === 'maintainer_security_review',
  );
  const securityDecision = requirements.find(
    (requirement) => requirement.requirementId === securityRequirement?.requirementId,
  );
  return securityDecision?.status === 'passed' && globalReasons.length === 0
    ? []
    : [MAINTAINER_SECURITY_APPROVAL];
}

function sameArtifactIdentity(
  left: ReleaseArtifactIdentity,
  right: ReleaseArtifactIdentity,
): boolean {
  return (
    left.canonicalRepository === right.canonicalRepository &&
    left.repositoryId === right.repositoryId &&
    left.commit === right.commit &&
    left.payloadSha256 === right.payloadSha256 &&
    left.canonicalManifestDigest === right.canonicalManifestDigest &&
    left.behaviorDigest === right.behaviorDigest &&
    left.profileDigest === right.profileDigest &&
    left.gatePolicyDigest === right.gatePolicyDigest
  );
}
