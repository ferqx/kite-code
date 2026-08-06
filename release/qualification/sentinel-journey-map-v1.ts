import { z } from 'zod';
import { isQualificationSafeIdentifierV1 } from '../../scripts/evals/contracts/qualification/evidence/metadata-safety-v1';
import { generateAgentFeatureQualificationMatrixV1 } from '../../scripts/evals/contracts/qualification/feature-matrix';
import { L0_CONTRACT_SUITE_ID_V1 } from '../../scripts/evals/contracts/qualification/l0-contract-schema-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../scripts/release/canonical-json';
import { createSourceOwnedQualificationCatalogV1 } from './source-owned-surface-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;

const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message: 'sentinel identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });
const featureIdSchema = z.string().regex(FEATURE_ID);

/**
 * These are the RFC's ten critical journeys. The fixed slot names describe
 * journeys only; product owners supply all source-surface, feature, assertion,
 * and receipt identities at construction time. There is no lookup table from
 * a source surface to a feature in this module.
 */
export const SENTINEL_JOURNEY_IDS_V1 = [
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

export type SentinelJourneyIdV1 = (typeof SENTINEL_JOURNEY_IDS_V1)[number];

const sentinelJourneyIdV1Schema = z.enum(SENTINEL_JOURNEY_IDS_V1);

/** The source-owned matrix and behavioral assertion must agree exactly. */
export const sentinelJourneySourceBindingV1Schema = z
  .object({
    sourceSurfaceId: safeIdentifierSchema,
    featureId: featureIdSchema,
    assertionId: safeIdentifierSchema,
  })
  .strict();

export type SentinelJourneySourceBindingV1 = z.infer<typeof sentinelJourneySourceBindingV1Schema>;

/** A behavioral receipt is linked to one exact source-owned assertion. */
export const sentinelJourneyReceiptLinkV1Schema = sentinelJourneySourceBindingV1Schema
  .extend({
    receiptId: safeIdentifierSchema,
    receiptDigest: digestSchema,
    observation: z.enum(['observed', 'unobserved']),
  })
  .strict();

export type SentinelJourneyReceiptLinkV1 = z.infer<typeof sentinelJourneyReceiptLinkV1Schema>;

/**
 * A public projection carries its own assertion and receipt. It also carries
 * the source receipt identity that it projects, so a CLI/TUI claim cannot be
 * moved to a different feature or behavioral receipt.
 */
export const sentinelJourneyProjectionLinkV1Schema = sentinelJourneyReceiptLinkV1Schema
  .omit({ observation: true })
  .extend({
    entrypoint: z.enum(['cli', 'tui']),
    projectionAssertionId: safeIdentifierSchema,
    projectionReceiptId: safeIdentifierSchema,
    projectionReceiptDigest: digestSchema,
    observation: z.enum(['observed', 'unobserved']),
  })
  .strict();

export type SentinelJourneyProjectionLinkV1 = z.infer<typeof sentinelJourneyProjectionLinkV1Schema>;

export const SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V1 = [
  'default_off_legacy_fallback',
  'entrypoint_not_exposed',
  'legacy_resume_rejected',
  'source_not_supported',
] as const;

export type SentinelJourneyNotApplicableRationaleV1 =
  (typeof SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V1)[number];

const notApplicableRationaleSchema = z.enum(SENTINEL_JOURNEY_NOT_APPLICABLE_RATIONALES_V1);

/** A structured source-owned condition reference; prose conditions are not accepted. */
export const sentinelJourneyRequiredWhenV1Schema = z
  .object({
    conditionId: safeIdentifierSchema,
    conditionDigest: digestSchema,
  })
  .strict();

export type SentinelJourneyRequiredWhenV1 = z.infer<typeof sentinelJourneyRequiredWhenV1Schema>;

/**
 * `requiredWhen` and `notApplicableRationale` are intentionally both present
 * in output. Exactly one is populated for every journey, CLI, and TUI scope.
 */
export const sentinelJourneyApplicabilityInputEntryV1Schema = z
  .object({
    requiredWhen: sentinelJourneyRequiredWhenV1Schema.optional(),
    notApplicableRationale: notApplicableRationaleSchema.optional(),
  })
  .strict();

export type SentinelJourneyApplicabilityInputEntryV1 = z.infer<
  typeof sentinelJourneyApplicabilityInputEntryV1Schema
>;

export const sentinelJourneyApplicabilityInputV1Schema = z
  .object({
    journey: sentinelJourneyApplicabilityInputEntryV1Schema.optional(),
    cli: sentinelJourneyApplicabilityInputEntryV1Schema.optional(),
    tui: sentinelJourneyApplicabilityInputEntryV1Schema.optional(),
  })
  .strict();

export type SentinelJourneyApplicabilityInputV1 = z.infer<
  typeof sentinelJourneyApplicabilityInputV1Schema
>;

const sentinelJourneyApplicabilityEntryV1Schema = z
  .object({
    requiredWhen: sentinelJourneyRequiredWhenV1Schema.nullable(),
    notApplicableRationale: notApplicableRationaleSchema.nullable(),
    state: z.enum(['required', 'not_applicable', 'blocked']),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = applicabilityStateV1(value.requiredWhen, value.notApplicableRationale);
    if (value.state !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'applicability state must be derived from requiredWhen/notApplicableRationale',
      });
    }
  });

export type SentinelJourneyApplicabilityEntryV1 = z.infer<
  typeof sentinelJourneyApplicabilityEntryV1Schema
>;

export const sentinelJourneyApplicabilityV1Schema = z
  .object({
    journey: sentinelJourneyApplicabilityEntryV1Schema,
    cli: sentinelJourneyApplicabilityEntryV1Schema,
    tui: sentinelJourneyApplicabilityEntryV1Schema,
  })
  .strict();

export type SentinelJourneyApplicabilityV1 = z.infer<typeof sentinelJourneyApplicabilityV1Schema>;

const sentinelJourneyProjectionAssertionsV1Schema = z
  .object({
    cli: z.array(sentinelJourneyProjectionLinkV1Schema),
    tui: z.array(sentinelJourneyProjectionLinkV1Schema),
  })
  .strict();

export type SentinelJourneyProjectionAssertionsV1 = z.infer<
  typeof sentinelJourneyProjectionAssertionsV1Schema
>;

/**
 * Each input row is supplied by source owners. Omitting any scope, link, or
 * applicability entry is valid input: the resulting fixed row is blocked
 * rather than dropped or silently counted.
 */
export const sentinelJourneySourceOwnedRowInputV1Schema = z
  .object({
    journeyId: sentinelJourneyIdV1Schema,
    sourceBindings: z.array(sentinelJourneySourceBindingV1Schema).max(64).optional(),
    receipts: z.array(sentinelJourneyReceiptLinkV1Schema).max(64).optional(),
    entrypointProjectionAssertions: z
      .object({
        cli: z.array(sentinelJourneyProjectionLinkV1Schema).max(64).optional(),
        tui: z.array(sentinelJourneyProjectionLinkV1Schema).max(64).optional(),
      })
      .strict()
      .optional(),
    applicability: sentinelJourneyApplicabilityInputV1Schema.optional(),
  })
  .strict();

export type SentinelJourneySourceOwnedRowInputV1 = z.infer<
  typeof sentinelJourneySourceOwnedRowInputV1Schema
>;

const blockedReasonSchema = z.enum([
  'applicability_conflict',
  'applicability_missing',
  'cli_projection_missing',
  'cli_projection_unobserved',
  'link_identity_mismatch',
  'projection_not_independent',
  'receipt_missing',
  'receipt_unobserved',
  'source_binding_missing',
  'tui_projection_missing',
  'tui_projection_unobserved',
]);

export const SENTINEL_JOURNEY_BLOCKED_REASONS_V1 = blockedReasonSchema.options;
export type SentinelJourneyBlockedReasonV1 = z.infer<typeof blockedReasonSchema>;

export const sentinelJourneyMapRowV1Schema = z
  .object({
    journeyId: sentinelJourneyIdV1Schema,
    sourceBindings: z.array(sentinelJourneySourceBindingV1Schema),
    /** Derived exact, code-point sorted IDs from sourceBindings. */
    featureIds: z.array(featureIdSchema),
    /** Derived exact, code-point sorted IDs from sourceBindings. */
    assertionIds: z.array(safeIdentifierSchema),
    receipts: z.array(sentinelJourneyReceiptLinkV1Schema),
    /** Derived exact, code-point sorted IDs from receipts. */
    receiptIds: z.array(safeIdentifierSchema),
    entrypointProjectionAssertions: sentinelJourneyProjectionAssertionsV1Schema,
    applicability: sentinelJourneyApplicabilityV1Schema,
    state: z.enum(['observed', 'not_applicable', 'blocked']),
    blockedReasons: z.array(blockedReasonSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedFeatureIds = canonicalIds(
      value.sourceBindings.map((binding) => binding.featureId),
    );
    const expectedAssertionIds = canonicalIds(
      value.sourceBindings.map((binding) => binding.assertionId),
    );
    const expectedReceiptIds = canonicalIds(value.receipts.map((receipt) => receipt.receiptId));
    if (!sameStrings(value.featureIds, expectedFeatureIds)) {
      context.addIssue({
        code: 'custom',
        path: ['featureIds'],
        message: 'featureIds must be derived exactly from source-owned bindings',
      });
    }
    if (!sameStrings(value.assertionIds, expectedAssertionIds)) {
      context.addIssue({
        code: 'custom',
        path: ['assertionIds'],
        message: 'assertionIds must be derived exactly from source-owned bindings',
      });
    }
    if (!sameStrings(value.receiptIds, expectedReceiptIds)) {
      context.addIssue({
        code: 'custom',
        path: ['receiptIds'],
        message: 'receiptIds must be derived exactly from receipt links',
      });
    }
    const expectedReasons = blockedReasonsForRowV1(value);
    const expectedState = rowStateV1(value.applicability, expectedReasons);
    if (!sameStrings(value.blockedReasons, expectedReasons)) {
      context.addIssue({
        code: 'custom',
        path: ['blockedReasons'],
        message: 'sentinel journey blocked reasons must be exact and canonical',
      });
    }
    if (value.state !== expectedState) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'sentinel journey state must be derived from applicability and exact links',
      });
    }
  });

export type SentinelJourneyMapRowV1 = z.infer<typeof sentinelJourneyMapRowV1Schema>;

const sentinelJourneyCoverageV1Schema = z
  .object({
    fixedRowCount: z.literal(SENTINEL_JOURNEY_IDS_V1.length),
    observedJourneyIds: z.array(sentinelJourneyIdV1Schema),
  })
  .strict();

const sentinelJourneyMapMaterialV1Schema = z
  .object({
    schema: z.literal('SentinelJourneyMapV1'),
    version: z.literal(1),
    /** Exact source-owned catalog identity supplied by the caller. */
    matrixDigest: digestSchema,
    /** Exact behavioral suite identity supplied by the caller. */
    suiteDigest: digestSchema,
    rows: z.array(sentinelJourneyMapRowV1Schema),
    coverage: sentinelJourneyCoverageV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    assertFixedRowsV1(value.rows, context);
    const expectedObserved = value.rows
      .filter((row) => row.state === 'observed')
      .map((row) => row.journeyId);
    if (!sameStrings(value.coverage.observedJourneyIds, expectedObserved)) {
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'observedJourneyIds'],
        message: 'only fully observed required rows may contribute to sentinel coverage',
      });
    }
  });

export type SentinelJourneyMapMaterialV1 = z.infer<typeof sentinelJourneyMapMaterialV1Schema>;

export function computeSentinelJourneyMapDigestV1(
  material: SentinelJourneyMapMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.sentinel-journey-map.v1',
    canonicalJsonBytes(sentinelJourneyMapMaterialV1Schema.parse(material)),
  );
}

export const sentinelJourneyMapV1Schema = sentinelJourneyMapMaterialV1Schema
  .extend({ mapDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { mapDigest, ...material } = value;
    const expected = computeSentinelJourneyMapDigestV1(material);
    if (mapDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['mapDigest'],
        message: `sentinel journey map digest mismatch: expected ${expected}`,
      });
    }
  });

export type SentinelJourneyMapV1 = z.infer<typeof sentinelJourneyMapV1Schema>;

const sentinelJourneyMapBuildInputV1Schema = z
  .object({
    matrixDigest: digestSchema,
    suiteDigest: digestSchema,
    rows: z.array(sentinelJourneySourceOwnedRowInputV1Schema).max(SENTINEL_JOURNEY_IDS_V1.length),
  })
  .strict();

interface SentinelJourneyMapBuildInputV1 {
  matrixDigest: string;
  suiteDigest: string;
  rows: readonly SentinelJourneySourceOwnedRowInputV1[];
}

/**
 * Materialize every fixed sentinel row from already trusted source-owned
 * inputs. This is intentionally private: raw rows are a parser concern, not
 * an authority boundary. AQ-3 has no L1 journey receipts yet, so the public
 * builder below supplies no rows and keeps every required journey blocked.
 */
function materializeSentinelJourneyMapV1(
  input: SentinelJourneyMapBuildInputV1,
): SentinelJourneyMapV1 {
  const parsed = sentinelJourneyMapBuildInputV1Schema.parse(input);
  const rowsByJourneyId = new Map<SentinelJourneyIdV1, SentinelJourneySourceOwnedRowInputV1>();
  for (const row of parsed.rows) {
    if (rowsByJourneyId.has(row.journeyId)) {
      throw new Error(`duplicate_sentinel_journey_row:${row.journeyId}`);
    }
    rowsByJourneyId.set(row.journeyId, row);
  }

  const rows = SENTINEL_JOURNEY_IDS_V1.map((journeyId) => {
    const inputRow = rowsByJourneyId.get(journeyId);
    const sourceBindings = inputRow?.sourceBindings ?? [];
    const receipts = inputRow?.receipts ?? [];
    const entrypointProjectionAssertions = {
      cli: inputRow?.entrypointProjectionAssertions?.cli ?? [],
      tui: inputRow?.entrypointProjectionAssertions?.tui ?? [],
    };
    const applicability = materializeApplicabilityV1(inputRow?.applicability);
    const draft = {
      journeyId,
      sourceBindings,
      featureIds: canonicalIds(sourceBindings.map((binding) => binding.featureId)),
      assertionIds: canonicalIds(sourceBindings.map((binding) => binding.assertionId)),
      receipts,
      receiptIds: canonicalIds(receipts.map((receipt) => receipt.receiptId)),
      entrypointProjectionAssertions,
      applicability,
      state: 'blocked' as const,
      blockedReasons: [] as SentinelJourneyBlockedReasonV1[],
    };
    const blockedReasons = blockedReasonsForRowV1(draft);
    return {
      ...draft,
      state: rowStateV1(applicability, blockedReasons),
      blockedReasons,
    };
  });
  const material: SentinelJourneyMapMaterialV1 = {
    schema: 'SentinelJourneyMapV1',
    version: 1,
    matrixDigest: parsed.matrixDigest,
    suiteDigest: parsed.suiteDigest,
    rows,
    coverage: {
      fixedRowCount: SENTINEL_JOURNEY_IDS_V1.length,
      observedJourneyIds: rows
        .filter((row) => row.state === 'observed')
        .map((row) => row.journeyId),
    },
  };
  return sentinelJourneyMapV1Schema.parse({
    ...material,
    mapDigest: computeSentinelJourneyMapDigestV1(material),
  });
}

/**
 * Build the only currently trusted Sentinel map. Matrix and suite identities
 * are reconstructed from product-owned declarations, never accepted as raw
 * caller metadata. AQ-4--AQ-6 will extend this boundary with their own
 * verifier-checked receipts; until then every fixed journey is visibly
 * blocked rather than fabricating an observed row.
 */
export function buildSentinelJourneyMapV1(): SentinelJourneyMapV1 {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find((candidate) => candidate.suiteId === L0_CONTRACT_SUITE_ID_V1);
  if (!suite) throw new Error('sentinel_journey_l0_suite_missing');
  return materializeSentinelJourneyMapV1({
    matrixDigest: matrix.matrixDigest,
    suiteDigest: suite.suiteDigest,
    rows: [],
  });
}

/**
 * A persisted Sentinel map is accepted only if it exactly equals the map
 * reconstructed from current source-owned facts. This prevents a caller from
 * inventing source bindings, conditions, receipts, public projections, or a
 * different Matrix/suite digest and treating them as observed coverage.
 */
export function verifySourceOwnedSentinelJourneyMapV1(input: unknown): SentinelJourneyMapV1 {
  const expected = buildSentinelJourneyMapV1();
  const parsed = sentinelJourneyMapV1Schema.safeParse(input);
  if (!parsed.success || parsed.data.mapDigest !== expected.mapDigest) {
    throw new Error('sentinel_journey_map_source_identity_drift');
  }
  return expected;
}

function blockedReasonsForRowV1(row: SentinelJourneyMapRowV1): SentinelJourneyBlockedReasonV1[] {
  const reasons = new Set<SentinelJourneyBlockedReasonV1>();
  const applicabilityEntries = [
    row.applicability.journey,
    row.applicability.cli,
    row.applicability.tui,
  ];
  if (applicabilityEntries.some((entry) => entry.state === 'blocked')) {
    reasons.add(
      applicabilityEntries.some((entry) => entry.requiredWhen && entry.notApplicableRationale)
        ? 'applicability_conflict'
        : 'applicability_missing',
    );
  }
  if (row.sourceBindings.length === 0) {
    reasons.add('source_binding_missing');
    return canonicalBlockedReasonsV1(reasons);
  }
  if (
    hasDuplicateSourceBindingsV1(row.sourceBindings) ||
    hasDuplicateReceiptLinksV1(row.receipts)
  ) {
    reasons.add('link_identity_mismatch');
  }

  if (row.applicability.journey.state === 'required') {
    validateBehavioralReceiptsV1(row, reasons);
  }
  if (row.applicability.cli.state === 'required') {
    validateProjectionSetV1('cli', row, reasons);
  }
  if (row.applicability.tui.state === 'required') {
    validateProjectionSetV1('tui', row, reasons);
  }
  return canonicalBlockedReasonsV1(reasons);
}

function validateBehavioralReceiptsV1(
  row: SentinelJourneyMapRowV1,
  reasons: Set<SentinelJourneyBlockedReasonV1>,
): void {
  if (row.receipts.length === 0) {
    reasons.add('receipt_missing');
    return;
  }
  for (const sourceBinding of row.sourceBindings) {
    const matchingReceipts = row.receipts.filter((receipt) =>
      sameSourceBindingV1(sourceBinding, receipt),
    );
    if (matchingReceipts.length === 0) reasons.add('receipt_missing');
    if (matchingReceipts.some((receipt) => receipt.observation !== 'observed')) {
      reasons.add('receipt_unobserved');
    }
  }
  if (
    row.receipts.some(
      (receipt) =>
        !row.sourceBindings.some((sourceBinding) => sameSourceBindingV1(sourceBinding, receipt)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function validateProjectionSetV1(
  entrypoint: 'cli' | 'tui',
  row: SentinelJourneyMapRowV1,
  reasons: Set<SentinelJourneyBlockedReasonV1>,
): void {
  const projections = row.entrypointProjectionAssertions[entrypoint];
  if (projections.length === 0) {
    reasons.add(entrypoint === 'cli' ? 'cli_projection_missing' : 'tui_projection_missing');
    return;
  }
  if (hasDuplicateProjectionLinksV1(projections)) reasons.add('link_identity_mismatch');
  for (const receipt of row.receipts) {
    const matching = projections.filter((projection) => sameReceiptLinkV1(receipt, projection));
    if (matching.length === 0) {
      reasons.add(entrypoint === 'cli' ? 'cli_projection_missing' : 'tui_projection_missing');
      continue;
    }
    if (matching.some((projection) => projection.observation !== 'observed')) {
      reasons.add(entrypoint === 'cli' ? 'cli_projection_unobserved' : 'tui_projection_unobserved');
    }
    if (
      matching.some(
        (projection) =>
          projection.entrypoint !== entrypoint ||
          projection.projectionAssertionId === receipt.assertionId ||
          projection.projectionReceiptId === receipt.receiptId,
      )
    ) {
      reasons.add('projection_not_independent');
    }
  }
  if (
    projections.some(
      (projection) => !row.receipts.some((receipt) => sameReceiptLinkV1(receipt, projection)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function materializeApplicabilityV1(
  input: SentinelJourneyApplicabilityInputV1 | undefined,
): SentinelJourneyApplicabilityV1 {
  return sentinelJourneyApplicabilityV1Schema.parse({
    journey: materializeApplicabilityEntryV1(input?.journey),
    cli: materializeApplicabilityEntryV1(input?.cli),
    tui: materializeApplicabilityEntryV1(input?.tui),
  });
}

function materializeApplicabilityEntryV1(
  input: SentinelJourneyApplicabilityInputEntryV1 | undefined,
): SentinelJourneyApplicabilityEntryV1 {
  const requiredWhen = input?.requiredWhen ?? null;
  const notApplicableRationale = input?.notApplicableRationale ?? null;
  return sentinelJourneyApplicabilityEntryV1Schema.parse({
    requiredWhen,
    notApplicableRationale,
    state: applicabilityStateV1(requiredWhen, notApplicableRationale),
  });
}

function applicabilityStateV1(
  requiredWhen: SentinelJourneyRequiredWhenV1 | null,
  notApplicableRationale: SentinelJourneyNotApplicableRationaleV1 | null,
): SentinelJourneyApplicabilityEntryV1['state'] {
  if (requiredWhen && !notApplicableRationale) return 'required';
  if (!requiredWhen && notApplicableRationale) return 'not_applicable';
  return 'blocked';
}

function rowStateV1(
  applicability: SentinelJourneyApplicabilityV1,
  blockedReasons: readonly SentinelJourneyBlockedReasonV1[],
): SentinelJourneyMapRowV1['state'] {
  if (blockedReasons.length > 0) return 'blocked';
  return applicability.journey.state === 'not_applicable' ? 'not_applicable' : 'observed';
}

function sameSourceBindingV1(
  source: SentinelJourneySourceBindingV1,
  linked: SentinelJourneyReceiptLinkV1,
): boolean {
  return (
    source.sourceSurfaceId === linked.sourceSurfaceId &&
    source.featureId === linked.featureId &&
    source.assertionId === linked.assertionId
  );
}

function sameReceiptLinkV1(
  receipt: SentinelJourneyReceiptLinkV1,
  projection: SentinelJourneyProjectionLinkV1,
): boolean {
  return (
    receipt.sourceSurfaceId === projection.sourceSurfaceId &&
    receipt.featureId === projection.featureId &&
    receipt.assertionId === projection.assertionId &&
    receipt.receiptId === projection.receiptId &&
    receipt.receiptDigest === projection.receiptDigest
  );
}

function hasDuplicateSourceBindingsV1(
  bindings: readonly SentinelJourneySourceBindingV1[],
): boolean {
  return hasDuplicateKeys(
    bindings.map(
      (binding) =>
        `${binding.sourceSurfaceId}\u0000${binding.featureId}\u0000${binding.assertionId}`,
    ),
  );
}

function hasDuplicateReceiptLinksV1(receipts: readonly SentinelJourneyReceiptLinkV1[]): boolean {
  return hasDuplicateKeys(receipts.map((receipt) => receipt.receiptId));
}

function hasDuplicateProjectionLinksV1(
  projections: readonly SentinelJourneyProjectionLinkV1[],
): boolean {
  return hasDuplicateKeys(
    projections.map(
      (projection) =>
        `${projection.entrypoint}\u0000${projection.projectionAssertionId}\u0000${projection.projectionReceiptId}`,
    ),
  );
}

function hasDuplicateKeys(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoint);
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalBlockedReasonsV1(
  reasons: ReadonlySet<SentinelJourneyBlockedReasonV1>,
): SentinelJourneyBlockedReasonV1[] {
  return SENTINEL_JOURNEY_BLOCKED_REASONS_V1.filter((reason) => reasons.has(reason));
}

function assertFixedRowsV1(
  rows: readonly SentinelJourneyMapRowV1[],
  context: z.RefinementCtx,
): void {
  if (rows.length !== SENTINEL_JOURNEY_IDS_V1.length) {
    context.addIssue({
      code: 'custom',
      path: ['rows'],
      message: `sentinel journey map must contain exactly ${SENTINEL_JOURNEY_IDS_V1.length} fixed rows`,
    });
    return;
  }
  if (
    !sameStrings(
      rows.map((row) => row.journeyId),
      SENTINEL_JOURNEY_IDS_V1,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['rows'],
      message: 'sentinel journey rows must use every fixed journey ID exactly once and in order',
    });
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
