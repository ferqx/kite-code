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
    phase: input.phase,
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
      turnId: kernel.getState().turn.turnId,
    };
    kernel.processEvent(turnStarted);
    collector.recordRuntime(turnStarted);
    yield turnStarted;

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
