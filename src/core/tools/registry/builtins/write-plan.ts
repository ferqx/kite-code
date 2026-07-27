import { z } from 'zod';
import type { RuntimeActionEmission } from '@/core/runtime/action-emission';
import { writePlanAction } from '@/core/runtime/plan-facade';
import { WRITE_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
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

export type WritePlanInput = z.infer<typeof writePlanInputSchema>;

export const writePlanSpec: ToolSpec<
  z.infer<typeof writePlanInputSchema>,
  RuntimeActionEmission
> = {
  name: 'write_plan' as const,
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
    if (!context.planRuntime) {
      return { ok: false, stdout: '', stderr: 'Plan Runtime is unavailable.' };
    }
    return writePlanAction(context.planRuntime, context.toolCallId ?? '', input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Write', preview: 'Plan' },
    runtimeEvents: output.runtimeEvents,
  }),
};
