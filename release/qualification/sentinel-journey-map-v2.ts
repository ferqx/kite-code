import { z } from 'zod';
import { isQualificationSafeIdentifierV1 } from '../../scripts/evals/contracts/qualification/evidence/metadata-safety-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../scripts/release/canonical-json';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;

const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'sentinel V2 identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });
const featureIdSchema = z.string().regex(FEATURE_ID).refine(isQualificationSafeIdentifierV1, {
  message: 'sentinel V2 feature identifier must not contain unsafe metadata',
});

/**
 * These slots are deliberately fixed and independently versioned from V1.
 * V2 does not widen V1 or reuse V1's single-suite identity.
 */
export const SENTINEL_JOURNEY_IDS_V2 = [
  'sentinel-tool-approval-execution-verification',
  'sentinel-tool-invalid-arguments-correction',
  'sentinel-skill-discovery-activation-dependency-output-validation',
  'sentinel-skill-mcp-revision-drift',
  'sentinel-mcp-config-approval-connect-oauth-discovery-call',
  'sentinel-mcp-auth-expired-login-new-turn',
  'sentinel-subagent-approval-restart-continuation',
  'sentinel-effect-unknown-restart-reconciliation',
  'sentinel-parallel-tool-subagent-cancel-convergence',
  'sentinel-elevated-session-rewind-fork-tightening',
] as const;

export type SentinelJourneyIdV2 = (typeof SENTINEL_JOURNEY_IDS_V2)[number];

const sentinelJourneyIdV2Schema = z.enum(SENTINEL_JOURNEY_IDS_V2);

/**
 * A source binding is a compact reference only. AQ-4+ integration must
 * reconstruct this reference from a source-owned declaration; it must never
 * be treated as an authority merely because it deserializes successfully.
 */
export const sentinelJourneySourceBindingV2Schema = z
  .object({
    sourceSurfaceId: safeIdentifierSchema,
    featureId: featureIdSchema,
    assertionId: safeIdentifierSchema,
    sourceBindingDigest: digestSchema,
  })
  .strict();

export type SentinelJourneySourceBindingV2 = z.infer<typeof sentinelJourneySourceBindingV2Schema>;

export const sentinelJourneySuiteProvenanceV2Schema = z
  .object({
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
  })
  .strict();

export type SentinelJourneySuiteProvenanceV2 = z.infer<
  typeof sentinelJourneySuiteProvenanceV2Schema
>;

/**
 * Every behavioral receipt carries its own suite identity. There is no
 * map-level behavioral suite fallback in V2.
 */
export const sentinelJourneyBehavioralReceiptLinkV2Schema = sentinelJourneySourceBindingV2Schema
  .extend({
    receiptId: safeIdentifierSchema,
    receiptDigest: digestSchema,
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
    observation: z.enum(['observed', 'unobserved']),
  })
  .strict();

export type SentinelJourneyBehavioralReceiptLinkV2 = z.infer<
  typeof sentinelJourneyBehavioralReceiptLinkV2Schema
>;

/**
 * A CLI/TUI receipt is independently produced. Its behavioral link repeats
 * the exact source, receipt, and suite provenance it projects; its own
 * suiteId/suiteDigest identify the projection suite rather than a map-level
 * surrogate.
 */
export const sentinelJourneyProjectionReceiptLinkV2Schema = sentinelJourneySourceBindingV2Schema
  .extend({
    entrypoint: z.enum(['cli', 'tui']),
    behavioralReceiptId: safeIdentifierSchema,
    behavioralReceiptDigest: digestSchema,
    behavioralSuiteId: safeIdentifierSchema,
    behavioralSuiteDigest: digestSchema,
    projectionSourceBinding: sentinelJourneySourceBindingV2Schema,
    projectionAssertionId: safeIdentifierSchema,
    projectionReceiptId: safeIdentifierSchema,
    projectionReceiptDigest: digestSchema,
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
    observation: z.enum(['observed', 'unobserved']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projectionAssertionId !== value.projectionSourceBinding.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['projectionAssertionId'],
        message: 'projection assertion must be derived from its own source binding',
      });
    }
    if (
      value.projectionSourceBinding.sourceSurfaceId === value.sourceSurfaceId &&
      value.projectionSourceBinding.featureId === value.featureId &&
      value.projectionSourceBinding.assertionId === value.assertionId &&
      value.projectionSourceBinding.sourceBindingDigest === value.sourceBindingDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['projectionSourceBinding'],
        message: 'projection source binding must be independent from behavioral source binding',
      });
    }
    if (value.projectionReceiptId === value.behavioralReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['projectionReceiptId'],
        message: 'projection receipt must be independent from the behavioral receipt',
      });
    }
    if (
      value.suiteId === value.behavioralSuiteId ||
      value.suiteDigest === value.behavioralSuiteDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['suiteId'],
        message: 'projection suite provenance must be independent from behavioral suite provenance',
      });
    }
  });

export type SentinelJourneyProjectionReceiptLinkV2 = z.infer<
  typeof sentinelJourneyProjectionReceiptLinkV2Schema
>;

export const SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V2 = [
  'default_off_legacy_fallback',
  'entrypoint_not_exposed',
  'legacy_resume_rejected',
  'source_not_supported',
] as const;

export type SentinelJourneyNotApplicableRationaleV2 =
  (typeof SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V2)[number];

const notApplicableRationaleSchema = z.enum(SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V2);

export const sentinelJourneyRequiredWhenV2Schema = z
  .object({
    conditionId: safeIdentifierSchema,
    conditionDigest: digestSchema,
  })
  .strict();

export type SentinelJourneyRequiredWhenV2 = z.infer<typeof sentinelJourneyRequiredWhenV2Schema>;

export const sentinelJourneyApplicabilityInputEntryV2Schema = z
  .object({
    requiredWhen: sentinelJourneyRequiredWhenV2Schema.optional(),
    notApplicableRationale: notApplicableRationaleSchema.optional(),
  })
  .strict();

export type SentinelJourneyApplicabilityInputEntryV2 = z.infer<
  typeof sentinelJourneyApplicabilityInputEntryV2Schema
>;

export const sentinelJourneyApplicabilityInputV2Schema = z
  .object({
    journey: sentinelJourneyApplicabilityInputEntryV2Schema.optional(),
    cli: sentinelJourneyApplicabilityInputEntryV2Schema.optional(),
    tui: sentinelJourneyApplicabilityInputEntryV2Schema.optional(),
  })
  .strict();

export type SentinelJourneyApplicabilityInputV2 = z.infer<
  typeof sentinelJourneyApplicabilityInputV2Schema
>;

const sentinelJourneyApplicabilityEntryV2Schema = z
  .object({
    requiredWhen: sentinelJourneyRequiredWhenV2Schema.nullable(),
    notApplicableRationale: notApplicableRationaleSchema.nullable(),
    state: z.enum(['required', 'not_applicable', 'blocked']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state !== applicabilityStateV2(value.requiredWhen, value.notApplicableRationale)) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'applicability state must be derived from requiredWhen/notApplicableRationale',
      });
    }
  });

export type SentinelJourneyApplicabilityEntryV2 = z.infer<
  typeof sentinelJourneyApplicabilityEntryV2Schema
>;

export const sentinelJourneyApplicabilityV2Schema = z
  .object({
    journey: sentinelJourneyApplicabilityEntryV2Schema,
    cli: sentinelJourneyApplicabilityEntryV2Schema,
    tui: sentinelJourneyApplicabilityEntryV2Schema,
  })
  .strict();

export type SentinelJourneyApplicabilityV2 = z.infer<typeof sentinelJourneyApplicabilityV2Schema>;

const projectionReceiptSetsV2Schema = z
  .object({
    cli: z.array(sentinelJourneyProjectionReceiptLinkV2Schema),
    tui: z.array(sentinelJourneyProjectionReceiptLinkV2Schema),
  })
  .strict();

export type SentinelJourneyProjectionReceiptSetsV2 = z.infer<typeof projectionReceiptSetsV2Schema>;

/**
 * The only input accepted by the materializer is a trusted reconstructor's
 * compact snapshot. It is deliberately not a persisted map shape: integration
 * must rebuild it from current source ownership and verifier-checked receipts.
 */
export const sentinelJourneyTrustedRowInputV2Schema = z
  .object({
    journeyId: sentinelJourneyIdV2Schema,
    sourceBindings: z.array(sentinelJourneySourceBindingV2Schema).max(64).optional(),
    behavioralReceipts: z.array(sentinelJourneyBehavioralReceiptLinkV2Schema).max(128).optional(),
    entrypointProjectionReceipts: z
      .object({
        cli: z.array(sentinelJourneyProjectionReceiptLinkV2Schema).max(128).optional(),
        tui: z.array(sentinelJourneyProjectionReceiptLinkV2Schema).max(128).optional(),
      })
      .strict()
      .optional(),
    applicability: sentinelJourneyApplicabilityInputV2Schema.optional(),
  })
  .strict();

export type SentinelJourneyTrustedRowInputV2 = z.infer<
  typeof sentinelJourneyTrustedRowInputV2Schema
>;

export const sentinelJourneyTrustedSnapshotV2Schema = z
  .object({
    schema: z.literal('SentinelJourneyMapV2TrustedSnapshot'),
    version: z.literal(1),
    matrixDigest: digestSchema,
    rows: z.array(sentinelJourneyTrustedRowInputV2Schema).max(SENTINEL_JOURNEY_IDS_V2.length),
  })
  .strict();

export type SentinelJourneyTrustedSnapshotV2 = z.infer<
  typeof sentinelJourneyTrustedSnapshotV2Schema
>;

export const SENTINEL_JOURNEY_BLOCKED_REASONS_V2 = [
  'applicability_conflict',
  'applicability_missing',
  'behavioral_receipt_missing',
  'behavioral_receipt_unobserved',
  'cli_projection_missing',
  'cli_projection_unobserved',
  'link_identity_mismatch',
  'projection_not_independent',
  'source_binding_missing',
  'tui_projection_missing',
  'tui_projection_unobserved',
] as const;

export type SentinelJourneyBlockedReasonV2 = (typeof SENTINEL_JOURNEY_BLOCKED_REASONS_V2)[number];

const blockedReasonV2Schema = z.enum(SENTINEL_JOURNEY_BLOCKED_REASONS_V2);

export const sentinelJourneyMapRowV2Schema = z
  .object({
    journeyId: sentinelJourneyIdV2Schema,
    sourceBindings: z.array(sentinelJourneySourceBindingV2Schema),
    featureIds: z.array(featureIdSchema),
    assertionIds: z.array(safeIdentifierSchema),
    behavioralReceipts: z.array(sentinelJourneyBehavioralReceiptLinkV2Schema),
    behavioralReceiptIds: z.array(safeIdentifierSchema),
    entrypointProjectionReceipts: projectionReceiptSetsV2Schema,
    applicability: sentinelJourneyApplicabilityV2Schema,
    state: z.enum(['observed', 'not_applicable', 'blocked']),
    blockedReasons: z.array(blockedReasonV2Schema),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedFeatureIds = canonicalIds(
      [
        ...value.sourceBindings,
        ...value.entrypointProjectionReceipts.cli.map(
          (projection) => projection.projectionSourceBinding,
        ),
        ...value.entrypointProjectionReceipts.tui.map(
          (projection) => projection.projectionSourceBinding,
        ),
      ].map((binding) => binding.featureId),
    );
    const expectedAssertionIds = canonicalIds(
      [
        ...value.sourceBindings,
        ...value.entrypointProjectionReceipts.cli.map(
          (projection) => projection.projectionSourceBinding,
        ),
        ...value.entrypointProjectionReceipts.tui.map(
          (projection) => projection.projectionSourceBinding,
        ),
      ].map((binding) => binding.assertionId),
    );
    const expectedReceiptIds = canonicalIds(
      value.behavioralReceipts.map((receipt) => receipt.receiptId),
    );
    if (!sameStrings(value.featureIds, expectedFeatureIds)) {
      context.addIssue({
        code: 'custom',
        path: ['featureIds'],
        message: 'featureIds must be derived exactly from source bindings',
      });
    }
    if (!sameStrings(value.assertionIds, expectedAssertionIds)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'assertionIds must be derived exactly from source bindings',
      });
    }
    if (!sameStrings(value.behavioralReceiptIds, expectedReceiptIds)) {
      context.addIssue({
        code: 'custom',
        path: ['behavioralReceiptIds'],
        message: 'behavioralReceiptIds must be derived exactly from behavioral receipts',
      });
    }
    if (!sameSourceBindings(value.sourceBindings, canonicalSourceBindings(value.sourceBindings))) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindings'],
        message: 'source bindings must be canonical and code-point sorted',
      });
    }
    if (
      !sameBehavioralReceipts(
        value.behavioralReceipts,
        canonicalBehavioralReceipts(value.behavioralReceipts),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['behavioralReceipts'],
        message: 'behavioral receipts must be canonical and code-point sorted',
      });
    }
    for (const entrypoint of ['cli', 'tui'] as const) {
      const projections = value.entrypointProjectionReceipts[entrypoint];
      if (!sameProjectionReceipts(projections, canonicalProjectionReceipts(projections))) {
        context.addIssue({
          code: 'custom',
          path: ['entrypointProjectionReceipts', entrypoint],
          message: 'projection receipts must be canonical and code-point sorted',
        });
      }
    }
    const expectedReasons = blockedReasonsForRowV2(value);
    if (!sameStrings(value.blockedReasons, expectedReasons)) {
      context.addIssue({
        code: 'custom',
        path: ['blockedReasons'],
        message: 'sentinel V2 blocked reasons must be exact and canonical',
      });
    }
    if (value.state !== rowStateV2(value.applicability, expectedReasons)) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'sentinel V2 state must be derived from applicability and exact receipt links',
      });
    }
  });

export type SentinelJourneyMapRowV2 = z.infer<typeof sentinelJourneyMapRowV2Schema>;

const sentinelJourneyCoverageV2Schema = z
  .object({
    fixedRowCount: z.literal(SENTINEL_JOURNEY_IDS_V2.length),
    observedJourneyIds: z.array(sentinelJourneyIdV2Schema),
  })
  .strict();

export const sentinelJourneyMapMaterialV2Schema = z
  .object({
    schema: z.literal('SentinelJourneyMapV2'),
    version: z.literal(2),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    matrixDigest: digestSchema,
    rows: z.array(sentinelJourneyMapRowV2Schema),
    coverage: sentinelJourneyCoverageV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    assertFixedRowsV2(value.rows, context);
    const expectedObservedJourneyIds = value.rows
      .filter((row) => row.state === 'observed')
      .map((row) => row.journeyId);
    if (!sameStrings(value.coverage.observedJourneyIds, expectedObservedJourneyIds)) {
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'observedJourneyIds'],
        message: 'only fully observed required rows may contribute to V2 sentinel coverage',
      });
    }
  });

export type SentinelJourneyMapMaterialV2 = z.infer<typeof sentinelJourneyMapMaterialV2Schema>;

export function computeSentinelJourneyMapDigestV2(
  material: SentinelJourneyMapMaterialV2,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.sentinel-journey-map.v2',
    canonicalJsonBytes(sentinelJourneyMapMaterialV2Schema.parse(material)),
  );
}

export const sentinelJourneyMapV2Schema = sentinelJourneyMapMaterialV2Schema
  .extend({ mapDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { mapDigest, ...material } = value;
    const expected = computeSentinelJourneyMapDigestV2(material);
    if (mapDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['mapDigest'],
        message: 'sentinel V2 map digest mismatch',
      });
    }
  });

export type SentinelJourneyMapV2 = z.infer<typeof sentinelJourneyMapV2Schema>;

function blockedReasonsForRowV2(row: SentinelJourneyMapRowV2): SentinelJourneyBlockedReasonV2[] {
  const reasons = new Set<SentinelJourneyBlockedReasonV2>();
  const applicability = [row.applicability.journey, row.applicability.cli, row.applicability.tui];
  if (applicability.some((entry) => entry.state === 'blocked')) {
    reasons.add(
      applicability.some((entry) => entry.requiredWhen && entry.notApplicableRationale)
        ? 'applicability_conflict'
        : 'applicability_missing',
    );
  }
  if (
    row.applicability.journey.state === 'not_applicable' &&
    (row.applicability.cli.state === 'required' || row.applicability.tui.state === 'required')
  ) {
    reasons.add('applicability_conflict');
  }

  if (row.sourceBindings.length === 0) {
    reasons.add('source_binding_missing');
    return canonicalBlockedReasonsV2(reasons);
  }
  if (
    hasDuplicateKeys(row.sourceBindings.map(sourceBindingKeyV2)) ||
    hasDuplicateKeys(row.behavioralReceipts.map((receipt) => receipt.receiptId))
  ) {
    reasons.add('link_identity_mismatch');
  }

  if (row.applicability.journey.state === 'required') {
    validateBehavioralReceiptsV2(row, reasons);
  } else if (
    row.behavioralReceipts.some(
      (receipt) => !row.sourceBindings.some((binding) => sameSourceBindingV2(binding, receipt)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
  if (row.applicability.cli.state === 'required') {
    validateProjectionReceiptsV2('cli', row, reasons);
  }
  if (row.applicability.tui.state === 'required') {
    validateProjectionReceiptsV2('tui', row, reasons);
  }
  return canonicalBlockedReasonsV2(reasons);
}

function validateBehavioralReceiptsV2(
  row: SentinelJourneyMapRowV2,
  reasons: Set<SentinelJourneyBlockedReasonV2>,
): void {
  if (row.behavioralReceipts.length === 0) {
    reasons.add('behavioral_receipt_missing');
    return;
  }
  for (const binding of row.sourceBindings) {
    const matches = row.behavioralReceipts.filter((receipt) =>
      sameSourceBindingV2(binding, receipt),
    );
    if (matches.length === 0) {
      reasons.add('behavioral_receipt_missing');
      continue;
    }
    if (matches.some((receipt) => receipt.observation !== 'observed')) {
      reasons.add('behavioral_receipt_unobserved');
    }
  }
  if (
    row.behavioralReceipts.some(
      (receipt) => !row.sourceBindings.some((binding) => sameSourceBindingV2(binding, receipt)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function validateProjectionReceiptsV2(
  entrypoint: 'cli' | 'tui',
  row: SentinelJourneyMapRowV2,
  reasons: Set<SentinelJourneyBlockedReasonV2>,
): void {
  const projections = row.entrypointProjectionReceipts[entrypoint];
  if (projections.length === 0) {
    reasons.add(projectionMissingReasonV2(entrypoint));
    return;
  }
  if (hasDuplicateKeys(projections.map(projectionReceiptKeyV2))) {
    reasons.add('link_identity_mismatch');
  }
  for (const receipt of row.behavioralReceipts) {
    const matches = projections.filter((projection) =>
      sameBehavioralReceiptV2(receipt, projection),
    );
    if (matches.length !== 1) {
      reasons.add(projectionMissingReasonV2(entrypoint));
      if (matches.length > 1) reasons.add('link_identity_mismatch');
      continue;
    }
    const projection = matches[0];
    if (!projection) continue;
    if (projection.entrypoint !== entrypoint) {
      reasons.add('link_identity_mismatch');
    }
    if (projection.observation !== 'observed') {
      reasons.add(projectionUnobservedReasonV2(entrypoint));
    }
    if (!isIndependentProjectionV2(receipt, projection)) {
      reasons.add('projection_not_independent');
    }
  }
  if (
    projections.some(
      (projection) =>
        !row.behavioralReceipts.some((receipt) => sameBehavioralReceiptV2(receipt, projection)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function applicabilityStateV2(
  requiredWhen: SentinelJourneyRequiredWhenV2 | null,
  notApplicableRationale: SentinelJourneyNotApplicableRationaleV2 | null,
): SentinelJourneyApplicabilityEntryV2['state'] {
  if (requiredWhen && !notApplicableRationale) return 'required';
  if (!requiredWhen && notApplicableRationale) return 'not_applicable';
  return 'blocked';
}

function rowStateV2(
  applicability: SentinelJourneyApplicabilityV2,
  blockedReasons: readonly SentinelJourneyBlockedReasonV2[],
): SentinelJourneyMapRowV2['state'] {
  if (blockedReasons.length > 0) return 'blocked';
  return applicability.journey.state === 'not_applicable' ? 'not_applicable' : 'observed';
}

function sameSourceBindingV2(
  source: SentinelJourneySourceBindingV2,
  linked: SentinelJourneyBehavioralReceiptLinkV2 | SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    source.sourceSurfaceId === linked.sourceSurfaceId &&
    source.featureId === linked.featureId &&
    source.assertionId === linked.assertionId &&
    source.sourceBindingDigest === linked.sourceBindingDigest
  );
}

function sameBehavioralReceiptV2(
  receipt: SentinelJourneyBehavioralReceiptLinkV2,
  projection: SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    sameSourceBindingV2(receipt, projection) &&
    receipt.receiptId === projection.behavioralReceiptId &&
    receipt.receiptDigest === projection.behavioralReceiptDigest &&
    receipt.suiteId === projection.behavioralSuiteId &&
    receipt.suiteDigest === projection.behavioralSuiteDigest
  );
}

function isIndependentProjectionV2(
  receipt: SentinelJourneyBehavioralReceiptLinkV2,
  projection: SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    projection.projectionAssertionId === projection.projectionSourceBinding.assertionId &&
    !sameSourceBindingPairV2(receipt, projection.projectionSourceBinding) &&
    projection.projectionReceiptId !== receipt.receiptId &&
    projection.suiteId !== receipt.suiteId &&
    projection.suiteDigest !== receipt.suiteDigest
  );
}

function sameSourceBindingPairV2(
  left: SentinelJourneySourceBindingV2,
  right: SentinelJourneySourceBindingV2,
): boolean {
  return (
    left.sourceSurfaceId === right.sourceSurfaceId &&
    left.featureId === right.featureId &&
    left.assertionId === right.assertionId &&
    left.sourceBindingDigest === right.sourceBindingDigest
  );
}

function sourceBindingKeyV2(binding: SentinelJourneySourceBindingV2): string {
  return `${binding.sourceSurfaceId}\u0000${binding.featureId}\u0000${binding.assertionId}\u0000${binding.sourceBindingDigest}`;
}

function behavioralReceiptKeyV2(receipt: SentinelJourneyBehavioralReceiptLinkV2): string {
  return `${sourceBindingKeyV2(receipt)}\u0000${receipt.receiptId}\u0000${receipt.receiptDigest}\u0000${receipt.suiteId}\u0000${receipt.suiteDigest}`;
}

function projectionReceiptKeyV2(receipt: SentinelJourneyProjectionReceiptLinkV2): string {
  return `${receipt.entrypoint}\u0000${sourceBindingKeyV2(receipt)}\u0000${sourceBindingKeyV2(receipt.projectionSourceBinding)}\u0000${receipt.behavioralReceiptId}\u0000${receipt.behavioralReceiptDigest}\u0000${receipt.behavioralSuiteId}\u0000${receipt.behavioralSuiteDigest}\u0000${receipt.projectionAssertionId}\u0000${receipt.projectionReceiptId}\u0000${receipt.projectionReceiptDigest}\u0000${receipt.suiteId}\u0000${receipt.suiteDigest}`;
}

function canonicalSourceBindings(
  bindings: readonly SentinelJourneySourceBindingV2[],
): SentinelJourneySourceBindingV2[] {
  return [...bindings].sort((left, right) =>
    compareCodePoint(sourceBindingKeyV2(left), sourceBindingKeyV2(right)),
  );
}

function canonicalBehavioralReceipts(
  receipts: readonly SentinelJourneyBehavioralReceiptLinkV2[],
): SentinelJourneyBehavioralReceiptLinkV2[] {
  return [...receipts].sort((left, right) =>
    compareCodePoint(behavioralReceiptKeyV2(left), behavioralReceiptKeyV2(right)),
  );
}

function canonicalProjectionReceipts(
  receipts: readonly SentinelJourneyProjectionReceiptLinkV2[],
): SentinelJourneyProjectionReceiptLinkV2[] {
  return [...receipts].sort((left, right) =>
    compareCodePoint(projectionReceiptKeyV2(left), projectionReceiptKeyV2(right)),
  );
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoint);
}

function canonicalBlockedReasonsV2(
  reasons: ReadonlySet<SentinelJourneyBlockedReasonV2>,
): SentinelJourneyBlockedReasonV2[] {
  return SENTINEL_JOURNEY_BLOCKED_REASONS_V2.filter((reason) => reasons.has(reason));
}

function projectionMissingReasonV2(entrypoint: 'cli' | 'tui'): SentinelJourneyBlockedReasonV2 {
  return entrypoint === 'cli' ? 'cli_projection_missing' : 'tui_projection_missing';
}

function projectionUnobservedReasonV2(entrypoint: 'cli' | 'tui'): SentinelJourneyBlockedReasonV2 {
  return entrypoint === 'cli' ? 'cli_projection_unobserved' : 'tui_projection_unobserved';
}

function assertFixedRowsV2(
  rows: readonly SentinelJourneyMapRowV2[],
  context: z.RefinementCtx,
): void {
  if (rows.length !== SENTINEL_JOURNEY_IDS_V2.length) {
    context.addIssue({
      code: 'custom',
      path: ['rows'],
      message: `sentinel V2 map must contain exactly ${SENTINEL_JOURNEY_IDS_V2.length} fixed rows`,
    });
    return;
  }
  if (
    !sameStrings(
      rows.map((row) => row.journeyId),
      SENTINEL_JOURNEY_IDS_V2,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['rows'],
      message: 'sentinel V2 rows must use every fixed journey ID exactly once and in order',
    });
  }
}

function sameSourceBindings(
  left: readonly SentinelJourneySourceBindingV2[],
  right: readonly SentinelJourneySourceBindingV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => sourceBindingKeyV2(value) === sourceBindingKeyV2(right[index] ?? value),
    )
  );
}

function sameBehavioralReceipts(
  left: readonly SentinelJourneyBehavioralReceiptLinkV2[],
  right: readonly SentinelJourneyBehavioralReceiptLinkV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        behavioralReceiptKeyV2(value) === behavioralReceiptKeyV2(right[index] ?? value),
    )
  );
}

function sameProjectionReceipts(
  left: readonly SentinelJourneyProjectionReceiptLinkV2[],
  right: readonly SentinelJourneyProjectionReceiptLinkV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        projectionReceiptKeyV2(value) === projectionReceiptKeyV2(right[index] ?? value),
    )
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasDuplicateKeys(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
