import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type QualificationSuiteV1, qualificationSuiteV1Schema } from './feature-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L1 subagent/recovery identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * AQ-6 is a sealed, deterministic diagnostic suite. It has no release
 * evidence, bundle, gate, or production-admission input position.
 */
export const L1_SUBAGENT_RECOVERY_SUITE_ID_V1 = 'qualification-l1-subagent-recovery-v1';
export const L1_SUBAGENT_RECOVERY_EVALUATOR_ID_V1 =
  'qualification-l1-subagent-recovery-evaluator-v1';
export const L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1 = 'l1-subagent-recovery-fixture-v1';
export const L1_SUBAGENT_RECOVERY_RUNNER_ID_V1 = 'qualification-l1-subagent-recovery-runner-v1';

/**
 * These pairs are closed implementation provenance, not a feature map. The
 * source-owned collector discovers the Feature ID beside each product symbol.
 */
export const L1_SUBAGENT_RECOVERY_ADAPTERS_V1 = [
  {
    adapterId: 'subagent-parent-child-reservation-v1',
    assertionId: 'l1.subagent.parent-child-reservation.v1',
  },
  {
    adapterId: 'subagent-approval-resume-claim-v1',
    assertionId: 'l1.subagent.approval-resume-claim.v1',
  },
  {
    adapterId: 'runtime-subagent-terminal-consumption-v1',
    assertionId: 'l1.runtime.subagent-terminal-consumption.v1',
  },
  {
    adapterId: 'runtime-subagent-restart-unknown-v1',
    assertionId: 'l1.runtime.subagent-restart-unknown.v1',
  },
  {
    adapterId: 'runtime-late-terminal-convergence-v1',
    assertionId: 'l1.runtime.late-terminal-convergence.v1',
  },
  {
    adapterId: 'runtime-parallel-cancel-convergence-v1',
    assertionId: 'l1.runtime.parallel-cancel-convergence.v1',
  },
  {
    adapterId: 'runtime-rewind-fork-tightening-v1',
    assertionId: 'l1.runtime.rewind-fork-tightening.v1',
  },
] as const;

export const L1_SUBAGENT_RECOVERY_ADAPTER_IDS_V1 = L1_SUBAGENT_RECOVERY_ADAPTERS_V1.map(
  (entry) => entry.adapterId,
) as unknown as readonly [
  'subagent-parent-child-reservation-v1',
  'subagent-approval-resume-claim-v1',
  'runtime-subagent-terminal-consumption-v1',
  'runtime-subagent-restart-unknown-v1',
  'runtime-late-terminal-convergence-v1',
  'runtime-parallel-cancel-convergence-v1',
  'runtime-rewind-fork-tightening-v1',
];
export type L1SubagentRecoveryAdapterIdV1 = (typeof L1_SUBAGENT_RECOVERY_ADAPTER_IDS_V1)[number];

export const L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1 = L1_SUBAGENT_RECOVERY_ADAPTERS_V1.map(
  (entry) => entry.assertionId,
) as unknown as readonly [
  'l1.subagent.parent-child-reservation.v1',
  'l1.subagent.approval-resume-claim.v1',
  'l1.runtime.subagent-terminal-consumption.v1',
  'l1.runtime.subagent-restart-unknown.v1',
  'l1.runtime.late-terminal-convergence.v1',
  'l1.runtime.parallel-cancel-convergence.v1',
  'l1.runtime.rewind-fork-tightening.v1',
];
export type L1SubagentRecoveryAssertionIdV1 =
  (typeof L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L1_SUBAGENT_RECOVERY_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1);

export function isRegisteredL1SubagentRecoveryPairV1(
  adapterId: L1SubagentRecoveryAdapterIdV1,
  assertionId: L1SubagentRecoveryAssertionIdV1,
): boolean {
  return L1_SUBAGENT_RECOVERY_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: { adapterId: L1SubagentRecoveryAdapterIdV1; assertionId: L1SubagentRecoveryAssertionIdV1 },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredL1SubagentRecoveryPairV1(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'L1 subagent/recovery adapter/assertion pair is not registered',
    });
  }
}

/** Exact declaration stored beside the product symbol that owns this cut point. */
export const l1SubagentRecoverySourceOwnedDeclarationV1Schema = z
  .object({ adapterId: adapterIdSchema, assertionId: assertionIdSchema })
  .strict()
  .superRefine(addPairIssue);
export type L1SubagentRecoverySourceOwnedDeclarationV1 = z.infer<
  typeof l1SubagentRecoverySourceOwnedDeclarationV1Schema
>;

const l1SubagentRecoverySourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoverySourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SubagentRecoverySourceOwnedBindingMaterialV1 = z.infer<
  typeof l1SubagentRecoverySourceOwnedBindingMaterialV1Schema
>;

export function computeL1SubagentRecoverySourceOwnedBindingDigestV1(
  material: L1SubagentRecoverySourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.source-owned-binding.v1',
    canonicalJsonBytes(l1SubagentRecoverySourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l1SubagentRecoverySourceOwnedBindingV1Schema =
  l1SubagentRecoverySourceOwnedBindingMaterialV1Schema
    .extend({ bindingDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { bindingDigest, ...material } = value;
      const expected = computeL1SubagentRecoverySourceOwnedBindingDigestV1(material);
      if (bindingDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['bindingDigest'],
          message: `L1 subagent/recovery source-owned binding digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1SubagentRecoverySourceOwnedBindingV1 = z.infer<
  typeof l1SubagentRecoverySourceOwnedBindingV1Schema
>;

export function buildL1SubagentRecoverySourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L1SubagentRecoverySourceOwnedDeclarationV1;
}): L1SubagentRecoverySourceOwnedBindingV1 {
  const declaration = l1SubagentRecoverySourceOwnedDeclarationV1Schema.parse(input.declaration);
  const material = l1SubagentRecoverySourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L1SubagentRecoverySourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l1SubagentRecoverySourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL1SubagentRecoverySourceOwnedBindingDigestV1(material),
  });
}

export const L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1 = [
  {
    adapterId: 'subagent-parent-child-reservation-v1',
    assertionId: 'l1.subagent.parent-child-reservation.v1',
    sourceRef: 'src/core/subagent/runner.ts#runSubAgent',
  },
  {
    adapterId: 'subagent-approval-resume-claim-v1',
    assertionId: 'l1.subagent.approval-resume-claim.v1',
    sourceRef: 'src/core/controllers/tool-controller.ts#executeRuntimeTools',
  },
  {
    adapterId: 'runtime-subagent-terminal-consumption-v1',
    assertionId: 'l1.runtime.subagent-terminal-consumption.v1',
    sourceRef: 'src/core/runtime/reducer.ts#reduceRuntimeState',
  },
  {
    adapterId: 'runtime-subagent-restart-unknown-v1',
    assertionId: 'l1.runtime.subagent-restart-unknown.v1',
    sourceRef: 'src/core/runtime/kernel.ts#createAgentKernel',
  },
  {
    adapterId: 'runtime-late-terminal-convergence-v1',
    assertionId: 'l1.runtime.late-terminal-convergence.v1',
    sourceRef: 'src/core/runtime/kernel.ts#applyEffectEvent',
  },
  {
    adapterId: 'runtime-parallel-cancel-convergence-v1',
    assertionId: 'l1.runtime.parallel-cancel-convergence.v1',
    sourceRef: 'src/core/runtime/actions.ts#eventsForRunCancellation',
  },
  {
    adapterId: 'runtime-rewind-fork-tightening-v1',
    assertionId: 'l1.runtime.rewind-fork-tightening.v1',
    sourceRef: 'src/core/runtime/store.ts#forkSession',
  },
] as const;

export const L1_SUBAGENT_RECOVERY_CASE_IDS_V1 = [
  'l1-runtime-late-terminal-convergence-v1',
  'l1-runtime-parallel-cancel-convergence-v1',
  'l1-runtime-rewind-fork-tightening-v1',
  'l1-runtime-subagent-restart-unknown-v1',
  'l1-runtime-subagent-terminal-consumption-v1',
  'l1-subagent-approval-resume-claim-v1',
  'l1-subagent-parent-child-reservation-v1',
] as const;
export type L1SubagentRecoveryCaseIdV1 = (typeof L1_SUBAGENT_RECOVERY_CASE_IDS_V1)[number];

const caseIdSchema = z.enum(L1_SUBAGENT_RECOVERY_CASE_IDS_V1);
export const l1SubagentRecoveryCaseV1Schema = z
  .object({
    caseId: caseIdSchema,
    category: z.enum(['journey', 'negative']),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SubagentRecoveryCaseV1 = z.infer<typeof l1SubagentRecoveryCaseV1Schema>;

/** Corpus contains only stable ownership/outcome IDs; no continuation or task body. */
export const L1_SUBAGENT_RECOVERY_CORPUS_V1 = [
  {
    caseId: 'l1-runtime-late-terminal-convergence-v1',
    category: 'negative',
    adapterId: 'runtime-late-terminal-convergence-v1',
    assertionId: 'l1.runtime.late-terminal-convergence.v1',
  },
  {
    caseId: 'l1-runtime-parallel-cancel-convergence-v1',
    category: 'negative',
    adapterId: 'runtime-parallel-cancel-convergence-v1',
    assertionId: 'l1.runtime.parallel-cancel-convergence.v1',
  },
  {
    caseId: 'l1-runtime-rewind-fork-tightening-v1',
    category: 'journey',
    adapterId: 'runtime-rewind-fork-tightening-v1',
    assertionId: 'l1.runtime.rewind-fork-tightening.v1',
  },
  {
    caseId: 'l1-runtime-subagent-restart-unknown-v1',
    category: 'negative',
    adapterId: 'runtime-subagent-restart-unknown-v1',
    assertionId: 'l1.runtime.subagent-restart-unknown.v1',
  },
  {
    caseId: 'l1-runtime-subagent-terminal-consumption-v1',
    category: 'negative',
    adapterId: 'runtime-subagent-terminal-consumption-v1',
    assertionId: 'l1.runtime.subagent-terminal-consumption.v1',
  },
  {
    caseId: 'l1-subagent-approval-resume-claim-v1',
    category: 'negative',
    adapterId: 'subagent-approval-resume-claim-v1',
    assertionId: 'l1.subagent.approval-resume-claim.v1',
  },
  {
    caseId: 'l1-subagent-parent-child-reservation-v1',
    category: 'journey',
    adapterId: 'subagent-parent-child-reservation-v1',
    assertionId: 'l1.subagent.parent-child-reservation.v1',
  },
] as const satisfies readonly L1SubagentRecoveryCaseV1[];

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

export const l1SubagentRecoveryCorpusV1Schema = z
  .array(l1SubagentRecoveryCaseV1Schema)
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.map((entry) => entry.caseId),
        L1_SUBAGENT_RECOVERY_CASE_IDS_V1,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L1 subagent/recovery corpus cases must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1SubagentRecoveryCorpusV1 = z.infer<typeof l1SubagentRecoveryCorpusV1Schema>;

export function computeL1SubagentRecoveryCorpusDigestV1(
  corpus: L1SubagentRecoveryCorpusV1 = L1_SUBAGENT_RECOVERY_CORPUS_V1 as unknown as L1SubagentRecoveryCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.corpus.v1',
    canonicalJsonBytes(l1SubagentRecoveryCorpusV1Schema.parse(corpus)),
  );
}

const l1SubagentRecoverySuiteMaterialV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoverySuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L1_SUBAGENT_RECOVERY_SUITE_ID_V1),
    corpusDigest: digestSchema,
    adapterIds: z.array(adapterIdSchema),
    assertionIds: z.array(assertionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.corpusDigest !== computeL1SubagentRecoveryCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L1 subagent/recovery corpus digest drift',
      });
    }
    if (!exactInventory(value.adapterIds, L1_SUBAGENT_RECOVERY_ADAPTER_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['adapterIds'],
        message: 'L1 subagent/recovery adapters must be exact',
      });
    }
    if (!exactInventory(value.assertionIds, L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'L1 subagent/recovery assertions must be exact',
      });
    }
  });
export type L1SubagentRecoverySuiteMaterialV1 = z.infer<
  typeof l1SubagentRecoverySuiteMaterialV1Schema
>;

export function computeL1SubagentRecoverySuiteDigestV1(
  material: L1SubagentRecoverySuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.suite.v1',
    canonicalJsonBytes(l1SubagentRecoverySuiteMaterialV1Schema.parse(material)),
  );
}

export const l1SubagentRecoverySuiteV1Schema = l1SubagentRecoverySuiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL1SubagentRecoverySuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L1 subagent/recovery suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SubagentRecoverySuiteV1 = z.infer<typeof l1SubagentRecoverySuiteV1Schema>;

export function buildL1SubagentRecoverySuiteV1(): L1SubagentRecoverySuiteV1 {
  const material = l1SubagentRecoverySuiteMaterialV1Schema.parse({
    schema: 'L1SubagentRecoverySuiteV1',
    version: 1,
    suiteId: L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
    corpusDigest: computeL1SubagentRecoveryCorpusDigestV1(),
    adapterIds: [...L1_SUBAGENT_RECOVERY_ADAPTER_IDS_V1],
    assertionIds: [...L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1],
  });
  return l1SubagentRecoverySuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL1SubagentRecoverySuiteDigestV1(material),
  });
}

export const l1SubagentRecoveryCatalogSuiteIdentityV1Schema = z
  .object({ suiteId: identifierSchema, suiteDigest: digestSchema })
  .strict();
export type L1SubagentRecoveryCatalogSuiteIdentityV1 = z.infer<
  typeof l1SubagentRecoveryCatalogSuiteIdentityV1Schema
>;

export function bindL1SubagentRecoveryCatalogSuiteV1(
  suite: QualificationSuiteV1,
): L1SubagentRecoveryCatalogSuiteIdentityV1 {
  const parsed = qualificationSuiteV1Schema.parse(suite);
  const expectedAssertions = [...L1_SUBAGENT_RECOVERY_ASSERTION_IDS_V1].sort();
  if (
    parsed.suiteId !== L1_SUBAGENT_RECOVERY_SUITE_ID_V1 ||
    parsed.assertionIds.length !== expectedAssertions.length ||
    !parsed.assertionIds.every((entry, index) => entry === expectedAssertions[index])
  ) {
    throw new Error('l1_subagent_recovery_catalog_suite_identity_mismatch');
  }
  return l1SubagentRecoveryCatalogSuiteIdentityV1Schema.parse({
    suiteId: parsed.suiteId,
    suiteDigest: parsed.suiteDigest,
  });
}

const l1SubagentRecoveryEvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoveryEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L1_SUBAGENT_RECOVERY_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
    faultInjectionDigest: digestSchema,
  })
  .strict();
export type L1SubagentRecoveryEvaluatorIdentityMaterialV1 = z.infer<
  typeof l1SubagentRecoveryEvaluatorIdentityMaterialV1Schema
>;

export function computeL1SubagentRecoveryEvaluatorIdentityDigestV1(
  material: L1SubagentRecoveryEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.evaluator-identity.v1',
    canonicalJsonBytes(l1SubagentRecoveryEvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l1SubagentRecoveryEvaluatorIdentityV1Schema =
  l1SubagentRecoveryEvaluatorIdentityMaterialV1Schema
    .extend({ evaluatorDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { evaluatorDigest, ...material } = value;
      const expected = computeL1SubagentRecoveryEvaluatorIdentityDigestV1(material);
      if (evaluatorDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['evaluatorDigest'],
          message: `L1 subagent/recovery evaluator digest mismatch: expected ${expected}`,
        });
      }
    });
export type L1SubagentRecoveryEvaluatorIdentityV1 = z.infer<
  typeof l1SubagentRecoveryEvaluatorIdentityV1Schema
>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

export function buildL1SubagentRecoveryEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  faultInjection: unknown;
  suite?: L1SubagentRecoverySuiteV1;
}): L1SubagentRecoveryEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL1SubagentRecoverySuiteV1();
  const material = l1SubagentRecoveryEvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L1SubagentRecoveryEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L1_SUBAGENT_RECOVERY_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest(
      'kite.qualification.l1.subagent-recovery.oracle.v1',
      input.oracle,
    ),
    verifierDigest: dependencyDigest(
      'kite.qualification.l1.subagent-recovery.verifier.v1',
      input.verifier,
    ),
    runnerDigest: dependencyDigest(
      'kite.qualification.l1.subagent-recovery.runner.v1',
      input.runner,
    ),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l1.subagent-recovery.scheduler.v1',
      input.scheduler,
    ),
    faultInjectionDigest: dependencyDigest(
      'kite.qualification.l1.subagent-recovery.fault-injection.v1',
      input.faultInjection,
    ),
  });
  return l1SubagentRecoveryEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL1SubagentRecoveryEvaluatorIdentityDigestV1(material),
  });
}

export const l1SubagentRecoveryAdapterResultV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    outcome: z.enum(['passed', 'failed']),
  })
  .strict()
  .superRefine(addPairIssue);
export type L1SubagentRecoveryAdapterResultV1 = z.infer<
  typeof l1SubagentRecoveryAdapterResultV1Schema
>;
