import { z } from 'zod';
import { TASK_CONTRACT } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

export const taskInputSchema = z.object({
  subagent_type: z
    .enum(['explore', 'plan', 'code', 'review'])
    .describe('Type of sub-agent to invoke'),
  task: z
    .string()
    .min(1)
    .describe(
      'Self-contained task description with all necessary context. The sub-agent cannot see the main conversation.',
    ),
});

const planningTaskInputSchema = taskInputSchema.extend({
  subagent_type: z
    .enum(['explore', 'plan'])
    .describe('Read-only role: explore for evidence gathering or plan for architecture and design'),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

export const taskSpec = defineExecutableTool({
  name: 'task',
  kind: 'coordination',
  contract: TASK_CONTRACT.sections,
  inputSchema: taskInputSchema,
  modelInputSchema: (context) =>
    context.featureFlags?.promptContractV2 && context.phase === 'planning'
      ? planningTaskInputSchema
      : taskInputSchema,
  declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'none' },
  minimumApproval: 'user',
  availability: (context) => context.hasTaskAdapter === true,
  effects: (input) =>
    input.subagent_type === 'code'
      ? {
          effectClass: 'workspace_write',
          sideEffect: true,
          classificationReason: 'Code sub-agent may modify the workspace.',
        }
      : {
          effectClass: 'read_only',
          sideEffect: false,
          classificationReason: `${input.subagent_type} sub-agent is read-only by role.`,
        },
  execute: async (input, context) => {
    if (!context.runTask) {
      return { available: false, error: 'task tool is unavailable in this execution context.' };
    }
    return { available: true, result: await context.runTask(input) };
  },
  projectResult: (output) => {
    const ok = output.available && output.result.ok !== false;
    const modelContent = output.available ? JSON.stringify(output.result) : output.error;
    return {
      ok,
      modelContent,
      resultMeta: {},
      display: { verb: 'Task' },
    };
  },
});
