import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L1 projection identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * This is a diagnostic-only public-projection suite. It has no release-gate,
 * release-bundle, or admission meaning; a later source-owned collector alone
 * may join its closed assertions to public Features.
 */
export const L1_PUBLIC_PROJECTION_SUITE_ID_V1 = 'qualification-l1-public-projection-v1';
export const L1_PUBLIC_PROJECTION_EVALUATOR_ID_V1 =
  'qualification-l1-public-projection-evaluator-v1';
export const L1_PUBLIC_PROJECTION_FIXTURE_ID_V1 = 'l1-public-projection-fixture-v1';
export const L1_PUBLIC_PROJECTION_RUNNER_ID_V1 = 'qualification-l1-public-projection-runner-v1';

export const L1_PUBLIC_PROJECTION_ADAPTER_IDS_V1 = [
  'cli-invalid-arguments-projection-v1',
  'cli-tool-approval-projection-v1',
  'tui-invalid-arguments-projection-v1',
  'tui-provider-action-projection-v1',
  'tui-tool-approval-projection-v1',
] as const;
export type L1PublicProjectionAdapterIdV1 = (typeof L1_PUBLIC_PROJECTION_ADAPTER_IDS_V1)[number];

export const L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1 = [
  'l1.projection.cli.invalid-arguments.v1',
  'l1.projection.cli.tool-approval.v1',
  'l1.projection.tui.invalid-arguments.v1',
  'l1.projection.tui.provider-action.v1',
  'l1.projection.tui.tool-approval.v1',
] as const;
export type L1PublicProjectionAssertionIdV1 =
  (typeof L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1)[number];

export const L1_PUBLIC_PROJECTION_ADAPTERS_V1 = [
  {
    adapterId: 'cli-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.cli.invalid-arguments.v1',
  },
  {
    adapterId: 'cli-tool-approval-projection-v1',
    assertionId: 'l1.projection.cli.tool-approval.v1',
  },
  {
    adapterId: 'tui-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.tui.invalid-arguments.v1',
  },
  {
    adapterId: 'tui-provider-action-projection-v1',
    assertionId: 'l1.projection.tui.provider-action.v1',
  },
  {
    adapterId: 'tui-tool-approval-projection-v1',
    assertionId: 'l1.projection.tui.tool-approval.v1',
  },
] as const;

/** Lightweight implementation provenance for source-owned collection. */
export const L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'cli-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.cli.invalid-arguments.v1',
    sourceRef: 'src/app/cli/runtime-event-projection.ts#projectCliRuntimeEventV1',
  },
  {
    adapterId: 'cli-tool-approval-projection-v1',
    assertionId: 'l1.projection.cli.tool-approval.v1',
    sourceRef: 'src/app/cli/runtime-event-projection.ts#projectCliRuntimeEventV1',
  },
  {
    adapterId: 'tui-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.tui.invalid-arguments.v1',
    sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
  },
  {
    adapterId: 'tui-provider-action-projection-v1',
    assertionId: 'l1.projection.tui.provider-action.v1',
    sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
  },
  {
    adapterId: 'tui-tool-approval-projection-v1',
    assertionId: 'l1.projection.tui.tool-approval.v1',
    sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
  },
] as const;

const adapterIdSchema = z.enum(L1_PUBLIC_PROJECTION_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1);

export function isRegisteredL1PublicProjectionPairV1(
  adapterId: L1PublicProjectionAdapterIdV1,
  assertionId: L1PublicProjectionAssertionIdV1,
): boolean {
  return L1_PUBLIC_PROJECTION_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: {
    adapterId: L1PublicProjectionAdapterIdV1;
    assertionId: L1PublicProjectionAssertionIdV1;
  },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1PublicProjectionPairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 public-projection adapter/assertion pair is not registered',
    });
  }
}

/** The exact declaration a product-owned public projection may carry later. */
export const l1PublicProjectionSourceOwnedDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1PublicProjectionSourceOwnedDeclarationV1 = z.infer<
  typeof l1PublicProjectionSourceOwnedDeclarationV1Schema
>;

const l1PublicProjectionSourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionSourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1PublicProjectionSourceOwnedBindingMaterialV1 = z.infer<
  typeof l1PublicProjectionSourceOwnedBindingMaterialV1Schema
>;

export function computeL1PublicProjectionSourceOwnedBindingDigestV1(
  material: L1PublicProjectionSourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.source-owned-binding.v1',
    canonicalJsonBytes(l1PublicProjectionSourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1PublicProjectionSourceOwnedBindingV1Schema =
  l1PublicProjectionSourceOwnedBindingMaterialV1Schema
    .extend({ bindingDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { bindingDigest, ...material } = value;
      const expected = computeL1PublicProjectionSourceOwnedBindingDigestV1(material);
      if (bindingDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['bindingDigest'],
          message: `L1 public-projection source binding digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1PublicProjectionSourceOwnedBindingV1 = z.infer<
  typeof l1PublicProjectionSourceOwnedBindingV1Schema
>;

/**
 * Qualification owns only the closed pair. `sourceSurfaceId` remains a
 * source-owned input so this helper cannot manufacture a parallel Feature map.
 */
export function buildL1PublicProjectionSourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1PublicProjectionSourceOwnedDeclarationV1;
}): L1PublicProjectionSourceOwnedBindingV1 {
  const declaration = l1PublicProjectionSourceOwnedDeclarationV1Schema.parse(input.declaration);
  const material = l1PublicProjectionSourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1PublicProjectionSourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1PublicProjectionSourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1PublicProjectionSourceOwnedBindingDigestV1(material),
  });
}

export const L1_PUBLIC_PROJECTION_CASE_IDS_V1 = [
  'l1-cli-invalid-arguments-projection-v1',
  'l1-cli-tool-approval-projection-v1',
  'l1-tui-invalid-arguments-projection-v1',
  'l1-tui-provider-action-projection-v1',
  'l1-tui-tool-approval-projection-v1',
] as const;
export type L1PublicProjectionCaseIdV1 = (typeof L1_PUBLIC_PROJECTION_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_PUBLIC_PROJECTION_CASE_IDS_V1);
export const l1PublicProjectionCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1PublicProjectionCaseV1 = z.infer<typeof l1PublicProjectionCaseV1Schema>;

/**
 * The local corpus intentionally holds only stable IDs. It cannot retain a
 * rendered response, terminal message, source body, path, or route.
 */
export const L1_PUBLIC_PROJECTION_CORPUS_V1 = [
  {
    caseId: 'l1-cli-invalid-arguments-projection-v1',
    adapterId: 'cli-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.cli.invalid-arguments.v1',
  },
  {
    caseId: 'l1-cli-tool-approval-projection-v1',
    adapterId: 'cli-tool-approval-projection-v1',
    assertionId: 'l1.projection.cli.tool-approval.v1',
  },
  {
    caseId: 'l1-tui-invalid-arguments-projection-v1',
    adapterId: 'tui-invalid-arguments-projection-v1',
    assertionId: 'l1.projection.tui.invalid-arguments.v1',
  },
  {
    caseId: 'l1-tui-provider-action-projection-v1',
    adapterId: 'tui-provider-action-projection-v1',
    assertionId: 'l1.projection.tui.provider-action.v1',
  },
  {
    caseId: 'l1-tui-tool-approval-projection-v1',
    adapterId: 'tui-tool-approval-projection-v1',
    assertionId: 'l1.projection.tui.tool-approval.v1',
  },
] as const satisfies readonly L1PublicProjectionCaseV1[];

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

export const l1PublicProjectionCorpusV1Schema = z
  .array(l1PublicProjectionCaseV1Schema)
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.map((entry) => entry.caseId),
        L1_PUBLIC_PROJECTION_CASE_IDS_V1,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L1 public-projection corpus must be the exact code-point-sorted case inventory',
      });
    }
  });
export type L1PublicProjectionCorpusV1 = z.infer<typeof l1PublicProjectionCorpusV1Schema>;

export function computeL1PublicProjectionCorpusDigestV1(
  corpus: L1PublicProjectionCorpusV1 = L1_PUBLIC_PROJECTION_CORPUS_V1 as unknown as L1PublicProjectionCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.corpus.v1',
    canonicalJsonBytes(l1PublicProjectionCorpusV1Schema.parse(corpus)),
  );
}

const l1PublicProjectionSuiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_PUBLIC_PROJECTION_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.corpusDigest !== computeL1PublicProjectionCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 public-projection corpus digest must bind the exact closed corpus inventory',
      });
    }
    if (!exactInventory(value.adapterIds, L1_PUBLIC_PROJECTION_ADAPTER_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 projection adapters must be exact',
      });
    }
    if (!exactInventory(value.assertionIds, L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 projection assertions must be exact',
      });
    }
  });
export type L1PublicProjectionSuiteMaterialV1 = z.infer<
  typeof l1PublicProjectionSuiteMaterialV1Schema
>;

export function computeL1PublicProjectionSuiteDigestV1(
  material: L1PublicProjectionSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.suite.v1',
    canonicalJsonBytes(l1PublicProjectionSuiteMaterialV1Schema.parse(material)),
  );
}

export const l1PublicProjectionSuiteV1Schema = l1PublicProjectionSuiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1PublicProjectionSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 projection suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1PublicProjectionSuiteV1 = z.infer<typeof l1PublicProjectionSuiteV1Schema>;

export function buildL1PublicProjectionSuiteV1(): L1PublicProjectionSuiteV1 {
  const material = l1PublicProjectionSuiteMaterialV1Schema.parse({
    schema: 'L1PublicProjectionSuiteV1',
    version: 1,
    suiteId: L1_PUBLIC_PROJECTION_SUITE_ID_V1,
    corpusDigest: computeL1PublicProjectionCorpusDigestV1(),
    adapterIds: [...L1_PUBLIC_PROJECTION_ADAPTER_IDS_V1],
    assertionIds: [...L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1],
  });
  return l1PublicProjectionSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1PublicProjectionSuiteDigestV1(material),
  });
}

/**
 * Receipt construction must bind this source-owned Matrix suite, never the
 * evaluator self-contract suite above. This prevents the local adapter from
 * creating a second Matrix authority.
 */
export const l1PublicProjectionCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1PublicProjectionCatalogSuiteIdentityV1 = z.infer<
  typeof l1PublicProjectionCatalogSuiteIdentityV1Schema
>;

export function bindL1PublicProjectionCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1PublicProjectionCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  if (parsed.suiteId !== L1_PUBLIC_PROJECTION_SUITE_ID_V1) {
    throw new Error('l1_public_projection_catalog_suite_id_mismatch');
  }
  const requiredAssertions = [...L1_PUBLIC_PROJECTION_ASSERTION_IDS_V1].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (!exactInventory(parsed.assertionIds, requiredAssertions)) {
    throw new Error('l1_public_projection_catalog_suite_assertion_inventory_mismatch');
  }
  return l1PublicProjectionCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

const l1PublicProjectionEvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_PUBLIC_PROJECTION_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
  })
  .strict();
export type L1PublicProjectionEvaluatorIdentityMaterialV1 = z.infer<
  typeof l1PublicProjectionEvaluatorIdentityMaterialV1Schema
>;

export function computeL1PublicProjectionEvaluatorIdentityDigestV1(
  material: L1PublicProjectionEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.evaluator-identity.v1',
    canonicalJsonBytes(l1PublicProjectionEvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1PublicProjectionEvaluatorIdentityV1Schema =
  l1PublicProjectionEvaluatorIdentityMaterialV1Schema
    .extend({ evaluatorDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { evaluatorDigest, ...material } = value;
      const expected = computeL1PublicProjectionEvaluatorIdentityDigestV1(material);
      if (evaluatorDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['evaluatorDigest'],
          message: `L1 projection evaluator digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1PublicProjectionEvaluatorIdentityV1 = z.infer<
  typeof l1PublicProjectionEvaluatorIdentityV1Schema
>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

export function buildL1PublicProjectionEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  suite?: L1PublicProjectionSuiteV1;
}): L1PublicProjectionEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL1PublicProjectionSuiteV1();
  const material = l1PublicProjectionEvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1PublicProjectionEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_PUBLIC_PROJECTION_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest(
      'kite.qualification.l1.public-projection.oracle.v1',
      input.oracle,
    ),
    verifierDigest: dependencyDigest(
      'kite.qualification.l1.public-projection.verifier.v1',
      input.verifier,
    ),
    runnerDigest: dependencyDigest(
      'kite.qualification.l1.public-projection.runner.v1',
      input.runner,
    ),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l1.public-projection.scheduler.v1',
      input.scheduler,
    ),
  });
  return l1PublicProjectionEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1PublicProjectionEvaluatorIdentityDigestV1(material),
  });
}

/** A stable, metadata-only result from one in-memory public projection call. */
export const l1PublicProjectionAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1PublicProjectionAdapterResultV1 = z.infer<
  typeof l1PublicProjectionAdapterResultV1Schema
>;

export function assertL1PublicProjectionSafeIdentifierV1(value: string): string {
  return identifierSchema.parse(value);
}
