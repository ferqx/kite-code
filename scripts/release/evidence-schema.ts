import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';

export const RELEASE_EVIDENCE_SCHEMA = 'ReleaseEvidence' as const;

export const RELEASE_GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type ReleaseGate = (typeof RELEASE_GATES)[number];

export const RELEASE_EVIDENCE_KINDS = [
  'clean_install',
  'required_ci',
  'platform_artifact_smoke',
  'unit_contract',
  'e2e_pty',
  'lint_warning_budget',
  'dependency_audit',
  'license_scan',
  'sbom',
  'provenance',
  'live_route',
  'provider_data_policy',
  'agent_task_suite',
  'compaction_qualification',
  'runtime_soak',
  'execution_conformance',
  'schema_rollback',
  'incident_rehearsal',
  'limited_slo',
  'canary_slo',
  'maintainer_security_review',
] as const;
export type ReleaseEvidenceKind = (typeof RELEASE_EVIDENCE_KINDS)[number];

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonEmptySchema = z.string().trim().min(1);

export const releaseArtifactIdentitySchema = z
  .object({
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    commit: commitSchema,
    payloadSha256: digestSchema,
    canonicalManifestDigest: digestSchema,
    behaviorDigest: digestSchema,
    profileDigest: digestSchema,
    gatePolicyDigest: digestSchema,
  })
  .strict();

const maintainerReviewScopeSchema = z.tuple([
  z.literal('architecture'),
  z.literal('security_boundaries'),
  z.literal('artifact_identity'),
  z.literal('rollback'),
  z.literal('adversarial_bypass'),
]);

const maintainerReviewExecutionSchema = z
  .object({
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    workflowPath: nonEmptySchema,
    workflowRef: nonEmptySchema,
    workflowSha: commitSchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    ref: nonEmptySchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    actorIdentity: nonEmptySchema,
  })
  .strict();

const maintainerSecurityReviewMaterialSchema = z
  .object({
    schema: z.literal('MaintainerSecurityReviewRecord'),
    reviewMode: z.literal('single_maintainer'),
    reviewerIdentity: nonEmptySchema,
    reviewedAt: isoTimestampSchema,
    outcome: z.enum(['passed', 'failed']),
    candidate: releaseArtifactIdentitySchema,
    execution: maintainerReviewExecutionSchema,
    ref: nonEmptySchema,
    trustedVerifierCommit: commitSchema,
    routeIdentity: nonEmptySchema,
    platformIdentity: nonEmptySchema,
    rollbackReportDigest: digestSchema,
    compatibilityReportDigest: digestSchema,
    scope: maintainerReviewScopeSchema,
    unresolvedP0: z.literal(0),
    unresolvedP1: z.literal(0),
    p2Dispositions: z
      .array(
        z
          .object({
            riskId: nonEmptySchema,
            disposition: z.enum(['mitigated', 'accepted']),
            impact: nonEmptySchema.max(512),
            rollbackCondition: nonEmptySchema.max(512),
            recordDigest: digestSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.p2Dispositions.map(({ riskId }) => riskId)).size !== value.p2Dispositions.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['p2Dispositions'],
        message: 'P2 risk dispositions must have unique risk IDs.',
      });
    }
  });

export const maintainerSecurityReviewRecordSchema = maintainerSecurityReviewMaterialSchema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const expected = computeMaintainerSecurityReviewDigest(material);
    if (recordDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: `Maintainer security review digest mismatch: expected ${expected}.`,
      });
    }
  });

export type MaintainerSecurityReviewRecord = z.infer<typeof maintainerSecurityReviewRecordSchema>;
export type MaintainerSecurityReviewMaterial = z.infer<
  typeof maintainerSecurityReviewMaterialSchema
>;

export function computeMaintainerSecurityReviewDigest(
  material: MaintainerSecurityReviewMaterial,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'maintainer-security-review-record-v1',
    canonicalJsonBytes(maintainerSecurityReviewMaterialSchema.parse(material)),
  );
}

export function buildMaintainerSecurityReviewRecord(
  material: MaintainerSecurityReviewMaterial,
): MaintainerSecurityReviewRecord {
  return maintainerSecurityReviewRecordSchema.parse({
    ...material,
    recordDigest: computeMaintainerSecurityReviewDigest(material),
  });
}

const productionReleaseReplayEvidenceMaterialSchema = z
  .object({
    schema: z.literal('ProductionReleaseReplayEvidenceRecord'),
    kind: z.enum(['schema_rollback', 'ga_compatibility']),
    productionEvidence: z.literal(true),
    status: z.literal('passed'),
    candidate: releaseArtifactIdentitySchema,
    completedAt: isoTimestampSchema,
    trustedVerifierCommit: commitSchema,
    reportDigest: digestSchema,
    verificationReceiptDigest: digestSchema,
  })
  .strict();

export const productionReleaseReplayEvidenceRecordSchema =
  productionReleaseReplayEvidenceMaterialSchema
    .extend({ recordDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { recordDigest, ...material } = value;
      const expected = computeProductionReleaseReplayEvidenceDigest(material);
      if (recordDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['recordDigest'],
          message: `Production replay evidence digest mismatch: expected ${expected}.`,
        });
      }
    });

export type ProductionReleaseReplayEvidenceRecord = z.infer<
  typeof productionReleaseReplayEvidenceRecordSchema
>;
export type ProductionReleaseReplayEvidenceMaterial = z.infer<
  typeof productionReleaseReplayEvidenceMaterialSchema
>;

export function computeProductionReleaseReplayEvidenceDigest(
  material: ProductionReleaseReplayEvidenceMaterial,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'production-release-replay-evidence-record-v1',
    canonicalJsonBytes(productionReleaseReplayEvidenceMaterialSchema.parse(material)),
  );
}

export function buildProductionReleaseReplayEvidenceRecord(
  material: ProductionReleaseReplayEvidenceMaterial,
): ProductionReleaseReplayEvidenceRecord {
  return productionReleaseReplayEvidenceRecordSchema.parse({
    ...material,
    recordDigest: computeProductionReleaseReplayEvidenceDigest(material),
  });
}

const githubExecutionIdentitySchema = z
  .object({
    source: z.literal('github_actions'),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    workflowPath: nonEmptySchema,
    workflowRef: nonEmptySchema,
    workflowSha: commitSchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    ref: nonEmptySchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    job: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const localSyntheticExecutionIdentitySchema = z
  .object({
    source: z.literal('local_synthetic'),
    fixtureId: nonEmptySchema,
    runner: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const externalExecutionIdentitySchema = z
  .object({
    source: z.literal('external'),
    reviewerIdentity: nonEmptySchema,
    recordIdentity: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const githubMaintainerReviewExecutionIdentitySchema = z
  .object({
    source: z.literal('github_maintainer_review'),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    workflowPath: nonEmptySchema,
    workflowRef: nonEmptySchema,
    workflowSha: commitSchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    ref: nonEmptySchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    actorIdentity: nonEmptySchema,
    reviewerIdentity: nonEmptySchema,
    recordIdentity: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

export const releaseEvidenceExecutionIdentitySchema = z.discriminatedUnion('source', [
  githubExecutionIdentitySchema,
  localSyntheticExecutionIdentitySchema,
  externalExecutionIdentitySchema,
  githubMaintainerReviewExecutionIdentitySchema,
]);

export const releaseEvidenceResultSchema = z
  .object({
    evidenceId: nonEmptySchema,
    kind: z.enum(RELEASE_EVIDENCE_KINDS),
    gate: z.enum(RELEASE_GATES),
    capability: nonEmptySchema.optional(),
    status: z.enum(['passed', 'failed', 'blocked', 'not_run']),
    artifactIdentity: releaseArtifactIdentitySchema,
    executionIdentity: releaseEvidenceExecutionIdentitySchema,
    routeIdentity: nonEmptySchema.optional(),
    platformIdentity: nonEmptySchema.optional(),
    suiteIdentity: nonEmptySchema,
    record: z
      .object({
        uri: z.string().url(),
        digest: digestSchema,
      })
      .strict(),
    expiresAt: isoTimestampSchema.optional(),
    summary: nonEmptySchema.max(512),
    maintainerReview: maintainerSecurityReviewRecordSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.executionIdentity.commit !== value.artifactIdentity.commit) {
      context.addIssue({
        code: 'custom',
        path: ['executionIdentity', 'commit'],
        message: 'Evidence execution commit must match the artifact identity.',
      });
    }
    if (
      Date.parse(value.executionIdentity.endedAt) < Date.parse(value.executionIdentity.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['executionIdentity', 'endedAt'],
        message: 'Evidence end time cannot precede its start time.',
      });
    }
    if (value.kind === 'maintainer_security_review') {
      const review = value.maintainerReview;
      if (!review) {
        context.addIssue({
          code: 'custom',
          path: ['maintainerReview'],
          message: 'Maintainer security review evidence requires its canonical review record.',
        });
      } else {
        if (!sameArtifactIdentity(review.candidate, value.artifactIdentity)) {
          context.addIssue({
            code: 'custom',
            path: ['maintainerReview', 'candidate'],
            message: 'Maintainer review must bind the exact evidence artifact identity.',
          });
        }
        if (
          review.routeIdentity !== value.routeIdentity ||
          review.platformIdentity !== value.platformIdentity
        ) {
          context.addIssue({
            code: 'custom',
            path: ['maintainerReview'],
            message: 'Maintainer review route and platform must match the evidence result.',
          });
        }
        if (
          value.executionIdentity.source === 'github_maintainer_review' &&
          (review.reviewerIdentity !== value.executionIdentity.reviewerIdentity ||
            review.reviewedAt !== value.executionIdentity.endedAt ||
            review.ref !== value.executionIdentity.ref ||
            review.execution.canonicalRepository !== value.executionIdentity.canonicalRepository ||
            review.execution.repositoryId !== value.executionIdentity.repositoryId ||
            review.execution.workflowPath !== value.executionIdentity.workflowPath ||
            review.execution.workflowRef !== value.executionIdentity.workflowRef ||
            review.execution.workflowSha !== value.executionIdentity.workflowSha ||
            review.execution.oidcIssuer !== value.executionIdentity.oidcIssuer ||
            review.execution.ref !== value.executionIdentity.ref ||
            review.execution.runId !== value.executionIdentity.runId ||
            review.execution.runAttempt !== value.executionIdentity.runAttempt ||
            review.execution.actorIdentity !== value.executionIdentity.actorIdentity)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['maintainerReview'],
            message: 'Maintainer review identity and timestamp must match its execution identity.',
          });
        }
        if (value.record.digest !== review.recordDigest) {
          context.addIssue({
            code: 'custom',
            path: ['record', 'digest'],
            message: 'Maintainer review evidence URI must bind the canonical review digest.',
          });
        }
        const expectedStatus = review.outcome === 'passed' ? 'passed' : 'failed';
        if (value.status !== expectedStatus) {
          context.addIssue({
            code: 'custom',
            path: ['status'],
            message: 'Maintainer review result status must match its canonical record outcome.',
          });
        }
      }
    } else if (value.maintainerReview !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['maintainerReview'],
        message: 'Only maintainer security review evidence may carry a review record.',
      });
    }
  });

export const releaseEvidenceRiskSchema = z
  .object({
    riskId: nonEmptySchema,
    severity: z.enum(['P0', 'P1', 'P2']),
    status: z.enum(['open', 'mitigated', 'accepted']),
    summary: nonEmptySchema.max(512),
    record: z.object({ uri: z.string().url(), digest: digestSchema }).strict().optional(),
  })
  .strict();

export const releaseEvidenceExceptionSchema = z
  .object({
    exceptionId: nonEmptySchema,
    evidenceId: nonEmptySchema,
    gate: z.enum(RELEASE_GATES),
    capability: nonEmptySchema.optional(),
    approvedBy: nonEmptySchema,
    reason: nonEmptySchema.max(512),
    approvedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    record: z.object({ uri: z.string().url(), digest: digestSchema }).strict(),
  })
  .strict();

export const releaseEvidenceSchema = z
  .object({
    schema: z.literal(RELEASE_EVIDENCE_SCHEMA),
    evidenceBundleId: nonEmptySchema,
    generatedAt: isoTimestampSchema,
    artifactIdentity: releaseArtifactIdentitySchema,
    nonDistributable: z.boolean(),
    syntheticTrustRoot: z.boolean(),
    results: z.array(releaseEvidenceResultSchema),
    risks: z.array(releaseEvidenceRiskSchema),
    exceptions: z.array(releaseEvidenceExceptionSchema),
    bundleDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.syntheticTrustRoot && !value.nonDistributable) {
      context.addIssue({
        code: 'custom',
        path: ['nonDistributable'],
        message: 'Synthetic trust roots must remain non-distributable.',
      });
    }
    const evidenceIds = new Set<string>();
    for (const [index, result] of value.results.entries()) {
      if (evidenceIds.has(result.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['results', index, 'evidenceId'],
          message: 'Evidence IDs must be unique.',
        });
      }
      evidenceIds.add(result.evidenceId);
      if (!sameArtifactIdentity(result.artifactIdentity, value.artifactIdentity)) {
        context.addIssue({
          code: 'custom',
          path: ['results', index, 'artifactIdentity'],
          message: 'Every result must bind the exact bundle artifact identity.',
        });
      }
      if (value.syntheticTrustRoot && result.executionIdentity.source !== 'local_synthetic') {
        context.addIssue({
          code: 'custom',
          path: ['results', index, 'executionIdentity', 'source'],
          message: 'Synthetic trust-root bundles accept only local synthetic evidence.',
        });
      }
    }
    for (const [index, exception] of value.exceptions.entries()) {
      if (!evidenceIds.has(exception.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['exceptions', index, 'evidenceId'],
          message: 'Exceptions must reference evidence in the same bundle.',
        });
      }
      if (exception.gate === 'G0' || exception.gate === 'G1') {
        context.addIssue({
          code: 'custom',
          path: ['exceptions', index, 'gate'],
          message: 'G0 and G1 cannot be waived.',
        });
      }
      if (Date.parse(exception.expiresAt) <= Date.parse(exception.approvedAt)) {
        context.addIssue({
          code: 'custom',
          path: ['exceptions', index, 'expiresAt'],
          message: 'Exception expiry must be after approval.',
        });
      }
    }
  });

export type ReleaseArtifactIdentity = z.infer<typeof releaseArtifactIdentitySchema>;
export type ReleaseEvidenceExecutionIdentity = z.infer<
  typeof releaseEvidenceExecutionIdentitySchema
>;
export type ReleaseEvidenceResult = z.infer<typeof releaseEvidenceResultSchema>;
export type ReleaseEvidenceRisk = z.infer<typeof releaseEvidenceRiskSchema>;
export type ReleaseEvidenceException = z.infer<typeof releaseEvidenceExceptionSchema>;
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

export function parseReleaseEvidence(value: unknown): ReleaseEvidence {
  return releaseEvidenceSchema.parse(value);
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
