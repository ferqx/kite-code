import type {
  BuiltinPlanActionResultV1,
  BuiltinPlanningExecutionMechanismV1,
  BuiltinReadPlanInputV1,
  BuiltinRuntimeEventValueV1,
  BuiltinUpdatePlanInputV1,
  BuiltinWritePlanInputV1,
} from '@kite/builtin-runtime';
import {
  createBuiltinPlanDocumentV2V1,
  isBuiltinSavedReplanRevisionV1,
  PlanArtifactError,
  type PlanArtifactStore,
  projectBuiltinPublicPlanV2V1,
} from '@kite/builtin-runtime/planning';
import type { PlanArtifactRef } from '@kite/runtime-contract';
import {
  acceptRuntimeAction,
  createRuntimeHostInteractionIdV1 as genInteractionId,
  getActivePlanning,
  getActiveTask,
  type RuntimeActionEmission,
  type StateRuntimeEventV1 as RuntimeEvent,
  type RuntimeState,
  rejectRuntimeAction,
  runtimeHostStateDecideReadPlanCommandV1,
  runtimeHostStateDecideUpdatePlanCommandV1,
  runtimeHostStateDecideWritePlanCommandV1,
  runtimeHostStatePlanCommandFactsV1,
  runtimeHostStatePlanCompletionBlockerV1,
  runtimeHostStateProjectPlanCompletionEvidenceV1,
} from '@kite/runtime-host';

export interface PlanRuntimeContext {
  state: RuntimeState;
  artifacts: PlanArtifactStore;
  modelMessageId?: string;
  ordinal?: number;
  /** New Tool Pipeline persistence owns the atomic review-opening sibling cancellation batch. */
  deferPlanReviewSiblingCancellation?: boolean;
}

/**
 * App-owned adapter that joins the Kernel admission decision, Builtin plan
 * document/artifact semantics, and Host action/event transport. The Core
 * pipeline receives only this already-composed Builtin mechanism.
 */
export function createPlanRuntimeV1(
  context: PlanRuntimeContext,
): BuiltinPlanningExecutionMechanismV1 {
  return Object.freeze({
    read: async (input: BuiltinReadPlanInputV1) =>
      planActionResultV1(readPlanAction(context, input)),
    update: async (toolCallId: string, input: BuiltinUpdatePlanInputV1) =>
      planActionResultV1(updatePlanAction(context, toolCallId, input)),
    write: async (toolCallId: string, input: BuiltinWritePlanInputV1) =>
      planActionResultV1(writePlanAction(context, toolCallId, input)),
  });
}

function planActionResultV1(action: RuntimeActionEmission): BuiltinPlanActionResultV1 {
  return {
    ok: action.ok,
    stdout: action.stdout,
    stderr: action.stderr,
    ...(action.runtimeEvents === undefined
      ? {}
      : {
          runtimeEvents: action.runtimeEvents as unknown as readonly BuiltinRuntimeEventValueV1[],
        }),
  };
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

function activeArtifactRef(
  context: PlanRuntimeContext,
  command: ReadPlanCommand,
): { taskId: string; ref: PlanArtifactRef } | null {
  const planning = getActivePlanning(context.state);
  const task = getActiveTask(context.state);
  if (!task) return null;
  const taskId = task.taskId;
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
  const task = getActiveTask(context.state);
  const decision = runtimeHostStateDecideReadPlanCommandV1(
    runtimeHostStatePlanCommandFactsV1(context.state),
    command,
  );
  if (!decision.accepted) return rejectRuntimeAction(decision.diagnostic);
  if (!task) return rejectRuntimeAction('No active Task owns this Plan.');
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
  const task = getActiveTask(state);
  const decision = runtimeHostStateDecideWritePlanCommandV1(
    runtimeHostStatePlanCommandFactsV1(state),
    command,
  );
  if (!decision.accepted) return rejectRuntimeAction(decision.diagnostic);
  if (!task) return rejectRuntimeAction('write_plan requires an active Task.');
  const taskId = task.taskId;
  const hasDocument =
    command.title !== undefined &&
    command.body_markdown !== undefined &&
    command.steps !== undefined;
  const replanningDocumentIsSavedCanonicalRevision =
    planning.kind === 'replanning_draft' &&
    isBuiltinSavedReplanRevisionV1(planning.document, {
      supersedesPlanVersion: planning.supersedesPlanVersion,
      replanReason: planning.replanReason,
    });
  const autoEnter = decision.mode === 'auto_enter';
  const replan = decision.mode === 'replan_save';
  const submitExistingAllowed =
    decision.mode === 'submit_existing' || (decision.mode === 'replanning_save' && !hasDocument);
  const events: RuntimeEvent[] = [];
  if (autoEnter) {
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
      events.push({
        type: 'plan.review_requested',
        interactionId: genInteractionId(),
        toolCallId,
        taskId,
        plan: projectBuiltinPublicPlanV2V1(document),
        planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        artifact: artifact.artifact,
      });
      if (context.deferPlanReviewSiblingCancellation !== true) cancelSiblings();
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
  const currentRevisionIsSavedCanonicalDraft =
    planning.kind === 'planning_draft' || replanningDocumentIsSavedCanonicalRevision;
  const candidate = createBuiltinPlanDocumentV2V1({
    taskId,
    turnId: state.turn.turnId,
    title: command.title!,
    bodyMarkdown: command.body_markdown!,
    steps: command.steps!,
    previous,
    revision:
      replanMetadata.supersedesPlanVersion == null
        ? undefined
        : {
            supersedesPlanVersion: replanMetadata.supersedesPlanVersion,
            replanReason: replanMetadata.replanReason!,
          },
    canonicalRevisionIsSaved: currentRevisionIsSavedCanonicalDraft,
  });
  const document =
    previous &&
    previous.structuralDigest === candidate.structuralDigest &&
    currentRevisionIsSavedCanonicalDraft
      ? previous
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
    plan: projectBuiltinPublicPlanV2V1(document),
    structuralHash: document.structuralDigest,
    taskId,
    artifact,
    ...(document.supersedesPlanVersion == null
      ? {}
      : {
          supersedesPlanVersion: document.supersedesPlanVersion,
          replanReason: document.replanReason ?? '',
        }),
  });
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
  const task = getActiveTask(context.state);
  const facts = runtimeHostStatePlanCommandFactsV1(context.state);
  const admission = runtimeHostStateDecideUpdatePlanCommandV1(facts, command);
  if (!admission.accepted) return rejectRuntimeAction(admission.diagnostic);
  const skippedReasonCodes = Object.fromEntries(
    command.updates.flatMap((update) =>
      update.reason_code === undefined ? [] : [[update.step_id, update.reason_code]],
    ),
  );
  const evidence = runtimeHostStateProjectPlanCompletionEvidenceV1(
    context.state,
    admission.nextSteps,
    skippedReasonCodes,
  );
  const decision = runtimeHostStateDecideUpdatePlanCommandV1(
    {
      ...facts,
      completionBlocker: command.complete_plan
        ? runtimeHostStatePlanCompletionBlockerV1(context.state, evidence)
        : null,
    },
    command,
  );
  if (!decision.accepted) return rejectRuntimeAction(decision.diagnostic);
  if (!task || planning.kind !== 'executing') {
    return rejectRuntimeAction('No executing plan. Wait for plan approval first.');
  }
  const document = planning.document;
  const plan = {
    name: document.title,
    description: document.bodyMarkdown,
    status: command.complete_plan ? ('completed' as const) : ('in_progress' as const),
    steps: decision.nextSteps.map((step) => ({
      step: step.title,
      id: step.id,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  };
  const identity = {
    taskId: task.taskId,
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
