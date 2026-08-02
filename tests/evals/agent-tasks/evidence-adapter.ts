import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';
import type { AdversarialContractSummaryV1 } from './adversarial-contract';
import type { HumanReviewRehearsalV1 } from './human-review';
import type { PlanRecoveryUxResultV1 } from './plan-recovery-mapper';
import {
  type AgentTaskRepeatedReportV1,
  verifySyntheticRepeatedRunReport,
} from './repeated-runner';
import type { AgentTaskSuiteRevisionV1 } from './suite-registry';

export interface AgentTaskEvidenceAdapterInputV1 {
  version: 1;
  suite: AgentTaskSuiteRevisionV1;
  repeatedReports: AgentTaskRepeatedReportV1[];
  adversarial: AdversarialContractSummaryV1 | null;
  planRecovery: PlanRecoveryUxResultV1[];
  humanReview: HumanReviewRehearsalV1 | null;
  liveRoute: {
    enabled: boolean;
    explicitOptIn: boolean;
    runObserved: boolean;
  };
  dependencies: {
    ms1bDone: false;
    d07Closed: false;
    ms2aFoundation: boolean;
  };
}

export interface AgentTaskEvidenceAdapterResultV1 {
  version: 1;
  kind: 'agent_task_suite';
  status: 'blocked';
  gateColor: 'not_green';
  evidenceEligible: false;
  suiteIdentity: `sha256:${string}`;
  expectedCases: number;
  receivedCaseReports: number;
  missingCaseIds: string[];
  caseSummaries: Array<{
    caseId: string;
    routeIdentity: string;
    attempted: number;
    checksPassed: number;
    failureTaxonomy: Array<{ kind: string; count: number }>;
    reportDigest: `sha256:${string}`;
  }>;
  reasonCodes: string[];
  humanAccepted: 'not_observed';
  integrated: 'not_observed';
  reverted: 'not_observed';
  digest: `sha256:${string}`;
}

/**
 * Local adapter deliberately has no `passed` variant. Formal dependencies,
 * platform adversarial evidence, human observation, and live-route runs are absent.
 */
export function adaptAgentTaskEvidence(
  input: AgentTaskEvidenceAdapterInputV1,
): AgentTaskEvidenceAdapterResultV1 {
  exactKeys(input, [
    'adversarial',
    'dependencies',
    'humanReview',
    'liveRoute',
    'planRecovery',
    'repeatedReports',
    'suite',
    'version',
  ]);
  exactKeys(input.liveRoute, ['enabled', 'explicitOptIn', 'runObserved']);
  exactKeys(input.dependencies, ['d07Closed', 'ms1bDone', 'ms2aFoundation']);
  if (
    input.version !== 1 ||
    input.dependencies.ms1bDone !== false ||
    input.dependencies.d07Closed !== false ||
    typeof input.dependencies.ms2aFoundation !== 'boolean' ||
    typeof input.liveRoute.enabled !== 'boolean' ||
    typeof input.liveRoute.explicitOptIn !== 'boolean' ||
    typeof input.liveRoute.runObserved !== 'boolean'
  ) {
    throw new Error('Local Agent task adapter dependency identity is invalid.');
  }
  verifyDigestRecord(input.suite, 'suiteDigest');
  const expected = new Set(input.suite.cases.map((task) => task.caseId));
  const seen = new Set<string>();
  for (const report of input.repeatedReports) {
    if (!expected.has(report.caseId) || seen.has(report.caseId)) {
      throw new Error('Repeated report has an unknown or duplicate suite case identity.');
    }
    if (report.suiteDigest !== input.suite.suiteDigest) {
      throw new Error('Repeated report suite identity mismatch.');
    }
    verifySyntheticRepeatedRunReport(report, {
      version: 1,
      executionClass: 'synthetic_fixture',
      caseId: report.caseId,
      suiteDigest: report.suiteDigest,
      routeIdentity: report.routeIdentity,
      configDigest: report.configDigest,
      artifactDigest: report.artifactDigest,
      contractDigest: report.contractDigest,
      schemaDigest: report.schemaDigest,
      repetitionCount: report.attempts.length,
      evaluatorSeed: report.evaluatorSeed,
      decision: { id: 'D-07', status: 'unconfigured', approvedAt: null },
    });
    seen.add(report.caseId);
  }
  const missingCaseIds = [...expected].filter((caseId) => !seen.has(caseId)).sort();
  const reasons = new Set<string>(['d07_unconfigured', 'ms1b_done_missing']);
  if (!input.dependencies.ms2aFoundation) reasons.add('ms2a_foundation_missing');
  if (missingCaseIds.length > 0) reasons.add('case_reports_missing');
  if (!input.adversarial) reasons.add('adversarial_contract_missing');
  else {
    verifyDigestRecord(input.adversarial, 'digest');
    if (input.adversarial.formalG0Outcome === 'not_observed') reasons.add('formal_g0_not_observed');
    if (input.adversarial.status !== 'contract_only')
      reasons.add('adversarial_contract_incomplete');
  }
  if (input.planRecovery.length === 0) reasons.add('plan_recovery_missing');
  input.planRecovery.forEach((result) => {
    verifyDigestRecord(result, 'digest');
    if (result.evidenceEligible !== false)
      throw new Error('Plan/recovery result is not local-only.');
  });
  if (input.planRecovery.some((result) => result.outcome !== 'ready_for_review')) {
    reasons.add('plan_recovery_not_ready');
  }
  if (!input.humanReview) reasons.add('human_review_missing');
  else {
    verifyDigestRecord(input.humanReview, 'digest');
    if (
      input.humanReview.evidenceEligible !== false ||
      input.humanReview.result.humanAccepted !== 'not_observed' ||
      input.humanReview.result.integrated !== 'not_observed' ||
      input.humanReview.result.reverted !== 'not_observed'
    ) {
      throw new Error('Synthetic human review contains a fabricated observed outcome.');
    }
    reasons.add('human_outcomes_not_observed');
  }
  if (!input.liveRoute.enabled) reasons.add('live_route_disabled');
  else if (!input.liveRoute.explicitOptIn) reasons.add('live_route_opt_in_missing');
  else if (!input.liveRoute.runObserved) reasons.add('live_route_not_observed');
  reasons.add('synthetic_reports_not_release_evidence');

  const caseSummaries = input.repeatedReports
    .map((report) => ({
      caseId: report.caseId,
      routeIdentity: report.routeIdentity,
      attempted: report.counts.attempted,
      checksPassed: report.counts.checksPassed,
      failureTaxonomy: structuredClone(report.failureTaxonomy),
      reportDigest: report.digest,
    }))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const withoutDigest = {
    version: 1 as const,
    kind: 'agent_task_suite' as const,
    status: 'blocked' as const,
    gateColor: 'not_green' as const,
    evidenceEligible: false as const,
    suiteIdentity: input.suite.suiteDigest,
    expectedCases: expected.size,
    receivedCaseReports: input.repeatedReports.length,
    missingCaseIds,
    caseSummaries,
    reasonCodes: [...reasons].sort(),
    humanAccepted: 'not_observed' as const,
    integrated: 'not_observed' as const,
    reverted: 'not_observed' as const,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

function verifyDigestRecord<Value extends object, Key extends keyof Value>(
  value: Value,
  digestKey: Key,
): void {
  const copy = { ...value } as Record<string, unknown>;
  const actual = copy[String(digestKey)];
  delete copy[String(digestKey)];
  if (typeof actual !== 'string' || actual !== sha256Digest(canonicalJsonBytes(copy))) {
    throw new Error(`Evaluation record ${String(digestKey)} does not match its canonical content.`);
  }
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Evidence adapter input has missing or unknown fields.');
  }
}
