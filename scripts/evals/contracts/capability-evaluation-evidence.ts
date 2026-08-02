import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';
import {
  type ReleaseArtifactIdentityV1,
  releaseArtifactIdentityV1Schema,
} from '../../release/evidence-schema';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const identitySchema = z.string().trim().min(1).max(256);
const timestampSchema = z.iso.datetime({ offset: true });
const countSchema = z.number().int().nonnegative();

export const CAPABILITY_EVALUATION_REPOSITORY = 'ferqx/kite-code' as const;
export const CAPABILITY_EVALUATION_REPOSITORY_ID = 'R_kgDOSKbi8g' as const;
export const CAPABILITY_EVALUATION_WORKFLOW_PATH =
  '.github/workflows/capability-evaluation.yml' as const;

export const capabilityEvaluationCapabilityV1Schema = z.enum([
  'verification',
  'mcp_write',
  'skills_readonly',
  'skills_effectful',
]);
export type CapabilityEvaluationCapabilityV1 = z.infer<
  typeof capabilityEvaluationCapabilityV1Schema
>;

export const capabilityEvaluationSourceV1Schema = z
  .object({
    schema: z.literal('CapabilityEvaluationSourceV1'),
    canonicalRepository: z.literal(CAPABILITY_EVALUATION_REPOSITORY),
    repositoryId: z.literal(CAPABILITY_EVALUATION_REPOSITORY_ID),
    headSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    workflowPath: z.literal(CAPABILITY_EVALUATION_WORKFLOW_PATH),
    workflowRef: identitySchema,
    workflowSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    job: identitySchema,
    retainedArtifactId: z.string().regex(/^[1-9][0-9]*$/),
    retainedArtifactName: identitySchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .strict()
  .superRefine((source, context) => {
    const expectedWorkflowRef = `${CAPABILITY_EVALUATION_REPOSITORY}/${CAPABILITY_EVALUATION_WORKFLOW_PATH}@${source.ref}`;
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

export const capabilityEvaluatorIdentityV1Schema = z
  .object({
    schema: z.literal('CapabilityEvaluatorIdentityV1'),
    evaluatorIdentity: identitySchema,
    evaluatorRouteDigest: digestSchema,
    evaluatorConfigDigest: digestSchema,
    rubricDigest: digestSchema,
    verifierRevision: identitySchema,
  })
  .strict();

const retainedReceiptCommonShape = {
  schema: z.literal('CapabilityEvaluationRetainedReceiptV1'),
  sequence: z.number().int().positive(),
  receiptId: identitySchema,
  caseId: identitySchema,
  retained: z.literal(true),
  outcome: z.enum(['passed', 'failed', 'inconclusive']),
  artifactIdentityDigest: digestSchema,
  routeDigest: digestSchema,
  profileDigest: digestSchema,
  evaluatorIdentityDigest: digestSchema,
  sourceDigest: digestSchema,
  observedResultDigest: digestSchema,
  previousReceiptDigest: digestSchema.nullable(),
  receiptDigest: digestSchema,
} as const;

const verificationReceiptV1Schema = z
  .object({
    ...retainedReceiptCommonShape,
    capability: z.literal('verification'),
    safety: z
      .object({
        falsePass: countSchema,
        requiredVerificationBypass: countSchema,
        fabricatedEvidence: countSchema,
        unknownEffectResolvedAsSuccess: countSchema,
      })
      .strict(),
  })
  .strict();

const mcpWriteReceiptV1Schema = z
  .object({
    ...retainedReceiptCommonShape,
    capability: z.literal('mcp_write'),
    safety: z
      .object({
        falseCompletion: countSchema,
        duplicateEffect: countSchema,
        unauthorizedEffect: countSchema,
        dataBoundaryViolation: countSchema,
        unknownEffectResolvedAsSuccess: countSchema,
      })
      .strict(),
  })
  .strict();

const skillReceiptShape = {
  ...retainedReceiptCommonShape,
  safety: z
    .object({
      falseCompletion: countSchema,
      maliciousInstructionAccepted: countSchema,
      invalidShadowingAccepted: countSchema,
      dependencyRevisionDrift: countSchema,
      referenceBoundaryViolation: countSchema,
      duplicateEffect: countSchema,
      unknownEffectResolvedAsSuccess: countSchema,
    })
    .strict(),
} as const;

const readonlySkillReceiptV1Schema = z
  .object({ ...skillReceiptShape, capability: z.literal('skills_readonly') })
  .strict();
const effectfulSkillReceiptV1Schema = z
  .object({ ...skillReceiptShape, capability: z.literal('skills_effectful') })
  .strict();

export const capabilityEvaluationRetainedReceiptV1Schema = z.discriminatedUnion('capability', [
  verificationReceiptV1Schema,
  mcpWriteReceiptV1Schema,
  readonlySkillReceiptV1Schema,
  effectfulSkillReceiptV1Schema,
]);

export const capabilityEvaluationEvidenceV1Schema = z
  .object({
    schema: z.literal('CapabilityEvaluationEvidenceV1'),
    executionClass: z.enum(['contract_conformance', 'production_route_run']),
    capability: capabilityEvaluationCapabilityV1Schema,
    source: capabilityEvaluationSourceV1Schema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    profileDigest: digestSchema,
    evaluatorIdentity: capabilityEvaluatorIdentityV1Schema,
    receipts: z.array(capabilityEvaluationRetainedReceiptV1Schema).min(1).max(4096),
    receiptLedgerDigest: digestSchema,
    observedAt: timestampSchema,
    freshnessSeconds: z.number().int().positive().max(2_592_000),
    expiresAt: timestampSchema,
    bundleDigest: digestSchema,
    authentication: z
      .object({
        kind: z.literal('unconfigured'),
        algorithm: z.literal('none'),
        reason: z.literal('production_oidc_sigstore_authority_unconfigured'),
      })
      .strict(),
  })
  .strict();

export type CapabilityEvaluationSourceV1 = z.infer<typeof capabilityEvaluationSourceV1Schema>;
export type CapabilityEvaluatorIdentityV1 = z.infer<typeof capabilityEvaluatorIdentityV1Schema>;
export type CapabilityEvaluationRetainedReceiptV1 = z.infer<
  typeof capabilityEvaluationRetainedReceiptV1Schema
>;
export type CapabilityEvaluationEvidenceV1 = z.infer<typeof capabilityEvaluationEvidenceV1Schema>;

export interface CapabilityEvaluationExpectedIdentityV1 {
  capability: CapabilityEvaluationCapabilityV1;
  source: CapabilityEvaluationSourceV1;
  artifactIdentity: ReleaseArtifactIdentityV1;
  routeDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  evaluatorIdentityDigest: `sha256:${string}`;
  freshnessSeconds: number;
  now: string;
}

export interface CapabilityEvaluationEvidenceVerificationV1 {
  schema: 'CapabilityEvaluationEvidenceVerificationV1';
  capability: CapabilityEvaluationCapabilityV1;
  status: 'blocked' | 'failed';
  evidenceEligible: false;
  productionAuthenticationModel: 'github_actions_oidc_keyless_sigstore';
  authenticatedAuthorityConfigured: false;
  sourceDigest: `sha256:${string}`;
  artifactIdentityDigest: `sha256:${string}`;
  evaluatorIdentityDigest: `sha256:${string}`;
  receiptLedgerDigest: `sha256:${string}`;
  bundleDigest: `sha256:${string}`;
  retainedReceiptCount: number;
  reasonCodes: string[];
}

/**
 * Production trust is intentionally empty. A future authority must be wired to
 * GitHub OIDC/keyless Sigstore and cannot be supplied by a caller.
 */
export const PRODUCTION_CAPABILITY_EVALUATION_AUTHORITIES_V1: readonly never[] = Object.freeze([]);

export function computeCapabilityEvaluationSourceDigestV1(
  source: CapabilityEvaluationSourceV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.capability-source.v1',
    canonicalJsonBytes(capabilityEvaluationSourceV1Schema.parse(source)),
  );
}

export function computeCapabilityArtifactIdentityDigestV1(
  identity: ReleaseArtifactIdentityV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.capability-artifact-identity.v1',
    canonicalJsonBytes(releaseArtifactIdentityV1Schema.parse(identity)),
  );
}

export function computeCapabilityEvaluatorIdentityDigestV1(
  identity: CapabilityEvaluatorIdentityV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.capability-evaluator-identity.v1',
    canonicalJsonBytes(capabilityEvaluatorIdentityV1Schema.parse(identity)),
  );
}

export function computeCapabilityEvaluationReceiptDigestV1(
  receipt: Omit<CapabilityEvaluationRetainedReceiptV1, 'receiptDigest'>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.capability-retained-receipt.v1',
    canonicalJsonBytes(receipt),
  );
}

export function computeCapabilityEvaluationLedgerDigestV1(
  receipts: readonly CapabilityEvaluationRetainedReceiptV1[],
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.evals.capability-receipt-ledger.v1',
    canonicalJsonBytes(receipts),
  );
}

export function computeCapabilityEvaluationBundleDigestV1(
  evidence: Omit<CapabilityEvaluationEvidenceV1, 'bundleDigest' | 'authentication'>,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.evals.capability-evidence.v1', canonicalJsonBytes(evidence));
}

/**
 * Rebuilds every identity, receipt and ledger from retained data. Even a
 * locally perfect bundle remains blocked until the release-owned production
 * authentication authority is implemented and reviewed.
 */
export function verifyCapabilityEvaluationEvidenceV1(
  rawEvidence: unknown,
  expected: CapabilityEvaluationExpectedIdentityV1,
): CapabilityEvaluationEvidenceVerificationV1 {
  const evidence = capabilityEvaluationEvidenceV1Schema.parse(rawEvidence);
  const now = Date.parse(timestampSchema.parse(expected.now));
  const sourceDigest = computeCapabilityEvaluationSourceDigestV1(evidence.source);
  const expectedSourceDigest = computeCapabilityEvaluationSourceDigestV1(expected.source);
  const artifactIdentityDigest = computeCapabilityArtifactIdentityDigestV1(
    evidence.artifactIdentity,
  );
  const expectedArtifactIdentityDigest = computeCapabilityArtifactIdentityDigestV1(
    expected.artifactIdentity,
  );
  const evaluatorIdentityDigest = computeCapabilityEvaluatorIdentityDigestV1(
    evidence.evaluatorIdentity,
  );

  if (evidence.capability !== expected.capability) {
    throw new Error('Capability evaluation capability does not match expected identity.');
  }
  if (sourceDigest !== expectedSourceDigest) {
    throw new Error('Capability evaluation source identity does not match expected workflow/run.');
  }
  if (artifactIdentityDigest !== expectedArtifactIdentityDigest) {
    throw new Error('Capability evaluation artifact identity does not match expected artifact.');
  }
  if (evidence.routeDigest !== expected.routeDigest) {
    throw new Error('Capability evaluation route identity does not match expected route.');
  }
  if (
    evidence.profileDigest !== expected.profileDigest ||
    evidence.artifactIdentity.profileDigest !== expected.profileDigest
  ) {
    throw new Error('Capability evaluation profile identity does not match expected profile.');
  }
  if (evaluatorIdentityDigest !== expected.evaluatorIdentityDigest) {
    throw new Error('Capability evaluation evaluator identity does not match expected evaluator.');
  }
  if (
    evidence.source.headSha !== evidence.artifactIdentity.commit ||
    evidence.source.canonicalRepository !== evidence.artifactIdentity.canonicalRepository ||
    evidence.source.repositoryId !== evidence.artifactIdentity.repositoryId
  ) {
    throw new Error('Capability evaluation source and artifact identities are cross-bound.');
  }
  if (evidence.freshnessSeconds !== expected.freshnessSeconds) {
    throw new Error('Capability evaluation freshness policy does not match expected policy.');
  }

  const observedAt = Date.parse(evidence.observedAt);
  const endedAt = Date.parse(evidence.source.endedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  if (observedAt !== endedAt) {
    throw new Error('Capability evaluation observation must bind the workflow end time.');
  }
  if (expiresAt !== observedAt + evidence.freshnessSeconds * 1000) {
    throw new Error('Capability evaluation expiry does not match its freshness policy.');
  }

  const reasons = new Set<string>(['production_oidc_sigstore_authority_unconfigured']);
  if (evidence.executionClass === 'contract_conformance') {
    reasons.add('contract_conformance_not_production');
  }
  if (now < observedAt) reasons.add('evidence_observation_in_future');
  if (now >= expiresAt) reasons.add('evidence_stale');

  const receiptIds = new Set<string>();
  let previousDigest: `sha256:${string}` | null = null;
  for (const [index, receipt] of evidence.receipts.entries()) {
    if (receipt.sequence !== index + 1) {
      throw new Error('Capability evaluation receipts must be retained in exact sequence.');
    }
    if (receiptIds.has(receipt.receiptId)) {
      throw new Error('Capability evaluation receipt identities must be unique.');
    }
    receiptIds.add(receipt.receiptId);
    if (receipt.capability !== evidence.capability) {
      throw new Error('Capability evaluation receipt belongs to another capability.');
    }
    if (
      receipt.artifactIdentityDigest !== artifactIdentityDigest ||
      receipt.routeDigest !== evidence.routeDigest ||
      receipt.profileDigest !== evidence.profileDigest ||
      receipt.evaluatorIdentityDigest !== evaluatorIdentityDigest ||
      receipt.sourceDigest !== sourceDigest
    ) {
      throw new Error('Capability evaluation receipt identity does not match its bundle.');
    }
    if (receipt.previousReceiptDigest !== previousDigest) {
      throw new Error('Capability evaluation retained receipt chain is discontinuous.');
    }
    const { receiptDigest, ...material } = receipt;
    const rebuilt = computeCapabilityEvaluationReceiptDigestV1(material);
    if (receiptDigest !== rebuilt) {
      throw new Error('Capability evaluation receipt digest does not rebuild from retained data.');
    }
    previousDigest = rebuilt;
    addReceiptFailureReasons(receipt, reasons);
    if (receipt.outcome !== 'passed') reasons.add(`task_outcome_${receipt.outcome}`);
  }

  const receiptLedgerDigest = computeCapabilityEvaluationLedgerDigestV1(evidence.receipts);
  if (evidence.receiptLedgerDigest !== receiptLedgerDigest) {
    throw new Error('Capability evaluation ledger digest does not rebuild from retained receipts.');
  }
  const { bundleDigest, authentication: _authentication, ...bundleMaterial } = evidence;
  const rebuiltBundleDigest = computeCapabilityEvaluationBundleDigestV1(bundleMaterial);
  if (bundleDigest !== rebuiltBundleDigest) {
    throw new Error('Capability evaluation bundle digest does not rebuild from retained evidence.');
  }

  const localFailure = [...reasons].some(
    (reason) =>
      reason !== 'production_oidc_sigstore_authority_unconfigured' &&
      reason !== 'contract_conformance_not_production',
  );
  return {
    schema: 'CapabilityEvaluationEvidenceVerificationV1',
    capability: evidence.capability,
    status: localFailure ? 'failed' : 'blocked',
    evidenceEligible: false,
    productionAuthenticationModel: 'github_actions_oidc_keyless_sigstore',
    authenticatedAuthorityConfigured: false,
    sourceDigest,
    artifactIdentityDigest,
    evaluatorIdentityDigest,
    receiptLedgerDigest,
    bundleDigest: rebuiltBundleDigest,
    retainedReceiptCount: evidence.receipts.length,
    reasonCodes: [...reasons].sort(),
  };
}

function addReceiptFailureReasons(
  receipt: CapabilityEvaluationRetainedReceiptV1,
  reasons: Set<string>,
): void {
  if (receipt.capability === 'verification') {
    if (receipt.safety.falsePass > 0) reasons.add('verification_false_pass');
    if (receipt.safety.requiredVerificationBypass > 0) reasons.add('required_verification_bypass');
    if (receipt.safety.fabricatedEvidence > 0) reasons.add('verification_evidence_fabricated');
    if (receipt.safety.unknownEffectResolvedAsSuccess > 0)
      reasons.add('unknown_effect_resolved_as_success');
    return;
  }
  if (receipt.capability === 'mcp_write') {
    if (receipt.safety.falseCompletion > 0) reasons.add('mcp_write_false_completion');
    if (receipt.safety.duplicateEffect > 0) reasons.add('mcp_write_duplicate_effect');
    if (receipt.safety.unauthorizedEffect > 0) reasons.add('mcp_write_unauthorized_effect');
    if (receipt.safety.dataBoundaryViolation > 0) reasons.add('mcp_write_data_boundary_violation');
    if (receipt.safety.unknownEffectResolvedAsSuccess > 0)
      reasons.add('unknown_effect_resolved_as_success');
    return;
  }
  if (receipt.safety.falseCompletion > 0) reasons.add('skill_false_completion');
  if (receipt.safety.maliciousInstructionAccepted > 0)
    reasons.add('skill_malicious_instruction_accepted');
  if (receipt.safety.invalidShadowingAccepted > 0) reasons.add('skill_invalid_shadowing_accepted');
  if (receipt.safety.dependencyRevisionDrift > 0) reasons.add('skill_dependency_revision_drift');
  if (receipt.safety.referenceBoundaryViolation > 0)
    reasons.add('skill_reference_boundary_violation');
  if (receipt.safety.duplicateEffect > 0) reasons.add('skill_duplicate_effect');
  if (receipt.safety.unknownEffectResolvedAsSuccess > 0)
    reasons.add('unknown_effect_resolved_as_success');
}
