import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlanArtifactError } from '@/core/persistence/plan-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import {
  computePlanStructuralDigest,
  getActivePlanning,
  getActiveTask,
  getAgentPhase,
} from '@/core/runtime/state';
import { WRITE_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import type { PlanArtifactRef, PlanDocument } from '@/protocol/events';
import type { ToolSpec } from '../spec';

const documentFields = {
  title: z.string().trim().min(1).max(200),
  body_markdown: z.string().trim().min(1).max(30_000),
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        title: z.string().trim().min(1).max(160),
      }),
    )
    .min(1)
    .max(12),
};
export const writePlanInputSchema = z
  .object({
    title: documentFields.title.optional(),
    body_markdown: documentFields.body_markdown.optional(),
    steps: documentFields.steps.optional(),
    plan_id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
    structural_digest: z.string().trim().min(1).optional(),
    expected_version: z.number().int().positive().optional(),
    replan_reason: z.string().trim().max(500).optional(),
    action: z.enum(['save', 'submit']).optional(),
  })
  .superRefine((value, context) => {
    const action = value.action ?? 'save';
    const hasDocument =
      value.title !== undefined && value.body_markdown !== undefined && value.steps !== undefined;
    const hasArtifact =
      value.plan_id !== undefined &&
      value.version !== undefined &&
      value.structural_digest !== undefined;
    if (action === 'save' && !hasDocument) {
      for (const key of ['title', 'body_markdown', 'steps'] as const) {
        if (value[key] === undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Required' });
        }
      }
    }
    if (action === 'submit' && !hasArtifact && !hasDocument) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan_id'],
        message: 'Submit requires an Artifact reference or a complete document',
      });
    }
  });

type WritePlanOutput = {
  ok: boolean;
  stdout: string;
  stderr: string;
  runtimeEvents?: RuntimeEvent[];
};

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

export const writePlanSpec: ToolSpec<z.infer<typeof writePlanInputSchema>, WritePlanOutput> = {
  name: 'write_plan',
  kind: 'runtime_action',
  contract: WRITE_PLAN_CONTRACT.sections,
  inputSchema: writePlanInputSchema,
  declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'plan_only',
    sideEffect: false,
    classificationReason: 'Creates or submits an immutable Plan Artifact.',
  }),
  execute: async (input, context) => {
    const runtime = context.planRuntime;
    if (!runtime) return { ok: false, stdout: '', stderr: 'Plan Runtime is unavailable.' };
    const state = runtime.state;
    const planning = getActivePlanning(state);
    const phase = getAgentPhase(planning);
    const task = getActiveTask(state);
    const taskId = task?.taskId ?? `legacy-${state.session.threadId}`;
    const action = input.action ?? 'save';
    const hasDocument =
      input.title !== undefined && input.body_markdown !== undefined && input.steps !== undefined;
    const hasArtifact =
      input.plan_id !== undefined &&
      input.version !== undefined &&
      input.structural_digest !== undefined;
    const submitExisting = action === 'submit' && hasArtifact && !hasDocument;
    const legacySubmit = action === 'submit' && hasDocument;
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
    const replan = phase === 'building' && planning.kind === 'executing' && action === 'submit';
    const submitExistingAllowed =
      submitExisting &&
      (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
      input.plan_id === planning.document.planId &&
      input.version === planning.document.version &&
      input.structural_digest === planning.document.structuralDigest;
    const sideEffectsBlock =
      hasDocument && (action === 'save' || legacySubmit) && task?.sideEffectsStarted === true;
    if (!draftWrite && !replanDraftSubmit && !autoEnter && !replan && !submitExistingAllowed) {
      return {
        ok: false,
        stdout: '',
        stderr: submitExisting
          ? 'submit must reference the current saved plan_id, version, and structural_digest.'
          : sideEffectsBlock
            ? 'write_plan cannot save a new plan after side effects have started.'
            : 'write_plan requires a complete plan document when saving.',
      };
    }
    const events: RuntimeEvent[] = [];
    if (autoEnter && task) {
      events.push({ type: 'planning.entered', taskId: task.taskId, source: 'model_request' });
    }
    if (replan && planning.kind === 'executing') {
      events.push({
        type: 'plan.replan_requested',
        toolCallId: context.toolCallId ?? '',
        reason: input.replan_reason ?? (input.body_markdown ?? '').slice(0, 500),
        supersedesPlanVersion: planning.document.version,
      });
    }
    const cancelSiblings = () => {
      for (const sibling of Object.values(state.tools.calls)) {
        if (
          sibling.status === 'queued' &&
          sibling.modelMessageId === runtime.modelMessageId &&
          (sibling.ordinal ?? 0) > (runtime.ordinal ?? 0)
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
        const artifact = runtime.artifacts.read({
          artifactId: `${input.plan_id}:v${input.version}`,
          taskId,
          planId: input.plan_id!,
          version: input.version!,
          fileName: `v${input.version}.md`,
          relativePath: '',
          displayPath: '',
          structuralDigest: input.structural_digest!,
          byteLength: 0,
        });
        const document = artifact.plan;
        events.push({
          type: 'plan.review_requested',
          interactionId: genInteractionId(),
          toolCallId: context.toolCallId ?? '',
          taskId,
          plan: publicPlan(document),
          planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          artifact: artifact.artifact,
        });
        cancelSiblings();
        return { ok: true, stdout: '', stderr: '', runtimeEvents: events };
      } catch (error) {
        return {
          ok: false,
          stdout: '',
          stderr:
            error instanceof PlanArtifactError
              ? error.message
              : 'Unable to read the saved Plan Artifact.',
        };
      }
    }
    if (!hasDocument) {
      return {
        ok: false,
        stdout: '',
        stderr: 'write_plan save requires title, body_markdown, and steps.',
      };
    }
    if (
      input.expected_version != null &&
      (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
      input.expected_version !== planning.document.version
    ) {
      return {
        ok: false,
        stdout: '',
        stderr: `Version conflict: expected v${input.expected_version}, current is v${planning.document.version}.`,
      };
    }
    const previous =
      planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
        ? planning.document
        : undefined;
    const replanMetadata =
      replan && planning.kind === 'executing'
        ? {
            supersedesPlanVersion: planning.document.version,
            replanReason: input.replan_reason ?? (input.body_markdown ?? '').slice(0, 500),
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
      planId: previous?.planId ?? randomUUID(),
      version: (previous?.version ?? 0) + 1,
      title: input.title!,
      bodyMarkdown: input.body_markdown!,
      steps: input.steps!.map(({ id, title }) => ({ id, title, status: 'pending' as const })),
      structuralDigest: '',
      createdAtTurnId: previous?.createdAtTurnId ?? state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
      ...replanMetadata,
    };
    candidate.structuralDigest = computePlanStructuralDigest(candidate);
    const document =
      previous && previous.structuralDigest === candidate.structuralDigest
        ? { ...candidate, ...previous, updatedAtTurnId: state.turn.turnId }
        : candidate;
    let artifact: PlanArtifactRef;
    try {
      artifact = runtime.artifacts.write(taskId, document);
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr:
          error instanceof PlanArtifactError
            ? error.message
            : 'Unable to persist the Plan Artifact.',
      };
    }
    events.push({
      type: 'plan.drafted',
      toolCallId: context.toolCallId ?? '',
      planId: document.planId,
      version: document.version,
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
        toolCallId: context.toolCallId ?? '',
        plan: publicPlan(document),
        planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        taskId,
        artifact,
      });
      cancelSiblings();
      return { ok: true, stdout: '', stderr: '', runtimeEvents: events };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        status: 'draft_saved',
        task_id: taskId,
        plan_id: document.planId,
        version: document.version,
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
      stderr: '',
      runtimeEvents: events,
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Write', preview: 'Plan' },
    runtimeEvents: output.runtimeEvents,
  }),
};
