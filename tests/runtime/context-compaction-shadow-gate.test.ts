import { describe, expect, test } from 'bun:test';
import {
  buildCompactionGateLedgerV1,
  buildCompactionGateReceiptV1,
  buildExternalCompactionShadowEvidenceV1,
  type CompactionGateReceiptV1,
  evaluateExternalCompactionShadowGateV1,
} from '../../scripts/evals/contracts/compaction-rollout-evidence';

const D = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const HEAD = 'a'.repeat(40);
const REF = 'refs/heads/main';
const workflowPath = '.github/workflows/compaction-external-shadow.yml';

const identity = {
  artifactIdentity: {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    commit: HEAD,
    payloadSha256: D('1'),
    canonicalManifestDigest: D('2'),
    behaviorDigest: D('3'),
    profileDigest: D('4'),
    gatePolicyDigest: D('5'),
  },
  routeDigest: D('6'),
  promptDigest: D('7'),
  policyDigest: D('8'),
  evaluatorDigest: D('9'),
  operationsReadinessDecisionDigest: D('a'),
  routeQualificationDecisionDigest: D('b'),
  liveProviderMatrixDecisionDigest: D('c'),
} as const;

const source = {
  sourceKind: 'github_actions_unsigned_contract',
  repository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  headSha: HEAD,
  ref: REF,
  workflowPath,
  workflowRef: `ferqx/kite-code/${workflowPath}@${REF}`,
  workflowSha: 'b'.repeat(40),
  runId: '123',
  runAttempt: 1,
  jobName: 'external-compaction-shadow',
  artifactId: '456',
  artifactName: 'external-compaction-shadow-123-1',
  artifactDigest: D('1'),
  startedAt: '2026-08-02T00:00:00.000Z',
  endedAt: '2026-08-02T02:00:00.000Z',
  authentication: {
    kind: 'unconfigured',
    reason: 'production_compaction_rollout_authority_not_configured',
  },
} as const;

function shadowGateLedger() {
  let previousReceiptDigest: string | null = null;
  const receipts: CompactionGateReceiptV1[] = (
    [
      ['G3', 'false_trigger_bound'],
      ['G4', 'resource_bound'],
    ] as const
  ).map(([gate, check], index) => {
    const receipt = buildCompactionGateReceiptV1({
      schema: 'CompactionGateReceiptV1',
      sequence: index + 1,
      gate,
      check,
      outcome: 'passed',
      sampleCount: 64,
      observedAt: `2026-08-02T0${index}:00:00.000Z`,
      observationDigest: D(String(index + 1)),
      previousReceiptDigest,
    });
    previousReceiptDigest = receipt.receiptDigest;
    return receipt;
  });
  return buildCompactionGateLedgerV1(receipts);
}

function shadowEvidence(
  overrides: {
    consent?: boolean;
    summaryDispatchCount?: number;
    checkpointWriteCount?: number;
    falseTriggerCount?: number;
    resourceSampleCount?: number;
    observedMaximumCpuMillis?: number;
    observedMaximumMemoryBytes?: number;
  } = {},
) {
  return buildExternalCompactionShadowEvidenceV1({
    schema: 'ExternalCompactionShadowEvidenceV1',
    identity,
    source,
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T02:00:00.000Z',
    consent: {
      schema: 'ExternalCompactionShadowConsentV1',
      consentId: 'external-shadow-consent-001',
      policyRevision: 'external-shadow-consent-v1',
      cohortDigest: D('d'),
      required: true,
      granted: overrides.consent ?? true,
      grantedAt: '2026-08-01T23:00:00.000Z',
      receiptDigest: D('e'),
      authentication: {
        kind: 'unconfigured',
        reason: 'external_shadow_consent_authority_not_configured',
      },
    },
    observations: {
      eligibilityEvaluationCount: 64,
      summaryDispatchCount: overrides.summaryDispatchCount ?? 0,
      checkpointWriteCount: overrides.checkpointWriteCount ?? 0,
      falseTriggerCount: overrides.falseTriggerCount ?? 0,
      maximumFalseTriggerCount: 1,
      resourceSampleCount: overrides.resourceSampleCount ?? 64,
      maximumCpuMillis: 100,
      observedMaximumCpuMillis: overrides.observedMaximumCpuMillis ?? 50,
      maximumMemoryBytes: 1_048_576,
      observedMaximumMemoryBytes: overrides.observedMaximumMemoryBytes ?? 524_288,
    },
    gateLedger: shadowGateLedger(),
  });
}

describe('external compaction shadow Gate', () => {
  test('enforces zero effects and remains blocked without authenticated authority', () => {
    const gate = evaluateExternalCompactionShadowGateV1({
      evidence: shadowEvidence(),
      expected: { identity, source },
      verifiedAt: '2026-08-02T03:00:00.000Z',
      maximumAgeSeconds: 7_200,
    });
    expect(gate).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      authenticatedAuthorityConfigured: false,
      permittedSummaryDispatches: 0,
      permittedCheckpointWrites: 0,
      observedSummaryDispatches: 0,
      observedCheckpointWrites: 0,
      profileDiff: { capability: 'auto_compaction', maxRollout: 'off', cohortMaximum: 0 },
      reasonCodes: [
        'authenticated_external_shadow_authority_not_configured',
        'external_shadow_consent_authority_not_configured',
      ],
    });
  });

  test('rejects shadow model/checkpoint effects through fail-closed reasons', () => {
    const gate = evaluateExternalCompactionShadowGateV1({
      evidence: shadowEvidence({ summaryDispatchCount: 1, checkpointWriteCount: 1 }),
      expected: { identity, source },
      verifiedAt: '2026-08-02T03:00:00.000Z',
      maximumAgeSeconds: 7_200,
    });
    expect(gate.reasonCodes).toEqual(
      expect.arrayContaining([
        'shadow_summary_dispatch_observed',
        'shadow_checkpoint_write_observed',
      ]),
    );
    expect(gate.observedSummaryDispatches).toBe(1);
    expect(gate.observedCheckpointWrites).toBe(1);
    expect(gate.profileDiff.maxRollout).toBe('off');
  });

  test('blocks missing consent, false triggers, resource excess, and stale evidence', () => {
    const gate = evaluateExternalCompactionShadowGateV1({
      evidence: shadowEvidence({
        consent: false,
        falseTriggerCount: 2,
        resourceSampleCount: 0,
        observedMaximumCpuMillis: 101,
        observedMaximumMemoryBytes: 1_048_577,
      }),
      expected: { identity, source },
      verifiedAt: '2026-08-04T03:00:00.000Z',
      maximumAgeSeconds: 60,
    });
    expect(gate.reasonCodes).toEqual(
      expect.arrayContaining([
        'evidence_stale_or_future',
        'external_shadow_consent_missing',
        'false_trigger_bound_exceeded',
        'resource_bound_not_satisfied',
      ]),
    );
    expect(gate.evidenceEligible).toBeFalse();
  });

  test('binds external expected prompt and source identities', () => {
    const retained = shadowEvidence();
    expect(() =>
      evaluateExternalCompactionShadowGateV1({
        evidence: retained,
        expected: { identity: { ...identity, promptDigest: D('f') }, source },
        verifiedAt: '2026-08-02T03:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow('identity_mismatch');
    expect(() =>
      evaluateExternalCompactionShadowGateV1({
        evidence: retained,
        expected: { identity, source: { ...source, artifactId: '999' } },
        verifiedAt: '2026-08-02T03:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow('identity_mismatch');
  });
});
