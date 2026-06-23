import { readFile, stat as statAsync } from 'node:fs/promises';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';
import type { UserAction } from '@/protocol/actions';
import type {
  AgentEvent,
  AgentPhase,
  AgentPlan,
  CacheMetricsPayload,
  NeedPlanReviewPayload,
  StateChangePayload,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
  WorkspaceAccessRequest,
} from '@/protocol/events';
import type { UserInputProvider } from '@/protocol/provider';
import { createPromptCacheStandardTracker, extractPromptCacheMetrics } from './cache-metrics';
import { genSpanId } from './id-utils';

/** 统一事件管道：所有 AgentEvent 通过此接口发送到 TUI + 日志等消费者 */
interface EventSink {
  emit(event: AgentEvent): void;
}

import type { AgentConfig } from './config/index';
import { buildCodeAgentGraph } from './harness/graph';
import { defaultAuthorizationState } from './harness/tool-policy';
import type { SupportedChatModel } from './model/factory';
import type { BunSqliteSaver } from './persistence/checkpoint';
import { SessionLogCollector } from './session-logger';
import { countTokens } from './token-counter';
import type { ShellExecutor } from './tools/shell';
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ContextBudget,
  ModelRetryEvent,
  ThreadAuthorizationState,
} from './types';

export interface RunAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride;
  /** 测试用：注入自定义模型（mock）/ Inject custom model for testing mocks the LLM */
  model?: SupportedChatModel;
  /** 恢复值：提供时将直接从 checkpoint 恢复而非创建新 initial state / Resume value: if provided, resumes from checkpoint instead of creating new initial state */
  resume?: AgentResumeValue;
  /** 外部中止信号 / External abort signal to cancel the agent loop */
  signal?: AbortSignal;
  /** 思考级别，映射到 reasoning_effort API 参数 / Thinking level, mapped to reasoning_effort API param */
  thinkingLevel?: string | null;
  skills?: import('@/core/skills/types').SkillManifest[];
  skillOptions?: import('@/core/skills/types').SkillScanOptions;
  /** 可选 MCP 管理器，提供 MCP 工具和资源 / Optional MCP manager, provides MCP tools and resources */
  mcpManager?: import('@/core/mcp').McpManager;
  /** 工具完成回调 / Per-tool completion callback for progressive TUI display */
  toolResultSink?: (
    callId: string,
    toolName: string,
    ok: boolean,
    summary: string,
    totalLines?: number,
    toolTokenCount?: number,
  ) => void;
  /** 调用端标识 / Frontend identity */
  frontend?: string;
}

export interface StreamCodeAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride;
  /** 思考级别 / Thinking level */
  thinkingLevel?: string | null;
  /** 外部中止信号 / External abort signal */
  signal?: AbortSignal;
  /** 可选 MCP 管理器 / Optional MCP manager */
  mcpManager?: import('@/core/mcp').McpManager;
}

export interface ResumeCodeAgentInput extends Omit<StreamCodeAgentInput, 'task'> {
  resume: AgentResumeValue;
}

/** 从上次 checkpoint 读取 thread 授权状态 / Read thread authorization state from last checkpoint */
async function readLastAuthorization(
  checkpointer: BunSqliteSaver,
  threadId: string,
): Promise<ThreadAuthorizationState | null> {
  try {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!tuple) return null;
    const auth = tuple.checkpoint.channel_values?.authorization as
      | ThreadAuthorizationState
      | undefined;
    if (!auth || typeof auth.mode !== 'string') return null;
    return auth;
  } catch {
    return null;
  }
}

/** 按错误类型分类是否为可恢复错误 / Classify whether an error is recoverable */
export function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message?.toLowerCase() ?? '';
    if (msg.includes('etimedout')) return true; // TCP 超时
    if (msg.includes('econnreset')) return true; // 连接重置
    if (msg.includes('429')) return true; // 速率限制
    if (msg.includes('503') || msg.includes('502')) return true; // 服务不可用
    if (msg.includes('overloaded')) return true; // 模型过载
    if (msg.includes('timeout')) return true; // 通用超时
    if (msg.includes('rate limit')) return true; // 速率限制文字
    if (error.name === 'AbortError') return false; // 用户主动取消 → 不可恢复
  }
  return false; // 默认不可恢复（配置/权限/未知错误）
}

export async function* runAgent(
  provider: UserInputProvider,
  input: RunAgentInput,
): AsyncGenerator<AgentEvent> {
  const signal = input.signal;

  // ── 统一事件管道 ──
  // sink 必须先于 collector 定义（闭包捕获），collector 在 sink 之后赋值。
  // subagentEventSink 也使用 sink，因此定义顺序：sink → collector → subagentEventSink → graph。
  let collector: SessionLogCollector;

  const sink: EventSink = {
    emit(event: AgentEvent): void {
      // TUI 端不应该抛异常，但防御纵深包一层
      try {
        provider.onEvent(event);
      } catch {
        /* TUI 异常不影响 Agent */
      }
      try {
        collector.record(event);
      } catch {
        /* 日志失败不影响 Agent */
      }
    },
  };

  collector = new SessionLogCollector(
    input.threadId,
    input.workspace,
    input.frontend ?? 'unknown',
    { provider: input.config.providerName, name: input.config.modelName },
  );

  // 用户初始任务 → 事件标准化（resume 时不重复记录）
  if (!input.resume) {
    sink.emit({ type: 'user_message', data: { text: input.task, kind: 'task' } });
  }

  const subagentEventSink: import('@/core/subagent/types').SubAgentEventSink = (e) => {
    switch (e.type) {
      case 'start':
        sink.emit({ type: 'subagent_start', data: e.data });
        break;
      case 'step':
        sink.emit({ type: 'subagent_step', data: e.data });
        break;
      case 'tool_result':
        sink.emit({ type: 'subagent_tool_result', data: e.data });
        break;
      case 'done':
        sink.emit({ type: 'subagent_done', data: e.data });
        break;
      case 'error':
        sink.emit({ type: 'subagent_error', data: e.data });
        break;
      case 'cache_metrics':
        sink.emit({
          type: 'subagent_cache_metrics',
          data: {
            subagentId: e.data.subagentId,
            cacheHitTokens: e.data.cacheHitTokens,
            cacheMissTokens: e.data.cacheMissTokens,
            inputTokens: e.data.inputTokens,
          },
        });
        break;
    }
  };

  const toolResultSink =
    input.toolResultSink ??
    ((callId, toolName, ok, summary, totalLines) => {
      // 仅推 TUI（processStream 会从 chunk 生成更完整的 tool_done 并写入日志）
      try {
        provider.onEvent({
          type: 'tool_done',
          data: {
            call_id: callId,
            name: toolName,
            ok,
            summary,
            ...(totalLines != null ? { totalLines } : {}),
          },
        });
      } catch {
        // TUI 异常不影响 Agent
      }
    });

  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skills: input.skills,
    skillOptions: input.skillOptions,
    mcpManager: input.mcpManager,
    subagentEventSink,
    subagentSignal: input.signal,
    toolResultSink,
  });

  try {
    const initialAccess = initialWorkspaceAccessForTask(input.task, input.mode ?? 'auto');
    const initialPhase = workspaceAccessToPhase(initialAccess);

    const prevAuth = await readLastAuthorization(checkpointer, input.threadId);

    const initialState = {
      messages: [new HumanMessage(input.task)],
      workspaceAccess: initialAccess,
      phase: initialPhase,
      plan: null,
      userId: input.userId,
      threadId: input.threadId,
      workspace: input.workspace,
      authorization: prevAuth ?? defaultAuthorizationState(),
      contextBudget: input.contextBudget,
      modelProvider: input.config.providerName,
      modelName: input.config.modelName,
      thinkingLevel: input.thinkingLevel ?? null,
    };

    let resumeValue: AgentResumeValue | null = input.resume ?? null;
    let turnIndex = 0;

    while (true) {
      if (signal?.aborted) break;

      const streamConfig = {
        configurable: { thread_id: input.threadId },
        streamMode: 'updates' as const,
        recursionLimit: 9999999,
      };

      let stream: AsyncIterable<unknown>;
      if (resumeValue) {
        const cmd: Record<string, unknown> = { resume: resumeValue };
        stream = await graph.stream(new Command(cmd), streamConfig);
      } else {
        stream = await graph.stream(initialState, streamConfig);
      }

      resumeValue = null;
      turnIndex++;

      const turnSpanId = genSpanId();
      collector.nextTurn(turnSpanId);
      sink.emit({ type: 'turn_begin', data: { index: turnIndex, spanId: turnSpanId } });
      const result = await processStream(sink, provider, stream, signal, input.workspace);
      sink.emit({ type: 'turn_end', data: { index: turnIndex } });

      yield* result.events;

      if (result.kind === 'done') break;

      // 用户在 ask_user 提问中按 ESC → 终止对话，不回注空答案 / ESC during ask_user → terminate, don't inject empty answer
      if (
        result.kind === 'interrupt' &&
        result.action.type === 'cancel' &&
        result.interruptKind === 'input'
      ) {
        break;
      }

      resumeValue = mapActionToResumeValue(result.action);
    }

    // 根据退出原因确定最终状态 / Determine final status from exit cause
    const exitStatus: 'completed' | 'aborted' | 'fatal' = signal?.aborted ? 'aborted' : 'completed';
    await collector.finalize(exitStatus);
  } catch (e) {
    await collector.finalize('fatal');
    throw e;
  } finally {
    checkpointer.close();
  }
}

export interface RevertInput {
  threadId: string;
  checkpointId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  thinkingLevel?: string | null;
  mcpManager?: import('@/core/mcp').McpManager;
}

/** 当前 thread 恢复到指定 checkpoint 继续执行 / Revert current thread to a checkpoint */
export async function* revertToCheckpoint(
  provider: UserInputProvider,
  input: RevertInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    thinkingLevel: input.thinkingLevel ?? null,
    model: input.model,
    mcpManager: input.mcpManager,
    subagentEventSink: undefined,
    subagentSignal: input.signal,
  });

  const signal = input.signal;

  try {
    // Verify checkpoint exists before attempting revert
    const cpState = await checkpointer.getCheckpointState(input.threadId, input.checkpointId);
    if (!cpState) {
      yield {
        type: 'error' as const,
        data: { message: 'Checkpoint not found', recoverable: false },
      };
      return;
    }

    const streamConfig = {
      configurable: {
        thread_id: input.threadId,
        checkpoint_id: input.checkpointId,
      },
      streamMode: 'updates' as const,
      recursionLimit: 9999999,
    };

    const stream = await graph.stream({ messages: [] }, streamConfig);

    const bareSink: EventSink = {
      emit(e) {
        provider.onEvent(e);
      },
    };
    const result = await processStream(bareSink, provider, stream, signal, input.workspace);
    yield* result.events;
  } finally {
    checkpointer.close();
  }
}

export interface ForkInput {
  oldThreadId: string;
  checkpointId: string;
  newThreadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  thinkingLevel?: string | null;
  mcpManager?: import('@/core/mcp').McpManager;
}

/** 从旧 checkpoint fork 新会话 / Fork a new session from an old checkpoint */
export async function* forkFromCheckpoint(
  provider: UserInputProvider,
  input: ForkInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    thinkingLevel: input.thinkingLevel ?? null,
    model: input.model,
    mcpManager: input.mcpManager,
    subagentEventSink: undefined,
    subagentSignal: input.signal,
  });

  const signal = input.signal;

  try {
    const oldState = await checkpointer.getCheckpointState(input.oldThreadId, input.checkpointId);
    if (!oldState) {
      yield {
        type: 'error' as const,
        data: { message: 'Checkpoint not found', recoverable: false },
      };
      return;
    }

    const initialState = {
      userId: '',
      threadId: input.newThreadId,
      workspace: input.workspace,
      workspaceAccess: oldState.workspaceAccess ?? 'write',
      phase: oldState.phase ?? 'building',
      plan: oldState.plan,
      messages: oldState.messages ?? [],
      authorization: oldState.authorization ?? defaultAuthorizationState(),
      contextBudget: undefined,
      modelProvider: input.config.providerName,
      modelName: input.config.modelName,
      thinkingLevel: null as string | null,
    };

    const streamConfig = {
      configurable: { thread_id: input.newThreadId },
      streamMode: 'updates' as const,
      recursionLimit: 9999999,
    };

    const stream = await graph.stream(initialState, streamConfig);
    const bareSink: EventSink = {
      emit(e) {
        provider.onEvent(e);
      },
    };
    const result = await processStream(bareSink, provider, stream, signal, input.workspace);
    yield* result.events;
  } finally {
    checkpointer.close();
  }
}

type StreamResult =
  | { kind: 'done'; events: AgentEvent[] }
  | {
      kind: 'interrupt';
      action: UserAction;
      events: AgentEvent[];
      interruptKind: 'approval' | 'input' | 'plan_review';
    };

async function processStream(
  sink: EventSink,
  provider: UserInputProvider,
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
  workspace?: string,
): Promise<StreamResult> {
  const { isInterrupted, INTERRUPT } = await import('@langchain/langgraph');
  const cacheStandard = createPromptCacheStandardTracker();
  let currentAccess: WorkspaceAccess = 'write';
  const allEvents: AgentEvent[] = [];
  const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();

  for await (const chunk of stream) {
    if (signal?.aborted) {
      return { events: allEvents, kind: 'done' };
    }

    const interruptData = extractInterrupt(chunk, isInterrupted, INTERRUPT);
    if (interruptData) {
      const event = interruptToEvent(interruptData);
      if (event) {
        sink.emit(event);
        allEvents.push(event);
        const payload = eventToInterruptPayload(interruptData, event);
        if (payload) {
          const action = await provider.requestAction(payload);
          if (action.type === 'input' && action.text) {
            sink.emit({
              type: 'user_message',
              data: { text: action.text, kind: 'answer', interruptType: 'input' },
            });
          }
          const interruptKind =
            event.type === 'need_approval'
              ? ('approval' as const)
              : event.type === 'need_input'
                ? ('input' as const)
                : ('plan_review' as const);
          return { events: allEvents, kind: 'interrupt', action, interruptKind };
        }
      }
      continue;
    }

    const acc = findWorkspaceAccess(chunk);
    if (acc) currentAccess = acc;

    const events = chunkToEvents(chunk, currentAccess, cacheStandard);

    // Record tool calls for cross-chunk file_change matching
    for (const e of events) {
      if (e.type === 'tool_call') {
        pendingToolCalls.set(e.data.call_id, { name: e.data.name, args: e.data.args });
      }
    }
    // Generate file_change events when a write/edit tool completes
    for (const e of events) {
      if (e.type === 'tool_done' && e.data.ok && e.data.name === 'write_file') {
        const call = pendingToolCalls.get(e.data.call_id);
        if (call) {
          const path = call.args.path;
          if (typeof path === 'string') {
            await produceFileChange(events, path, e.data.name, workspace);
          }
        }
      }
    }

    for (const e of events) {
      sink.emit(e);
      allEvents.push(e);
    }
  }

  return { events: allEvents, kind: 'done' };
}

function extractInterrupt(
  chunk: unknown,
  isInterrupted: (c: unknown) => boolean,
  INTERRUPT_KEY: string | symbol,
): unknown {
  if (isInterrupted(chunk)) return (chunk as Record<string | symbol, unknown>)[INTERRUPT_KEY];
  const rec = chunk as Record<string, unknown>;
  if (typeof INTERRUPT_KEY === 'string' && INTERRUPT_KEY in rec) return rec[INTERRUPT_KEY];
  return null;
}

function interruptToEvent(data: unknown): AgentEvent | null {
  const arr = data as Record<string, unknown>[] | undefined;
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const inner = (item as Record<string, unknown>).value;
      if (inner && typeof inner === 'object') {
        const v = inner as Record<string, unknown>;
        if (v.kind === 'tool_approval') {
          const approval = v.approval as ToolApprovalPayload | undefined;
          if (approval && typeof approval === 'object') {
            return { type: 'need_approval', data: approval };
          }
        }
        if (v.kind === 'user_input') {
          const request = v.request as Record<string, unknown> | undefined;
          if (request && typeof request === 'object') {
            const args = request.args as Record<string, unknown> | undefined;
            const rawQuestions = args?.questions as Array<Record<string, unknown>> | undefined;
            const payload: UserInputPayload = {
              question: (args?.question as string) ?? 'User input required',
              options: (args?.options as UserInputPayload['options']) ?? [],
              allow_free_text: (args?.allow_free_text as boolean) ?? true,
              recommended: typeof args?.recommended === 'string' ? args.recommended : undefined,
              context: typeof args?.context === 'string' ? args.context : undefined,
              questions: rawQuestions?.map((q) => ({
                id: q.id as string | undefined,
                question: (q.question as string) ?? '',
                options: (q.options as UserInputPayload['options']) ?? [],
                recommended: typeof q.recommended === 'string' ? q.recommended : undefined,
                allow_free_text: q.allow_free_text as boolean | undefined,
              })),
            };
            return { type: 'need_input', data: payload };
          }
        }
        if (v.kind === 'plan_review') {
          const plan = v.plan as Record<string, unknown> | undefined;
          if (plan && typeof plan === 'object') {
            const payload: NeedPlanReviewPayload = {
              plan: {
                name: (plan.name as string) ?? '',
                description: (plan.description as string) ?? '',
                status: (plan.status as AgentPlan['status']) ?? 'pending',
                steps:
                  (plan.steps as Array<Record<string, unknown>> | undefined)?.map((s) => ({
                    step: (s.step as string) ?? '',
                    status: (s.status as AgentPlan['status']) ?? 'pending',
                  })) ?? [],
              },
            };
            return { type: 'need_plan_review', data: payload };
          }
        }
      }
    }
  }
  return null;
}

function eventToInterruptPayload(
  _data: unknown,
  event: AgentEvent,
):
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload }
  | { kind: 'plan_review'; plan: AgentPlan }
  | null {
  if (event.type === 'need_approval') return { kind: 'approval', approval: event.data };
  if (event.type === 'need_input') return { kind: 'input', question: event.data };
  if (event.type === 'need_plan_review') return { kind: 'plan_review', plan: event.data.plan };
  return null;
}

function mapActionToResumeValue(action: UserAction): AgentResumeValue {
  switch (action.type) {
    case 'approve': {
      const grant = action.grant !== 'none' ? action.grant : undefined;
      return { approved: true, grant };
    }
    case 'reject':
      return { approved: false };
    case 'input':
      return action.answers
        ? { answer: action.text, answers: action.answers }
        : { answer: action.text };
    case 'cancel':
      return { approved: false };
    case 'switch_auth':
      return { approved: false };
    case 'approve_plan':
      return { planApproved: true };
    case 'approve_plan_auto':
      return { planApproved: true, executionMode: 'auto' };
    case 'approve_plan_manual':
      return { planApproved: true, executionMode: 'manual' };
    case 'supplement_plan':
      return { planSupplement: action.feedback };
    case 'reject_plan':
      return { planApproved: false };
  }
}

// ── chunkToEvents 子解析器 ──

/** Parse AIMessage → text, reason, tool_call events */
function parseAIMessageEvents(msg: AIMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  // DeepSeek puts reasoning_content in additional_kwargs or as a top-level field
  const rc =
    (msg.additional_kwargs?.reasoning_content as string | undefined) ??
    ((msg as unknown as Record<string, unknown>).reasoning_content as string | undefined);
  if (typeof rc === 'string' && rc.length > 0) {
    events.push({ type: 'reason', data: { text: rc } });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      events.push({
        type: 'tool_call',
        data: {
          call_id: tc.id ?? '',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        },
      });
    }
  }
  const text = extractText(msg.content);
  if (text.length > 0) {
    events.push({ type: 'text', data: { text } });
  }
  return events;
}

/** Parse ToolMessage → tool_done event */
function parseToolResultEvents(msg: Record<string, unknown>): AgentEvent | null {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  // 手动统计工具输出的 token 数，不依赖 provider 的 cache_metrics 字段
  // Count tool output tokens manually, independent of provider cache_metrics fields
  const toolTokenCount = countTokens(content);
  let ok = true;
  const summaryMaxLen = (msg.name as string) === 'edit_file' ? 2000 : 200;
  let summary = content.slice(0, summaryMaxLen);
  let totalLines: number | undefined;
  try {
    const p = JSON.parse(content);
    if (p && typeof p === 'object') {
      ok = p.ok !== false;
      if (typeof p.totalLines === 'number') totalLines = p.totalLines;
      if (p.ok !== false) {
        summary = (p.stdout as string) ?? (p.message as string) ?? (p.summary as string) ?? summary;
      } else {
        const reason = (p.rejected as boolean)
          ? ((p.reason as string) ?? 'action rejected')
          : (((p.failure as Record<string, unknown> | undefined)?.reason as string) ??
            (p.stderr as string) ??
            (p.message as string) ??
            (p.summary as string) ??
            summary);
        summary = reason;
      }
      // ask_user: extract human-readable answer from ToolMessage JSON
      // instead of showing raw JSON
      if ((msg.name as string) === 'ask_user') {
        const answer = p.answer as string | undefined;
        const answers = p.answers as Record<string, string> | undefined;
        if (answers && Object.keys(answers).length > 0) {
          summary = Object.entries(answers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
        } else if (typeof answer === 'string') {
          summary = answer || '(no answer)';
        }
      }
    }
  } catch {
    /* use raw content */
  }
  return {
    type: 'tool_done',
    data: {
      call_id: (msg.tool_call_id as string) ?? '',
      name: (msg.name as string) ?? '',
      ok,
      summary,
      ...(totalLines != null ? { totalLines } : {}),
      ...(toolTokenCount > 0 ? { toolTokenCount } : {}),
    },
  };
}

/** Parse state changes from a graph node */
function parseStateChangeEvents(node: Record<string, unknown>): AgentEvent | null {
  const sc: StateChangePayload = {};
  const ws = node.workspaceAccess as string | undefined;
  const phase = node.phase as string | undefined;
  const plan = node.plan ?? (node.metadata as Record<string, unknown> | undefined)?.plan;
  const auth = node.authorization;
  const modelProvider = node.modelProvider as string | undefined;
  const modelName = node.modelName as string | undefined;
  if (ws === 'write') sc.workspaceAccess = ws;
  if (phase === 'planning' || phase === 'building') sc.phase = phase;
  if (plan !== undefined) sc.plan = plan as StateChangePayload['plan'];
  if (auth && typeof auth === 'object') {
    sc.authorization = {
      mode: (auth as Record<string, unknown>).mode as 'default' | 'full_access',
    };
  }
  if (modelProvider) sc.modelProvider = modelProvider;
  if (modelName) sc.modelName = modelName;
  if (Object.keys(sc).length > 0) {
    return { type: 'state_change', data: sc };
  }
  return null;
}

/** Parse retry metadata from a graph node */
function parseRetryEvents(node: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const retries = node.modelRetries;
  if (Array.isArray(retries)) {
    for (const r of retries) {
      if (
        r &&
        typeof r === 'object' &&
        typeof (r as Record<string, unknown>).attempt === 'number'
      ) {
        events.push({
          type: 'model_retry',
          data: {
            attempt: (r as Record<string, unknown>).attempt as number,
            maxAttempts: ((r as Record<string, unknown>).maxAttempts as number) ?? 5,
            error: ((r as Record<string, unknown>).error as string) ?? 'unknown',
            delayMs: ((r as Record<string, unknown>).delayMs as number) ?? 0,
          },
        });
      }
    }
  }
  return events;
}

// ── chunkToEvents 编排函数 ──

export function chunkToEvents(
  chunk: unknown,
  workspaceAccess: WorkspaceAccess,
  cacheStandard: ReturnType<typeof createPromptCacheStandardTracker>,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!chunk || typeof chunk !== 'object') return events;
  const record = chunk as Record<string, unknown>;

  // 预计算：确定此 chunk 中是否有 final 和 cache_metrics
  let final = findFinal(chunk);
  let metrics = findCacheMetrics(chunk);
  const AGENT_KEYS = new Set(['agent', 'agent_plan', 'agent_build']);

  for (const key of Object.keys(record)) {
    const node = record[key] as Record<string, unknown> | undefined;
    if (!node || typeof node !== 'object') continue;

    const nodeSpanId = genSpanId();

    events.push({
      type: 'step_begin',
      data: { node: key, spanId: nodeSpanId, internal: key === 'cleanup' },
    });

    // 消息解析
    const msgs = node.messages;
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        if (AIMessage.isInstance(msg)) {
          events.push(...parseAIMessageEvents(msg));
        } else if (isToolMessage(msg as Record<string, unknown>)) {
          const evt = parseToolResultEvents(msg as Record<string, unknown>);
          if (evt) events.push(evt);
        }
      }
    }

    // 状态变化
    const scEvt = parseStateChangeEvents(node);
    if (scEvt) events.push(scEvt);

    // 重试
    events.push(...parseRetryEvents(node));

    // final / cache_metrics 归属到 agent 类 node（在 step_end 之前 emit，只 emit 一次）
    if (AGENT_KEYS.has(key)) {
      if (final) {
        events.push({ type: 'final', data: final });
        final = null; // 只 emit 一次
      }
      if (metrics) {
        const outputTokens = findOutputTokens(chunk);
        events.push({
          type: 'cache_metrics',
          data: {
            workspaceAccess,
            cacheHitTokens: metrics.cacheHitTokens,
            cacheMissTokens: metrics.cacheMissTokens,
            cacheWriteTokens: 0,
            inputTokens: metrics.inputTokens,
            outputTokens,
            hitRate: metrics.hitRate,
            standard: cacheStandard.record(metrics),
          } satisfies CacheMetricsPayload,
        });
        metrics = null; // 只 emit 一次
      }
    }

    events.push({
      type: 'step_end',
      data: { node: key, spanId: nodeSpanId },
    });
  }

  return events;
}

function isToolMessage(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === 'function')
      return (msg._getType as () => string).call(msg) === 'tool';
  } catch {
    /* ignore */
  }
  return false;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

function findWorkspaceAccess(chunk: unknown): WorkspaceAccess | null {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return null;
  for (const v of Object.values(chunk as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ws = (v as Record<string, unknown>).workspaceAccess;
      if (ws === 'write') return ws;
    }
  }
  return null;
}

function findCacheMetrics(chunk: unknown) {
  return findPromptCacheMetrics(chunk);
}

function findOutputTokens(chunk: unknown): number {
  for (const value of walkValues(chunk)) {
    if (AIMessage.isInstance(value)) {
      const um = value.usage_metadata as { output_tokens?: number } | undefined;
      const ru = value.response_metadata?.usage as
        | { completion_tokens?: number; output_tokens?: number }
        | undefined;
      return um?.output_tokens ?? ru?.output_tokens ?? ru?.completion_tokens ?? 0;
    }
  }
  return 0;
}

export function initialWorkspaceAccessForTask(
  _task: string,
  _requested: WorkspaceAccessRequest = 'auto',
): WorkspaceAccess {
  return 'write';
}

export function workspaceAccessToPhase(_access: WorkspaceAccess): AgentPhase {
  return 'building';
}

export function initialAgentPhaseForAccess(_workspaceAccess: WorkspaceAccess): AgentPhase {
  return 'building';
}

export function taskMessageForInitialAccess(
  task: string,
  _workspaceAccess: WorkspaceAccess,
): string {
  return task;
}

export async function* normalizeGraphStream(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let currentWorkspaceAccess: WorkspaceAccess | null = null;
  const cacheStandard = createPromptCacheStandardTracker();
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    if (isInterrupted(chunk)) {
      yield { type: 'interrupt', data: (chunk as Record<string | symbol, unknown>)[INTERRUPT] };
      continue;
    }

    const chunkRecord = chunk as Record<string, unknown>;
    if (INTERRUPT in chunkRecord) {
      yield { type: 'interrupt', data: chunkRecord[String(INTERRUPT)] };
      continue;
    }

    currentWorkspaceAccess = findWorkspaceAccess(chunk) ?? currentWorkspaceAccess;
    yield { type: 'update', data: chunk };

    for (const retry of findModelRetries(chunk)) {
      yield { type: 'model_retry', data: retry };
    }

    const metrics = findPromptCacheMetrics(chunk);
    if (metrics && currentWorkspaceAccess) {
      yield {
        type: 'cache_metrics',
        data: {
          workspaceAccess: currentWorkspaceAccess,
          ...metrics,
          outputTokens: findOutputTokens(chunk),
          cacheWriteTokens: 0,
          standard: cacheStandard.record(metrics),
        },
      };
    }

    const final = findFinal(chunk);
    if (final) {
      yield { type: 'final', data: final };
    }
  }
}

export async function* streamCodeAgent(input: StreamCodeAgentInput): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
    thinkingLevel: input.thinkingLevel,
    mcpManager: input.mcpManager,
  });

  const signal = input.signal;

  try {
    const initialWorkspaceAccess = initialWorkspaceAccessForTask(input.task, input.mode ?? 'auto');
    const initialPhase = initialAgentPhaseForAccess(initialWorkspaceAccess);

    const prevAuth = await readLastAuthorization(checkpointer, input.threadId);

    const stream = await graph.stream(
      {
        messages: [new HumanMessage(input.task)],
        workspaceAccess: initialWorkspaceAccess,
        phase: initialPhase,
        plan: null,
        userId: input.userId,
        threadId: input.threadId,
        workspace: input.workspace,
        authorization: prevAuth ?? defaultAuthorizationState(),
        contextBudget: input.contextBudget,
        modelProvider: input.config.providerName,
        modelName: input.config.modelName,
        thinkingLevel: input.thinkingLevel ?? null,
      },
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream, signal);
  } finally {
    checkpointer.close();
  }
}

export async function* resumeCodeAgent(input: ResumeCodeAgentInput): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
    thinkingLevel: input.thinkingLevel,
    mcpManager: input.mcpManager,
  });

  const signal = input.signal;

  try {
    const stream = await graph.stream(
      new Command({ resume: input.resume }),
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream, signal);
  } finally {
    checkpointer.close();
  }
}

function graphConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    streamMode: 'updates' as const,
    recursionLimit: 9999999,
  };
}

function findFinal(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const record = chunk as Record<string, unknown>;
  for (const key of ['agent', 'agent_plan', 'agent_build']) {
    const node = record[key] as { final?: unknown } | undefined;
    if (typeof node?.final === 'string') return node.final;
  }
  return null;
}

function findModelRetries(chunk: unknown): ModelRetryEvent[] {
  const all: ModelRetryEvent[] = [];
  for (const value of walkValues(chunk)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const modelRetries = (value as Record<string, unknown>).modelRetries;
    if (Array.isArray(modelRetries)) {
      for (const item of modelRetries) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).attempt === 'number'
        ) {
          all.push(item as ModelRetryEvent);
        }
      }
    }
  }
  return all;
}

function findPromptCacheMetrics(chunk: unknown) {
  for (const value of walkValues(chunk)) {
    if (AIMessage.isInstance(value)) {
      const metrics = extractPromptCacheMetrics(value);
      if (metrics) return metrics;
    }
  }
  return null;
}

function* walkValues(value: unknown): Generator<unknown> {
  yield value;
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkValues(item);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    yield* walkValues(item);
  }
}

/** Generate a file_change event when a write/edit tool completes.
 *  Preview is a raw content snippet (first ~1KB); TUI layer handles display formatting. */
async function produceFileChange(
  events: AgentEvent[],
  path: string,
  toolName: string,
  workspace?: string,
): Promise<void> {
  const kind = toolName === 'write_file' ? ('add' as const) : ('edit' as const);
  let linesAdded: number | undefined;
  let linesRemoved: number | undefined;
  let preview: string | undefined;
  const { resolve } = await import('node:path');
  const absolutePath = workspace ? resolve(workspace, path) : path;
  try {
    const s = await statAsync(absolutePath);
    if (s.size <= 1_000_000) {
      const content = await readFile(absolutePath, 'utf-8');
      const allLines = content.split('\n');
      linesAdded = allLines.length;
      preview = content.slice(0, 1024);
    }
  } catch {
    /* no preview on read error */
  }
  events.push({ type: 'file_change', data: { path, kind, linesAdded, linesRemoved, preview } });
}
