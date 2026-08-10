import { randomUUID } from 'node:crypto';
import { PlanArtifactError, type PlanArtifactStore } from '@/core/persistence/plan-artifacts';
import type { PlanArtifactRef, PlanDocument } from '@/protocol/events';
import {
  acceptRuntimeAction,
  type RuntimeActionEmission,
  rejectRuntimeAction,
} from './action-emission';
import type { RuntimeEvent } from './events';
import { genInteractionId } from './ids';
import { planCompletionBlocker, projectPlanCompletionEvidenceV1 } from './plan-evidence';
import {
  computePlanStructuralDigest,
  getActivePlanning,
  getActiveTask,
  getAgentPhase,
  type RuntimeState,
} from './state';

export interface PlanRuntimeContext {
  state: RuntimeState;
  artifacts: PlanArtifactStore;
  modelMessageId?: string;
  ordinal?: number;
}

export interface ReadPlanCommand {
  plan_id: string;
  version?: number;
  structural_digest?: string;
}

export interface UpdatePlanCommand {
  plan_id: string;
  version?: number;
  structural_digest?: string;
  updates: Array<{
    step_id: string;
    status: 'pending' | 'in_progress' | 'completed' | 'skipped';
    note?: string;
    reason_code?: string;
  }>;
  complete_plan?: boolean;
}

type PlanIdentityCommand = {
  plan_id?: string;
  version?: number;
  structural_digest?: string;
};

function validatePlanIdentity(
  command: PlanIdentityCommand,
  document: PlanDocument,
): 'plan_identity_required' | 'plan_identity_mismatch' | null {
  if (
    command.plan_id === undefined ||
    command.version === undefined ||
    command.structural_digest === undefined
  ) {
    return 'plan_identity_required';
  }
  if (
    command.plan_id !== document.planId ||
    command.version !== document.version ||
    command.structural_digest !== document.structuralDigest
  ) {
    return 'plan_identity_mismatch';
  }
  return null;
}

export interface WritePlanCommand {
  title?: string;
  body_markdown?: string;
  steps?: Array<{ id: string; title: string }>;
  plan_id?: string;
  version?: number;
  structural_digest?: string;
  expected_version?: number;
  replan_reason?: string;
  action?: 'save' | 'submit';
}

function publicPlan(document: PlanDocument) {
  return {
    name: document.title,
    description: document.bodyMarkdown,
    status: 'pending' as const,
    steps: document.steps.map((step) => ({
      step: step.title,
      id: step.id,
      status: step.status,
    })),
  };
}

function activeArtifactRef(
  context: PlanRuntimeContext,
  command: ReadPlanCommand,
): { taskId: string; ref: PlanArtifactRef } | null {
  const planning = getActivePlanning(context.state);
  const task = getActiveTask(context.state);
  const taskId = task?.taskId ?? `legacy-${context.state.session.threadId}`;
  const document =
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    planning.kind === 'awaiting_review' ||
    planning.kind === 'executing' ||
    planning.kind === 'completed'
      ? planning.document
      : undefined;
  const version = command.version ?? document?.version;
  if (!document || command.plan_id !== document.planId || version !== document.version) return null;
  return {
    taskId,
    ref: document.artifact ?? {
      artifactId: `${document.planId}:v${document.version}`,
      taskId,
      planId: document.planId,
      version: document.version,
      fileName: `v${document.version}.md`,
      relativePath: '',
      displayPath: '',
      structuralDigest: document.structuralDigest,
      byteLength: 0,
    },
  };
}

export function readPlanAction(
  context: PlanRuntimeContext,
  command: ReadPlanCommand,
): RuntimeActionEmission {
  const planning = getActivePlanning(context.state);
  const document =
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    planning.kind === 'awaiting_review' ||
    planning.kind === 'executing' ||
    planning.kind === 'completed'
      ? planning.document
      : undefined;
  const version = command.version ?? document?.version;
  if (!document || command.plan_id !== document.planId || version !== document.version) {
    return rejectRuntimeAction(
      'read_plan must reference the active Task plan and its current version.',
    );
  }
  if (command.structural_digest && command.structural_digest !== document.structuralDigest) {
    return rejectRuntimeAction('read_plan structural_digest does not match the active Artifact.');
  }
  const active = activeArtifactRef(context, command);
  if (!active) return rejectRuntimeAction('Plan Runtime is unavailable.');
  try {
    const artifact = context.artifacts.read(active.ref);
    return acceptRuntimeAction(
      JSON.stringify({
        ok: true,
        status: 'plan_loaded',
        task_id: active.taskId,
        plan_id: artifact.plan.planId,
        version: artifact.plan.version,
        plan_schema_version: artifact.plan.planSchemaVersion,
        structural_digest: artifact.plan.structuralDigest,
        title: artifact.plan.title,
        body_markdown: artifact.plan.bodyMarkdown,
        steps: artifact.plan.steps,
        completion_evidence: artifact.plan.completionEvidence,
        artifact: artifact.artifact,
      }),
    );
  } catch (error) {
    return rejectRuntimeAction(
      error instanceof PlanArtifactError ? error.message : 'Unable to read the Plan Artifact.',
    );
  }
}

export function writePlanAction(
  context: PlanRuntimeContext,
  toolCallId: string,
  command: WritePlanCommand,
): RuntimeActionEmission {
  const state = context.state;
  const planning = getActivePlanning(state);
  const phase = getAgentPhase(planning);
  const task = getActiveTask(state);
  const taskId = task?.taskId ?? `legacy-${state.session.threadId}`;
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
  const legacySubmit = action === 'submit' && hasDocument;
  const activeDocument =
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    planning.kind === 'executing'
      ? planning.document
      : undefined;
  if (activeDocument && (hasDocument || submitExisting)) {
    const identityError = validatePlanIdentity(command, activeDocument);
    if (identityError) return rejectRuntimeAction(identityError);
  }
  const autoEnter =
    phase === 'building' &&
    planning.kind === 'building_without_plan' &&
    (action === 'save' || legacySubmit) &&
    Boolean(task && !task.sideEffectsStarted);
  const draftWrite =
    (planning.kind === 'planning_empty' || planning.kind === 'planning_draft') &&
    hasDocument &&
    (action === 'save' || legacySubmit) &&
    (task == null || !task.sideEffectsStarted);
  const replanDraftSubmit =
    planning.kind === 'replanning_draft' && (submitExisting || legacySubmit);
  const replan =
    phase === 'building' &&
    planning.kind === 'executing' &&
    hasDocument &&
    (action === 'save' || action === 'submit');
  const submitExistingAllowed =
    submitExisting &&
    (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
    command.plan_id === planning.document.planId &&
    command.version === planning.document.version &&
    command.structural_digest === planning.document.structuralDigest;
  const sideEffectsBlock =
    !replan &&
    hasDocument &&
    (action === 'save' || legacySubmit) &&
    task?.sideEffectsStarted === true;
  if (!draftWrite && !replanDraftSubmit && !autoEnter && !replan && !submitExistingAllowed) {
    return rejectRuntimeAction(
      submitExisting
        ? 'submit must reference the current saved plan_id, version, and structural_digest.'
        : sideEffectsBlock
          ? 'write_plan cannot save a new plan after side effects have started.'
          : 'write_plan requires a complete plan document when saving.',
    );
  }
  const events: RuntimeEvent[] = [];
  if (autoEnter && task) {
    events.push({
      type: 'planning.entered',
      taskId: task.taskId,
      source: 'model_request',
    });
  }
  if (replan && planning.kind === 'executing') {
    events.push({
      type: 'plan.replan_requested',
      toolCallId,
      reason: command.replan_reason ?? 'model_requested',
      supersedesPlanVersion: planning.document.version,
    });
  }
  const cancelSiblings = () => {
    for (const sibling of Object.values(state.tools.calls)) {
      if (
        sibling.status === 'queued' &&
        sibling.modelMessageId === context.modelMessageId &&
        (sibling.ordinal ?? 0) > (context.ordinal ?? 0)
      ) {
        events.push({
          type: 'tool.cancelled',
          toolCallId: sibling.toolCallId,
          reason: 'Cancelled because an earlier tool call opened an interaction.',
        });
      }
    }
  };
  if (submitExistingAllowed) {
    try {
      const artifact = context.artifacts.read({
        artifactId: `${command.plan_id}:v${command.version}`,
        taskId,
        planId: command.plan_id!,
        version: command.version!,
        fileName: `v${command.version}.md`,
        relativePath: '',
        displayPath: '',
        structuralDigest: command.structural_digest!,
        byteLength: 0,
      });
      const document = artifact.plan;
      if (document.planSchemaVersion !== 2) {
        return rejectRuntimeAction('legacy_plan_replan_required');
      }
      events.push({
        type: 'plan.review_requested',
        interactionId: genInteractionId(),
        toolCallId,
        taskId,
        plan: publicPlan(document),
        planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        artifact: artifact.artifact,
      });
      cancelSiblings();
      return acceptRuntimeAction('', events);
    } catch (error) {
      return rejectRuntimeAction(
        error instanceof PlanArtifactError
          ? error.message
          : 'Unable to read the saved Plan Artifact.',
      );
    }
  }
  if (!hasDocument) {
    return rejectRuntimeAction('write_plan save requires title, body_markdown, and steps.');
  }
  if (
    command.expected_version != null &&
    (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
    command.expected_version !== planning.document.version
  ) {
    return rejectRuntimeAction(
      `Version conflict: expected v${command.expected_version}, current is v${planning.document.version}.`,
    );
  }
  const previous =
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    (replan && planning.kind === 'executing')
      ? planning.document
      : undefined;
  const replanMetadata =
    replan && planning.kind === 'executing'
      ? {
          supersedesPlanVersion: planning.document.version,
          replanReason: command.replan_reason ?? 'model_requested',
        }
      : planning.kind === 'replanning_draft'
        ? {
            supersedesPlanVersion: planning.supersedesPlanVersion,
            replanReason: planning.replanReason,
          }
        : previous?.supersedesPlanVersion != null
          ? {
              supersedesPlanVersion: previous.supersedesPlanVersion,
              replanReason: previous.replanReason ?? '',
            }
          : {};
  const candidate: PlanDocument = {
    planSchemaVersion: 2,
    planId: previous?.planId ?? randomUUID(),
    version: (previous?.version ?? 0) + 1,
    title: command.title!,
    bodyMarkdown: command.body_markdown!,
    steps: command.steps!.map(({ id, title }) => ({
      id,
      title,
      status: 'pending' as const,
    })),
    structuralDigest: '',
    createdAtTurnId: previous?.createdAtTurnId ?? state.turn.turnId,
    updatedAtTurnId: state.turn.turnId,
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
    ...replanMetadata,
  };
  candidate.structuralDigest = computePlanStructuralDigest(candidate);
  const document =
    previous &&
    previous.planSchemaVersion === 2 &&
    previous.structuralDigest === candidate.structuralDigest
      ? { ...candidate, ...previous, updatedAtTurnId: state.turn.turnId }
      : candidate;
  let artifact: PlanArtifactRef;
  try {
    artifact = context.artifacts.write(taskId, document);
  } catch (error) {
    return rejectRuntimeAction(
      error instanceof PlanArtifactError ? error.message : 'Unable to persist the Plan Artifact.',
    );
  }
  events.push({
    type: 'plan.drafted',
    toolCallId,
    planId: document.planId,
    version: document.version,
    planSchemaVersion: 2,
    plan: publicPlan(document),
    structuralHash: document.structuralDigest,
    taskId,
    artifact,
    ...replanMetadata,
  });
  if (legacySubmit) {
    events.push({
      type: 'plan.review_requested',
      interactionId: genInteractionId(),
      toolCallId,
      plan: publicPlan(document),
      planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      taskId,
      artifact,
    });
    cancelSiblings();
    return acceptRuntimeAction('', events);
  }
  return acceptRuntimeAction(
    JSON.stringify({
      ok: true,
      status: 'draft_saved',
      task_id: taskId,
      plan_id: document.planId,
      version: document.version,
      plan_schema_version: document.planSchemaVersion,
      structural_digest: document.structuralDigest,
      artifact: {
        artifact_id: artifact.artifactId,
        file_name: artifact.fileName,
        path: artifact.displayPath,
        relative_path: artifact.relativePath,
        structural_digest: artifact.structuralDigest,
        byte_length: artifact.byteLength,
      },
      next_action: 'submit',
    }),
    events,
  );
}

export function updatePlanAction(
  context: PlanRuntimeContext,
  toolCallId: string,
  command: UpdatePlanCommand,
): RuntimeActionEmission {
  const planning = getActivePlanning(context.state);
  if (getAgentPhase(planning) !== 'building') {
    return rejectRuntimeAction(
      'update_plan is only available in building phase after plan approval.',
    );
  }
  if (planning.kind !== 'executing') {
    return rejectRuntimeAction('No executing plan. Wait for plan approval first.');
  }
  const document = planning.document;
  if (document.planSchemaVersion !== 2) {
    return rejectRuntimeAction('legacy_plan_replan_required');
  }
  const identityError = validatePlanIdentity(command, document);
  if (identityError) return rejectRuntimeAction(identityError);
  if (new Set(command.updates.map((update) => update.step_id)).size !== command.updates.length) {
    return rejectRuntimeAction('plan_duplicate_step_update');
  }
  const unknownStep = command.updates.find(
    (update) => !document.steps.some((step) => step.id === update.step_id),
  );
  if (unknownStep) return rejectRuntimeAction(`Unknown plan step ID: ${unknownStep.step_id}.`);
  const terminalRollback = command.updates.some((update) => {
    const current = document.steps.find((step) => step.id === update.step_id);
    return (
      current != null &&
      (current.status === 'completed' || current.status === 'skipped') &&
      update.status !== current.status
    );
  });
  if (terminalRollback) return rejectRuntimeAction('plan_terminal_step_rollback');
  const plan = {
    name: document.title,
    description: document.bodyMarkdown,
    status: command.complete_plan ? ('completed' as const) : ('in_progress' as const),
    steps: document.steps.map((step) => {
      const update = command.updates.find((candidate) => candidate.step_id === step.id);
      return {
        step: step.title,
        id: step.id,
        status: update?.status ?? step.status,
        note: update?.note ?? step.note,
      };
    }),
  };
  if (
    command.complete_plan &&
    plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
  ) {
    return rejectRuntimeAction('Cannot complete plan while steps are pending or in progress.');
  }
  const evidence = projectPlanCompletionEvidenceV1(
    context.state,
    plan.steps.map((step) => ({
      id: step.id!,
      title: step.step,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
    Object.fromEntries(
      command.updates.flatMap((update) =>
        update.reason_code === undefined ? [] : [[update.step_id, update.reason_code]],
      ),
    ),
  );
  if (command.complete_plan) {
    const blocker = planCompletionBlocker(context.state, evidence);
    if (blocker) return rejectRuntimeAction(blocker);
  }
  const identity = {
    planId: document.planId,
    version: document.version,
    structuralDigest: document.structuralDigest,
    completionEvidence: evidence,
  };
  const events: RuntimeEvent[] = [{ type: 'plan.progress_updated', toolCallId, plan, ...identity }];
  if (command.complete_plan) events.push({ type: 'plan.completed', toolCallId, plan, ...identity });
  return acceptRuntimeAction(
    JSON.stringify({
      ok: true,
      plan_id: document.planId,
      updated_steps: command.updates.map((update) => update.step_id),
      plan_completed: command.complete_plan ?? false,
    }),
    events,
  );
}
