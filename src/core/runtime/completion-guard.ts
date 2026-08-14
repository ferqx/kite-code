import type {
  PlanCompletionEvidenceV1,
  PlanDocument,
  PlanIdentity,
  PlanningState,
} from '@/protocol/events';
import { isPlanDocumentV2 } from './plan-document';
import { planCompletionBlocker, planCompletionEvidenceMatchesRuntime } from './plan-evidence';
import { getActivePlanning, type RuntimeState, type ToolCallStatus } from './state';
import {
  hasActiveUnresolvedToolFailuresV1,
  isToolRecoveryQualityBlockedV1,
} from './tool-recovery-journal';
import {
  activeSkillFramesForCurrentWork,
  hasCurrentSuspendedSubagent,
  toolCallBelongsToCurrentWork,
} from './work-scope';

export const COMPLETION_GUARD_V1 = 'completion_guard_v1' as const;
export const COMPLETION_GUARD_V2 = 'completion_guard_v2' as const;
export type CompletionGuardVersion = typeof COMPLETION_GUARD_V1 | typeof COMPLETION_GUARD_V2;

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

export interface CompletionGuardAcceptedV1 {
  status: 'accepted';
  version: typeof COMPLETION_GUARD_V1;
}

export interface CompletionGuardAcceptedV2 {
  status: 'accepted';
  version: typeof COMPLETION_GUARD_V2;
  planIdentity: PlanIdentity;
}

export type CompletionGuardAccepted = CompletionGuardAcceptedV1 | CompletionGuardAcceptedV2;

interface CompletionGuardBlockedBase {
  status: 'blocked';
  code: CompletionBlockerCode;
  nextAction: CompletionNextAction;
  planning: PlanningState['kind'];
  correctionAttempt: number;
  canCorrect: boolean;
}

export interface CompletionGuardBlockedV1 extends CompletionGuardBlockedBase {
  version: typeof COMPLETION_GUARD_V1;
}

export interface CompletionGuardBlockedV2 extends CompletionGuardBlockedBase {
  version: typeof COMPLETION_GUARD_V2;
  planIdentity: PlanIdentity;
}

export type CompletionGuardBlocked = CompletionGuardBlockedV1 | CompletionGuardBlockedV2;

export type CompletionGuardDecision = CompletionGuardAccepted | CompletionGuardBlocked;
export type CompletionGuardDecisionV1 = CompletionGuardAcceptedV1 | CompletionGuardBlockedV1;
export type CompletionGuardDecisionV2 = CompletionGuardAcceptedV2 | CompletionGuardBlockedV2;

const NON_TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  'queued',
  'awaiting_user_input',
  'awaiting_review',
  'awaiting_approval',
  'awaiting_auto_review',
  'approved',
  'running',
]);

function hasCurrentNonTerminalTool(state: RuntimeState): boolean {
  return Object.values(state.tools.calls).some(
    (call) =>
      toolCallBelongsToCurrentWork(state, call) && NON_TERMINAL_TOOL_STATUSES.has(call.status),
  );
}

function samePlanIdentity(left: PlanIdentity | undefined, right: PlanIdentity): boolean {
  return (
    left?.planId === right.planId &&
    left.version === right.version &&
    left.structuralDigest === right.structuralDigest
  );
}

function correctionAttemptV1(state: RuntimeState): number {
  return state.completionGuard?.guardVersion === COMPLETION_GUARD_V2
    ? 1
    : (state.completionGuard?.correctionAttempts ?? 0) + 1;
}

function correctionAttemptV2(state: RuntimeState, planIdentity: PlanIdentity): number {
  return state.completionGuard?.guardVersion === COMPLETION_GUARD_V2 &&
    samePlanIdentity(state.completionGuard.planIdentity, planIdentity)
    ? state.completionGuard.correctionAttempts + 1
    : 1;
}

function blockedV1(
  state: RuntimeState,
  planning: PlanningState['kind'],
  code: CompletionBlockerCode,
  nextAction: CompletionNextAction,
): CompletionGuardBlockedV1 {
  const correctionAttempt = correctionAttemptV1(state);
  const activePlanning = getActivePlanning(state);
  const reviewedDraftCanPause =
    code === 'plan_draft_pending' &&
    activePlanning.kind === 'planning_draft' &&
    activePlanning.revisionFeedback != null;
  return {
    status: 'blocked',
    version: COMPLETION_GUARD_V1,
    code,
    nextAction,
    planning,
    correctionAttempt,
    canCorrect: correctionAttempt === 1 && !reviewedDraftCanPause,
  };
}

function blockedV2(
  state: RuntimeState,
  planning: PlanningState['kind'],
  planIdentity: PlanIdentity,
  code: CompletionBlockerCode,
  nextAction: CompletionNextAction,
): CompletionGuardBlockedV2 {
  const correctionAttempt = correctionAttemptV2(state, planIdentity);
  const activePlanning = getActivePlanning(state);
  const reviewedDraftCanPause =
    code === 'plan_draft_pending' &&
    activePlanning.kind === 'planning_draft' &&
    activePlanning.revisionFeedback != null;
  return {
    status: 'blocked',
    version: COMPLETION_GUARD_V2,
    code,
    nextAction,
    planning,
    planIdentity,
    correctionAttempt,
    canCorrect: correctionAttempt === 1 && !reviewedDraftCanPause,
  };
}

/**
 * The canonical V1 completion decision. It deliberately uses only durable,
 * currently authoritative state; verification and recovery-evidence gates are
 * added by later decision versions rather than guessed here.
 */
export function decideCompletionV1(state: RuntimeState): CompletionGuardDecisionV1 {
  const planning = getActivePlanning(state);
  if (state.interactions.kind !== 'idle') {
    return blockedV1(state, planning.kind, 'interaction_pending', 'wait_for_interaction');
  }
  if (hasCurrentNonTerminalTool(state)) {
    return blockedV1(state, planning.kind, 'tool_pending', 'wait_for_tool');
  }
  if (hasCurrentSuspendedSubagent(state)) {
    return blockedV1(state, planning.kind, 'subagent_suspended', 'wait_for_subagent');
  }
  if (
    Object.values(state.capabilities.invocations).some(
      (invocation) => invocation.status === 'unknown',
    )
  ) {
    return blockedV1(state, planning.kind, 'unknown_external_invocation', 'reconcile_invocation');
  }
  if (activeSkillFramesForCurrentWork(state).length > 0) {
    return blockedV1(state, planning.kind, 'skill_active', 'complete_skill');
  }

  switch (planning.kind) {
    case 'building_without_plan':
    case 'completed':
      return { status: 'accepted', version: COMPLETION_GUARD_V1 };
    case 'planning_empty':
      return blockedV1(state, planning.kind, 'planning_empty', 'save_plan');
    case 'planning_draft':
    case 'replanning_draft':
      return blockedV1(state, planning.kind, 'plan_draft_pending', 'submit_plan');
    case 'awaiting_review':
      return blockedV1(state, planning.kind, 'plan_review_pending', 'wait_for_review');
    case 'executing':
      return blockedV1(state, planning.kind, 'plan_execution_incomplete', 'complete_plan');
    case 'cancelled':
      return blockedV1(state, planning.kind, 'plan_cancelled', 'start_new_task');
  }
}

function getV2PlanDocument(planning: PlanningState): PlanDocument | null {
  if (!('document' in planning) || planning.document?.planSchemaVersion !== 2) return null;
  return planning.document;
}

function identityFor(document: PlanDocument): PlanIdentity {
  return {
    planId: document.planId,
    version: document.version,
    structuralDigest: document.structuralDigest,
  };
}

const EMPTY_COMPLETION_EVIDENCE: PlanCompletionEvidenceV1 = Object.freeze({
  schemaVersion: 1,
  verification: [],
  execution: [],
  skipped: [],
  unresolved: [],
});

function v2EvidenceBlocker(
  state: RuntimeState,
  document: PlanDocument,
): Pick<CompletionGuardBlockedV2, 'code' | 'nextAction'> | null {
  const evidence = document.completionEvidence ?? EMPTY_COMPLETION_EVIDENCE;
  const requiredVerificationMissing = Object.values(state.verification.records).some((record) => {
    const belongsToActiveTask =
      record.taskId == null || state.activeTaskId == null || record.taskId === state.activeTaskId;
    if (!belongsToActiveTask || record.mode !== 'required') return false;
    if (record.status !== 'passed' && record.status !== 'waived') return true;
    return !evidence.verification.some(
      (entry) => entry.verificationId === record.verificationId && entry.outcome === record.status,
    );
  });
  if (requiredVerificationMissing) {
    return { code: 'verification_required', nextAction: 'complete_verification' };
  }
  const blocker = planCompletionBlocker(state, evidence);
  if (blocker === 'plan_verification_required') {
    return { code: 'verification_required', nextAction: 'complete_verification' };
  }
  if (
    blocker === 'plan_effect_evidence_required' ||
    document.completionEvidence === undefined ||
    !planCompletionEvidenceMatchesRuntime(state, document.steps, evidence)
  ) {
    return { code: 'effect_evidence_required', nextAction: 'record_effect_evidence' };
  }
  if (blocker === 'plan_unresolved_blocker' || blocker === 'plan_skipped_reason_required') {
    return { code: 'plan_evidence_unresolved', nextAction: 'resolve_plan_evidence' };
  }
  return null;
}

/** Monotonic V2 decision for a canonical PlanDocument V2 only. */
export function decideCompletionV2(state: RuntimeState): CompletionGuardDecisionV2 {
  const planning = getActivePlanning(state);
  const document = getV2PlanDocument(planning);
  if (!document) {
    throw new Error('CompletionGuard V2 requires a PlanDocument V2.');
  }
  const planIdentity = identityFor(document);
  const block = (code: CompletionBlockerCode, nextAction: CompletionNextAction) =>
    blockedV2(state, planning.kind, planIdentity, code, nextAction);

  if (state.interactions.kind !== 'idle') {
    return block('interaction_pending', 'wait_for_interaction');
  }
  if (hasCurrentNonTerminalTool(state)) {
    return block('tool_pending', 'wait_for_tool');
  }
  if (hasCurrentSuspendedSubagent(state)) {
    return block('subagent_suspended', 'wait_for_subagent');
  }
  if (
    Object.values(state.capabilities.invocations).some(
      (invocation) => invocation.status === 'unknown',
    )
  ) {
    return block('unknown_external_invocation', 'reconcile_invocation');
  }
  if (activeSkillFramesForCurrentWork(state).length > 0) {
    return block('skill_active', 'complete_skill');
  }
  if (
    state.toolRecovery &&
    (isToolRecoveryQualityBlockedV1(state.toolRecovery, {
      taskId: state.activeTaskId,
      turnId: state.turn.turnId,
    }) ||
      hasActiveUnresolvedToolFailuresV1(state.toolRecovery, {
        taskId: state.activeTaskId,
        turnId: state.turn.turnId,
      }))
  ) {
    return block('plan_evidence_unresolved', 'resolve_plan_evidence');
  }
  if (!isPlanDocumentV2(document)) {
    return block('plan_evidence_unresolved', 'resolve_plan_evidence');
  }

  switch (planning.kind) {
    case 'planning_draft':
    case 'replanning_draft':
      return block('plan_draft_pending', 'submit_plan');
    case 'awaiting_review':
      return block('plan_review_pending', 'wait_for_review');
    case 'executing': {
      if (
        document.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
      ) {
        return block('plan_execution_incomplete', 'complete_plan');
      }
      const evidenceBlocker = v2EvidenceBlocker(state, document);
      return evidenceBlocker
        ? block(evidenceBlocker.code, evidenceBlocker.nextAction)
        : block('plan_execution_incomplete', 'complete_plan');
    }
    case 'completed': {
      const evidenceBlocker = v2EvidenceBlocker(state, document);
      return evidenceBlocker
        ? block(evidenceBlocker.code, evidenceBlocker.nextAction)
        : { status: 'accepted', version: COMPLETION_GUARD_V2, planIdentity };
    }
    case 'cancelled':
      return block('plan_cancelled', 'start_new_task');
    case 'building_without_plan':
    case 'planning_empty':
      throw new Error('CompletionGuard V2 requires a PlanDocument V2 lifecycle.');
  }
}

/** Select V2 only when the active lifecycle owns a PlanDocument V2. */
export function decideCompletion(state: RuntimeState): CompletionGuardDecision {
  return getV2PlanDocument(getActivePlanning(state))
    ? decideCompletionV2(state)
    : decideCompletionV1(state);
}
