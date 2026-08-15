import { z } from 'zod';
import { activateSkillLifecycle, completeSkillLifecycle, readSkillReference } from '@/core/skills';
import { BUILTIN_TOOL_CONTRACTS } from '@/core/tools/tool-contracts';
import { defineExecutableTool } from '../spec';

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
  kind: 'coordination',
  contract: BUILTIN_TOOL_CONTRACTS.activate_skill,
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
      };
    }
    return activateSkillLifecycle(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
  }),
});

export const readSkillReferenceSpec = defineExecutableTool({
  name: 'read_skill_reference',
  kind: 'coordination',
  contract: BUILTIN_TOOL_CONTRACTS.read_skill_reference,
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
      };
    }
    return readSkillReference(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
  }),
});

export const completeSkillSpec = defineExecutableTool({
  name: 'complete_skill',
  kind: 'coordination',
  contract: BUILTIN_TOOL_CONTRACTS.complete_skill,
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
      };
    }
    return completeSkillLifecycle(context.skillRuntime, input);
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
  }),
});
