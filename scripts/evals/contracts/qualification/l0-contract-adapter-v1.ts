import { z } from 'zod';
import { createBinding, descriptorRevision } from '../../../../src/core/capabilities/catalog';
import { executionBoundaryV1Schema } from '../../../../src/core/config/execution-boundary';
import { evaluateToolApproval } from '../../../../src/core/policies/approval-policy';
import { requiresVerification } from '../../../../src/core/verification/policy';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  RUNTIME_FAULT_SOAK_CASE_IDS,
  RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS,
} from '../../../runtime/fault-soak-report';
import { parseAgentTaskCase } from '../agent-task-case-schema';
import {
  buildCompactionContinuationArmV1,
  buildCompactionContinuationPreregistrationV1,
  compareSyntheticContinuation,
} from '../compaction-continuation';
import {
  buildDiagnosticCandidateArtifactClosureV1,
  qualificationReceiptBindingV1Schema,
} from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  evaluateL0ContractCorpusV1,
  type L0EvaluatorCaseObservationV1,
  type L0EvaluatorReportV1,
  l0ExpectedOutcomeForCaseV1,
} from './l0-contract-evaluator-v1';
import {
  buildL0SourceOwnedBindingV1,
  L0_CONTRACT_ADAPTERS_V1,
  L0_EVALUATOR_CASE_IDS_V1,
  L0_GOOD_BAD_CORPUS_V1,
  type L0ContractAdapterIdV1,
  type L0SourceOwnedBindingV1,
  l0EvaluatorIdentityV1Schema,
} from './l0-contract-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message: 'L0 identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });

export const L0_CONTRACT_FIXTURE_ID_V1 = 'l0-contract-fixture-v1';
export const L0_CONTRACT_RUNNER_ID_V1 = 'qualification-l0-contract-runner-v1';
const L0_SYNTHETIC_WORKSPACE_ROOT_V1 = '/tmp';

/**
 * This is an implementation-provenance registry, not a Feature registry.
 * Each closed adapter names the exact product symbol invoked by
 * `runProductAssertionV1`; the source-owned collector rejects an annotation
 * moved to another symbol even when its adapter/assertion pair stays valid.
 */
export const L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'approval-policy-decision-v1',
    assertionId: 'l0.authorization-approval.decision-v1',
    sourceRef: 'src/core/policies/approval-policy.ts#evaluateToolApproval',
  },
  {
    adapterId: 'capability-catalog-binding-v1',
    assertionId: 'l0.capability-catalog.binding-v1',
    sourceRef: 'src/core/capabilities/catalog.ts#createBinding',
  },
  {
    adapterId: 'execution-boundary-schema-v1',
    assertionId: 'l0.sandbox-execution-boundary.schema-v1',
    sourceRef: 'src/core/config/execution-boundary.ts#executionBoundaryV1Schema',
  },
  {
    adapterId: 'verification-policy-requirement-v1',
    assertionId: 'l0.verification-policy.requirement-v1',
    sourceRef: 'src/core/verification/policy.ts#requiresVerification',
  },
] as const;

export type L0ContractAdapterOutcomeV1 = 'passed' | 'failed';

export interface L0ContractAdapterResultV1 {
  adapterId: L0ContractAdapterIdV1;
  assertionId: string;
  outcome: L0ContractAdapterOutcomeV1;
}

const l0ContractReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('L0ContractReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum(
      L0_CONTRACT_ADAPTERS_V1.map((entry) => entry.adapterId) as [string, ...string[]],
    ),
    assertionId: safeIdentifierSchema,
    sourceBindingDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteDigest: digestSchema,
    evaluatorDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    outcome: z.enum(['passed', 'failed', 'blocked']),
    reasonCode: z.enum(['adapter_assertion_failed', 'evaluator_blocked', 'passed']),
  })
  .strict()
  .superRefine((value, context) => {
    const adapter = L0_CONTRACT_ADAPTERS_V1.find((entry) => entry.adapterId === value.adapterId);
    if (!adapter || adapter.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'l0 receipt adapter/assertion pair must remain source-owned and registered',
      });
    }
    if (adapter) {
      const expectedBindingDigest = buildL0SourceOwnedBindingV1({
        sourceSurfaceId: value.sourceSurfaceId,
        declaration: adapter,
      }).bindingDigest;
      if (value.sourceBindingDigest !== expectedBindingDigest) {
        context.addIssue({
          code: 'custom',
          path: ['sourceBindingDigest'],
          message: 'l0 receipt source binding digest must match its exact source surface and pair',
        });
      }
    }
    const expectedReceiptId = `l0-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'l0 receipt ID must be derived from its exact source surface and assertion',
      });
    }
    const expectedReason =
      value.outcome === 'passed'
        ? 'passed'
        : value.outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked';
    if (value.reasonCode !== expectedReason) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'l0 receipt reason must be derived from its outcome',
      });
    }
  });

export type L0ContractReceiptMaterialV1 = z.infer<typeof l0ContractReceiptMaterialV1Schema>;

export function computeL0ContractReceiptDigestV1(
  material: L0ContractReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.contract-receipt.v1',
    canonicalJsonBytes(l0ContractReceiptMaterialV1Schema.parse(material)),
  );
}

export const l0ContractReceiptV1Schema = l0ContractReceiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    const parsedMaterial = l0ContractReceiptMaterialV1Schema.safeParse(material);
    if (!parsedMaterial.success) {
      for (const issue of parsedMaterial.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
      return;
    }
    const expected = computeL0ContractReceiptDigestV1(parsedMaterial.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `l0 receipt digest mismatch: expected ${expected}`,
      });
    }
  });

export type L0ContractReceiptV1 = z.infer<typeof l0ContractReceiptV1Schema>;

export function buildL0ContractReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L0SourceOwnedBindingV1;
  matrixDigest: string;
  suiteDigest: string;
  evaluatorReport: L0EvaluatorReportV1;
  adapterResult: L0ContractAdapterResultV1;
}): L0ContractReceiptV1 {
  const adapterResult = input.adapterResult;
  if (
    adapterResult.adapterId !== input.binding.adapterId ||
    adapterResult.assertionId !== input.binding.assertionId
  ) {
    throw new Error('l0_receipt_adapter_binding_mismatch');
  }
  const outcome =
    input.evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = l0ContractReceiptMaterialV1Schema.parse({
    schema: 'L0ContractReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l0-receipt:${input.sourceSurfaceId}:${input.binding.assertionId}`,
    sourceSurfaceId: input.sourceSurfaceId,
    featureId: input.featureId,
    adapterId: input.binding.adapterId,
    assertionId: input.binding.assertionId,
    sourceBindingDigest: input.binding.bindingDigest,
    matrixDigest: input.matrixDigest,
    suiteDigest: input.suiteDigest,
    evaluatorDigest: input.evaluatorReport.evaluator.evaluatorDigest,
    evaluatorReportDigest: input.evaluatorReport.reportDigest,
    outcome,
    reasonCode:
      outcome === 'passed'
        ? 'passed'
        : outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked',
  });
  return l0ContractReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL0ContractReceiptDigestV1(material),
  });
}

export function l0ContractReceiptBindingV1(
  receipt: L0ContractReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}

/**
 * Execute one closed product-owned L0 assertion. Inputs are constructed in
 * memory and the returned result is a stable outcome token only: it does not
 * retain a command, path, source body, exception, or evaluation output.
 */
export function runL0ContractAdapterV1(binding: L0SourceOwnedBindingV1): L0ContractAdapterResultV1 {
  return {
    adapterId: binding.adapterId,
    assertionId: binding.assertionId,
    outcome: runProductAssertionV1(binding.adapterId) ? 'passed' : 'failed',
  };
}

/**
 * Evaluate the complete, immutable corpus against real deterministic product
 * contracts and evaluator self-protection checks. This is local synthetic
 * work only; it makes no provider request and exposes no product body.
 */
export function runL0ContractCorpusV1(input: {
  evaluator: Parameters<typeof evaluateL0ContractCorpusV1>[0]['evaluator'];
}): L0EvaluatorReportV1 {
  const observations: L0EvaluatorCaseObservationV1[] = L0_EVALUATOR_CASE_IDS_V1.map((caseId) => {
    const expected = l0ExpectedOutcomeForCaseV1(caseId);
    const actual = evaluatorDependencyContractsHoldV1() && casePassesV1(caseId, input.evaluator);
    return {
      caseId,
      observedOutcome:
        expected === 'accepted'
          ? actual
            ? 'accepted'
            : 'rejected'
          : actual
            ? 'rejected'
            : 'accepted',
    };
  });
  return evaluateL0ContractCorpusV1({ evaluator: input.evaluator, observations });
}

/**
 * Reuse existing deterministic contract owners only as evaluator self-checks.
 * None of these values is mapped to a product Feature here; the source-owned
 * public operation annotation remains the sole product mapping authority.
 */
function evaluatorDependencyContractsHoldV1(): boolean {
  try {
    parseAgentTaskCase({
      version: 1,
      caseId: 'l0-contract-agent-task',
      title: 'L0 contract fixture',
      category: 'test',
      difficulty: 'simple',
      contextClass: 'short',
      accessMode: 'read_only',
      repositoryType: 'synthetic_local',
      primaryLanguage: 'typescript',
      buildSystem: 'bun',
      fixtureId: 'l0-contract-fixture',
      baselineState: 'clean',
      allowedPaths: [],
      forbiddenPaths: ['secrets/'],
      requiredDiffFacts: [],
      forbiddenDiffFacts: [],
      requiredChecks: [
        {
          version: 1,
          checkId: 'l0-contract-check',
          kind: 'static',
          command: ['bun', 'test'],
          expectedExitCode: 0,
          network: 'off',
          timeoutMs: 1,
        },
      ],
      expectedInteractions: {
        version: 1,
        entrypoint: 'headless_cli',
        plan: 'optional',
        approval: 'none_expected',
        verificationRequired: false,
        projectInstructionsRequired: false,
        maxUserCorrections: 0,
      },
      budgets: {
        version: 1,
        budgetId: 'l0-contract-budget',
        maxDurationMs: 1,
        maxModelCalls: 0,
        maxToolCalls: 0,
        maxInputTokens: 1,
        maxOutputTokens: 1,
      },
      capabilities: { plan: false, mcp: false, longContext: false },
    });
    const arm = (name: 'control' | 'treatment') =>
      buildCompactionContinuationArmV1({
        version: 1,
        arm: name,
        routeDigest: `sha256:${'a'.repeat(64)}`,
        modelConfigDigest: `sha256:${'b'.repeat(64)}`,
        toolFixtureDigest: `sha256:${'c'.repeat(64)}`,
        budgetDigest: `sha256:${'d'.repeat(64)}`,
        seedPolicyDigest: `sha256:${'e'.repeat(64)}`,
        sampleCount: 1,
        successRate: 1,
        confidenceLower: 1,
        confidenceUpper: 1,
        safetyViolations: 0,
        resourceBounded: true,
      });
    const continuation = compareSyntheticContinuation({
      version: 1,
      executionClass: 'synthetic_fixture',
      runStartedAt: '2026-08-05T00:00:00.000Z',
      thresholds: buildCompactionContinuationPreregistrationV1({
        version: 1,
        decisionId: 'D-COMPACTION-NONINFERIORITY',
        status: 'preregistered',
        minimumSamplesPerArm: 1,
        maximumSuccessRateDelta: 0,
        registeredAt: '2026-08-04T00:00:00.000Z',
      }),
      control: arm('control'),
      treatment: arm('treatment'),
    });
    return (
      continuation.contractOutcome === 'passed' &&
      continuation.status === 'blocked' &&
      RUNTIME_FAULT_SOAK_CASE_IDS.length > 0 &&
      RUNTIME_FAULT_SOAK_CASE_IDS.every(
        (caseId) => RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[caseId].length > 0,
      )
    );
  } catch {
    return false;
  }
}

function runProductAssertionV1(adapterId: L0ContractAdapterIdV1): boolean {
  switch (adapterId) {
    case 'approval-policy-decision-v1':
      return (
        evaluateToolApproval({ toolName: 'write_plan', toolArgs: {}, phase: 'building' })
          .decision === 'allow' &&
        evaluateToolApproval({
          toolName: 'shell_execute',
          toolArgs: { command: 'rm -rf /' },
          phase: 'building',
          workspace: '/synthetic-fixture',
        }).decision === 'deny'
      );
    case 'verification-policy-requirement-v1':
      return (
        requiresVerification({ filesystem: 'unknown', network: 'none', externalState: 'none' }) &&
        !requiresVerification({ filesystem: 'none', network: 'none', externalState: 'none' })
      );
    case 'capability-catalog-binding-v1': {
      const descriptorInput = {
        capabilityId: 'l0.synthetic.capability',
        kind: 'builtin_tool' as const,
        displayName: 'L0 synthetic capability',
        description: 'deterministic qualification fixture',
        provider: { type: 'builtin' as const, id: 'l0', provenance: 'builtin' as const },
        inputSchema: { type: 'object' },
        declaredEffects: {
          filesystem: 'read' as const,
          network: 'none' as const,
          externalState: 'none' as const,
        },
        effectiveEffects: {
          filesystem: 'read' as const,
          network: 'none' as const,
          externalState: 'none' as const,
        },
        policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
        availability: 'available' as const,
        diagnostics: [],
      };
      const descriptor = {
        ...descriptorInput,
        revision: descriptorRevision(descriptorInput),
      };
      const first = createBinding({
        descriptor,
        exposedToolName: 'l0_tool',
        turnId: 'l0-turn-a',
      });
      const second = createBinding({
        descriptor,
        exposedToolName: 'l0_tool',
        turnId: 'l0-turn-b',
      });
      return (
        first.capabilityId === descriptor.capabilityId &&
        first.capabilityRevision === descriptor.revision &&
        first.bindingId !== second.bindingId
      );
    }
    case 'execution-boundary-schema-v1': {
      const boundary = {
        filesystemScope: 'read_only' as const,
        // The L0 self-contract must never inspect the repository workspace.
        // `/tmp` is a fixed existing synthetic root used solely to satisfy the
        // product schema's canonical-directory invariant; it is not retained.
        workspaceRoot: L0_SYNTHETIC_WORKSPACE_ROOT_V1,
        networkMode: 'off' as const,
        networkAllowlist: [],
        allowLocalAndPrivateNetwork: false as const,
        protectedPathPolicy: 'deny' as const,
        maxProcessTreeSizePerShellInvocation: 1,
        sandboxRequired: true,
        sandboxUnavailable: 'fail' as const,
      };
      return (
        executionBoundaryV1Schema.safeParse(boundary).success &&
        !executionBoundaryV1Schema.safeParse({
          ...boundary,
          networkAllowlist: ['example.invalid'],
        }).success
      );
    }
  }
}

function casePassesV1(
  caseId: (typeof L0_EVALUATOR_CASE_IDS_V1)[number],
  evaluator: Parameters<typeof evaluateL0ContractCorpusV1>[0]['evaluator'],
): boolean {
  const corpusCase = L0_GOOD_BAD_CORPUS_V1.find((entry) => entry.caseId === caseId);
  if (corpusCase) {
    return runProductAssertionV1(corpusCase.adapterId);
  }
  switch (caseId) {
    case 'l0-mutation-candidate-identity-drift-v1':
      return rejectsCandidateLineageSpliceV1();
    case 'l0-mutation-deleted-assertion-v1':
      return rejectsDeletedAssertionV1();
    case 'l0-mutation-duplicate-child-result-v1':
      return rejectsDuplicateEvaluationCaseV1(evaluator);
    case 'l0-mutation-forged-success-v1':
    case 'l0-mutation-test-failed-claimed-success-v1':
      return rejectsForgedEvaluatorSuccessV1(evaluator);
    case 'l0-mutation-missing-verification-receipt-v1':
      return !qualificationReceiptBindingV1Schema.safeParse(undefined).success;
    case 'l0-mutation-stale-binding-v1':
      return rejectsStaleBindingV1();
    case 'l0-mutation-suite-digest-drift-v1':
      return rejectsEvaluatorDigestDriftV1(evaluator);
    case 'l0-mutation-unknown-effect-accepted-v1':
      return requiresVerification({
        filesystem: 'unknown',
        network: 'none',
        externalState: 'none',
      });
    case 'l0-mutation-weakened-assertion-v1':
      return rejectsDeletedAssertionV1();
  }
  return false;
}

function rejectsDeletedAssertionV1(): boolean {
  return throwsV1(() =>
    buildL0SourceOwnedBindingV1({
      sourceSurfaceId: 'authorization:approval',
      declaration: { adapterId: 'approval-policy-decision-v1' } as never,
    }),
  );
}

function rejectsStaleBindingV1(): boolean {
  return throwsV1(() =>
    buildL0SourceOwnedBindingV1({
      sourceSurfaceId: 'authorization:approval',
      declaration: {
        adapterId: 'approval-policy-decision-v1',
        assertionId: 'l0.verification-policy.requirement-v1',
      },
    }),
  );
}

function rejectsDuplicateEvaluationCaseV1(
  evaluator: Parameters<typeof evaluateL0ContractCorpusV1>[0]['evaluator'],
): boolean {
  return throwsV1(() =>
    evaluateL0ContractCorpusV1({
      evaluator,
      observations: [
        ...L0_EVALUATOR_CASE_IDS_V1.map((caseId) => ({
          caseId,
          observedOutcome: l0ExpectedOutcomeForCaseV1(caseId),
        })),
        {
          caseId: 'l0-good-approval-policy-decision-v1',
          observedOutcome: 'accepted',
        },
      ],
    }),
  );
}

function rejectsForgedEvaluatorSuccessV1(
  evaluator: Parameters<typeof evaluateL0ContractCorpusV1>[0]['evaluator'],
): boolean {
  const report = evaluateL0ContractCorpusV1({
    evaluator,
    observations: L0_EVALUATOR_CASE_IDS_V1.map((caseId) => ({
      caseId,
      observedOutcome:
        caseId === 'l0-mutation-forged-success-v1'
          ? 'accepted'
          : l0ExpectedOutcomeForCaseV1(caseId),
    })),
  });
  return (
    report.status === 'blocked' &&
    report.acceptedNegativeCaseIds.includes('l0-mutation-forged-success-v1')
  );
}

function rejectsEvaluatorDigestDriftV1(
  evaluator: Parameters<typeof evaluateL0ContractCorpusV1>[0]['evaluator'],
): boolean {
  const replacement = `sha256:${'f'.repeat(64)}`;
  return !l0EvaluatorIdentityV1Schema.safeParse({ ...evaluator, evaluatorDigest: replacement })
    .success;
}

function rejectsCandidateLineageSpliceV1(): boolean {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const commit = 'a'.repeat(40);
  return throwsV1(() =>
    buildDiagnosticCandidateArtifactClosureV1({
      schema: 'DiagnosticCandidateArtifactClosureV1',
      version: 1,
      artifacts: [
        {
          platformIdentity: 'linux-x64',
          artifact: {
            canonicalRepository: 'ferqx/kite-code',
            repositoryId: 'R_kgDOKite',
            commit,
            payloadSha256: digest('a'),
            canonicalManifestDigest: digest('b'),
            behaviorDigest: digest('c'),
            profileDigest: digest('d'),
            gatePolicyDigest: digest('e'),
          },
        },
        {
          platformIdentity: 'macos-arm64',
          artifact: {
            canonicalRepository: 'ferqx/kite-code',
            repositoryId: 'R_kgDOKite',
            commit: 'b'.repeat(40),
            payloadSha256: digest('f'),
            canonicalManifestDigest: digest('0'),
            behaviorDigest: digest('c'),
            profileDigest: digest('d'),
            gatePolicyDigest: digest('e'),
          },
        },
      ],
    }),
  );
}

function throwsV1(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}
