import { z } from 'zod';
import { registeredQualificationSuiteRoleV1 } from '../../../../../release/qualification/evidence/source-owned-verifier-v1';
import {
  assertSourceOwnedL2NativeConformanceBindingProvenanceV1,
  createSourceOwnedQualificationCatalogV1,
  discoverSourceOwnedL0ContractBindingsV1,
  discoverSourceOwnedL1AutoCompactionFailureBindingsV1,
  discoverSourceOwnedL1PublicProjectionBindingsV1,
  discoverSourceOwnedL1SkillMcpBindingsV1,
  discoverSourceOwnedL1SubagentRecoveryBindingsV1,
  discoverSourceOwnedL1ToolVerificationBindingsV1,
  discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1,
  discoverSourceOwnedL2NativeConformanceBindingsV1,
} from '../../../../../release/qualification/source-owned-surface-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  computeQualificationEvaluatorDigestV1,
  generateAgentFeatureQualificationMatrixV1,
} from '../feature-matrix';
import {
  buildL0ContractReceiptV1,
  type L0ContractReceiptV1,
  l0ContractReceiptBindingV1,
  l0ContractReceiptV1Schema,
  runL0ContractAdapterV1,
  runL0ContractCorpusV1,
} from '../l0-contract-adapter-v1';
import { L0_CONTRACT_SUITE_ID_V1, l0EvaluatorIdentityV1Schema } from '../l0-contract-schema-v1';
import {
  runL1AutoCompactionFailureAdaptersV1,
  runL1AutoCompactionFailureContractCorpusV1,
} from '../l1-auto-compaction-failure-adapter-v1';
import {
  buildL1AutoCompactionFailureReceiptV1,
  type L1AutoCompactionFailureReceiptV1,
  l1AutoCompactionFailureReceiptBindingV1,
  l1AutoCompactionFailureReceiptV1Schema,
} from '../l1-auto-compaction-failure-evidence-v1';
import {
  bindL1AutoCompactionFailureCatalogSuiteV1,
  L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
  L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
  L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
  l1AutoCompactionFailureEvaluatorIdentityV1Schema,
} from '../l1-auto-compaction-failure-schema-v1';
import {
  buildL1PublicProjectionReceiptV1,
  type L1PublicProjectionReceiptV1,
  l1PublicProjectionReceiptV1Schema,
  runL1PublicProjectionAdaptersV1,
  runL1PublicProjectionContractCorpusV1,
} from '../l1-public-projection-adapter-v1';
import {
  bindL1PublicProjectionCatalogSuiteV1,
  L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
  L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
  L1_PUBLIC_PROJECTION_SUITE_ID_V1,
  l1PublicProjectionEvaluatorIdentityV1Schema,
} from '../l1-public-projection-schema-v1';
import { runL1SkillMcpAdaptersV1, runL1SkillMcpContractCorpusV1 } from '../l1-skill-mcp-adapter-v1';
import {
  buildL1SkillMcpReceiptV1,
  type L1SkillMcpReceiptV1,
  l1SkillMcpReceiptBindingV1,
  l1SkillMcpReceiptV1Schema,
} from '../l1-skill-mcp-evidence-v1';
import {
  bindL1SkillMcpCatalogSuiteV1,
  L1_SKILL_MCP_FIXTURE_ID_V1,
  L1_SKILL_MCP_RUNNER_ID_V1,
  L1_SKILL_MCP_SUITE_ID_V1,
  l1SkillMcpEvaluatorIdentityV1Schema,
} from '../l1-skill-mcp-schema-v1';
import {
  runL1SubagentRecoveryAdaptersV1,
  runL1SubagentRecoveryContractCorpusV1,
} from '../l1-subagent-recovery-adapter-v1';
import {
  buildL1SubagentRecoveryReceiptV1,
  type L1SubagentRecoveryReceiptV1,
  l1SubagentRecoveryReceiptBindingV1,
  l1SubagentRecoveryReceiptV1Schema,
} from '../l1-subagent-recovery-evidence-v1';
import {
  bindL1SubagentRecoveryCatalogSuiteV1,
  L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
  L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
  L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
  l1SubagentRecoveryEvaluatorIdentityV1Schema,
} from '../l1-subagent-recovery-schema-v1';
import {
  runL1ToolVerificationAdaptersV1,
  runL1ToolVerificationContractCorpusV1,
} from '../l1-tool-verification-adapter-v1';
import {
  buildL1ToolVerificationReceiptV1,
  type L1ToolVerificationReceiptV1,
  l1ToolVerificationReceiptBindingV1,
  l1ToolVerificationReceiptV1Schema,
} from '../l1-tool-verification-evidence-v1';
import {
  bindL1ToolVerificationCatalogSuiteV1,
  L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
  L1_TOOL_VERIFICATION_RUNNER_ID_V1,
  L1_TOOL_VERIFICATION_SUITE_ID_V1,
  l1ToolVerificationEvaluatorIdentityV1Schema,
} from '../l1-tool-verification-schema-v1';
import {
  runL1TuiRewindForkProjectionAdaptersV1,
  runL1TuiRewindForkProjectionContractCorpusV1,
} from '../l1-tui-rewind-projection-adapter-v1';
import {
  buildL1TuiRewindForkProjectionReceiptV1,
  type L1TuiRewindForkProjectionReceiptV1,
  l1TuiRewindForkProjectionReceiptBindingV1,
  l1TuiRewindForkProjectionReceiptV1Schema,
} from '../l1-tui-rewind-projection-evidence-v1';
import {
  bindL1TuiRewindForkProjectionCatalogSuiteV1,
  L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
  l1TuiRewindForkProjectionEvaluatorIdentityV1Schema,
} from '../l1-tui-rewind-projection-schema-v1';
import {
  buildL2NativeConformanceEvaluatorV1,
  evaluateL2NativeConformanceCorpusV1,
  l2NativeConformanceEvaluatorReportV1Schema,
} from '../l2-native-conformance-evaluator-v1';
import {
  l2NativeConformanceProvenanceContextV1Schema,
  l2NativeConformanceReceiptV1Schema,
} from '../l2-native-conformance-evidence-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
  L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
} from '../l2-native-conformance-schema-v1';
import {
  type AgentQualificationEvidenceV1,
  agentQualificationEvidenceV1Schema,
  type DiagnosticCandidateArtifactClosureV1,
  type DiagnosticExecutionV1,
  type DiagnosticRouteIdentityV1,
  diagnosticCandidateArtifactClosureV1Schema,
  diagnosticExecutionV1Schema,
  liveCompatibilityObservationV1Schema,
  type QualificationAttemptIdentityV1,
  type QualificationAttemptScopeV1,
  type QualificationReceiptBindingV1,
  type QualificationSuiteBindingV1,
  qualificationAttemptIdentityV1Schema,
  qualificationAttemptScopeV1Schema,
  qualificationReceiptBindingV1Schema,
  sameQualificationGovernanceBindingV1,
} from './evidence-schema-v1';
import {
  EVIDENCE_GOVERNANCE_PROFILE_V1,
  type EvidenceGovernanceBindingV1,
  type EvidenceQuotaLedgerV1,
  type EvidenceRetentionWitnessV1,
  evidenceGovernanceBindingV1Schema,
  evidenceQuotaLedgerV1Schema,
  evidenceRetentionWitnessV1Schema,
} from './governance-v1';
import { isQualificationSafeIdentifierV1 } from './metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
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

export const QUALIFICATION_DERIVED_STATES_V1 = [
  'qualified',
  'verified_disabled',
  'unsupported',
  'blocked',
  'failed',
] as const;
export type QualificationDerivedStateV1 = (typeof QUALIFICATION_DERIVED_STATES_V1)[number];

export const QUALIFICATION_VERIFIER_REASON_CODES_V1 = [
  'assertion_failed',
  'behavioral_evidence_not_registered',
  'behavioral_evidence_registered',
  'behavioral_context_untrusted',
  'candidate_identity_mismatch',
  'disabled_behavior_verified',
  'execution_identity_untrusted',
  'identity_drift',
  'input_invalid',
  'not_applicable_default_off_legacy_fallback',
  'not_applicable_manual_usability_disabled',
  'not_applicable_source_not_supported',
  'not_observed',
  'retention_unavailable',
] as const;
export type QualificationVerifierReasonCodeV1 =
  (typeof QUALIFICATION_VERIFIER_REASON_CODES_V1)[number];

const expectedRequirementV1Schema = z
  .object({
    requirementId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    assertionId: assertionIdSchema,
    layer: z.enum(['contract', 'scripted_runtime', 'native', 'live_model', 'manual_usability']),
    scope: z
      .object({
        platformIdentity: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
        releaseProfileDigest: digestSchema,
        entrypoint: z.enum(['tui', 'cli', 'installer', 'runtime', 'any']),
        testPolicyDigest: digestSchema,
        routePolicyDigest: digestSchema,
        route: z
          .object({
            routeAlias: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
            model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
            protocolFamily: z.enum([
              'openai_compatible',
              'chat_completions',
              'messages',
              'responses',
            ]),
            routeIdentityDigest: digestSchema,
            providerDataPolicyDigest: digestSchema,
            promptEnvironmentDigest: digestSchema,
            toolCatalogDigest: digestSchema,
            capabilityDeclarationDigest: digestSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    identity: z
      .object({
        matrixDigest: digestSchema,
        suiteDigest: digestSchema,
        oracleDigest: digestSchema,
        corpusDigest: digestSchema,
        evaluatorDigest: digestSchema,
        verifierDigest: digestSchema,
        runnerDigest: digestSchema,
      })
      .strict(),
    receipt: qualificationReceiptBindingV1Schema.optional(),
    expectedDisposition: z.enum(['behavioral_required', 'verified_disabled', 'unsupported']),
  })
  .strict();

export type QualificationVerifierRequirementV1 = z.infer<typeof expectedRequirementV1Schema>;

const verifierContextMaterialV1Schema = z
  .object({
    schema: z.literal('QualificationVerifierContextV1'),
    version: z.literal(1),
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    executions: z.array(diagnosticExecutionV1Schema).min(1),
    suite: z
      .object({
        suiteId: safeIdentifierSchema,
        suiteDigest: digestSchema,
        role: z.enum(['structural_inventory', 'behavioral']),
      })
      .strict(),
    governanceWitnesses: z
      .object({
        dayQuotaLedger: evidenceQuotaLedgerV1Schema,
        monthQuotaLedger: evidenceQuotaLedgerV1Schema,
        retention: evidenceRetentionWitnessV1Schema,
      })
      .strict(),
    requirements: z.array(expectedRequirementV1Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.requirements.every(
        (requirement, index) =>
          index === 0 ||
          (value.requirements[index - 1]?.requirementId ?? '') < requirement.requirementId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requirements'],
        message: 'verifier requirements must be code-point sorted and unique',
      });
    }
    const registeredRole = registeredQualificationSuiteRoleV1(value.suite.suiteId);
    if (!registeredRole || registeredRole !== value.suite.role) {
      context.addIssue({
        code: 'custom',
        path: ['suite'],
        message: 'suite role must be supplied by the closed source-owned role registry',
      });
    }
    if (
      !value.executions.every(
        (execution, index) =>
          index === 0 || (value.executions[index - 1]?.executionId ?? '') < execution.executionId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['executions'],
        message: 'trusted executions must be code-point sorted and unique by execution ID',
      });
    }
    for (const [index, requirement] of value.requirements.entries()) {
      if (requirement.identity.suiteDigest !== value.suite.suiteDigest) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'identity', 'suiteDigest'],
          message: 'requirement suite digest must match verifier context suite',
        });
      }
      if (value.suite.role === 'behavioral' && requirement.receipt === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'receipt'],
          message: 'behavioral verifier requirements require an exact receipt binding',
        });
      }
    }
  });

export type QualificationVerifierContextMaterialV1 = z.infer<
  typeof verifierContextMaterialV1Schema
>;

export function computeQualificationVerifierContextDigestV1(
  material: QualificationVerifierContextMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.verifier-context.v1',
    canonicalJsonBytes(verifierContextMaterialV1Schema.parse(material)),
  );
}

export const qualificationVerifierContextV1Schema = verifierContextMaterialV1Schema
  .extend({ contextDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { contextDigest, ...material } = value;
    const expected = computeQualificationVerifierContextDigestV1(material);
    if (contextDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['contextDigest'],
        message: `verifier context digest mismatch: expected ${expected}`,
      });
    }
  });

export type QualificationVerifierContextV1 = z.infer<typeof qualificationVerifierContextV1Schema>;

export function buildQualificationVerifierContextV1(
  material: QualificationVerifierContextMaterialV1,
): QualificationVerifierContextV1 {
  const parsed = verifierContextMaterialV1Schema.parse(material);
  return qualificationVerifierContextV1Schema.parse({
    ...parsed,
    contextDigest: computeQualificationVerifierContextDigestV1(parsed),
  });
}

const l0SourceScopeV1Schema = z
  .object({
    sourceSurfaceId: safeIdentifierSchema,
    scope: qualificationAttemptScopeV1Schema,
  })
  .strict();

const l0TrustedVerificationContextV1Schema = z
  .object({
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    executions: z.array(diagnosticExecutionV1Schema).min(1),
    governanceWitnesses: z
      .object({
        dayQuotaLedger: evidenceQuotaLedgerV1Schema,
        monthQuotaLedger: evidenceQuotaLedgerV1Schema,
        retention: evidenceRetentionWitnessV1Schema,
      })
      .strict(),
  })
  .strict();

/**
 * L0 accepts no caller-supplied Feature/assertion/suite mapping. The wrapper
 * below reconstructs those from the source-owned catalog, using this input
 * only for independently supplied candidate/execution/governance context,
 * per-surface scope and opaque receipts. The wrapper reruns the closed L0
 * corpus itself; accepting a caller-provided evaluator report would make a
 * metadata record capable of masking a broken evaluator self-check.
 */
const l0ContractEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L0ContractEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l0TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l0SourceScopeV1Schema).min(1),
    receipts: z.array(l0ContractReceiptV1Schema).min(1),
  })
  .strict();

export type L0ContractEvidenceVerificationInputV1 = z.infer<
  typeof l0ContractEvidenceVerificationInputV1Schema
>;

const l1SourceScopeV1Schema = z
  .object({
    sourceSurfaceId: safeIdentifierSchema,
    scope: qualificationAttemptScopeV1Schema,
  })
  .strict();

const l1TrustedVerificationContextV1Schema = z
  .object({
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    executions: z.array(diagnosticExecutionV1Schema).min(1),
    governanceWitnesses: z
      .object({
        dayQuotaLedger: evidenceQuotaLedgerV1Schema,
        monthQuotaLedger: evidenceQuotaLedgerV1Schema,
        retention: evidenceRetentionWitnessV1Schema,
      })
      .strict(),
  })
  .strict();

/**
 * The L1 wrappers accept only independently supplied candidate/execution/
 * governance context plus opaque receipt material. Source ownership, Matrix,
 * suites, evaluator identities, reports, and expected receipts are rebuilt
 * from current product declarations and closed local corpus code.
 */
const l1ToolVerificationEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1ToolVerificationEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1ToolVerificationReceiptV1Schema).min(1),
  })
  .strict();

export type L1ToolVerificationEvidenceVerificationInputV1 = z.infer<
  typeof l1ToolVerificationEvidenceVerificationInputV1Schema
>;

/** AQ-9A has its own local-only receipt type, fixture, runner, and bindings. */
const l1AutoCompactionFailureEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1AutoCompactionFailureReceiptV1Schema).min(1),
  })
  .strict();
export type L1AutoCompactionFailureEvidenceVerificationInputV1 = z.infer<
  typeof l1AutoCompactionFailureEvidenceVerificationInputV1Schema
>;

const l1PublicProjectionEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1PublicProjectionReceiptV1Schema).min(1),
  })
  .strict();

export type L1PublicProjectionEvidenceVerificationInputV1 = z.infer<
  typeof l1PublicProjectionEvidenceVerificationInputV1Schema
>;

/**
 * AQ-5's Skill/MCP evidence uses the same candidate/governance envelope as
 * the other L1 diagnostic wrappers, but its receipts, fixture, runner,
 * suite, and source bindings are independently closed below. It has no
 * production-admission or deployment-decision input position.
 */
const l1SkillMcpEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1SkillMcpReceiptV1Schema).min(1),
  })
  .strict();

export type L1SkillMcpEvidenceVerificationInputV1 = z.infer<
  typeof l1SkillMcpEvidenceVerificationInputV1Schema
>;

/** AQ-6 uses its own receipt type, source bindings, fixture, and runner. */
const l1SubagentRecoveryEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoveryEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1SubagentRecoveryReceiptV1Schema).min(1),
  })
  .strict();

export type L1SubagentRecoveryEvidenceVerificationInputV1 = z.infer<
  typeof l1SubagentRecoveryEvidenceVerificationInputV1Schema
>;

/** AQ-6's public rewind observation is a distinct diagnostic projection suite. */
const l1TuiRewindForkProjectionEvidenceVerificationInputV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionEvidenceVerificationInputV1'),
    version: z.literal(1),
    evidence: agentQualificationEvidenceV1Schema,
    trusted: l1TrustedVerificationContextV1Schema,
    sourceSurfaceId: safeIdentifierSchema,
    scopes: z.array(l1SourceScopeV1Schema).min(1),
    receipts: z.array(l1TuiRewindForkProjectionReceiptV1Schema).min(1),
  })
  .strict();

export type L1TuiRewindForkProjectionEvidenceVerificationInputV1 = z.infer<
  typeof l1TuiRewindForkProjectionEvidenceVerificationInputV1Schema
>;

/**
 * AQ-7's protected native path accepts only opaque L2 material.  It has no
 * generic diagnostic-record input and no caller-controlled source mapping:
 * the verifier below reconstructs those facts from the product catalog.
 */
const l2NativeConformanceReceiptVerificationInputV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceReceiptVerificationInputV1'),
    version: z.literal(1),
    receipt: l2NativeConformanceReceiptV1Schema,
    provenance: l2NativeConformanceProvenanceContextV1Schema,
    evaluatorReport: l2NativeConformanceEvaluatorReportV1Schema,
  })
  .strict();

export type L2NativeConformanceReceiptVerificationInputV1 = z.infer<
  typeof l2NativeConformanceReceiptVerificationInputV1Schema
>;

/**
 * This digest is an audit closure for one sealed L2 receipt.  It is not a
 * cross-run aggregate: protected-profile quota ledgers remain an atomic
 * control-plane concern and are deliberately not synthesized here.
 */
const l2NativeConformanceReceiptVerifierContextMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceReceiptVerifierContextV1'),
    version: z.literal(1),
    matrixDigest: digestSchema,
    sourceRegistryDigest: digestSchema,
    sourceSurfaceId: safeIdentifierSchema,
    sourceBindingDigest: digestSchema,
    featureId: z.string().regex(FEATURE_ID),
    assertionId: assertionIdSchema,
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    corpusDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    candidateDigest: digestSchema,
    executionDigest: digestSchema,
    probeBindingDigest: digestSchema,
    platformVerifierDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    receiptDigest: digestSchema,
    governance: evidenceGovernanceBindingV1Schema,
  })
  .strict();

type L2NativeConformanceReceiptVerifierContextMaterialV1 = z.infer<
  typeof l2NativeConformanceReceiptVerifierContextMaterialV1Schema
>;

function computeL2NativeConformanceReceiptVerifierContextDigestV1(
  material: L2NativeConformanceReceiptVerifierContextMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.receipt-verifier-context.v1',
    canonicalJsonBytes(l2NativeConformanceReceiptVerifierContextMaterialV1Schema.parse(material)),
  );
}

const liveObservationVerifierContextMaterialV1Schema = z
  .object({
    schema: z.literal('LiveCompatibilityObservationVerifierContextV1'),
    version: z.literal(1),
    candidate: diagnosticCandidateArtifactClosureV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
    execution: diagnosticExecutionV1Schema,
    scope: qualificationAttemptScopeV1Schema,
    identity: qualificationAttemptIdentityV1Schema,
    governanceWitnesses: z
      .object({
        dayQuotaLedger: evidenceQuotaLedgerV1Schema,
        monthQuotaLedger: evidenceQuotaLedgerV1Schema,
        retention: evidenceRetentionWitnessV1Schema,
      })
      .strict(),
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
        message: 'live observation context candidate must contain the execution platform artifact',
      });
    } else {
      if (candidateArtifact.artifact.commit !== value.execution.identity.commit) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation context candidate commit must match execution identity',
        });
      }
      if (candidateArtifact.artifact.profileDigest !== value.scope.releaseProfileDigest) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation context candidate must bind the scope profile digest',
        });
      }
      if (candidateArtifact.artifact.payloadSha256 !== value.identity.runnerDigest) {
        context.addIssue({
          code: 'custom',
          path: ['candidate', 'artifacts'],
          message: 'live observation context candidate payload must bind the runner digest',
        });
      }
    }
    if (value.governance.retentionClass !== 'ephemeral_local') {
      context.addIssue({
        code: 'custom',
        path: ['governance', 'retentionClass'],
        message: 'AQ-2 live observation context is local ephemeral only',
      });
    }
    if (!value.scope.route) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'route'],
        message: 'live observation context requires a metadata-only route identity',
      });
    }
    if (value.scope.platformIdentity !== value.execution.platformIdentity) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'platformIdentity'],
        message: 'live observation context scope must match execution platform',
      });
    }
  });

export type LiveCompatibilityObservationVerifierContextMaterialV1 = z.infer<
  typeof liveObservationVerifierContextMaterialV1Schema
>;

export function computeLiveCompatibilityObservationVerifierContextDigestV1(
  material: LiveCompatibilityObservationVerifierContextMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-observation-verifier-context.v1',
    canonicalJsonBytes(liveObservationVerifierContextMaterialV1Schema.parse(material)),
  );
}

export const liveCompatibilityObservationVerifierContextV1Schema =
  liveObservationVerifierContextMaterialV1Schema
    .extend({ contextDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { contextDigest, ...material } = value;
      const expected = computeLiveCompatibilityObservationVerifierContextDigestV1(material);
      if (contextDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['contextDigest'],
          message: `live observation verifier context digest mismatch: expected ${expected}`,
        });
      }
    });

export type LiveCompatibilityObservationVerifierContextV1 = z.infer<
  typeof liveCompatibilityObservationVerifierContextV1Schema
>;

export function buildLiveCompatibilityObservationVerifierContextV1(
  material: LiveCompatibilityObservationVerifierContextMaterialV1,
): LiveCompatibilityObservationVerifierContextV1 {
  const parsed = liveObservationVerifierContextMaterialV1Schema.parse(material);
  return liveCompatibilityObservationVerifierContextV1Schema.parse({
    ...parsed,
    contextDigest: computeLiveCompatibilityObservationVerifierContextDigestV1(parsed),
  });
}

const verificationResultV1Schema = z
  .object({
    requirementId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    assertionId: assertionIdSchema,
    status: z.enum(QUALIFICATION_DERIVED_STATES_V1),
    reasonCode: z.enum(QUALIFICATION_VERIFIER_REASON_CODES_V1),
    attemptId: safeIdentifierSchema.optional(),
  })
  .strict();

export type QualificationVerificationResultV1 = z.infer<typeof verificationResultV1Schema>;

const verificationReportMaterialV1Schema = z
  .object({
    schema: z.literal('AgentQualificationDiagnosticReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    verifierContextDigest: digestSchema.optional(),
    evidenceRecordDigest: digestSchema.optional(),
    candidateClosureDigest: digestSchema.optional(),
    results: z.array(verificationResultV1Schema),
  })
  .strict();

export type AgentQualificationDiagnosticReportMaterialV1 = z.infer<
  typeof verificationReportMaterialV1Schema
>;

export function computeAgentQualificationDiagnosticReportDigestV1(
  material: AgentQualificationDiagnosticReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.verifier-report.v1',
    canonicalJsonBytes(verificationReportMaterialV1Schema.parse(material)),
  );
}

export const agentQualificationDiagnosticReportV1Schema = verificationReportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const expected = computeAgentQualificationDiagnosticReportDigestV1(material);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `diagnostic verifier report digest mismatch: expected ${expected}`,
      });
    }
  });

export type AgentQualificationDiagnosticReportV1 = z.infer<
  typeof agentQualificationDiagnosticReportV1Schema
>;

function buildReport(
  material: AgentQualificationDiagnosticReportMaterialV1,
): AgentQualificationDiagnosticReportV1 {
  const parsed = verificationReportMaterialV1Schema.parse(material);
  return agentQualificationDiagnosticReportV1Schema.parse({
    ...parsed,
    reportDigest: computeAgentQualificationDiagnosticReportDigestV1(parsed),
  });
}

export const LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1 = ['observed', 'blocked'] as const;
export type LiveCompatibilityObservationDiagnosticStateV1 =
  (typeof LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1)[number];

export const LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1 = [
  'execution_identity_untrusted',
  'identity_drift',
  'input_invalid',
  'not_observed',
  'observed_cancelled',
  'observed_success',
  'retention_unavailable',
] as const;
export type LiveCompatibilityObservationReasonCodeV1 =
  (typeof LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1)[number];

const liveCompatibilityObservationDiagnosticReportMaterialV1Schema = z
  .object({
    schema: z.literal('LiveCompatibilityObservationDiagnosticReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    verifierContextDigest: digestSchema.optional(),
    observationRecordDigest: digestSchema.optional(),
    candidateClosureDigest: digestSchema.optional(),
    outcome: z.enum(['success', 'cancelled']).optional(),
    status: z.enum(LIVE_COMPATIBILITY_OBSERVATION_DIAGNOSTIC_STATES_V1),
    reasonCode: z.enum(LIVE_COMPATIBILITY_OBSERVATION_REASON_CODES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const observed = value.status === 'observed';
    if (observed !== (value.outcome !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'only observed reports may carry an outcome',
      });
    }
    if (
      (value.outcome === 'success' && value.reasonCode !== 'observed_success') ||
      (value.outcome === 'cancelled' && value.reasonCode !== 'observed_cancelled') ||
      (value.status === 'blocked' &&
        ![
          'execution_identity_untrusted',
          'identity_drift',
          'input_invalid',
          'not_observed',
          'retention_unavailable',
        ].includes(value.reasonCode))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live observation status, outcome, and reason code must agree',
      });
    }
    if (
      value.status === 'observed' &&
      (value.verifierContextDigest === undefined ||
        value.observationRecordDigest === undefined ||
        value.candidateClosureDigest === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'observed report must bind context, observation record, and candidate closure digests',
      });
    }
  });

export type LiveCompatibilityObservationDiagnosticReportMaterialV1 = z.infer<
  typeof liveCompatibilityObservationDiagnosticReportMaterialV1Schema
>;

export function computeLiveCompatibilityObservationDiagnosticReportDigestV1(
  material: LiveCompatibilityObservationDiagnosticReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-observation-verifier-report.v1',
    canonicalJsonBytes(
      liveCompatibilityObservationDiagnosticReportMaterialV1Schema.parse(material),
    ),
  );
}

export const liveCompatibilityObservationDiagnosticReportV1Schema =
  liveCompatibilityObservationDiagnosticReportMaterialV1Schema
    .extend({ reportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { reportDigest, ...material } = value;
      const expected = computeLiveCompatibilityObservationDiagnosticReportDigestV1(material);
      if (reportDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['reportDigest'],
          message: `live observation verifier report digest mismatch: expected ${expected}`,
        });
      }
    });

export type LiveCompatibilityObservationDiagnosticReportV1 = z.infer<
  typeof liveCompatibilityObservationDiagnosticReportV1Schema
>;

function buildLiveCompatibilityObservationDiagnosticReport(
  material: LiveCompatibilityObservationDiagnosticReportMaterialV1,
): LiveCompatibilityObservationDiagnosticReportV1 {
  const parsed = liveCompatibilityObservationDiagnosticReportMaterialV1Schema.parse(material);
  return liveCompatibilityObservationDiagnosticReportV1Schema.parse({
    ...parsed,
    reportDigest: computeLiveCompatibilityObservationDiagnosticReportDigestV1(parsed),
  });
}

/**
 * A missing or deliberately zero-network L3 run is not an observation. Keep
 * that distinction explicit instead of manufacturing a success/cancelled
 * `LiveCompatibilityObservationV1` merely to obtain a report digest.
 */
export function buildLiveCompatibilityNotObservedReportV1(
  contextInput?: unknown,
): LiveCompatibilityObservationDiagnosticReportV1 {
  const context = liveCompatibilityObservationVerifierContextV1Schema.safeParse(contextInput);
  return buildLiveCompatibilityObservationDiagnosticReport({
    schema: 'LiveCompatibilityObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context.success ? { verifierContextDigest: context.data.contextDigest } : {}),
    ...(context.success ? { candidateClosureDigest: context.data.candidate.closureDigest } : {}),
    status: 'blocked',
    reasonCode: 'not_observed',
  });
}

function sameRoute(
  left: DiagnosticRouteIdentityV1 | undefined,
  right: DiagnosticRouteIdentityV1 | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.routeAlias === right.routeAlias &&
    left.model === right.model &&
    left.protocolFamily === right.protocolFamily &&
    left.routeIdentityDigest === right.routeIdentityDigest &&
    left.providerDataPolicyDigest === right.providerDataPolicyDigest &&
    left.promptEnvironmentDigest === right.promptEnvironmentDigest &&
    left.toolCatalogDigest === right.toolCatalogDigest &&
    left.capabilityDeclarationDigest === right.capabilityDeclarationDigest
  );
}

function sameScope(left: QualificationAttemptScopeV1, right: QualificationAttemptScopeV1): boolean {
  return (
    left.platformIdentity === right.platformIdentity &&
    left.releaseProfileDigest === right.releaseProfileDigest &&
    left.entrypoint === right.entrypoint &&
    left.testPolicyDigest === right.testPolicyDigest &&
    left.routePolicyDigest === right.routePolicyDigest &&
    sameRoute(left.route, right.route)
  );
}

function sameIdentity(
  left: QualificationAttemptIdentityV1,
  right: QualificationAttemptIdentityV1,
): boolean {
  return (
    left.matrixDigest === right.matrixDigest &&
    left.suiteDigest === right.suiteDigest &&
    left.oracleDigest === right.oracleDigest &&
    left.corpusDigest === right.corpusDigest &&
    left.evaluatorDigest === right.evaluatorDigest &&
    left.verifierDigest === right.verifierDigest &&
    left.runnerDigest === right.runnerDigest
  );
}

function sameReceipt(
  left: QualificationReceiptBindingV1 | undefined,
  right: QualificationReceiptBindingV1 | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.receiptId === right.receiptId &&
    left.receiptDigest === right.receiptDigest
  );
}

function sameSuite(
  left: QualificationSuiteBindingV1,
  right: QualificationVerifierContextV1['suite'],
): boolean {
  return (
    left.suiteId === right.suiteId &&
    left.suiteDigest === right.suiteDigest &&
    left.role === right.role
  );
}

function sameCandidate(
  left: AgentQualificationEvidenceV1['candidate'],
  right: QualificationVerifierContextV1['candidate'],
): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    left.closureDigest === right.closureDigest &&
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameDiagnosticCandidateClosure(
  left: DiagnosticCandidateArtifactClosureV1,
  right: DiagnosticCandidateArtifactClosureV1,
): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    left.closureDigest === right.closureDigest &&
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameExecution(left: DiagnosticExecutionV1, right: DiagnosticExecutionV1): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    left.executionDigest === right.executionDigest &&
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameExecutionSet(
  left: readonly DiagnosticExecutionV1[],
  right: readonly DiagnosticExecutionV1[],
): boolean {
  if (left.length !== right.length) return false;
  const expectedById = new Map(right.map((execution) => [execution.executionId, execution]));
  return left.every((execution) => {
    const expected = expectedById.get(execution.executionId);
    return expected !== undefined && sameExecution(execution, expected);
  });
}

function governanceIsUsable(
  governance: EvidenceGovernanceBindingV1,
  createdAt: string,
  now: Date,
  scopes: readonly QualificationAttemptScopeV1[],
  dayQuotaLedger: EvidenceQuotaLedgerV1,
  monthQuotaLedger: EvidenceQuotaLedgerV1,
  retentionWitness: EvidenceRetentionWitnessV1,
): boolean {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles[governance.retentionClass];
  if (
    governance.retentionClass === 'repository_declaration' ||
    governance.retentionClass === 'private_reserve'
  ) {
    return false;
  }
  if (
    governance.quotaLedgerDigests === undefined ||
    governance.storageDeletionWitnessDigest === undefined ||
    governance.quotaLedgerDigests.day !== dayQuotaLedger.recordDigest ||
    governance.quotaLedgerDigests.month !== monthQuotaLedger.recordDigest ||
    governance.storageDeletionWitnessDigest !== retentionWitness.recordDigest ||
    dayQuotaLedger.profileId !== governance.profileId ||
    dayQuotaLedger.profileDigest !== governance.profileDigest ||
    dayQuotaLedger.period !== 'day' ||
    dayQuotaLedger.status !== 'reconciled' ||
    monthQuotaLedger.profileId !== governance.profileId ||
    monthQuotaLedger.profileDigest !== governance.profileDigest ||
    monthQuotaLedger.period !== 'month' ||
    monthQuotaLedger.status !== 'reconciled' ||
    retentionWitness.profileId !== governance.profileId ||
    retentionWitness.profileDigest !== governance.profileDigest ||
    retentionWitness.retentionClass !== governance.retentionClass
  ) {
    return false;
  }
  const routePolicyDigests = new Set(scopes.map((scope) => scope.routePolicyDigest));
  const createdAtDate = new Date(createdAt);
  if (!Number.isFinite(createdAtDate.getTime())) return false;
  const createdAtIso = createdAtDate.toISOString();
  const expectedDayPeriodStart = createdAtIso.slice(0, 10);
  const expectedMonthPeriodStart = `${createdAtIso.slice(0, 7)}-01`;
  if (
    routePolicyDigests.size !== 1 ||
    scopes.length === 0 ||
    dayQuotaLedger.routePolicyDigest !== scopes[0]?.routePolicyDigest ||
    monthQuotaLedger.routePolicyDigest !== scopes[0]?.routePolicyDigest ||
    dayQuotaLedger.reservationId !== monthQuotaLedger.reservationId ||
    dayQuotaLedger.periodStart !== expectedDayPeriodStart ||
    monthQuotaLedger.periodStart !== expectedMonthPeriodStart
  ) {
    return false;
  }
  const dayReconciled = dayQuotaLedger.reconciled;
  const monthReconciled = monthQuotaLedger.reconciled;
  if (
    !dayReconciled ||
    !monthReconciled ||
    !countersWithin(dayQuotaLedger.reserved, profile.quotas.perRun) ||
    !countersWithin(dayReconciled, profile.quotas.perRun) ||
    !countersWithin(dayQuotaLedger.reserved, profile.quotas.perDay) ||
    !countersWithin(dayReconciled, profile.quotas.perDay) ||
    !countersNoGreaterThan(dayReconciled, dayQuotaLedger.reserved) ||
    !countersWithin(monthQuotaLedger.reserved, profile.quotas.perRun) ||
    !countersWithin(monthReconciled, profile.quotas.perRun) ||
    !countersWithin(monthQuotaLedger.reserved, profile.quotas.perMonth) ||
    !countersWithin(monthReconciled, profile.quotas.perMonth) ||
    !countersNoGreaterThan(monthReconciled, monthQuotaLedger.reserved) ||
    dayReconciled.attempts !== scopes.length ||
    monthReconciled.attempts !== scopes.length
  ) {
    return false;
  }
  if (governance.retentionClass === 'protected_ci_retained') {
    if (!governance.expiresAt || !governance.retainedArtifactDigest) return false;
    const issued = Date.parse(createdAt);
    const expires = Date.parse(governance.expiresAt);
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      expires <= issued ||
      expires <= now.getTime()
    ) {
      return false;
    }
    if (typeof profile.retention.maxAgeSeconds !== 'number') return false;
    return (
      expires <= issued + profile.retention.maxAgeSeconds * 1_000 &&
      retentionWitness.expiresAt === governance.expiresAt &&
      retentionWitness.retainedArtifactDigest === governance.retainedArtifactDigest
    );
  }
  return (
    governance.retentionClass === 'ephemeral_local' &&
    retentionWitness.expiresAt === undefined &&
    retentionWitness.retainedArtifactDigest === undefined
  );
}

function countersWithin(
  counters: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
  limits: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number },
): boolean {
  return (
    counters.attempts <= limits.attempts &&
    counters.tokens <= limits.tokens &&
    counters.runWallClockSeconds <= limits.runWallClockSeconds &&
    counters.costUsdMicros <= limits.costUsdMicros
  );
}

function countersNoGreaterThan(
  counters: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
  reserved: {
    attempts: number;
    tokens: number;
    runWallClockSeconds: number;
    costUsdMicros: number;
  },
): boolean {
  return (
    counters.attempts <= reserved.attempts &&
    counters.tokens <= reserved.tokens &&
    counters.runWallClockSeconds <= reserved.runWallClockSeconds &&
    counters.costUsdMicros <= reserved.costUsdMicros
  );
}

function result(
  requirement: Pick<
    QualificationVerifierRequirementV1,
    'requirementId' | 'featureId' | 'assertionId'
  >,
  status: QualificationDerivedStateV1,
  reasonCode: QualificationVerifierReasonCodeV1,
  attemptId?: string,
): QualificationVerificationResultV1 {
  return {
    requirementId: requirement.requirementId,
    featureId: requirement.featureId,
    assertionId: requirement.assertionId,
    status,
    reasonCode,
    ...(attemptId ? { attemptId } : {}),
  };
}

function invalidReport(
  context: QualificationVerifierContextV1 | undefined,
): AgentQualificationDiagnosticReportV1 {
  const results = context
    ? context.requirements.map((requirement) => result(requirement, 'blocked', 'input_invalid'))
    : [
        {
          requirementId: 'input_invalid',
          featureId: 'DIAGNOSTIC-INPUT-000',
          assertionId: 'input_invalid',
          status: 'blocked' as const,
          reasonCode: 'input_invalid' as const,
        },
      ];
  return buildReport({
    schema: 'AgentQualificationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context ? { verifierContextDigest: context.contextDigest } : {}),
    ...(context ? { candidateClosureDigest: context.candidate.closureDigest } : {}),
    results,
  });
}

/**
 * Verify an independent diagnostic record against a trusted, closed context.
 * This function intentionally accepts only AgentQualificationEvidenceV1: a
 * live observation has no aggregate input position and therefore fails closed.
 */
function verifyQualificationEvidenceWithContextV1(
  evidenceInput: unknown,
  contextInput: unknown,
  now = new Date(),
  allowSourceOwnedBehavioralContext = false,
): AgentQualificationDiagnosticReportV1 {
  const contextResult = qualificationVerifierContextV1Schema.safeParse(contextInput);
  if (!contextResult.success) return invalidReport(undefined);
  const context = contextResult.data;
  if (context.suite.role === 'behavioral' && !allowSourceOwnedBehavioralContext) {
    return buildReport({
      schema: 'AgentQualificationDiagnosticReportV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      verifierContextDigest: context.contextDigest,
      results: context.requirements.map((requirement) =>
        result(requirement, 'blocked', 'behavioral_context_untrusted'),
      ),
    });
  }
  const evidenceResult = agentQualificationEvidenceV1Schema.safeParse(evidenceInput);
  if (!evidenceResult.success) return invalidReport(context);
  const evidence = evidenceResult.data;

  if (
    !sameCandidate(evidence.candidate, context.candidate) ||
    !sameQualificationGovernanceBindingV1(evidence.governance, context.governance) ||
    !sameExecutionSet(evidence.executions, context.executions) ||
    !sameSuite(evidence.suite, context.suite)
  ) {
    return buildReport({
      schema: 'AgentQualificationDiagnosticReportV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      verifierContextDigest: context.contextDigest,
      evidenceRecordDigest: evidence.recordDigest,
      candidateClosureDigest: evidence.candidate.closureDigest,
      results: context.requirements.map((requirement) =>
        result(requirement, 'blocked', 'identity_drift'),
      ),
    });
  }

  if (
    !governanceIsUsable(
      evidence.governance,
      evidence.createdAt,
      now,
      evidence.attempts.map((attempt) => attempt.scope),
      context.governanceWitnesses.dayQuotaLedger,
      context.governanceWitnesses.monthQuotaLedger,
      context.governanceWitnesses.retention,
    )
  ) {
    return buildReport({
      schema: 'AgentQualificationDiagnosticReportV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      verifierContextDigest: context.contextDigest,
      evidenceRecordDigest: evidence.recordDigest,
      candidateClosureDigest: evidence.candidate.closureDigest,
      results: context.requirements.map((requirement) =>
        result(requirement, 'blocked', 'retention_unavailable'),
      ),
    });
  }

  const attemptsByRequirement = new Map<string, AgentQualificationEvidenceV1['attempts'][number]>();
  let unexpectedAttempt = false;
  for (const attempt of evidence.attempts) {
    const requirement = context.requirements.find(
      (candidate) =>
        candidate.featureId === attempt.featureId &&
        candidate.assertionId === attempt.assertionId &&
        candidate.layer === attempt.layer &&
        sameScope(candidate.scope, attempt.scope) &&
        sameIdentity(candidate.identity, attempt.identity),
    );
    if (!requirement || attemptsByRequirement.has(requirement.requirementId)) {
      unexpectedAttempt = true;
      continue;
    }
    attemptsByRequirement.set(requirement.requirementId, attempt);
  }

  if (unexpectedAttempt) {
    return buildReport({
      schema: 'AgentQualificationDiagnosticReportV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      verifierContextDigest: context.contextDigest,
      evidenceRecordDigest: evidence.recordDigest,
      candidateClosureDigest: evidence.candidate.closureDigest,
      results: context.requirements.map((requirement) =>
        result(requirement, 'blocked', 'identity_drift'),
      ),
    });
  }

  const executionById = new Map(
    evidence.executions.map((execution) => [execution.executionId, execution]),
  );
  const results = context.requirements.map((requirement) => {
    const attempt = attemptsByRequirement.get(requirement.requirementId);
    if (!attempt) return result(requirement, 'blocked', 'not_observed');
    const execution = executionById.get(attempt.executionId);
    if (
      !execution ||
      execution.identity.source === 'external' ||
      execution.identity.source === 'github_maintainer_review' ||
      execution.identity.source === 'github_actions' ||
      (execution.identity.source === 'local_synthetic' &&
        evidence.governance.retentionClass !== 'ephemeral_local')
    ) {
      return result(requirement, 'blocked', 'execution_identity_untrusted', attempt.attemptId);
    }
    if (context.suite.role === 'behavioral' && !sameReceipt(attempt.receipt, requirement.receipt)) {
      return result(requirement, 'blocked', 'identity_drift', attempt.attemptId);
    }
    if (attempt.status === 'failed')
      return result(requirement, 'failed', 'assertion_failed', attempt.attemptId);
    if (attempt.status === 'blocked')
      return result(requirement, 'blocked', 'not_observed', attempt.attemptId);
    if (attempt.status === 'not_applicable') {
      if (requirement.expectedDisposition !== 'unsupported') {
        return result(requirement, 'blocked', 'identity_drift', attempt.attemptId);
      }
      const reason = attempt.reasonCode;
      if (
        reason === 'not_applicable_default_off_legacy_fallback' ||
        reason === 'not_applicable_manual_usability_disabled' ||
        reason === 'not_applicable_source_not_supported'
      ) {
        return result(requirement, 'unsupported', reason, attempt.attemptId);
      }
      return result(requirement, 'blocked', 'identity_drift', attempt.attemptId);
    }
    if (context.suite.role === 'structural_inventory') {
      return result(
        requirement,
        'blocked',
        'behavioral_evidence_not_registered',
        attempt.attemptId,
      );
    }
    if (requirement.expectedDisposition === 'verified_disabled') {
      return result(
        requirement,
        'verified_disabled',
        'disabled_behavior_verified',
        attempt.attemptId,
      );
    }
    return result(requirement, 'qualified', 'behavioral_evidence_registered', attempt.attemptId);
  });

  return buildReport({
    schema: 'AgentQualificationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    verifierContextDigest: context.contextDigest,
    evidenceRecordDigest: evidence.recordDigest,
    candidateClosureDigest: evidence.candidate.closureDigest,
    results,
  });
}

/**
 * The generic verifier remains structural-only.  AQ-3's source-owned L0
 * wrapper is the sole caller of this narrow behavioral entry point after it
 * has reconstructed the exact matrix, suite, evaluator report, and receipt
 * bindings.  It is intentionally not a release-path API.
 */
function verifySourceOwnedBehavioralQualificationEvidenceV1(
  evidenceInput: unknown,
  contextInput: unknown,
  now = new Date(),
): AgentQualificationDiagnosticReportV1 {
  return verifyQualificationEvidenceWithContextV1(evidenceInput, contextInput, now, true);
}

/**
 * Verify structural inventory evidence only.  A caller cannot turn an
 * arbitrary behavioral context into a positive diagnostic result through
 * this generic API.
 */
export function verifyAgentQualificationEvidenceV1(
  evidenceInput: unknown,
  contextInput: unknown,
  now = new Date(),
): AgentQualificationDiagnosticReportV1 {
  return verifyQualificationEvidenceWithContextV1(evidenceInput, contextInput, now, false);
}

/**
 * Verify one AQ-7 opaque native receipt through its dedicated, source-owned
 * path.  The L2 execution schema is the only narrow boundary in this module
 * that permits the protected GitHub execution identity; the generic verifier
 * above remains fail-closed for that source.
 *
 * This validates a receipt and its complete evaluator report as diagnostic
 * material only.  It does not construct a generic qualification record or a
 * cross-run aggregate, because that would require the protected-profile
 * quota/retention control plane to make one atomic claim across workers. No
 * non-forgeable control-plane witness exists in this implementation, so even
 * an otherwise closed protected receipt has a stable blocked result.
 */
export function verifyL2NativeConformanceReceiptV1(
  input: unknown,
): AgentQualificationDiagnosticReportV1 {
  const parsedInput = l2NativeConformanceReceiptVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const { receipt, provenance, evaluatorReport } = parsedInput.data;

  try {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
    const sourceRegistry = buildL2NativeConformanceSourceRegistryV1();
    const nativeSuite = buildL2NativeConformanceSuiteV1();
    const evaluator = buildL2NativeConformanceEvaluatorV1();
    const catalogSuite = catalog.suites.find(
      (candidate) => candidate.suiteId === L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
    );
    const bindings = discoverSourceOwnedL2NativeConformanceBindingsV1();
    assertSourceOwnedL2NativeConformanceBindingProvenanceV1(bindings);
    const matchingBindings = bindings.filter(
      (binding) => binding.assertionId === receipt.assertionId,
    );
    const binding = matchingBindings[0];

    if (
      !catalogSuite ||
      matchingBindings.length !== 1 ||
      !binding ||
      !sameCanonicalValueV1(catalog.l2NativeConformanceEvaluator, evaluator) ||
      computeQualificationEvaluatorDigestV1(evaluator) !== catalogSuite.evaluatorDigest ||
      !sameStringInventoryV1(catalogSuite.assertionIds, L2_NATIVE_CONFORMANCE_CASE_IDS_V1)
    ) {
      throw new Error('l2_native_catalog_identity_drift');
    }

    const feature = matrix.features.find(
      (candidate) =>
        candidate.id === binding.featureId && candidate.sourceSurfaceId === binding.sourceSurfaceId,
    );
    if (
      !feature ||
      !hasSourceOwnedL2NativeRequirementV1(feature, binding.assertionId) ||
      receipt.sourceSurfaceId !== binding.sourceSurfaceId ||
      receipt.featureId !== binding.featureId ||
      receipt.assertionId !== binding.assertionId ||
      receipt.sourceBindingDigest !== binding.sourceDigest ||
      !sameCanonicalValueV1(receipt.case, binding.case)
    ) {
      throw new Error('l2_native_source_binding_drift');
    }

    if (
      provenance.matrixDigest !== matrix.matrixDigest ||
      provenance.sourceRegistryDigest !== sourceRegistry.sourceRegistryDigest ||
      !sameCanonicalValueV1(provenance.suite, nativeSuite) ||
      !sameCanonicalValueV1(provenance.evaluator, evaluator) ||
      !sameQualificationGovernanceBindingV1(provenance.governance, receipt.governance) ||
      receipt.provenanceContextDigest !== provenance.contextDigest ||
      receipt.matrixDigest !== matrix.matrixDigest ||
      receipt.suiteId !== L2_NATIVE_CONFORMANCE_SUITE_ID_V1 ||
      receipt.suiteDigest !== nativeSuite.suiteDigest ||
      receipt.oracleDigest !== evaluator.oracleDigest ||
      receipt.corpusDigest !== nativeSuite.corpusDigest ||
      receipt.evaluatorDigest !== evaluator.evaluatorDigest ||
      receipt.verifierDigest !== evaluator.verifierDigest ||
      receipt.runnerDigest !== evaluator.runnerDigest ||
      receipt.platformVerifierDigest !== receipt.probe.platformVerifierDigest ||
      receipt.evaluatorReportDigest !== evaluatorReport.reportDigest
    ) {
      throw new Error('l2_native_provenance_identity_drift');
    }

    if (
      receipt.scope.platformIdentity !== binding.case.target.distributionTargetId ||
      receipt.scope.entrypoint !== binding.case.entrypoint ||
      receipt.scope.releaseProfileDigest !== receipt.candidate.artifact.profileDigest ||
      receipt.candidate.target.distributionTargetId !== binding.case.target.distributionTargetId ||
      receipt.execution.target.distributionTargetId !== binding.case.target.distributionTargetId ||
      receipt.probe.target.distributionTargetId !== binding.case.target.distributionTargetId ||
      receipt.execution.identity.source !== 'github_actions' ||
      receipt.execution.identity.commit !== receipt.candidate.artifact.commit ||
      receipt.execution.identity.canonicalRepository !==
        receipt.candidate.artifact.canonicalRepository ||
      receipt.execution.identity.repositoryId !== receipt.candidate.artifact.repositoryId
    ) {
      throw new Error('l2_native_candidate_execution_scope_drift');
    }

    if (!sameCanonicalValueV1(evaluatorReport.evaluator, evaluator)) {
      throw new Error('l2_native_report_evaluator_drift');
    }
    const rebuiltReport = evaluateL2NativeConformanceCorpusV1({
      evaluator,
      observations: evaluatorReport.observations,
    });
    if (!sameCanonicalValueV1(evaluatorReport, rebuiltReport)) {
      throw new Error('l2_native_report_derivation_drift');
    }
    const matchingObservations = evaluatorReport.observations.filter(
      (observation) => observation.case.caseId === binding.case.caseId,
    );
    const matchingResults = evaluatorReport.results.filter(
      (entry) => entry.caseId === binding.case.caseId,
    );
    const observation = matchingObservations[0];
    const evaluated = matchingResults[0];
    if (
      matchingObservations.length !== 1 ||
      matchingResults.length !== 1 ||
      !observation ||
      !evaluated ||
      !sameCanonicalValueV1(observation.case, receipt.case) ||
      !sameCanonicalValueV1(observation.candidate, receipt.candidate) ||
      !sameCanonicalValueV1(observation.execution, receipt.execution) ||
      !sameCanonicalValueV1(observation.probe, receipt.probe) ||
      evaluated.observationDigest !== observation.observationDigest ||
      receipt.outcome !== evaluated.status ||
      receipt.reasonCode !== evaluated.reasonCode
    ) {
      throw new Error('l2_native_receipt_report_closure_drift');
    }

    const verifierContextDigest = computeL2NativeConformanceReceiptVerifierContextDigestV1({
      schema: 'L2NativeConformanceReceiptVerifierContextV1',
      version: 1,
      matrixDigest: matrix.matrixDigest,
      sourceRegistryDigest: sourceRegistry.sourceRegistryDigest,
      sourceSurfaceId: binding.sourceSurfaceId,
      sourceBindingDigest: binding.sourceDigest,
      featureId: binding.featureId,
      assertionId: binding.assertionId,
      suiteDigest: nativeSuite.suiteDigest,
      oracleDigest: evaluator.oracleDigest,
      corpusDigest: nativeSuite.corpusDigest,
      evaluatorDigest: evaluator.evaluatorDigest,
      verifierDigest: evaluator.verifierDigest,
      runnerDigest: evaluator.runnerDigest,
      candidateDigest: receipt.candidate.candidateDigest,
      executionDigest: receipt.execution.executionDigest,
      probeBindingDigest: receipt.probe.probeBindingDigest,
      platformVerifierDigest: receipt.probe.platformVerifierDigest,
      evaluatorReportDigest: evaluatorReport.reportDigest,
      receiptDigest: receipt.receiptDigest,
      governance: receipt.governance,
    });
    return buildReport({
      schema: 'AgentQualificationDiagnosticReportV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      verifierContextDigest,
      results: [
        result(
          {
            requirementId: `l2-native-requirement:${binding.sourceSurfaceId}:${binding.assertionId}`,
            featureId: binding.featureId,
            assertionId: binding.assertionId,
          },
          'blocked',
          'retention_unavailable',
        ),
      ],
    });
  } catch {
    return invalidReport(undefined);
  }
}

/**
 * Reconstruct and verify the sole AQ-3 behavioral path. This accepts neither
 * a caller-provided Feature map nor a caller-provided suite identity: both
 * are regenerated from product-owned declarations before the generic
 * evidence logic sees a context. All output remains diagnostic-only.
 */
export function verifyL0ContractEvidenceV1(
  input: unknown,
  now = new Date(),
): AgentQualificationDiagnosticReportV1 {
  const parsedInput = l0ContractEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
    const suite = catalog.suites.find((candidate) => candidate.suiteId === L0_CONTRACT_SUITE_ID_V1);
    if (!suite) throw new Error('l0_suite_missing');
    const evaluator = l0EvaluatorIdentityV1Schema.parse(catalog.l0Evaluator);
    if (
      !sameCanonicalValueV1(evaluator, catalog.l0Evaluator) ||
      computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
    ) {
      throw new Error('l0_evaluator_identity_drift');
    }
    const evaluatorReport = runL0ContractCorpusV1({ evaluator });
    const sourceBinding = discoverSourceOwnedL0ContractBindingsV1().find(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (!sourceBinding) throw new Error(`l0_source_binding_unknown:${parsed.sourceSurfaceId}`);
    const bindings = [sourceBinding];
    const expectedSourceSurfaceIds = [sourceBinding.sourceSurfaceId];
    const scopesBySourceSurface = exactL0ScopesBySourceSurfaceV1(
      parsed.scopes,
      expectedSourceSurfaceIds,
    );
    const receiptsBySourceSurface = exactL0ReceiptsBySourceSurfaceV1(
      parsed.receipts,
      expectedSourceSurfaceIds,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL0RequirementV1(feature, binding.binding.assertionId, suite.suiteDigest)
      ) {
        throw new Error(`l0_feature_requirement_drift:${binding.sourceSurfaceId}`);
      }
      const receipt = receiptsBySourceSurface.get(binding.sourceSurfaceId);
      if (!receipt) throw new Error(`l0_receipt_missing:${binding.sourceSurfaceId}`);
      const expectedReceipt = buildL0ContractReceiptV1({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        binding: binding.binding,
        matrixDigest: matrix.matrixDigest,
        suiteDigest: suite.suiteDigest,
        evaluatorReport,
        adapterResult: runL0ContractAdapterV1(binding.binding),
      });
      if (!sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error(`l0_receipt_identity_drift:${binding.sourceSurfaceId}`);
      }
      const scope = scopesBySourceSurface.get(binding.sourceSurfaceId);
      if (!scope) throw new Error(`l0_scope_missing:${binding.sourceSurfaceId}`);
      const matchingAttempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'contract',
      );
      if (
        matchingAttempts.length === 1 &&
        !attemptMatchesL0ReceiptOutcomeV1(matchingAttempts[0]!, expectedReceipt)
      ) {
        throw new Error(`l0_attempt_receipt_outcome_mismatch:${binding.sourceSurfaceId}`);
      }
      return {
        requirementId: `l0-requirement:${binding.sourceSurfaceId}:${binding.binding.assertionId}`,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'contract',
        scope,
        identity: {
          matrixDigest: matrix.matrixDigest,
          suiteDigest: suite.suiteDigest,
          oracleDigest: suite.oracleDigest,
          corpusDigest: suite.corpusDigest,
          evaluatorDigest: suite.evaluatorDigest,
          verifierDigest: evaluator.verifierDigest,
          runnerDigest: evaluator.runnerDependencyDigest,
        },
        receipt: l0ContractReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: suite.suiteId,
        suiteDigest: suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

export interface SourceOwnedL1ToolVerificationReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1ToolVerificationEvaluatorIdentityV1Schema>;
  evaluatorReport: Awaited<ReturnType<typeof runL1ToolVerificationContractCorpusV1>>;
  adapterResults: Awaited<ReturnType<typeof runL1ToolVerificationAdaptersV1>>;
  bindings: ReturnType<typeof discoverSourceOwnedL1ToolVerificationBindingsV1>;
  receipts: readonly L1ToolVerificationReceiptV1[];
}

/**
 * Rebuild the full L1 behavioral snapshot from source-owned declarations and
 * a fresh sealed corpus run. This is intentionally diagnostic-only; callers
 * still need the specialized verifier below to bind a candidate/execution/
 * governance record to one source surface's receipts.
 */
export async function reconstructSourceOwnedL1ToolVerificationV1(): Promise<SourceOwnedL1ToolVerificationReconstructionV1> {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === L1_TOOL_VERIFICATION_SUITE_ID_V1,
  );
  if (!suite) throw new Error('l1_tool_verification_suite_missing');
  const catalogSuite = bindL1ToolVerificationCatalogSuiteV1(suite);
  const evaluator = l1ToolVerificationEvaluatorIdentityV1Schema.parse(catalog.l1Evaluator);
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1Evaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_tool_verification_evaluator_identity_drift');
  }
  const evaluatorReport = await runL1ToolVerificationContractCorpusV1({ evaluator });
  const adapterResults = await runL1ToolVerificationAdaptersV1();
  const bindings = discoverSourceOwnedL1ToolVerificationBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error('l1_tool_verification_adapter_result_missing:' + binding.binding.adapterId);
    }
    return buildL1ToolVerificationReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      suiteDigest: suite.suiteDigest,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

export interface SourceOwnedL1AutoCompactionFailureReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1AutoCompactionFailureEvaluatorIdentityV1Schema>;
  evaluatorReport: Awaited<ReturnType<typeof runL1AutoCompactionFailureContractCorpusV1>>;
  adapterResults: Awaited<ReturnType<typeof runL1AutoCompactionFailureAdaptersV1>>;
  bindings: ReturnType<typeof discoverSourceOwnedL1AutoCompactionFailureBindingsV1>;
  receipts: readonly L1AutoCompactionFailureReceiptV1[];
}

/**
 * Rebuild AQ-9A from the product-owned admission declaration and fresh local
 * transport faults. No caller can provide a model result, prompt, route,
 * workspace, compactor, or source/feature mapping.
 */
export async function reconstructSourceOwnedL1AutoCompactionFailureV1(): Promise<SourceOwnedL1AutoCompactionFailureReconstructionV1> {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
  );
  if (!suite) throw new Error('l1_auto_compaction_failure_suite_missing');
  const catalogSuite = bindL1AutoCompactionFailureCatalogSuiteV1(suite);
  const evaluator = l1AutoCompactionFailureEvaluatorIdentityV1Schema.parse(
    catalog.l1AutoCompactionFailureEvaluator,
  );
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1AutoCompactionFailureEvaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_auto_compaction_failure_evaluator_identity_drift');
  }
  const evaluatorReport = await runL1AutoCompactionFailureContractCorpusV1({ evaluator });
  const adapterResults = await runL1AutoCompactionFailureAdaptersV1();
  const bindings = discoverSourceOwnedL1AutoCompactionFailureBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error(
        `l1_auto_compaction_failure_adapter_result_missing:${binding.binding.adapterId}`,
      );
    }
    return buildL1AutoCompactionFailureReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      suiteDigest: suite.suiteDigest,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

export interface SourceOwnedL1SkillMcpReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1SkillMcpEvaluatorIdentityV1Schema>;
  evaluatorReport: Awaited<ReturnType<typeof runL1SkillMcpContractCorpusV1>>;
  adapterResults: Awaited<ReturnType<typeof runL1SkillMcpAdaptersV1>>;
  bindings: ReturnType<typeof discoverSourceOwnedL1SkillMcpBindingsV1>;
  receipts: readonly L1SkillMcpReceiptV1[];
}

/**
 * Rebuild AQ-5's sealed Skill/MCP snapshot from product-owned declarations,
 * then rerun the in-memory corpus. The catalog's evaluator identity is passed
 * through to the runner so a locally rebuilt report cannot detach from the
 * source facts, fixture, runner, and six exact source bindings.
 */
export async function reconstructSourceOwnedL1SkillMcpV1(): Promise<SourceOwnedL1SkillMcpReconstructionV1> {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find((candidate) => candidate.suiteId === L1_SKILL_MCP_SUITE_ID_V1);
  if (!suite) throw new Error('l1_skill_mcp_suite_missing');
  const catalogSuite = bindL1SkillMcpCatalogSuiteV1(suite);
  const evaluator = l1SkillMcpEvaluatorIdentityV1Schema.parse(catalog.l1SkillMcpEvaluator);
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1SkillMcpEvaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_skill_mcp_evaluator_identity_drift');
  }
  const evaluatorReport = await runL1SkillMcpContractCorpusV1({ evaluator });
  const adapterResults = await runL1SkillMcpAdaptersV1();
  const bindings = discoverSourceOwnedL1SkillMcpBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error('l1_skill_mcp_adapter_result_missing:' + binding.binding.adapterId);
    }
    return buildL1SkillMcpReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      suiteDigest: suite.suiteDigest,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

export interface SourceOwnedL1SubagentRecoveryReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1SubagentRecoveryEvaluatorIdentityV1Schema>;
  evaluatorReport: Awaited<ReturnType<typeof runL1SubagentRecoveryContractCorpusV1>>;
  adapterResults: Awaited<ReturnType<typeof runL1SubagentRecoveryAdaptersV1>>;
  bindings: ReturnType<typeof discoverSourceOwnedL1SubagentRecoveryBindingsV1>;
  receipts: readonly L1SubagentRecoveryReceiptV1[];
}

/**
 * Rebuild AQ-6's cut-point suite from current source owners and rerun each
 * sealed synthetic adapter. Caller-supplied reports, continuations, and
 * child payloads have no input position.
 */
export async function reconstructSourceOwnedL1SubagentRecoveryV1(): Promise<SourceOwnedL1SubagentRecoveryReconstructionV1> {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
  );
  if (!suite) throw new Error('l1_subagent_recovery_suite_missing');
  const catalogSuite = bindL1SubagentRecoveryCatalogSuiteV1(suite);
  const evaluator = l1SubagentRecoveryEvaluatorIdentityV1Schema.parse(
    catalog.l1SubagentRecoveryEvaluator,
  );
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1SubagentRecoveryEvaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_subagent_recovery_evaluator_identity_drift');
  }
  const evaluatorReport = await runL1SubagentRecoveryContractCorpusV1({ evaluator });
  const adapterResults = await runL1SubagentRecoveryAdaptersV1();
  const bindings = discoverSourceOwnedL1SubagentRecoveryBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error('l1_subagent_recovery_adapter_result_missing:' + binding.binding.adapterId);
    }
    return buildL1SubagentRecoveryReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      suiteDigest: suite.suiteDigest,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

export interface SourceOwnedL1TuiRewindForkProjectionReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1TuiRewindForkProjectionEvaluatorIdentityV1Schema>;
  evaluatorReport: Awaited<ReturnType<typeof runL1TuiRewindForkProjectionContractCorpusV1>>;
  adapterResults: Awaited<ReturnType<typeof runL1TuiRewindForkProjectionAdaptersV1>>;
  bindings: ReturnType<typeof discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1>;
  receipts: readonly L1TuiRewindForkProjectionReceiptV1[];
}

/**
 * Rebuild AQ-6's real public `/rewind` projection from the product-owned
 * source declaration and rerun the isolated Ink-to-store path. The caller
 * cannot supply an observation, fixture root, workspace, or hook result.
 */
export async function reconstructSourceOwnedL1TuiRewindForkProjectionV1(): Promise<SourceOwnedL1TuiRewindForkProjectionReconstructionV1> {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
  );
  if (!suite) throw new Error('l1_tui_rewind_fork_projection_suite_missing');
  const catalogSuite = bindL1TuiRewindForkProjectionCatalogSuiteV1(suite);
  const evaluator = l1TuiRewindForkProjectionEvaluatorIdentityV1Schema.parse(
    catalog.l1TuiRewindForkProjectionEvaluator,
  );
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1TuiRewindForkProjectionEvaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_tui_rewind_fork_projection_evaluator_identity_drift');
  }
  const evaluatorReport = await runL1TuiRewindForkProjectionContractCorpusV1({ evaluator });
  const adapterResults = await runL1TuiRewindForkProjectionAdaptersV1();
  const bindings = discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error(
        'l1_tui_rewind_fork_projection_adapter_result_missing:' + binding.binding.adapterId,
      );
    }
    return buildL1TuiRewindForkProjectionReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      matrixSuite: suite,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

export interface SourceOwnedL1PublicProjectionReconstructionV1 {
  catalog: ReturnType<typeof createSourceOwnedQualificationCatalogV1>;
  matrix: ReturnType<typeof generateAgentFeatureQualificationMatrixV1>;
  suite: ReturnType<typeof createSourceOwnedQualificationCatalogV1>['suites'][number];
  evaluator: z.infer<typeof l1PublicProjectionEvaluatorIdentityV1Schema>;
  evaluatorReport: ReturnType<typeof runL1PublicProjectionContractCorpusV1>;
  adapterResults: ReturnType<typeof runL1PublicProjectionAdaptersV1>;
  bindings: ReturnType<typeof discoverSourceOwnedL1PublicProjectionBindingsV1>;
  receipts: readonly L1PublicProjectionReceiptV1[];
}

/** Rebuild the source-owned public-projection snapshot from fresh local calls. */
export function reconstructSourceOwnedL1PublicProjectionV1(): SourceOwnedL1PublicProjectionReconstructionV1 {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === L1_PUBLIC_PROJECTION_SUITE_ID_V1,
  );
  if (!suite) throw new Error('l1_public_projection_suite_missing');
  const catalogSuite = bindL1PublicProjectionCatalogSuiteV1(suite);
  const evaluator = l1PublicProjectionEvaluatorIdentityV1Schema.parse(
    catalog.l1ProjectionEvaluator,
  );
  if (
    !sameCanonicalValueV1(evaluator, catalog.l1ProjectionEvaluator) ||
    catalogSuite.suiteDigest !== suite.suiteDigest ||
    computeQualificationEvaluatorDigestV1(evaluator) !== suite.evaluatorDigest
  ) {
    throw new Error('l1_public_projection_evaluator_identity_drift');
  }
  const evaluatorReport = runL1PublicProjectionContractCorpusV1({ evaluator });
  const adapterResults = runL1PublicProjectionAdaptersV1();
  const bindings = discoverSourceOwnedL1PublicProjectionBindingsV1();
  const receipts = bindings.map((binding) => {
    const adapterResult = adapterResults.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!adapterResult) {
      throw new Error('l1_public_projection_adapter_result_missing:' + binding.binding.adapterId);
    }
    return buildL1PublicProjectionReceiptV1({
      sourceSurfaceId: binding.sourceSurfaceId,
      featureId: binding.featureId,
      binding: binding.binding,
      matrixDigest: matrix.matrixDigest,
      matrixSuite: suite,
      evaluatorReport,
      adapterResult,
    });
  });
  return {
    catalog,
    matrix,
    suite,
    evaluator,
    evaluatorReport,
    adapterResults,
    bindings,
    receipts,
  };
}

/**
 * Verify one source-owned L1 behavioral evidence record. The closed corpus is
 * always rerun; a caller-supplied evaluator report or source/feature map has
 * no input position and therefore fails the strict schema.
 */
export async function verifyL1ToolVerificationEvidenceV1(
  input: unknown,
  now = new Date(),
): Promise<AgentQualificationDiagnosticReportV1> {
  const parsedInput = l1ToolVerificationEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = await reconstructSourceOwnedL1ToolVerificationV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      L1_TOOL_VERIFICATION_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      L1_TOOL_VERIFICATION_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error('l1_tool_verification_source_binding_unknown:' + parsed.sourceSurfaceId);
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const receiptsByAssertion = exactL1ReceiptsForBindingsV1(
      parsed.receipts,
      bindings,
      reconstructed.receipts,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(
          feature,
          L1_TOOL_VERIFICATION_SUITE_ID_V1,
          binding.binding.assertionId,
        )
      ) {
        throw new Error(
          'l1_tool_verification_feature_requirement_drift:' + binding.sourceSurfaceId,
        );
      }
      const expectedReceipt = reconstructed.receipts.find(
        (receipt) =>
          receipt.sourceSurfaceId === binding.sourceSurfaceId &&
          receipt.assertionId === binding.binding.assertionId,
      );
      const receipt = receiptsByAssertion.get(binding.binding.assertionId);
      if (!expectedReceipt || !receipt || !sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error(
          'l1_tool_verification_receipt_identity_drift:' + binding.binding.assertionId,
        );
      }
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        attempts.length !== 1 ||
        !attemptMatchesL1ReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          'l1_tool_verification_attempt_receipt_outcome_mismatch:' + binding.binding.assertionId,
        );
      }
      return {
        requirementId:
          'l1-tool-requirement:' + binding.sourceSurfaceId + ':' + binding.binding.assertionId,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: l1ToolVerificationReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

/**
 * Candidate-bound verifier for AQ-9A's three local fault receipts. It always
 * reconstructs the source-owned Matrix/suite and reruns the zero-network
 * adapter; caller-provided event payloads, errors, prompts, or model output
 * have no schema position.
 */
export async function verifyL1AutoCompactionFailureEvidenceV1(
  input: unknown,
  now = new Date(),
): Promise<AgentQualificationDiagnosticReportV1> {
  const parsedInput = l1AutoCompactionFailureEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = await reconstructSourceOwnedL1AutoCompactionFailureV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
      L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
      L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error(
        `l1_auto_compaction_failure_source_binding_unknown:${parsed.sourceSurfaceId}`,
      );
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
    if (
      !sameStringInventoryV1(
        parsed.receipts.map((receipt) => receipt.assertionId),
        expectedAssertionIds,
      )
    ) {
      throw new Error('l1_auto_compaction_failure_receipt_inventory_drift');
    }
    const expectedReceiptsByAssertion = new Map(
      reconstructed.receipts
        .filter((receipt) => receipt.sourceSurfaceId === parsed.sourceSurfaceId)
        .map((receipt) => [receipt.assertionId, receipt]),
    );
    for (const receipt of parsed.receipts) {
      const expected = expectedReceiptsByAssertion.get(receipt.assertionId);
      if (!expected || !sameCanonicalValueV1(receipt, expected)) {
        throw new Error(`l1_auto_compaction_failure_receipt_identity_drift:${receipt.assertionId}`);
      }
    }
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(
          feature,
          L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
          binding.binding.assertionId,
        )
      ) {
        throw new Error(
          `l1_auto_compaction_failure_feature_requirement_drift:${binding.sourceSurfaceId}`,
        );
      }
      const expectedReceipt = expectedReceiptsByAssertion.get(binding.binding.assertionId);
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        !expectedReceipt ||
        attempts.length !== 1 ||
        !attemptMatchesL1AutoCompactionFailureReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          `l1_auto_compaction_failure_attempt_receipt_outcome_mismatch:${binding.binding.assertionId}`,
        );
      }
      return {
        requirementId: `l1-auto-compaction-failure-requirement:${binding.sourceSurfaceId}:${binding.binding.assertionId}`,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: l1AutoCompactionFailureReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

/**
 * Candidate-bound verifier for AQ-5's sealed Skill/MCP receipts. The only
 * caller-controlled data is independently issued candidate/execution/
 * governance context plus opaque receipt material. The feature mapping,
 * evaluator identity, matrix, corpus report, source binding, fixture, and
 * runner are always freshly reconstructed from source-owned declarations.
 */
export async function verifyL1SkillMcpEvidenceV1(
  input: unknown,
  now = new Date(),
): Promise<AgentQualificationDiagnosticReportV1> {
  const parsedInput = l1SkillMcpEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = await reconstructSourceOwnedL1SkillMcpV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_SKILL_MCP_FIXTURE_ID_V1,
      L1_SKILL_MCP_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_SKILL_MCP_FIXTURE_ID_V1,
      L1_SKILL_MCP_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error('l1_skill_mcp_source_binding_unknown:' + parsed.sourceSurfaceId);
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const receiptsByAssertion = exactL1SkillMcpReceiptsForBindingsV1(
      parsed.receipts,
      bindings,
      reconstructed.receipts,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(feature, L1_SKILL_MCP_SUITE_ID_V1, binding.binding.assertionId)
      ) {
        throw new Error('l1_skill_mcp_feature_requirement_drift:' + binding.sourceSurfaceId);
      }
      const expectedReceipt = reconstructed.receipts.find(
        (receipt) =>
          receipt.sourceSurfaceId === binding.sourceSurfaceId &&
          receipt.assertionId === binding.binding.assertionId,
      );
      const receipt = receiptsByAssertion.get(binding.binding.assertionId);
      if (!expectedReceipt || !receipt || !sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error('l1_skill_mcp_receipt_identity_drift:' + binding.binding.assertionId);
      }
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        attempts.length !== 1 ||
        !attemptMatchesL1SkillMcpReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          'l1_skill_mcp_attempt_receipt_outcome_mismatch:' + binding.binding.assertionId,
        );
      }
      return {
        requirementId:
          'l1-skill-mcp-requirement:' + binding.sourceSurfaceId + ':' + binding.binding.assertionId,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: l1SkillMcpReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

/**
 * Candidate-bound verifier for AQ-6 recovery receipts. It reconstructs the
 * source-owned cut-point inventory and reruns the sealed local adapters; raw
 * continuation, task, child-result, and workspace data have no caller input
 * position.
 */
export async function verifyL1SubagentRecoveryEvidenceV1(
  input: unknown,
  now = new Date(),
): Promise<AgentQualificationDiagnosticReportV1> {
  const parsedInput = l1SubagentRecoveryEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = await reconstructSourceOwnedL1SubagentRecoveryV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
      L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
      L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error('l1_subagent_recovery_source_binding_unknown:' + parsed.sourceSurfaceId);
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const receiptsByAssertion = exactL1SubagentRecoveryReceiptsForBindingsV1(
      parsed.receipts,
      bindings,
      reconstructed.receipts,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(
          feature,
          L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
          binding.binding.assertionId,
        )
      ) {
        throw new Error(
          'l1_subagent_recovery_feature_requirement_drift:' + binding.sourceSurfaceId,
        );
      }
      const expectedReceipt = reconstructed.receipts.find(
        (receipt) =>
          receipt.sourceSurfaceId === binding.sourceSurfaceId &&
          receipt.assertionId === binding.binding.assertionId,
      );
      const receipt = receiptsByAssertion.get(binding.binding.assertionId);
      if (!expectedReceipt || !receipt || !sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error(
          'l1_subagent_recovery_receipt_identity_drift:' + binding.binding.assertionId,
        );
      }
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        attempts.length !== 1 ||
        !attemptMatchesL1SubagentRecoveryReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          'l1_subagent_recovery_attempt_receipt_outcome_mismatch:' + binding.binding.assertionId,
        );
      }
      return {
        requirementId:
          'l1-subagent-recovery-requirement:' +
          binding.sourceSurfaceId +
          ':' +
          binding.binding.assertionId,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: l1SubagentRecoveryReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

/**
 * Candidate-bound verifier for AQ-6's public TUI `/rewind` projection. This
 * reruns the sealed temporary-root hook path and accepts metadata-only
 * diagnostic receipts; it has no release-evidence, gate, or admission input.
 */
export async function verifyL1TuiRewindForkProjectionEvidenceV1(
  input: unknown,
  now = new Date(),
): Promise<AgentQualificationDiagnosticReportV1> {
  const parsedInput = l1TuiRewindForkProjectionEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = await reconstructSourceOwnedL1TuiRewindForkProjectionV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
      L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
      L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error(
        'l1_tui_rewind_fork_projection_source_binding_unknown:' + parsed.sourceSurfaceId,
      );
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const receiptsByAssertion = exactL1TuiRewindForkProjectionReceiptsForBindingsV1(
      parsed.receipts,
      bindings,
      reconstructed.receipts,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(
          feature,
          L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
          binding.binding.assertionId,
        )
      ) {
        throw new Error(
          'l1_tui_rewind_fork_projection_feature_requirement_drift:' + binding.sourceSurfaceId,
        );
      }
      const expectedReceipt = reconstructed.receipts.find(
        (receipt) =>
          receipt.sourceSurfaceId === binding.sourceSurfaceId &&
          receipt.assertionId === binding.binding.assertionId,
      );
      const receipt = receiptsByAssertion.get(binding.binding.assertionId);
      if (!expectedReceipt || !receipt || !sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error(
          'l1_tui_rewind_fork_projection_receipt_identity_drift:' + binding.binding.assertionId,
        );
      }
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        attempts.length !== 1 ||
        !attemptMatchesL1TuiRewindForkProjectionReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          'l1_tui_rewind_fork_projection_attempt_receipt_outcome_mismatch:' +
            binding.binding.assertionId,
        );
      }
      return {
        requirementId:
          'l1-tui-rewind-fork-projection-requirement:' +
          binding.sourceSurfaceId +
          ':' +
          binding.binding.assertionId,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: l1TuiRewindForkProjectionReceiptBindingV1(expectedReceipt),
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

/** Source-owned candidate-bound verifier for the independent CLI/TUI receipts. */
export function verifyL1PublicProjectionEvidenceV1(
  input: unknown,
  now = new Date(),
): AgentQualificationDiagnosticReportV1 {
  const parsedInput = l1PublicProjectionEvidenceVerificationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return invalidReport(undefined);
  const parsed = parsedInput.data;
  try {
    const reconstructed = reconstructSourceOwnedL1PublicProjectionV1();
    assertExactL1SyntheticExecutionsV1(
      parsed.evidence.executions,
      L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
      L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
    );
    assertExactL1SyntheticExecutionsV1(
      parsed.trusted.executions,
      L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
      L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
    );
    const bindings = reconstructed.bindings.filter(
      (binding) => binding.sourceSurfaceId === parsed.sourceSurfaceId,
    );
    if (bindings.length === 0) {
      throw new Error('l1_public_projection_source_binding_unknown:' + parsed.sourceSurfaceId);
    }
    const scope = exactL1ScopeForSourceSurfaceV1(parsed.scopes, parsed.sourceSurfaceId);
    const receiptsByAssertion = exactL1PublicProjectionReceiptsForBindingsV1(
      parsed.receipts,
      bindings,
      reconstructed.receipts,
    );
    const requirements: QualificationVerifierRequirementV1[] = bindings.map((binding) => {
      const feature = reconstructed.matrix.features.find(
        (candidate) =>
          candidate.id === binding.featureId &&
          candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      if (
        !feature ||
        !hasExactL1RequirementV1(
          feature,
          L1_PUBLIC_PROJECTION_SUITE_ID_V1,
          binding.binding.assertionId,
        )
      ) {
        throw new Error(
          'l1_public_projection_feature_requirement_drift:' + binding.sourceSurfaceId,
        );
      }
      const expectedReceipt = reconstructed.receipts.find(
        (receipt) =>
          receipt.sourceSurfaceId === binding.sourceSurfaceId &&
          receipt.assertionId === binding.binding.assertionId,
      );
      const receipt = receiptsByAssertion.get(binding.binding.assertionId);
      if (!expectedReceipt || !receipt || !sameCanonicalValueV1(receipt, expectedReceipt)) {
        throw new Error(
          'l1_public_projection_receipt_identity_drift:' + binding.binding.assertionId,
        );
      }
      const attempts = parsed.evidence.attempts.filter(
        (attempt) =>
          attempt.featureId === binding.featureId &&
          attempt.assertionId === binding.binding.assertionId &&
          attempt.layer === 'scripted_runtime',
      );
      if (
        attempts.length !== 1 ||
        !attemptMatchesL1PublicProjectionReceiptOutcomeV1(attempts[0]!, expectedReceipt)
      ) {
        throw new Error(
          'l1_public_projection_attempt_receipt_outcome_mismatch:' + binding.binding.assertionId,
        );
      }
      return {
        requirementId:
          'l1-projection-requirement:' +
          binding.sourceSurfaceId +
          ':' +
          binding.binding.assertionId,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        scope,
        identity: {
          matrixDigest: reconstructed.matrix.matrixDigest,
          suiteDigest: reconstructed.suite.suiteDigest,
          oracleDigest: reconstructed.suite.oracleDigest,
          corpusDigest: reconstructed.suite.corpusDigest,
          evaluatorDigest: reconstructed.suite.evaluatorDigest,
          verifierDigest: reconstructed.evaluator.verifierDigest,
          runnerDigest: reconstructed.evaluator.runnerDigest,
        },
        receipt: {
          receiptId: expectedReceipt.receiptId,
          receiptDigest: expectedReceipt.receiptDigest,
        },
        expectedDisposition: 'behavioral_required',
      };
    });
    const context = buildQualificationVerifierContextV1({
      schema: 'QualificationVerifierContextV1',
      version: 1,
      candidate: parsed.trusted.candidate,
      governance: parsed.trusted.governance,
      executions: parsed.trusted.executions,
      suite: {
        suiteId: reconstructed.suite.suiteId,
        suiteDigest: reconstructed.suite.suiteDigest,
        role: 'behavioral',
      },
      governanceWitnesses: parsed.trusted.governanceWitnesses,
      requirements: requirements.sort((left, right) =>
        left.requirementId < right.requirementId
          ? -1
          : left.requirementId > right.requirementId
            ? 1
            : 0,
      ),
    });
    return verifySourceOwnedBehavioralQualificationEvidenceV1(parsed.evidence, context, now);
  } catch {
    return invalidReport(undefined);
  }
}

function exactL1ScopeForSourceSurfaceV1(
  scopes: readonly z.infer<typeof l1SourceScopeV1Schema>[],
  sourceSurfaceId: string,
): QualificationAttemptScopeV1 {
  if (scopes.length !== 1 || scopes[0]?.sourceSurfaceId !== sourceSurfaceId) {
    throw new Error('l1_scope_inventory_drift');
  }
  return scopes[0].scope;
}

/**
 * A closed local-synthetic registry is only an allowlist. Each L1 verifier
 * must also pin every evidence/trusted execution to its own fixture and
 * runner, so a valid L0 or projection execution cannot be replayed as this
 * suite's behavioral evidence.
 */
function assertExactL1SyntheticExecutionsV1(
  executions: readonly DiagnosticExecutionV1[],
  fixtureId: string,
  runner: string,
): void {
  if (
    executions.length === 0 ||
    !executions.every(
      (execution) =>
        execution.identity.source === 'local_synthetic' &&
        execution.identity.fixtureId === fixtureId &&
        execution.identity.runner === runner,
    )
  ) {
    throw new Error('l1_synthetic_execution_fixture_runner_drift');
  }
}

function exactL1ReceiptsForBindingsV1(
  receipts: readonly L1ToolVerificationReceiptV1[],
  bindings: readonly ReturnType<typeof discoverSourceOwnedL1ToolVerificationBindingsV1>[number][],
  expectedReceipts: readonly L1ToolVerificationReceiptV1[],
): Map<string, L1ToolVerificationReceiptV1> {
  const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
  const receivedAssertionIds = receipts.map((receipt) => receipt.assertionId);
  if (!sameStringInventoryV1(receivedAssertionIds, expectedAssertionIds)) {
    throw new Error('l1_receipt_inventory_drift');
  }
  const expectedByAssertion = new Map(
    expectedReceipts
      .filter((receipt) => receipt.sourceSurfaceId === bindings[0]?.sourceSurfaceId)
      .map((receipt) => [receipt.assertionId, receipt]),
  );
  for (const receipt of receipts) {
    if (!expectedByAssertion.has(receipt.assertionId)) {
      throw new Error('l1_receipt_unowned_assertion:' + receipt.assertionId);
    }
  }
  return new Map(receipts.map((receipt) => [receipt.assertionId, receipt]));
}

function exactL1SkillMcpReceiptsForBindingsV1(
  receipts: readonly L1SkillMcpReceiptV1[],
  bindings: readonly ReturnType<typeof discoverSourceOwnedL1SkillMcpBindingsV1>[number][],
  expectedReceipts: readonly L1SkillMcpReceiptV1[],
): Map<string, L1SkillMcpReceiptV1> {
  const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
  const receivedAssertionIds = receipts.map((receipt) => receipt.assertionId);
  if (!sameStringInventoryV1(receivedAssertionIds, expectedAssertionIds)) {
    throw new Error('l1_skill_mcp_receipt_inventory_drift');
  }
  const expectedByAssertion = new Map(
    expectedReceipts
      .filter((receipt) => receipt.sourceSurfaceId === bindings[0]?.sourceSurfaceId)
      .map((receipt) => [receipt.assertionId, receipt]),
  );
  for (const receipt of receipts) {
    if (!expectedByAssertion.has(receipt.assertionId)) {
      throw new Error('l1_skill_mcp_receipt_unowned_assertion:' + receipt.assertionId);
    }
  }
  return new Map(receipts.map((receipt) => [receipt.assertionId, receipt]));
}

function exactL1SubagentRecoveryReceiptsForBindingsV1(
  receipts: readonly L1SubagentRecoveryReceiptV1[],
  bindings: readonly ReturnType<typeof discoverSourceOwnedL1SubagentRecoveryBindingsV1>[number][],
  expectedReceipts: readonly L1SubagentRecoveryReceiptV1[],
): Map<string, L1SubagentRecoveryReceiptV1> {
  const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
  const receivedAssertionIds = receipts.map((receipt) => receipt.assertionId);
  if (!sameStringInventoryV1(receivedAssertionIds, expectedAssertionIds)) {
    throw new Error('l1_subagent_recovery_receipt_inventory_drift');
  }
  const expectedByAssertion = new Map(
    expectedReceipts
      .filter((receipt) => receipt.sourceSurfaceId === bindings[0]?.sourceSurfaceId)
      .map((receipt) => [receipt.assertionId, receipt]),
  );
  for (const receipt of receipts) {
    if (!expectedByAssertion.has(receipt.assertionId)) {
      throw new Error('l1_subagent_recovery_receipt_unowned_assertion:' + receipt.assertionId);
    }
  }
  return new Map(receipts.map((receipt) => [receipt.assertionId, receipt]));
}

function exactL1TuiRewindForkProjectionReceiptsForBindingsV1(
  receipts: readonly L1TuiRewindForkProjectionReceiptV1[],
  bindings: readonly ReturnType<
    typeof discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1
  >[number][],
  expectedReceipts: readonly L1TuiRewindForkProjectionReceiptV1[],
): Map<string, L1TuiRewindForkProjectionReceiptV1> {
  const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
  const receivedAssertionIds = receipts.map((receipt) => receipt.assertionId);
  if (!sameStringInventoryV1(receivedAssertionIds, expectedAssertionIds)) {
    throw new Error('l1_tui_rewind_fork_projection_receipt_inventory_drift');
  }
  const expectedByAssertion = new Map(
    expectedReceipts
      .filter((receipt) => receipt.sourceSurfaceId === bindings[0]?.sourceSurfaceId)
      .map((receipt) => [receipt.assertionId, receipt]),
  );
  for (const receipt of receipts) {
    if (!expectedByAssertion.has(receipt.assertionId)) {
      throw new Error(
        'l1_tui_rewind_fork_projection_receipt_unowned_assertion:' + receipt.assertionId,
      );
    }
  }
  return new Map(receipts.map((receipt) => [receipt.assertionId, receipt]));
}

function exactL1PublicProjectionReceiptsForBindingsV1(
  receipts: readonly L1PublicProjectionReceiptV1[],
  bindings: readonly ReturnType<typeof discoverSourceOwnedL1PublicProjectionBindingsV1>[number][],
  expectedReceipts: readonly L1PublicProjectionReceiptV1[],
): Map<string, L1PublicProjectionReceiptV1> {
  const expectedAssertionIds = bindings.map((binding) => binding.binding.assertionId).sort();
  const receivedAssertionIds = receipts.map((receipt) => receipt.assertionId);
  if (!sameStringInventoryV1(receivedAssertionIds, expectedAssertionIds)) {
    throw new Error('l1_public_projection_receipt_inventory_drift');
  }
  const expectedByAssertion = new Map(
    expectedReceipts
      .filter((receipt) => receipt.sourceSurfaceId === bindings[0]?.sourceSurfaceId)
      .map((receipt) => [receipt.assertionId, receipt]),
  );
  for (const receipt of receipts) {
    if (!expectedByAssertion.has(receipt.assertionId)) {
      throw new Error('l1_public_projection_receipt_unowned_assertion:' + receipt.assertionId);
    }
  }
  return new Map(receipts.map((receipt) => [receipt.assertionId, receipt]));
}

function hasExactL1RequirementV1(
  feature: {
    requiredEvidence: ReadonlyArray<{
      layer: string;
      suiteIds: string[];
      assertionIds: string[];
    }>;
  },
  suiteId: string,
  assertionId: string,
): boolean {
  return feature.requiredEvidence.some(
    (requirement) =>
      requirement.layer === 'scripted_runtime' &&
      requirement.suiteIds.length === 1 &&
      requirement.suiteIds[0] === suiteId &&
      requirement.assertionIds.length === 1 &&
      requirement.assertionIds[0] === assertionId,
  );
}

function attemptMatchesL1ReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1ToolVerificationReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function attemptMatchesL1AutoCompactionFailureReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1AutoCompactionFailureReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function attemptMatchesL1SkillMcpReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1SkillMcpReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function attemptMatchesL1SubagentRecoveryReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1SubagentRecoveryReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function attemptMatchesL1TuiRewindForkProjectionReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1TuiRewindForkProjectionReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function attemptMatchesL1PublicProjectionReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L1PublicProjectionReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function exactL0ScopesBySourceSurfaceV1(
  scopes: readonly z.infer<typeof l0SourceScopeV1Schema>[],
  expectedSourceSurfaceIds: readonly string[],
): Map<string, QualificationAttemptScopeV1> {
  const values = scopes.map((scope) => scope.sourceSurfaceId);
  if (!sameStringInventoryV1(values, expectedSourceSurfaceIds)) {
    throw new Error('l0_scope_inventory_drift');
  }
  return new Map(scopes.map((scope) => [scope.sourceSurfaceId, scope.scope]));
}

function exactL0ReceiptsBySourceSurfaceV1(
  receipts: readonly L0ContractReceiptV1[],
  expectedSourceSurfaceIds: readonly string[],
): Map<string, L0ContractReceiptV1> {
  const values = receipts.map((receipt) => receipt.sourceSurfaceId);
  if (!sameStringInventoryV1(values, expectedSourceSurfaceIds)) {
    throw new Error('l0_receipt_inventory_drift');
  }
  return new Map(receipts.map((receipt) => [receipt.sourceSurfaceId, receipt]));
}

function hasExactL0RequirementV1(
  feature: { requiredEvidence: ReadonlyArray<{ suiteIds: string[]; assertionIds: string[] }> },
  assertionId: string,
  suiteDigest: string,
): boolean {
  if (!/^sha256:[a-f0-9]{64}$/.test(suiteDigest)) return false;
  return feature.requiredEvidence.some(
    (requirement) =>
      requirement.suiteIds.length === 1 &&
      requirement.suiteIds[0] === L0_CONTRACT_SUITE_ID_V1 &&
      requirement.assertionIds.length === 1 &&
      requirement.assertionIds[0] === assertionId,
  );
}

function hasSourceOwnedL2NativeRequirementV1(
  feature: {
    requiredEvidence: ReadonlyArray<{
      layer: string;
      suiteIds: string[];
      assertionIds: string[];
    }>;
  },
  assertionId: string,
): boolean {
  return feature.requiredEvidence.some(
    (requirement) =>
      requirement.layer === 'native' &&
      requirement.suiteIds.length === 1 &&
      requirement.suiteIds[0] === L2_NATIVE_CONFORMANCE_SUITE_ID_V1 &&
      requirement.assertionIds.includes(assertionId),
  );
}

function attemptMatchesL0ReceiptOutcomeV1(
  attempt: AgentQualificationEvidenceV1['attempts'][number],
  receipt: L0ContractReceiptV1,
): boolean {
  if (receipt.outcome === 'passed') return attempt.status === 'passed';
  if (receipt.outcome === 'failed') {
    return attempt.status === 'failed' && attempt.reasonCode === 'assertion_failed';
  }
  return attempt.status === 'blocked';
}

function sameCanonicalValueV1(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameStringInventoryV1(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidLiveObservationReport(
  context: LiveCompatibilityObservationVerifierContextV1 | undefined,
): LiveCompatibilityObservationDiagnosticReportV1 {
  return buildLiveCompatibilityObservationDiagnosticReport({
    schema: 'LiveCompatibilityObservationDiagnosticReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    ...(context ? { verifierContextDigest: context.contextDigest } : {}),
    ...(context ? { candidateClosureDigest: context.candidate.closureDigest } : {}),
    status: 'blocked',
    reasonCode: 'input_invalid',
  });
}

/**
 * Verify one local, opt-in compatibility observation. The result deliberately
 * remains observation vocabulary. Its diagnostic candidate closure is only a
 * sealed identity binding; it cannot derive a qualification or production-admission state.
 */
export function verifyLiveCompatibilityObservationV1(
  observationInput: unknown,
  contextInput: unknown,
  now = new Date(),
): LiveCompatibilityObservationDiagnosticReportV1 {
  const contextResult = liveCompatibilityObservationVerifierContextV1Schema.safeParse(contextInput);
  if (!contextResult.success) return invalidLiveObservationReport(undefined);
  const context = contextResult.data;
  const observationResult = liveCompatibilityObservationV1Schema.safeParse(observationInput);
  if (!observationResult.success) return invalidLiveObservationReport(context);
  const observation = observationResult.data;

  const base = {
    schema: 'LiveCompatibilityObservationDiagnosticReportV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    verifierContextDigest: context.contextDigest,
    observationRecordDigest: observation.recordDigest,
    candidateClosureDigest: observation.candidate.closureDigest,
  };
  if (
    !sameQualificationGovernanceBindingV1(observation.governance, context.governance) ||
    !sameDiagnosticCandidateClosure(observation.candidate, context.candidate) ||
    !sameExecution(observation.execution, context.execution) ||
    !sameScope(observation.scope, context.scope) ||
    !sameIdentity(observation.identity, context.identity)
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
  }
  if (
    observation.execution.identity.source !== 'local_synthetic' ||
    observation.governance.retentionClass !== 'ephemeral_local'
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'execution_identity_untrusted',
    });
  }
  if (
    !governanceIsUsable(
      observation.governance,
      observation.observedAt,
      now,
      [observation.scope],
      context.governanceWitnesses.dayQuotaLedger,
      context.governanceWitnesses.monthQuotaLedger,
      context.governanceWitnesses.retention,
    )
  ) {
    return buildLiveCompatibilityObservationDiagnosticReport({
      ...base,
      status: 'blocked',
      reasonCode: 'retention_unavailable',
    });
  }
  return buildLiveCompatibilityObservationDiagnosticReport({
    ...base,
    outcome: observation.outcome,
    status: 'observed',
    reasonCode: observation.outcome === 'success' ? 'observed_success' : 'observed_cancelled',
  });
}
