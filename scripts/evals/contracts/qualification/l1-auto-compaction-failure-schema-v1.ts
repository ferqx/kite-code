import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L1 auto-compaction failure identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * AQ-9A is a local, deterministic diagnostic contract. It is not a release
 * evidence, release bundle, Gate, or production-admission input.
 */
export const L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1 = 'qualification-l1-auto-compaction-failure-v1';
export const L1_AUTO_COMPACTION_FAILURE_EVALUATOR_ID_V1 =
  'qualification-l1-auto-compaction-failure-evaluator-v1';
export const L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1 = 'l1-auto-compaction-failure-fixture-v1';
export const L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1 =
  'qualification-l1-auto-compaction-failure-runner-v1';

/**
 * These labels distinguish deterministic fault injection only. The product
 * intentionally preserves one terminal transport mapping: each injected
 * failure reaches `context.compaction_failed(summary_model_failed)`.
 */
export const L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1 = [
  {
    adapterId: 'auto-compaction-provider-failure-v1',
    assertionId: 'l1.auto-compaction.provider-failure.v1',
  },
  {
    adapterId: 'auto-compaction-provider-network-failure-v1',
    assertionId: 'l1.auto-compaction.provider-network-failure.v1',
  },
  {
    adapterId: 'auto-compaction-summary-failure-v1',
    assertionId: 'l1.auto-compaction.summary-failure.v1',
  },
] as const;

export const L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'auto-compaction-provider-failure-v1',
    assertionId: 'l1.auto-compaction.provider-failure.v1',
    sourceRef: 'src/core/controllers/model-controller.ts#invokeRuntimeModel',
  },
  {
    adapterId: 'auto-compaction-provider-network-failure-v1',
    assertionId: 'l1.auto-compaction.provider-network-failure.v1',
    sourceRef: 'src/core/controllers/model-controller.ts#invokeRuntimeModel',
  },
  {
    adapterId: 'auto-compaction-summary-failure-v1',
    assertionId: 'l1.auto-compaction.summary-failure.v1',
    sourceRef: 'src/core/controllers/model-controller.ts#invokeRuntimeModel',
  },
] as const;

export const L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1 = L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.map(
  (entry) => entry.adapterId,
) as unknown as readonly [
  'auto-compaction-provider-failure-v1',
  'auto-compaction-provider-network-failure-v1',
  'auto-compaction-summary-failure-v1',
];
export type L1AutoCompactionFailureAdapterIdV1 =
  (typeof L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1)[number];

export const L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1 =
  L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.map((entry) => entry.assertionId) as unknown as readonly [
    'l1.auto-compaction.provider-failure.v1',
    'l1.auto-compaction.provider-network-failure.v1',
    'l1.auto-compaction.summary-failure.v1',
  ];
export type L1AutoCompactionFailureAssertionIdV1 =
  (typeof L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1);

export function isRegisteredL1AutoCompactionFailurePairV1(
  adapterId: L1AutoCompactionFailureAdapterIdV1,
  assertionId: L1AutoCompactionFailureAssertionIdV1,
): boolean {
  return L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: {
    adapterId: L1AutoCompactionFailureAdapterIdV1;
    assertionId: L1AutoCompactionFailureAssertionIdV1;
  },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1AutoCompactionFailurePairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 auto-compaction failure adapter/assertion pair is not registered',
    });
  }
}

/** Exact declaration stored beside the product operation that owns admission. */
export const l1AutoCompactionFailureSourceOwnedDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1AutoCompactionFailureSourceOwnedDeclarationV1 = z.infer<
  typeof l1AutoCompactionFailureSourceOwnedDeclarationV1Schema
>;

const sourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureSourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1AutoCompactionFailureSourceOwnedBindingMaterialV1 = z.infer<
  typeof sourceOwnedBindingMaterialV1Schema
>;

export function computeL1AutoCompactionFailureSourceOwnedBindingDigestV1(
  material: L1AutoCompactionFailureSourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.source-owned-binding.v1',
    canonicalJsonBytes(sourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1AutoCompactionFailureSourceOwnedBindingV1Schema = sourceOwnedBindingMaterialV1Schema
  .extend({ bindingDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { bindingDigest, ...material } = value;
    const expected = computeL1AutoCompactionFailureSourceOwnedBindingDigestV1(material);
    if (bindingDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['bindingDigest'],
        message: `L1 auto-compaction failure source binding digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1AutoCompactionFailureSourceOwnedBindingV1 = z.infer<
  typeof l1AutoCompactionFailureSourceOwnedBindingV1Schema
>;

export function buildL1AutoCompactionFailureSourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1AutoCompactionFailureSourceOwnedDeclarationV1;
}): L1AutoCompactionFailureSourceOwnedBindingV1 {
  const declaration = l1AutoCompactionFailureSourceOwnedDeclarationV1Schema.parse(
    input.declaration,
  );
  const material = sourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1AutoCompactionFailureSourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1AutoCompactionFailureSourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1AutoCompactionFailureSourceOwnedBindingDigestV1(material),
  });
}

export const L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1 = [
  'l1-auto-compaction-provider-failure-v1',
  'l1-auto-compaction-provider-network-failure-v1',
  'l1-auto-compaction-summary-failure-v1',
] as const;
export type L1AutoCompactionFailureCaseIdV1 =
  (typeof L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1);
export const l1AutoCompactionFailureCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    category: z.literal('negative'),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1AutoCompactionFailureCaseV1 = z.infer<typeof l1AutoCompactionFailureCaseV1Schema>;

/** Corpus contains only stable case ownership; prompts, errors, and workspace data are omitted. */
export const L1_AUTO_COMPACTION_FAILURE_CORPUS_V1 = [
  {
    caseId: 'l1-auto-compaction-provider-failure-v1',
    category: 'negative',
    adapterId: 'auto-compaction-provider-failure-v1',
    assertionId: 'l1.auto-compaction.provider-failure.v1',
  },
  {
    caseId: 'l1-auto-compaction-provider-network-failure-v1',
    category: 'negative',
    adapterId: 'auto-compaction-provider-network-failure-v1',
    assertionId: 'l1.auto-compaction.provider-network-failure.v1',
  },
  {
    caseId: 'l1-auto-compaction-summary-failure-v1',
    category: 'negative',
    adapterId: 'auto-compaction-summary-failure-v1',
    assertionId: 'l1.auto-compaction.summary-failure.v1',
  },
] as const satisfies readonly L1AutoCompactionFailureCaseV1[];

export const l1AutoCompactionFailureCorpusV1Schema = z
  .array(l1AutoCompactionFailureCaseV1Schema)
  .superRefine((value, context) => {
    const exact =
      value.length === L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1.length &&
      value.every((entry, index) => entry.caseId === L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1[index]);
    if (!exact) {
      context.addIssue({
        code: 'custom',
        message: 'L1 auto-compaction failure corpus must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1AutoCompactionFailureCorpusV1 = z.infer<typeof l1AutoCompactionFailureCorpusV1Schema>;

export function computeL1AutoCompactionFailureCorpusDigestV1(
  corpus: L1AutoCompactionFailureCorpusV1 = L1_AUTO_COMPACTION_FAILURE_CORPUS_V1 as unknown as L1AutoCompactionFailureCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.corpus.v1',
    canonicalJsonBytes(l1AutoCompactionFailureCorpusV1Schema.parse(corpus)),
  );
}

const suiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.corpusDigest !== computeL1AutoCompactionFailureCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 auto-compaction failure suite must bind the closed corpus',
      });
    }
    if (
      value.adapterIds.length !== L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1.length ||
      !value.adapterIds.every(
        (entry, index) => entry === L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 adapters must be exact',
      });
    }
    if (
      value.assertionIds.length !== L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1.length ||
      !value.assertionIds.every(
        (entry, index) => entry === L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 assertions must be exact',
      });
    }
  });
export type L1AutoCompactionFailureSuiteMaterialV1 = z.infer<typeof suiteMaterialV1Schema>;

export function computeL1AutoCompactionFailureSuiteDigestV1(
  material: L1AutoCompactionFailureSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.suite.v1',
    canonicalJsonBytes(suiteMaterialV1Schema.parse(material)),
  );
}

export const l1AutoCompactionFailureSuiteV1Schema = suiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1AutoCompactionFailureSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 auto-compaction failure suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1AutoCompactionFailureSuiteV1 = z.infer<typeof l1AutoCompactionFailureSuiteV1Schema>;

export function buildL1AutoCompactionFailureSuiteV1(): L1AutoCompactionFailureSuiteV1 {
  const material = suiteMaterialV1Schema.parse({
    schema: 'L1AutoCompactionFailureSuiteV1',
    version: 1,
    suiteId: L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
    corpusDigest: computeL1AutoCompactionFailureCorpusDigestV1(),
    adapterIds: [...L1_AUTO_COMPACTION_FAILURE_ADAPTER_IDS_V1],
    assertionIds: [...L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1],
  });
  return l1AutoCompactionFailureSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1AutoCompactionFailureSuiteDigestV1(material),
  });
}

export const l1AutoCompactionFailureCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1AutoCompactionFailureCatalogSuiteIdentityV1 = z.infer<
  typeof l1AutoCompactionFailureCatalogSuiteIdentityV1Schema
>;

/** Bind receipts to the Matrix-generated suite rather than this self-contract. */
export function bindL1AutoCompactionFailureCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1AutoCompactionFailureCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  if (parsed.suiteId !== L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1) {
    throw new Error('l1_auto_compaction_failure_catalog_suite_id_mismatch');
  }
  const expectedAssertions = [...L1_AUTO_COMPACTION_FAILURE_ASSERTION_IDS_V1].sort();
  if (
    parsed.assertionIds.length !== expectedAssertions.length ||
    !parsed.assertionIds.every((assertionId, index) => assertionId === expectedAssertions[index])
  ) {
    throw new Error('l1_auto_compaction_failure_catalog_suite_assertion_mismatch');
  }
  return l1AutoCompactionFailureCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

export function computeL1AutoCompactionFailureVerifierDigestV1(): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.verifier.v1',
    canonicalJsonBytes({
      schema: 'L1AutoCompactionFailureVerifierIdentityV1',
      version: 1,
      suiteId: L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
      inventory: 'closed-failure-taxonomy-v1',
    }),
  );
}

export function computeL1AutoCompactionFailureRunnerDigestV1(): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.runner.v1',
    canonicalJsonBytes({
      schema: 'L1AutoCompactionFailureRunnerIdentityV1',
      version: 1,
      runner: L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
      fixtureId: L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
      isolation: 'fresh-synthetic-root-zero-network-v1',
    }),
  );
}

const evaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_AUTO_COMPACTION_FAILURE_EVALUATOR_ID_V1),
    oracle: z
      .object({ path: z.literal('kernel-model-controller-scheduler-executor-reducer-v1') })
      .strict(),
    verifier: z.object({ inventory: z.literal('closed-failure-taxonomy-v1') }).strict(),
    verifierDigest: digestSchema,
    runner: z
      .object({
        runner: z.literal(L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1),
        fixtureId: z.literal(L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1),
        isolation: z.literal('fresh-synthetic-root-zero-network-v1'),
      })
      .strict(),
    runnerDigest: digestSchema,
    policy: z
      .object({
        trigger: z.literal('in-memory-absolute-8192-v1'),
        context: z.literal('actual-estimator-safe-synthetic-9k-12k-v1'),
        defaults: z.literal('unchanged-no-context-window-override-v1'),
      })
      .strict(),
    faultInjection: z
      .object({
        transport: z.literal('local-do-generate-no-network-v1'),
        terminal: z.literal('summary-model-failed-preserved-v1'),
      })
      .strict(),
  })
  .strict();
export type L1AutoCompactionFailureEvaluatorIdentityMaterialV1 = z.infer<
  typeof evaluatorIdentityMaterialV1Schema
>;

export function computeL1AutoCompactionFailureEvaluatorDigestV1(
  material: L1AutoCompactionFailureEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.evaluator.v1',
    canonicalJsonBytes(evaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1AutoCompactionFailureEvaluatorIdentityV1Schema = evaluatorIdentityMaterialV1Schema
  .extend({ evaluatorDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { evaluatorDigest, ...material } = value;
    if (value.verifierDigest !== computeL1AutoCompactionFailureVerifierDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['verifierDigest'],
        message: 'L1 auto-compaction failure verifier digest mismatch',
      });
    }
    if (value.runnerDigest !== computeL1AutoCompactionFailureRunnerDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['runnerDigest'],
        message: 'L1 auto-compaction failure runner digest mismatch',
      });
    }
    const expected = computeL1AutoCompactionFailureEvaluatorDigestV1(material);
    if (evaluatorDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['evaluatorDigest'],
        message: `L1 auto-compaction failure evaluator digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1AutoCompactionFailureEvaluatorIdentityV1 = z.infer<
  typeof l1AutoCompactionFailureEvaluatorIdentityV1Schema
>;

export function buildL1AutoCompactionFailureEvaluatorIdentityV1(): L1AutoCompactionFailureEvaluatorIdentityV1 {
  const material = evaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1AutoCompactionFailureEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_AUTO_COMPACTION_FAILURE_EVALUATOR_ID_V1,
    oracle: { path: 'kernel-model-controller-scheduler-executor-reducer-v1' },
    verifier: { inventory: 'closed-failure-taxonomy-v1' },
    verifierDigest: computeL1AutoCompactionFailureVerifierDigestV1(),
    runner: {
      runner: L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
      fixtureId: L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
      isolation: 'fresh-synthetic-root-zero-network-v1',
    },
    runnerDigest: computeL1AutoCompactionFailureRunnerDigestV1(),
    policy: {
      trigger: 'in-memory-absolute-8192-v1',
      context: 'actual-estimator-safe-synthetic-9k-12k-v1',
      defaults: 'unchanged-no-context-window-override-v1',
    },
    faultInjection: {
      transport: 'local-do-generate-no-network-v1',
      terminal: 'summary-model-failed-preserved-v1',
    },
  });
  return l1AutoCompactionFailureEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1AutoCompactionFailureEvaluatorDigestV1(material),
  });
}

export const l1AutoCompactionFailureAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1AutoCompactionFailureAdapterResultV1 = z.infer<
  typeof l1AutoCompactionFailureAdapterResultV1Schema
>;
