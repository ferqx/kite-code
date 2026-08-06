import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { qualificationReceiptBindingV1Schema } from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import { type L1SkillMcpReportV1, l1SkillMcpReportV1Schema } from './l1-skill-mcp-evaluator-v1';
import {
  buildL1SkillMcpSourceOwnedBindingV1,
  L1_SKILL_MCP_ADAPTERS_V1,
  type L1SkillMcpAdapterResultV1,
  type L1SkillMcpSourceOwnedBindingV1,
  l1SkillMcpSourceOwnedBindingV1Schema,
} from './l1-skill-mcp-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'L1 Skill/MCP receipt metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * A closed metadata-only receipt for an exact L1 Skill/MCP assertion. It
 * stores neither fixture text nor any provider, authorization, workspace, or
 * runtime payload.
 */
const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1SkillMcpReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum(
      L1_SKILL_MCP_ADAPTERS_V1.map((entry) => entry.adapterId) as unknown as [string, ...string[]],
    ),
    assertionId: safeIdentifierSchema,
    sourceBindingDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteDigest: digestSchema,
    evaluatorDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    outcome: z.enum(['passed', 'failed', 'blocked']),
    reasonCode: z.enum(['adapter_assertion_failed', 'evaluator_blocked', 'passed']),
  })
  .strict()
  .superRefine((value, context) => {
    const adapter = L1_SKILL_MCP_ADAPTERS_V1.find((entry) => entry.adapterId === value.adapterId);
    if (!adapter || adapter.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'L1 Skill/MCP receipt adapter/assertion pair must remain closed and registered',
      });
      return;
    }
    const expectedBindingDigest = buildL1SkillMcpSourceOwnedBindingV1({
      sourceSurfaceId: value.sourceSurfaceId,
      declaration: adapter,
    }).bindingDigest;
    if (value.sourceBindingDigest !== expectedBindingDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindingDigest'],
        message: 'L1 Skill/MCP receipt must bind the exact source surface and pair',
      });
    }
    const expectedReceiptId = `l1-skill-mcp-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L1 Skill/MCP receipt ID must be derived from source surface and assertion',
      });
    }
    const expectedReason =
      value.outcome === 'passed'
        ? 'passed'
        : value.outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked';
    if (value.reasonCode !== expectedReason) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'L1 Skill/MCP receipt reason must be derived from outcome',
      });
    }
  });
export type L1SkillMcpReceiptMaterialV1 = z.infer<typeof receiptMaterialV1Schema>;

export function computeL1SkillMcpReceiptDigestV1(
  material: L1SkillMcpReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.skill-mcp.receipt.v1',
    canonicalJsonBytes(receiptMaterialV1Schema.parse(material)),
  );
}

export const l1SkillMcpReceiptV1Schema = receiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    const parsed = receiptMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL1SkillMcpReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L1 Skill/MCP receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SkillMcpReceiptV1 = z.infer<typeof l1SkillMcpReceiptV1Schema>;

export function buildL1SkillMcpReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1SkillMcpSourceOwnedBindingV1;
  matrixDigest: string;
  suiteDigest: string;
  evaluatorReport: L1SkillMcpReportV1;
  adapterResult: L1SkillMcpAdapterResultV1;
}): L1SkillMcpReceiptV1 {
  const binding = l1SkillMcpSourceOwnedBindingV1Schema.parse(input.binding);
  const evaluatorReport = l1SkillMcpReportV1Schema.parse(input.evaluatorReport);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_skill_mcp_receipt_adapter_binding_mismatch');
  }
  const outcome =
    evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : input.adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = receiptMaterialV1Schema.parse({
    schema: 'L1SkillMcpReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l1-skill-mcp-receipt:${input.sourceSurfaceId}:${binding.assertionId}`,
    sourceSurfaceId: input.sourceSurfaceId,
    featureId: input.featureId,
    adapterId: binding.adapterId,
    assertionId: binding.assertionId,
    sourceBindingDigest: binding.bindingDigest,
    matrixDigest: input.matrixDigest,
    suiteDigest: input.suiteDigest,
    evaluatorDigest: evaluatorReport.evaluator.evaluatorDigest,
    evaluatorReportDigest: evaluatorReport.reportDigest,
    outcome,
    reasonCode:
      outcome === 'passed'
        ? 'passed'
        : outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked',
  });
  return l1SkillMcpReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1SkillMcpReceiptDigestV1(material),
  });
}

export function l1SkillMcpReceiptBindingV1(
  receipt: L1SkillMcpReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}
