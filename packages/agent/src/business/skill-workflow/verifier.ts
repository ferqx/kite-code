import { createHash } from 'node:crypto';
import {
  createLinuxHostShellJob,
  createMacosHostShellJob,
  createShellJob,
  type MacosHostPaths,
  type ShellJobOptions,
} from '@kite-ai/agent/jobs/shell';
import type { Extension, JobDefinition, JobHandle, Json } from '../../extensions';
import { canonicalJson } from '../../json';
import {
  type CompiledSkillWorkflow,
  revalidateSkillWorkflow,
  type WorkflowCapability,
} from '../../skills/workflow-contract';
import { validateWorkflowArguments } from '../../skills/workflow-contract/schema';
import { AgentError } from '../../storage/types';

export interface SkillWorkflowVerifierOptions {
  readonly entries: readonly CompiledSkillWorkflow[];
  readonly resolveCapability?: (id: string) => WorkflowCapability | undefined;
  readonly shell: ShellJobOptions;
  readonly host?: Omit<MacosHostPaths, 'cwd' | 'workspaceRoot' | 'readOnlySourceRoot'>;
}
const definitionId = 'skill.workflow.verify';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface LiveVerification {
  shell: JobDefinition;
  handle: JobHandle;
  timedOut: boolean;
  timeoutSettled(): Promise<void>;
  cleanup(): void;
}
/** Trusted explicit assembly. Preparation describes a sealed request; only ordinary Job start executes. */
export function createSkillWorkflowVerifier(options: SkillWorkflowVerifierOptions) {
  const entries = new Map(
    options.entries.map((entry) => [entry.descriptor.capabilityId, structuredClone(entry)]),
  );
  if (entries.size !== options.entries.length) throw new AgentError('workflow_duplicate_skill');
  const resolver = options.resolveCapability;
  const configuration = { ...options.shell, env: { ...options.shell.env } };
  if (configuration.linux && (process.platform !== 'linux' || !options.host))
    throw new AgentError('workflow_verifier_platform_unqualified');
  const live = new WeakMap<JobHandle, LiveVerification>();
  const get = (handle: JobHandle) => {
    const state = live.get(handle);
    if (!state) throw new AgentError('workflow_verifier_handle_invalid');
    return state;
  };
  const job: JobDefinition = {
    id: definitionId,
    version: '1',
    description: 'Verify the exact Skill Workflow script through the supervised ordinary Shell Job',
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
      },
      required: ['skillId', 'revision', 'activationId', 'attempt', 'outputDigest', 'output'],
    },
    resources: { slot: 'process' },
    async start(input, context) {
      context.signal.throwIfAborted();
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'activationId,attempt,output,outputDigest,revision,skillId'
      )
        throw new AgentError('workflow_verifier_input_invalid');
      const { skillId, revision, activationId, attempt, outputDigest, output } = input;
      if (
        typeof skillId !== 'string' ||
        typeof revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(revision) ||
        typeof activationId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(activationId) ||
        typeof attempt !== 'number' ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        typeof outputDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(outputDigest) ||
        createHash('sha256').update(canonicalJson(output!)).digest('hex') !== outputDigest
      )
        throw new AgentError('workflow_verifier_input_invalid');
      const original = entries.get(skillId);
      if (
        !original?.contract ||
        original.descriptor.availability !== 'available' ||
        original.descriptor.revision !== revision
      )
        throw new AgentError('workflow_source_changed');
      const entry = revalidateSkillWorkflow(original, resolver);
      if (
        !entry.contract ||
        entry.descriptor.availability !== 'available' ||
        entry.descriptor.revision !== revision ||
        !entry.sourceBinding
      )
        throw new AgentError('workflow_source_changed');
      const contract = entry.contract;
      if (validateWorkflowArguments(contract.outputSchema, output))
        throw new AgentError('workflow_output_schema_invalid');
      if (contract.verification.strategy !== 'script' || !contract.verification.entrypoint)
        throw new AgentError('workflow_verifier_unavailable');
      const timeout = contract.verification.timeoutMs ?? contract.execution.timeoutMs;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
        throw new AgentError('workflow_verifier_timeout_invalid');
      const jobOptions = { ...configuration, cwd: entry.sourceBinding.canonicalRoot };
      const host = options.host && {
        ...options.host,
        workspaceRoot: configuration.cwd,
        ...(entry.source === 'user'
          ? { readOnlySourceRoot: entry.sourceBinding.canonicalRoot }
          : {}),
      };
      const shell =
        host && process.platform === 'linux' && configuration.linux
          ? createLinuxHostShellJob({
              ...jobOptions,
              ...host,
              bubblewrapPath: configuration.linux.bubblewrapPath,
            })
          : host && process.platform === 'darwin'
            ? createMacosHostShellJob({ ...jobOptions, ...host })
            : createShellJob(jobOptions);
      const controller = new AbortController();
      const abort = () => controller.abort(context.signal.reason);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
      let timedOut = false;
      let originalHandle: JobHandle | undefined;
      let timeoutSettlement: Promise<void> = Promise.resolve();
      const timer = setTimeout(() => {
        if (!originalHandle) {
          timedOut = true;
          controller.abort(new AgentError('workflow_verification_timeout'));
          return;
        }
        timeoutSettlement = shell.cancel(originalHandle).then(
          (confirmation) => {
            timedOut = confirmation.status !== 'already_finished';
          },
          () => {
            timedOut = true;
            controller.abort(new AgentError('workflow_verification_timeout'));
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
            command: `${quote(configuration.bunExecutable ?? process.execPath)} run ${quote(contract.verification.entrypoint)}`,
          },
          { ...context, signal: controller.signal },
        );
        originalHandle = handle;
        const wrapper: JobHandle = { reference: handle.reference };
        live.set(wrapper, {
          shell,
          handle,
          get timedOut() {
            return timedOut;
          },
          timeoutSettled: () => timeoutSettlement,
          cleanup,
        });
        return wrapper;
      } catch (error) {
        cleanup();
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
        if (!state.timedOut) {
          yield event;
          continue;
        }
        yield {
          ...event,
          result: {
            ...event.result,
            outcome: event.supervision === 'ended' ? 'failed' : 'outcome_unknown',
            content: 'workflow_verification_timeout',
            details: { shellResult: event.result.details ?? null, timeout: true },
          },
        };
      }
    },
    cancel(handle) {
      const state = get(handle);
      return state.shell.cancel(state.handle);
    },
    async dispose(handle) {
      const state = get(handle);
      try {
        await state.shell.dispose(state.handle);
      } finally {
        state.cleanup();
      }
    },
  };
  const extension: Extension = {
    id: 'builtin.skill-workflow.verifier',
    version: '1',
    apiMajor: 1,
    jobs: [job],
  };
  return {
    extension,
    verificationJob: {
      definitionId,
      definitionVersion: '1',
      prepare(input: {
        entry: CompiledSkillWorkflow;
        activationId: string;
        attempt: number;
        outputDigest: string;
        output: Json;
      }): Json {
        const original = entries.get(input.entry.descriptor.capabilityId);
        if (
          !original ||
          canonicalJson(original as unknown as Json) !==
            canonicalJson(input.entry as unknown as Json)
        )
          throw new AgentError('workflow_source_changed');
        return {
          skillId: original.descriptor.capabilityId,
          revision: original.descriptor.revision,
          activationId: input.activationId,
          attempt: input.attempt,
          outputDigest: input.outputDigest,
          output: structuredClone(input.output),
        };
      },
    },
  };
}
