import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import type { RuntimeEvent } from '@/core/runtime/events';
import { evaluateSkillActivation } from '@/core/skills';
import type { ToolContractSection } from '@/core/tools/tool-contracts';
import { verificationRequestForSkill } from '@/core/verification';
import type { ToolSpec } from '../spec';

const readContract: ToolContractSection = {
  whenToUse:
    'Read a declared supporting file from the active Skill Workflow. Use read_file for workspace files outside the Skill contract.',
  commonMistakes:
    'Reading undeclared paths, stale activations, symlinks, or files outside scripts/, references/, assets/, and evals/ is rejected.',
  outputFormat: 'JSON: ok, activation_id, path, encoding, and content.',
  failureHandling:
    'If rejected, verify the active activation id and choose an exact path declared by its Workflow Contract.',
};
const completeContract: ToolContractSection = {
  whenToUse:
    'Complete an active inline Skill Workflow with structured output. Use task for unrelated delegated work.',
  commonMistakes:
    'Completing a stale activation or returning output that does not match the compiled output schema is rejected.',
  outputFormat: 'JSON: ok, activation_id, and validated output.',
  failureHandling:
    'Fix the structured output to match the active Workflow Contract schema, then retry once.',
};
const activateContract: ToolContractSection = {
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

type SkillOutput = {
  ok: boolean;
  stdout: string;
  stderr: string;
  runtimeEvents?: RuntimeEvent[];
};

const effects = () => ({
  effectClass: 'read_only' as const,
  sideEffect: false,
  classificationReason: 'Operates on the active governed Skill frame.',
});

function parseForkOutput(
  summary: string,
  schema: Record<string, unknown>,
): { ok: true; output: Record<string, unknown> } | { ok: false; reason: string } {
  let output: unknown;
  try {
    output = JSON.parse(summary);
  } catch {
    return {
      ok: false,
      reason: 'Forked Skill must return exactly one JSON object matching its output schema.',
    };
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, reason: 'Forked Skill output must be a JSON object.' };
  }
  const error = validateCapabilityArguments(schema, output as Record<string, unknown>);
  return error
    ? { ok: false, reason: error }
    : { ok: true, output: output as Record<string, unknown> };
}

export const activateSkillSpec: ToolSpec<z.infer<typeof activateSkillInputSchema>, SkillOutput> = {
  name: 'activate_skill',
  kind: 'coordination',
  contract: activateContract,
  inputSchema: activateSkillInputSchema,
  declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
  minimumApproval: 'user',
  effects: () => ({
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: 'Skill effects are governed by the disclosed compiled descriptor.',
  }),
  execute: async (input, context) => {
    const runtime = context.skillRuntime;
    const activation =
      runtime?.catalog && runtime.flags
        ? evaluateSkillActivation({
            state: runtime.state,
            catalog: runtime.catalog,
            flags: runtime.flags,
            request: {
              skillId: input.skill_id,
              input: input.input,
              requestedBy: 'model',
              implicit: true,
            },
          })
        : { ok: false as const, reason: 'Skill catalog is unavailable.' };
    if (!activation.ok) return { ok: false, stdout: '', stderr: activation.reason };
    const events: RuntimeEvent[] = [...activation.events];
    if (activation.activation.contextMode !== 'fork') {
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          activation_id: activation.activation.activationId,
          skill_id: activation.activation.skillId,
          context_mode: activation.activation.contextMode,
        }),
        stderr: '',
        runtimeEvents: events,
      };
    }
    const entry = runtime?.catalog?.entries.find(
      (candidate) =>
        !candidate.shadowedBy &&
        candidate.descriptor.capabilityId === activation.activation.skillId &&
        candidate.descriptor.revision === activation.activation.skillRevision &&
        candidate.contract,
    );
    if (!entry?.contract || !runtime?.runFork) {
      return {
        ok: false,
        stdout: '',
        stderr:
          'Forked Skill requires a current compiled contract, Runtime model, and resolvable capability bindings.',
      };
    }
    const result = await runtime.runFork({
      agent: activation.activation.agent,
      capabilityCeiling: activation.activation.capabilityCeiling,
      instructions: entry.contract.instructions,
      workflowInput: activation.activation.input as Record<string, unknown>,
      outputSchema: entry.contract.outputSchema,
    });
    if (!result) {
      return {
        ok: false,
        stdout: '',
        stderr:
          'Forked Skill requires a current compiled contract, Runtime model, and resolvable capability bindings.',
      };
    }
    const validated = result.ok
      ? parseForkOutput(result.summary, entry.contract.outputSchema)
      : { ok: false as const, reason: result.error ?? result.summary };
    const completed = result.ok && validated.ok;
    const failure = validated.ok ? undefined : validated.reason;
    events.push({
      type: 'skill.frame_closed',
      activationId: activation.activation.activationId,
      status: completed ? 'closed' : 'invalidated',
      reason: completed
        ? 'Forked Skill execution completed.'
        : (failure ?? 'Forked Skill execution failed.'),
      closedAt: new Date().toISOString(),
      ...(completed ? { output: validated.output } : {}),
    });
    if (completed && runtime.verificationEnabled) {
      const verification = verificationRequestForSkill({
        activation: activation.activation,
        contract: entry.contract,
        sourcePath: entry.sourcePath,
        workspace: context.workspace,
      });
      if (verification) events.push(verification);
    }
    return {
      ok: completed,
      stdout: JSON.stringify({
        ok: completed,
        activation_id: activation.activation.activationId,
        skill_id: activation.activation.skillId,
        context_mode: 'fork',
        ...(completed ? { output: validated.output } : { summary: result.summary }),
      }),
      stderr: completed ? '' : (failure ?? 'Forked Skill execution failed.'),
      runtimeEvents: events,
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Activate', preview: 'Skill' },
    runtimeEvents: output.runtimeEvents,
  }),
};

function activeEntry(context: Parameters<ToolSpec['execute']>[1], activationId: string) {
  const runtime = context.skillRuntime;
  const frame = runtime?.state.skills.frames[activationId];
  const entry =
    frame &&
    runtime?.catalog?.entries.find(
      (candidate) =>
        !candidate.shadowedBy &&
        candidate.descriptor.capabilityId === frame.skillId &&
        candidate.descriptor.revision === frame.skillRevision &&
        candidate.contract,
    );
  return frame?.status === 'active' &&
    frame.taskId === runtime?.state.activeTaskId &&
    entry?.contract
    ? { frame, entry, runtime }
    : null;
}

export const readSkillReferenceSpec: ToolSpec<
  z.infer<typeof readSkillReferenceInputSchema>,
  SkillOutput
> = {
  name: 'read_skill_reference',
  kind: 'coordination',
  contract: readContract,
  inputSchema: readSkillReferenceInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects,
  execute: async (input, context) => {
    const active = activeEntry(context, input.activation_id);
    if (!active) return { ok: false, stdout: '', stderr: 'Skill frame is unavailable or changed.' };
    const normalized = input.path.replaceAll('\\', '/');
    if (
      !/^(?:scripts|references|assets|evals)\//.test(normalized) ||
      !active.entry.contract!.files.includes(normalized) ||
      normalized.includes('\0')
    ) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Skill reference is not declared by the active Workflow Contract.',
      };
    }
    const root = resolve(active.entry.sourcePath);
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, stdout: '', stderr: 'Skill reference path escapes its Skill directory.' };
    }
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return {
          ok: false,
          stdout: '',
          stderr: 'Skill reference must be a regular non-symlink file.',
        };
      }
      if (stat.size > 128 * 1024) {
        return {
          ok: false,
          stdout: '',
          stderr:
            'Skill reference exceeds the 128 KiB direct-read limit; expose it through an Artifact in a later workflow step.',
        };
      }
      const content = readFileSync(target);
      const utf8 = content.toString('utf8');
      const encoding = Buffer.from(utf8, 'utf8').equals(content) ? 'utf8' : 'base64';
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          activation_id: active.frame.activationId,
          path: input.path,
          encoding,
          content: encoding === 'utf8' ? utf8 : content.toString('base64'),
        }),
        stderr: '',
      };
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: `Unable to read Skill reference: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Read', preview: 'Skill reference' },
  }),
};

export const completeSkillSpec: ToolSpec<z.infer<typeof completeSkillInputSchema>, SkillOutput> = {
  name: 'complete_skill',
  kind: 'coordination',
  contract: completeContract,
  inputSchema: completeSkillInputSchema,
  declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects,
  execute: async (input, context) => {
    const active = activeEntry(context, input.activation_id);
    if (!active) return { ok: false, stdout: '', stderr: 'Skill frame is unavailable or changed.' };
    const outputError = validateCapabilityArguments(
      active.entry.contract!.outputSchema,
      input.output,
    );
    if (outputError) return { ok: false, stdout: '', stderr: outputError };
    const runtimeEvents: RuntimeEvent[] = [
      {
        type: 'skill.frame_closed',
        activationId: active.frame.activationId,
        status: 'closed',
        reason: 'Workflow completed with validated structured output.',
        closedAt: new Date().toISOString(),
        output: input.output,
      },
    ];
    if (active.runtime.verificationEnabled) {
      const verification = verificationRequestForSkill({
        activation: active.frame,
        contract: active.entry.contract!,
        sourcePath: active.entry.sourcePath,
        workspace: context.workspace,
      });
      if (verification) runtimeEvents.push(verification);
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        activation_id: active.frame.activationId,
        output: input.output,
      }),
      stderr: '',
      runtimeEvents,
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Complete', preview: 'Skill' },
    runtimeEvents: output.runtimeEvents,
  }),
};
