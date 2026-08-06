import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_TOOL_VERIFICATION_CASE_IDS_V1,
  type L1ToolVerificationCaseIdV1,
  type L1ToolVerificationEvaluatorIdentityV1,
  l1ToolVerificationEvaluatorIdentityV1Schema,
} from './l1-tool-verification-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_TOOL_VERIFICATION_CASE_IDS_V1);

/**
 * `accepted` means the assertion's required safety behavior was observed.
 * It does not mean a product release or release-gate admission was accepted.
 */
export const l1ToolVerificationCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1ToolVerificationCaseObservationV1 = z.infer<
  typeof l1ToolVerificationCaseObservationV1Schema
>;

function exactInventory(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const exact =
    values.length === L1_TOOL_VERIFICATION_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_TOOL_VERIFICATION_CASE_IDS_V1[index]);
  if (!exact) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'L1 observations must be the exact code-point-sorted case inventory',
    });
  }
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const l1ToolVerificationReportInputV1Schema = z
  .object({
    schema: z.literal('L1ToolVerificationEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1ToolVerificationEvaluatorIdentityV1Schema,
    observations: z.array(l1ToolVerificationCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) =>
    exactInventory(
      value.observations.map((entry) => entry.caseId),
      context,
      ['observations'],
    ),
  );
export type L1ToolVerificationReportInputV1 = z.infer<typeof l1ToolVerificationReportInputV1Schema>;

export const L1_TOOL_VERIFICATION_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1ToolVerificationReportStatusV1 =
  (typeof L1_TOOL_VERIFICATION_REPORT_STATUSES_V1)[number];

const l1ToolVerificationReportMaterialV1Schema = l1ToolVerificationReportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_TOOL_VERIFICATION_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const rejectedCaseIds = value.observations
      .filter((entry) => entry.observedOutcome !== 'accepted')
      .map((entry) => entry.caseId);
    if (!sortedUnique(value.rejectedCaseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 rejected case IDs must be code-point sorted and unique',
      });
    }
    if (
      value.rejectedCaseIds.length !== rejectedCaseIds.length ||
      !value.rejectedCaseIds.every((entry, index) => entry === rejectedCaseIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 rejected case IDs must be derived from closed observations',
      });
    }
    const expectedStatus = rejectedCaseIds.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1ToolVerificationReportMaterialV1 = z.infer<
  typeof l1ToolVerificationReportMaterialV1Schema
>;

export function computeL1ToolVerificationReportDigestV1(
  material: L1ToolVerificationReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tool-verification.evaluator-report.v1',
    canonicalJsonBytes(l1ToolVerificationReportMaterialV1Schema.parse(material)),
  );
}

export const l1ToolVerificationReportV1Schema = l1ToolVerificationReportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const parsed = l1ToolVerificationReportMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
      return;
    }
    const expected = computeL1ToolVerificationReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1ToolVerificationReportV1 = z.infer<typeof l1ToolVerificationReportV1Schema>;

/** Seal the full L1 observation inventory into a metadata-only report. */
export function evaluateL1ToolVerificationCorpusV1(input: {
  evaluator: L1ToolVerificationEvaluatorIdentityV1;
  observations: readonly L1ToolVerificationCaseObservationV1[];
}): L1ToolVerificationReportV1 {
  const parsed = l1ToolVerificationReportInputV1Schema.parse({
    schema: 'L1ToolVerificationEvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const rejectedCaseIds = parsed.observations
    .filter((entry) => entry.observedOutcome !== 'accepted')
    .map((entry) => entry.caseId);
  const material = l1ToolVerificationReportMaterialV1Schema.parse({
    ...parsed,
    rejectedCaseIds,
    status: rejectedCaseIds.length === 0 ? 'accepted' : 'blocked',
  });
  return l1ToolVerificationReportV1Schema.parse({
    ...material,
    reportDigest: computeL1ToolVerificationReportDigestV1(material),
  });
}

export function parseL1ToolVerificationReportV1(value: unknown): L1ToolVerificationReportV1 {
  return l1ToolVerificationReportV1Schema.parse(value);
}

export function l1ObservationForCaseV1(
  caseId: L1ToolVerificationCaseIdV1,
  accepted: boolean,
): L1ToolVerificationCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
