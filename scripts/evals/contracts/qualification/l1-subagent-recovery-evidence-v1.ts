import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { qualificationReceiptBindingV1Schema } from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  type L1SubagentRecoveryReportV1,
  l1SubagentRecoveryReportV1Schema,
} from './l1-subagent-recovery-evaluator-v1';
import {
  buildL1SubagentRecoverySourceOwnedBindingV1,
  L1_SUBAGENT_RECOVERY_ADAPTERS_V1,
  type L1SubagentRecoveryAdapterResultV1,
  type L1SubagentRecoverySourceOwnedBindingV1,
  l1SubagentRecoverySourceOwnedBindingV1Schema,
} from './l1-subagent-recovery-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'L1 subagent/recovery receipt metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * Metadata-only AQ-6 receipt. It deliberately stores no continuation, task,
 * result, workspace, prompt, source body, credential, or child output.
 */
const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1SubagentRecoveryReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum(
      L1_SUBAGENT_RECOVERY_ADAPTERS_V1.map((entry) => entry.adapterId) as unknown as [
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
    const adapter = L1_SUBAGENT_RECOVERY_ADAPTERS_V1.find(
      (entry) => entry.adapterId === value.adapterId,
    );
    if (!adapter || adapter.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message:
          'L1 subagent/recovery receipt adapter/assertion pair must remain closed and registered',
      });
      return;
    }
    const expectedBindingDigest = buildL1SubagentRecoverySourceOwnedBindingV1({
      sourceSurfaceId: value.sourceSurfaceId,
      declaration: adapter,
    }).bindingDigest;
    if (value.sourceBindingDigest !== expectedBindingDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindingDigest'],
        message: 'L1 subagent/recovery receipt must bind the exact source surface and pair',
      });
    }
    const expectedReceiptId = `l1-subagent-recovery-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L1 subagent/recovery receipt ID must derive from source surface and assertion',
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
        message: 'L1 subagent/recovery receipt reason must be derived from outcome',
      });
    }
  });
export type L1SubagentRecoveryReceiptMaterialV1 = z.infer<typeof receiptMaterialV1Schema>;

export function computeL1SubagentRecoveryReceiptDigestV1(
  material: L1SubagentRecoveryReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.subagent-recovery.receipt.v1',
    canonicalJsonBytes(receiptMaterialV1Schema.parse(material)),
  );
}

export const l1SubagentRecoveryReceiptV1Schema = receiptMaterialV1Schema
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
    const expected = computeL1SubagentRecoveryReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L1 subagent/recovery receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1SubagentRecoveryReceiptV1 = z.infer<typeof l1SubagentRecoveryReceiptV1Schema>;

export function buildL1SubagentRecoveryReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1SubagentRecoverySourceOwnedBindingV1;
  matrixDigest: string;
  suiteDigest: string;
  evaluatorReport: L1SubagentRecoveryReportV1;
  adapterResult: L1SubagentRecoveryAdapterResultV1;
}): L1SubagentRecoveryReceiptV1 {
  const binding = l1SubagentRecoverySourceOwnedBindingV1Schema.parse(input.binding);
  const evaluatorReport = l1SubagentRecoveryReportV1Schema.parse(input.evaluatorReport);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_subagent_recovery_receipt_adapter_binding_mismatch');
  }
  const outcome =
    evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : input.adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = receiptMaterialV1Schema.parse({
    schema: 'L1SubagentRecoveryReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l1-subagent-recovery-receipt:${input.sourceSurfaceId}:${binding.assertionId}`,
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
  return l1SubagentRecoveryReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1SubagentRecoveryReceiptDigestV1(material),
  });
}

export function l1SubagentRecoveryReceiptBindingV1(
  receipt: L1SubagentRecoveryReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}
