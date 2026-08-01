import { z } from 'zod';
import { updatePlanAction } from '@/core/runtime/plan-facade';
import { UPDATE_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

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

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

export const updatePlanSpec = defineExecutableTool({
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
    if (!context.planRuntime) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Plan Runtime is unavailable.',
        runtimeEvents: undefined,
      };
    }
    return updatePlanAction(context.planRuntime, context.toolCallId ?? '', input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Update', preview: 'Plan' },
    runtimeEvents: output.runtimeEvents,
  }),
});
