import { z } from 'zod';

export const RELEASE_EVIDENCE_SCHEMA = 'ReleaseEvidenceV1' as const;

export const RELEASE_GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type ReleaseGateV1 = (typeof RELEASE_GATES)[number];

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
  'third_party_security_review',
] as const;
export type ReleaseEvidenceKindV1 = (typeof RELEASE_EVIDENCE_KINDS)[number];

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonEmptySchema = z.string().trim().min(1);

export const releaseArtifactIdentityV1Schema = z
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

const githubExecutionIdentityV1Schema = z
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

const localSyntheticExecutionIdentityV1Schema = z
  .object({
    source: z.literal('local_synthetic'),
    fixtureId: nonEmptySchema,
    runner: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const externalExecutionIdentityV1Schema = z
  .object({
    source: z.literal('external'),
    reviewerIdentity: nonEmptySchema,
    recordIdentity: nonEmptySchema,
    commit: commitSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

export const releaseEvidenceExecutionIdentityV1Schema = z.discriminatedUnion('source', [
  githubExecutionIdentityV1Schema,
  localSyntheticExecutionIdentityV1Schema,
  externalExecutionIdentityV1Schema,
]);

export const releaseEvidenceResultV1Schema = z
  .object({
    evidenceId: nonEmptySchema,
    kind: z.enum(RELEASE_EVIDENCE_KINDS),
    gate: z.enum(RELEASE_GATES),
    capability: nonEmptySchema.optional(),
    status: z.enum(['passed', 'failed', 'blocked', 'not_run']),
    artifactIdentity: releaseArtifactIdentityV1Schema,
    executionIdentity: releaseEvidenceExecutionIdentityV1Schema,
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
  });

export const releaseEvidenceRiskV1Schema = z
  .object({
    riskId: nonEmptySchema,
    severity: z.enum(['P0', 'P1', 'P2']),
    status: z.enum(['open', 'mitigated', 'accepted']),
    summary: nonEmptySchema.max(512),
    record: z.object({ uri: z.string().url(), digest: digestSchema }).strict().optional(),
  })
  .strict();

export const releaseEvidenceExceptionV1Schema = z
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

export const releaseEvidenceV1Schema = z
  .object({
    schema: z.literal(RELEASE_EVIDENCE_SCHEMA),
    evidenceBundleId: nonEmptySchema,
    generatedAt: isoTimestampSchema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    nonDistributable: z.boolean(),
    syntheticTrustRoot: z.boolean(),
    results: z.array(releaseEvidenceResultV1Schema),
    risks: z.array(releaseEvidenceRiskV1Schema),
    exceptions: z.array(releaseEvidenceExceptionV1Schema),
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

export type ReleaseArtifactIdentityV1 = z.infer<typeof releaseArtifactIdentityV1Schema>;
export type ReleaseEvidenceExecutionIdentityV1 = z.infer<
  typeof releaseEvidenceExecutionIdentityV1Schema
>;
export type ReleaseEvidenceResultV1 = z.infer<typeof releaseEvidenceResultV1Schema>;
export type ReleaseEvidenceRiskV1 = z.infer<typeof releaseEvidenceRiskV1Schema>;
export type ReleaseEvidenceExceptionV1 = z.infer<typeof releaseEvidenceExceptionV1Schema>;
export type ReleaseEvidenceV1 = z.infer<typeof releaseEvidenceV1Schema>;

export function parseReleaseEvidenceV1(value: unknown): ReleaseEvidenceV1 {
  return releaseEvidenceV1Schema.parse(value);
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
