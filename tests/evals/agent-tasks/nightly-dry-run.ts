import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';
import type { AgentTaskSuiteRevisionV1 } from './suite-registry';

export interface NightlyDryRunPlanV1 {
  version: 1;
  mode: 'dry_run_only';
  suiteDigest: `sha256:${string}`;
  liveRouteEnabled: false;
  networkDispatches: 0;
  scheduled: Array<{
    caseId: string;
    status: 'blocked_unconfigured';
    repetitionCount: null;
  }>;
  evidenceStatus: 'blocked';
  reasonCodes: readonly ['d07_unconfigured', 'live_route_not_executed'];
  digest: `sha256:${string}`;
}

export function buildNightlyDryRunPlan(
  suite: AgentTaskSuiteRevisionV1,
  liveRoute: { enabled: boolean; explicitOptInToken: string | null },
): NightlyDryRunPlanV1 {
  if (
    suite.decision.id !== 'D-07' ||
    suite.decision.status !== 'unconfigured' ||
    suite.decision.approvedAt !== null ||
    suite.evidenceEligible !== false
  ) {
    throw new Error('Nightly dry-run suite decision identity is invalid.');
  }
  if (liveRoute.enabled) {
    if (liveRoute.explicitOptInToken !== 'KITE_AGENT_EVAL_LIVE_ROUTE_OPT_IN_V1') {
      throw new Error('Live Agent evaluation requires an exact explicit opt-in token.');
    }
    throw new Error('Live Agent evaluation remains blocked while D-07 is unconfigured.');
  }
  if (liveRoute.explicitOptInToken !== null) {
    throw new Error('Dry-run mode must not retain a live-route opt-in token.');
  }
  const withoutDigest = {
    version: 1 as const,
    mode: 'dry_run_only' as const,
    suiteDigest: suite.suiteDigest,
    liveRouteEnabled: false as const,
    networkDispatches: 0 as const,
    scheduled: suite.cases
      .map((task) => ({
        caseId: task.caseId,
        status: 'blocked_unconfigured' as const,
        repetitionCount: null,
      }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
    evidenceStatus: 'blocked' as const,
    reasonCodes: ['d07_unconfigured', 'live_route_not_executed'] as const,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}
