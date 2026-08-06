import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message: 'L1 identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * L1 is a local scripted-runtime diagnostic suite. It is deliberately not a
 * release evidence type and does not name a release gate or admission state.
 */
export const L1_TOOL_VERIFICATION_SUITE_ID_V1 = 'qualification-l1-tool-verification-v1';
export const L1_TOOL_VERIFICATION_EVALUATOR_ID_V1 =
  'qualification-l1-tool-verification-evaluator-v1';
export const L1_TOOL_VERIFICATION_FIXTURE_ID_V1 = 'l1-tool-verification-fixture-v1';
export const L1_TOOL_VERIFICATION_RUNNER_ID_V1 = 'qualification-l1-tool-verification-runner-v1';

export const L1_TOOL_VERIFICATION_ADAPTERS_V1 = [
  {
    adapterId: 'runtime-tool-approval-verification-v1',
    assertionId: 'l1.runtime.tool-approval-verification.v1',
  },
  {
    adapterId: 'runtime-invalid-tool-correction-v1',
    assertionId: 'l1.runtime.invalid-tool-correction.v1',
  },
  {
    adapterId: 'runtime-approval-rejection-v1',
    assertionId: 'l1.runtime.approval-rejection-aborts-turn.v1',
  },
  {
    adapterId: 'runtime-approved-parallel-tools-v1',
    assertionId: 'l1.runtime.approved-parallel-tools.v1',
  },
  {
    adapterId: 'runtime-unknown-late-terminal-v1',
    assertionId: 'l1.runtime.unknown-and-late-terminal.v1',
  },
  {
    adapterId: 'runtime-required-verification-v1',
    assertionId: 'l1.runtime.required-verification-blocks-completion.v1',
  },
  {
    adapterId: 'runtime-bounded-cleanup-v1',
    assertionId: 'l1.runtime.bounded-cleanup-retains-unknown.v1',
  },
] as const;

/**
 * Closed implementation provenance only. Keeping this beside the L1 schema
 * lets the source-owned collector bind symbols without importing the runtime
 * harness (and therefore without traversing application/config barrels).
 */
export const L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'runtime-tool-approval-verification-v1',
    assertionId: 'l1.runtime.tool-approval-verification.v1',
    sourceRef: 'src/core/controllers/tool-controller.ts#executeRuntimeTools',
  },
  {
    adapterId: 'runtime-invalid-tool-correction-v1',
    assertionId: 'l1.runtime.invalid-tool-correction.v1',
    sourceRef: 'src/core/controllers/tool-controller.ts#executeRuntimeTools',
  },
  {
    adapterId: 'runtime-approval-rejection-v1',
    assertionId: 'l1.runtime.approval-rejection-aborts-turn.v1',
    sourceRef: 'src/core/runtime/actions.ts#eventsForRuntimeAction',
  },
  {
    adapterId: 'runtime-approved-parallel-tools-v1',
    assertionId: 'l1.runtime.approved-parallel-tools.v1',
    sourceRef: 'src/core/controllers/tool-controller.ts#executeRuntimeTools',
  },
  {
    adapterId: 'runtime-unknown-late-terminal-v1',
    assertionId: 'l1.runtime.unknown-and-late-terminal.v1',
    sourceRef: 'src/core/runtime/kernel.ts#applyEffectEvent',
  },
  {
    adapterId: 'runtime-required-verification-v1',
    assertionId: 'l1.runtime.required-verification-blocks-completion.v1',
    sourceRef: 'src/core/verification/executor.ts#executeVerificationEffect',
  },
  {
    adapterId: 'runtime-bounded-cleanup-v1',
    assertionId: 'l1.runtime.bounded-cleanup-retains-unknown.v1',
    sourceRef: 'src/core/runtime/actions.ts#eventsForRunCancellation',
  },
] as const;

export const L1_TOOL_VERIFICATION_ADAPTER_IDS_V1 = L1_TOOL_VERIFICATION_ADAPTERS_V1.map(
  (entry) => entry.adapterId,
) as unknown as readonly [
  'runtime-tool-approval-verification-v1',
  'runtime-invalid-tool-correction-v1',
  'runtime-approval-rejection-v1',
  'runtime-approved-parallel-tools-v1',
  'runtime-unknown-late-terminal-v1',
  'runtime-required-verification-v1',
  'runtime-bounded-cleanup-v1',
];
export type L1ToolVerificationAdapterIdV1 = (typeof L1_TOOL_VERIFICATION_ADAPTER_IDS_V1)[number];

export const L1_TOOL_VERIFICATION_ASSERTION_IDS_V1 = L1_TOOL_VERIFICATION_ADAPTERS_V1.map(
  (entry) => entry.assertionId,
) as unknown as readonly [
  'l1.runtime.tool-approval-verification.v1',
  'l1.runtime.invalid-tool-correction.v1',
  'l1.runtime.approval-rejection-aborts-turn.v1',
  'l1.runtime.approved-parallel-tools.v1',
  'l1.runtime.unknown-and-late-terminal.v1',
  'l1.runtime.required-verification-blocks-completion.v1',
  'l1.runtime.bounded-cleanup-retains-unknown.v1',
];
export type L1ToolVerificationAssertionIdV1 =
  (typeof L1_TOOL_VERIFICATION_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L1_TOOL_VERIFICATION_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_TOOL_VERIFICATION_ASSERTION_IDS_V1);

export function isRegisteredL1ToolVerificationPairV1(
  adapterId: L1ToolVerificationAdapterIdV1,
  assertionId: L1ToolVerificationAssertionIdV1,
): boolean {
  return L1_TOOL_VERIFICATION_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: { adapterId: L1ToolVerificationAdapterIdV1; assertionId: L1ToolVerificationAssertionIdV1 },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1ToolVerificationPairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 adapter/assertion pair is not registered',
    });
  }
}

/** Exact declaration a source owner may later place beside its owned symbol. */
export const l1SourceOwnedContractDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1SourceOwnedContractDeclarationV1 = z.infer<
  typeof l1SourceOwnedContractDeclarationV1Schema
>;

const l1SourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1SourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SourceOwnedBindingMaterialV1 = z.infer<typeof l1SourceOwnedBindingMaterialV1Schema>;

export function computeL1SourceOwnedBindingDigestV1(
  material: L1SourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.source-owned-binding.v1',
    canonicalJsonBytes(l1SourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1SourceOwnedBindingV1Schema = l1SourceOwnedBindingMaterialV1Schema
  .extend({ bindingDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { bindingDigest, ...material } = value;
    const expected = computeL1SourceOwnedBindingDigestV1(material);
    if (bindingDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['bindingDigest'],
        message: `L1 source-owned binding digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SourceOwnedBindingV1 = z.infer<typeof l1SourceOwnedBindingV1Schema>;

/**
 * A source owner supplies the surface identity; qualification code supplies
 * only the closed adapter/assertion declaration. No Feature mapping is
 * accepted here, so this cannot become a parallel matrix authority.
 */
export function buildL1SourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1SourceOwnedContractDeclarationV1;
}): L1SourceOwnedBindingV1 {
  const declaration = l1SourceOwnedContractDeclarationV1Schema.parse(input.declaration);
  const material = l1SourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1SourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1SourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1SourceOwnedBindingDigestV1(material),
  });
}

export const L1_TOOL_VERIFICATION_CASE_IDS_V1 = [
  'l1-approval-rejection-aborts-turn-v1',
  'l1-approved-parallel-tools-v1',
  'l1-bounded-cleanup-retains-unknown-v1',
  'l1-invalid-tool-arguments-corrected-v1',
  'l1-required-verification-blocks-false-completion-v1',
  'l1-tool-approval-execution-verification-v1',
  'l1-unknown-dispatch-and-late-terminal-v1',
] as const;
export type L1ToolVerificationCaseIdV1 = (typeof L1_TOOL_VERIFICATION_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_TOOL_VERIFICATION_CASE_IDS_V1);

export const l1ToolVerificationCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    category: z.enum(['journey', 'negative']),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1ToolVerificationCaseV1 = z.infer<typeof l1ToolVerificationCaseV1Schema>;

/**
 * The corpus carries only stable IDs and ownership. It never stores fixture
 * prompts, tool arguments, result content, source text, paths, or endpoints.
 */
export const L1_TOOL_VERIFICATION_CORPUS_V1 = [
  {
    caseId: 'l1-approval-rejection-aborts-turn-v1',
    category: 'negative',
    adapterId: 'runtime-approval-rejection-v1',
    assertionId: 'l1.runtime.approval-rejection-aborts-turn.v1',
  },
  {
    caseId: 'l1-approved-parallel-tools-v1',
    category: 'negative',
    adapterId: 'runtime-approved-parallel-tools-v1',
    assertionId: 'l1.runtime.approved-parallel-tools.v1',
  },
  {
    caseId: 'l1-bounded-cleanup-retains-unknown-v1',
    category: 'negative',
    adapterId: 'runtime-bounded-cleanup-v1',
    assertionId: 'l1.runtime.bounded-cleanup-retains-unknown.v1',
  },
  {
    caseId: 'l1-invalid-tool-arguments-corrected-v1',
    category: 'journey',
    adapterId: 'runtime-invalid-tool-correction-v1',
    assertionId: 'l1.runtime.invalid-tool-correction.v1',
  },
  {
    caseId: 'l1-required-verification-blocks-false-completion-v1',
    category: 'negative',
    adapterId: 'runtime-required-verification-v1',
    assertionId: 'l1.runtime.required-verification-blocks-completion.v1',
  },
  {
    caseId: 'l1-tool-approval-execution-verification-v1',
    category: 'journey',
    adapterId: 'runtime-tool-approval-verification-v1',
    assertionId: 'l1.runtime.tool-approval-verification.v1',
  },
  {
    caseId: 'l1-unknown-dispatch-and-late-terminal-v1',
    category: 'negative',
    adapterId: 'runtime-unknown-late-terminal-v1',
    assertionId: 'l1.runtime.unknown-and-late-terminal.v1',
  },
] as const satisfies readonly L1ToolVerificationCaseV1[];

function exactCaseInventory(values: readonly string[], context: z.RefinementCtx): void {
  const exact =
    values.length === L1_TOOL_VERIFICATION_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_TOOL_VERIFICATION_CASE_IDS_V1[index]);
  if (!exact) {
    context.addIssue({
      code: 'custom',
      message: 'L1 corpus cases must be the exact code-point-sorted inventory',
    });
  }
}

export const l1ToolVerificationCorpusV1Schema = z
  .array(l1ToolVerificationCaseV1Schema)
  .superRefine((value, context) =>
    exactCaseInventory(
      value.map((entry) => entry.caseId),
      context,
    ),
  );
export type L1ToolVerificationCorpusV1 = z.infer<typeof l1ToolVerificationCorpusV1Schema>;

export function computeL1ToolVerificationCorpusDigestV1(
  corpus: L1ToolVerificationCorpusV1 = L1_TOOL_VERIFICATION_CORPUS_V1 as unknown as L1ToolVerificationCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tool-verification.corpus.v1',
    canonicalJsonBytes(l1ToolVerificationCorpusV1Schema.parse(corpus)),
  );
}

const l1ToolVerificationSuiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1ToolVerificationSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_TOOL_VERIFICATION_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedAdapters = L1_TOOL_VERIFICATION_ADAPTER_IDS_V1;
    const expectedAssertions = L1_TOOL_VERIFICATION_ASSERTION_IDS_V1;
    if (value.corpusDigest !== computeL1ToolVerificationCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 corpus digest must bind the exact closed corpus inventory',
      });
    }
    if (
      value.adapterIds.length !== expectedAdapters.length ||
      !value.adapterIds.every((entry, index) => entry === expectedAdapters[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 adapters must be exact',
      });
    }
    if (
      value.assertionIds.length !== expectedAssertions.length ||
      !value.assertionIds.every((entry, index) => entry === expectedAssertions[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 assertions must be exact',
      });
    }
  });
export type L1ToolVerificationSuiteMaterialV1 = z.infer<
  typeof l1ToolVerificationSuiteMaterialV1Schema
>;

export function computeL1ToolVerificationSuiteDigestV1(
  material: L1ToolVerificationSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tool-verification.suite.v1',
    canonicalJsonBytes(l1ToolVerificationSuiteMaterialV1Schema.parse(material)),
  );
}

export const l1ToolVerificationSuiteV1Schema = l1ToolVerificationSuiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1ToolVerificationSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1ToolVerificationSuiteV1 = z.infer<typeof l1ToolVerificationSuiteV1Schema>;

export function buildL1ToolVerificationSuiteV1(): L1ToolVerificationSuiteV1 {
  const material = l1ToolVerificationSuiteMaterialV1Schema.parse({
    schema: 'L1ToolVerificationSuiteV1',
    version: 1,
    suiteId: L1_TOOL_VERIFICATION_SUITE_ID_V1,
    corpusDigest: computeL1ToolVerificationCorpusDigestV1(),
    adapterIds: [...L1_TOOL_VERIFICATION_ADAPTER_IDS_V1],
    assertionIds: [...L1_TOOL_VERIFICATION_ASSERTION_IDS_V1],
  });
  return l1ToolVerificationSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1ToolVerificationSuiteDigestV1(material),
  });
}

/**
 * Receipt construction must use this identity rather than the evaluator's
 * self-contract suite above. The generic QualificationSuiteV1 is generated
 * by the source-owned catalog and is the sole Matrix-compatible suite digest.
 * This adapter does not manufacture one, preventing a qualification-local
 * parallel source of truth from becoming evidence authority.
 */
export const l1ToolVerificationCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1ToolVerificationCatalogSuiteIdentityV1 = z.infer<
  typeof l1ToolVerificationCatalogSuiteIdentityV1Schema
>;

export function bindL1ToolVerificationCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1ToolVerificationCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  if (parsed.suiteId !== L1_TOOL_VERIFICATION_SUITE_ID_V1) {
    throw new Error('l1_catalog_suite_id_mismatch');
  }
  const requiredAssertions = [...L1_TOOL_VERIFICATION_ASSERTION_IDS_V1].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    parsed.assertionIds.length !== requiredAssertions.length ||
    !parsed.assertionIds.every((assertionId, index) => assertionId === requiredAssertions[index])
  ) {
    throw new Error('l1_catalog_suite_assertion_inventory_mismatch');
  }
  return l1ToolVerificationCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

const l1ToolVerificationEvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1ToolVerificationEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_TOOL_VERIFICATION_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
    faultInjectionDigest: digestSchema,
  })
  .strict();
export type L1ToolVerificationEvaluatorIdentityMaterialV1 = z.infer<
  typeof l1ToolVerificationEvaluatorIdentityMaterialV1Schema
>;

export function computeL1ToolVerificationEvaluatorIdentityDigestV1(
  material: L1ToolVerificationEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tool-verification.evaluator-identity.v1',
    canonicalJsonBytes(l1ToolVerificationEvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1ToolVerificationEvaluatorIdentityV1Schema =
  l1ToolVerificationEvaluatorIdentityMaterialV1Schema
    .extend({ evaluatorDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { evaluatorDigest, ...material } = value;
      const expected = computeL1ToolVerificationEvaluatorIdentityDigestV1(material);
      if (evaluatorDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['evaluatorDigest'],
          message: `L1 evaluator digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1ToolVerificationEvaluatorIdentityV1 = z.infer<
  typeof l1ToolVerificationEvaluatorIdentityV1Schema
>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

export function buildL1ToolVerificationEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  faultInjection: unknown;
  suite?: L1ToolVerificationSuiteV1;
}): L1ToolVerificationEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL1ToolVerificationSuiteV1();
  const material = l1ToolVerificationEvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1ToolVerificationEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_TOOL_VERIFICATION_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest(
      'kite.qualification.l1.tool-verification.oracle.v1',
      input.oracle,
    ),
    verifierDigest: dependencyDigest(
      'kite.qualification.l1.tool-verification.verifier.v1',
      input.verifier,
    ),
    runnerDigest: dependencyDigest(
      'kite.qualification.l1.tool-verification.runner.v1',
      input.runner,
    ),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l1.tool-verification.scheduler.v1',
      input.scheduler,
    ),
    faultInjectionDigest: dependencyDigest(
      'kite.qualification.l1.tool-verification.fault-injection.v1',
      input.faultInjection,
    ),
  });
  return l1ToolVerificationEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1ToolVerificationEvaluatorIdentityDigestV1(material),
  });
}

/** A stable, metadata-only product of one adapter execution. */
export const l1ToolVerificationAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1ToolVerificationAdapterResultV1 = z.infer<
  typeof l1ToolVerificationAdapterResultV1Schema
>;

export function assertL1QualificationSafeIdentifierV1(value: string): string {
  return identifierSchema.parse(value);
}
