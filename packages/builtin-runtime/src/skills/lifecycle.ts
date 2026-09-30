import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { evaluateSkillActivation } from './activation';
import { validateCapabilityArguments } from './capability-domain';
import type { SkillCatalogEntry, SkillCatalogSnapshot } from './catalog';
import type {
  SkillFeatureFlags as FeatureFlags,
  SkillRuntimeEvent as RuntimeEvent,
  SkillRuntimeStateView as RuntimeState,
  SkillForkResult as SubAgentResult,
} from './runtime-domain';
import { verificationRequestForSkill } from './runtime-domain';

export interface SkillLifecycleContext {
  state: RuntimeState;
  catalog?: SkillCatalogSnapshot;
  verificationEnabled: boolean;
}

export interface SkillActivationContext extends SkillLifecycleContext {
  flags?: Readonly<FeatureFlags>;
  runFork?: (input: {
    agent: string;
    capabilityCeiling: readonly string[];
    instructions: string;
    workflowInput: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }) => Promise<SubAgentResult | null>;
}

export interface SkillLifecycleEmission {
  ok: boolean;
  stdout: string;
  stderr: string;
  runtimeEvents?: RuntimeEvent[];
}

interface ActiveSkillFrame {
  frame: RuntimeState['skills']['frames'][string];
  entry: SkillCatalogEntry & {
    contract: NonNullable<SkillCatalogEntry['contract']>;
  };
  runtime: SkillLifecycleContext;
}

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

export async function activateSkillLifecycle(
  runtime: SkillActivationContext,
  input: { skill_id: string; input: Record<string, unknown> },
): Promise<SkillLifecycleEmission> {
  const activation =
    runtime.catalog && runtime.flags
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
  const entry = runtime.catalog?.entries.find(
    (candidate) =>
      !candidate.shadowedBy &&
      candidate.descriptor.capabilityId === activation.activation.skillId &&
      candidate.descriptor.revision === activation.activation.skillRevision &&
      candidate.contract,
  );
  if (!entry?.contract || !runtime.runFork) {
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
      workspace: runtime.state.session.workspace,
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
}

export function findActiveSkillFrame(
  runtime: SkillLifecycleContext,
  activationId: string,
): ActiveSkillFrame | null {
  const frame = runtime.state.skills.frames[activationId];
  const entry =
    frame &&
    runtime.catalog?.entries.find(
      (candidate) =>
        !candidate.shadowedBy &&
        candidate.descriptor.capabilityId === frame.skillId &&
        candidate.descriptor.revision === frame.skillRevision &&
        candidate.contract,
    );
  return frame?.status === 'active' &&
    frame.taskId === runtime.state.activeTaskId &&
    entry?.contract
    ? {
        frame,
        entry: entry as ActiveSkillFrame['entry'],
        runtime,
      }
    : null;
}

export function readSkillReference(
  runtime: SkillLifecycleContext,
  input: { activation_id: string; path: string },
): SkillLifecycleEmission {
  const active = findActiveSkillFrame(runtime, input.activation_id);
  if (!active)
    return {
      ok: false,
      stdout: '',
      stderr: 'Skill frame is unavailable or changed.',
    };
  const normalized = input.path.replaceAll('\\', '/');
  if (
    !/^(?:scripts|references|assets|evals)\//.test(normalized) ||
    !active.entry.contract.files.includes(normalized) ||
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
    return {
      ok: false,
      stdout: '',
      stderr: 'Skill reference path escapes its Skill directory.',
    };
  }
  try {
    const assertSourceBinding = () => {
      const binding = active.entry.sourceBinding;
      const canonicalRoot = realpathSync(root);
      const current = lstatSync(canonicalRoot);
      if (binding) {
        if (
          canonicalRoot !== binding.canonicalRoot ||
          !current.isDirectory() ||
          current.dev !== binding.device ||
          current.ino !== binding.inode
        ) {
          throw new Error('Skill source binding changed after compilation.');
        }
      } else if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
        throw new Error('Skill root alias requires a compiled source binding.');
      }
      return canonicalRoot;
    };
    const canonicalRoot = assertSourceBinding();
    const canonicalTarget = resolve(canonicalRoot, rel);
    const stat = lstatSync(canonicalTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Skill reference must be a regular non-symlink file.',
      };
    }
    const content = readBoundSkillReference(canonicalRoot, canonicalTarget, stat);
    assertSourceBinding();
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
}

function readBoundSkillReference(root: string, target: string, expected: Stats): Buffer {
  const directories: Array<{ path: string; stat: Stats }> = [];
  let directory = dirname(target);
  while (true) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Skill reference directories must be non-symlink directories.');
    }
    directories.push({ path: directory, stat });
    if (directory === root) break;
    directory = dirname(directory);
  }
  const canonicalRoot = realpathSync(root);
  const assertBindings = () => {
    for (const binding of directories) {
      const current = lstatSync(binding.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== binding.stat.dev ||
        current.ino !== binding.stat.ino
      ) {
        throw new Error('Skill reference directory changed while reading.');
      }
    }
    const canonical = realpathSync(target);
    const rel = relative(canonicalRoot, canonical);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Skill reference path escapes its Skill directory.');
    }
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameReferenceIdentity(expected, opened)) {
      throw new Error('Skill reference file changed while opening.');
    }
    assertBindings();
    if (!sameReferenceIdentity(opened, lstatSync(target))) {
      throw new Error('Skill reference path changed while opening.');
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !sameReferenceIdentity(opened, after) ||
      content.byteLength !== after.size ||
      !sameReferenceIdentity(after, lstatSync(target))
    ) {
      throw new Error('Skill reference file changed while reading.');
    }
    assertBindings();
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameReferenceIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function completeSkillLifecycle(
  runtime: SkillLifecycleContext,
  input: { activation_id: string; output: Record<string, unknown> },
): SkillLifecycleEmission {
  const active = findActiveSkillFrame(runtime, input.activation_id);
  if (!active)
    return {
      ok: false,
      stdout: '',
      stderr: 'Skill frame is unavailable or changed.',
    };
  const outputError = validateCapabilityArguments(active.entry.contract.outputSchema, input.output);
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
      contract: active.entry.contract,
      sourcePath: active.entry.sourcePath,
      workspace: active.runtime.state.session.workspace,
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
}
