import type { EffectProfile, PlanningState } from '@kite-ai/runtime-contract';
import type {
  CapabilityProfile,
  CapabilityProfileAdmissionDecision,
} from '#app/config/release-capabilities';

export type VerificationStatus =
  | 'pending'
  | 'running'
  | 'repair_pending'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'waived'
  | 'compensating'
  | 'compensated'
  | 'budget_exhausted';

export interface CapabilityStatusRuntimeProjection {
  readonly terminalOutcome?: {
    readonly status: 'completed' | string;
    readonly safeRetry: boolean;
    readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  };
  readonly transcript: { readonly final?: string };
  readonly activeTaskId?: string | null;
  readonly tasks: Readonly<Record<string, { readonly planning: PlanningState }>>;
  readonly verification: {
    readonly records: Readonly<
      Record<
        string,
        {
          readonly verificationId: string;
          readonly mode: 'not_required' | 'best_effort' | 'required';
          readonly status: VerificationStatus;
          readonly spec: { readonly checks: readonly unknown[] };
          readonly checkResults: Readonly<
            Record<string, { readonly outcome: 'passed' | 'failed' | 'inconclusive' }>
          >;
        }
      >
    >;
  };
}

export type CapabilityExecutionBoundary = 'local' | 'mixed' | 'remote' | 'unknown';

export interface CompletionSemanticsProjection {
  agentFinal: 'absent' | 'present';
  runtimeTerminal:
    | 'not_ended'
    | NonNullable<CapabilityStatusRuntimeProjection['terminalOutcome']>['status'];
  planLifecycle: ReturnType<typeof projectPlanLifecycle>;
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

export interface CapabilityStatusProjection {
  version: 1;
  capability: CapabilityProfile['capability'];
  profileId: string;
  maturity: CapabilityProfile['state']['maturity'];
  rollout: CapabilityProfile['state']['maxRollout'];
  admission: 'admitted' | 'blocked';
  disabledReasons: readonly string[];
  executionBoundary: CapabilityExecutionBoundary;
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
  completion: CompletionSemanticsProjection;
}

/**
 * Projects durable Runtime facts without turning a final answer, ended turn,
 * completed Plan, or executed check into a Verification pass.
 */
export function projectCompletionSemantics(input: {
  state: Readonly<CapabilityStatusRuntimeProjection>;
  verificationFeatureEnabled: boolean;
}): CompletionSemanticsProjection {
  const records = Object.values(input.state.verification.records).sort((left, right) =>
    left.verificationId < right.verificationId
      ? -1
      : left.verificationId > right.verificationId
        ? 1
        : 0,
  );
  const required = records.filter((record) => record.mode === 'required');
  const results = records.flatMap((record) => Object.values(record.checkResults));
  const requiredStatus = aggregateRequiredVerificationStatus(required.map(({ status }) => status));
  const runtimeCompleted = input.state.terminalOutcome?.status === 'completed';

  return Object.freeze({
    agentFinal: input.state.transcript.final === undefined ? 'absent' : 'present',
    runtimeTerminal: input.state.terminalOutcome?.status ?? 'not_ended',
    planLifecycle: projectPlanLifecycle(input.state),
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
    assessment: completionAssessment(runtimeCompleted, requiredStatus),
  });
}

/** Presentation-only projection. It cannot enable a capability. */
export function projectCapabilityStatus(input: {
  profile: CapabilityProfile;
  admission: CapabilityProfileAdmissionDecision;
  executionBoundary: CapabilityExecutionBoundary;
  expectedSideEffects: EffectProfile;
  state: Readonly<CapabilityStatusRuntimeProjection>;
  verificationFeatureEnabled: boolean;
}): CapabilityStatusProjection {
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
    completion: projectCompletionSemantics({
      state: input.state,
      verificationFeatureEnabled: input.verificationFeatureEnabled,
    }),
  });
}

export function formatCapabilityStatus(status: CapabilityStatusProjection): string {
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

function aggregateRequiredVerificationStatus(
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

function completionAssessment(
  runtimeCompleted: boolean,
  verificationStatus: 'not_required' | VerificationStatus,
): CompletionSemanticsProjection['assessment'] {
  if (!runtimeCompleted) return 'runtime_not_completed';
  if (verificationStatus === 'not_required') return 'runtime_completed_verification_not_required';
  if (verificationStatus === 'passed') return 'runtime_completed_verification_passed';
  if (verificationStatus === 'waived') return 'runtime_completed_verification_waived';
  return 'runtime_completed_verification_pending';
}

function projectPlanLifecycle(
  state: Readonly<CapabilityStatusRuntimeProjection>,
):
  | 'not_present'
  | 'building_without_plan'
  | 'planning'
  | 'awaiting_review'
  | 'executing'
  | 'completed'
  | 'cancelled' {
  const planning = state.activeTaskId
    ? (state.tasks[state.activeTaskId]?.planning ?? { kind: 'building_without_plan' as const })
    : { kind: 'building_without_plan' as const };
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
