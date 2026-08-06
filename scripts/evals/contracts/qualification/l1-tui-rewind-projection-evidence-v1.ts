import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { qualificationReceiptBindingV1Schema } from './evidence/evidence-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  type L1TuiRewindForkProjectionReportV1,
  l1TuiRewindForkProjectionReportV1Schema,
} from './l1-tui-rewind-projection-evaluator-v1';
import {
  bindL1TuiRewindForkProjectionCatalogSuiteV1,
  buildL1TuiRewindForkProjectionSourceOwnedBindingV1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1,
  type L1TuiRewindForkProjectionAdapterResultV1,
  type L1TuiRewindForkProjectionSourceOwnedBindingV1,
  l1TuiRewindForkProjectionSourceOwnedBindingV1Schema,
} from './l1-tui-rewind-projection-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'L1 TUI rewind projection receipt metadata must not contain an endpoint, absolute path, or unsafe value',
  });

/**
 * Metadata-only AQ-6 receipt. It cannot retain a fixture root, workspace
 * body, source body, prompt, output, route, secret, or provider material.
 */
const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1TuiRewindForkProjectionReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.literal('tui-rewind-fork-projection-v1'),
    assertionId: z.literal('l1.projection.tui.rewind-fork-tightening.v1'),
    sourceBindingDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
    evaluatorDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    outcome: z.enum(['passed', 'failed', 'blocked']),
    reasonCode: z.enum(['adapter_assertion_failed', 'evaluator_blocked', 'passed']),
  })
  .strict()
  .superRefine((value, context) => {
    const adapter = L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1[0];
    if (
      !adapter ||
      adapter.assertionId !== value.assertionId ||
      adapter.adapterId !== value.adapterId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'L1 TUI rewind projection receipt pair must remain closed and registered',
      });
      return;
    }
    const expectedBindingDigest = buildL1TuiRewindForkProjectionSourceOwnedBindingV1({
      sourceSurfaceId: value.sourceSurfaceId,
      declaration: adapter,
    }).bindingDigest;
    if (value.sourceBindingDigest !== expectedBindingDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindingDigest'],
        message: 'L1 TUI rewind projection receipt must bind its exact source surface and pair',
      });
    }
    const expectedReceiptId = `l1-tui-rewind-fork-projection-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message:
          'L1 TUI rewind projection receipt ID must derive from source surface and assertion',
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
        message: 'L1 TUI rewind projection receipt reason must derive from outcome',
      });
    }
  });
export type L1TuiRewindForkProjectionReceiptMaterialV1 = z.infer<typeof receiptMaterialV1Schema>;

export function computeL1TuiRewindForkProjectionReceiptDigestV1(
  material: L1TuiRewindForkProjectionReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.tui-rewind-fork-projection.receipt.v1',
    canonicalJsonBytes(receiptMaterialV1Schema.parse(material)),
  );
}

export const l1TuiRewindForkProjectionReceiptV1Schema = receiptMaterialV1Schema
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
    const expected = computeL1TuiRewindForkProjectionReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L1 TUI rewind projection receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1TuiRewindForkProjectionReceiptV1 = z.infer<
  typeof l1TuiRewindForkProjectionReceiptV1Schema
>;

/**
 * The caller must pass the source-owned Matrix suite identity. The local
 * runner cannot manufacture a Feature mapping or a second Matrix authority.
 */
export function buildL1TuiRewindForkProjectionReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1TuiRewindForkProjectionSourceOwnedBindingV1;
  matrixDigest: string;
  matrixSuite: import('./feature-matrix').QualificationSuiteV1;
  evaluatorReport: L1TuiRewindForkProjectionReportV1;
  adapterResult: L1TuiRewindForkProjectionAdapterResultV1;
}): L1TuiRewindForkProjectionReceiptV1 {
  const binding = l1TuiRewindForkProjectionSourceOwnedBindingV1Schema.parse(input.binding);
  const evaluatorReport = l1TuiRewindForkProjectionReportV1Schema.parse(input.evaluatorReport);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_tui_rewind_fork_projection_receipt_adapter_binding_mismatch');
  }
  const catalogSuite = bindL1TuiRewindForkProjectionCatalogSuiteV1(input.matrixSuite);
  const outcome =
    evaluatorReport.status !== 'accepted'
      ? ('blocked' as const)
      : input.adapterResult.outcome === 'passed'
        ? ('passed' as const)
        : ('failed' as const);
  const material = receiptMaterialV1Schema.parse({
    schema: 'L1TuiRewindForkProjectionReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l1-tui-rewind-fork-projection-receipt:${input.sourceSurfaceId}:${binding.assertionId}`,
    sourceSurfaceId: input.sourceSurfaceId,
    featureId: input.featureId,
    adapterId: binding.adapterId,
    assertionId: binding.assertionId,
    sourceBindingDigest: binding.bindingDigest,
    matrixDigest: input.matrixDigest,
    suiteId: catalogSuite.suiteId,
    suiteDigest: catalogSuite.suiteDigest,
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
  return l1TuiRewindForkProjectionReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1TuiRewindForkProjectionReceiptDigestV1(material),
  });
}

export function l1TuiRewindForkProjectionReceiptBindingV1(
  receipt: L1TuiRewindForkProjectionReceiptV1,
): z.infer<typeof qualificationReceiptBindingV1Schema> {
  return qualificationReceiptBindingV1Schema.parse({
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
  });
}
