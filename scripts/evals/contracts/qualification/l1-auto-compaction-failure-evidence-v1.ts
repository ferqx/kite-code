import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { qualificationReceiptBindingV1Schema } from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  type L1AutoCompactionFailureReportV1,
  l1AutoCompactionFailureReportV1Schema,
} from './l1-auto-compaction-failure-evaluator-v1';
import {
  buildL1AutoCompactionFailureSourceOwnedBindingV1,
  L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1,
  type L1AutoCompactionFailureAdapterResultV1,
  type L1AutoCompactionFailureSourceOwnedBindingV1,
  l1AutoCompactionFailureSourceOwnedBindingV1Schema,
} from './l1-auto-compaction-failure-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'L1 auto-compaction failure receipt metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * Metadata-only AQ-9A receipt. Fault labels, errors, prompts, response text,
 * routes, credentials, workspace paths, and synthetic transcript text have no
 * receipt field or retention path.
 */
const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1AutoCompactionFailureReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum(
      L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.map((entry) => entry.adapterId) as unknown as [
        string,
        ...string[],
      ],
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
    const adapter = L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.find(
      (entry) => entry.adapterId === value.adapterId,
    );
    if (!adapter || adapter.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'L1 auto-compaction failure receipt adapter/assertion pair must stay closed',
      });
      return;
    }
    const expectedBindingDigest = buildL1AutoCompactionFailureSourceOwnedBindingV1({
      sourceSurfaceId: value.sourceSurfaceId,
      declaration: adapter,
    }).bindingDigest;
    if (value.sourceBindingDigest !== expectedBindingDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindingDigest'],
        message: 'L1 auto-compaction failure receipt must bind the exact source surface and pair',
      });
    }
    const expectedReceiptId = `l1-auto-compaction-failure-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L1 auto-compaction failure receipt ID must derive from source and assertion',
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
        message: 'L1 auto-compaction failure receipt reason must be derived from outcome',
      });
    }
  });
export type L1AutoCompactionFailureReceiptMaterialV1 = z.infer<typeof receiptMaterialV1Schema>;

export function computeL1AutoCompactionFailureReceiptDigestV1(
  material: L1AutoCompactionFailureReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.auto-compaction-failure.receipt.v1',
    canonicalJsonBytes(receiptMaterialV1Schema.parse(material)),
  );
}

export const l1AutoCompactionFailureReceiptV1Schema = receiptMaterialV1Schema
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
    const expected = computeL1AutoCompactionFailureReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L1 auto-compaction failure receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1AutoCompactionFailureReceiptV1 = z.infer<
  typeof l1AutoCompactionFailureReceiptV1Schema
>;

export function buildL1AutoCompactionFailureReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1AutoCompactionFailureSourceOwnedBindingV1;
  matrixDigest: string;
  suiteDigest: string;
  evaluatorReport: L1AutoCompactionFailureReportV1;
  adapterResult: L1AutoCompactionFailureAdapterResultV1;
}): L1AutoCompactionFailureReceiptV1 {
  const binding = l1AutoCompactionFailureSourceOwnedBindingV1Schema.parse(input.binding);
  const evaluatorReport = l1AutoCompactionFailureReportV1Schema.parse(input.evaluatorReport);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_auto_compaction_failure_receipt_adapter_binding_mismatch');
  }
  const outcome =
    evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : input.adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = receiptMaterialV1Schema.parse({
    schema: 'L1AutoCompactionFailureReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l1-auto-compaction-failure-receipt:${input.sourceSurfaceId}:${binding.assertionId}`,
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
  return l1AutoCompactionFailureReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1AutoCompactionFailureReceiptDigestV1(material),
  });
}

export function l1AutoCompactionFailureReceiptBindingV1(
  receipt: L1AutoCompactionFailureReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}
