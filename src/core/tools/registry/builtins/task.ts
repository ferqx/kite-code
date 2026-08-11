import { z } from 'zod';
import { planningContinuationAfterPlanSubagentV1 } from '@/core/subagent/delegation-contract';
import { TASK_CONTRACT } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

export const taskInputSchema = z.object({
  subagent_type: z
    .enum(['explore', 'plan', 'code', 'review'])
    .describe('Type of sub-agent to invoke'),
  task: z
    .string()
    .min(8)
    .max(8_000)
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
    context.phase === 'planning' ? planningTaskInputSchema : taskInputSchema,
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
  projectResult: (output, context) => {
    const ok = output.available && output.result.ok !== false;
    const nextActions =
      output.available && !output.result.blocked
        ? planningContinuationAfterPlanSubagentV1({
            phase: context.phase ?? 'building',
            role: context.invocationInput.subagent_type,
            childTerminal: true,
            childOk: output.result.ok === true,
            childStatus: output.result.blocked
              ? 'suspended'
              : output.result.ok === true
                ? 'completed'
                : (output.result.terminalStatus ?? 'failed'),
          })
        : [];
    const modelContent = output.available
      ? JSON.stringify({
          ok: output.result.ok,
          summary: output.result.summary,
          ...(output.result.error ? { error: output.result.error } : {}),
          toolCallCount: output.result.toolCallCount,
          durationMs: output.result.durationMs,
          ...(nextActions.length > 0 ? { nextActions } : {}),
        })
      : output.error;
    return {
      ok,
      modelContent,
      resultMeta: {},
      display: { verb: 'Task' },
    };
  },
});
