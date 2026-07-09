// ── Runtime Effect 类型定义 / Runtime effect type definitions ──
// Phase 4: 声明式效果 — AgentKernel 通过 decideNextEffect 决定下一步，
// 不再在 LangGraph 路由函数中硬编码业务调度。
//
// Declarative effects — AgentKernel uses decideNextEffect to determine the next step,
// no longer hard-coding business scheduling in LangGraph routing functions.

/**
 * 运行时效果 — AgentKernel 主循环中可执行的下一步操作。
 * Runtime effect — the next operation to execute in the AgentKernel main loop.
 *
 * 效果是无副作用的描述，由 Controller 解释执行。
 * Effects are side-effect-free descriptions, interpreted by Controllers.
 */
export type RuntimeEffect =
  /** 调用模型生成响应 / Call the model to generate a response */
  | { type: 'call_model' }
  /** 执行指定工具调用 / Execute the specified tool calls */
  | { type: 'run_tools'; toolCallIds: string[] }
  /** 向用户请求输入（ask_user）/ Request user input (ask_user) */
  | { type: 'request_user_input'; interactionId: string; toolCallId: string }
  /** 请求用户审核方案 / Request user plan review */
  | { type: 'request_plan_review'; interactionId: string; toolCallId: string }
  /** 请求用户审批工具 / Request user tool approval */
  | { type: 'request_tool_approval'; interactionId: string; toolCallId: string }
  /** 执行自动审查 / Run auto-review */
  | { type: 'run_auto_review'; reviewId: string; toolCallId: string }
  /** 发出最终事件并终止 / Emit final event and terminate */
  | { type: 'emit_final' }
  /** 停止执行 / Stop execution */
  | { type: 'stop' };

/**
 * 判断效果是否为终止型（不再产生后续效果）。
 * Returns true if the effect is terminal (no further effects follow).
 */
export function isTerminalEffect(effect: RuntimeEffect): boolean {
  return effect.type === 'emit_final' || effect.type === 'stop';
}

/**
 * 判断效果是否为中断型（需要等待外部输入）。
 * Returns true if the effect requires waiting for external input.
 */
export function isInterruptEffect(effect: RuntimeEffect): boolean {
  return (
    effect.type === 'request_user_input' ||
    effect.type === 'request_plan_review' ||
    effect.type === 'request_tool_approval'
  );
}
