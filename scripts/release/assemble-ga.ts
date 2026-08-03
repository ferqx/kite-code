import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';
import { type StableCapabilityDecisionV1, validateGaSelectionV1 } from './ga-selection';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const identityFieldSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

export const GA_ASSEMBLY_DEPENDENCIES_V1 = Object.freeze([
  'candidate_decision',
  'artifact_decision',
  'profile_decision',
  'route_decision',
  'cohort_decision',
] as const);

const gaAssemblyCandidateIdentityV1Schema = z
  .object({
    candidateId: identityFieldSchema,
    artifactDigest: digestSchema,
    profileDigest: digestSchema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
  })
  .strict();

export type GAAssemblyCandidateIdentityV1 = z.infer<typeof gaAssemblyCandidateIdentityV1Schema>;

const gaAssemblyDependencyDecisionV1Schema = gaAssemblyCandidateIdentityV1Schema
  .extend({
    schema: z.literal('GAAssemblyDependencyDecisionV1'),
    dependency: z.enum(GA_ASSEMBLY_DEPENDENCIES_V1),
    status: z.literal('passed'),
    selectionDigest: digestSchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    verifiedAt: timestampSchema,
    decisionDigest: digestSchema,
  })
  .strict();

const schemaRollbackReportV1Schema = z
  .object({
    schema: z.literal('ReleaseSchemaRollbackReportV1'),
    status: z.literal('contract_replay_passed'),
    fixtureClass: z.literal('synthetic_contract_only'),
    productionEvidence: z.literal(false),
    durableFactsPreserved: z.literal(true),
    unknownExternalEffectsReplayed: z.literal(0),
    rollbackSchemaRestored: z.literal(true),
    fixtureDigest: digestSchema,
    reportDigest: digestSchema,
  })
  .strict();

const compatibilityReportV1Schema = z
  .object({
    schema: z.literal('GACompatibilityReportV1'),
    fixtureClass: z.literal('synthetic_contract_only'),
    status: z.literal('contract_replay_passed'),
    productionEvidence: z.literal(false),
    durableFactsPreserved: z.literal(true),
    unknownExternalEffectsReplayed: z.literal(0),
    newAdmissionsForDisabledCapabilities: z.literal(0),
    reportDigest: digestSchema,
  })
  .strict();

const rollbackReplayV1Schema = z
  .object({
    schema: z.literal('GAAssemblyRollbackReplayV1'),
    candidate: gaAssemblyCandidateIdentityV1Schema,
    selectionDigest: digestSchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    completedAt: timestampSchema,
    verificationReceiptDigest: digestSchema,
    report: schemaRollbackReportV1Schema,
  })
  .strict();

const compatibilityReplayV1Schema = z
  .object({
    schema: z.literal('GAAssemblyCompatibilityReplayV1'),
    candidate: gaAssemblyCandidateIdentityV1Schema,
    selectionDigest: digestSchema,
    verifierIdentity: z.string().trim().min(1).max(256),
    completedAt: timestampSchema,
    verificationReceiptDigest: digestSchema,
    report: compatibilityReportV1Schema,
  })
  .strict();

const maintainerReviewScopeV1Schema = z.tuple([
  z.literal('candidate'),
  z.literal('artifact'),
  z.literal('profile'),
  z.literal('route'),
  z.literal('cohort'),
  z.literal('selection'),
  z.literal('rollback'),
  z.literal('compatibility'),
]);

const maintainerReviewMaterialV1Schema = z
  .object({
    schema: z.literal('GAAssemblyMaintainerReviewV1'),
    status: z.literal('passed'),
    reviewMode: z.literal('single_maintainer'),
    candidate: gaAssemblyCandidateIdentityV1Schema,
    selectionDigest: digestSchema,
    rollbackReportDigest: digestSchema,
    compatibilityReportDigest: digestSchema,
    scope: maintainerReviewScopeV1Schema,
    releaseOwnerIdentity: z.string().trim().min(1).max(256),
    reviewerIdentity: z.string().trim().min(1).max(256),
    reviewedAt: timestampSchema,
  })
  .strict();

const maintainerReviewV1Schema = maintainerReviewMaterialV1Schema
  .extend({ decisionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { decisionDigest, ...material } = value;
    const expected = computeGaMaintainerReviewDecisionDigestV1(material);
    if (decisionDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['decisionDigest'],
        message: `GA maintainer review digest mismatch: expected ${expected}.`,
      });
    }
  });

export function computeGaMaintainerReviewDecisionDigestV1(material: unknown): `sha256:${string}` {
  const parsed = maintainerReviewMaterialV1Schema.parse(material);
  return sha256DomainSeparated('kite.release.ga-maintainer-review.v1', canonicalJson(parsed));
}

export const gaAssemblyInputV1Schema = z
  .object({
    schema: z.literal('GAAssemblyInputV1'),
    assemblyId: identityFieldSchema,
    assembledAt: timestampSchema,
    candidate: gaAssemblyCandidateIdentityV1Schema,
    selection: z.unknown(),
    stableCapabilityDecisions: z.array(z.unknown()).max(64),
    dependencies: z
      .array(gaAssemblyDependencyDecisionV1Schema)
      .max(GA_ASSEMBLY_DEPENDENCIES_V1.length),
    maintainerReview: maintainerReviewV1Schema.nullable(),
    rollbackReplay: rollbackReplayV1Schema.nullable(),
    compatibilityReplay: compatibilityReplayV1Schema.nullable(),
  })
  .strict();

export interface GAAssemblyDecisionV1 {
  schema: 'GAAssemblyDecisionV1';
  status: 'passed' | 'blocked';
  gaEligible: boolean;
  distributable: boolean;
  bundleWritten: false;
  published: false;
  milestone: null;
  assemblyId: string;
  assembledAt: string;
  candidate: GAAssemblyCandidateIdentityV1;
  selectionDigest: `sha256:${string}`;
  dependencyDecisionDigests: `sha256:${string}`[];
  maintainerReviewDecisionDigest: `sha256:${string}` | null;
  rollbackReportDigest: `sha256:${string}` | null;
  compatibilityReportDigest: `sha256:${string}` | null;
  reasonCodes: string[];
  assemblyDigest: `sha256:${string}`;
}

interface TrustedGAAssemblyAuthorityV1 {
  authorityId: string;
  dependencyVerifierIdentities: readonly string[];
  reviewerIdentities: readonly string[];
  reviewDecisionDigests: readonly string[];
  replayRecords: readonly {
    kind: 'rollback' | 'compatibility';
    verifierIdentity: string;
    verificationReceiptDigest: string;
    candidate: GAAssemblyCandidateIdentityV1;
    selectionDigest: string;
    reportDigest: string;
  }[];
}

const TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1: readonly TrustedGAAssemblyAuthorityV1[] = Object.freeze(
  [],
);

/**
 * Pure GA assembly/replay Gate. It performs no I/O and has no publish path.
 * Production assembly remains impossible until a source-owned authenticated
 * authority registry and verifier are deliberately implemented.
 */
export function evaluateGaAssemblyV1(rawInput: unknown): GAAssemblyDecisionV1 {
  const input = gaAssemblyInputV1Schema.parse(rawInput);
  const validation = validateGaSelectionV1(
    input.selection,
    input.stableCapabilityDecisions as readonly StableCapabilityDecisionV1[],
  );
  const reasons = new Set<string>();
  if (TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.length === 0) {
    reasons.add('authenticated_ga_assembly_authority_not_configured');
  }
  const dependencies = new Map<
    (typeof GA_ASSEMBLY_DEPENDENCIES_V1)[number],
    (typeof input.dependencies)[number]
  >();

  for (const dependency of input.dependencies) {
    if (dependencies.has(dependency.dependency)) {
      throw new Error(`GA assembly dependency ${dependency.dependency} is duplicated.`);
    }
    dependencies.set(dependency.dependency, dependency);
    if (!sameCandidate(dependency, input.candidate)) {
      reasons.add(`dependency_candidate_identity_mismatch:${dependency.dependency}`);
    }
    if (dependency.selectionDigest !== validation.selectionDigest) {
      reasons.add(`dependency_selection_mismatch:${dependency.dependency}`);
    }
  }
  for (const dependency of GA_ASSEMBLY_DEPENDENCIES_V1) {
    if (!dependencies.has(dependency)) reasons.add(`dependency_missing:${dependency}`);
  }
  if (
    TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.length > 0 &&
    input.dependencies.some((dependency) =>
      TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.every(
        (authority) =>
          !authority.dependencyVerifierIdentities.includes(dependency.verifierIdentity),
      ),
    )
  ) {
    reasons.add('ga_dependency_verifier_untrusted');
  }

  if (validation.selection.selectedCapabilities.length === 0) {
    reasons.add('no_stable_capability_selected');
  }
  if (validation.selection.approvedBy.length === 0) reasons.add('selection_approval_missing');

  validateReplayBinding({
    label: 'rollback',
    replay: input.rollbackReplay,
    candidate: input.candidate,
    selectionDigest: validation.selectionDigest,
    reasons,
  });
  validateReplayBinding({
    label: 'compatibility',
    replay: input.compatibilityReplay,
    candidate: input.candidate,
    selectionDigest: validation.selectionDigest,
    reasons,
  });
  if (
    TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.length > 0 &&
    [
      { kind: 'rollback' as const, replay: input.rollbackReplay },
      { kind: 'compatibility' as const, replay: input.compatibilityReplay },
    ].some(
      ({ kind, replay }) =>
        replay &&
        TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.every(
          (authority) =>
            !authority.replayRecords.some(
              (record) =>
                record.kind === kind &&
                record.verifierIdentity === replay.verifierIdentity &&
                record.verificationReceiptDigest === replay.verificationReceiptDigest &&
                sameCandidate(record.candidate, replay.candidate) &&
                record.selectionDigest === replay.selectionDigest &&
                record.reportDigest === replay.report.reportDigest,
            ),
        ),
    )
  ) {
    reasons.add('ga_replay_verifier_untrusted');
  }

  if (!input.maintainerReview) {
    reasons.add('maintainer_security_review_missing');
  } else {
    const review = input.maintainerReview;
    if (!sameCandidate(review.candidate, input.candidate)) {
      reasons.add('maintainer_security_review_candidate_identity_mismatch');
    }
    if (review.selectionDigest !== validation.selectionDigest) {
      reasons.add('maintainer_security_review_selection_mismatch');
    }
    if (
      review.reviewerIdentity !== review.releaseOwnerIdentity ||
      review.reviewerIdentity !== 'github:@ferqx'
    ) {
      reasons.add('maintainer_security_review_identity_mismatch');
    }
    if (
      TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.length > 0 &&
      TRUSTED_GA_ASSEMBLY_AUTHORITIES_V1.every(
        (authority) =>
          !authority.reviewerIdentities.includes(review.reviewerIdentity) ||
          !authority.reviewDecisionDigests.includes(review.decisionDigest),
      )
    ) {
      reasons.add('maintainer_security_reviewer_untrusted');
    }
    const reviewedAt = Date.parse(review.reviewedAt);
    const assembledAt = Date.parse(input.assembledAt);
    const latestDependencyVerification = Math.max(
      ...input.dependencies.map((dependency) => Date.parse(dependency.verifiedAt)),
    );
    if (reviewedAt > assembledAt || assembledAt - reviewedAt > 7 * 24 * 60 * 60 * 1_000) {
      reasons.add('maintainer_security_review_stale');
    }
    if (
      Number.isFinite(latestDependencyVerification) &&
      reviewedAt < latestDependencyVerification
    ) {
      reasons.add('maintainer_security_review_precedes_dependencies');
    }
    const latestReplayCompletion = Math.max(
      ...[input.rollbackReplay, input.compatibilityReplay]
        .filter((replay) => replay !== null)
        .map((replay) => Date.parse(replay.completedAt)),
    );
    if (Number.isFinite(latestReplayCompletion) && reviewedAt < latestReplayCompletion) {
      reasons.add('maintainer_security_review_precedes_replay_verification');
    }
    if (
      !input.rollbackReplay ||
      review.rollbackReportDigest !== input.rollbackReplay.report.reportDigest
    ) {
      reasons.add('maintainer_security_review_rollback_mismatch');
    }
    if (
      !input.compatibilityReplay ||
      review.compatibilityReportDigest !== input.compatibilityReplay.report.reportDigest
    ) {
      reasons.add('maintainer_security_review_compatibility_mismatch');
    }
  }

  const gaEligible = reasons.size === 0;
  const withoutDigest: Omit<GAAssemblyDecisionV1, 'assemblyDigest'> = {
    schema: 'GAAssemblyDecisionV1',
    status: gaEligible ? 'passed' : 'blocked',
    gaEligible,
    distributable: gaEligible,
    bundleWritten: false,
    published: false,
    milestone: null,
    assemblyId: input.assemblyId,
    assembledAt: input.assembledAt,
    candidate: input.candidate,
    selectionDigest: validation.selectionDigest,
    dependencyDecisionDigests: input.dependencies
      .map((dependency) => dependency.decisionDigest as `sha256:${string}`)
      .sort(),
    maintainerReviewDecisionDigest:
      (input.maintainerReview?.decisionDigest as `sha256:${string}` | undefined) ?? null,
    rollbackReportDigest:
      (input.rollbackReplay?.report.reportDigest as `sha256:${string}` | undefined) ?? null,
    compatibilityReportDigest:
      (input.compatibilityReplay?.report.reportDigest as `sha256:${string}` | undefined) ?? null,
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    assemblyDigest: sha256DomainSeparated(
      'kite.release.ga-assembly-decision.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

function validateReplayBinding(input: {
  label: 'rollback' | 'compatibility';
  replay:
    | z.infer<typeof rollbackReplayV1Schema>
    | z.infer<typeof compatibilityReplayV1Schema>
    | null;
  candidate: GAAssemblyCandidateIdentityV1;
  selectionDigest: string;
  reasons: Set<string>;
}): void {
  if (!input.replay) {
    input.reasons.add(`${input.label}_replay_missing`);
    return;
  }
  if (!sameCandidate(input.replay.candidate, input.candidate)) {
    input.reasons.add(`${input.label}_replay_candidate_identity_mismatch`);
  }
  if (input.replay.selectionDigest !== input.selectionDigest) {
    input.reasons.add(`${input.label}_replay_selection_mismatch`);
  }
  // Both accepted schemas above are deliberately synthetic-only contracts.
  // They can exercise binding logic but can never authorize GA distribution.
  if (
    input.replay.report.fixtureClass === 'synthetic_contract_only' ||
    input.replay.report.productionEvidence === false
  ) {
    input.reasons.add(`${input.label}_production_evidence_missing`);
  }
}

function sameCandidate(
  left: GAAssemblyCandidateIdentityV1,
  right: GAAssemblyCandidateIdentityV1,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.artifactDigest === right.artifactDigest &&
    left.profileDigest === right.profileDigest &&
    left.routeDigest === right.routeDigest &&
    left.cohortDigest === right.cohortDigest
  );
}
