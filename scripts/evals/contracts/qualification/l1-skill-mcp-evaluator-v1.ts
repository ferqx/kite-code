import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  L1_SKILL_MCP_CASE_IDS_V1,
  type L1SkillMcpCaseIdV1,
  type L1SkillMcpEvaluatorIdentityV1,
  l1SkillMcpEvaluatorIdentityV1Schema,
} from './l1-skill-mcp-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);
const caseIdSchema = z.enum(L1_SKILL_MCP_CASE_IDS_V1);

/** `accepted` is an observed diagnostic assertion, not a product admission decision. */
export const l1SkillMcpCaseObservationV1Schema = z
  .object({ caseId: caseIdSchema, observedOutcome: z.enum(['accepted', 'rejected']) })
  .strict();
export type L1SkillMcpCaseObservationV1 = z.infer<typeof l1SkillMcpCaseObservationV1Schema>;

function hasExactInventory(values: readonly string[]): boolean {
  return (
    values.length === L1_SKILL_MCP_CASE_IDS_V1.length &&
    values.every((value, index) => value === L1_SKILL_MCP_CASE_IDS_V1[index])
  );
}

const reportInputV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l1SkillMcpEvaluatorIdentityV1Schema,
    observations: z.array(l1SkillMcpCaseObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasExactInventory(value.observations.map((entry) => entry.caseId))) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message: 'L1 Skill/MCP observations must be the exact code-point-sorted inventory',
      });
    }
  });
export type L1SkillMcpReportInputV1 = z.infer<typeof reportInputV1Schema>;

export const L1_SKILL_MCP_REPORT_STATUSES_V1 = ['accepted', 'blocked'] as const;
export type L1SkillMcpReportStatusV1 = (typeof L1_SKILL_MCP_REPORT_STATUSES_V1)[number];

const reportMaterialV1Schema = reportInputV1Schema
  .extend({
    rejectedCaseIds: z.array(caseIdSchema),
    status: z.enum(L1_SKILL_MCP_REPORT_STATUSES_V1),
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
        message: 'L1 Skill/MCP rejected cases must be derived from observations',
      });
    }
    const expectedStatus = rejectedCaseIds.length === 0 ? 'accepted' : 'blocked';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L1 Skill/MCP report status mismatch: expected ${expectedStatus}`,
      });
    }
  });
export type L1SkillMcpReportMaterialV1 = z.infer<typeof reportMaterialV1Schema>;

export function computeL1SkillMcpReportDigestV1(
  material: L1SkillMcpReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.evaluator-report.v1',
    canonicalJsonBytes(reportMaterialV1Schema.parse(material)),
  );
}

export const l1SkillMcpReportV1Schema = reportMaterialV1Schema
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
    const expected = computeL1SkillMcpReportDigestV1(parsed.data);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L1 Skill/MCP report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SkillMcpReportV1 = z.infer<typeof l1SkillMcpReportV1Schema>;

export function evaluateL1SkillMcpCorpusV1(input: {
  evaluator: L1SkillMcpEvaluatorIdentityV1;
  observations: readonly L1SkillMcpCaseObservationV1[];
}): L1SkillMcpReportV1 {
  const parsed = reportInputV1Schema.parse({
    schema: 'L1SkillMcpEvaluatorReportV1',
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
  return l1SkillMcpReportV1Schema.parse({
    ...material,
    reportDigest: computeL1SkillMcpReportDigestV1(material),
  });
}

export function l1SkillMcpObservationForCaseV1(
  caseId: L1SkillMcpCaseIdV1,
  accepted: boolean,
): L1SkillMcpCaseObservationV1 {
  return { caseId, observedOutcome: accepted ? 'accepted' : 'rejected' };
}
