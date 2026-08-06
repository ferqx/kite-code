import { describe, expect, test } from 'bun:test';
import {
  buildSentinelJourneyMapV1,
  computeSentinelJourneyMapDigestV1,
  SENTINEL_JOURNEY_IDS_V1,
  sentinelJourneyMapV1Schema,
  verifySourceOwnedSentinelJourneyMapV1,
} from '../../../release/qualification/sentinel-journey-map-v1';
import { createSourceOwnedQualificationCatalogV1 } from '../../../release/qualification/source-owned-surface-v1';
import { generateAgentFeatureQualificationMatrixV1 } from '../../../scripts/evals/contracts/qualification/feature-matrix';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;

function requiredApplicability(scope: string) {
  return {
    requiredWhen: { conditionId: `condition:${scope}`, conditionDigest: DIGEST_A },
    notApplicableRationale: null,
    state: 'required' as const,
  };
}

function fabricatedObservedRow(journeyId: (typeof SENTINEL_JOURNEY_IDS_V1)[number]) {
  const sourceBinding = {
    sourceSurfaceId: `fabricated-source:${journeyId}`,
    featureId: 'AUTHORIZATION-APPROVAL-001',
    assertionId: `fabricated-assertion:${journeyId}`,
  };
  const receipt = {
    ...sourceBinding,
    receiptId: `fabricated-receipt:${journeyId}`,
    receiptDigest: DIGEST_B,
    observation: 'observed' as const,
  };
  const projection = (entrypoint: 'cli' | 'tui') => ({
    ...receipt,
    entrypoint,
    projectionAssertionId: `fabricated-projection-assertion:${entrypoint}:${journeyId}`,
    projectionReceiptId: `fabricated-projection-receipt:${entrypoint}:${journeyId}`,
    projectionReceiptDigest: DIGEST_C,
    observation: 'observed' as const,
  });
  return {
    journeyId,
    sourceBindings: [sourceBinding],
    featureIds: [sourceBinding.featureId],
    assertionIds: [sourceBinding.assertionId],
    receipts: [receipt],
    receiptIds: [receipt.receiptId],
    entrypointProjectionAssertions: { cli: [projection('cli')], tui: [projection('tui')] },
    applicability: {
      journey: requiredApplicability(`journey:${journeyId}`),
      cli: requiredApplicability(`cli:${journeyId}`),
      tui: requiredApplicability(`tui:${journeyId}`),
    },
    state: 'observed' as const,
    blockedReasons: [],
  };
}

function withDigest(material: Record<string, unknown>) {
  const { mapDigest: _ignored, ...withoutDigest } = material;
  return sentinelJourneyMapV1Schema.parse({
    ...withoutDigest,
    mapDigest: computeSentinelJourneyMapDigestV1(withoutDigest as never),
  });
}

function fabricatedObservedMap() {
  const catalog = createSourceOwnedQualificationCatalogV1();
  const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
  const suite = catalog.suites.find(
    (candidate) => candidate.suiteId === 'qualification-l0-contract-v1',
  );
  if (!suite) throw new Error('test_l0_suite_missing');
  return withDigest({
    schema: 'SentinelJourneyMapV1',
    version: 1,
    matrixDigest: matrix.matrixDigest,
    suiteDigest: suite.suiteDigest,
    rows: SENTINEL_JOURNEY_IDS_V1.map(fabricatedObservedRow),
    coverage: {
      fixedRowCount: SENTINEL_JOURNEY_IDS_V1.length,
      observedJourneyIds: [...SENTINEL_JOURNEY_IDS_V1],
    },
  });
}

describe('SentinelJourneyMapV1', () => {
  test('reconstructs ten fixed source-owned slots and keeps unimplemented L1 journeys blocked', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateAgentFeatureQualificationMatrixV1(catalog);
    const suite = catalog.suites.find(
      (candidate) => candidate.suiteId === 'qualification-l0-contract-v1',
    );
    if (!suite) throw new Error('test_l0_suite_missing');

    const map = buildSentinelJourneyMapV1();
    expect(map.matrixDigest).toBe(matrix.matrixDigest);
    expect(map.suiteDigest).toBe(suite.suiteDigest);
    expect(map.rows.map((row) => row.journeyId)).toEqual([...SENTINEL_JOURNEY_IDS_V1]);
    expect(map.rows.every((row) => row.state === 'blocked')).toBe(true);
    expect(map.rows.every((row) => row.sourceBindings.length === 0)).toBe(true);
    expect(map.rows.every((row) => row.receiptIds.length === 0)).toBe(true);
    expect(map.rows.every((row) => row.applicability.journey.state === 'blocked')).toBe(true);
    expect(map.coverage).toEqual({ fixedRowCount: 10, observedJourneyIds: [] });
    expect(map.mapDigest).toBe(
      computeSentinelJourneyMapDigestV1({
        schema: map.schema,
        version: map.version,
        matrixDigest: map.matrixDigest,
        suiteDigest: map.suiteDigest,
        rows: map.rows,
        coverage: map.coverage,
      }),
    );
  });

  test('accepts only the exact source-owned reconstruction, never fabricated bindings or receipts', () => {
    const expected = buildSentinelJourneyMapV1();
    expect(verifySourceOwnedSentinelJourneyMapV1(expected)).toEqual(expected);

    const fabricated = fabricatedObservedMap();
    // A structurally valid, self-digested map is still untrusted without the
    // source-owned reconstruction. It invents every source/condition/receipt
    // and public projection while claiming ten observed journeys.
    expect(() => verifySourceOwnedSentinelJourneyMapV1(fabricated)).toThrow(
      'sentinel_journey_map_source_identity_drift',
    );
  });

  test('fails closed on forged matrix, suite, receipt, and unsafe identifier metadata', () => {
    const fabricated = fabricatedObservedMap();
    for (const drift of [
      withDigest({ ...fabricated, matrixDigest: DIGEST_D }),
      withDigest({ ...fabricated, suiteDigest: DIGEST_D }),
      withDigest({
        ...fabricated,
        rows: fabricated.rows.map((row, index) =>
          index === 0
            ? {
                ...row,
                receipts: [{ ...row.receipts[0]!, receiptDigest: DIGEST_D }],
                entrypointProjectionAssertions: {
                  cli: [{ ...row.entrypointProjectionAssertions.cli[0]!, receiptDigest: DIGEST_D }],
                  tui: [{ ...row.entrypointProjectionAssertions.tui[0]!, receiptDigest: DIGEST_D }],
                },
              }
            : row,
        ),
      }),
    ]) {
      expect(() => verifySourceOwnedSentinelJourneyMapV1(drift)).toThrow(
        'sentinel_journey_map_source_identity_drift',
      );
    }

    for (const unsafeIdentifier of [
      'https://provider.invalid/full-endpoint',
      'https:/provider.invalid/normalized-uri',
      'file:/private/tmp/secret',
      'http:provider.invalid',
      'C:/Users/qualification',
    ]) {
      const unsafe = structuredClone(fabricated);
      unsafe.rows[0]!.sourceBindings[0]!.sourceSurfaceId = unsafeIdentifier;
      expect(() => sentinelJourneyMapV1Schema.parse(unsafe)).toThrow('sentinel identifier');
    }
  });

  test('rejects a persisted map that drops a fixed row even with a recomputed digest', () => {
    const expected = buildSentinelJourneyMapV1();
    const withoutFixedRow = { ...expected, rows: expected.rows.slice(0, -1) };
    expect(() => withDigest(withoutFixedRow)).toThrow('exactly 10');
  });
});
