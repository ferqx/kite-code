import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RELEASE_CAPABILITIES } from '@/core/config/release-capabilities';
import {
  evaluateGaSelectionGateV1,
  validateGaSelectionV1,
} from '../../scripts/release/ga-selection';

const digest = `sha256:${'a'.repeat(64)}` as const;

describe('GA capability selection contract', () => {
  test('keeps the repository selection empty, explicit, and blocked', () => {
    const selection = JSON.parse(
      readFileSync(resolve('release/ga-selection-v1.json'), 'utf8'),
    ) as unknown;
    const validation = validateGaSelectionV1(selection, []);
    expect(validation.selection.selectedCapabilities).toEqual([]);
    expect(validation.selection.forcedOffCapabilities).toEqual([...RELEASE_CAPABILITIES].sort());
    const gate = evaluateGaSelectionGateV1({
      validation,
      dependencies: {
        msLimitedApproved: false,
        msLimitedSlo: false,
        ms2aRc: false,
        ms3OpsReady: false,
        d03Closed: false,
        d05Closed: false,
        d10Closed: false,
        thirdPartySecurityReview: false,
        productionSupportSetNonEmpty: false,
      },
    });
    expect(gate.status).toBe('blocked');
    expect(gate.gaEligible).toBeFalse();
    expect(gate.reasonCodes).toEqual([
      'ms_2a_rc_missing',
      'ms_3_ops_ready_missing',
      'ms_limited_approved_missing',
      'ms_limited_slo_missing',
      'no_stable_capability_selected',
      'production_support_set_empty',
      'selection_approval_missing',
      'third_party_security_review_missing',
    ]);
  });

  test('requires an exact fresh stable decision and total capability partition', () => {
    const selected = {
      version: 1,
      selectionId: 'fixture-selection',
      selectedCapabilities: [
        {
          capability: 'verification',
          stableMilestone: 'MS:5A-STABLE',
          decisionDigest: digest,
        },
      ],
      forcedOffCapabilities: RELEASE_CAPABILITIES.filter(
        (capability) => capability !== 'verification',
      ),
      approvedBy: ['fixture:release-owner'],
    } as const;
    expect(() => validateGaSelectionV1(selected, [])).toThrow('fresh stable decision');
    expect(
      validateGaSelectionV1(selected, [
        {
          capability: 'verification',
          stableMilestone: 'MS:5A-STABLE',
          decisionDigest: digest,
          status: 'stable',
          fresh: true,
        },
      ]).selection.selectedCapabilities,
    ).toHaveLength(1);
    expect(() =>
      validateGaSelectionV1(
        { ...selected, forcedOffCapabilities: selected.forcedOffCapabilities.slice(1) },
        [
          {
            capability: 'verification',
            stableMilestone: 'MS:5A-STABLE',
            decisionDigest: digest,
            status: 'stable',
            fresh: true,
          },
        ],
      ),
    ).toThrow('explicitly select or force off');
  });

  test('rejects duplicate, overlapping, unknown, and schema-injected selections', () => {
    const base = JSON.parse(
      readFileSync(resolve('release/ga-selection-v1.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(() =>
      validateGaSelectionV1(
        {
          ...base,
          forcedOffCapabilities: ['shell', 'shell'],
        },
        [],
      ),
    ).toThrow();
    expect(() => validateGaSelectionV1({ ...base, hiddenGrant: true }, [])).toThrow();
    expect(() =>
      validateGaSelectionV1({ ...base, forcedOffCapabilities: ['unknown_capability'] }, []),
    ).toThrow();
  });
});
