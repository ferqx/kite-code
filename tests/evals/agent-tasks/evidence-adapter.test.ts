import { describe, expect, test } from 'bun:test';
import {
  ADVERSARIAL_CONTRACT_CATALOG_V1,
  createAdversarialContractReceipt,
  summarizeAdversarialContracts,
} from './adversarial-contract';
import { digest, syntheticRepeatedReport, syntheticSuite } from './evaluation-test-fixtures';
import { adaptAgentTaskEvidence } from './evidence-adapter';
import { buildSyntheticHumanReviewRehearsal } from './human-review';
import { buildNightlyDryRunPlan } from './nightly-dry-run';
import { mapPlanRecoveryUx } from './plan-recovery-mapper';

describe('Agent task evidence adapter and nightly dry run', () => {
  test('keeps complete local contracts blocked and emits metadata-only summaries', () => {
    const suite = syntheticSuite();
    const report = syntheticRepeatedReport(suite);
    const result = adaptAgentTaskEvidence({
      version: 1,
      suite,
      repeatedReports: [report],
      adversarial: contractSummary(),
      planRecovery: [readyPlanResult()],
      humanReview: rehearsal(),
      liveRoute: { enabled: false, explicitOptIn: false, runObserved: false },
      dependencies: { ms1bDone: false, d07Closed: false, ms2aFoundation: true },
    });

    expect(result.status).toBe('blocked');
    expect(result.gateColor).toBe('not_green');
    expect(result.evidenceEligible).toBe(false);
    expect(result.reasonCodes).toContain('formal_g0_not_observed');
    expect(result.reasonCodes).toContain('human_outcomes_not_observed');
    expect(result.reasonCodes).toContain('live_route_disabled');
    expect(result.reasonCodes).toContain('synthetic_reports_not_release_evidence');
    expect(result.humanAccepted).toBe('not_observed');
    expect(result.caseSummaries[0]).not.toHaveProperty('attempts');
    expect(JSON.stringify(result)).not.toContain('payloadBytes');
  });

  test('missing reports and observations never become green', () => {
    const suite = syntheticSuite();
    const result = adaptAgentTaskEvidence({
      version: 1,
      suite,
      repeatedReports: [],
      adversarial: null,
      planRecovery: [],
      humanReview: null,
      liveRoute: { enabled: true, explicitOptIn: false, runObserved: false },
      dependencies: { ms1bDone: false, d07Closed: false, ms2aFoundation: false },
    });
    expect(result.status).toBe('blocked');
    expect(result.missingCaseIds).toEqual([suite.cases[0]!.caseId]);
    expect(result.reasonCodes).toContain('case_reports_missing');
    expect(result.reasonCodes).toContain('adversarial_contract_missing');
    expect(result.reasonCodes).toContain('human_review_missing');
    expect(result.reasonCodes).toContain('live_route_opt_in_missing');
  });

  test('rejects tampered report aggregates instead of adapting recent-looking green counts', () => {
    const suite = syntheticSuite();
    const report = syntheticRepeatedReport(suite);
    report.counts.checksPassed = 0;
    expect(() =>
      adaptAgentTaskEvidence({
        version: 1,
        suite,
        repeatedReports: [report],
        adversarial: contractSummary(),
        planRecovery: [readyPlanResult()],
        humanReview: rehearsal(),
        liveRoute: { enabled: false, explicitOptIn: false, runObserved: false },
        dependencies: { ms1bDone: false, d07Closed: false, ms2aFoundation: true },
      }),
    ).toThrow('does not rebuild');
  });

  test('nightly planning performs zero dispatch and live mode requires opt-in plus closed decision', () => {
    const suite = syntheticSuite();
    const dryRun = buildNightlyDryRunPlan(suite, {
      enabled: false,
      explicitOptInToken: null,
    });
    expect(dryRun.mode).toBe('dry_run_only');
    expect(dryRun.networkDispatches).toBe(0);
    expect(dryRun.evidenceStatus).toBe('blocked');
    expect(dryRun.scheduled.every((entry) => entry.repetitionCount === null)).toBe(true);

    expect(() =>
      buildNightlyDryRunPlan(suite, { enabled: true, explicitOptInToken: null }),
    ).toThrow('explicit opt-in');
    expect(() =>
      buildNightlyDryRunPlan(suite, {
        enabled: true,
        explicitOptInToken: 'KITE_AGENT_EVAL_LIVE_ROUTE_OPT_IN_V1',
      }),
    ).toThrow('D-07 is unconfigured');
  });
});

function contractSummary() {
  return summarizeAdversarialContracts(
    ADVERSARIAL_CONTRACT_CATALOG_V1.map((entry) =>
      createAdversarialContractReceipt(entry, 'schema_exercised'),
    ),
  );
}

function rehearsal() {
  return buildSyntheticHumanReviewRehearsal({
    consentId: 'synthetic-consent-v1',
    reviewId: 'synthetic-review-v1',
    diffDigest: digest('diff'),
    checksDigest: digest('checks'),
  });
}

function readyPlanResult() {
  return mapPlanRecoveryUx({
    version: 1,
    caseId: 'synthetic.plan-recovery.v1',
    entrypoint: 'headless_cli',
    planState: 'reviewed',
    toolDiscovery: 'found',
    approval: 'approved',
    recovery: 'recovered',
    verification: 'passed',
    claimedComplete: false,
    userCorrections: 0,
    approvalCount: 1,
  });
}
