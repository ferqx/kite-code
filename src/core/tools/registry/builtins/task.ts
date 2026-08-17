import { z } from 'zod';
import { planningContinuationAfterPlanSubagentV1 } from '@/core/subagent/delegation-contract';
import { TASK_CONTRACT } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

/**
 * Public/raw task arguments are a closed shape.  The private Artifact-backed
 * form below is deliberately a separate union branch; accepting unknown keys
 * here would make `{ task, taskArtifact }` look like a raw task after Zod
 * strips the private projection, allowing an unhydrated request to dispatch.
 */
export const taskInputSchema = z
  .object({
    subagent_type: z
      .enum(['explore', 'plan', 'code', 'review'])
      .describe('Type of sub-agent to invoke'),
    task: z
      .string()
      .trim()
      .min(8)
      .max(8_000)
      .describe(
        'Self-contained task description with all necessary context. The sub-agent cannot see the main conversation.',
      ),
  })
  .strict();

const taskPrivateReferenceInputSchema = z
  .object({
    subagent_type: z.enum(['explore', 'plan', 'code', 'review']),
    taskArtifact: z
      .object({
        artifactId: z.string().regex(/^pa_[0-9a-f]{64}$/u),
        kind: z.literal('subagent_task_request'),
        integrityIdentifier: z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/u),
        byteLength: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const taskRuntimeInputSchema = z.union([taskInputSchema, taskPrivateReferenceInputSchema]);

const legacyPlanningTaskInputSchema = taskInputSchema.extend({
  subagent_type: z
    .enum(['explore', 'plan'])
    .describe('Read-only role: explore for evidence gathering or plan for architecture and design'),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

export const taskSpec = defineExecutableTool({
  name: 'task',
  kind: 'coordination',
  contract: TASK_CONTRACT.sections,
  inputSchema: taskRuntimeInputSchema,
  modelInputSchema: (context) => {
    return !context.featureFlags?.promptContractV2 && context.phase === 'planning'
      ? legacyPlanningTaskInputSchema
      : taskInputSchema;
  },
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
    if (!('task' in input)) {
      return { available: false, error: 'private task Artifact was not hydrated for execution.' };
    }
    if (!context.runTask) {
      return { available: false, error: 'task tool is unavailable in this execution context.' };
    }
    return {
      available: true,
      result: await context.runTask(input),
    };
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
          ...(output.result.terminalStatus ? { terminalStatus: output.result.terminalStatus } : {}),
          toolCallCount: output.result.toolCallCount,
          durationMs: output.result.durationMs,
          ...(nextActions.length > 0 ? { nextActions } : {}),
        })
      : output.error;
    return {
      ok,
      modelContent,
      resultMeta: {},
    };
  },
});
