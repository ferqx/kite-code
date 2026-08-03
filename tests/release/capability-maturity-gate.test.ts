import { describe, expect, test } from 'bun:test';
import {
  type CapabilityMaturityEvidenceMaterialV1,
  type CapabilityMaturityEvidenceV1,
  type CapabilityMaturityIdentityV1,
  type CapabilityMaturityStageV1,
  computeCapabilityMaturityEvidenceDigestV1,
  evaluateCapabilityMaturityGateV1,
  verifyCapabilityMaturityEvidenceV1,
} from '../../scripts/release/capability-maturity-gate';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const identity: CapabilityMaturityIdentityV1 = {
  payloadDigest: digest('1'),
  profileDigest: digest('2'),
  routeDigest: digest('3'),
  platformIdentity: 'ubuntu-24.04-x64',
  capability: 'verification',
  capabilityContractDigest: digest('4'),
  evaluatorIdentity: {
    evaluatorId: 'kite-capability-evaluator-v1',
    evaluatorDigest: digest('5'),
    suiteDigest: digest('6'),
  },
};

function material(
  targetStage: CapabilityMaturityStageV1 = 'stable',
): CapabilityMaturityEvidenceMaterialV1 {
  const previousStage = targetStage === 'stable' ? 'beta' : 'canary';
  return {
    schema: 'CapabilityMaturityEvidenceMaterialV1',
    decisionId: `${targetStage}-decision-003`,
    windowId: `${targetStage}-window-003`,
    targetStage,
    identity: structuredClone(identity),
    previousDecision:
      targetStage === 'canary'
        ? null
        : {
            schema: 'CapabilityMaturityPreviousDecisionV1',
            stage: previousStage,
            status: 'passed',
            decisionId: `${previousStage}-decision-002`,
            windowId: `${previousStage}-window-002`,
            decidedAt: '2026-07-31T00:00:00.000Z',
            identity: structuredClone(identity),
            decisionDigest: digest('7'),
          },
    preregistration: {
      registrationId: `${targetStage}-registration-003`,
      registeredAt: '2026-08-01T00:00:00.000Z',
      windowStartsAt: '2026-08-02T00:00:00.000Z',
      windowEndsAt: '2026-08-04T00:00:00.000Z',
      minimumWindowSeconds: 86_400,
      minimumSamples: 100,
      maximumErrorBudgetBps: 100,
      minimumUserUnderstandingSamples: 10,
      minimumUserUnderstandingBps: 9_000,
      requiredHumanApprovalCount: 1,
      freshnessSeconds: 86_400,
    },
    observation: {
      evidenceClass: 'production_observation',
      startedAt: '2026-08-02T00:00:00.000Z',
      endedAt: '2026-08-03T00:00:00.000Z',
      sampleCount: 100,
      errorCount: 1,
      errorBudgetConsumedBps: 100,
      retainedSampleLedgerDigest: digest('8'),
      gates: { G3: 'passed', G4: 'passed', G5: 'passed' },
      humanApprovals: [
        {
          approvalId: 'approval-001',
          approverIdentity: 'github:@release-reviewer',
          approvedAt: '2026-08-03T01:00:00.000Z',
          outcome: 'approved',
          independentFromEvidenceProducer: true,
          recordDigest: digest('9'),
        },
      ],
      userUnderstanding: {
        responseCount: 10,
        understoodCount: 9,
        understandingBps: 9_000,
        retainedResponseLedgerDigest: digest('a'),
      },
      rollback: {
        status: 'passed',
        rehearsalId: 'rollback-001',
        rehearsedAt: '2026-08-03T02:00:00.000Z',
        recordDigest: digest('b'),
        disablesNewAdmission: true,
        cohortPercentAfterRollback: 0,
      },
    },
  };
}

function evidence(
  evidenceMaterial: CapabilityMaturityEvidenceMaterialV1 = material(),
  authentication: 'configured' | 'unconfigured' = 'configured',
): CapabilityMaturityEvidenceV1 {
  const materialDigest = computeCapabilityMaturityEvidenceDigestV1(evidenceMaterial);
  return {
    schema: 'CapabilityMaturityEvidenceV1',
    material: evidenceMaterial,
    materialDigest,
    authentication:
      authentication === 'configured'
        ? {
            kind: 'github_oidc_sigstore_v1',
            authorityIdentity: 'github-actions:ferqx/kite-code:capability-maturity',
            verifierIdentity: 'sigstore-policy:kite-capability-maturity-v1',
            subjectDigest: materialDigest,
            attestationDigest: digest('c'),
            verificationReceiptDigest: digest('d'),
            verifiedAt: '2026-08-03T03:00:00.000Z',
          }
        : {
            kind: 'unconfigured',
            subjectDigest: materialDigest,
          },
  };
}

function evaluate(
  candidate: CapabilityMaturityEvidenceV1 | undefined,
  expectedIdentity: CapabilityMaturityIdentityV1 = identity,
  targetStage: CapabilityMaturityStageV1 = 'stable',
  evaluatedAt = '2026-08-03T04:00:00.000Z',
) {
  return evaluateCapabilityMaturityGateV1({
    targetStage,
    expectedIdentity,
    evaluatedAt,
    evidence: candidate,
  });
}

describe('capability maturity Gate', () => {
  test('is deterministically blocked when authenticated evidence is absent', () => {
    const first = evaluate(undefined);
    const second = evaluate(undefined);
    expect(first).toMatchObject({
      status: 'blocked',
      promotionEligible: false,
      decisionId: null,
      windowId: null,
      evidenceDigest: null,
      reasonCodes: ['authenticated_maturity_authority_not_configured', 'maturity_evidence_missing'],
    });
    expect(second.decisionDigest).toBe(first.decisionDigest);
  });

  test('keeps complete shape-valid production evidence blocked without a trusted authority', () => {
    const decision = evaluate(evidence());
    expect(decision).toMatchObject({
      status: 'blocked',
      promotionEligible: false,
      decisionId: 'stable-decision-003',
      windowId: 'stable-window-003',
      reasonCodes: [
        'authenticated_maturity_authority_not_configured',
        'evidence_authority_untrusted',
        'verified_human_approval_not_configured',
        'verified_previous_maturity_decision_not_configured',
      ],
    });
  });

  test('strictly rebuilds the canonical subject and rejects schema injection', () => {
    const candidate = evidence();
    expect(verifyCapabilityMaturityEvidenceV1(candidate)).toEqual(candidate);
    expect(() =>
      verifyCapabilityMaturityEvidenceV1({ ...candidate, materialDigest: digest('d') }),
    ).toThrow('material digest mismatch');
    expect(() =>
      verifyCapabilityMaturityEvidenceV1({
        ...candidate,
        authentication: { ...candidate.authentication, subjectDigest: digest('e') },
      }),
    ).toThrow('authentication subject');
    expect(() => verifyCapabilityMaturityEvidenceV1({ ...candidate, hiddenGrant: true })).toThrow();
  });

  test('enforces canary to beta to stable ordering and unique decision windows', () => {
    const skipped = material('stable');
    if (skipped.previousDecision) {
      skipped.previousDecision.stage = 'canary';
      skipped.previousDecision.decisionId = skipped.decisionId;
      skipped.previousDecision.windowId = skipped.windowId;
      skipped.previousDecision.decidedAt = skipped.preregistration.registeredAt;
    }
    expect(evaluate(evidence(skipped)).reasonCodes).toEqual(
      expect.arrayContaining([
        'maturity_stage_skip_detected',
        'decision_id_reused',
        'observation_window_id_reused',
        'previous_decision_not_before_current_registration',
      ]),
    );

    const betaWithoutCanary = material('beta');
    betaWithoutCanary.previousDecision = null;
    expect(evaluate(evidence(betaWithoutCanary), identity, 'beta').reasonCodes).toContain(
      'previous_canary_decision_missing',
    );

    const canaryWithHistory = material('canary');
    canaryWithHistory.previousDecision = {
      schema: 'CapabilityMaturityPreviousDecisionV1',
      stage: 'canary',
      status: 'passed',
      decisionId: 'prior-canary',
      windowId: 'prior-window',
      decidedAt: '2026-07-31T00:00:00.000Z',
      identity: structuredClone(identity),
      decisionDigest: digest('f'),
    };
    expect(evaluate(evidence(canaryWithHistory), identity, 'canary').reasonCodes).toContain(
      'canary_must_start_new_decision_chain',
    );
  });

  test('never trusts caller-authored previous decisions or human approval digests', () => {
    const candidate = material('stable');
    if (!candidate.previousDecision) throw new Error('Fixture previous decision missing.');
    candidate.previousDecision.decisionDigest = digest('f');
    candidate.observation.humanApprovals[0]!.recordDigest = digest('e');

    expect(evaluate(evidence(candidate)).reasonCodes).toEqual(
      expect.arrayContaining([
        'verified_previous_maturity_decision_not_configured',
        'verified_human_approval_not_configured',
      ]),
    );
  });

  test('binds payload, profile, route, platform, capability contract, and evaluator identity', () => {
    const expected = structuredClone(identity);
    expected.payloadDigest = digest('d');
    expected.profileDigest = digest('e');
    expected.routeDigest = digest('f');
    expected.platformIdentity = 'macos-15-arm64';
    expected.capabilityContractDigest = digest('0');
    expected.evaluatorIdentity = {
      evaluatorId: 'different-evaluator',
      evaluatorDigest: digest('d'),
      suiteDigest: digest('e'),
    };
    expect(evaluate(evidence(), expected).reasonCodes).toEqual(
      expect.arrayContaining([
        'evidence_identity_mismatch:payloadDigest',
        'evidence_identity_mismatch:profileDigest',
        'evidence_identity_mismatch:routeDigest',
        'evidence_identity_mismatch:platformIdentity',
        'evidence_identity_mismatch:capabilityContractDigest',
        'evidence_identity_mismatch:evaluator.evaluatorId',
        'evidence_identity_mismatch:evaluator.evaluatorDigest',
        'evidence_identity_mismatch:evaluator.suiteDigest',
      ]),
    );
  });

  test('rejects contract-only, stale, under-sampled, over-budget, and unapproved observations', () => {
    const invalid = material();
    invalid.preregistration.registeredAt = invalid.preregistration.windowStartsAt;
    invalid.preregistration.minimumSamples = 101;
    invalid.observation.evidenceClass = 'contract_only';
    invalid.observation.startedAt = '2026-08-02T12:00:00.000Z';
    invalid.observation.errorCount = 2;
    invalid.observation.errorBudgetConsumedBps = 100;
    invalid.observation.gates = { G3: 'failed', G4: 'blocked', G5: 'not_run' };
    const approval = invalid.observation.humanApprovals[0];
    if (!approval) throw new Error('Fixture approval missing.');
    approval.approvedAt = '2026-08-02T12:00:00.000Z';
    invalid.observation.userUnderstanding = {
      ...invalid.observation.userUnderstanding,
      responseCount: 9,
      understoodCount: 8,
      understandingBps: 9_000,
    };
    invalid.observation.rollback.status = 'not_run';
    invalid.observation.rollback.rehearsedAt = '2026-08-02T12:00:00.000Z';
    const candidate = evidence(invalid);
    if (candidate.authentication.kind === 'github_oidc_sigstore_v1') {
      candidate.authentication.verifiedAt = '2026-08-06T00:00:00.000Z';
    }
    const decision = evaluate(candidate, identity, 'stable', '2026-08-05T00:00:00.000Z');
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'real_observation_missing',
        'window_not_preregistered_before_start',
        'observation_window_too_short',
        'sample_count_below_preregistered_minimum',
        'error_budget_rate_mismatch',
        'error_budget_exceeded',
        'g3_not_passed',
        'g4_not_passed',
        'g5_not_passed',
        'human_approval_precedes_observation_completion',
        'user_understanding_rate_mismatch',
        'user_understanding_sample_count_below_minimum',
        'user_understanding_below_preregistered_minimum',
        'rollback_rehearsal_not_passed',
        'rollback_rehearsal_precedes_observation_completion',
        'maturity_evidence_stale',
        'authentication_time_invalid',
      ]),
    );
  });

  test('requires unique human approvals and explicit authentication configuration', () => {
    const duplicate = material();
    duplicate.preregistration.requiredHumanApprovalCount = 2;
    const approval = duplicate.observation.humanApprovals[0];
    if (!approval) throw new Error('Fixture approval missing.');
    duplicate.observation.humanApprovals.push(structuredClone(approval));
    expect(evaluate(evidence(duplicate, 'unconfigured')).reasonCodes).toEqual(
      expect.arrayContaining([
        'evidence_authentication_unconfigured',
        'human_approval_not_unique',
        'human_approval_count_below_preregistered_minimum',
      ]),
    );
  });
});
