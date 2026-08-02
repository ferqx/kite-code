import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

export interface PlanRecoveryObservationV1 {
  version: 1;
  caseId: string;
  entrypoint: 'tui' | 'headless_cli';
  planState: 'not_required' | 'drafted' | 'reviewed' | 'completed';
  toolDiscovery: 'not_needed' | 'found' | 'not_found' | 'error';
  approval: 'not_required' | 'approved' | 'denied' | 'cancelled' | 'unknown';
  recovery: 'not_needed' | 'recovered' | 'blocked' | 'failed';
  verification: 'passed' | 'failed' | 'not_run' | 'unknown';
  claimedComplete: boolean;
  userCorrections: number;
  approvalCount: number;
}

export interface PlanRecoveryUxResultV1 {
  version: 1;
  caseId: string;
  entrypoint: 'tui' | 'headless_cli';
  outcome: 'ready_for_review' | 'blocked' | 'failed' | 'unverified' | 'unknown';
  reasonCodes: string[];
  completionLabel: 'verified' | 'blocked' | 'failed' | 'unverified' | 'unknown';
  evidenceEligible: false;
  digest: `sha256:${string}`;
}

export function mapPlanRecoveryUx(input: PlanRecoveryObservationV1): PlanRecoveryUxResultV1 {
  validateObservation(input);
  const reasons = new Set<string>();
  if (input.approval === 'denied') reasons.add('approval_denied');
  if (input.approval === 'cancelled') reasons.add('approval_cancelled');
  if (input.approval === 'unknown') reasons.add('approval_unknown');
  if (input.toolDiscovery === 'not_found') reasons.add('tool_not_found');
  if (input.toolDiscovery === 'error') reasons.add('tool_discovery_error');
  if (input.recovery === 'blocked') reasons.add('recovery_blocked');
  if (input.recovery === 'failed') reasons.add('recovery_failed');
  if (input.verification === 'failed') reasons.add('verification_failed');
  if (input.verification === 'not_run') reasons.add('verification_not_run');
  if (input.verification === 'unknown') reasons.add('verification_unknown');
  if (input.planState === 'completed' && input.verification !== 'passed') {
    reasons.add('plan_not_completion');
  }
  if (input.claimedComplete && input.verification !== 'passed')
    reasons.add('false_completion_claim');

  let outcome: PlanRecoveryUxResultV1['outcome'];
  if (input.verification === 'failed' || input.recovery === 'failed') outcome = 'failed';
  else if (
    input.approval === 'denied' ||
    input.approval === 'cancelled' ||
    input.recovery === 'blocked' ||
    input.toolDiscovery === 'not_found'
  )
    outcome = 'blocked';
  else if (input.verification === 'not_run') outcome = 'unverified';
  else if (input.verification === 'unknown' || input.approval === 'unknown') outcome = 'unknown';
  else outcome = 'ready_for_review';
  const completionLabel: PlanRecoveryUxResultV1['completionLabel'] =
    outcome === 'ready_for_review'
      ? 'verified'
      : outcome === 'blocked'
        ? 'blocked'
        : outcome === 'failed'
          ? 'failed'
          : outcome;
  const withoutDigest = {
    version: 1 as const,
    caseId: input.caseId,
    entrypoint: input.entrypoint,
    outcome,
    reasonCodes: [...reasons].sort(),
    completionLabel,
    evidenceEligible: false as const,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

function validateObservation(value: PlanRecoveryObservationV1): void {
  exactKeys(value, [
    'approval',
    'approvalCount',
    'caseId',
    'claimedComplete',
    'entrypoint',
    'planState',
    'recovery',
    'toolDiscovery',
    'userCorrections',
    'verification',
    'version',
  ]);
  if (
    value.version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,255}$/.test(value.caseId) ||
    !['tui', 'headless_cli'].includes(value.entrypoint) ||
    !['not_required', 'drafted', 'reviewed', 'completed'].includes(value.planState) ||
    !['not_needed', 'found', 'not_found', 'error'].includes(value.toolDiscovery) ||
    !['not_required', 'approved', 'denied', 'cancelled', 'unknown'].includes(value.approval) ||
    !['not_needed', 'recovered', 'blocked', 'failed'].includes(value.recovery) ||
    !['passed', 'failed', 'not_run', 'unknown'].includes(value.verification) ||
    typeof value.claimedComplete !== 'boolean' ||
    !Number.isSafeInteger(value.userCorrections) ||
    value.userCorrections < 0 ||
    !Number.isSafeInteger(value.approvalCount) ||
    value.approvalCount < 0
  ) {
    throw new Error('Plan/recovery observation is invalid.');
  }
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Plan/recovery observation has missing or unknown fields.');
  }
}
