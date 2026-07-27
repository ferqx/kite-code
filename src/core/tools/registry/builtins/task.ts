import { z } from 'zod';
import type { SubAgentResult } from '@/core/subagent/types';
import { TASK_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

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

export type TaskInput = z.infer<typeof taskInputSchema>;
type TaskOutput = { available: true; result: SubAgentResult } | { available: false; error: string };

export const taskSpec: ToolSpec<TaskInput, TaskOutput> = {
  name: 'task' as const,
  kind: 'coordination',
  contract: TASK_CONTRACT.sections,
  inputSchema: taskInputSchema,
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
};
