import type { ToolMessage } from '@langchain/core/messages';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import { normalizeUserInputResume, userInputToolMessage } from '@/core/harness/user-input';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { AgentResumeValue } from '@/core/types';
import type { AgentPlan } from '@/protocol/events';

/** 用户输入处理参数 / User input handling parameters */
export interface UserInputParams {
  /** 工具请求（ask_user 变体）/ Tool request (ask_user variant) */
  request: Extract<PendingToolRequest, { name: 'ask_user' }>;
  /** 从 interrupt() 返回的 resume 值 / Resume value returned from interrupt() */
  resume: AgentResumeValue;
  /** 当前 plan 状态（透传）/ Current plan state (passthrough) */
  plan: AgentPlan | null;
  /** 当前 planReviewed 状态（透传）/ Current planReviewed state (passthrough) */
  planReviewed: boolean;
  /** 运行时事件回调 — RuntimeEvent 是唯一 TUI 通知路径 */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** 交互 ID（由调用方 graph.ts 传入，或自动生成） */
  interactionId?: string;
}

/** 用户输入处理结果 / User input handling result */
export interface UserInputResult {
  messages: ToolMessage[];
  plan: AgentPlan | null;
  planReviewed: boolean;
}

/**
 * 纯函数：处理用户输入中断恢复逻辑 / Pure function: handle user input interrupt resume logic.
 *
 * 将 graph.ts userInput 节点中 interrupt() 之后的 resume 处理抽取为不依赖 LangGraph 的纯函数。
 * 调用方负责在 LangGraph 节点中调用 interrupt() 并将 resume 值传入本函数。
 *
 * Extracts the resume processing after interrupt() from the graph.ts userInput node
 * into a pure function with no LangGraph dependency. The caller is responsible for
 * calling interrupt() in the LangGraph node and passing the resume value here.
 *
 * RuntimeEvent 是唯一 TUI 通知路径 — 不再使用 toolResultSink 双写。
 * RuntimeEvent is the sole TUI notification path — no more toolResultSink dual-write.
 */
export function handleUserInput(params: UserInputParams): UserInputResult {
  const { request, resume, plan, planReviewed, emitRuntimeEvent, interactionId } = params;
  const iid = interactionId ?? genInteractionId();

  // 规范化用户回复 / Normalize user response
  const normalized = normalizeUserInputResume(resume);
  const answer = normalized.answers
    ? Object.entries(normalized.answers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : normalized.answer;

  // RuntimeEvent 管道发出 tool_done — 唯一 TUI 通知路径
  // RuntimeEvent pipeline emits tool_done — sole TUI notification path
  emitRuntimeEvent?.({
    type: 'user_input.answered',
    interactionId: iid,
    answer,
  });
  emitRuntimeEvent?.({
    type: 'tool.finished',
    toolCallId: request.id ?? '',
    name: 'ask_user',
    result: {
      ok: true,
      command: request.protectedCommand ?? '',
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, answer }),
      stderr: '',
    },
  });

  return {
    messages: [userInputToolMessage(request, resume)],
    plan,
    planReviewed,
  };
}
