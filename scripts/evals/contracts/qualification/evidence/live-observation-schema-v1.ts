import { z } from 'zod';
import { isRegisteredQualificationLocalSyntheticExecutionV1 } from '../../../../../release/qualification/evidence/source-owned-execution-registry-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  releaseArtifactIdentityV1Schema,
  releaseEvidenceExecutionIdentityV1Schema,
} from '../../../../release/evidence-identity-primitives';
import {
  type EvidenceGovernanceBindingV1,
  evidenceGovernanceBindingV1Schema,
} from './governance-v1';
import {
  isQualificationSafeIdentifierV1,
  isQualificationSafeMetadataValueV1,
} from './metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_PLATFORM = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_ROUTE_ALIAS = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CANONICAL_REPOSITORY =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SAFE_REPOSITORY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'diagnostic identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });
const platformIdentitySchema = z.string().regex(SAFE_PLATFORM);
const isoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * Closed vocabulary shared by diagnostic records.  This remains local to the
 * evidence contract so the live runner never needs the feature-Matrix module
 * (or any application-owned public surface) merely to parse an observation.
 */
export const LIVE_OBSERVATION_ENTRYPOINTS_V1 = [
  'tui',
  'cli',
  'installer',
  'runtime',
  'any',
] as const;
export type LiveObservationEntrypointV1 = (typeof LIVE_OBSERVATION_ENTRYPOINTS_V1)[number];

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

export const diagnosticCandidateArtifactSlotV1Schema = z
  .object({
    platformIdentity: platformIdentitySchema,
    artifact: releaseArtifactIdentityV1Schema,
  })
  .strict();

export type DiagnosticCandidateArtifactSlotV1 = z.infer<
  typeof diagnosticCandidateArtifactSlotV1Schema
>;

const diagnosticCandidateArtifactClosureMaterialV1Schema = z
  .object({
    schema: z.literal('DiagnosticCandidateArtifactClosureV1'),
    version: z.literal(1),
    artifacts: z.array(diagnosticCandidateArtifactSlotV1Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const platforms = value.artifacts.map((artifact) => artifact.platformIdentity);
    if (!codePointSortedUnique(platforms)) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'candidate artifacts must be code-point sorted and unique by platform identity',
      });
    }
    const first = value.artifacts[0]?.artifact;
    if (!first) return;
    for (const [index, { artifact }] of value.artifacts.entries()) {
      if (
        !SAFE_CANONICAL_REPOSITORY.test(artifact.canonicalRepository) ||
        !SAFE_REPOSITORY_ID.test(artifact.repositoryId) ||
        !isQualificationSafeMetadataValueV1(artifact.canonicalRepository) ||
        !isQualificationSafeMetadataValueV1(artifact.repositoryId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index, 'artifact'],
          message: 'candidate artifact identity contains unsafe metadata',
        });
      }
      for (const field of [
        'canonicalRepository',
        'repositoryId',
        'commit',
        'behaviorDigest',
        'profileDigest',
        'gatePolicyDigest',
      ] as const) {
        if (artifact[field] !== first[field]) {
          context.addIssue({
            code: 'custom',
            path: ['artifacts', index, 'artifact', field],
            message: 'candidate artifact lineage must agree across all platforms',
          });
        }
      }
    }
  });

export type DiagnosticCandidateArtifactClosureMaterialV1 = z.infer<
  typeof diagnosticCandidateArtifactClosureMaterialV1Schema
>;

export function computeDiagnosticCandidateArtifactClosureDigestV1(
  material: DiagnosticCandidateArtifactClosureMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.candidate-artifact-closure.v1',
    canonicalJsonBytes(diagnosticCandidateArtifactClosureMaterialV1Schema.parse(material)),
  );
}

export const diagnosticCandidateArtifactClosureV1Schema =
  diagnosticCandidateArtifactClosureMaterialV1Schema
    .extend({ closureDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { closureDigest, ...material } = value;
      const expected = computeDiagnosticCandidateArtifactClosureDigestV1(material);
      if (closureDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['closureDigest'],
          message: `candidate closure digest mismatch: expected ${expected}`,
        });
      }
    });

export type DiagnosticCandidateArtifactClosureV1 = z.infer<
  typeof diagnosticCandidateArtifactClosureV1Schema
>;

export function buildDiagnosticCandidateArtifactClosureV1(
  material: DiagnosticCandidateArtifactClosureMaterialV1,
): DiagnosticCandidateArtifactClosureV1 {
  const parsed = diagnosticCandidateArtifactClosureMaterialV1Schema.parse(material);
  return diagnosticCandidateArtifactClosureV1Schema.parse({
    ...parsed,
    closureDigest: computeDiagnosticCandidateArtifactClosureDigestV1(parsed),
  });
}

function executionMetadataIssues(
  identity: z.infer<typeof releaseEvidenceExecutionIdentityV1Schema>,
): string[] {
  const values = (() => {
    switch (identity.source) {
      case 'github_actions':
        return [
          identity.canonicalRepository,
          identity.repositoryId,
          identity.workflowPath,
          identity.workflowRef,
          identity.ref,
          identity.job,
        ];
      case 'local_synthetic':
        return [identity.fixtureId, identity.runner];
      case 'external':
        return [identity.reviewerIdentity, identity.recordIdentity];
      case 'github_maintainer_review':
        return [
          identity.canonicalRepository,
          identity.repositoryId,
          identity.workflowPath,
          identity.workflowRef,
          identity.ref,
          identity.actorIdentity,
          identity.reviewerIdentity,
          identity.recordIdentity,
        ];
    }
  })();
  return values.filter((value) => !isQualificationSafeMetadataValueV1(value));
}

const diagnosticExecutionMaterialV1Schema = z
  .object({
    executionId: safeIdentifierSchema,
    platformIdentity: platformIdentitySchema,
    identity: releaseEvidenceExecutionIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.identity.source === 'local_synthetic' &&
      !isRegisteredQualificationLocalSyntheticExecutionV1(
        value.identity.fixtureId,
        value.identity.runner,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'local synthetic execution must use a registered fixture and runner identity',
      });
    } else if (
      value.identity.source !== 'local_synthetic' &&
      value.identity.source !== 'github_actions'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'source'],
        message:
          'diagnostic execution accepts only a registered local synthetic source or a specialized GitHub diagnostic source',
      });
    }
    if (Date.parse(value.identity.endedAt) < Date.parse(value.identity.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'execution end time cannot precede start time',
      });
    }
    if (executionMetadataIssues(value.identity).length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'execution identity contains unsafe metadata',
      });
    }
    if (
      value.identity.source === 'github_actions' &&
      !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(value.identity.workflowPath)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'workflowPath'],
        message: 'github workflow path must be a safe repository workflow declaration',
      });
    }
  });

export type DiagnosticExecutionMaterialV1 = z.infer<typeof diagnosticExecutionMaterialV1Schema>;

export function computeDiagnosticExecutionDigestV1(
  material: DiagnosticExecutionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.execution.v1',
    canonicalJsonBytes(diagnosticExecutionMaterialV1Schema.parse(material)),
  );
}

export const diagnosticExecutionV1Schema = diagnosticExecutionMaterialV1Schema
  .extend({ executionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { executionDigest, ...material } = value;
    const expected = computeDiagnosticExecutionDigestV1(material);
    if (executionDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['executionDigest'],
        message: `execution digest mismatch: expected ${expected}`,
      });
    }
  });

export type DiagnosticExecutionV1 = z.infer<typeof diagnosticExecutionV1Schema>;

export function buildDiagnosticExecutionV1(
  material: DiagnosticExecutionMaterialV1,
): DiagnosticExecutionV1 {
  const parsed = diagnosticExecutionMaterialV1Schema.parse(material);
  return diagnosticExecutionV1Schema.parse({
    ...parsed,
    executionDigest: computeDiagnosticExecutionDigestV1(parsed),
  });
}

export const diagnosticRouteIdentityV1Schema = z
  .object({
    routeAlias: z.string().regex(SAFE_ROUTE_ALIAS),
    model: z.string().regex(SAFE_MODEL),
    protocolFamily: z.enum(['openai_compatible', 'chat_completions', 'messages', 'responses']),
    routeIdentityDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    toolCatalogDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
  })
  .strict();

export type DiagnosticRouteIdentityV1 = z.infer<typeof diagnosticRouteIdentityV1Schema>;

export const qualificationAttemptScopeV1Schema = z
  .object({
    platformIdentity: platformIdentitySchema,
    releaseProfileDigest: digestSchema,
    entrypoint: z.enum(LIVE_OBSERVATION_ENTRYPOINTS_V1),
    testPolicyDigest: digestSchema,
    routePolicyDigest: digestSchema,
    route: diagnosticRouteIdentityV1Schema.optional(),
  })
  .strict();

export type QualificationAttemptScopeV1 = z.infer<typeof qualificationAttemptScopeV1Schema>;

export const qualificationAttemptIdentityV1Schema = z
  .object({
    matrixDigest: digestSchema,
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    corpusDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
  })
  .strict();

export type QualificationAttemptIdentityV1 = z.infer<typeof qualificationAttemptIdentityV1Schema>;

const liveCompatibilityObservationMaterialV1Schema = z
  .object({
    schema: z.literal('LiveCompatibilityObservationV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    observedAt: isoTimestampSchema,
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    execution: diagnosticExecutionV1Schema,
    scope: qualificationAttemptScopeV1Schema,
    identity: qualificationAttemptIdentityV1Schema,
    outcome: z.enum(['success', 'cancelled']),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateArtifact = value.candidate.artifacts.find(
      (slot) => slot.platformIdentity === value.execution.platformIdentity,
    );
    if (!candidateArtifact) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'artifacts'],
        message: 'live observation candidate must contain the execution platform artifact',
      });
    } else {
      if (candidateArtifact.artifact.commit !== value.execution.identity.commit) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation candidate commit must match execution identity',
        });
      }
      if (candidateArtifact.artifact.profileDigest !== value.scope.releaseProfileDigest) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation candidate must bind the scope profile digest',
        });
      }
      if (candidateArtifact.artifact.payloadSha256 !== value.identity.runnerDigest) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation candidate payload must bind the runner digest',
        });
      }
    }
    if (value.scope.platformIdentity !== value.execution.platformIdentity) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'platformIdentity'],
        message: 'live observation scope must match execution platform',
      });
    }
    if (!value.scope.route) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'route'],
        message: 'live observation requires a metadata-only route identity',
      });
    }
    if (value.governance.retentionClass !== 'ephemeral_local') {
      context.addIssue({
        code: 'custom',
        path: ['governance', 'retentionClass'],
        message: 'AQ-8 live observations are local ephemeral diagnostics only',
      });
    }
  });

export type LiveCompatibilityObservationMaterialV1 = z.infer<
  typeof liveCompatibilityObservationMaterialV1Schema
>;

export function computeLiveCompatibilityObservationRecordDigestV1(
  material: LiveCompatibilityObservationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-observation-record.v1',
    canonicalJsonBytes(liveCompatibilityObservationMaterialV1Schema.parse(material)),
  );
}

const liveCompatibilityObservationRecordMaterialV1Schema =
  liveCompatibilityObservationMaterialV1Schema.extend({ recordDigest: digestSchema }).strict();

export type LiveCompatibilityObservationRecordMaterialV1 = z.infer<
  typeof liveCompatibilityObservationRecordMaterialV1Schema
>;

export function computeLiveCompatibilityObservationReportDigestV1(
  material: LiveCompatibilityObservationRecordMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-observation-report.v1',
    canonicalJsonBytes(liveCompatibilityObservationRecordMaterialV1Schema.parse(material)),
  );
}

export const liveCompatibilityObservationV1Schema =
  liveCompatibilityObservationRecordMaterialV1Schema
    .extend({ reportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { reportDigest, recordDigest, ...recordMaterial } = value;
      const expectedRecordDigest =
        computeLiveCompatibilityObservationRecordDigestV1(recordMaterial);
      if (recordDigest !== expectedRecordDigest) {
        context.addIssue({
          code: 'custom',
          path: ['recordDigest'],
          message: `live observation record digest mismatch: expected ${expectedRecordDigest}`,
        });
      }
      const expectedReportDigest = computeLiveCompatibilityObservationReportDigestV1({
        ...recordMaterial,
        recordDigest,
      });
      if (reportDigest !== expectedReportDigest) {
        context.addIssue({
          code: 'custom',
          path: ['reportDigest'],
          message: `live observation report digest mismatch: expected ${expectedReportDigest}`,
        });
      }
    });

export type LiveCompatibilityObservationV1 = z.infer<typeof liveCompatibilityObservationV1Schema>;

export function buildLiveCompatibilityObservationV1(
  material: LiveCompatibilityObservationMaterialV1,
): LiveCompatibilityObservationV1 {
  const parsed = liveCompatibilityObservationMaterialV1Schema.parse(material);
  const recordDigest = computeLiveCompatibilityObservationRecordDigestV1(parsed);
  return liveCompatibilityObservationV1Schema.parse({
    ...parsed,
    recordDigest,
    reportDigest: computeLiveCompatibilityObservationReportDigestV1({ ...parsed, recordDigest }),
  });
}

export function sameQualificationGovernanceBindingV1(
  left: EvidenceGovernanceBindingV1,
  right: EvidenceGovernanceBindingV1,
): boolean {
  return (
    left.retentionClass === right.retentionClass &&
    left.profileId === right.profileId &&
    left.profileDigest === right.profileDigest &&
    left.expiresAt === right.expiresAt &&
    left.retainedArtifactDigest === right.retainedArtifactDigest &&
    left.quotaLedgerDigests?.day === right.quotaLedgerDigests?.day &&
    left.quotaLedgerDigests?.month === right.quotaLedgerDigests?.month &&
    left.storageDeletionWitnessDigest === right.storageDeletionWitnessDigest
  );
}
