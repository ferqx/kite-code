import { describe, expect, test } from 'bun:test';
import { qualifyLimitedSlo } from '../../scripts/operations/qualify-limited-slo';

const digest = `sha256:${'a'.repeat(64)}` as const;
const commit = 'a'.repeat(40);
const artifactIdentity = {
  canonicalRepository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  commit,
  payloadSha256: digest,
  canonicalManifestDigest: digest,
  behaviorDigest: digest,
  profileDigest: digest,
  gatePolicyDigest: digest,
} as const;
const metrics = {
  task_checks_passed: 0.99,
  human_accepted: 0.9,
  recovery_success: 0.99,
  unrelated_diff: 0,
  false_completion: 0,
  integrated: 0.8,
  reverted: 0,
};
const observation = {
  schema: 'LimitedCohortObservation',
  artifactIdentity,
  routeDigest: digest,
  cohortDigest: digest,
  source: {
    repository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    headSha: commit,
    ref: 'refs/heads/main',
    workflowPath: '.github/workflows/limited-slo.yml',
    workflowRef: 'ferqx/kite-code/.github/workflows/limited-slo.yml@refs/heads/main',
    workflowSha: commit,
    runId: '1',
    runAttempt: 1,
    jobName: 'limited-slo',
    jobId: '2',
    artifactName: 'limited-slo-evidence',
    artifactId: '3',
    artifactDigest: digest,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    attestationSubjectDigest: digest,
    reportDigest: digest,
    verifierDigest: digest,
    sampleLedgerDigest: digest,
  },
  startedAt: '2026-08-01T00:00:00.000Z',
  endedAt: '2026-08-02T00:00:00.000Z',
  sampleCount: 100,
  noData: false,
  consentCompliant: true,
  ownerAvailable: true,
  killSwitchAvailable: true,
  g0: {
    unauthorized_side_effects: 0,
    secret_or_content_egress: 0,
    sandbox_or_workspace_escape: 0,
    runtime_state_corruption: 0,
    required_verification_bypass: 0,
  },
  g1Failures: 0,
  errorBudgetBurn: 0.01,
  metrics,
} as const;
const approvedPolicy = {
  schema: 'AgentProductionSlo',
  policyId: 'agent-production-v1',
  status: 'approved',
  approvalMilestone: 'MS:LIM-APPROVED',
  noData: 'blocked',
  minimumSamples: 50,
  observationWindowSeconds: 3600,
  errorBudget: 0.05,
  g0: {
    unauthorized_side_effects: 0,
    secret_or_content_egress: 0,
    sandbox_or_workspace_escape: 0,
    runtime_state_corruption: 0,
    required_verification_bypass: 0,
  },
  thresholds: {
    task_checks_passed: 0.95,
    human_accepted: 0.8,
    recovery_success: 0.95,
    unrelated_diff: 0.01,
    false_completion: 0,
    integrated: 0.7,
    reverted: 0.05,
  },
  approval: {
    owner: 'github:@ferqx',
    approvedAt: '2026-07-31T00:00:00.000Z',
    evidenceDigest: digest,
  },
} as const;

describe('limited cohort SLO Gate', () => {
  test('keeps the repository baseline blocked while thresholds are unconfigured', () => {
    const result = qualifyLimitedSlo({
      policy: {
        ...approvedPolicy,
        status: 'baseline_unconfigured',
        minimumSamples: null,
        observationWindowSeconds: null,
        errorBudget: null,
      },
      observation,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      milestone: null,
      policyId: null,
      reasonCodes: [
        'authenticated_observation_verifier_not_configured',
        'baseline_unconfigured_or_unapproved',
        'retained_sample_ledger_missing',
        'trusted_source_expectation_missing',
      ],
    });
  });

  test('blocks no-data, any G0/G1, insufficient windows, and unavailable containment', () => {
    const result = qualifyLimitedSlo({
      policy: approvedPolicy,
      observation: {
        ...observation,
        endedAt: '2026-08-01T00:00:30.000Z',
        sampleCount: 0,
        noData: true,
        ownerAvailable: false,
        killSwitchAvailable: false,
        g0: { ...observation.g0, unauthorized_side_effects: 1 },
        g1Failures: 1,
      },
    });
    expect(result.status).toBe('blocked');
    expect(result.milestone).toBeNull();
    expect(result.reasonCodes).toEqual([
      'authenticated_observation_verifier_not_configured',
      'g0_observed',
      'g1_observed',
      'kill_switch_unavailable',
      'no_data',
      'observation_window_insufficient',
      'owner_unavailable',
      'retained_sample_ledger_missing',
      'sample_count_insufficient',
      'trusted_source_expectation_missing',
    ]);
  });

  test('keeps a deterministic fixture contract-only without minting external evidence', () => {
    const first = qualifyLimitedSlo({ policy: approvedPolicy, observation });
    const second = qualifyLimitedSlo({ policy: approvedPolicy, observation });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'blocked',
      milestone: null,
      evidenceClass: 'contract_only',
      evidenceEligible: false,
      reasonCodes: [
        'authenticated_observation_verifier_not_configured',
        'retained_sample_ledger_missing',
        'trusted_source_expectation_missing',
      ],
    });
    expect(first.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.observationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
