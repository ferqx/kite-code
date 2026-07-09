// ── Model Controller / 模型控制器 ──
// Phase 3: 将 graph.ts agent 节点中的工具创建 + 模型调用抽取为独立函数。
// 包装 createAgentTools + invokeModel + retry listener 生命周期管理。
//
// Extracts tool creation + model invocation from the agent node as a standalone function.
// Wraps createAgentTools + invokeModel + retry listener lifecycle management.

import type { AIMessage } from '@langchain/core/messages';
import type { AgentConfig } from '@/core/config/index';
import { invokeModel } from '@/core/harness/graph';
import type { CodeAgentState } from '@/core/harness/state';
import type { McpManager } from '@/core/mcp';
import type { RetryListenerHost } from '@/core/model/deepseek';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { createAgentTools } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';

// ── 类型定义 / Type definitions ──

/** Model controller 输入参数 / Model controller input parameters */
export interface InvokeAgentModelParams {
  model: SupportedChatModel;
  state: CodeAgentState;
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  config: AgentConfig;
  subagentEventSink?: SubAgentEventSink;
  subagentSignal?: AbortSignal;
  /** 运行时事件回调 — 用于发出 model.requested / model.responded */
  runtimeEventSink?: (event: RuntimeEvent) => void;
}

/** Model controller 返回结果 / Model controller return result */
export interface InvokeAgentModelResult {
  /** invokeModel 的原始返回 / Raw return from invokeModel */
  result: ReturnType<typeof invokeModel> extends Promise<infer T> ? T : never;
  /** 模型重试事件（如有）/ Model retry events (if any) */
  retryEvents?: Array<{
    attempt: number;
    maxAttempts: number;
    error: string;
    delayMs: number;
  }>;
}

// ── 辅助函数 / Helpers ──

function hasRetryListener(
  model: SupportedChatModel,
): model is SupportedChatModel & RetryListenerHost {
  return (
    'setRetryListener' in model &&
    typeof (model as { setRetryListener: unknown }).setRetryListener === 'function'
  );
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractReasoningText(message: AIMessage | undefined): string | undefined {
  const reasoning =
    (message?.additional_kwargs?.reasoning_content as string | undefined) ??
    ((message as unknown as Record<string, unknown> | undefined)?.reasoning_content as
      | string
      | undefined);
  return reasoning && reasoning.length > 0 ? reasoning : undefined;
}

// ── Controller / 控制器 ──

/**
 * 调用 agent 模型 — 创建工具 + 调用 invokeModel + 管理 retry listener。
 * Invoke the agent model — create tools + call invokeModel + manage retry listener.
 *
 * 不处理（留在 graph.ts）：
 * - 执行态 channel 透传（plan, planReviewed, autoReviewState 等）
 * - authorization 同步（authorizationForState）
 * - modelProvider/modelName/thinkingLevel 写入 state
 *
 * 仅处理：工具创建 → invokeModel → retry listener 生命周期。
 * Only handles: tool creation → invokeModel → retry listener lifecycle.
 */
export async function invokeAgentModel(
  params: InvokeAgentModelParams,
): Promise<InvokeAgentModelResult> {
  const {
    model,
    state,
    workspace,
    shellExecutor,
    mcpManager,
    skills,
    skillOptions,
    config,
    subagentEventSink,
    subagentSignal,
  } = params;

  // 创建 agent 工具 / Create agent tools
  const tools = createAgentTools({
    workspace,
    shellExecutor,
    mcpManager,
    skills,
    skillOptions,
    config,
    subagentEventSink,
    subagentSignal,
    signal: subagentSignal,
    model,
    threadId: state.threadId,
    authorization: state.authorization,
    workspaceAccess: state.workspaceAccess,
    phase: state.phase,
    interactionMode: state.interactionMode,
  });

  // Retry listener 管理 / Retry listener management
  const retryEvents: Array<{
    attempt: number;
    maxAttempts: number;
    error: string;
    delayMs: number;
  }> = [];
  const listener = (attempt: number, maxAttempts: number, error: unknown, delayMs: number) => {
    retryEvents.push({
      attempt,
      maxAttempts,
      error: typeof error === 'string' ? error : String(error).slice(0, 200),
      delayMs,
    });
  };
  if (hasRetryListener(model)) model.setRetryListener(listener);

  try {
    // RuntimeEvent: model.requested — 记录模型请求前事件
    const requestId = genInteractionId();
    params.runtimeEventSink?.({ type: 'model.requested', requestId });

    const result = await invokeModel({
      model,
      state,
      tools,
      skills,
      signal: subagentSignal,
    });

    // RuntimeEvent: model.responded — 记录模型响应事件
    const messages = result.state?.messages as AIMessage[] | undefined;
    const responseMsg = messages?.[0];
    params.runtimeEventSink?.({
      type: 'model.responded',
      messageId: responseMsg?.id ?? requestId,
      toolCalls:
        responseMsg?.tool_calls?.map((tc) => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args,
        })) ?? [],
      reasoningText: extractReasoningText(responseMsg),
      text: extractText(responseMsg?.content),
    });

    return {
      result,
      retryEvents: retryEvents.length > 0 ? retryEvents : undefined,
    };
  } catch (e) {
    // 保留 retryEvents 即使调用失败 / Preserve retryEvents even on failure
    if (retryEvents.length > 0) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
        modelRetries: retryEvents,
      });
    }
    throw e;
  } finally {
    if (hasRetryListener(model)) model.setRetryListener(null);
  }
}
