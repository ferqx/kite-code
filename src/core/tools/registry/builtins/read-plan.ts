import { z } from 'zod';
import type { RuntimeActionEmission } from '@/core/runtime/action-emission';
import { type ReadPlanCommand, readPlanAction } from '@/core/runtime/plan-facade';
import { READ_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export const readPlanInputSchema = z.object({
  plan_id: z.string().min(1),
  version: z.number().int().positive().optional(),
  structural_digest: z.string().min(1).optional(),
});

export type ReadPlanInput = z.infer<typeof readPlanInputSchema>;

export const readPlanSpec: ToolSpec<z.infer<typeof readPlanInputSchema>, RuntimeActionEmission> = {
  name: 'read_plan',
  kind: 'runtime_action',
  contract: READ_PLAN_CONTRACT.sections,
  inputSchema: readPlanInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Reads the active immutable Plan Artifact.',
  }),
  execute: async (input, context) => {
    if (!context.planRuntime) {
      return { ok: false, stdout: '', stderr: 'Plan Runtime is unavailable.' };
    }
    return readPlanAction(context.planRuntime, input as ReadPlanCommand);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Read', preview: 'Plan' },
  }),
};
