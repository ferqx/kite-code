import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';
import { verifyReleaseEvidenceBundleV1 } from './evidence-bundle';
import {
  RELEASE_EVIDENCE_KINDS,
  RELEASE_GATES,
  type ReleaseArtifactIdentityV1,
  type ReleaseEvidenceExceptionV1,
  type ReleaseEvidenceResultV1,
  type ReleaseEvidenceV1,
  type ReleaseGateV1,
} from './evidence-schema';

const GATE_POLICY_SCHEMA = 'ReleaseGatePolicyV1' as const;
const GATE_POLICY_DIGEST_DOMAIN = 'release-gate-policy-v1';
const GATE_DECISION_DIGEST_DOMAIN = 'release-gate-decision-v1';
const SINGLE_MAINTAINER_IDENTITY = 'github:@ferqx';
const THIRD_PARTY_SECURITY_APPROVAL = 'independent_third_party_security_review';
// No independent reviewer signing identity has been approved yet. External
// review records remain blocked until a real reviewer and verifier trust root
// are registered through the release governance process.
const TRUSTED_THIRD_PARTY_REVIEWER_IDENTITIES = new Set<string>();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonEmptySchema = z.string().trim().min(1);

export const releaseGateRequirementV1Schema = z
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

export const releaseGatePolicyV1Schema = z
  .object({
    schema: z.literal(GATE_POLICY_SCHEMA),
    policyId: nonEmptySchema,
    mode: z.enum(['synthetic_foundation', 'github_release']),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    releaseWorkflowPath: nonEmptySchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    allowedRefPrefixes: z.array(nonEmptySchema).min(1),
    capabilities: z.array(nonEmptySchema),
    requirements: z.array(releaseGateRequirementV1Schema),
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
        (requirement) => requirement.kind === 'third_party_security_review',
      );
      if (securityRequirements.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message:
            'GitHub release policies require exactly one third-party security review requirement.',
        });
      }
      const securityRequirement = securityRequirements[0];
      if (securityRequirement?.capability !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message: 'The third-party security review must be a global requirement.',
        });
      }
      if (securityRequirement?.maxAgeSeconds === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['requirements'],
          message: 'The third-party security review must declare a maximum evidence age.',
        });
      }
    }
  });

export type ReleaseGatePolicyV1 = z.infer<typeof releaseGatePolicyV1Schema>;
export type ReleaseGatePolicyInputV1 = Omit<ReleaseGatePolicyV1, 'policyDigest'>;

export interface ReleaseGateDecisionItemV1 {
  requirementId: string;
  evidenceId: string;
  gate: ReleaseGateV1;
  capability?: string;
  status: 'passed' | 'blocked' | 'waived';
  reasons: string[];
}

export interface ReleaseGateDecisionV1 {
  schema: 'ReleaseGateDecisionV1';
  evaluatedAt: string;
  policyDigest: string;
  evidenceBundleDigest: string;
  artifactIdentity: ReleaseArtifactIdentityV1;
  overall: 'approved_foundation' | 'approved_candidate' | 'blocked';
  gates: Array<{
    gate: ReleaseGateV1;
    status: 'passed' | 'blocked' | 'not_applicable';
    reasons: string[];
  }>;
  capabilities: Array<{
    capability: string;
    status: 'enabled' | 'disabled';
    reasons: string[];
  }>;
  requirements: ReleaseGateDecisionItemV1[];
  requiredManualApprovals: string[];
  decisionDigest: string;
}

export function computeReleaseGatePolicyDigestV1(
  input: ReleaseGatePolicyInputV1,
): `sha256:${string}` {
  return sha256DomainSeparated(GATE_POLICY_DIGEST_DOMAIN, canonicalJsonBytes(input));
}

export function buildReleaseGatePolicyV1(input: ReleaseGatePolicyInputV1): ReleaseGatePolicyV1 {
  return releaseGatePolicyV1Schema.parse({
    ...input,
    policyDigest: computeReleaseGatePolicyDigestV1(input),
  });
}

export function verifyReleaseGatePolicyV1(value: unknown): ReleaseGatePolicyV1 {
  const parsed = releaseGatePolicyV1Schema.parse(value);
  const { policyDigest, ...material } = parsed;
  const expected = computeReleaseGatePolicyDigestV1(material);
  if (policyDigest !== expected) {
    throw new Error(`Release Gate policy digest mismatch: expected ${expected}.`);
  }
  return parsed;
}

export function evaluateReleaseGateV1(input: {
  policy: unknown;
  evidence: unknown;
  artifactIdentity: ReleaseArtifactIdentityV1;
  evaluatedAt: string;
}): ReleaseGateDecisionV1 {
  const policy = verifyReleaseGatePolicyV1(input.policy);
  const evidence = verifyReleaseEvidenceBundleV1(input.evidence);
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
  const requirements = policy.requirements.map((requirement): ReleaseGateDecisionItemV1 => {
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
      result.kind !== 'third_party_security_review' && result.gate !== 'G0' && result.gate !== 'G1';
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

  for (const risk of evidence.risks) {
    if (risk.status === 'open')
      globalReasons.push(`open_${risk.severity.toLowerCase()}_risk:${risk.riskId}`);
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
    schema: 'ReleaseGateDecisionV1' as const,
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
  policy: ReleaseGatePolicyV1;
  evidence: ReleaseEvidenceV1;
  requirement: ReleaseGatePolicyV1['requirements'][number];
  result: ReleaseEvidenceResultV1;
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
  if (result.kind === 'third_party_security_review') {
    if (result.executionIdentity.source !== 'external') {
      reasons.push('security_review_requires_external_identity');
    } else if (result.executionIdentity.reviewerIdentity === SINGLE_MAINTAINER_IDENTITY) {
      reasons.push('security_review_requires_independent_reviewer');
    } else if (
      !TRUSTED_THIRD_PARTY_REVIEWER_IDENTITIES.has(result.executionIdentity.reviewerIdentity)
    ) {
      reasons.push('security_review_trust_root_unconfigured');
    }
    return;
  }
  if (result.executionIdentity.source !== 'github_actions') {
    reasons.push('non_github_execution_identity');
    return;
  }
  const execution = result.executionIdentity;
  if (
    execution.canonicalRepository !== policy.canonicalRepository ||
    execution.repositoryId !== policy.repositoryId ||
    execution.workflowPath !== policy.releaseWorkflowPath ||
    execution.oidcIssuer !== policy.oidcIssuer ||
    execution.workflowSha !== execution.commit ||
    !policy.allowedRefPrefixes.some((prefix) => execution.ref.startsWith(prefix))
  ) {
    reasons.push('github_release_identity_mismatch');
  }
}

function matchingException(
  evidence: ReleaseEvidenceV1,
  result: ReleaseEvidenceResultV1,
  evaluatedAtMs: number,
): ReleaseEvidenceExceptionV1 | undefined {
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
  policy: ReleaseGatePolicyV1,
  requirements: ReleaseGateDecisionItemV1[],
  globalReasons: string[],
): string[] {
  if (policy.mode === 'synthetic_foundation') return [];
  const securityRequirement = policy.requirements.find(
    (requirement) => requirement.kind === 'third_party_security_review',
  );
  const securityDecision = requirements.find(
    (requirement) => requirement.requirementId === securityRequirement?.requirementId,
  );
  return securityDecision?.status === 'passed' && globalReasons.length === 0
    ? []
    : [THIRD_PARTY_SECURITY_APPROVAL];
}

function sameArtifactIdentity(
  left: ReleaseArtifactIdentityV1,
  right: ReleaseArtifactIdentityV1,
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
