import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { qualificationReceiptBindingV1Schema } from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  type L1ToolVerificationReportV1,
  l1ToolVerificationReportV1Schema,
} from './l1-tool-verification-evaluator-v1';
import {
  buildL1SourceOwnedBindingV1,
  L1_TOOL_VERIFICATION_ADAPTERS_V1,
  type L1SourceOwnedBindingV1,
  type L1ToolVerificationAdapterResultV1,
  l1SourceOwnedBindingV1Schema,
} from './l1-tool-verification-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message: 'L1 receipt metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * A sealed, metadata-only candidate-side receipt for one L1 product assertion.
 * It is not a release-evidence record and contains no fixture content, prompt,
 * response, endpoint, source body, workspace path, credential, or transcript.
 */
const l1ToolVerificationReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1ToolVerificationReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum(
      L1_TOOL_VERIFICATION_ADAPTERS_V1.map((entry) => entry.adapterId) as unknown as [
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
    const adapter = L1_TOOL_VERIFICATION_ADAPTERS_V1.find(
      (entry) => entry.adapterId === value.adapterId,
    );
    if (!adapter || adapter.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'L1 receipt adapter/assertion pair must remain closed and registered',
      });
    }
    if (adapter) {
      const expectedBindingDigest = buildL1SourceOwnedBindingV1({
        sourceSurfaceId: value.sourceSurfaceId,
        declaration: adapter,
      }).bindingDigest;
      if (value.sourceBindingDigest !== expectedBindingDigest) {
        context.addIssue({
          code: 'custom',
          path: ['sourceBindingDigest'],
          message: 'L1 receipt must bind its exact source surface and closed adapter pair',
        });
      }
    }
    const expectedReceiptId = 'l1-receipt:' + value.sourceSurfaceId + ':' + value.assertionId;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L1 receipt ID must be derived from source surface and assertion',
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
        message: 'L1 receipt reason must be derived from its outcome',
      });
    }
  });

export type L1ToolVerificationReceiptMaterialV1 = z.infer<
  typeof l1ToolVerificationReceiptMaterialV1Schema
>;

export function computeL1ToolVerificationReceiptDigestV1(
  material: L1ToolVerificationReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tool-verification.receipt.v1',
    canonicalJsonBytes(l1ToolVerificationReceiptMaterialV1Schema.parse(material)),
  );
}

export const l1ToolVerificationReceiptV1Schema = l1ToolVerificationReceiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    const parsed = l1ToolVerificationReceiptMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL1ToolVerificationReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: 'L1 receipt digest mismatch: expected ' + expected,
      });
    }
  });

export type L1ToolVerificationReceiptV1 = z.infer<typeof l1ToolVerificationReceiptV1Schema>;

export function buildL1ToolVerificationReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1SourceOwnedBindingV1;
  matrixDigest: string;
  suiteDigest: string;
  evaluatorReport: L1ToolVerificationReportV1;
  adapterResult: L1ToolVerificationAdapterResultV1;
}): L1ToolVerificationReceiptV1 {
  const binding = l1SourceOwnedBindingV1Schema.parse(input.binding);
  const evaluatorReport = l1ToolVerificationReportV1Schema.parse(input.evaluatorReport);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_receipt_adapter_binding_mismatch');
  }
  const outcome =
    evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : input.adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = l1ToolVerificationReceiptMaterialV1Schema.parse({
    schema: 'L1ToolVerificationReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: 'l1-receipt:' + input.sourceSurfaceId + ':' + binding.assertionId,
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
  return l1ToolVerificationReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1ToolVerificationReceiptDigestV1(material),
  });
}

export function l1ToolVerificationReceiptBindingV1(
  receipt: L1ToolVerificationReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}
