import { z } from 'zod';
import { isRegisteredQualificationLocalSyntheticExecutionV1 } from '../../../../../release/qualification/evidence/source-owned-verifier-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  type ReleaseArtifactIdentityV1,
  releaseArtifactIdentityV1Schema,
  releaseEvidenceExecutionIdentityV1Schema,
  sameReleaseArtifactIdentityV1,
} from '../../../../release/evidence-identity-primitives';
import {
  QUALIFICATION_ENTRYPOINTS_V1,
  QUALIFICATION_LAYERS_V1,
  type QualificationEntrypointV1,
  type QualificationLayerV1,
} from '../feature-matrix';
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
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const ASSERTION_ID = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'diagnostic identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });
const assertionIdSchema = z.string().regex(ASSERTION_ID).refine(isQualificationSafeIdentifierV1, {
  message:
    'diagnostic assertion identifier must not contain an endpoint, absolute path, or unsafe metadata',
});
const platformIdentitySchema = z.string().regex(SAFE_PLATFORM);
const isoTimestampSchema = z.iso.datetime({ offset: true });

export const QUALIFICATION_SUITE_ROLES_V1 = ['structural_inventory', 'behavioral'] as const;
export type QualificationSuiteRoleV1 = (typeof QUALIFICATION_SUITE_ROLES_V1)[number];

export const QUALIFICATION_ATTEMPT_REASON_CODES_V1 = [
  'assertion_failed',
  'behavioral_evidence_not_registered',
  'candidate_identity_mismatch',
  'execution_identity_untrusted',
  'identity_drift',
  'not_applicable_default_off_legacy_fallback',
  'not_applicable_manual_usability_disabled',
  'not_applicable_source_not_supported',
  'not_observed',
  'policy_not_registered',
  'retention_unavailable',
  'suite_role_structural_inventory',
] as const;
export type QualificationAttemptReasonCodeV1 =
  (typeof QUALIFICATION_ATTEMPT_REASON_CODES_V1)[number];

const reasonCodeSchema = z.enum(QUALIFICATION_ATTEMPT_REASON_CODES_V1);

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function sameArtifact(left: ReleaseArtifactIdentityV1, right: ReleaseArtifactIdentityV1): boolean {
  return sameReleaseArtifactIdentityV1(left, right);
}

const diagnosticCandidateArtifactSlotV1Schema = z
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
        path: ['identity', 'endedAt'],
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
    entrypoint: z.enum(QUALIFICATION_ENTRYPOINTS_V1),
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

/**
 * A behavioral receipt is opaque diagnostic metadata. Its content remains in
 * the evaluator's local contract; aggregate evidence carries only the stable
 * ID and canonical digest needed for exact verifier binding.
 */
export const qualificationReceiptBindingV1Schema = z
  .object({
    receiptId: safeIdentifierSchema,
    receiptDigest: digestSchema,
  })
  .strict();

export type QualificationReceiptBindingV1 = z.infer<typeof qualificationReceiptBindingV1Schema>;

const qualificationAttemptMaterialV1Schema = z
  .object({
    attemptId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    assertionId: assertionIdSchema,
    layer: z.enum(QUALIFICATION_LAYERS_V1),
    status: z.enum(['passed', 'failed', 'blocked', 'not_applicable']),
    executionId: safeIdentifierSchema,
    candidateArtifact: diagnosticCandidateArtifactSlotV1Schema,
    scope: qualificationAttemptScopeV1Schema,
    identity: qualificationAttemptIdentityV1Schema,
    receipt: qualificationReceiptBindingV1Schema.optional(),
    reasonCode: reasonCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.platformIdentity !== value.candidateArtifact.platformIdentity) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'platformIdentity'],
        message: 'attempt scope platform must equal candidate artifact platform',
      });
    }
    if (value.scope.releaseProfileDigest !== value.candidateArtifact.artifact.profileDigest) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'releaseProfileDigest'],
        message: 'attempt release profile must match candidate artifact profile',
      });
    }
    if (value.status === 'passed' && value.reasonCode !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'passed attempt cannot carry reason code',
      });
    }
    if (value.status !== 'passed' && value.reasonCode === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'non-passed attempt requires reason code',
      });
    }
    if (value.status === 'failed' && value.reasonCode !== 'assertion_failed') {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'failed attempt requires assertion_failed reason',
      });
    }
    if (
      value.status === 'not_applicable' &&
      ![
        'not_applicable_default_off_legacy_fallback',
        'not_applicable_manual_usability_disabled',
        'not_applicable_source_not_supported',
      ].includes(value.reasonCode ?? '')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'not applicable attempt requires a registered N/A reason',
      });
    }
  });

export type QualificationAttemptMaterialV1 = z.infer<typeof qualificationAttemptMaterialV1Schema>;

export function computeQualificationAttemptEvidenceDigestV1(
  material: QualificationAttemptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.attempt-evidence.v1',
    canonicalJsonBytes(qualificationAttemptMaterialV1Schema.parse(material)),
  );
}

export const qualificationAttemptV1Schema = qualificationAttemptMaterialV1Schema
  .extend({ evidenceDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { evidenceDigest, ...material } = value;
    const expected = computeQualificationAttemptEvidenceDigestV1(material);
    if (evidenceDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceDigest'],
        message: `attempt evidence digest mismatch: expected ${expected}`,
      });
    }
  });

export type QualificationAttemptV1 = z.infer<typeof qualificationAttemptV1Schema>;

export function buildQualificationAttemptV1(
  material: QualificationAttemptMaterialV1,
): QualificationAttemptV1 {
  const parsed = qualificationAttemptMaterialV1Schema.parse(material);
  return qualificationAttemptV1Schema.parse({
    ...parsed,
    evidenceDigest: computeQualificationAttemptEvidenceDigestV1(parsed),
  });
}

const qualificationSuiteBindingV1Schema = z
  .object({
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
    role: z.enum(QUALIFICATION_SUITE_ROLES_V1),
  })
  .strict();

export type QualificationSuiteBindingV1 = z.infer<typeof qualificationSuiteBindingV1Schema>;

const agentQualificationEvidenceMaterialV1Schema = z
  .object({
    schema: z.literal('AgentQualificationEvidenceV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    createdAt: isoTimestampSchema,
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    suite: qualificationSuiteBindingV1Schema,
    executions: z.array(diagnosticExecutionV1Schema).min(1),
    attempts: z.array(qualificationAttemptV1Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const executionIds = value.executions.map((execution) => execution.executionId);
    if (!codePointSortedUnique(executionIds)) {
      context.addIssue({
        code: 'custom',
        path: ['executions'],
        message: 'executions must be code-point sorted and unique by execution ID',
      });
    }
    const attemptIds = value.attempts.map((attempt) => attempt.attemptId);
    if (!codePointSortedUnique(attemptIds)) {
      context.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: 'attempts must be code-point sorted and unique by attempt ID',
      });
    }
    const executions = new Map(
      value.executions.map((execution) => [execution.executionId, execution]),
    );
    const referencedExecutionIds = new Set<string>();
    const candidateByPlatform = new Map(
      value.candidate.artifacts.map((artifact) => [artifact.platformIdentity, artifact]),
    );
    for (const [index, attempt] of value.attempts.entries()) {
      const execution = executions.get(attempt.executionId);
      if (!execution) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'executionId'],
          message: 'attempt must reference a canonical execution in this record',
        });
        continue;
      }
      referencedExecutionIds.add(execution.executionId);
      const candidateArtifact = candidateByPlatform.get(attempt.candidateArtifact.platformIdentity);
      if (
        !candidateArtifact ||
        !sameArtifact(candidateArtifact.artifact, attempt.candidateArtifact.artifact)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'candidateArtifact'],
          message: 'attempt must carry the exact candidate artifact for its closure platform',
        });
      }
      if (execution.platformIdentity !== attempt.scope.platformIdentity) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'executionId'],
          message: 'attempt execution platform must match attempt scope platform',
        });
      }
      if (execution.identity.commit !== attempt.candidateArtifact.artifact.commit) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'executionId'],
          message: 'attempt execution commit must match candidate artifact commit',
        });
      }
      if (
        (execution.identity.source === 'github_actions' ||
          execution.identity.source === 'github_maintainer_review') &&
        (execution.identity.canonicalRepository !==
          attempt.candidateArtifact.artifact.canonicalRepository ||
          execution.identity.repositoryId !== attempt.candidateArtifact.artifact.repositoryId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'executionId'],
          message: 'github execution repository identity must match candidate artifact identity',
        });
      }
    }
    for (const [index, execution] of value.executions.entries()) {
      if (!referencedExecutionIds.has(execution.executionId)) {
        context.addIssue({
          code: 'custom',
          path: ['executions', index],
          message: 'record cannot carry dangling execution records',
        });
      }
    }
    if (value.governance.retentionClass === 'repository_declaration') {
      context.addIssue({
        code: 'custom',
        path: ['governance'],
        message:
          'repository declaration profile has zero dispatch budget and cannot carry attempts',
      });
    }
  });

export type AgentQualificationEvidenceMaterialV1 = z.infer<
  typeof agentQualificationEvidenceMaterialV1Schema
>;

export function computeAgentQualificationEvidenceRecordDigestV1(
  material: AgentQualificationEvidenceMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.evidence-record.v1',
    canonicalJsonBytes(agentQualificationEvidenceMaterialV1Schema.parse(material)),
  );
}

const agentQualificationEvidenceRecordMaterialV1Schema = agentQualificationEvidenceMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict();

export type AgentQualificationEvidenceRecordMaterialV1 = z.infer<
  typeof agentQualificationEvidenceRecordMaterialV1Schema
>;

export function computeAgentQualificationEvidenceReportDigestV1(
  material: AgentQualificationEvidenceRecordMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.evidence-report.v1',
    canonicalJsonBytes(agentQualificationEvidenceRecordMaterialV1Schema.parse(material)),
  );
}

export const agentQualificationEvidenceV1Schema = agentQualificationEvidenceRecordMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, recordDigest, ...recordMaterial } = value;
    const expectedRecordDigest = computeAgentQualificationEvidenceRecordDigestV1(recordMaterial);
    if (recordDigest !== expectedRecordDigest) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: `diagnostic evidence record digest mismatch: expected ${expectedRecordDigest}`,
      });
    }
    const expectedReportDigest = computeAgentQualificationEvidenceReportDigestV1({
      ...recordMaterial,
      recordDigest,
    });
    if (reportDigest !== expectedReportDigest) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `diagnostic evidence report digest mismatch: expected ${expectedReportDigest}`,
      });
    }
  });

export type AgentQualificationEvidenceV1 = z.infer<typeof agentQualificationEvidenceV1Schema>;

export function buildAgentQualificationEvidenceV1(
  material: AgentQualificationEvidenceMaterialV1,
): AgentQualificationEvidenceV1 {
  const parsed = agentQualificationEvidenceMaterialV1Schema.parse(material);
  const recordDigest = computeAgentQualificationEvidenceRecordDigestV1(parsed);
  return agentQualificationEvidenceV1Schema.parse({
    ...parsed,
    recordDigest,
    reportDigest: computeAgentQualificationEvidenceReportDigestV1({ ...parsed, recordDigest }),
  });
}

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
        message: 'AQ-2 live observations are local ephemeral diagnostics only',
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

export function isQualificationAttemptScopeV1(
  value: unknown,
): value is QualificationAttemptScopeV1 {
  return qualificationAttemptScopeV1Schema.safeParse(value).success;
}

export function isQualificationLayerV1(value: unknown): value is QualificationLayerV1 {
  return (QUALIFICATION_LAYERS_V1 as readonly string[]).includes(String(value));
}

export function isQualificationEntrypointV1(value: unknown): value is QualificationEntrypointV1 {
  return (QUALIFICATION_ENTRYPOINTS_V1 as readonly string[]).includes(String(value));
}
