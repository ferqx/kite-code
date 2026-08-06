import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1,
  type L1TuiRewindForkProjectionCaseIdV1,
  type L1TuiRewindForkProjectionEvaluatorIdentityV1,
  l1TuiRewindForkProjectionEvaluatorIdentityV1Schema,
} from './l1-tui-rewind-projection-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1);

/** `accepted` means only that the sealed diagnostic observation held. */
export const l1TuiRewindForkProjectionCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1TuiRewindForkProjectionCaseObservationV1 = z.infer<
  typeof l1TuiRewindForkProjectionCaseObservationV1Schema
>;

function hasExactInventory(values: readonly string[]): boolean {
  return (
    values.length === L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_TUI_REWIND_FORK_PROJECTION_CASE_IDS_V1[index])
  );
}

const reportInputV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1TuiRewindForkProjectionEvaluatorIdentityV1Schema,
    observations: z.array(l1TuiRewindForkProjectionCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasExactInventory(value.observations.map((entry) => entry.caseId))) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message: 'L1 TUI rewind projection observations must be the exact closed inventory',
      });
    }
  });
export type L1TuiRewindForkProjectionReportInputV1 = z.infer<typeof reportInputV1Schema>;

export const L1_TUI_REWIND_FORK_PROJECTION_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1TuiRewindForkProjectionReportStatusV1 =
  (typeof L1_TUI_REWIND_FORK_PROJECTION_REPORT_STATUSES_V1)[number];

const reportMaterialV1Schema = reportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_TUI_REWIND_FORK_PROJECTION_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const rejectedCaseIds = value.observations
      .filter((entry) => entry.observedOutcome !== 'accepted')
      .map((entry) => entry.caseId);
    if (
      rejectedCaseIds.length !== value.rejectedCaseIds.length ||
      !rejectedCaseIds.every((caseId, index) => caseId === value.rejectedCaseIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 TUI rewind projection rejected cases must derive from observations',
      });
    }
    const expectedStatus = rejectedCaseIds.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 TUI rewind projection report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1TuiRewindForkProjectionReportMaterialV1 = z.infer<typeof reportMaterialV1Schema>;

export function computeL1TuiRewindForkProjectionReportDigestV1(
  material: L1TuiRewindForkProjectionReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.evaluator-report.v1',
    canonicalJsonBytes(reportMaterialV1Schema.parse(material)),
  );
}

export const l1TuiRewindForkProjectionReportV1Schema = reportMaterialV1Schema
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
    const expected = computeL1TuiRewindForkProjectionReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 TUI rewind projection report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1TuiRewindForkProjectionReportV1 = z.infer<
  typeof l1TuiRewindForkProjectionReportV1Schema
>;

export function evaluateL1TuiRewindForkProjectionCorpusV1(input: {
  evaluator: L1TuiRewindForkProjectionEvaluatorIdentityV1;
  observations: readonly L1TuiRewindForkProjectionCaseObservationV1[];
}): L1TuiRewindForkProjectionReportV1 {
  const parsed = reportInputV1Schema.parse({
    schema: 'L1TuiRewindForkProjectionEvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const rejectedCaseIds = parsed.observations
    .filter((entry) => entry.observedOutcome !== 'accepted')
    .map((entry) => entry.caseId);
  const material = reportMaterialV1Schema.parse({
    ...parsed,
    rejectedCaseIds,
    status: rejectedCaseIds.length === 0 ? 'accepted' : 'blocked',
  });
  return l1TuiRewindForkProjectionReportV1Schema.parse({
    ...material,
    reportDigest: computeL1TuiRewindForkProjectionReportDigestV1(material),
  });
}

export function l1TuiRewindForkProjectionObservationForCaseV1(
  caseId: L1TuiRewindForkProjectionCaseIdV1,
  accepted: boolean,
): L1TuiRewindForkProjectionCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
