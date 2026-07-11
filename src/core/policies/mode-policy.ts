// ── Mode 策略实现 / Mode policy implementations ──
// Phase 4: RuntimePolicy 接口的具体实现 — ask / auto / full 三种 mode。
// 将 mode 决策从 graph 节点 if-else 中解耦为可独立测试的纯函数。
//
// Concrete implementations of RuntimePolicy for ask / auto / full modes.
// Decouples mode decisions from graph node if-else chains into independently
// testable pure functions.

import type { PolicyDecision, PolicyInput, RuntimePolicy } from './runtime-policy';

// ── 辅助函数 / Helpers ──

/** 判断工具是否为破坏性操作 / Returns true if the tool is a destructive operation */
function isDestructive(risk: PolicyInput['toolRisk']): boolean {
  return risk === 'destructive';
}

/** 判断工具是否需要审批（非只读/非计划类）/ Returns true if the tool requires approval */
function requiresApproval(risk: PolicyInput['toolRisk']): boolean {
  if (!risk) return false;
  return risk !== 'read' && risk !== 'plan';
}

// ── Ask Mode / 询问模式 ──

/**
 * 创建 Ask Mode 策略 — 最保守的模式，所有变更需用户确认。
 * Create Ask Mode policy — most conservative, all mutations require user confirmation.
 *
 * 行为 / Behavior:
 * - plan: 草稿方案需人工审核 / drafted plans require human review
 * - 工具: 只读直通，变更需审批，破坏性拒绝 / read-only allowed, mutations need approval, destructive denied
 * - ask_user: 正常支持 / fully supported
 * - auto-review: 不启用 / disabled
 */
export function createAskModePolicy(): RuntimePolicy {
  return {
    name: 'ask-mode',

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldReviewPlan(input: PolicyInput): PolicyDecision {
      // 仅当方案处于 drafted 或 awaiting_review 状态时才需审核
      // Only require review when plan is drafted or awaiting_review
      if (input.planKind === 'planning_draft' || input.planKind === 'awaiting_review') {
        return { kind: 'need_plan_review' };
      }
      return { kind: 'allow' };
    },

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      // ask mode 下 ask_user 正常支持 / ask_user is supported in ask mode
      return { kind: 'allow' };
    },

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      // 破坏性操作 — 不可绕过 / Destructive operations — never bypass
      if (isDestructive(input.toolRisk)) {
        return { kind: 'deny', reason: 'destructive operations are not allowed' };
      }
      // 需要审批的工具 — 中断等用户确认 / Tools requiring approval — interrupt for user
      if (requiresApproval(input.toolRisk)) {
        return { kind: 'need_tool_approval' };
      }
      // 只读/计划类 — 直通 / Read/plan — allow directly
      return { kind: 'allow' };
    },

    shouldAutoReview(_input: PolicyInput): PolicyDecision {
      // ask mode 不使用 auto-review / ask mode does not use auto-review
      return { kind: 'allow' };
    },

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      return { kind: 'stop' };
    },
  };
}

// ── Auto Mode / 自动模式 ──

/** Auto mode 策略配置 / Auto mode policy configuration */
export interface AutoModeConfig {
  /** 方案是否可自动执行 / Whether plan can execute automatically */
  planAutoExecute?: boolean;
  /** 是否允许 fail-open（auto-review 失败时放行）/ Whether to allow fail-open */
  failOpen?: boolean;
  /** 断路器最大拒绝次数 / Circuit breaker max rejections */
  circuitBreakerMaxRejections?: number;
}

/**
 * 创建 Auto Mode 策略 — 工具执行前先经 review model 自动审查。
 * Create Auto Mode policy — tools are auto-reviewed before execution.
 *
 * 行为 / Behavior:
 * - plan: 可在审批时选择 auto-execution / can choose auto-execution at approval time
 * - 工具: 非破坏性变更走 auto-review，破坏性拒绝 / non-destructive mutations go through auto-review, destructive denied
 * - ask_user: 正常支持 / fully supported
 * - auto-review: 对需审批的工具自动审查 / auto-review for tools that need approval
 */
export function createAutoModePolicy(_config?: AutoModeConfig): RuntimePolicy {
  return {
    name: 'auto-mode',

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldReviewPlan(input: PolicyInput): PolicyDecision {
      if (input.planKind === 'planning_draft' || input.planKind === 'awaiting_review') {
        return { kind: 'need_plan_review' };
      }
      return { kind: 'allow' };
    },

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      // 破坏性 — 不可绕过 / Destructive — never bypass
      if (isDestructive(input.toolRisk)) {
        return { kind: 'deny', reason: 'destructive operations are not allowed' };
      }
      // 需要审批 — 走 auto-review / Requires approval — go through auto-review
      if (requiresApproval(input.toolRisk)) {
        // 已有审批缓存 — 直通 / Already cached approval — allow
        if (input.approvalCached) {
          return { kind: 'allow' };
        }
        // 断路器已跳闸 — 回退到人工审批 / Circuit breaker tripped — fall back to manual
        if (input.circuitBreakerTripped) {
          return { kind: 'need_tool_approval' };
        }
        // 正常路径 — auto-review / Normal path — auto-review
        return {
          kind: 'need_auto_review',
          toolCallId: '',
          toolName: input.toolName ?? 'unknown',
          reason: 'auto-review required for non-read operation',
        };
      }
      // 只读/计划类 — 直通 / Read/plan — allow directly
      return { kind: 'allow' };
    },

    shouldAutoReview(input: PolicyInput): PolicyDecision {
      // 仅对需审批的非破坏性工具启用 / Only for non-destructive tools that need approval
      if (requiresApproval(input.toolRisk) && !isDestructive(input.toolRisk)) {
        return {
          kind: 'need_auto_review',
          toolCallId: '',
          toolName: input.toolName ?? 'unknown',
          reason: 'auto-review for tool approval',
        };
      }
      return { kind: 'allow' };
    },

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      return { kind: 'stop' };
    },
  };
}

// ── Full Mode / 完全自主模式 ──

/**
 * 创建 Full Mode 策略 — 模型完全自主执行，不允许 ask_user，需要 sandbox。
 * Create Full Mode policy — fully autonomous, no ask_user, requires sandbox.
 *
 * 行为 / Behavior:
 * - plan: 需审核 / requires review
 * - 工具: 破坏性拒绝，其余在 sandbox 内可执行 / destructive denied, rest allowed within sandbox
 * - ask_user: 拒绝 — full mode 不能向用户提问 / denied — full mode cannot ask the user
 * - auto-review: 不启用（full mode 直接执行）/ disabled (full mode executes directly)
 * - sandbox: 不可用时返回 deny / returns deny if not available
 */
export function createFullModePolicy(sandboxAvailable: boolean): RuntimePolicy {
  if (!sandboxAvailable) {
    // Sandbox 不可用时的 fallback — 所有操作都需要审批
    // Fallback when sandbox unavailable — all operations need approval
    return {
      name: 'full-mode (no-sandbox fallback)',

      shouldRequirePlan(_input: PolicyInput): PolicyDecision {
        return { kind: 'allow' };
      },

      shouldReviewPlan(input: PolicyInput): PolicyDecision {
        if (input.planKind === 'planning_draft' || input.planKind === 'awaiting_review') {
          return { kind: 'need_plan_review' };
        }
        return { kind: 'allow' };
      },

      shouldAskUser(_input: PolicyInput): PolicyDecision {
        return { kind: 'deny', reason: 'full mode requires sandbox which is not available' };
      },

      shouldApproveTool(input: PolicyInput): PolicyDecision {
        if (isDestructive(input.toolRisk)) {
          return { kind: 'deny', reason: 'destructive operations are not allowed' };
        }
        if (requiresApproval(input.toolRisk)) {
          return { kind: 'need_tool_approval' };
        }
        return { kind: 'allow' };
      },

      shouldAutoReview(_input: PolicyInput): PolicyDecision {
        return { kind: 'allow' };
      },

      shouldContinueLoop(_input: PolicyInput): PolicyDecision {
        return { kind: 'stop' };
      },
    };
  }

  return {
    name: 'full-mode',

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldReviewPlan(input: PolicyInput): PolicyDecision {
      if (input.planKind === 'planning_draft' || input.planKind === 'awaiting_review') {
        return { kind: 'need_plan_review' };
      }
      return { kind: 'allow' };
    },

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      // full mode 下 ask_user 被禁止 — 模型不能依赖人工判断
      // ask_user is forbidden in full mode — model cannot rely on human judgment
      return {
        kind: 'deny',
        reason: 'full mode does not support ask_user — replan to avoid user interaction',
      };
    },

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      // 破坏性 — 不可绕过，即使有 sandbox / Destructive — never bypass, even with sandbox
      if (isDestructive(input.toolRisk)) {
        return { kind: 'deny', reason: 'destructive operations are not allowed' };
      }
      // Sandbox 内 — 直通 / Inside sandbox — allow directly
      return { kind: 'allow' };
    },

    shouldAutoReview(_input: PolicyInput): PolicyDecision {
      // full mode 直接执行，不经过 auto-review / full mode executes directly, no auto-review
      return { kind: 'allow' };
    },

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      return { kind: 'stop' };
    },
  };
}

// ── 工厂函数 / Factory ──

/**
 * 根据 mode 名称创建对应的策略实例。
 * Create the appropriate policy instance for a given mode name.
 *
 * @param mode - 'ask' | 'auto' | 'full'
 * @param sandboxAvailable - sandbox 是否可用（仅 full mode 需要）
 * @param autoConfig - auto mode 配置（可选）
 */
// ── Accept Edits Mode / 接受编辑模式 ──

/**
 * 创建 Accept Edits Mode 策略 — Plan 审批后的半自动执行。
 * Create Accept Edits Mode policy — semi-automatic execution after plan approval.
 *
 * 行为 / Behavior:
 * - workspace file edit: allow (auto-approve write_file/edit_file)
 * - safe fs command: allow (read/search/stat)
 * - test/build/execute: approval (still requires user check)
 * - network: approval
 * - vcs mutation: approval
 * - destructive: deny
 */
export function createAcceptEditsModePolicy(): RuntimePolicy {
  return {
    name: 'accept-edits',

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldReviewPlan(input: PolicyInput): PolicyDecision {
      if (input.planKind === 'planning_draft' || input.planKind === 'awaiting_review') {
        return { kind: 'need_plan_review' };
      }
      return { kind: 'allow' };
    },

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      if (isDestructive(input.toolRisk)) {
        return { kind: 'deny', reason: 'destructive operations are not allowed' };
      }
      // Auto-approve workspace file edits
      if (input.toolRisk === 'write_file') {
        return { kind: 'allow' };
      }
      // Read/plan — allow
      if (input.toolRisk === 'read' || input.toolRisk === 'plan') {
        return { kind: 'allow' };
      }
      // Everything else (test, build, execute, network, vcs) — approval
      return { kind: 'need_tool_approval' };
    },

    shouldAutoReview(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      return { kind: 'stop' };
    },
  };
}

// ── 工厂函数 / Factory ──

/**
 * 根据 mode 名称创建对应的策略实例。
 * Create the appropriate policy instance for a given mode name.
 *
 * @param mode - 'ask' | 'accept_edits' | 'auto' | 'full'
 * @param sandboxAvailable - sandbox 是否可用（仅 full mode 需要）
 * @param autoConfig - auto mode 配置（可选）
 */
export function createModePolicy(
  mode: 'ask' | 'accept_edits' | 'auto' | 'full',
  sandboxAvailable?: boolean,
  autoConfig?: AutoModeConfig,
): RuntimePolicy {
  switch (mode) {
    case 'ask':
      return createAskModePolicy();
    case 'accept_edits':
      return createAcceptEditsModePolicy();
    case 'auto':
      return createAutoModePolicy(autoConfig);
    case 'full':
      return createFullModePolicy(sandboxAvailable ?? false);
  }
}
