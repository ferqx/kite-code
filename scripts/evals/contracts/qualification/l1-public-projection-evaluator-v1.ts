import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_PUBLIC_PROJECTION_CASE_IDS_V1,
  type L1PublicProjectionCaseIdV1,
  type L1PublicProjectionEvaluatorIdentityV1,
  l1PublicProjectionEvaluatorIdentityV1Schema,
} from './l1-public-projection-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_PUBLIC_PROJECTION_CASE_IDS_V1);

/** `accepted` means the diagnostic projection assertion was observed only. */
export const l1PublicProjectionCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1PublicProjectionCaseObservationV1 = z.infer<
  typeof l1PublicProjectionCaseObservationV1Schema
>;

function hasExactInventory(values: readonly string[]): boolean {
  return (
    values.length === L1_PUBLIC_PROJECTION_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_PUBLIC_PROJECTION_CASE_IDS_V1[index])
  );
}

function isCodePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const l1PublicProjectionReportInputV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1PublicProjectionEvaluatorIdentityV1Schema,
    observations: z.array(l1PublicProjectionCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasExactInventory(value.observations.map((entry) => entry.caseId))) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message: 'L1 public-projection observations must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1PublicProjectionReportInputV1 = z.infer<typeof l1PublicProjectionReportInputV1Schema>;

export const L1_PUBLIC_PROJECTION_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1PublicProjectionReportStatusV1 =
  (typeof L1_PUBLIC_PROJECTION_REPORT_STATUSES_V1)[number];

const l1PublicProjectionReportMaterialV1Schema = l1PublicProjectionReportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_PUBLIC_PROJECTION_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const rejected = value.observations
      .filter((entry) => entry.observedOutcome !== 'accepted')
      .map((entry) => entry.caseId);
    if (!isCodePointSortedUnique(value.rejectedCaseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 public-projection rejected case IDs must be code-point sorted and unique',
      });
    }
    if (
      rejected.length !== value.rejectedCaseIds.length ||
      !rejected.every((caseId, index) => caseId === value.rejectedCaseIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 public-projection rejected case IDs must be derived from observations',
      });
    }
    const expectedStatus = rejected.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 public-projection report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1PublicProjectionReportMaterialV1 = z.infer<
  typeof l1PublicProjectionReportMaterialV1Schema
>;

export function computeL1PublicProjectionReportDigestV1(
  material: L1PublicProjectionReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.evaluator-report.v1',
    canonicalJsonBytes(l1PublicProjectionReportMaterialV1Schema.parse(material)),
  );
}

export const l1PublicProjectionReportV1Schema = l1PublicProjectionReportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const parsed = l1PublicProjectionReportMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL1PublicProjectionReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 public-projection report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1PublicProjectionReportV1 = z.infer<typeof l1PublicProjectionReportV1Schema>;

export function evaluateL1PublicProjectionCorpusV1(input: {
  evaluator: L1PublicProjectionEvaluatorIdentityV1;
  observations: readonly L1PublicProjectionCaseObservationV1[];
}): L1PublicProjectionReportV1 {
  const parsed = l1PublicProjectionReportInputV1Schema.parse({
    schema: 'L1PublicProjectionEvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const rejectedCaseIds = parsed.observations
    .filter((entry) => entry.observedOutcome !== 'accepted')
    .map((entry) => entry.caseId);
  const material = l1PublicProjectionReportMaterialV1Schema.parse({
    ...parsed,
    rejectedCaseIds,
    status: rejectedCaseIds.length === 0 ? 'accepted' : 'blocked',
  });
  return l1PublicProjectionReportV1Schema.parse({
    ...material,
    reportDigest: computeL1PublicProjectionReportDigestV1(material),
  });
}

export function l1PublicProjectionObservationForCaseV1(
  caseId: L1PublicProjectionCaseIdV1,
  accepted: boolean,
): L1PublicProjectionCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
