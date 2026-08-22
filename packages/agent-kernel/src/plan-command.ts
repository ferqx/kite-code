/**
 * Pure State25 plan-command admission.
 *
 * This module deliberately stops at the Kernel boundary.  It does not read
 * or write artifacts, construct RuntimeEvents, allocate interaction ids, or
 * invoke a Host/Builtin callback.  The caller supplies the canonical
 * planning facts and a package above the Kernel performs the resulting
 * persistence and presentation work.
 */

import type { PlanDocument, PlanningState, PlanStep } from './state';

export type PlanCommandPhaseV1 = 'planning' | 'building';

export interface PlanIdentityInputV1 {
  readonly plan_id?: string;
  readonly version?: number;
  readonly structural_digest?: string;
}

export interface PlanCommandStateFactsV1 {
  /** Absent means that no active Task owns the command. */
  readonly taskId?: string;
  readonly planning: PlanningState;
  readonly phase: PlanCommandPhaseV1;
  readonly sideEffectsStarted: boolean;
}

export interface ReadPlanCommandV1 extends PlanIdentityInputV1 {
  readonly plan_id: string;
}

export interface WritePlanCommandV1 extends PlanIdentityInputV1 {
  readonly title?: string;
  readonly body_markdown?: string;
  readonly steps?: readonly { readonly id: string; readonly title: string }[];
  readonly expected_version?: number;
  readonly replan_reason?: string;
  readonly action?: 'save' | 'submit';
}

export interface UpdatePlanCommandV1 extends PlanIdentityInputV1 {
  readonly updates: readonly {
    readonly step_id: string;
    readonly status: PlanStep['status'];
    readonly note?: string;
    readonly reason_code?: string;
  }[];
  readonly complete_plan?: boolean;
}

export type PlanCompletionBlockerV1 =
  | 'plan_verification_required'
  | 'plan_effect_evidence_required'
  | 'plan_unresolved_blocker'
  | 'plan_skipped_reason_required';

export interface PlanDecisionRejectedV1 {
  readonly accepted: false;
  readonly code: PlanDecisionCodeV1;
  /** Stable legacy diagnostic retained for the RMV1 compatibility adapter. */
  readonly diagnostic: string;
}

export interface PlanDecisionAcceptedV1<Mode extends string = string> {
  readonly accepted: true;
  readonly mode: Mode;
  readonly code: 'admitted';
}

export type PlanDecisionV1<Mode extends string = string> =
  | PlanDecisionAcceptedV1<Mode>
  | PlanDecisionRejectedV1;

export type PlanDecisionCodeV1 =
  | 'task_required'
  | 'read_plan_identity_mismatch'
  | 'read_plan_structural_digest_mismatch'
  | 'plan_identity_required'
  | 'plan_identity_mismatch'
  | 'write_plan_submit_identity_mismatch'
  | 'write_plan_side_effects_started'
  | 'write_plan_document_required'
  | 'write_plan_version_conflict'
  | 'update_plan_phase'
  | 'update_plan_requires_executing'
  | 'plan_duplicate_step_update'
  | 'plan_unknown_step'
  | 'plan_terminal_step_rollback'
  | 'plan_pending_steps'
  | 'plan_all_steps_skipped'
  | PlanCompletionBlockerV1;

export type ReadPlanDecisionV1 = PlanDecisionV1<'read_artifact'>;
export type WritePlanDecisionModeV1 =
  | 'auto_enter'
  | 'draft_save'
  | 'replan_save'
  | 'replanning_save'
  | 'submit_existing';
export type WritePlanDecisionV1 =
  | PlanDecisionAcceptedV1<WritePlanDecisionModeV1>
  | PlanDecisionRejectedV1;
export type UpdatePlanDecisionModeV1 = 'progress_update' | 'complete';
export type UpdatePlanDecisionV1 =
  | (PlanDecisionAcceptedV1<UpdatePlanDecisionModeV1> & {
      readonly nextSteps: readonly PlanStep[];
    })
  | PlanDecisionRejectedV1;

function documentForPlanning(planning: PlanningState): PlanDocument | undefined {
  switch (planning.kind) {
    case 'planning_draft':
    case 'replanning_draft':
    case 'awaiting_review':
    case 'executing':
    case 'completed':
      return planning.document;
    default:
      return undefined;
  }
}

function activeWriteDocument(planning: PlanningState): PlanDocument | undefined {
  switch (planning.kind) {
    case 'planning_draft':
    case 'replanning_draft':
    case 'executing':
      return planning.document;
    default:
      return undefined;
  }
}

function phaseForPlanning(planning: PlanningState): PlanCommandPhaseV1 {
  switch (planning.kind) {
    case 'planning_empty':
    case 'planning_draft':
    case 'replanning_draft':
    case 'awaiting_review':
      return 'planning';
    default:
      return 'building';
  }
}

function rejected(code: PlanDecisionCodeV1, diagnostic: string): PlanDecisionRejectedV1 {
  return { accepted: false, code, diagnostic };
}

function identityError(
  input: PlanIdentityInputV1,
  document: PlanDocument,
): PlanDecisionRejectedV1 | null {
  if (
    input.plan_id === undefined ||
    input.version === undefined ||
    input.structural_digest === undefined
  ) {
    return {
      accepted: false,
      code: 'plan_identity_required',
      diagnostic: 'plan_identity_required',
    };
  }
  if (
    input.plan_id !== document.planId ||
    input.version !== document.version ||
    input.structural_digest !== document.structuralDigest
  ) {
    return {
      accepted: false,
      code: 'plan_identity_mismatch',
      diagnostic: 'plan_identity_mismatch',
    };
  }
  return null;
}

/** Admit a read_plan request. Artifact lookup remains outside the Kernel. */
export function decideReadPlanCommandV1(
  facts: PlanCommandStateFactsV1,
  command: ReadPlanCommandV1,
): ReadPlanDecisionV1 {
  if (facts.taskId === undefined) {
    return rejected('task_required', 'No active Task owns this Plan.');
  }
  const document = documentForPlanning(facts.planning);
  const version = command.version ?? document?.version;
  if (!document || command.plan_id !== document.planId || version !== document.version) {
    return rejected(
      'read_plan_identity_mismatch',
      'read_plan must reference the active Task plan and its current version.',
    );
  }
  if (
    command.structural_digest !== undefined &&
    command.structural_digest !== document.structuralDigest
  ) {
    return rejected(
      'read_plan_structural_digest_mismatch',
      'read_plan structural_digest does not match the active Artifact.',
    );
  }
  return { accepted: true, mode: 'read_artifact', code: 'admitted' };
}

/**
 * Admit a write_plan request.  The result identifies the lifecycle mode that
 * the App/Builtin adapter may execute; it never writes an Artifact or emits a
 * planning event.
 */
export function decideWritePlanCommandV1(
  facts: PlanCommandStateFactsV1,
  command: WritePlanCommandV1,
): WritePlanDecisionV1 {
  if (facts.taskId === undefined) {
    return rejected('task_required', 'write_plan requires an active Task.');
  }
  const planning = facts.planning;
  const phase = facts.phase ?? phaseForPlanning(planning);
  const action = command.action ?? 'save';
  const hasDocument =
    command.title !== undefined &&
    command.body_markdown !== undefined &&
    command.steps !== undefined;
  const hasArtifact =
    command.plan_id !== undefined &&
    command.version !== undefined &&
    command.structural_digest !== undefined;
  const submitExisting = action === 'submit' && hasArtifact && !hasDocument;
  const activeDocument = activeWriteDocument(planning);
  const replanningDocumentIsSavedCanonicalRevision =
    planning.kind === 'replanning_draft' &&
    planning.document.version > planning.supersedesPlanVersion &&
    planning.document.supersedesPlanVersion === planning.supersedesPlanVersion &&
    planning.document.replanReason === planning.replanReason;

  if (activeDocument && (hasDocument || submitExisting)) {
    const error = identityError(command, activeDocument);
    if (error) return error;
  }

  const autoEnter =
    phase === 'building' &&
    planning.kind === 'building_without_plan' &&
    action === 'save' &&
    !facts.sideEffectsStarted;
  const draftWrite =
    (planning.kind === 'planning_empty' || planning.kind === 'planning_draft') &&
    hasDocument &&
    action === 'save' &&
    !facts.sideEffectsStarted;
  const replanDraftAction =
    planning.kind === 'replanning_draft' &&
    ((submitExisting && replanningDocumentIsSavedCanonicalRevision) ||
      (hasDocument && action === 'save'));
  const replan =
    phase === 'building' && planning.kind === 'executing' && hasDocument && action === 'save';
  const submitExistingAllowed =
    submitExisting &&
    (planning.kind === 'planning_draft' || replanningDocumentIsSavedCanonicalRevision) &&
    command.plan_id === planning.document.planId &&
    command.version === planning.document.version &&
    command.structural_digest === planning.document.structuralDigest;
  const sideEffectsBlock =
    !replan && hasDocument && action === 'save' && facts.sideEffectsStarted === true;

  if (!draftWrite && !replanDraftAction && !autoEnter && !replan && !submitExistingAllowed) {
    return rejected(
      submitExisting
        ? 'write_plan_submit_identity_mismatch'
        : sideEffectsBlock
          ? 'write_plan_side_effects_started'
          : 'write_plan_document_required',
      submitExisting
        ? 'submit must reference the current saved plan_id, version, and structural_digest.'
        : sideEffectsBlock
          ? 'write_plan cannot save a new plan after side effects have started.'
          : 'write_plan requires a complete plan document when saving.',
    );
  }

  if (
    !submitExistingAllowed &&
    command.expected_version != null &&
    (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
    command.expected_version !== planning.document.version
  ) {
    return rejected(
      'write_plan_version_conflict',
      `Version conflict: expected v${command.expected_version}, current is v${planning.document.version}.`,
    );
  }

  const mode: WritePlanDecisionModeV1 = autoEnter
    ? 'auto_enter'
    : draftWrite
      ? 'draft_save'
      : replanDraftAction
        ? 'replanning_save'
        : replan
          ? 'replan_save'
          : 'submit_existing';
  return { accepted: true, mode, code: 'admitted' };
}

/**
 * Admit an update_plan progress/completion request. Completion blockers are
 * supplied as canonical Kernel facts; this function never inspects a Host
 * receipt, Artifact, or provider result itself.
 */
export function decideUpdatePlanCommandV1(
  facts: PlanCommandStateFactsV1 & {
    readonly completionBlocker?: PlanCompletionBlockerV1 | null;
  },
  command: UpdatePlanCommandV1,
): UpdatePlanDecisionV1 {
  if (facts.taskId === undefined) {
    return rejected('task_required', 'No active Task owns this Plan.');
  }
  if (facts.phase !== 'building') {
    return rejected(
      'update_plan_phase',
      'update_plan is only available in building phase after plan approval.',
    );
  }
  if (facts.planning.kind !== 'executing') {
    return rejected(
      'update_plan_requires_executing',
      'No executing plan. Wait for plan approval first.',
    );
  }

  const document = facts.planning.document;
  const identity = identityError(command, document);
  if (identity) return identity;
  if (new Set(command.updates.map((update) => update.step_id)).size !== command.updates.length) {
    return rejected('plan_duplicate_step_update', 'plan_duplicate_step_update');
  }
  const unknownStep = command.updates.find(
    (update) => !document.steps.some((step) => step.id === update.step_id),
  );
  if (unknownStep) {
    return rejected('plan_unknown_step', `Unknown plan step ID: ${unknownStep.step_id}.`);
  }
  const terminalRollback = command.updates.some((update) => {
    const current = document.steps.find((step) => step.id === update.step_id);
    return (
      current != null &&
      (current.status === 'completed' || current.status === 'skipped') &&
      update.status !== current.status
    );
  });
  if (terminalRollback) {
    return rejected('plan_terminal_step_rollback', 'plan_terminal_step_rollback');
  }

  const nextSteps = document.steps.map((step) => {
    const update = command.updates.find((candidate) => candidate.step_id === step.id);
    return {
      ...step,
      status: update?.status ?? step.status,
      ...(update?.note === undefined ? {} : { note: update.note }),
    };
  });
  if (
    command.complete_plan &&
    nextSteps.some((step) => step.status === 'pending' || step.status === 'in_progress')
  ) {
    return rejected(
      'plan_pending_steps',
      'Cannot complete plan while steps are pending or in progress.',
    );
  }
  if (command.complete_plan && nextSteps.every((step) => step.status === 'skipped')) {
    return rejected('plan_all_steps_skipped', 'plan_all_steps_skipped');
  }
  if (command.complete_plan && facts.completionBlocker) {
    return rejected(facts.completionBlocker, facts.completionBlocker);
  }
  return {
    accepted: true,
    mode: command.complete_plan ? 'complete' : 'progress_update',
    code: 'admitted',
    nextSteps,
  };
}

/** State25 phase selector kept local so the decision remains Kernel-owned. */
export function planCommandPhaseV1(planning: PlanningState): PlanCommandPhaseV1 {
  return phaseForPlanning(planning);
}
