import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '@/core/config/index';
import type { McpManager } from '@/core/mcp';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import type { SandboxBackend } from '@/core/sandbox';
import { SessionLogCollector } from '@/core/session-logger';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import type { RuntimeEvent } from './events';
import { createRuntimeEffectExecutor } from './executor';
import { createAgentKernel } from './kernel';
import { type RuntimeActionProvider, runRuntimeLoop } from './runner';
import { getActiveTask } from './state';

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
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
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
    const resumedReview =
      getActiveTask(kernel.getState()) && kernel.getState().interactions.kind === 'awaiting_review';
    if (!resumedReview) {
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
    const errorEvent: RuntimeEvent = {
      type: 'run.error',
      message: error instanceof Error ? error.message : String(error),
      recoverable: false,
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
