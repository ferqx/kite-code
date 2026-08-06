import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L1 TUI rewind projection identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * This AQ-6 slice is a closed diagnostic observation only. It has no
 * admission meaning or eligibility input position.
 */
export const L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1 =
  'qualification-l1-tui-rewind-fork-projection-v1';
export const L1_TUI_REWIND_FORK_PROJECTION_EVALUATOR_ID_V1 =
  'qualification-l1-tui-rewind-fork-projection-evaluator-v1';
export const L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1 =
  'l1-tui-rewind-fork-projection-fixture-v1';
export const L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1 =
  'qualification-l1-tui-rewind-fork-projection-runner-v1';

/** One closed product-owned path; this is not a second public-projection suite. */
export const L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1 = [
  {
    adapterId: 'tui-rewind-fork-projection-v1',
    assertionId: 'l1.projection.tui.rewind-fork-tightening.v1',
  },
] as const;

export const L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IDS_V1 = [
  'tui-rewind-fork-projection-v1',
] as const;
export type L1TuiRewindForkProjectionAdapterIdV1 =
  (typeof L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IDS_V1)[number];

export const L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1 = [
  'l1.projection.tui.rewind-fork-tightening.v1',
] as const;
export type L1TuiRewindForkProjectionAssertionIdV1 =
  (typeof L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1);

export function isRegisteredL1TuiRewindForkProjectionPairV1(
  adapterId: L1TuiRewindForkProjectionAdapterIdV1,
  assertionId: L1TuiRewindForkProjectionAssertionIdV1,
): boolean {
  return L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: {
    adapterId: L1TuiRewindForkProjectionAdapterIdV1;
    assertionId: L1TuiRewindForkProjectionAssertionIdV1;
  },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1TuiRewindForkProjectionPairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 TUI rewind projection adapter/assertion pair is not registered',
    });
  }
}

/** Exact source annotation declaration; the source-owned collector owns Feature mapping. */
export const l1TuiRewindForkProjectionSourceOwnedDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1TuiRewindForkProjectionSourceOwnedDeclarationV1 = z.infer<
  typeof l1TuiRewindForkProjectionSourceOwnedDeclarationV1Schema
>;

const l1TuiRewindForkProjectionSourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionSourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1TuiRewindForkProjectionSourceOwnedBindingMaterialV1 = z.infer<
  typeof l1TuiRewindForkProjectionSourceOwnedBindingMaterialV1Schema
>;

export function computeL1TuiRewindForkProjectionSourceOwnedBindingDigestV1(
  material: L1TuiRewindForkProjectionSourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.source-owned-binding.v1',
    canonicalJsonBytes(l1TuiRewindForkProjectionSourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1TuiRewindForkProjectionSourceOwnedBindingV1Schema =
  l1TuiRewindForkProjectionSourceOwnedBindingMaterialV1Schema
    .extend({ bindingDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { bindingDigest, ...material } = value;
      const expected = computeL1TuiRewindForkProjectionSourceOwnedBindingDigestV1(material);
      if (bindingDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['bindingDigest'],
          message: `L1 TUI rewind projection source-owned binding digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1TuiRewindForkProjectionSourceOwnedBindingV1 = z.infer<
  typeof l1TuiRewindForkProjectionSourceOwnedBindingV1Schema
>;

export function buildL1TuiRewindForkProjectionSourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1TuiRewindForkProjectionSourceOwnedDeclarationV1;
}): L1TuiRewindForkProjectionSourceOwnedBindingV1 {
  const declaration = l1TuiRewindForkProjectionSourceOwnedDeclarationV1Schema.parse(
    input.declaration,
  );
  const material = l1TuiRewindForkProjectionSourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1TuiRewindForkProjectionSourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1TuiRewindForkProjectionSourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1TuiRewindForkProjectionSourceOwnedBindingDigestV1(material),
  });
}

/**
 * Provenance is closed implementation metadata. It records function symbols,
 * not source bodies, fixture paths, prompts, outputs, routes, or secrets.
 */
export const L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'tui-rewind-fork-projection-v1',
    assertionId: 'l1.projection.tui.rewind-fork-tightening.v1',
    sourceRef: 'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
    pathRefs: [
      'src/app/tui/public-surface.ts#parseSlashCommand',
      'src/app/tui/hooks/useSlashCommand.ts#useSlashCommand',
      'src/app/tui/hooks/useRewindHandler.ts#dispatchTuiRewindRequest',
      'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
      'src/core/runtime/store.ts#forkSession',
    ],
  },
] as const;

export const L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1 = [
  'l1-tui-rewind-fork-projection-v1',
] as const;
export type L1TuiRewindForkProjectionCaseIdV1 =
  (typeof L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1);
export const l1TuiRewindForkProjectionCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    category: z.literal('journey'),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1TuiRewindForkProjectionCaseV1 = z.infer<typeof l1TuiRewindForkProjectionCaseV1Schema>;

/** The sealed corpus keeps only stable cut-point IDs, never fixture payload. */
export const L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1 = [
  {
    caseId: 'l1-tui-rewind-fork-projection-v1',
    category: 'journey',
    adapterId: 'tui-rewind-fork-projection-v1',
    assertionId: 'l1.projection.tui.rewind-fork-tightening.v1',
  },
] as const satisfies readonly L1TuiRewindForkProjectionCaseV1[];

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

export const l1TuiRewindForkProjectionCorpusV1Schema = z
  .array(l1TuiRewindForkProjectionCaseV1Schema)
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.map((entry) => entry.caseId),
        L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L1 TUI rewind projection corpus must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1TuiRewindForkProjectionCorpusV1 = z.infer<
  typeof l1TuiRewindForkProjectionCorpusV1Schema
>;

export function computeL1TuiRewindForkProjectionCorpusDigestV1(
  corpus: L1TuiRewindForkProjectionCorpusV1 = L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1 as unknown as L1TuiRewindForkProjectionCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.corpus.v1',
    canonicalJsonBytes(l1TuiRewindForkProjectionCorpusV1Schema.parse(corpus)),
  );
}

const l1TuiRewindForkProjectionSuiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.corpusDigest !== computeL1TuiRewindForkProjectionCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 TUI rewind projection suite must bind the exact corpus',
      });
    }
    if (!exactInventory(value.adapterIds, L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 TUI rewind projection adapters must be exact',
      });
    }
    if (!exactInventory(value.assertionIds, L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 TUI rewind projection assertions must be exact',
      });
    }
  });
export type L1TuiRewindForkProjectionSuiteMaterialV1 = z.infer<
  typeof l1TuiRewindForkProjectionSuiteMaterialV1Schema
>;

export function computeL1TuiRewindForkProjectionSuiteDigestV1(
  material: L1TuiRewindForkProjectionSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.suite.v1',
    canonicalJsonBytes(l1TuiRewindForkProjectionSuiteMaterialV1Schema.parse(material)),
  );
}

export const l1TuiRewindForkProjectionSuiteV1Schema = l1TuiRewindForkProjectionSuiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1TuiRewindForkProjectionSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 TUI rewind projection suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1TuiRewindForkProjectionSuiteV1 = z.infer<
  typeof l1TuiRewindForkProjectionSuiteV1Schema
>;

export function buildL1TuiRewindForkProjectionSuiteV1(): L1TuiRewindForkProjectionSuiteV1 {
  const material = l1TuiRewindForkProjectionSuiteMaterialV1Schema.parse({
    schema: 'L1TuiRewindForkProjectionSuiteV1',
    version: 1,
    suiteId: L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
    corpusDigest: computeL1TuiRewindForkProjectionCorpusDigestV1(),
    adapterIds: [...L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IDS_V1],
    assertionIds: [...L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1],
  });
  return l1TuiRewindForkProjectionSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1TuiRewindForkProjectionSuiteDigestV1(material),
  });
}

/** A receipt accepts this identity only from the source-owned Matrix catalog. */
export const l1TuiRewindForkProjectionCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1TuiRewindForkProjectionCatalogSuiteIdentityV1 = z.infer<
  typeof l1TuiRewindForkProjectionCatalogSuiteIdentityV1Schema
>;

export function bindL1TuiRewindForkProjectionCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1TuiRewindForkProjectionCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  const expectedAssertions = [...L1_TUI_REWIND_FORK_PROJECTION_ASSERTION_IDS_V1];
  if (
    parsed.suiteId !== L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1 ||
    !exactInventory(parsed.assertionIds, expectedAssertions)
  ) {
    throw new Error('l1_tui_rewind_fork_projection_catalog_suite_identity_mismatch');
  }
  return l1TuiRewindForkProjectionCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

const l1TuiRewindForkProjectionEvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_TUI_REWIND_FORK_PROJECTION_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
    isolationDigest: digestSchema,
  })
  .strict();
export type L1TuiRewindForkProjectionEvaluatorIdentityMaterialV1 = z.infer<
  typeof l1TuiRewindForkProjectionEvaluatorIdentityMaterialV1Schema
>;

export function computeL1TuiRewindForkProjectionEvaluatorIdentityDigestV1(
  material: L1TuiRewindForkProjectionEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.evaluator-identity.v1',
    canonicalJsonBytes(l1TuiRewindForkProjectionEvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1TuiRewindForkProjectionEvaluatorIdentityV1Schema =
  l1TuiRewindForkProjectionEvaluatorIdentityMaterialV1Schema
    .extend({ evaluatorDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { evaluatorDigest, ...material } = value;
      const expected = computeL1TuiRewindForkProjectionEvaluatorIdentityDigestV1(material);
      if (evaluatorDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['evaluatorDigest'],
          message: `L1 TUI rewind projection evaluator digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1TuiRewindForkProjectionEvaluatorIdentityV1 = z.infer<
  typeof l1TuiRewindForkProjectionEvaluatorIdentityV1Schema
>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

export function buildL1TuiRewindForkProjectionEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  isolation: unknown;
  suite?: L1TuiRewindForkProjectionSuiteV1;
}): L1TuiRewindForkProjectionEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL1TuiRewindForkProjectionSuiteV1();
  const material = l1TuiRewindForkProjectionEvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1TuiRewindForkProjectionEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_TUI_REWIND_FORK_PROJECTION_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest(
      'kite.qualification.l1.tui-rewind-fork-projection.oracle.v1',
      input.oracle,
    ),
    verifierDigest: dependencyDigest(
      'kite.qualification.l1.tui-rewind-fork-projection.verifier.v1',
      input.verifier,
    ),
    runnerDigest: dependencyDigest(
      'kite.qualification.l1.tui-rewind-fork-projection.runner.v1',
      input.runner,
    ),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l1.tui-rewind-fork-projection.scheduler.v1',
      input.scheduler,
    ),
    isolationDigest: dependencyDigest(
      'kite.qualification.l1.tui-rewind-fork-projection.isolation.v1',
      input.isolation,
    ),
  });
  return l1TuiRewindForkProjectionEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1TuiRewindForkProjectionEvaluatorIdentityDigestV1(material),
  });
}

/** The adapter leaks no fixture data: only its closed pair and an outcome token. */
export const l1TuiRewindForkProjectionAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1TuiRewindForkProjectionAdapterResultV1 = z.infer<
  typeof l1TuiRewindForkProjectionAdapterResultV1Schema
>;

export function assertL1TuiRewindForkProjectionSafeIdentifierV1(value: string): string {
  return identifierSchema.parse(value);
}
