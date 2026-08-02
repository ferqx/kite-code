import type {
  CapabilityProfileAdmissionDecisionV1,
  CapabilityProfileV1,
} from '@/core/config/release-capabilities';
import {
  getActivePlanning,
  type RuntimeState,
  type VerificationStatus,
} from '@/core/runtime/state';
import type { EffectProfile } from '@/protocol/capabilities';

export type CapabilityExecutionBoundaryV1 = 'local' | 'mixed' | 'remote' | 'unknown';

export interface CompletionSemanticsProjectionV1 {
  agentFinal: 'absent' | 'present';
  runtimeTerminal: 'not_ended' | NonNullable<RuntimeState['terminalOutcome']>['status'];
  planLifecycle: ReturnType<typeof projectPlanLifecycleV1>;
  checks: {
    declared: number;
    executed: number;
    passed: number;
    failed: number;
    inconclusive: number;
  };
  verification: {
    newAdmission: 'enabled' | 'disabled';
    requiredFactCount: number;
    requiredFactsRetained: boolean;
    status: 'not_required' | VerificationStatus;
  };
  assessment:
    | 'runtime_not_completed'
    | 'runtime_completed_verification_not_required'
    | 'runtime_completed_verification_passed'
    | 'runtime_completed_verification_pending'
    | 'runtime_completed_verification_waived';
}

export interface CapabilityStatusProjectionV1 {
  version: 1;
  capability: CapabilityProfileV1['capability'];
  profileId: string;
  maturity: CapabilityProfileV1['state']['maturity'];
  rollout: CapabilityProfileV1['state']['maxRollout'];
  admission: 'admitted' | 'blocked';
  disabledReasons: readonly string[];
  executionBoundary: CapabilityExecutionBoundaryV1;
  expectedSideEffects: EffectProfile;
  recovery: {
    disableNewAdmission: true;
    preserveReceipts: true;
    preserveRequiredVerification: true;
    cohortPercent: 0;
    safeRetry: boolean;
    entry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  };
  experimentalExit: 'disable_new_admission_and_set_cohort_zero';
  completion: CompletionSemanticsProjectionV1;
}

/**
 * Projects durable Runtime facts without turning a final answer, ended turn,
 * completed Plan, or executed check into a Verification pass.
 */
export function projectCompletionSemanticsV1(input: {
  state: Readonly<RuntimeState>;
  verificationFeatureEnabled: boolean;
}): CompletionSemanticsProjectionV1 {
  const records = Object.values(input.state.verification.records).sort((left, right) =>
    left.verificationId < right.verificationId
      ? -1
      : left.verificationId > right.verificationId
        ? 1
        : 0,
  );
  const required = records.filter((record) => record.mode === 'required');
  const results = records.flatMap((record) => Object.values(record.checkResults));
  const requiredStatus = aggregateRequiredVerificationStatusV1(
    required.map(({ status }) => status),
  );
  const runtimeCompleted = input.state.terminalOutcome?.status === 'completed';

  return Object.freeze({
    agentFinal: input.state.transcript.final === undefined ? 'absent' : 'present',
    runtimeTerminal: input.state.terminalOutcome?.status ?? 'not_ended',
    planLifecycle: projectPlanLifecycleV1(input.state),
    checks: Object.freeze({
      declared: records.reduce((total, record) => total + record.spec.checks.length, 0),
      executed: results.length,
      passed: results.filter(({ outcome }) => outcome === 'passed').length,
      failed: results.filter(({ outcome }) => outcome === 'failed').length,
      inconclusive: results.filter(({ outcome }) => outcome === 'inconclusive').length,
    }),
    verification: Object.freeze({
      newAdmission: input.verificationFeatureEnabled ? 'enabled' : 'disabled',
      requiredFactCount: required.length,
      requiredFactsRetained: required.length > 0,
      status: requiredStatus,
    }),
    assessment: completionAssessmentV1(runtimeCompleted, requiredStatus),
  });
}

/** Presentation-only projection. It cannot enable a capability. */
export function projectCapabilityStatusV1(input: {
  profile: CapabilityProfileV1;
  admission: CapabilityProfileAdmissionDecisionV1;
  executionBoundary: CapabilityExecutionBoundaryV1;
  expectedSideEffects: EffectProfile;
  state: Readonly<RuntimeState>;
  verificationFeatureEnabled: boolean;
}): CapabilityStatusProjectionV1 {
  const outcome = input.state.terminalOutcome;
  return Object.freeze({
    version: 1,
    capability: input.profile.capability,
    profileId: input.profile.profileId,
    maturity: input.profile.state.maturity,
    rollout: input.profile.state.maxRollout,
    admission: input.admission.admitted ? 'admitted' : 'blocked',
    disabledReasons: Object.freeze([...input.admission.reasons]),
    executionBoundary: input.executionBoundary,
    expectedSideEffects: Object.freeze({ ...input.expectedSideEffects }),
    recovery: Object.freeze({
      ...input.profile.rollback,
      safeRetry: outcome?.safeRetry ?? false,
      entry: outcome?.recoveryEntry ?? 'none',
    }),
    experimentalExit: 'disable_new_admission_and_set_cohort_zero',
    completion: projectCompletionSemanticsV1({
      state: input.state,
      verificationFeatureEnabled: input.verificationFeatureEnabled,
    }),
  });
}

export function formatCapabilityStatusV1(status: CapabilityStatusProjectionV1): string {
  const completion = status.completion;
  return [
    `Capability: ${status.capability}`,
    `Profile: ${status.profileId}`,
    `Maturity: ${status.maturity}`,
    `Rollout ceiling: ${status.rollout}`,
    `Admission: ${status.admission}${status.disabledReasons.length > 0 ? ` (${status.disabledReasons.join(', ')})` : ''}`,
    `Execution boundary: ${status.executionBoundary}`,
    `Expected side effects: filesystem=${status.expectedSideEffects.filesystem} network=${status.expectedSideEffects.network} external_state=${status.expectedSideEffects.externalState}`,
    `Agent final: ${completion.agentFinal}`,
    `Runtime terminal: ${completion.runtimeTerminal}`,
    `Plan lifecycle: ${completion.planLifecycle}`,
    `Checks: executed=${completion.checks.executed} declared=${completion.checks.declared} passed=${completion.checks.passed} failed=${completion.checks.failed} inconclusive=${completion.checks.inconclusive}`,
    `Verification new admission: ${completion.verification.newAdmission}`,
    `Required Verification facts: retained=${yesNo(completion.verification.requiredFactsRetained)} count=${completion.verification.requiredFactCount} status=${completion.verification.status}`,
    `Completion assessment: ${completion.assessment}`,
    `Recovery: safe_retry=${yesNo(status.recovery.safeRetry)} entry=${status.recovery.entry} receipts=preserved required_verification=preserved`,
    `Experimental exit: ${status.experimentalExit}`,
  ].join('\n');
}

function aggregateRequiredVerificationStatusV1(
  statuses: readonly VerificationStatus[],
): 'not_required' | VerificationStatus {
  if (statuses.length === 0) return 'not_required';
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.every((status) => status === 'passed' || status === 'waived')) return 'waived';
  const priority: readonly VerificationStatus[] = [
    'budget_exhausted',
    'compensating',
    'compensated',
    'failed',
    'inconclusive',
    'repair_pending',
    'running',
    'pending',
    'waived',
    'passed',
  ];
  return priority.find((status) => statuses.includes(status)) ?? 'inconclusive';
}

function completionAssessmentV1(
  runtimeCompleted: boolean,
  verificationStatus: 'not_required' | VerificationStatus,
): CompletionSemanticsProjectionV1['assessment'] {
  if (!runtimeCompleted) return 'runtime_not_completed';
  if (verificationStatus === 'not_required') return 'runtime_completed_verification_not_required';
  if (verificationStatus === 'passed') return 'runtime_completed_verification_passed';
  if (verificationStatus === 'waived') return 'runtime_completed_verification_waived';
  return 'runtime_completed_verification_pending';
}

function projectPlanLifecycleV1(
  state: Readonly<RuntimeState>,
):
  | 'not_present'
  | 'building_without_plan'
  | 'planning'
  | 'awaiting_review'
  | 'executing'
  | 'completed'
  | 'cancelled' {
  const planning = getActivePlanning(state);
  switch (planning.kind) {
    case 'building_without_plan':
      return 'building_without_plan';
    case 'planning_empty':
    case 'planning_draft':
    case 'replanning_draft':
      return 'planning';
    case 'awaiting_review':
      return 'awaiting_review';
    case 'executing':
      return 'executing';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'not_present';
  }
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
