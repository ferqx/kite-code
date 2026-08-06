import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_SUBAGENT_RECOVERY_CASE_IDS_V1,
  type L1SubagentRecoveryCaseIdV1,
  type L1SubagentRecoveryEvaluatorIdentityV1,
  l1SubagentRecoveryEvaluatorIdentityV1Schema,
} from './l1-subagent-recovery-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_SUBAGENT_RECOVERY_CASE_IDS_V1);

/** `accepted` means the sealed diagnostic assertion was observed, never admission. */
export const l1SubagentRecoveryCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1SubagentRecoveryCaseObservationV1 = z.infer<
  typeof l1SubagentRecoveryCaseObservationV1Schema
>;

function hasExactInventory(values: readonly string[]): boolean {
  return (
    values.length === L1_SUBAGENT_RECOVERY_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_SUBAGENT_RECOVERY_CASE_IDS_V1[index])
  );
}

const reportInputV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoveryEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1SubagentRecoveryEvaluatorIdentityV1Schema,
    observations: z.array(l1SubagentRecoveryCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasExactInventory(value.observations.map((entry) => entry.caseId))) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message: 'L1 subagent/recovery observations must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1SubagentRecoveryReportInputV1 = z.infer<typeof reportInputV1Schema>;

export const L1_SUBAGENT_RECOVERY_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1SubagentRecoveryReportStatusV1 =
  (typeof L1_SUBAGENT_RECOVERY_REPORT_STATUSES_V1)[number];

const reportMaterialV1Schema = reportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_SUBAGENT_RECOVERY_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const rejectedCaseIds = value.observations
      .filter((entry) => entry.observedOutcome !== 'accepted')
      .map((entry) => entry.caseId);
    if (
      rejectedCaseIds.length !== value.rejectedCaseIds.length ||
      !rejectedCaseIds.every((entry, index) => entry === value.rejectedCaseIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rejectedCaseIds'],
        message: 'L1 subagent/recovery rejected cases must be derived from observations',
      });
    }
    const expectedStatus = rejectedCaseIds.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 subagent/recovery report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1SubagentRecoveryReportMaterialV1 = z.infer<typeof reportMaterialV1Schema>;

export function computeL1SubagentRecoveryReportDigestV1(
  material: L1SubagentRecoveryReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.evaluator-report.v1',
    canonicalJsonBytes(reportMaterialV1Schema.parse(material)),
  );
}

export const l1SubagentRecoveryReportV1Schema = reportMaterialV1Schema
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
    const expected = computeL1SubagentRecoveryReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 subagent/recovery report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SubagentRecoveryReportV1 = z.infer<typeof l1SubagentRecoveryReportV1Schema>;

export function evaluateL1SubagentRecoveryCorpusV1(input: {
  evaluator: L1SubagentRecoveryEvaluatorIdentityV1;
  observations: readonly L1SubagentRecoveryCaseObservationV1[];
}): L1SubagentRecoveryReportV1 {
  const parsed = reportInputV1Schema.parse({
    schema: 'L1SubagentRecoveryEvaluatorReportV1',
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
  return l1SubagentRecoveryReportV1Schema.parse({
    ...material,
    reportDigest: computeL1SubagentRecoveryReportDigestV1(material),
  });
}

export function l1SubagentRecoveryObservationForCaseV1(
  caseId: L1SubagentRecoveryCaseIdV1,
  accepted: boolean,
): L1SubagentRecoveryCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
