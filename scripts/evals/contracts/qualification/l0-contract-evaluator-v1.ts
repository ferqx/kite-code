import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L0_EVALUATOR_CASE_IDS_V1,
  L0_GOOD_BAD_CORPUS_V1,
  L0_MUTATION_CORPUS_V1,
  type L0EvaluatorCaseIdV1,
  type L0EvaluatorIdentityV1,
  type L0ExpectedOutcomeV1,
  l0EvaluatorIdentityV1Schema,
} from './l0-contract-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L0_EVALUATOR_CASE_IDS_V1);
const observedOutcomeSchema = z.enum(['accepted', 'rejected']);

export type L0ObservedOutcomeV1 = z.infer<typeof observedOutcomeSchema>;

/**
 * This observation intentionally contains no test, source, prompt, response,
 * path, exception, or explanation body. It is a closed result token only.
 */
export const l0EvaluatorCaseObservationV1Schema = z
  .object({
    caseId: caseIdSchema,
    observedOutcome: observedOutcomeSchema,
  })
  .strict();

export type L0EvaluatorCaseObservationV1 = z.infer<typeof l0EvaluatorCaseObservationV1Schema>;

const expectedOutcomeByCaseId = new Map<L0EvaluatorCaseIdV1, L0ExpectedOutcomeV1>([
  ...L0_GOOD_BAD_CORPUS_V1.map((entry) => [entry.caseId, entry.expectedOutcome] as const),
  ...L0_MUTATION_CORPUS_V1.map((entry) => [entry.caseId, entry.expectedOutcome] as const),
]);

const goodCaseIds = L0_GOOD_BAD_CORPUS_V1.filter((entry) => entry.category === 'good').map(
  (entry) => entry.caseId,
);
const negativeCaseIds = [
  ...L0_GOOD_BAD_CORPUS_V1.filter((entry) => entry.category === 'bad').map((entry) => entry.caseId),
  ...L0_MUTATION_CORPUS_V1.map((entry) => entry.caseId),
];

function exactRegisteredCaseInventory(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const isExact =
    values.length === L0_EVALUATOR_CASE_IDS_V1.length &&
    values.every((value, index) => value === L0_EVALUATOR_CASE_IDS_V1[index]);
  if (!isExact) {
    context.addIssue({
      code: 'custom',
      path,
      message:
        'l0 evaluator observations must contain the exact registered code-point-sorted case IDs',
    });
  }
}

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function addSortedUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  if (!codePointSortedUnique(values)) {
    context.addIssue({
      code: 'custom',
      path,
      message: `${label} must be code-point sorted and unique`,
    });
  }
}

const l0EvaluatorReportInputV1Schema = z
  .object({
    schema: z.literal('L0EvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l0EvaluatorIdentityV1Schema,
    observations: z.array(l0EvaluatorCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    exactRegisteredCaseInventory(
      value.observations.map((observation) => observation.caseId),
      context,
      ['observations'],
    );
  });

export type L0EvaluatorReportInputV1 = z.infer<typeof l0EvaluatorReportInputV1Schema>;

export const L0_EVALUATOR_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L0EvaluatorReportStatusV1 = (typeof L0_EVALUATOR_REPORT_STATUSES_V1)[number];

const l0EvaluatorReportMaterialV1Schema = l0EvaluatorReportInputV1Schema
  .extend({
    falseRejectCaseIds: z.array(z.enum(goodCaseIds as [string, ...string[]])),
    acceptedNegativeCaseIds: z.array(z.enum(negativeCaseIds as [string, ...string[]])),
    status: z.enum(L0_EVALUATOR_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = deriveL0EvaluatorReportFieldsV1(value.observations);
    addSortedUniqueIssue(
      value.falseRejectCaseIds,
      context,
      ['falseRejectCaseIds'],
      'false reject case IDs',
    );
    addSortedUniqueIssue(
      value.acceptedNegativeCaseIds,
      context,
      ['acceptedNegativeCaseIds'],
      'accepted negative case IDs',
    );
    if (!sameStrings(value.falseRejectCaseIds, expected.falseRejectCaseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['falseRejectCaseIds'],
        message: 'l0 false reject case IDs do not match the closed observations',
      });
    }
    if (!sameStrings(value.acceptedNegativeCaseIds, expected.acceptedNegativeCaseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedNegativeCaseIds'],
        message: 'l0 accepted negative case IDs do not match the closed observations',
      });
    }
    if (value.status !== expected.status) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `l0 evaluator report status mismatch: expected ${expected.status}`,
      });
    }
  });

export type L0EvaluatorReportMaterialV1 = z.infer<typeof l0EvaluatorReportMaterialV1Schema>;

export function computeL0EvaluatorReportDigestV1(
  material: L0EvaluatorReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l0.evaluator-report.v1',
    canonicalJsonBytes(l0EvaluatorReportMaterialV1Schema.parse(material)),
  );
}

export const l0EvaluatorReportV1Schema = l0EvaluatorReportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const expected = computeL0EvaluatorReportDigestV1(material);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `l0 evaluator report digest mismatch: expected ${expected}`,
      });
    }
  });

export type L0EvaluatorReportV1 = z.infer<typeof l0EvaluatorReportV1Schema>;

/**
 * Derive a sealed report from the complete, ordered observation inventory.
 * A caller cannot omit a negative case, insert a new case, or predeclare a
 * passing status: all such inputs are rejected before a report is emitted.
 */
export function evaluateL0ContractCorpusV1(input: {
  evaluator: L0EvaluatorIdentityV1;
  observations: readonly L0EvaluatorCaseObservationV1[];
}): L0EvaluatorReportV1 {
  const parsed = l0EvaluatorReportInputV1Schema.parse({
    schema: 'L0EvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const derived = deriveL0EvaluatorReportFieldsV1(parsed.observations);
  const material = l0EvaluatorReportMaterialV1Schema.parse({
    ...parsed,
    ...derived,
  });
  return l0EvaluatorReportV1Schema.parse({
    ...material,
    reportDigest: computeL0EvaluatorReportDigestV1(material),
  });
}

/** Strict parser for persisted metadata-only evaluator reports. */
export function parseL0EvaluatorReportV1(value: unknown): L0EvaluatorReportV1 {
  return l0EvaluatorReportV1Schema.parse(value);
}

export function l0ExpectedOutcomeForCaseV1(caseId: L0EvaluatorCaseIdV1): L0ExpectedOutcomeV1 {
  const expected = expectedOutcomeByCaseId.get(caseId);
  if (!expected) throw new Error(`l0_evaluator_case_not_registered:${caseId}`);
  return expected;
}

function deriveL0EvaluatorReportFieldsV1(
  observations: readonly L0EvaluatorCaseObservationV1[],
): Pick<L0EvaluatorReportMaterialV1, 'falseRejectCaseIds' | 'acceptedNegativeCaseIds' | 'status'> {
  const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
  const falseRejectCaseIds = goodCaseIds.filter(
    (caseId) => byId.get(caseId)?.observedOutcome !== 'accepted',
  );
  const acceptedNegativeCaseIds = negativeCaseIds.filter(
    (caseId) => byId.get(caseId)?.observedOutcome !== 'rejected',
  );
  return {
    falseRejectCaseIds,
    acceptedNegativeCaseIds,
    status:
      falseRejectCaseIds.length === 0 && acceptedNegativeCaseIds.length === 0
        ? 'accepted'
        : 'blocked',
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
