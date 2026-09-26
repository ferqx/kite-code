import { createHash } from 'node:crypto';
import type { AgentState, KernelEvent } from '@kite-ai/agent-kernel';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import { getActivePlanning } from './initial';
import {
  type BoundedFollowupModelResourcePlan,
  planBoundedFollowupModelResource,
} from './resource-admission';
import {
  assertResourceUsage,
  committedResourceUsage,
  createZeroResourceUsage,
  fundingBudgetForRun,
  type ResourceUsage,
  reduceResourceBudgetState,
} from './resource-budget';

type ReservedEvent = Extract<KernelEvent, { type: 'resource_budget.reserved' }>;
type ChildSlotEvent = Extract<KernelEvent, { type: 'resource_budget.child_slot_acquired' }>;

/** Trusted Store receipt lookup must precede any new budget plan. */
export type CrossSessionReceiptPreflight<Receipt> =
  | { readonly status: 'missing' }
  | { readonly status: 'exact'; readonly requestDigest: string; readonly receipt: Receipt }
  | { readonly status: 'conflict' };

export interface CrossSessionFollowupPolicy {
  readonly phaseCeiling: 'planning' | 'building';
  readonly authorizationDigest: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly capabilityDigest: string;
  readonly workspaceDigest: string;
  readonly policyRevision: string;
  readonly interactionModeRevision: number;
  readonly boundedContext: true;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly firstAttemptTimeoutMs: number;
  /** Persisted on the private admission Artifact for target attenuation. */
  readonly interactionMode?: AgentState['mode'];
  readonly workspaceAccess?: AgentState['workspaceAccess'];
}

export interface CrossSessionTargetFollowupPolicyProof {
  readonly observedTargetRevision: number;
  readonly grantDigest: string;
  readonly capabilityDigest: string;
  readonly interactionModeRevision: number;
  readonly phaseCeiling: 'planning' | 'building';
  readonly mode: AgentState['mode'];
  readonly workspaceAccess: AgentState['workspaceAccess'];
  readonly denyTools: true;
  readonly allowedTools: readonly [];
}

export interface CrossSessionFollowupAdmission {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly sourceRunId: string;
  readonly submissionId: string;
  readonly fundingRunId: string;
  readonly backupReservationId: string;
  readonly deadlineAt: number;
  readonly executableUpperBound: ResourceUsage;
  readonly policy: CrossSessionFollowupPolicy;
}

export class CrossSessionFollowupAdmissionError extends Error {
  readonly code:
    | 'receipt_conflict'
    | 'source_mismatch'
    | 'policy_changed'
    | 'budget_unconfigured'
    | 'reconciliation_required'
    | 'budget_exhausted'
    | 'surface_unverified';
  constructor(code: CrossSessionFollowupAdmissionError['code'], message: string) {
    super(message);
    this.name = 'CrossSessionFollowupAdmissionError';
    this.code = code;
  }
}

const fail = (code: CrossSessionFollowupAdmissionError['code'], message: string): never => {
  throw new CrossSessionFollowupAdmissionError(code, message);
};
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const identity = (kind: string, parts: readonly string[]): string =>
  `${kind}_${sha256(JSON.stringify(['kite.cross-session-followup.v1', kind, ...parts]))}`;

/** Pure source-ledger preflight; the source owner persists the returned Event under its fence. */
export function planCrossSessionFollowupSlotAcquisition(input: {
  readonly sourceState: AgentState;
  readonly sourceSessionId: string;
  readonly fundingRunId: string;
  readonly submissionId: string;
  readonly backupReservationId: string;
}):
  | Readonly<{ status: 'ready'; event: ChildSlotEvent }>
  | Readonly<{ status: 'waiting' }>
  | Readonly<{ status: 'already_acquired' }> {
  if (
    input.sourceState.session.threadId !== input.sourceSessionId ||
    input.backupReservationId !== identity('backup', [input.submissionId, input.fundingRunId])
  )
    fail('source_mismatch', 'TriggerTurn slot request has no exact source admission identity.');
  const ledger = fundingBudgetForRun(input.sourceState, input.fundingRunId);
  if (!ledger)
    throw new CrossSessionFollowupAdmissionError(
      'reconciliation_required',
      'TriggerTurn funding Run is unavailable.',
    );
  if (ledger.runId !== input.fundingRunId)
    fail('reconciliation_required', 'TriggerTurn funding Run identity changed.');
  const backup = ledger.reservations[input.backupReservationId];
  if (!backup)
    throw new CrossSessionFollowupAdmissionError(
      'reconciliation_required',
      'TriggerTurn slot backup is unavailable.',
    );
  if (
    backup.reservationId !== input.backupReservationId ||
    backup.runId !== input.fundingRunId ||
    backup.invocationId !== input.submissionId ||
    backup.resourceKind !== 'subagent' ||
    backup.executableUpperBound.gauges.activeSubagents !== 1 ||
    Object.values(ledger.reservations).some((item) => item.state === 'unknown')
  )
    fail('reconciliation_required', 'TriggerTurn slot funding is unavailable or unknown.');
  if (backup.state === 'reserved') return { status: 'already_acquired' };
  if (backup.state !== 'queued')
    fail('reconciliation_required', 'TriggerTurn slot backup is no longer queued.');
  const event: ChildSlotEvent = {
    type: 'resource_budget.child_slot_acquired',
    reservationId: input.backupReservationId,
  };
  try {
    reduceResourceBudgetState(ledger, event);
  } catch (error) {
    if (
      committedResourceUsage(ledger).gauges.activeSubagents + 1 >
      ledger.budget.maxConcurrentSubagents
    )
      return { status: 'waiting' };
    fail('budget_exhausted', error instanceof Error ? error.message : String(error));
  }
  return { status: 'ready', event };
}
const nonempty = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const policyFields = [
  'phaseCeiling',
  'authorizationDigest',
  'admissionDigest',
  'effectiveEffectsDigest',
  'capabilityDigest',
  'workspaceDigest',
  'policyRevision',
  'interactionModeRevision',
  'boundedContext',
  'contextWindowTokens',
  'maxOutputTokens',
  'firstAttemptTimeoutMs',
] as const;
const counterFields = [
  'turns',
  'modelRequests',
  'toolInvocations',
  'inputTokens',
  'outputTokens',
  'artifactBytes',
] as const;
const gaugeFields = [
  'elapsedRunMs',
  'activeSubagents',
  'activeWriters',
  'activeToolInvocations',
  'activeShellInvocations',
] as const;

function sameUsage(left: ResourceUsage, right: ResourceUsage): boolean {
  return (
    left.source === right.source &&
    left.estimatorVersion === right.estimatorVersion &&
    counterFields.every((field) => left.counters[field] === right.counters[field]) &&
    gaugeFields.every((field) => left.gauges[field] === right.gauges[field])
  );
}

function assertPolicy(policy: CrossSessionFollowupPolicy, state: AgentState): void {
  const phase = getAgentPhase(getActivePlanning(state));
  if (
    (policy.phaseCeiling !== 'planning' && policy.phaseCeiling !== 'building') ||
    phase !== policy.phaseCeiling ||
    policy.boundedContext !== true ||
    !nonempty(policy.authorizationDigest) ||
    !nonempty(policy.admissionDigest) ||
    !nonempty(policy.effectiveEffectsDigest) ||
    !nonempty(policy.policyRevision) ||
    !nonempty(policy.workspaceDigest) ||
    policy.capabilityDigest !== state.capabilities.catalogRevision ||
    policy.workspaceDigest !== state.session.canonicalWorkspaceDigest ||
    policy.interactionModeRevision !== state.interactionModeRevision ||
    !positive(policy.contextWindowTokens) ||
    !positive(policy.maxOutputTokens) ||
    policy.contextWindowTokens <= policy.maxOutputTokens ||
    !positive(policy.firstAttemptTimeoutMs)
  )
    fail('policy_changed', 'TriggerTurn policy evidence is incomplete or stale.');
}

function assertNoUnknown(state: AgentState, fundingRunId: string): void {
  const ledger =
    fundingBudgetForRun(state, fundingRunId) ??
    fail('budget_unconfigured', 'Funding Run has no active or retained budget ledger.');
  if (Object.values(ledger.reservations).some((reservation) => reservation.state === 'unknown'))
    fail('reconciliation_required', 'Funding ledger contains an unknown reservation.');
}

function receiptFirst<Receipt>(
  preflight: CrossSessionReceiptPreflight<Receipt>,
  requestDigest: string,
): { readonly status: 'replay'; readonly receipt: Receipt } | null {
  if (preflight.status === 'conflict')
    fail('receipt_conflict', 'The exact command receipt has a different request digest.');
  if (preflight.status === 'exact') {
    if (!nonempty(requestDigest) || preflight.requestDigest !== requestDigest)
      fail('receipt_conflict', 'The exact command receipt has a different request digest.');
    return { status: 'replay', receipt: preflight.receipt };
  }
  return null;
}

/** Plan the source-owned backup. The caller commits its event with mail and command receipt. */
export function planCrossSessionTriggerTurnBackup<Receipt>(input: {
  readonly sourceState: AgentState;
  readonly trustedCurrentRunId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly requestDigest: string;
  readonly receipt: CrossSessionReceiptPreflight<Receipt>;
  readonly policy: CrossSessionFollowupPolicy;
  readonly nowMs: number;
}):
  | { readonly status: 'replay'; readonly receipt: Receipt }
  | {
      readonly status: 'planned';
      readonly admission: CrossSessionFollowupAdmission;
      readonly reservationEvent: ReservedEvent;
    } {
  const replay = receiptFirst(input.receipt, input.requestDigest);
  if (replay) return replay;
  const state = input.sourceState;
  if (
    !nonempty(input.sourceSessionId) ||
    !nonempty(input.targetSessionId) ||
    input.sourceSessionId === input.targetSessionId ||
    state.session.threadId !== input.sourceSessionId ||
    !nonempty(input.submissionId) ||
    !nonempty(input.requestDigest) ||
    !nonempty(input.trustedCurrentRunId)
  )
    fail('source_mismatch', 'TriggerTurn source or target Session identity is invalid.');
  assertPolicy(input.policy, state);
  const fundingRunId = input.trustedCurrentRunId;
  const ledger = state.resourceBudget;
  if (ledger.status !== 'active')
    throw new CrossSessionFollowupAdmissionError(
      'budget_unconfigured',
      'The current source Run has no active funding ledger.',
    );
  if (ledger.runId !== fundingRunId)
    fail('budget_unconfigured', 'The current source Run does not own the funding ledger.');
  assertNoUnknown(state, fundingRunId);
  const deadlineAt = Date.parse(ledger.deadlineAt);
  const minimumWindow = Math.max(60_000, input.policy.firstAttemptTimeoutMs + 5_000);
  if (
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isFinite(deadlineAt) ||
    !Number.isSafeInteger(minimumWindow) ||
    deadlineAt - input.nowMs < minimumWindow
  )
    fail('budget_exhausted', 'Funding Run deadline leaves no bounded first attempt.');
  const inputTokens = 2 * (input.policy.contextWindowTokens - input.policy.maxOutputTokens);
  if (!Number.isSafeInteger(inputTokens))
    fail('budget_exhausted', 'TriggerTurn input envelope exceeds safe integer bounds.');
  const upper = createZeroResourceUsage(
    'versioned_upper_bound',
    'cross-session-followup-backup-v1',
  );
  upper.counters.turns = 1;
  upper.counters.modelRequests = 1;
  upper.counters.inputTokens = inputTokens;
  upper.counters.outputTokens = input.policy.maxOutputTokens;
  upper.gauges.activeSubagents = 1;
  const backupReservationId = identity('backup', [input.submissionId, fundingRunId]);
  const owned = [
    ...(state.resourceBudget.status === 'active' ? [state.resourceBudget] : []),
    ...Object.values(state.retainedResourceBudgets),
  ];
  if (owned.some((item) => item.reservations[backupReservationId]))
    fail('reconciliation_required', 'Backup reservation identity is already owned.');
  const reservationEvent: ReservedEvent = {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: backupReservationId,
      runId: fundingRunId,
      invocationId: input.submissionId,
      resourceKind: 'subagent',
      executableUpperBound: upper,
      state: 'queued',
    },
  };
  try {
    reduceResourceBudgetState(ledger, reservationEvent);
  } catch (error) {
    fail('budget_exhausted', error instanceof Error ? error.message : String(error));
  }
  return {
    status: 'planned',
    admission: {
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      sourceRunId: fundingRunId,
      submissionId: input.submissionId,
      fundingRunId,
      backupReservationId,
      deadlineAt,
      executableUpperBound: upper,
      policy: input.policy,
    },
    reservationEvent,
  };
}

/** Validate the first verified child Surface against its original source-funded backup. */
export function planCrossSessionFirstModelReplacement<Receipt>(input: {
  readonly fundingState: AgentState;
  readonly targetState: AgentState;
  readonly admission: CrossSessionFollowupAdmission;
  readonly receipt: CrossSessionReceiptPreflight<Receipt>;
  readonly requestDigest: string;
  readonly frozenSurface: Readonly<{
    invocationId: string;
    artifactId: string;
    integrityIdentifier: string;
    inputTokens: number;
    maxOutputTokens: number;
    verified: true;
  }>;
  readonly currentPolicy: CrossSessionFollowupPolicy;
  readonly targetPolicyProof?: CrossSessionTargetFollowupPolicyProof;
  readonly nowMs: number;
}):
  | { readonly status: 'replay'; readonly receipt: Receipt }
  | {
      readonly status: 'planned';
      readonly plan: BoundedFollowupModelResourcePlan;
      readonly fundingRunId: string;
      readonly backupReservationId: string;
    } {
  const replay = receiptFirst(input.receipt, input.requestDigest);
  if (replay) return replay;
  const { admission, fundingState, targetState, frozenSurface } = input;
  if (
    !nonempty(admission.sourceSessionId) ||
    !nonempty(admission.targetSessionId) ||
    fundingState.session.threadId !== admission.sourceSessionId ||
    targetState.session.threadId !== admission.targetSessionId ||
    admission.sourceSessionId === admission.targetSessionId ||
    admission.sourceRunId !== admission.fundingRunId
  )
    fail('source_mismatch', 'Followup funding and target Sessions do not match admission.');
  const sourcePolicyUnchanged = policyFields.every(
    (field) => input.currentPolicy[field] === admission.policy[field],
  );
  const targetProof = input.targetPolicyProof;
  const restrictedTargetIndependentlyProven =
    targetProof !== undefined &&
    targetProof.observedTargetRevision === targetState.revision &&
    targetProof.grantDigest === targetState.activeFollowupTurn?.grantDigest &&
    targetState.activeFollowupTurn?.grantRef.kind === 'agent_followup_grant' &&
    targetProof.capabilityDigest === targetState.capabilities.catalogRevision &&
    targetProof.interactionModeRevision === targetState.interactionModeRevision &&
    targetProof.phaseCeiling === getAgentPhase(getActivePlanning(targetState)) &&
    targetProof.mode === targetState.mode &&
    targetProof.mode === admission.policy.interactionMode &&
    targetProof.workspaceAccess === targetState.workspaceAccess &&
    targetProof.workspaceAccess === admission.policy.workspaceAccess &&
    targetState.session.canonicalWorkspaceDigest === admission.policy.workspaceDigest &&
    (admission.policy.phaseCeiling !== 'planning' || targetProof.phaseCeiling === 'planning') &&
    targetProof.denyTools === true &&
    Array.isArray(targetProof.allowedTools) &&
    targetProof.allowedTools.length === 0 &&
    targetState.resourceBudget.status === 'active' &&
    targetState.resourceBudget.budget.maxToolInvocations === 0 &&
    targetState.resourceBudget.budget.maxArtifactBytes === 0 &&
    targetState.resourceBudget.budget.maxConcurrentSubagents === 0 &&
    targetState.resourceBudget.budget.maxConcurrentToolInvocations === 0 &&
    targetState.resourceBudget.budget.maxConcurrentShellInvocations === 0;
  if (!sourcePolicyUnchanged || !restrictedTargetIndependentlyProven)
    fail('policy_changed', 'First child model policy exceeds immutable TriggerTurn authority.');
  if (
    frozenSurface.verified !== true ||
    !nonempty(frozenSurface.invocationId) ||
    !/^pa_[a-f0-9]{64}$/u.test(frozenSurface.artifactId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(frozenSurface.integrityIdentifier) ||
    !Number.isSafeInteger(frozenSurface.inputTokens) ||
    frozenSurface.inputTokens < 0 ||
    !positive(frozenSurface.maxOutputTokens)
  )
    fail('surface_unverified', 'First model Surface lacks exact verified bounds.');
  if (frozenSurface.maxOutputTokens > admission.policy.maxOutputTokens)
    fail('budget_exhausted', 'First model output exceeds the accepted context ceiling.');
  const ledger =
    fundingBudgetForRun(fundingState, admission.fundingRunId) ??
    fail('budget_unconfigured', 'Original funding Run ledger is unavailable.');
  assertNoUnknown(fundingState, admission.fundingRunId);
  if (
    !Number.isSafeInteger(admission.deadlineAt) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs >= admission.deadlineAt ||
    Date.parse(ledger.deadlineAt) !== admission.deadlineAt
  )
    fail('budget_exhausted', 'Original funding deadline is stale or elapsed.');
  const backup =
    ledger.reservations[admission.backupReservationId] ??
    fail('reconciliation_required', 'Held backup reservation is unavailable.');
  const targetBudget =
    targetState.resourceBudget.status === 'active'
      ? targetState.resourceBudget
      : fail('budget_unconfigured', 'Target followup Run ceiling is unavailable.');
  if (targetBudget.runId !== targetState.activeFollowupTurn?.targetRunId)
    fail('budget_unconfigured', 'Target followup Run ceiling is unavailable.');
  if (
    backup.state !== 'reserved' ||
    backup.resourceKind !== 'subagent' ||
    backup.runId !== admission.fundingRunId ||
    backup.parentReservationId !== undefined ||
    backup.invocationId !== admission.submissionId ||
    !sameUsage(backup.executableUpperBound, admission.executableUpperBound)
  )
    fail('reconciliation_required', 'Held backup no longer matches its immutable admission.');
  assertResourceUsage(admission.executableUpperBound);
  const turnReservationId = identity('followup_turn', [
    admission.submissionId,
    frozenSurface.invocationId,
  ]);
  const replacementReservationId = identity('followup_model', [
    admission.submissionId,
    frozenSurface.invocationId,
  ]);
  let plan!: BoundedFollowupModelResourcePlan;
  try {
    plan = planBoundedFollowupModelResource(fundingState, {
      fundingRunId: admission.fundingRunId,
      fundingDeadlineAt: ledger.deadlineAt,
      backupReservationId: admission.backupReservationId,
      turnReservationId,
      replacementReservationId,
      invocationId: frozenSurface.invocationId,
      inputTokens: frozenSurface.inputTokens,
      minimumInputTokensUpperBound: targetBudget.budget.maxRunInputTokens,
      requestedMaxOutputTokens: frozenSurface.maxOutputTokens,
      now: new Date(input.nowMs),
    });
  } catch (error) {
    fail('budget_exhausted', error instanceof Error ? error.message : String(error));
  }
  return {
    status: 'planned',
    plan,
    fundingRunId: admission.fundingRunId,
    backupReservationId: admission.backupReservationId,
  };
}
