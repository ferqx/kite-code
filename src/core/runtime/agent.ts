import { randomUUID } from 'node:crypto';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import type { SandboxBackend } from '@/core/sandbox';
import { SessionLogCollector } from '@/core/session-logger';
import { evaluateSkillActivation, refreshSkillCatalog } from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import type { RuntimeEvent } from './events';
import { createRuntimeEffectExecutor } from './executor';
import { recordRuntimeFailure } from './failures';
import { createAgentKernel } from './kernel';
import { type RuntimeActionProvider, runRuntimeLoop } from './runner';
import { getActiveTask } from './state';

/** Build redacted admission facts for unavailable required providers before model execution. */
export function requiredProviderAdmissionEvents(
  state: Readonly<import('./state').RuntimeState>,
  mcpManager: McpRuntimeProvider | undefined,
  enabled: boolean,
): RuntimeEvent[] {
  if (
    !enabled ||
    !mcpManager ||
    (state.interactions.kind !== 'idle' &&
      state.interactions.kind !== 'awaiting_provider_admission')
  ) {
    return [];
  }
  const pending = new Set(state.providerAdmission.pending.map((entry) => entry.providerId));
  return mcpManager
    .getProviderDirectorySnapshot()
    .entries.filter(
      (entry) =>
        entry.required &&
        entry.status !== 'ready' &&
        entry.status !== 'degraded' &&
        !pending.has(entry.providerId) &&
        !state.providerAdmission.waivers[entry.providerId],
    )
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
    .map((entry) => ({
      type: 'provider.admission_required' as const,
      interactionId: randomUUID(),
      providerId: entry.providerId,
      source: entry.source,
      providerStatus: entry.status,
      ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
      retryable: entry.retryable,
    }));
}

/** Inputs for the graph-free runtime entry point. */
export interface RunRuntimeAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  runtimeStorePath: string;
  config: AgentConfig;
  model?: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  /** Explicit user-requested Workflow Contract activations for the initial task. */
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  /** 初始执行阶段 / Initial execution phase */
  phase?: 'planning' | 'building';
  thinkingLevel?: string | null;
  sandboxBackend?: SandboxBackend | 'unknown';
  signal?: AbortSignal;
  frontend?: string;
}

/** Start a fresh RuntimeStore-backed session without LangGraph/checkpoint state. */
export async function* runRuntimeAgent(
  input: RunRuntimeAgentInput,
  provider: RuntimeActionProvider,
): AsyncGenerator<RuntimeEvent> {
  const model =
    input.model ??
    createChatModel({
      ...input.config,
      reasoningEffort: input.thinkingLevel ?? input.config.reasoningEffort ?? null,
    });
  const kernel = createAgentKernel({
    threadId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    storePath: input.runtimeStorePath,
    interactionMode: input.interactionMode ?? input.config.interactionMode ?? 'accept_edits',
    authorizationMode: input.authorizationMode,
    authorizationSource: input.authorizationSource,
    // Plan entry is a persisted event below; initialPhase is no longer the
    // source of truth for the task lifecycle.
    phase: 'building',
    sandboxAvailable: input.sandboxBackend === 'seatbelt' || input.sandboxBackend === 'bubblewrap',
  });
  const collector = new SessionLogCollector(
    input.threadId,
    input.workspace,
    input.frontend ?? 'runtime',
    { provider: input.config.providerName, name: input.config.modelName },
  );
  let exitStatus: 'completed' | 'aborted' | 'fatal' = 'completed';
  try {
    const admissionEvents = requiredProviderAdmissionEvents(
      kernel.getState(),
      input.mcpManager,
      getFeatureFlags(input.config).mcpProviderActionV1,
    );
    for (const event of admissionEvents) {
      kernel.processEvent(event);
      collector.recordRuntime(event);
      yield event;
    }

    const resumedInteraction =
      getActiveTask(kernel.getState()) && kernel.getState().interactions.kind !== 'idle';
    if (!resumedInteraction) {
      if (input.phase === 'planning') {
        const taskStarted: RuntimeEvent = {
          type: 'task.started',
          taskId: randomUUID(),
          userGoal: input.task,
          turnId: kernel.getState().turn.turnId,
        };
        kernel.processEvent(taskStarted);
        collector.recordRuntime(taskStarted);
        yield taskStarted;
      }

      if (input.phase === 'planning') {
        const activeTask = getActiveTask(kernel.getState());
        if (activeTask) {
          const entered: RuntimeEvent = {
            type: 'planning.entered',
            taskId: activeTask.taskId,
            source: 'user_command',
          };
          kernel.processEvent(entered);
          collector.recordRuntime(entered);
          yield entered;
        }
      }

      const initial: RuntimeEvent = {
        type: 'user.message_appended',
        messageId: randomUUID(),
        content: input.task,
      };
      kernel.processEvent(initial);
      collector.recordRuntime(initial);
      yield initial;

      const turnStarted: RuntimeEvent = {
        type: 'turn.started',
        turnId: crypto.randomUUID(),
      };
      kernel.processEvent(turnStarted);
      collector.recordRuntime(turnStarted);
      yield turnStarted;

      if (input.initialSkillActivations && input.initialSkillActivations.length > 0) {
        const catalog = input.skillOptions ? refreshSkillCatalog(input.skillOptions) : undefined;
        for (const requested of input.initialSkillActivations) {
          const evaluation = catalog
            ? evaluateSkillActivation({
                state: kernel.getState(),
                catalog,
                flags: getFeatureFlags(input.config),
                request: {
                  skillId: requested.skillId,
                  input: requested.input,
                  requestedBy: 'user',
                  implicit: false,
                },
              })
            : { ok: false as const, reason: 'Skill catalog is unavailable.' };
          if (!evaluation.ok) {
            const failed: RuntimeEvent = {
              type: 'run.error',
              message: `Skill activation rejected: ${evaluation.reason}`,
              recoverable: false,
              turnId: kernel.getState().turn.turnId,
            };
            kernel.processEvent(failed);
            collector.recordRuntime(failed);
            yield failed;
            return;
          }
          kernel.processEvents(evaluation.events);
          for (const event of evaluation.events) {
            collector.recordRuntime(event);
            yield event;
          }
        }
      }
    }

    const executor = createRuntimeEffectExecutor({
      config: input.config,
      model,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      signal: input.signal,
    });
    for await (const event of runRuntimeLoop(kernel, executor, provider)) {
      collector.recordRuntime(event);
      // Task lifecycle facts are durable RuntimeEvents, but remain internal to
      // the legacy public stream; UI projections are driven by planning/tool
      // events and existing consumers should not see extra turn markers.
      if (event.type === 'task.completed') continue;
      yield event;
    }
    if (input.signal?.aborted) exitStatus = 'aborted';
  } catch (error) {
    exitStatus = 'fatal';
    const failure = recordRuntimeFailure({
      kind: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      phase: 'building',
      turnId: kernel.getState().turn.turnId,
      userVisible: true,
    });
    const errorEvent: RuntimeEvent = {
      type: 'run.error',
      message: failure.message,
      recoverable: false,
      failure: failure.failure,
      turnId: failure.turnId,
    };
    kernel.processEvent(errorEvent);
    collector.recordRuntime(errorEvent);
    yield errorEvent;

    const aborted: RuntimeEvent = {
      type: 'turn.aborted',
      turnId: kernel.getState().turn.turnId,
      reason: errorEvent.message,
    };
    kernel.processEvent(aborted);
    collector.recordRuntime(aborted);
    yield aborted;
  } finally {
    await collector.finalize(exitStatus);
    kernel.close();
  }
}
