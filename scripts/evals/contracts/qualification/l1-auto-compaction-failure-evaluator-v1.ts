import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1,
  type L1AutoCompactionFailureCaseIdV1,
  type L1AutoCompactionFailureEvaluatorIdentityV1,
  l1AutoCompactionFailureEvaluatorIdentityV1Schema,
} from './l1-auto-compaction-failure-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1);

/** `accepted` means the sealed diagnostic safety assertion was observed, never release admission. */
export const l1AutoCompactionFailureCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1AutoCompactionFailureCaseObservationV1 = z.infer<
  typeof l1AutoCompactionFailureCaseObservationV1Schema
>;

const reportInputV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1AutoCompactionFailureEvaluatorIdentityV1Schema,
    observations: z.array(l1AutoCompactionFailureCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    const exact =
      value.observations.length === L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1.length &&
      value.observations.every(
        (observation, index) =>
          observation.caseId === L1_AUTO_COMPACTION_FAILURE_CASE_IDS_V1[index],
      );
    if (!exact) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message:
          'L1 auto-compaction failure observations must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1AutoCompactionFailureReportInputV1 = z.infer<typeof reportInputV1Schema>;

export const L1_AUTO_COMPACTION_FAILURE_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1AutoCompactionFailureReportStatusV1 =
  (typeof L1_AUTO_COMPACTION_FAILURE_REPORT_STATUSES_V1)[number];

const reportMaterialV1Schema = reportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_AUTO_COMPACTION_FAILURE_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const rejectedCaseIds = value.observations
      .filter((observation) => observation.observedOutcome !== 'accepted')
      .map((observation) => observation.caseId);
    if (
      rejectedCaseIds.length !== value.rejectedCaseIds.length ||
      !rejectedCaseIds.every((caseId, index) => caseId === value.rejectedCaseIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 auto-compaction failure rejected cases must be derived from observations',
      });
    }
    const expectedStatus = rejectedCaseIds.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 auto-compaction failure report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1AutoCompactionFailureReportMaterialV1 = z.infer<typeof reportMaterialV1Schema>;

export function computeL1AutoCompactionFailureReportDigestV1(
  material: L1AutoCompactionFailureReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.evaluator-report.v1',
    canonicalJsonBytes(reportMaterialV1Schema.parse(material)),
  );
}

export const l1AutoCompactionFailureReportV1Schema = reportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const parsed = reportMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL1AutoCompactionFailureReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 auto-compaction failure report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1AutoCompactionFailureReportV1 = z.infer<typeof l1AutoCompactionFailureReportV1Schema>;

export function evaluateL1AutoCompactionFailureCorpusV1(input: {
  evaluator: L1AutoCompactionFailureEvaluatorIdentityV1;
  observations: readonly L1AutoCompactionFailureCaseObservationV1[];
}): L1AutoCompactionFailureReportV1 {
  const parsed = reportInputV1Schema.parse({
    schema: 'L1AutoCompactionFailureEvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const rejectedCaseIds = parsed.observations
    .filter((observation) => observation.observedOutcome !== 'accepted')
    .map((observation) => observation.caseId);
  const material = reportMaterialV1Schema.parse({
    ...parsed,
    rejectedCaseIds,
    status: rejectedCaseIds.length === 0 ? 'accepted' : 'blocked',
  });
  return l1AutoCompactionFailureReportV1Schema.parse({
    ...material,
    reportDigest: computeL1AutoCompactionFailureReportDigestV1(material),
  });
}

export function l1AutoCompactionFailureObservationForCaseV1(
  caseId: L1AutoCompactionFailureCaseIdV1,
  accepted: boolean,
): L1AutoCompactionFailureCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
