// ── Effect Scheduler / 效果调度器 ──
// Phase 4: 纯函数 decideNextEffect — 从 RuntimeState 决定下一步效果。
// 替代 routes.ts 中的 resolveToolRoute()，将业务调度从 LangGraph 路由机制中解耦。
//
// Pure function decideNextEffect — determines the next effect from RuntimeState.
// Replaces routes.ts resolveToolRoute(), decoupling business scheduling from LangGraph routing.

import { END } from '@langchain/langgraph';
import type { RuntimeEffect } from './effects';
import type { RuntimeState } from './state';

/**
 * 纯函数：根据运行时状态决定下一步应执行的效果。
 * Pure function: determines the next effect to execute based on runtime state.
 *
 * 优先级与 routes.ts resolveToolRoute() 保持一致：
 * Priority mirrors routes.ts resolveToolRoute():
 *   1. ask_user           → request_user_input
 *   2. update_plan (结构) → request_plan_review
 *   3. 待审批工具          → request_tool_approval
 *   4. 可执行工具          → run_tools
 *   5. 无待处理            → call_model
 *
 * @param state - 当前运行时状态 / Current runtime state
 * @param hasPendingToolCalls - 是否有待处理的工具调用（从 messages 扫描）/ Whether there are pending tool calls
 * @param hasRunnableTools - 是否有可直接执行的工具（无需审批）/ Whether there are tools that can run directly
 * @returns 应执行的下一个效果 / The next effect to execute
 */
export function decideNextEffect(
  state: RuntimeState,
  hasPendingToolCalls: boolean,
  hasRunnableTools: boolean,
): RuntimeEffect {
  // 无待处理工具 → 调用模型或停止
  // No pending tools → call model or stop
  if (!hasPendingToolCalls) {
    // 检查是否有待处理的交互中断
    // Check for pending interaction interrupts
    if (state.interactions.kind === 'awaiting_user_input') {
      return {
        type: 'request_user_input',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    }
    if (state.interactions.kind === 'awaiting_plan_review') {
      return {
        type: 'request_plan_review',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    }
    if (state.interactions.kind === 'awaiting_tool_approval') {
      return {
        type: 'request_tool_approval',
        interactionId: state.interactions.interactionId,
        toolCallId: state.interactions.toolCallId,
      };
    }

    // 无待处理工具且无中断 → 调用模型
    // No pending tools and no interrupts → call model
    return { type: 'call_model' };
  }

  // 有待处理工具调用 → 检查是否需要中断
  // Has pending tool calls → check if interrupt is needed

  // Priority 1: ask_user → 需要用户输入（full mode 下不能挂起）
  // ask_user requires user input (cannot suspend in full mode)
  if (state.interactions.kind === 'awaiting_user_input') {
    return {
      type: 'request_user_input',
      interactionId: state.interactions.interactionId,
      toolCallId: state.interactions.toolCallId,
    };
  }

  // Priority 2: plan 待审核 → 需要方案审核
  // Plan awaiting review → need plan review
  if (state.interactions.kind === 'awaiting_plan_review') {
    return {
      type: 'request_plan_review',
      interactionId: state.interactions.interactionId,
      toolCallId: state.interactions.toolCallId,
    };
  }

  // Priority 3: 工具待审批 → 需要工具审批
  // Tool awaiting approval → need tool approval
  if (state.interactions.kind === 'awaiting_tool_approval') {
    return {
      type: 'request_tool_approval',
      interactionId: state.interactions.interactionId,
      toolCallId: state.interactions.toolCallId,
    };
  }

  // Priority 4: 可执行工具 → 直接执行
  // Runnable tools → execute directly
  if (hasRunnableTools) {
    const runnableIds = state.tools.queue.filter((id) => {
      const call = state.tools.calls[id];
      return call && call.status === 'queued';
    });
    if (runnableIds.length > 0) {
      return { type: 'run_tools', toolCallIds: runnableIds };
    }
  }

  // 默认：调用模型
  // Default: call model
  return { type: 'call_model' };
}

/**
 * 判断是否需要继续主循环。
 * Returns true if the main loop should continue.
 */
export function shouldContinue(effect: RuntimeEffect): boolean {
  return effect.type !== 'stop' && effect.type !== 'emit_final';
}

// ── 过渡期适配器 / Transitional adapter ──

/**
 * 适配函数：根据扁平化参数决定 LangGraph 路由目标。
 * 可替代 routes.ts 中的 routeEntry / routeAfterAgent。
 *
 * Adapter: determines LangGraph routing target from flattened parameters.
 * Can replace routeEntry / routeAfterAgent in routes.ts.
 *
 * 优先级 / Priority（与 routes.ts resolveToolRoute 保持一致）：
 *   0. 工具耗尽且无人值守       → END
 *   1. ask_user                → user_input（full mode 跳过）
 *   2. update_plan（结构性）    → plan_review
 *   3. 待审批工具               → approval
 *   4. 可直接执行工具            → tools
 *   5. 无待处理                 → agent
 */
export function resolveToolRouteFromState(params: {
  hasPendingToolCalls: boolean;
  hasRunnableTools: boolean;
  interactionKind: string;
  isFullMode: boolean;
  hasExhaustedTools: boolean;
}): 'agent' | 'tools' | 'approval' | 'user_input' | 'plan_review' | typeof END {
  const { hasPendingToolCalls, hasRunnableTools, interactionKind, isFullMode, hasExhaustedTools } =
    params;

  // Priority 0: 工具耗尽且无人值守 → 终止
  // Tool exhaustion with no human in the loop → terminate
  if (hasExhaustedTools && isFullMode) return END;

  // 无待处理工具调用 → 检查是否有待处理的交互中断
  // No pending tool calls → check for pending interaction interrupts
  if (!hasPendingToolCalls) {
    if (interactionKind === 'awaiting_user_input' && !isFullMode) return 'user_input';
    if (interactionKind === 'awaiting_plan_review') return 'plan_review';
    if (interactionKind === 'awaiting_tool_approval') return 'approval';
    return 'agent';
  }

  // 有待处理工具调用 → 按优先级路由
  // Has pending tool calls → route by priority

  // Priority 1: ask_user（full mode 下不挂起）
  // ask_user cannot suspend in full mode
  if (interactionKind === 'awaiting_user_input') {
    if (isFullMode) {
      // full mode: skip ask_user, fall through to tool execution
    } else {
      return 'user_input';
    }
  }

  // Priority 2: plan 待审核 → plan_review
  // Plan awaiting review → plan_review
  if (interactionKind === 'awaiting_plan_review') return 'plan_review';

  // Priority 3: 工具待审批 → approval
  // Tool awaiting approval → approval
  if (interactionKind === 'awaiting_tool_approval') return 'approval';

  // Priority 4: 可执行工具 → tools；需审批 → approval
  // Runnable tools → tools; need approval → approval
  if (hasRunnableTools) return 'tools';
  if (hasPendingToolCalls) return 'approval';

  // 默认：让模型继续生成
  // Default: let model continue generating
  return 'agent';
}
