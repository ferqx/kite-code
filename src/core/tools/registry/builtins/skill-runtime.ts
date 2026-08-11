import { z } from 'zod';
import { activateSkillLifecycle, completeSkillLifecycle, readSkillReference } from '@/core/skills';
import { UTF8_TOOL_RESULT_BUDGET_V2 } from '@/core/tools/result-budget-v2';
import type { LegacyToolContractSection } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

const readContract: LegacyToolContractSection = {
  whenToUse:
    'Read a declared supporting file from the active Skill Workflow. Use read_file for workspace files outside the Skill contract.',
  commonMistakes:
    'Reading undeclared paths, stale activations, symlinks, or files outside scripts/, references/, assets/, and evals/ is rejected.',
  outputFormat: 'JSON: ok, activation_id, path, encoding, and content.',
  failureHandling:
    'If rejected, verify the active activation id and choose an exact path declared by its Workflow Contract.',
};
const completeContract: LegacyToolContractSection = {
  whenToUse:
    'Complete an active inline Skill Workflow with structured output. Use task for unrelated delegated work.',
  commonMistakes:
    'Completing a stale activation or returning output that does not match the compiled output schema is rejected.',
  outputFormat: 'JSON: ok, activation_id, and validated output.',
  failureHandling:
    'Fix the structured output to match the active Workflow Contract schema, then retry once.',
};
const activateContract: LegacyToolContractSection = {
  whenToUse:
    'Activate a disclosed compiled Skill Workflow Contract. Use tool_search first when the capability is not disclosed.',
  commonMistakes:
    'Guessing a Skill ID, using stale catalog metadata, or passing input that fails the compiled schema is rejected.',
  outputFormat: 'JSON: ok, activation_id, skill_id, context_mode, and fork output when applicable.',
  failureHandling:
    'Search again after catalog drift, then retry with input matching the disclosed Skill contract.',
};

export const readSkillReferenceInputSchema = z.object({
  activation_id: z.string().min(1),
  path: z.string().min(1),
});
export const completeSkillInputSchema = z.object({
  activation_id: z.string().min(1),
  output: z.record(z.string(), z.unknown()),
});
export const activateSkillInputSchema = z.object({
  skill_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export type ReadSkillReferenceInput = z.infer<typeof readSkillReferenceInputSchema>;
export type CompleteSkillInput = z.infer<typeof completeSkillInputSchema>;
export type ActivateSkillInput = z.infer<typeof activateSkillInputSchema>;

const effects = () => ({
  effectClass: 'read_only' as const,
  sideEffect: false,
  classificationReason: 'Operates on the active governed Skill frame.',
});

export const activateSkillSpec = defineExecutableTool({
  name: 'activate_skill',
  modelResultBudgetV2: UTF8_TOOL_RESULT_BUDGET_V2,
  kind: 'coordination',
  contract: activateContract,
  inputSchema: activateSkillInputSchema,
  declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
  minimumApproval: 'user',
  availability: (context) =>
    context.featureFlags?.skillWorkflowV1 === true &&
    context.featureFlags.skillActivationV2 === true &&
    (context.availableSkillIds?.length ?? 0) > 0,
  effects: () => ({
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: 'Skill effects are governed by the disclosed compiled descriptor.',
  }),
  execute: async (input, context) => {
    if (!context.skillRuntime) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Skill catalog is unavailable.',
        runtimeEvents: undefined,
      };
    }
    return activateSkillLifecycle(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Activate', preview: 'Skill' },
    runtimeEvents: output.runtimeEvents,
  }),
});

export const readSkillReferenceSpec = defineExecutableTool({
  name: 'read_skill_reference',
  modelResultBudgetV2: UTF8_TOOL_RESULT_BUDGET_V2,
  kind: 'coordination',
  contract: readContract,
  inputSchema: readSkillReferenceInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  availability: (context) => (context.activeSkillFrameIds?.length ?? 0) > 0,
  effects,
  execute: async (input, context) => {
    if (!context.skillRuntime) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Skill frame is unavailable or changed.',
        runtimeEvents: undefined,
      };
    }
    return readSkillReference(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Read', preview: 'Skill reference' },
  }),
});

export const completeSkillSpec = defineExecutableTool({
  name: 'complete_skill',
  modelResultBudgetV2: UTF8_TOOL_RESULT_BUDGET_V2,
  kind: 'coordination',
  contract: completeContract,
  inputSchema: completeSkillInputSchema,
  declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  availability: (context) => (context.activeSkillFrameIds?.length ?? 0) > 0,
  effects,
  execute: async (input, context) => {
    if (!context.skillRuntime) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Skill frame is unavailable or changed.',
        runtimeEvents: undefined,
      };
    }
    return completeSkillLifecycle(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Complete', preview: 'Skill' },
    runtimeEvents: output.runtimeEvents,
  }),
});
