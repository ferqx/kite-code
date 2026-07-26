import { z } from 'zod';
import type { RuntimeEvent } from '@/core/runtime/events';
import { getActivePlanning, getAgentPhase } from '@/core/runtime/state';
import { UPDATE_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export const updatePlanInputSchema = z.object({
  plan_id: z.string().min(1).describe('Plan ID from the approved plan'),
  updates: z
    .array(
      z.object({
        step_id: z.string().min(1).describe('Stable step ID from the plan'),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(12),
  complete_plan: z.boolean().optional(),
});

type UpdatePlanOutput = {
  ok: boolean;
  stdout: string;
  stderr: string;
  runtimeEvents?: RuntimeEvent[];
};

export const updatePlanSpec: ToolSpec<z.infer<typeof updatePlanInputSchema>, UpdatePlanOutput> = {
  name: 'update_plan',
  kind: 'runtime_action',
  contract: UPDATE_PLAN_CONTRACT.sections,
  inputSchema: updatePlanInputSchema,
  declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'plan_only',
    sideEffect: false,
    classificationReason: 'Updates progress in the active approved Plan.',
  }),
  execute: async (input, context) => {
    const state = context.planRuntime?.state;
    if (!state) return { ok: false, stdout: '', stderr: 'Plan Runtime is unavailable.' };
    const planning = getActivePlanning(state);
    if (getAgentPhase(planning) !== 'building') {
      return {
        ok: false,
        stdout: '',
        stderr: 'update_plan is only available in building phase after plan approval.',
      };
    }
    if (planning.kind !== 'executing') {
      return { ok: false, stdout: '', stderr: 'No executing plan. Wait for plan approval first.' };
    }
    const document = planning.document;
    if (input.plan_id !== document.planId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Plan ID mismatch: expected ${input.plan_id}, current is ${document.planId}.`,
      };
    }
    const unknownStep = input.updates.find(
      (update) => !document.steps.some((step) => step.id === update.step_id),
    );
    if (unknownStep) {
      return { ok: false, stdout: '', stderr: `Unknown plan step ID: ${unknownStep.step_id}.` };
    }
    const plan = {
      name: document.title,
      description: document.bodyMarkdown,
      status: input.complete_plan ? ('completed' as const) : ('in_progress' as const),
      steps: document.steps.map((step) => {
        const update = input.updates.find((candidate) => candidate.step_id === step.id);
        return {
          step: step.title,
          id: step.id,
          status: update?.status ?? step.status,
          note: update?.note ?? step.note,
        };
      }),
    };
    if (
      input.complete_plan &&
      plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
    ) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Cannot complete plan while steps are pending or in progress.',
      };
    }
    const runtimeEvents: RuntimeEvent[] = [
      { type: 'plan.progress_updated', toolCallId: context.toolCallId ?? '', plan },
    ];
    if (input.complete_plan) {
      runtimeEvents.push({
        type: 'plan.completed',
        toolCallId: context.toolCallId ?? '',
        plan,
      });
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        plan_id: document.planId,
        updated_steps: input.updates.map((update) => update.step_id),
        plan_completed: input.complete_plan ?? false,
      }),
      stderr: '',
      runtimeEvents,
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Update', preview: 'Plan' },
    runtimeEvents: output.runtimeEvents,
  }),
};
