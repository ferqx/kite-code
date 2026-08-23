import { sha256Hex } from './hash';
import { hasActiveUnresolvedToolFailures, isToolRecoveryQualityBlocked } from './recovery';
import type {
  AgentState,
  AgentToolCallState,
  PlanCompletionEvidence,
  PlanDocument,
  PlanningState,
  PlanStep,
} from './state';

export const COMPLETION_GUARD_UNPLANNED_VERSION = 'completion_guard_v1' as const;
export const COMPLETION_GUARD_PLANNED_VERSION = 'completion_guard_v2' as const;
export type CompletionGuardVersion =
  | typeof COMPLETION_GUARD_UNPLANNED_VERSION
  | typeof COMPLETION_GUARD_PLANNED_VERSION;

export const COMPLETION_BLOCKER_CODES = [
  'interaction_pending',
  'tool_pending',
  'subagent_suspended',
  'unknown_external_invocation',
  'skill_active',
  'planning_empty',
  'plan_draft_pending',
  'plan_review_pending',
  'plan_execution_incomplete',
  'verification_required',
  'effect_evidence_required',
  'plan_evidence_unresolved',
  'plan_cancelled',
] as const;
export type CompletionBlockerCode = (typeof COMPLETION_BLOCKER_CODES)[number];

export function isCompletionBlockerCode(value: unknown): value is CompletionBlockerCode {
  return (
    typeof value === 'string' && (COMPLETION_BLOCKER_CODES as readonly string[]).includes(value)
  );
}

export type CompletionNextAction =
  | 'wait_for_interaction'
  | 'wait_for_tool'
  | 'wait_for_subagent'
  | 'reconcile_invocation'
  | 'complete_skill'
  | 'save_plan'
  | 'submit_plan'
  | 'wait_for_review'
  | 'complete_plan'
  | 'complete_verification'
  | 'record_effect_evidence'
  | 'resolve_plan_evidence'
  | 'start_new_task';

export interface PlanIdentity {
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
}

export interface UnplannedCompletionGuardAccepted {
  readonly status: 'accepted';
  readonly version: typeof COMPLETION_GUARD_UNPLANNED_VERSION;
}
export interface PlannedCompletionGuardAccepted {
  readonly status: 'accepted';
  readonly version: typeof COMPLETION_GUARD_PLANNED_VERSION;
  readonly planIdentity: PlanIdentity;
}
export type CompletionGuardAccepted =
  | UnplannedCompletionGuardAccepted
  | PlannedCompletionGuardAccepted;

interface CompletionGuardBlockedBase {
  readonly status: 'blocked';
  readonly code: CompletionBlockerCode;
  readonly nextAction: CompletionNextAction;
  readonly planning: PlanningState['kind'];
  readonly correctionAttempt: number;
  readonly canCorrect: boolean;
}
export interface UnplannedCompletionGuardBlocked extends CompletionGuardBlockedBase {
  readonly version: typeof COMPLETION_GUARD_UNPLANNED_VERSION;
}
export interface PlannedCompletionGuardBlocked extends CompletionGuardBlockedBase {
  readonly version: typeof COMPLETION_GUARD_PLANNED_VERSION;
  readonly planIdentity: PlanIdentity;
}
export type CompletionGuardBlocked =
  | UnplannedCompletionGuardBlocked
  | PlannedCompletionGuardBlocked;
export type CompletionGuardDecision = CompletionGuardAccepted | CompletionGuardBlocked;
export type UnplannedCompletionGuardDecision =
  | UnplannedCompletionGuardAccepted
  | UnplannedCompletionGuardBlocked;
export type PlannedCompletionGuardDecision =
  | PlannedCompletionGuardAccepted
  | PlannedCompletionGuardBlocked;

const NON_TERMINAL_TOOL_STATUSES = new Set<AgentToolCallState['status']>([
  'queued',
  'awaiting_user_input',
  'awaiting_review',
  'awaiting_approval',
  'awaiting_auto_review',
  'approved',
  'running',
]);
const TERMINAL_TOOL_STATUSES = new Set<AgentToolCallState['status']>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const SAFE_STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function normalizePlanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function planStructuralDigest(
  document: Pick<PlanDocument, 'title' | 'bodyMarkdown' | 'steps'>,
): string {
  return sha256Hex(
    JSON.stringify({
      title: normalizePlanText(document.title),
      bodyMarkdown: normalizePlanText(document.bodyMarkdown),
      steps: document.steps.map(({ id, title }) => ({ id, title: normalizePlanText(title) })),
    }),
  );
}

function isPlanStep(value: unknown): value is PlanStep {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, 'note')
    ? ['id', 'title', 'status', 'note']
    : ['id', 'title', 'status'];
  return (
    hasExactKeys(value, keys) &&
    typeof value.id === 'string' &&
    SAFE_STEP_ID.test(value.id) &&
    typeof value.title === 'string' &&
    value.title === value.title.trim() &&
    value.title.length >= 1 &&
    value.title.length <= 160 &&
    !/[\r\n]/u.test(value.title) &&
    (value.status === 'pending' ||
      value.status === 'in_progress' ||
      value.status === 'completed' ||
      value.status === 'skipped') &&
    (value.note === undefined || typeof value.note === 'string')
  );
}

function isPlanCompletionEvidence(value: unknown): value is PlanCompletionEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'verification', 'execution', 'skipped', 'unresolved']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.verification) ||
    !Array.isArray(value.execution) ||
    !Array.isArray(value.skipped) ||
    !Array.isArray(value.unresolved)
  ) {
    return false;
  }
  return (
    value.verification.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['verificationId', 'outcome']) &&
        typeof entry.verificationId === 'string' &&
        SAFE_REFERENCE.test(entry.verificationId) &&
        (entry.outcome === 'passed' || entry.outcome === 'waived'),
    ) &&
    value.execution.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['toolCallId', 'outcome']) &&
        typeof entry.toolCallId === 'string' &&
        SAFE_REFERENCE.test(entry.toolCallId) &&
        entry.outcome === 'succeeded',
    ) &&
    value.skipped.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['stepId', 'reasonCode']) &&
        typeof entry.stepId === 'string' &&
        SAFE_REFERENCE.test(entry.stepId) &&
        typeof entry.reasonCode === 'string' &&
        SAFE_REASON_CODE.test(entry.reasonCode),
    ) &&
    value.unresolved.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['kind', 'referenceId']) &&
        (entry.kind === 'failure' || entry.kind === 'approval') &&
        typeof entry.referenceId === 'string' &&
        SAFE_REFERENCE.test(entry.referenceId),
    )
  );
}

function isPlanArtifactRef(value: unknown, plan: PlanDocument): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'taskId',
      'planId',
      'version',
      'fileName',
      'relativePath',
      'displayPath',
      'structuralDigest',
      'byteLength',
    ])
  )
    return false;
  return (
    value.artifactId === `${plan.planId}:v${plan.version}` &&
    typeof value.taskId === 'string' &&
    SAFE_SEGMENT.test(value.taskId) &&
    value.planId === plan.planId &&
    value.version === plan.version &&
    value.fileName === `v${plan.version}.md` &&
    typeof value.relativePath === 'string' &&
    value.relativePath.length > 0 &&
    typeof value.displayPath === 'string' &&
    value.displayPath.length > 0 &&
    value.structuralDigest === plan.structuralDigest &&
    Number.isInteger(value.byteLength) &&
    (value.byteLength as number) >= 0
  );
}

function isPlanDocument(value: unknown): value is PlanDocument {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'planSchemaVersion',
      'planId',
      'version',
      'title',
      'bodyMarkdown',
      'steps',
      'structuralDigest',
      'createdAtTurnId',
      'updatedAtTurnId',
      'supersedesPlanVersion',
      'replanReason',
      'completionEvidence',
      'artifact',
    ]) ||
    value.planSchemaVersion !== 2 ||
    typeof value.planId !== 'string' ||
    !SAFE_SEGMENT.test(value.planId) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.title !== 'string' ||
    value.title !== value.title.trim() ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    /[\r\n]/u.test(value.title) ||
    typeof value.bodyMarkdown !== 'string' ||
    value.bodyMarkdown !== value.bodyMarkdown.trim() ||
    value.bodyMarkdown.length < 20 ||
    value.bodyMarkdown.length > 30_000 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 12 ||
    !value.steps.every(isPlanStep) ||
    new Set(value.steps.map((step) => (step as PlanStep).id)).size !== value.steps.length ||
    typeof value.structuralDigest !== 'string' ||
    !SHA256_DIGEST.test(value.structuralDigest) ||
    typeof value.createdAtTurnId !== 'string' ||
    value.createdAtTurnId.length < 1 ||
    typeof value.updatedAtTurnId !== 'string' ||
    value.updatedAtTurnId.length < 1 ||
    !isPlanCompletionEvidence(value.completionEvidence) ||
    (value.supersedesPlanVersion !== undefined &&
      (!Number.isInteger(value.supersedesPlanVersion) ||
        (value.supersedesPlanVersion as number) < 1)) ||
    (value.replanReason !== undefined &&
      (typeof value.replanReason !== 'string' || value.replanReason.length > 500))
  ) {
    return false;
  }
  const plan = value as unknown as PlanDocument;
  return (
    planStructuralDigest(plan) === plan.structuralDigest &&
    (value.artifact === undefined || isPlanArtifactRef(value.artifact, plan))
  );
}

function activePlanning(state: AgentState): PlanningState {
  return state.activeTaskId != null && state.tasks[state.activeTaskId] != null
    ? state.tasks[state.activeTaskId]!.planning
    : { kind: 'building_without_plan' };
}

function toolCallBelongsToCurrentWork(state: AgentState, call: AgentToolCallState): boolean {
  return call.taskId != null
    ? call.taskId === state.activeTaskId
    : call.createdAtTurnId === state.turn.turnId;
}

function belongsToActiveTask(state: AgentState, value: { readonly taskId?: string }): boolean {
  return value.taskId == null || state.activeTaskId == null || value.taskId === state.activeTaskId;
}

function hasCurrentNonTerminalTool(state: AgentState): boolean {
  return Object.values(state.tools.calls).some(
    (call) =>
      toolCallBelongsToCurrentWork(state, call) && NON_TERMINAL_TOOL_STATUSES.has(call.status),
  );
}

function hasCurrentSuspendedSubagent(state: AgentState): boolean {
  return Object.keys(state.suspendedSubagents).some((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.name === 'task' &&
      !TERMINAL_TOOL_STATUSES.has(call.status) &&
      toolCallBelongsToCurrentWork(state, call)
    );
  });
}

function activeSkillFramesForCurrentWork(state: AgentState): boolean {
  return Object.values(state.skills.frames).some(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
}

function samePlanIdentity(left: PlanIdentity | undefined, right: PlanIdentity): boolean {
  return (
    left?.planId === right.planId &&
    left.version === right.version &&
    left.structuralDigest === right.structuralDigest
  );
}

function unplannedCorrectionAttempt(state: AgentState): number {
  return state.completionGuard.guardVersion === COMPLETION_GUARD_PLANNED_VERSION
    ? 1
    : state.completionGuard.correctionAttempts + 1;
}

function plannedCorrectionAttempt(state: AgentState, planIdentity: PlanIdentity): number {
  return state.completionGuard.guardVersion === COMPLETION_GUARD_PLANNED_VERSION &&
    samePlanIdentity(state.completionGuard.planIdentity, planIdentity)
    ? state.completionGuard.correctionAttempts + 1
    : 1;
}

function blockedUnplannedCompletion(
  state: AgentState,
  planning: PlanningState['kind'],
  code: CompletionBlockerCode,
  nextAction: CompletionNextAction,
): UnplannedCompletionGuardBlocked {
  const correctionAttempt = unplannedCorrectionAttempt(state);
  const current = activePlanning(state);
  const reviewedDraftCanPause =
    code === 'plan_draft_pending' &&
    current.kind === 'planning_draft' &&
    current.revisionFeedback != null;
  return {
    status: 'blocked',
    version: COMPLETION_GUARD_UNPLANNED_VERSION,
    code,
    nextAction,
    planning,
    correctionAttempt,
    canCorrect: correctionAttempt === 1 && !reviewedDraftCanPause,
  };
}

function blockedPlannedCompletion(
  state: AgentState,
  planning: PlanningState['kind'],
  planIdentity: PlanIdentity,
  code: CompletionBlockerCode,
  nextAction: CompletionNextAction,
): PlannedCompletionGuardBlocked {
  const correctionAttempt = plannedCorrectionAttempt(state, planIdentity);
  const current = activePlanning(state);
  const reviewedDraftCanPause =
    code === 'plan_draft_pending' &&
    current.kind === 'planning_draft' &&
    current.revisionFeedback != null;
  return {
    status: 'blocked',
    version: COMPLETION_GUARD_PLANNED_VERSION,
    code,
    nextAction,
    planning,
    planIdentity,
    correctionAttempt,
    canCorrect: correctionAttempt === 1 && !reviewedDraftCanPause,
  };
}

function commonBlocker(state: AgentState): UnplannedCompletionGuardBlocked | undefined {
  const planning = activePlanning(state).kind;
  if (state.interactions.kind !== 'idle')
    return blockedUnplannedCompletion(
      state,
      planning,
      'interaction_pending',
      'wait_for_interaction',
    );
  if (hasCurrentNonTerminalTool(state))
    return blockedUnplannedCompletion(state, planning, 'tool_pending', 'wait_for_tool');
  if (hasCurrentSuspendedSubagent(state))
    return blockedUnplannedCompletion(state, planning, 'subagent_suspended', 'wait_for_subagent');
  if (
    Object.values(state.capabilities.invocations).some(
      (invocation) => invocation.status === 'unknown',
    )
  )
    return blockedUnplannedCompletion(
      state,
      planning,
      'unknown_external_invocation',
      'reconcile_invocation',
    );
  if (activeSkillFramesForCurrentWork(state))
    return blockedUnplannedCompletion(state, planning, 'skill_active', 'complete_skill');
  return undefined;
}

export function decideUnplannedCompletion(state: AgentState): UnplannedCompletionGuardDecision {
  const planning = activePlanning(state);
  const common = commonBlocker(state);
  if (common) return common;
  switch (planning.kind) {
    case 'building_without_plan':
    case 'completed':
      return { status: 'accepted', version: COMPLETION_GUARD_UNPLANNED_VERSION };
    case 'planning_empty':
      return blockedUnplannedCompletion(state, planning.kind, 'planning_empty', 'save_plan');
    case 'planning_draft':
    case 'replanning_draft':
      return blockedUnplannedCompletion(state, planning.kind, 'plan_draft_pending', 'submit_plan');
    case 'awaiting_review':
      return blockedUnplannedCompletion(
        state,
        planning.kind,
        'plan_review_pending',
        'wait_for_review',
      );
    case 'executing':
      return blockedUnplannedCompletion(
        state,
        planning.kind,
        'plan_execution_incomplete',
        'complete_plan',
      );
    case 'cancelled':
      return blockedUnplannedCompletion(state, planning.kind, 'plan_cancelled', 'start_new_task');
  }
}

function isResolvedRecoveryFailure(state: AgentState, call: AgentToolCallState): boolean {
  const failureInstanceId = call.outcome?.lineage?.failureInstanceId;
  return (
    failureInstanceId != null &&
    state.toolRecovery.failures[failureInstanceId]?.status === 'recovered'
  );
}

function relevantEffectCalls(state: AgentState): AgentToolCallState[] {
  return Object.values(state.tools.calls).filter(
    (call) =>
      call.sideEffect === true &&
      belongsToActiveTask(state, call) &&
      (call.status === 'succeeded' || !isResolvedRecoveryFailure(state, call)),
  );
}

function relevantPendingCalls(state: AgentState): AgentToolCallState[] {
  return Object.values(state.tools.calls).filter(
    (call) =>
      belongsToActiveTask(state, call) &&
      [
        'awaiting_user_input',
        'awaiting_review',
        'awaiting_approval',
        'awaiting_auto_review',
      ].includes(call.status),
  );
}

export function projectPlanCompletionEvidence(
  state: AgentState,
  steps: readonly PlanStep[],
  skippedReasonCodes: Readonly<Record<string, string>> = {},
): PlanCompletionEvidence {
  const planning = activePlanning(state);
  const previous = planning.kind === 'executing' ? planning.document.completionEvidence : undefined;
  const priorSkipped = new Map(
    (previous?.skipped ?? []).map((entry) => [entry.stepId, entry.reasonCode]),
  );
  const verification = Object.values(state.verification.records)
    .filter(
      (record) =>
        belongsToActiveTask(state, record) &&
        (record.status === 'passed' || record.status === 'waived'),
    )
    .map((record) => ({
      verificationId: record.verificationId,
      outcome: record.status as 'passed' | 'waived',
    }))
    .sort((left, right) => left.verificationId.localeCompare(right.verificationId));
  const execution = relevantEffectCalls(state)
    .filter((call) => call.status === 'succeeded' && call.result?.ok === true)
    .map((call) => ({ toolCallId: call.toolCallId, outcome: 'succeeded' as const }))
    .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
  const unresolved = Object.values(state.tools.calls)
    .filter((call) => belongsToActiveTask(state, call))
    .reduce<Array<PlanCompletionEvidence['unresolved'][number]>>((entries, call) => {
      if (call.status === 'awaiting_approval')
        entries.push({ kind: 'approval', referenceId: call.toolCallId });
      if (
        ['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status) &&
        call.sideEffect === true &&
        !isResolvedRecoveryFailure(state, call)
      ) {
        entries.push({ kind: 'failure', referenceId: call.toolCallId });
      }
      return entries;
    }, [])
    .sort((left, right) =>
      `${left.kind}:${left.referenceId}`.localeCompare(`${right.kind}:${right.referenceId}`),
    );
  const skipped = steps
    .filter((step) => step.status === 'skipped')
    .map((step) => ({
      stepId: step.id,
      reasonCode: skippedReasonCodes[step.id] ?? priorSkipped.get(step.id) ?? '',
    }))
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
  return { schemaVersion: 1, verification, execution, skipped, unresolved };
}

export type PlanCompletionBlocker =
  | 'plan_verification_required'
  | 'plan_effect_evidence_required'
  | 'plan_unresolved_blocker'
  | 'plan_skipped_reason_required';

export function planCompletionBlocker(
  state: AgentState,
  evidence: PlanCompletionEvidence,
): PlanCompletionBlocker | null {
  if (state.interactions.kind !== 'idle' || relevantPendingCalls(state).length > 0)
    return 'plan_unresolved_blocker';
  if (
    Object.values(state.verification.records).some(
      (record) =>
        belongsToActiveTask(state, record) &&
        record.mode === 'required' &&
        record.status !== 'passed' &&
        record.status !== 'waived',
    )
  )
    return 'plan_verification_required';
  if (evidence.skipped.some((entry) => !SAFE_REASON_CODE.test(entry.reasonCode)))
    return 'plan_skipped_reason_required';
  if (evidence.unresolved.length > 0) return 'plan_unresolved_blocker';
  const effectCalls = relevantEffectCalls(state);
  const activeTask = state.activeTaskId == null ? undefined : state.tasks[state.activeTaskId];
  if (
    (activeTask?.sideEffectsStarted === true && evidence.execution.length === 0) ||
    effectCalls.some(
      (call) =>
        call.status !== 'succeeded' ||
        call.result?.ok !== true ||
        !evidence.execution.some((entry) => entry.toolCallId === call.toolCallId),
    )
  )
    return 'plan_effect_evidence_required';
  return null;
}

export function planCompletionEvidenceMatchesRuntime(
  state: AgentState,
  steps: readonly PlanStep[],
  evidence: PlanCompletionEvidence,
): boolean {
  if (!isPlanCompletionEvidence(evidence)) return false;
  const reasonCodes = Object.fromEntries(
    evidence.skipped.map((entry) => [entry.stepId, entry.reasonCode]),
  );
  return (
    JSON.stringify(projectPlanCompletionEvidence(state, steps, reasonCodes)) ===
    JSON.stringify(evidence)
  );
}

export function emptyPlanCompletionEvidence(): PlanCompletionEvidence {
  return {
    schemaVersion: 1,
    verification: [],
    execution: [],
    skipped: [],
    unresolved: [],
  };
}

function plannedEvidenceBlocker(
  state: AgentState,
  document: PlanDocument,
): Pick<PlannedCompletionGuardBlocked, 'code' | 'nextAction'> | null {
  const evidence = document.completionEvidence;
  if (
    Object.values(state.verification.records).some((record) => {
      const belongs =
        record.taskId == null || state.activeTaskId == null || record.taskId === state.activeTaskId;
      if (!belongs || record.mode !== 'required') return false;
      if (record.status !== 'passed' && record.status !== 'waived') return true;
      return !evidence.verification.some(
        (entry) =>
          entry.verificationId === record.verificationId && entry.outcome === record.status,
      );
    })
  )
    return { code: 'verification_required', nextAction: 'complete_verification' };
  const blocker = planCompletionBlocker(state, evidence);
  if (blocker === 'plan_verification_required')
    return { code: 'verification_required', nextAction: 'complete_verification' };
  if (
    blocker === 'plan_effect_evidence_required' ||
    !planCompletionEvidenceMatchesRuntime(state, document.steps, evidence)
  )
    return { code: 'effect_evidence_required', nextAction: 'record_effect_evidence' };
  if (blocker === 'plan_unresolved_blocker' || blocker === 'plan_skipped_reason_required')
    return { code: 'plan_evidence_unresolved', nextAction: 'resolve_plan_evidence' };
  return null;
}

/** Monotonic V2 completion decision for a canonical PlanDocument V2 lifecycle. */
export function decidePlannedCompletion(state: AgentState): PlannedCompletionGuardDecision {
  const planning = activePlanning(state);
  if (!('document' in planning) || planning.document == null)
    throw new Error('CompletionGuard V2 requires a PlanDocument V2.');
  const document = planning.document;
  const planIdentity = {
    planId: document.planId,
    version: document.version,
    structuralDigest: document.structuralDigest,
  };
  const block = (code: CompletionBlockerCode, nextAction: CompletionNextAction) =>
    blockedPlannedCompletion(state, planning.kind, planIdentity, code, nextAction);

  if (state.interactions.kind !== 'idle')
    return block('interaction_pending', 'wait_for_interaction');
  if (hasCurrentNonTerminalTool(state)) return block('tool_pending', 'wait_for_tool');
  if (hasCurrentSuspendedSubagent(state)) return block('subagent_suspended', 'wait_for_subagent');
  if (
    Object.values(state.capabilities.invocations).some(
      (invocation) => invocation.status === 'unknown',
    )
  )
    return block('unknown_external_invocation', 'reconcile_invocation');
  if (activeSkillFramesForCurrentWork(state)) return block('skill_active', 'complete_skill');
  if (
    isToolRecoveryQualityBlocked(state.toolRecovery, {
      taskId: state.activeTaskId,
      turnId: state.turn.turnId,
    }) ||
    hasActiveUnresolvedToolFailures(state.toolRecovery, {
      taskId: state.activeTaskId,
      turnId: state.turn.turnId,
    })
  )
    return block('plan_evidence_unresolved', 'resolve_plan_evidence');
  if (!isPlanDocument(document)) return block('plan_evidence_unresolved', 'resolve_plan_evidence');

  switch (planning.kind) {
    case 'planning_draft':
    case 'replanning_draft':
      return block('plan_draft_pending', 'submit_plan');
    case 'awaiting_review':
      return block('plan_review_pending', 'wait_for_review');
    case 'executing': {
      if (document.steps.some((step) => step.status === 'pending' || step.status === 'in_progress'))
        return block('plan_execution_incomplete', 'complete_plan');
      const evidenceBlocker = plannedEvidenceBlocker(state, document);
      return evidenceBlocker
        ? block(evidenceBlocker.code, evidenceBlocker.nextAction)
        : block('plan_execution_incomplete', 'complete_plan');
    }
    case 'completed': {
      const evidenceBlocker = plannedEvidenceBlocker(state, document);
      return evidenceBlocker
        ? block(evidenceBlocker.code, evidenceBlocker.nextAction)
        : { status: 'accepted', version: COMPLETION_GUARD_PLANNED_VERSION, planIdentity };
    }
    case 'cancelled':
      return block('plan_cancelled', 'start_new_task');
  }
}

/** Select V2 only when the active lifecycle owns a PlanDocument V2-shaped document. */
export function decideCompletion(state: AgentState): CompletionGuardDecision {
  const planning = activePlanning(state);
  return 'document' in planning && planning.document != null
    ? decidePlannedCompletion(state)
    : decideUnplannedCompletion(state);
}
