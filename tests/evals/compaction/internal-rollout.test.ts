import { describe, expect, test } from 'bun:test';
import {
  buildCompactionGateLedgerV1,
  buildCompactionGateReceiptV1,
  buildInternalCompactionRolloutEvidenceV1,
  type CompactionGateReceiptV1,
  verifyInternalCompactionRolloutEvidenceV1,
} from './internal-rollout';

const D = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const HEAD = 'a'.repeat(40);
const REF = 'refs/heads/main';

function identity() {
  return {
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
}

function source() {
  const workflowPath = '.github/workflows/compaction-internal-rollout.yml';
  return {
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
    jobName: 'internal-compaction-rollout',
    artifactId: '456',
    artifactName: 'internal-compaction-rollout-123-1',
    artifactDigest: D('1'),
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T04:00:00.000Z',
    authentication: {
      kind: 'unconfigured',
      reason: 'production_compaction_rollout_authority_not_configured',
    },
  } as const;
}

function gateLedger() {
  const inputs = [
    ['G3', 'continuation_non_inferiority'],
    ['G3', 'false_trigger_bound'],
    ['G4', 'resource_bound'],
    ['G4', 'rollback_rehearsal'],
  ] as const;
  let previousReceiptDigest: string | null = null;
  const receipts: CompactionGateReceiptV1[] = inputs.map(([gate, check], index) => {
    const receipt = buildCompactionGateReceiptV1({
      schema: 'CompactionGateReceiptV1',
      sequence: index + 1,
      gate,
      check,
      outcome: 'passed',
      sampleCount: 8,
      observedAt: `2026-08-02T0${index}:00:00.000Z`,
      observationDigest: D(String(index + 1)),
      previousReceiptDigest,
    });
    previousReceiptDigest = receipt.receiptDigest;
    return receipt;
  });
  return buildCompactionGateLedgerV1(receipts);
}

function evidence(shadowEffects = { summaryDispatchCount: 0, checkpointWriteCount: 0 }) {
  return buildInternalCompactionRolloutEvidenceV1({
    schema: 'InternalCompactionRolloutEvidenceV1',
    identity: identity(),
    source: source(),
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T04:00:00.000Z',
    stages: [
      {
        stage: 'internal_manual',
        decisionId: 'internal-manual-decision-001',
        windowId: 'internal-manual-window-001',
        startedAt: '2026-08-02T00:00:00.000Z',
        endedAt: '2026-08-02T01:00:00.000Z',
        outcome: 'passed',
        sampleCount: 8,
        summaryDispatchCount: 8,
        checkpointWriteCount: 8,
        observationDigest: D('a'),
      },
      {
        stage: 'internal_auto_shadow',
        decisionId: 'internal-shadow-decision-001',
        windowId: 'internal-shadow-window-001',
        startedAt: '2026-08-02T01:00:00.000Z',
        endedAt: '2026-08-02T02:00:00.000Z',
        outcome: 'passed',
        sampleCount: 8,
        ...shadowEffects,
        observationDigest: D('b'),
      },
      {
        stage: 'internal_auto_live',
        decisionId: 'internal-live-decision-001',
        windowId: 'internal-live-window-001',
        startedAt: '2026-08-02T02:00:00.000Z',
        endedAt: '2026-08-02T04:00:00.000Z',
        outcome: 'passed',
        sampleCount: 8,
        summaryDispatchCount: 8,
        checkpointWriteCount: 8,
        observationDigest: D('c'),
      },
    ],
    gateLedger: gateLedger(),
  });
}

describe('production-owned internal compaction rollout evidence', () => {
  test('rebuilds identity, freshness, stage order, and G3/G4 ledger but remains blocked', () => {
    const retained = evidence();
    const verification = verifyInternalCompactionRolloutEvidenceV1({
      evidence: retained,
      expected: { identity: identity(), source: source() },
      verifiedAt: '2026-08-02T05:00:00.000Z',
      maximumAgeSeconds: 7_200,
    });
    expect(verification).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      authenticatedAuthorityConfigured: false,
      effectiveStage: 'off',
      milestone: null,
      reasonCodes: ['authenticated_internal_rollout_authority_not_configured'],
    });
  });

  test('binds artifact, route, prompt, policy, evaluator, and source identity externally', () => {
    const retained = evidence();
    for (const [field, value] of [
      ['routeDigest', D('d')],
      ['promptDigest', D('e')],
      ['policyDigest', D('f')],
      ['evaluatorDigest', D('0')],
      ['operationsReadinessDecisionDigest', D('d')],
      ['routeQualificationDecisionDigest', D('e')],
      ['liveProviderMatrixDecisionDigest', D('f')],
    ] as const) {
      expect(() =>
        verifyInternalCompactionRolloutEvidenceV1({
          evidence: retained,
          expected: { identity: { ...identity(), [field]: value }, source: source() },
          verifiedAt: '2026-08-02T05:00:00.000Z',
          maximumAgeSeconds: 7_200,
        }),
      ).toThrow('identity_mismatch');
    }
    expect(() =>
      verifyInternalCompactionRolloutEvidenceV1({
        evidence: retained,
        expected: { identity: identity(), source: { ...source(), runId: '999' } },
        verifiedAt: '2026-08-02T05:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow('identity_mismatch');
  });

  test('records stale evidence and shadow effects without granting rollout', () => {
    const verification = verifyInternalCompactionRolloutEvidenceV1({
      evidence: evidence({ summaryDispatchCount: 1, checkpointWriteCount: 1 }),
      expected: { identity: identity(), source: source() },
      verifiedAt: '2026-08-03T05:00:00.000Z',
      maximumAgeSeconds: 60,
    });
    expect(verification.reasonCodes).toEqual(
      expect.arrayContaining([
        'evidence_stale_or_future',
        'internal_shadow_checkpoint_write_observed',
        'internal_shadow_summary_dispatch_observed',
      ]),
    );
    expect(verification.effectiveStage).toBe('off');
    expect(verification.evidenceEligible).toBeFalse();
  });

  test('rejects a mutated retained Gate ledger', () => {
    const retained = evidence();
    retained.gateLedger.receipts[0]!.sampleCount = 999;
    expect(() =>
      verifyInternalCompactionRolloutEvidenceV1({
        evidence: retained,
        expected: { identity: identity(), source: source() },
        verifiedAt: '2026-08-02T05:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow();
  });

  test('rejects stage identity reuse, reordered windows, and restamped Gate receipts', () => {
    const duplicateWindow = evidence();
    duplicateWindow.stages[1].windowId = duplicateWindow.stages[0].windowId;
    expect(() =>
      verifyInternalCompactionRolloutEvidenceV1({
        evidence: duplicateWindow,
        expected: { identity: identity(), source: source() },
        verifiedAt: '2026-08-02T05:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow();

    const outsideWindow = evidence();
    outsideWindow.gateLedger.receipts[0]!.observedAt = '2026-08-01T23:59:59.000Z';
    expect(() =>
      verifyInternalCompactionRolloutEvidenceV1({
        evidence: outsideWindow,
        expected: { identity: identity(), source: source() },
        verifiedAt: '2026-08-02T05:00:00.000Z',
        maximumAgeSeconds: 7_200,
      }),
    ).toThrow();
  });
});
