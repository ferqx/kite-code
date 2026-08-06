import { describe, expect, test } from 'bun:test';
import * as sentinelJourneyMapV2 from '../../../release/qualification/sentinel-journey-map-v2';
import {
  sentinelJourneyBehavioralReceiptLinkV2Schema,
  sentinelJourneyProjectionReceiptLinkV2Schema,
  sentinelJourneySourceBindingV2Schema,
} from '../../../release/qualification/sentinel-journey-map-v2';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;

const FIXTURE_SOURCE_BINDING = {
  sourceSurfaceId: 'fixture-only:sentinel-v2-source',
  featureId: 'FIXTURE-SENTINEL_V2-001',
  assertionId: 'fixture-only:sentinel-v2-assertion',
  sourceBindingDigest: DIGEST_A,
};
const FIXTURE_PROJECTION_SOURCE_BINDING = {
  sourceSurfaceId: 'fixture-only:sentinel-v2-cli-projection',
  featureId: 'FIXTURE-CLI_PROJECTION-001',
  assertionId: 'fixture-only:cli-projection-assertion',
  sourceBindingDigest: DIGEST_D,
};

function unobservedBehavioralReceipt() {
  return {
    ...FIXTURE_SOURCE_BINDING,
    receiptId: 'fixture-only:behavioral-receipt',
    receiptDigest: DIGEST_B,
    suiteId: 'fixture-only:behavioral-suite',
    suiteDigest: DIGEST_C,
    observation: 'unobserved' as const,
  };
}

describe('SentinelJourneyMapV2', () => {
  test('does not expose a generic callback or raw-snapshot API that could self-authorize observed rows', () => {
    expect(sentinelJourneyMapV2).not.toHaveProperty('buildSentinelJourneyMapV2');
    expect(sentinelJourneyMapV2).not.toHaveProperty('verifyReconstructedSentinelJourneyMapV2');
    expect(sentinelJourneyMapV2).not.toHaveProperty('buildBlockedSentinelJourneyMapV2');
    expect(sentinelJourneyMapV2).not.toHaveProperty('materializeSentinelJourneyMapV2');
  });

  test('requires safe suite provenance and independent projection identities on every receipt link', () => {
    const behavioral = unobservedBehavioralReceipt();
    const { suiteId: _suiteId, ...withoutSuiteId } = behavioral;
    expect(sentinelJourneyBehavioralReceiptLinkV2Schema.safeParse(withoutSuiteId).success).toBe(
      false,
    );

    const projection = {
      ...FIXTURE_SOURCE_BINDING,
      entrypoint: 'cli' as const,
      behavioralReceiptId: behavioral.receiptId,
      behavioralReceiptDigest: behavioral.receiptDigest,
      behavioralSuiteId: behavioral.suiteId,
      behavioralSuiteDigest: behavioral.suiteDigest,
      projectionSourceBinding: FIXTURE_PROJECTION_SOURCE_BINDING,
      projectionAssertionId: 'fixture-only:projection-assertion',
      projectionReceiptId: 'fixture-only:projection-receipt',
      projectionReceiptDigest: DIGEST_D,
      suiteId: 'fixture-only:projection-suite',
      suiteDigest: DIGEST_D,
      observation: 'unobserved' as const,
    };
    const validProjection = {
      ...projection,
      projectionSourceBinding: {
        ...FIXTURE_PROJECTION_SOURCE_BINDING,
        assertionId: projection.projectionAssertionId,
      },
    };
    expect(sentinelJourneyProjectionReceiptLinkV2Schema.safeParse(validProjection).success).toBe(
      true,
    );
    expect(
      sentinelJourneyProjectionReceiptLinkV2Schema.safeParse({
        ...validProjection,
        suiteId: behavioral.suiteId,
        suiteDigest: behavioral.suiteDigest,
      }).success,
    ).toBe(false);
    expect(
      sentinelJourneySourceBindingV2Schema.safeParse({
        ...FIXTURE_SOURCE_BINDING,
        sourceSurfaceId: 'https:/unsafe-normalized-endpoint',
      }).success,
    ).toBe(false);
  });
});
