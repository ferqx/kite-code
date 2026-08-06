import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L1 Skill/MCP identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * This sealed suite is deterministic diagnostic instrumentation only. Its
 * schema deliberately has no product-admission input position.
 */
export const L1_SKILL_MCP_SUITE_ID_V1 = 'qualification-l1-skill-mcp-v1';
export const L1_SKILL_MCP_EVALUATOR_ID_V1 = 'qualification-l1-skill-mcp-evaluator-v1';
export const L1_SKILL_MCP_FIXTURE_ID_V1 = 'l1-skill-mcp-fixture-v1';
export const L1_SKILL_MCP_RUNNER_ID_V1 = 'qualification-l1-skill-mcp-runner-v1';

export const L1_SKILL_MCP_ADAPTERS_V1 = [
  {
    adapterId: 'mcp-auth-invalid-provider-action-v1',
    assertionId: 'l1.mcp.auth-invalid-provider-action.v1',
  },
  {
    adapterId: 'mcp-project-approval-catalog-churn-v1',
    assertionId: 'l1.mcp.project-approval-catalog-churn.v1',
  },
  {
    adapterId: 'mcp-unknown-write-reconciliation-v1',
    assertionId: 'l1.mcp.unknown-write-reconciliation.v1',
  },
  {
    adapterId: 'runtime-provider-action-new-turn-v1',
    assertionId: 'l1.runtime.provider-action-new-turn.v1',
  },
  {
    adapterId: 'skill-discovery-activation-output-v1',
    assertionId: 'l1.skill.discovery-activation-output.v1',
  },
  {
    adapterId: 'skill-mcp-dependency-revision-drift-v1',
    assertionId: 'l1.skill.mcp-dependency-revision-drift.v1',
  },
] as const;

export const L1_SKILL_MCP_ADAPTER_IDS_V1 = L1_SKILL_MCP_ADAPTERS_V1.map(
  (entry) => entry.adapterId,
) as unknown as readonly [
  'mcp-auth-invalid-provider-action-v1',
  'mcp-project-approval-catalog-churn-v1',
  'mcp-unknown-write-reconciliation-v1',
  'runtime-provider-action-new-turn-v1',
  'skill-discovery-activation-output-v1',
  'skill-mcp-dependency-revision-drift-v1',
];
export type L1SkillMcpAdapterIdV1 = (typeof L1_SKILL_MCP_ADAPTER_IDS_V1)[number];

export const L1_SKILL_MCP_ASSERTION_IDS_V1 = L1_SKILL_MCP_ADAPTERS_V1.map(
  (entry) => entry.assertionId,
) as unknown as readonly [
  'l1.mcp.auth-invalid-provider-action.v1',
  'l1.mcp.project-approval-catalog-churn.v1',
  'l1.mcp.unknown-write-reconciliation.v1',
  'l1.runtime.provider-action-new-turn.v1',
  'l1.skill.discovery-activation-output.v1',
  'l1.skill.mcp-dependency-revision-drift.v1',
];
export type L1SkillMcpAssertionIdV1 = (typeof L1_SKILL_MCP_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L1_SKILL_MCP_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_SKILL_MCP_ASSERTION_IDS_V1);

export function isRegisteredL1SkillMcpPairV1(
  adapterId: L1SkillMcpAdapterIdV1,
  assertionId: L1SkillMcpAssertionIdV1,
): boolean {
  return L1_SKILL_MCP_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: { adapterId: L1SkillMcpAdapterIdV1; assertionId: L1SkillMcpAssertionIdV1 },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1SkillMcpPairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 Skill/MCP adapter/assertion pair is not registered',
    });
  }
}

/** Exact declaration stored beside the product symbol that owns the behavior. */
export const l1SkillMcpSourceOwnedDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1SkillMcpSourceOwnedDeclarationV1 = z.infer<
  typeof l1SkillMcpSourceOwnedDeclarationV1Schema
>;

const l1SkillMcpSourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpSourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SkillMcpSourceOwnedBindingMaterialV1 = z.infer<
  typeof l1SkillMcpSourceOwnedBindingMaterialV1Schema
>;

export function computeL1SkillMcpSourceOwnedBindingDigestV1(
  material: L1SkillMcpSourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.source-owned-binding.v1',
    canonicalJsonBytes(l1SkillMcpSourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1SkillMcpSourceOwnedBindingV1Schema = l1SkillMcpSourceOwnedBindingMaterialV1Schema
  .extend({ bindingDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { bindingDigest, ...material } = value;
    const expected = computeL1SkillMcpSourceOwnedBindingDigestV1(material);
    if (bindingDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['bindingDigest'],
        message: `L1 Skill/MCP source-owned binding digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SkillMcpSourceOwnedBindingV1 = z.infer<typeof l1SkillMcpSourceOwnedBindingV1Schema>;

export function buildL1SkillMcpSourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1SkillMcpSourceOwnedDeclarationV1;
}): L1SkillMcpSourceOwnedBindingV1 {
  const declaration = l1SkillMcpSourceOwnedDeclarationV1Schema.parse(input.declaration);
  const material = l1SkillMcpSourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1SkillMcpSourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1SkillMcpSourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1SkillMcpSourceOwnedBindingDigestV1(material),
  });
}

/**
 * Closed implementation provenance. The collector compares these exact source
 * references with source annotations; qualification code never supplies a
 * Feature ID for a product operation.
 */
export const L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'mcp-auth-invalid-provider-action-v1',
    assertionId: 'l1.mcp.auth-invalid-provider-action.v1',
    sourceRef: 'src/core/controllers/tool-controller.ts#executeRuntimeTools',
  },
  {
    adapterId: 'mcp-project-approval-catalog-churn-v1',
    assertionId: 'l1.mcp.project-approval-catalog-churn.v1',
    sourceRef: 'src/core/mcp/supervisor.ts#DefaultMcpSupervisor',
  },
  {
    adapterId: 'mcp-unknown-write-reconciliation-v1',
    assertionId: 'l1.mcp.unknown-write-reconciliation.v1',
    sourceRef: 'src/core/mcp/write-governance.ts#classifyMcpWriteRecoveryV1',
  },
  {
    adapterId: 'runtime-provider-action-new-turn-v1',
    assertionId: 'l1.runtime.provider-action-new-turn.v1',
    sourceRef: 'src/core/runtime/actions.ts#eventsForRuntimeAction',
  },
  {
    adapterId: 'skill-discovery-activation-output-v1',
    assertionId: 'l1.skill.discovery-activation-output.v1',
    sourceRef: 'src/core/skills/lifecycle.ts#activateSkillLifecycle',
  },
  {
    adapterId: 'skill-mcp-dependency-revision-drift-v1',
    assertionId: 'l1.skill.mcp-dependency-revision-drift.v1',
    sourceRef: 'src/core/skills/workflow.ts#compileSkillWorkflow',
  },
] as const;

export const L1_SKILL_MCP_CASE_IDS_V1 = [
  'l1-mcp-auth-invalid-provider-action-v1',
  'l1-mcp-project-approval-catalog-churn-v1',
  'l1-mcp-unknown-write-reconciliation-v1',
  'l1-runtime-provider-action-new-turn-v1',
  'l1-skill-discovery-activation-output-v1',
  'l1-skill-mcp-dependency-revision-drift-v1',
] as const;
export type L1SkillMcpCaseIdV1 = (typeof L1_SKILL_MCP_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_SKILL_MCP_CASE_IDS_V1);
export const l1SkillMcpCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    category: z.enum(['journey', 'negative']),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SkillMcpCaseV1 = z.infer<typeof l1SkillMcpCaseV1Schema>;

/** The corpus contains stable IDs only; fixture bodies and provider data stay ephemeral. */
export const L1_SKILL_MCP_CORPUS_V1 = [
  {
    caseId: 'l1-mcp-auth-invalid-provider-action-v1',
    category: 'journey',
    adapterId: 'mcp-auth-invalid-provider-action-v1',
    assertionId: 'l1.mcp.auth-invalid-provider-action.v1',
  },
  {
    caseId: 'l1-mcp-project-approval-catalog-churn-v1',
    category: 'negative',
    adapterId: 'mcp-project-approval-catalog-churn-v1',
    assertionId: 'l1.mcp.project-approval-catalog-churn.v1',
  },
  {
    caseId: 'l1-mcp-unknown-write-reconciliation-v1',
    category: 'negative',
    adapterId: 'mcp-unknown-write-reconciliation-v1',
    assertionId: 'l1.mcp.unknown-write-reconciliation.v1',
  },
  {
    caseId: 'l1-runtime-provider-action-new-turn-v1',
    category: 'journey',
    adapterId: 'runtime-provider-action-new-turn-v1',
    assertionId: 'l1.runtime.provider-action-new-turn.v1',
  },
  {
    caseId: 'l1-skill-discovery-activation-output-v1',
    category: 'journey',
    adapterId: 'skill-discovery-activation-output-v1',
    assertionId: 'l1.skill.discovery-activation-output.v1',
  },
  {
    caseId: 'l1-skill-mcp-dependency-revision-drift-v1',
    category: 'negative',
    adapterId: 'skill-mcp-dependency-revision-drift-v1',
    assertionId: 'l1.skill.mcp-dependency-revision-drift.v1',
  },
] as const satisfies readonly L1SkillMcpCaseV1[];

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

export const l1SkillMcpCorpusV1Schema = z
  .array(l1SkillMcpCaseV1Schema)
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.map((entry) => entry.caseId),
        L1_SKILL_MCP_CASE_IDS_V1,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L1 Skill/MCP corpus cases must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1SkillMcpCorpusV1 = z.infer<typeof l1SkillMcpCorpusV1Schema>;

export function computeL1SkillMcpCorpusDigestV1(
  corpus: L1SkillMcpCorpusV1 = L1_SKILL_MCP_CORPUS_V1 as unknown as L1SkillMcpCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.corpus.v1',
    canonicalJsonBytes(l1SkillMcpCorpusV1Schema.parse(corpus)),
  );
}

const l1SkillMcpSuiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_SKILL_MCP_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.corpusDigest !== computeL1SkillMcpCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 Skill/MCP corpus digest drift',
      });
    }
    if (!exactInventory(value.adapterIds, L1_SKILL_MCP_ADAPTER_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 Skill/MCP adapters must be exact',
      });
    }
    if (!exactInventory(value.assertionIds, L1_SKILL_MCP_ASSERTION_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 Skill/MCP assertions must be exact',
      });
    }
  });
export type L1SkillMcpSuiteMaterialV1 = z.infer<typeof l1SkillMcpSuiteMaterialV1Schema>;

export function computeL1SkillMcpSuiteDigestV1(
  material: L1SkillMcpSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.suite.v1',
    canonicalJsonBytes(l1SkillMcpSuiteMaterialV1Schema.parse(material)),
  );
}

export const l1SkillMcpSuiteV1Schema = l1SkillMcpSuiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1SkillMcpSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 Skill/MCP suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SkillMcpSuiteV1 = z.infer<typeof l1SkillMcpSuiteV1Schema>;

export function buildL1SkillMcpSuiteV1(): L1SkillMcpSuiteV1 {
  const material = l1SkillMcpSuiteMaterialV1Schema.parse({
    schema: 'L1SkillMcpSuiteV1',
    version: 1,
    suiteId: L1_SKILL_MCP_SUITE_ID_V1,
    corpusDigest: computeL1SkillMcpCorpusDigestV1(),
    adapterIds: [...L1_SKILL_MCP_ADAPTER_IDS_V1],
    assertionIds: [...L1_SKILL_MCP_ASSERTION_IDS_V1],
  });
  return l1SkillMcpSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1SkillMcpSuiteDigestV1(material),
  });
}

/** Matrix-compatible suite identity may only come from the source-owned catalog. */
export const l1SkillMcpCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1SkillMcpCatalogSuiteIdentityV1 = z.infer<
  typeof l1SkillMcpCatalogSuiteIdentityV1Schema
>;

export function bindL1SkillMcpCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1SkillMcpCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  const expectedAssertions = [...L1_SKILL_MCP_ASSERTION_IDS_V1].sort();
  if (
    parsed.suiteId !== L1_SKILL_MCP_SUITE_ID_V1 ||
    parsed.assertionIds.length !== expectedAssertions.length ||
    !parsed.assertionIds.every((entry, index) => entry === expectedAssertions[index])
  ) {
    throw new Error('l1_skill_mcp_catalog_suite_identity_mismatch');
  }
  return l1SkillMcpCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

const l1SkillMcpEvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_SKILL_MCP_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
    faultInjectionDigest: digestSchema,
  })
  .strict();
export type L1SkillMcpEvaluatorIdentityMaterialV1 = z.infer<
  typeof l1SkillMcpEvaluatorIdentityMaterialV1Schema
>;

export function computeL1SkillMcpEvaluatorIdentityDigestV1(
  material: L1SkillMcpEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.evaluator-identity.v1',
    canonicalJsonBytes(l1SkillMcpEvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1SkillMcpEvaluatorIdentityV1Schema = l1SkillMcpEvaluatorIdentityMaterialV1Schema
  .extend({ evaluatorDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { evaluatorDigest, ...material } = value;
    const expected = computeL1SkillMcpEvaluatorIdentityDigestV1(material);
    if (evaluatorDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['evaluatorDigest'],
        message: `L1 Skill/MCP evaluator digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SkillMcpEvaluatorIdentityV1 = z.infer<typeof l1SkillMcpEvaluatorIdentityV1Schema>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

export function buildL1SkillMcpEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  faultInjection: unknown;
  suite?: L1SkillMcpSuiteV1;
}): L1SkillMcpEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL1SkillMcpSuiteV1();
  const material = l1SkillMcpEvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1SkillMcpEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_SKILL_MCP_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest('kite.qualification.l1.skill-mcp.oracle.v1', input.oracle),
    verifierDigest: dependencyDigest('kite.qualification.l1.skill-mcp.verifier.v1', input.verifier),
    runnerDigest: dependencyDigest('kite.qualification.l1.skill-mcp.runner.v1', input.runner),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l1.skill-mcp.scheduler.v1',
      input.scheduler,
    ),
    faultInjectionDigest: dependencyDigest(
      'kite.qualification.l1.skill-mcp.fault-injection.v1',
      input.faultInjection,
    ),
  });
  return l1SkillMcpEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1SkillMcpEvaluatorIdentityDigestV1(material),
  });
}

export const l1SkillMcpAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SkillMcpAdapterResultV1 = z.infer<typeof l1SkillMcpAdapterResultV1Schema>;
