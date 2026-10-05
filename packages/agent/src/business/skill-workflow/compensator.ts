import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMacosConfinedShellJob, type ShellJobOptions } from '@kite-ai/agent/jobs/shell';
import type { Extension, JobDefinition, JobHandle, Json } from '../../extensions';
import { canonicalJson } from '../../json';
import type { CompiledSkillWorkflow, WorkflowCapability } from '../../skills/workflow-contract';
import { validateWorkflowArguments } from '../../skills/workflow-contract/schema';
import { AgentError } from '../../storage/types';
import {
  assertDirectory,
  directoryIdentity,
  sealCompensationAssets,
  within,
} from './compensation-assets';

export interface SkillWorkflowCompensatorOptions {
  readonly entries: readonly CompiledSkillWorkflow[];
  readonly resolveCapability?: (id: string) => WorkflowCapability | undefined;
  readonly shell: ShellJobOptions;
  readonly protectedRoots: readonly string[];
  readonly temporaryRoot?: string;
}
interface LiveCompensation {
  shell: JobDefinition;
  handle: JobHandle;
  release(): void;
  cleanup(): void;
  timedOut: boolean;
  timeoutSettled(): Promise<void>;
}
const definitionId = 'skill.workflow.compensate';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Only ordinary Job start executes the exact declaration; unsupported confinement never falls back. */
export function createSkillWorkflowCompensator(options: SkillWorkflowCompensatorOptions) {
  if (process.platform !== 'darwin')
    throw new AgentError('workflow_compensation_platform_unsupported');
  const entries = new Map(
    options.entries.map((entry) => [entry.descriptor.capabilityId, structuredClone(entry)]),
  );
  if (entries.size !== options.entries.length) throw new AgentError('workflow_duplicate_skill');
  const workspace = directoryIdentity(options.shell.cwd);
  const base = directoryIdentity(options.temporaryRoot ?? tmpdir());
  const protectedPaths = options.protectedRoots.map(directoryIdentity);
  if (
    within(workspace.canonical, base.canonical) ||
    protectedPaths.some((path) => within(path.canonical, base.canonical))
  )
    throw new AgentError('workflow_compensation_path_invalid');
  const configuration = { ...options.shell, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } };
  const resolver = options.resolveCapability;
  const supports = (entry: CompiledSkillWorkflow) => {
    const original = entries.get(entry.descriptor.capabilityId);
    return (
      !!original?.contract?.recovery.compensation &&
      !!original.sourceBinding &&
      original.descriptor.availability === 'available' &&
      within(workspace.canonical, original.sourceBinding.canonicalRoot) &&
      canonicalJson(original as unknown as Json) === canonicalJson(entry as unknown as Json)
    );
  };
  const live = new WeakMap<JobHandle, LiveCompensation>();
  const get = (handle: JobHandle) => {
    const state = live.get(handle);
    if (!state) throw new AgentError('workflow_compensator_handle_invalid');
    return state;
  };
  const job: JobDefinition = {
    id: definitionId,
    version: '1',
    description:
      'Run the exact declared Skill compensation with fixed network and filesystem confinement',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skillId: { type: 'string', minLength: 1 },
        revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        activationId: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' },
        attempt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        outputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        output: { type: 'object' },
        decisionKey: { type: 'string', minLength: 1 },
        decisionDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      required: [
        'skillId',
        'revision',
        'activationId',
        'attempt',
        'outputDigest',
        'output',
        'decisionKey',
        'decisionDigest',
      ],
    },
    resources: { slot: 'process' },
    async start(input, context) {
      context.signal.throwIfAborted();
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'activationId,attempt,decisionDigest,decisionKey,output,outputDigest,revision,skillId'
      )
        throw new AgentError('workflow_compensator_input_invalid');
      const {
        skillId,
        revision,
        activationId,
        attempt,
        outputDigest,
        output,
        decisionKey,
        decisionDigest,
      } = input;
      if (
        typeof skillId !== 'string' ||
        typeof revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(revision) ||
        typeof activationId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(activationId) ||
        !Number.isSafeInteger(attempt) ||
        Number(attempt) < 1 ||
        typeof outputDigest !== 'string' ||
        hash(output!) !== outputDigest ||
        typeof decisionKey !== 'string' ||
        !decisionKey ||
        typeof decisionDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(decisionDigest)
      )
        throw new AgentError('workflow_compensator_input_invalid');
      const entry = entries.get(skillId);
      if (!entry || !supports(entry) || entry.descriptor.revision !== revision)
        throw new AgentError('workflow_compensation_unavailable');
      if (validateWorkflowArguments(entry.contract!.outputSchema, output))
        throw new AgentError('workflow_output_schema_invalid');
      assertDirectory(workspace);
      assertDirectory(base);
      protectedPaths.forEach(assertDirectory);
      const assets = sealCompensationAssets(entry, base.canonical, resolver);
      let released = false;
      const release = () => {
        if (!released) {
          assets.cleanup();
          released = true;
        }
      };
      const controller = new AbortController();
      const abort = () => controller.abort(context.signal.reason);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
      let timedOut = false,
        originalHandle: JobHandle | undefined;
      let settlement: Promise<void> = Promise.resolve();
      const timeout = entry.contract!.execution.timeoutMs;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
        release();
        context.signal.removeEventListener('abort', abort);
        throw new AgentError('workflow_compensation_timeout_invalid');
      }
      let shell: JobDefinition;
      try {
        shell = createMacosConfinedShellJob({
          ...configuration,
          cwd: workspace.canonical,
          protectedRoots: protectedPaths.map((path) => path.canonical),
          runtimeReadOnlyRoots: [assets.root],
          temporaryRoot: base.canonical,
        });
      } catch (error) {
        context.signal.removeEventListener('abort', abort);
        release();
        throw error;
      }
      const timer = setTimeout(() => {
        if (!originalHandle) {
          timedOut = true;
          controller.abort(new AgentError('workflow_compensation_timeout'));
          return;
        }
        settlement = shell.cancel(originalHandle).then(
          (confirmation) => {
            timedOut = confirmation.status !== 'already_finished';
          },
          () => {
            timedOut = true;
            controller.abort(new AgentError('workflow_compensation_timeout'));
          },
        );
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
      };
      try {
        const handle = await shell.start(
          {
            command: `exec ${quote(configuration.bunExecutable ?? process.execPath)} run ${quote(join(assets.root, entry.contract!.recovery.compensation!))}`,
          },
          { ...context, signal: controller.signal },
        );
        originalHandle = handle;
        const wrapper: JobHandle = {
          reference: {
            shell: handle.reference,
            skillId,
            revision,
            activationId,
            attempt: Number(attempt),
            outputDigest,
            decisionKey,
            decisionDigest,
            assetsDigest: assets.assetsDigest,
          },
        };
        live.set(wrapper, {
          shell,
          handle,
          release,
          cleanup,
          get timedOut() {
            return timedOut;
          },
          timeoutSettled: () => settlement,
        });
        return wrapper;
      } catch (error) {
        cleanup();
        // start may already have entered a guardian. Without its stop proof retain the sealed code.
        throw error;
      }
    },
    async *observe(handle) {
      const state = get(handle);
      for await (const event of state.shell.observe(state.handle)) {
        if (event.type !== 'terminal') {
          yield event;
          continue;
        }
        state.cleanup();
        await state.timeoutSettled();
        if (event.supervision === 'ended') state.release();
        yield state.timedOut
          ? {
              ...event,
              result: {
                ...event.result,
                outcome:
                  event.supervision === 'ended'
                    ? ('failed' as const)
                    : ('outcome_unknown' as const),
                content: 'workflow_compensation_timeout',
                details: { shellResult: event.result.details ?? null, timeout: true },
              },
            }
          : event;
      }
    },
    async cancel(handle) {
      const state = get(handle),
        confirmation = await state.shell.cancel(state.handle);
      if (confirmation.status === 'stopped' || confirmation.status === 'already_finished')
        state.release();
      return confirmation;
    },
    async dispose(handle) {
      const state = get(handle);
      try {
        const confirmation = await state.shell.cancel(state.handle);
        if (confirmation.status === 'stopped' || confirmation.status === 'already_finished')
          state.release();
        await state.shell.dispose(state.handle);
      } finally {
        state.cleanup();
      }
    },
  };
  const extension: Extension = {
    id: 'builtin.skill-workflow.compensator',
    version: '1',
    apiMajor: 1,
    jobs: [job],
  };
  return {
    extension,
    compensationJob: {
      definitionId,
      definitionVersion: '1',
      supports,
      prepare(input: {
        entry: CompiledSkillWorkflow;
        activationId: string;
        attempt: number;
        outputDigest: string;
        output: Json;
        decisionKey: string;
        decisionDigest: string;
      }): Json {
        if (!supports(input.entry)) throw new AgentError('workflow_compensation_unavailable');
        return {
          skillId: input.entry.descriptor.capabilityId,
          revision: input.entry.descriptor.revision,
          activationId: input.activationId,
          attempt: input.attempt,
          outputDigest: input.outputDigest,
          output: structuredClone(input.output),
          decisionKey: input.decisionKey,
          decisionDigest: input.decisionDigest,
        };
      },
    },
  };
}
