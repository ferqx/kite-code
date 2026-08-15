import { z } from 'zod';
import { updatePlanAction } from '@/core/runtime/plan-facade';
import { UPDATE_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

export const updatePlanInputSchema = z
  .object({
    plan_id: z.string().min(1).describe('Plan ID from the approved plan'),
    version: z.number().int().positive().describe('Version from the approved plan').optional(),
    structural_digest: z
      .string()
      .trim()
      .min(1)
      .describe('Digest from the approved plan')
      .optional(),
    updates: z
      .array(
        z
          .object({
            step_id: z.string().min(1).describe('Stable step ID from the plan'),
            status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
            note: z.string().trim().max(500).optional(),
            reason_code: z
              .string()
              .regex(/^[a-z][a-z0-9_]{0,63}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .superRefine((updates, context) => {
        const ids = new Set<string>();
        for (const [index, update] of updates.entries()) {
          if (ids.has(update.step_id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'step_id'],
              message: 'Each step may be updated once per call',
            });
          }
          if (update.status === 'skipped' && update.reason_code === undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'reason_code'],
              message: 'Skipped steps require a reason_code',
            });
          }
          ids.add(update.step_id);
        }
      }),
    complete_plan: z.boolean().optional(),
  })
  .strict();

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
      };
    }
    return updatePlanAction(context.planRuntime, context.toolCallId ?? '', input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
  }),
});
