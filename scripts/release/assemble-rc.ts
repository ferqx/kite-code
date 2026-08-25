import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';
import { releaseArtifactIdentitySchema } from './evidence-schema';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const RC_DEPENDENCIES_ = Object.freeze([
  'ms_1a_done',
  'ms_1b_done',
  'ms_1c_done',
  'ms_2b_done',
  'ms_3_ops_ready',
  'task_2a8_supply_chain',
  'task_2a10_docs',
  'gate_replay',
  'schema_rollback',
  'maintainer_security_review',
] as const);

export const RC_CRITICAL_INPUTS_ = Object.freeze([
  'detached_manifest',
  'evidence_bundle',
  'release_gate_decision',
  'supply_chain_verification',
  'gate_replay',
  'schema_rollback_report',
] as const);

const rcDependencyDecisionSchema = z
  .object({
    schema: z.literal('ReleaseCandidateDependencyDecision'),
    dependency: z.enum(RC_DEPENDENCIES_),
    status: z.literal('passed'),
    artifactIdentity: releaseArtifactIdentitySchema,
    verifiedAt: timestampSchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    decisionDigest: digestSchema,
    attestationDigest: digestSchema,
  })
  .strict();

const rcCriticalInputVerificationSchema = z
  .object({
    schema: z.literal('ReleaseCandidateCriticalInputVerification'),
    kind: z.enum(RC_CRITICAL_INPUTS_),
    digest: digestSchema,
    artifactIdentity: releaseArtifactIdentitySchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    verificationReceiptDigest: digestSchema,
    verifiedAt: timestampSchema,
  })
  .strict();

export const releaseCandidateAssemblyInputSchema = z
  .object({
    schema: z.literal('ReleaseCandidateAssemblyInput'),
    candidateId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    artifactIdentity: releaseArtifactIdentitySchema,
    detachedManifestDigest: digestSchema,
    evidenceBundleDigest: digestSchema,
    releaseGateDecisionDigest: digestSchema,
    supplyChainVerificationDigest: digestSchema,
    gateReplayDigest: digestSchema,
    schemaRollbackReportDigest: digestSchema,
    criticalInputs: z.array(rcCriticalInputVerificationSchema).max(RC_CRITICAL_INPUTS_.length),
    dependencies: z.array(rcDependencyDecisionSchema).max(RC_DEPENDENCIES_.length),
  })
  .strict();

export type ReleaseCandidateAssemblyInput = z.infer<typeof releaseCandidateAssemblyInputSchema>;

interface TrustedReleaseCandidateVerifier {
  dependency: (typeof RC_DEPENDENCIES_)[number];
  verifierIdentity: string;
  decisionDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  artifactIdentityDigest: `sha256:${string}`;
  verifiedAt: string;
}

const TRUSTED_RELEASE_CANDIDATE_VERIFIERS_: readonly TrustedReleaseCandidateVerifier[] =
  Object.freeze([]);

interface TrustedReleaseCandidateCriticalInput {
  kind: (typeof RC_CRITICAL_INPUTS_)[number];
  digest: `sha256:${string}`;
  verifierIdentity: string;
  verificationReceiptDigest: `sha256:${string}`;
  artifactIdentityDigest: `sha256:${string}`;
  verifiedAt: string;
}

const TRUSTED_RELEASE_CANDIDATE_CRITICAL_INPUTS_: readonly TrustedReleaseCandidateCriticalInput[] =
  Object.freeze([]);

export interface ReleaseCandidateAssemblyDecision {
  schema: 'ReleaseCandidateAssemblyDecision';
  status: 'passed' | 'blocked';
  candidateEligible: boolean;
  distributable: boolean;
  bundleWritten: false;
  milestone: 'MS:2A-RC' | null;
  candidateId: string;
  artifactIdentity: z.infer<typeof releaseArtifactIdentitySchema>;
  criticalInputDigests: Array<{
    kind: (typeof RC_CRITICAL_INPUTS_)[number];
    digest: `sha256:${string}`;
    verifierIdentity: string;
    verificationReceiptDigest: `sha256:${string}`;
    verifiedAt: string;
  }>;
  dependencyDecisionDigests: `sha256:${string}`[];
  reasonCodes: string[];
  assemblyDigest: `sha256:${string}`;
}

/**
 * Pure assembly Gate. It never writes or publishes a bundle. A reviewed
 * production attestation verifier must first be added to the source-owned
 * registry before this evaluator may gain a passed variant. The lookup path is
 * implemented here; the source-owned registry is currently empty.
 */
export function evaluateReleaseCandidateAssembly(
  rawInput: unknown,
): ReleaseCandidateAssemblyDecision {
  const input = releaseCandidateAssemblyInputSchema.parse(rawInput);
  const reasons = new Set<string>();
  if (TRUSTED_RELEASE_CANDIDATE_VERIFIERS_.length === 0) {
    reasons.add('authenticated_rc_assembly_authority_not_configured');
  }
  if (TRUSTED_RELEASE_CANDIDATE_CRITICAL_INPUTS_.length === 0) {
    reasons.add('authenticated_rc_critical_input_authority_not_configured');
  }
  const artifactIdentityDigest = sha256DomainSeparated(
    'kite.release.rc-artifact-identity.v1',
    canonicalJson(input.artifactIdentity),
  );
  const dependencies = new Map<string, (typeof input.dependencies)[number]>();
  for (const dependency of input.dependencies) {
    if (dependencies.has(dependency.dependency)) {
      throw new Error(`RC dependency ${dependency.dependency} is duplicated.`);
    }
    dependencies.set(dependency.dependency, dependency);
    if (
      TRUSTED_RELEASE_CANDIDATE_VERIFIERS_.length > 0 &&
      !TRUSTED_RELEASE_CANDIDATE_VERIFIERS_.some(
        (trusted) =>
          trusted.dependency === dependency.dependency &&
          trusted.verifierIdentity === dependency.verifierIdentity &&
          trusted.decisionDigest === dependency.decisionDigest &&
          trusted.attestationDigest === dependency.attestationDigest &&
          trusted.artifactIdentityDigest === artifactIdentityDigest &&
          trusted.verifiedAt === dependency.verifiedAt,
      )
    ) {
      reasons.add(`dependency_verifier_untrusted:${dependency.dependency}`);
    }
    if (canonicalJson(dependency.artifactIdentity) !== canonicalJson(input.artifactIdentity)) {
      reasons.add(`dependency_artifact_identity_mismatch:${dependency.dependency}`);
    }
  }
  for (const dependency of RC_DEPENDENCIES_) {
    if (!dependencies.has(dependency)) reasons.add(`dependency_missing:${dependency}`);
  }
  const expectedCriticalDigests: Record<(typeof RC_CRITICAL_INPUTS_)[number], string> = {
    detached_manifest: input.detachedManifestDigest,
    evidence_bundle: input.evidenceBundleDigest,
    release_gate_decision: input.releaseGateDecisionDigest,
    supply_chain_verification: input.supplyChainVerificationDigest,
    gate_replay: input.gateReplayDigest,
    schema_rollback_report: input.schemaRollbackReportDigest,
  };
  const criticalInputs = new Map<
    (typeof RC_CRITICAL_INPUTS_)[number],
    (typeof input.criticalInputs)[number]
  >();
  for (const criticalInput of input.criticalInputs) {
    if (criticalInputs.has(criticalInput.kind)) {
      throw new Error(`RC critical input ${criticalInput.kind} is duplicated.`);
    }
    criticalInputs.set(criticalInput.kind, criticalInput);
    if (criticalInput.digest !== expectedCriticalDigests[criticalInput.kind]) {
      reasons.add(`critical_input_digest_mismatch:${criticalInput.kind}`);
    }
    if (canonicalJson(criticalInput.artifactIdentity) !== canonicalJson(input.artifactIdentity)) {
      reasons.add(`critical_input_artifact_identity_mismatch:${criticalInput.kind}`);
    }
    if (
      TRUSTED_RELEASE_CANDIDATE_CRITICAL_INPUTS_.length > 0 &&
      !TRUSTED_RELEASE_CANDIDATE_CRITICAL_INPUTS_.some(
        (trusted) =>
          trusted.kind === criticalInput.kind &&
          trusted.digest === criticalInput.digest &&
          trusted.verifierIdentity === criticalInput.verifierIdentity &&
          trusted.verificationReceiptDigest === criticalInput.verificationReceiptDigest &&
          trusted.artifactIdentityDigest === artifactIdentityDigest &&
          trusted.verifiedAt === criticalInput.verifiedAt,
      )
    ) {
      reasons.add(`critical_input_verifier_untrusted:${criticalInput.kind}`);
    }
  }
  for (const kind of RC_CRITICAL_INPUTS_) {
    if (!criticalInputs.has(kind)) reasons.add(`critical_input_missing:${kind}`);
  }
  const candidateEligible = reasons.size === 0;
  const withoutDigest: Omit<ReleaseCandidateAssemblyDecision, 'assemblyDigest'> = {
    schema: 'ReleaseCandidateAssemblyDecision',
    status: candidateEligible ? 'passed' : 'blocked',
    candidateEligible,
    distributable: candidateEligible,
    bundleWritten: false,
    milestone: candidateEligible ? 'MS:2A-RC' : null,
    candidateId: input.candidateId,
    artifactIdentity: input.artifactIdentity,
    criticalInputDigests: input.criticalInputs
      .map((entry) => ({
        kind: entry.kind,
        digest: entry.digest as `sha256:${string}`,
        verifierIdentity: entry.verifierIdentity,
        verificationReceiptDigest: entry.verificationReceiptDigest as `sha256:${string}`,
        verifiedAt: entry.verifiedAt,
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    dependencyDecisionDigests: input.dependencies
      .map((dependency) => dependency.decisionDigest as `sha256:${string}`)
      .sort(),
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    assemblyDigest: sha256DomainSeparated(
      'kite.release.rc-assembly-decision.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
