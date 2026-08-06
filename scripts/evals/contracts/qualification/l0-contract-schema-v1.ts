import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message: 'L0 identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * The deterministic L0 suite is deliberately a qualification-only contract.
 * It has no production-admission semantics and cannot carry a feature identifier:
 * a source owner must attach the adapter/assertion pair to its own surface,
 * and the source-owned catalog performs the later matrix join.
 */
export const L0_CONTRACT_SUITE_ID_V1 = 'qualification-l0-contract-v1';
export const L0_EVALUATOR_ID_V1 = 'qualification-l0-evaluator-v1';

export const L0_CONTRACT_ADAPTERS_V1 = [
  {
    adapterId: 'approval-policy-decision-v1',
    assertionId: 'l0.authorization-approval.decision-v1',
  },
  {
    adapterId: 'capability-catalog-binding-v1',
    assertionId: 'l0.capability-catalog.binding-v1',
  },
  {
    adapterId: 'execution-boundary-schema-v1',
    assertionId: 'l0.sandbox-execution-boundary.schema-v1',
  },
  {
    adapterId: 'verification-policy-requirement-v1',
    assertionId: 'l0.verification-policy.requirement-v1',
  },
] as const;

export const L0_CONTRACT_ADAPTER_IDS_V1 = [
  'approval-policy-decision-v1',
  'capability-catalog-binding-v1',
  'execution-boundary-schema-v1',
  'verification-policy-requirement-v1',
] as const;
export type L0ContractAdapterIdV1 = (typeof L0_CONTRACT_ADAPTER_IDS_V1)[number];

export const L0_CONTRACT_ASSERTION_IDS_V1 = [
  'l0.authorization-approval.decision-v1',
  'l0.capability-catalog.binding-v1',
  'l0.sandbox-execution-boundary.schema-v1',
  'l0.verification-policy.requirement-v1',
] as const;
export type L0ContractAssertionIdV1 = (typeof L0_CONTRACT_ASSERTION_IDS_V1)[number];

const adapterIdSchema = z.enum(L0_CONTRACT_ADAPTER_IDS_V1);
const assertionIdSchema = z.enum(L0_CONTRACT_ASSERTION_IDS_V1);

function isRegisteredAdapterAssertionPair(
  adapterId: L0ContractAdapterIdV1,
  assertionId: L0ContractAssertionIdV1,
): boolean {
  return L0_CONTRACT_ADAPTERS_V1.some(
    (entry) => entry.adapterId === adapterId && entry.assertionId === assertionId,
  );
}

function addPairIssue(
  value: { adapterId: L0ContractAdapterIdV1; assertionId: L0ContractAssertionIdV1 },
  context: z.RefinementCtx,
): void {
  if (!isRegisteredAdapterAssertionPair(value.adapterId, value.assertionId)) {
    context.addIssue({
      code: 'custom',
      path: ['assertionId'],
      message: 'l0 adapter/assertion pair is not registered',
    });
  }
}

/** The exact two-field declaration allowed beside a source-owner surface. */
export const l0SourceOwnedContractDeclarationV1Schema = z
  .object({
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);

export type L0SourceOwnedContractDeclarationV1 = z.infer<
  typeof l0SourceOwnedContractDeclarationV1Schema
>;

const l0SourceOwnedBindingMaterialV1Schema = z
  .object({
    schema: z.literal('L0SourceOwnedBindingV1'),
    version: z.literal(1),
    sourceSurfaceId: identifierSchema,
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
  })
  .strict()
  .superRefine(addPairIssue);

export type L0SourceOwnedBindingMaterialV1 = z.infer<typeof l0SourceOwnedBindingMaterialV1Schema>;

export function computeL0SourceOwnedBindingDigestV1(
  material: L0SourceOwnedBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.source-owned-binding.v1',
    canonicalJsonBytes(l0SourceOwnedBindingMaterialV1Schema.parse(material)),
  );
}

export const l0SourceOwnedBindingV1Schema = l0SourceOwnedBindingMaterialV1Schema
  .extend({ bindingDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { bindingDigest, ...material } = value;
    const expected = computeL0SourceOwnedBindingDigestV1(material);
    if (bindingDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['bindingDigest'],
        message: `l0 source-owned binding digest mismatch: expected ${expected}`,
      });
    }
  });

export type L0SourceOwnedBindingV1 = z.infer<typeof l0SourceOwnedBindingV1Schema>;

/**
 * This builder deliberately accepts a sourceSurfaceId separately from the
 * declaration, so a qualification-side registry cannot invent a feature map.
 */
export function buildL0SourceOwnedBindingV1(input: {
  sourceSurfaceId: string;
  declaration: L0SourceOwnedContractDeclarationV1;
}): L0SourceOwnedBindingV1 {
  const declaration = l0SourceOwnedContractDeclarationV1Schema.parse(input.declaration);
  const material = l0SourceOwnedBindingMaterialV1Schema.parse({
    schema: 'L0SourceOwnedBindingV1',
    version: 1,
    sourceSurfaceId: input.sourceSurfaceId,
    ...declaration,
  });
  return l0SourceOwnedBindingV1Schema.parse({
    ...material,
    bindingDigest: computeL0SourceOwnedBindingDigestV1(material),
  });
}

export const L0_GOOD_BAD_CASE_IDS_V1 = [
  'l0-bad-approval-policy-rejected-v1',
  'l0-bad-capability-catalog-rejected-v1',
  'l0-bad-execution-boundary-rejected-v1',
  'l0-bad-verification-policy-rejected-v1',
  'l0-good-approval-policy-decision-v1',
  'l0-good-capability-catalog-binding-v1',
  'l0-good-execution-boundary-schema-v1',
  'l0-good-verification-policy-requirement-v1',
] as const;
export type L0GoodBadCaseIdV1 = (typeof L0_GOOD_BAD_CASE_IDS_V1)[number];

export const L0_MUTATION_CASE_IDS_V1 = [
  'l0-mutation-candidate-identity-drift-v1',
  'l0-mutation-deleted-assertion-v1',
  'l0-mutation-duplicate-child-result-v1',
  'l0-mutation-forged-success-v1',
  'l0-mutation-missing-verification-receipt-v1',
  'l0-mutation-stale-binding-v1',
  'l0-mutation-suite-digest-drift-v1',
  'l0-mutation-test-failed-claimed-success-v1',
  'l0-mutation-unknown-effect-accepted-v1',
  'l0-mutation-weakened-assertion-v1',
] as const;
export type L0MutationCaseIdV1 = (typeof L0_MUTATION_CASE_IDS_V1)[number];

export const L0_EVALUATOR_CASE_IDS_V1 = [
  ...L0_GOOD_BAD_CASE_IDS_V1,
  ...L0_MUTATION_CASE_IDS_V1,
] as const;
export type L0EvaluatorCaseIdV1 = (typeof L0_EVALUATOR_CASE_IDS_V1)[number];

const l0ExpectedOutcomeV1Schema = z.enum(['accepted', 'rejected']);
export type L0ExpectedOutcomeV1 = z.infer<typeof l0ExpectedOutcomeV1Schema>;

const l0GoodBadCaseV1Schema = z
  .object({
    caseId: z.enum(L0_GOOD_BAD_CASE_IDS_V1),
    category: z.enum(['good', 'bad']),
    adapterId: adapterIdSchema,
    assertionId: assertionIdSchema,
    expectedOutcome: l0ExpectedOutcomeV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    addPairIssue(value, context);
    if (
      (value.category === 'good' && value.expectedOutcome !== 'accepted') ||
      (value.category === 'bad' && value.expectedOutcome !== 'rejected')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedOutcome'],
        message: 'l0 good/bad corpus outcome does not match its category',
      });
    }
  });

export type L0GoodBadCaseV1 = z.infer<typeof l0GoodBadCaseV1Schema>;

export const L0_MUTATION_KINDS_V1 = [
  'candidate_identity_drift',
  'deleted_assertion',
  'duplicate_child_result',
  'forged_success',
  'missing_verification_receipt',
  'stale_binding',
  'suite_digest_drift',
  'test_failed_claimed_success',
  'unknown_effect_accepted',
  'weakened_assertion',
] as const;
export type L0MutationKindV1 = (typeof L0_MUTATION_KINDS_V1)[number];

const l0MutationCaseV1Schema = z
  .object({
    caseId: z.enum(L0_MUTATION_CASE_IDS_V1),
    mutationKind: z.enum(L0_MUTATION_KINDS_V1),
    expectedOutcome: z.literal('rejected'),
  })
  .strict();

export type L0MutationCaseV1 = z.infer<typeof l0MutationCaseV1Schema>;

function sortedUniqueExact(
  values: readonly string[],
  expected: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const exact =
    values.length === expected.length && values.every((value, index) => value === expected[index]);
  if (!exact) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'l0 corpus cases must be the exact registered code-point-sorted inventory',
    });
  }
}

export const l0GoodBadCorpusV1Schema = z
  .array(l0GoodBadCaseV1Schema)
  .superRefine((value, context) => {
    sortedUniqueExact(
      value.map((entry) => entry.caseId),
      L0_GOOD_BAD_CASE_IDS_V1,
      context,
      [],
    );
  });

export type L0GoodBadCorpusV1 = z.infer<typeof l0GoodBadCorpusV1Schema>;

export const l0MutationCorpusV1Schema = z
  .array(l0MutationCaseV1Schema)
  .superRefine((value, context) => {
    sortedUniqueExact(
      value.map((entry) => entry.caseId),
      L0_MUTATION_CASE_IDS_V1,
      context,
      [],
    );
  });

export type L0MutationCorpusV1 = z.infer<typeof l0MutationCorpusV1Schema>;

/**
 * Corpus records intentionally contain only stable identifiers, expected
 * outcomes, and adapter/assertion ownership. They do not retain prompts,
 * source text, test bodies, or observed runtime content.
 */
export const L0_GOOD_BAD_CORPUS_V1: L0GoodBadCorpusV1 = l0GoodBadCorpusV1Schema.parse([
  {
    caseId: 'l0-bad-approval-policy-rejected-v1',
    category: 'bad',
    adapterId: 'approval-policy-decision-v1',
    assertionId: 'l0.authorization-approval.decision-v1',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-bad-capability-catalog-rejected-v1',
    category: 'bad',
    adapterId: 'capability-catalog-binding-v1',
    assertionId: 'l0.capability-catalog.binding-v1',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-bad-execution-boundary-rejected-v1',
    category: 'bad',
    adapterId: 'execution-boundary-schema-v1',
    assertionId: 'l0.sandbox-execution-boundary.schema-v1',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-bad-verification-policy-rejected-v1',
    category: 'bad',
    adapterId: 'verification-policy-requirement-v1',
    assertionId: 'l0.verification-policy.requirement-v1',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-good-approval-policy-decision-v1',
    category: 'good',
    adapterId: 'approval-policy-decision-v1',
    assertionId: 'l0.authorization-approval.decision-v1',
    expectedOutcome: 'accepted',
  },
  {
    caseId: 'l0-good-capability-catalog-binding-v1',
    category: 'good',
    adapterId: 'capability-catalog-binding-v1',
    assertionId: 'l0.capability-catalog.binding-v1',
    expectedOutcome: 'accepted',
  },
  {
    caseId: 'l0-good-execution-boundary-schema-v1',
    category: 'good',
    adapterId: 'execution-boundary-schema-v1',
    assertionId: 'l0.sandbox-execution-boundary.schema-v1',
    expectedOutcome: 'accepted',
  },
  {
    caseId: 'l0-good-verification-policy-requirement-v1',
    category: 'good',
    adapterId: 'verification-policy-requirement-v1',
    assertionId: 'l0.verification-policy.requirement-v1',
    expectedOutcome: 'accepted',
  },
]);

export const L0_MUTATION_CORPUS_V1: L0MutationCorpusV1 = l0MutationCorpusV1Schema.parse([
  {
    caseId: 'l0-mutation-candidate-identity-drift-v1',
    mutationKind: 'candidate_identity_drift',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-deleted-assertion-v1',
    mutationKind: 'deleted_assertion',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-duplicate-child-result-v1',
    mutationKind: 'duplicate_child_result',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-forged-success-v1',
    mutationKind: 'forged_success',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-missing-verification-receipt-v1',
    mutationKind: 'missing_verification_receipt',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-stale-binding-v1',
    mutationKind: 'stale_binding',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-suite-digest-drift-v1',
    mutationKind: 'suite_digest_drift',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-test-failed-claimed-success-v1',
    mutationKind: 'test_failed_claimed_success',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-unknown-effect-accepted-v1',
    mutationKind: 'unknown_effect_accepted',
    expectedOutcome: 'rejected',
  },
  {
    caseId: 'l0-mutation-weakened-assertion-v1',
    mutationKind: 'weakened_assertion',
    expectedOutcome: 'rejected',
  },
]);

export function computeL0GoodBadCorpusDigestV1(
  corpus: L0GoodBadCorpusV1 = L0_GOOD_BAD_CORPUS_V1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.good-bad-corpus.v1',
    canonicalJsonBytes(l0GoodBadCorpusV1Schema.parse(corpus)),
  );
}

export function computeL0MutationCorpusDigestV1(
  corpus: L0MutationCorpusV1 = L0_MUTATION_CORPUS_V1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.mutation-corpus.v1',
    canonicalJsonBytes(l0MutationCorpusV1Schema.parse(corpus)),
  );
}

function computeL0DependencyDigestV1(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

const l0EvaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L0EvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L0_EVALUATOR_ID_V1),
    goodBadCorpusDigest: digestSchema,
    mutationCorpusDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    adapterDependencyDigest: digestSchema,
    runnerDependencyDigest: digestSchema,
  })
  .strict();

export type L0EvaluatorIdentityMaterialV1 = z.infer<typeof l0EvaluatorIdentityMaterialV1Schema>;

export function computeL0EvaluatorIdentityDigestV1(
  material: L0EvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.evaluator-identity.v1',
    canonicalJsonBytes(l0EvaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l0EvaluatorIdentityV1Schema = l0EvaluatorIdentityMaterialV1Schema
  .extend({ evaluatorDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { evaluatorDigest, ...material } = value;
    const expected = computeL0EvaluatorIdentityDigestV1(material);
    if (evaluatorDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['evaluatorDigest'],
        message: `l0 evaluator digest mismatch: expected ${expected}`,
      });
    }
  });

export type L0EvaluatorIdentityV1 = z.infer<typeof l0EvaluatorIdentityV1Schema>;

/**
 * A source-owned catalog passes only canonicalizable dependency facts here
 * (normally source fact digests and stable runner/oracle/verifier IDs). The
 * builder seals each category under a distinct domain before composing the
 * evaluator identity; callers cannot substitute a precomputed digest across
 * categories.
 */
export function buildL0EvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  adapterDependency: unknown;
  runnerDependency: unknown;
  goodBadCorpus?: L0GoodBadCorpusV1;
  mutationCorpus?: L0MutationCorpusV1;
}): L0EvaluatorIdentityV1 {
  const material = l0EvaluatorIdentityMaterialV1Schema.parse({
    schema: 'L0EvaluatorIdentityV1',
    version: 1,
    evaluatorId: L0_EVALUATOR_ID_V1,
    goodBadCorpusDigest: computeL0GoodBadCorpusDigestV1(input.goodBadCorpus),
    mutationCorpusDigest: computeL0MutationCorpusDigestV1(input.mutationCorpus),
    oracleDigest: computeL0DependencyDigestV1('kite.qualification.l0.oracle.v1', input.oracle),
    verifierDigest: computeL0DependencyDigestV1(
      'kite.qualification.l0.verifier.v1',
      input.verifier,
    ),
    adapterDependencyDigest: computeL0DependencyDigestV1(
      'kite.qualification.l0.adapter-dependency.v1',
      input.adapterDependency,
    ),
    runnerDependencyDigest: computeL0DependencyDigestV1(
      'kite.qualification.l0.runner-dependency.v1',
      input.runnerDependency,
    ),
  });
  return l0EvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL0EvaluatorIdentityDigestV1(material),
  });
}
