// ── Loop Mode 策略（桩实现）/ Loop Mode Policy (stub) ──
// Phase 4 补全: 为未来的 loop-mode 预留策略实现。
// 当前为桩实现——loop-mode 尚未实现，所有方法返回安全的默认值。
//
// Completes Phase 4: Stub policy for future loop-mode.
// Currently a stub — loop-mode is not yet implemented. All methods return safe defaults.
//
// Loop mode 设计要求（来自方案文档 Section 3.5）：
// - 仅增加 shouldContinueLoop，不绕过其他 policy
// - ask_user 仍然正常工作（loop mode 下可暂停）
// - tool 审批走正常路径
//
// Loop mode design requirements (from plan doc Section 3.5):
// - Only adds shouldContinueLoop, does not bypass other policies
// - ask_user still works normally (can pause within loop mode)
// - Tool approval follows the normal path

import type { PolicyDecision, PolicyInput, RuntimePolicy } from './runtime-policy';

/**
 * 创建 Loop Mode 策略（桩实现）。
 * Create Loop Mode policy (stub implementation).
 *
 * 当前行为 / Current behavior:
 * - shouldContinueLoop: 始终返回 stop（loop-mode 尚未启用 / loop-mode not yet enabled）
 * - 其他方法 / Other methods: 委托给默认行为（allow 直通 / allow pass-through）
 *
 * 未来实现 / Future implementation:
 * - shouldContinueLoop: 返回 continue_loop 让 agent 持续运行 / returns continue_loop to keep running
 * - 其余方法按 mode-policy 中的 ask mode 行为实现 / other methods follow ask mode behavior
 */
export function createLoopModePolicy(): RuntimePolicy {
  return {
    name: 'loop-mode (stub)',

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      // loop mode 下 plan 可选 / Plan is optional in loop mode
      return { kind: 'allow' };
    },

    shouldReviewPlan(input: PolicyInput): PolicyDecision {
      // 如果 agent 产生了 plan，仍需审核 / If the agent produces a plan, it still needs review
      if (input.planKind === 'drafted' || input.planKind === 'awaiting_review') {
        return { kind: 'need_plan_review' };
      }
      return { kind: 'allow' };
    },

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      // loop mode 下 ask_user 正常支持 — agent 可在循环中暂停询问用户
      // ask_user is supported in loop mode — agent can pause to ask the user within the loop
      return { kind: 'allow' };
    },

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      // loop mode 下工具审批与 ask mode 一致 / Tool approval in loop mode follows ask mode
      if (input.toolRisk === 'destructive') {
        return { kind: 'deny', reason: 'destructive operations are not allowed' };
      }
      if (input.toolRisk && input.toolRisk !== 'read' && input.toolRisk !== 'plan') {
        return { kind: 'need_tool_approval' };
      }
      return { kind: 'allow' };
    },

    shouldAutoReview(_input: PolicyInput): PolicyDecision {
      // loop mode 不使用 auto-review / Loop mode does not use auto-review
      return { kind: 'allow' };
    },

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      // 桩实现：loop-mode 尚未启用，始终停止
      // Stub: loop-mode not yet enabled, always stop
      //
      // 未来实现将返回 / Future implementation will return:
      //   { kind: 'continue_loop' }
      return { kind: 'stop' };
    },
  };
}
