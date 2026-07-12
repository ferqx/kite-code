// ── Mode 策略实现 / Mode policy implementations ──
// Phase 4: RuntimePolicy 接口的具体实现 — ask / auto / full 三种 mode。
// 将 mode 决策从 graph 节点 if-else 中解耦为可独立测试的纯函数。
//
// Concrete implementations of RuntimePolicy for ask / auto / full modes.
// Decouples mode decisions from graph node if-else chains into independently
// testable pure functions.

import type { AuthorizationSource } from '@/core/types';
import type { PolicyDecision, PolicyInput, RuntimePolicy } from './runtime-policy';

/** Enforce authorization invariants at every elevation boundary. */
export function assertAuthorizationElevation(input: {
  mode: 'default' | 'full_access';
  source?: AuthorizationSource;
  sandboxAvailable: boolean;
  autoReview?: boolean;
  loopMode?: boolean;
}): void {
  if (input.mode === 'full_access' && !input.sandboxAvailable) {
    throw new Error('full_access requires an available workspace sandbox.');
  }
  if (input.autoReview && input.source === 'system' && input.mode === 'full_access') {
    throw new Error('auto-review cannot grant full_access.');
  }
  if (input.loopMode && input.mode === 'full_access' && input.source === 'system') {
    throw new Error('loop-mode cannot auto-elevate authorization.');
  }
}

// ── 辅助函数 / Helpers ──

/** 判断工具是否为破坏性操作 / Returns true if the tool is a destructive operation */
function isDestructive(risk: PolicyInput['toolRisk']): boolean {
  return risk === 'destructive';
}

function hasExternalEffects(effects: PolicyInput['effects']): boolean {
  return Boolean(effects?.network || effects?.externalWrite || effects?.uncertainEffects);
}

/** 判断工具是否需要审批（非只读/非计划类）/ Returns true if the tool requires approval */
function requiresApproval(risk: PolicyInput['toolRisk']): boolean {
  if (!risk) return false;
  return risk !== 'read' && risk !== 'plan';
}

/**
 * `accept_edits` is the shared baseline for interactive execution modes.
 * It permits only proven-local workspace work and sends every other
 * non-destructive operation to an approval path.
 */
function decideAcceptEditsTool(input: PolicyInput): PolicyDecision {
  if (isDestructive(input.toolRisk)) {
    return { kind: 'deny', reason: 'destructive operations are not allowed' };
  }
  if (hasExternalEffects(input.effects)) {
    return { kind: 'need_tool_approval' };
  }
  if (input.toolRisk === 'write_file') {
    return { kind: 'allow' };
  }
  if (input.toolRisk === 'read' || input.toolRisk === 'plan') {
    return { kind: 'allow' };
  }
  return { kind: 'need_tool_approval' };
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
 * - 工具: 继承 accept_edits 的本地直通；原本需人工审批的操作走 auto-review，破坏性拒绝 /
 *   inherits accept_edits local allows; operations otherwise needing manual approval go through auto-review; destructive denied
 * - ask_user: 正常支持 / fully supported
 * - auto-review: 对需审批的工具自动审查 / auto-review for tools that need approval
 */
export function createAutoModePolicy(_config?: AutoModeConfig): RuntimePolicy {
  const decideTool = (input: PolicyInput): PolicyDecision => {
    const acceptEditsDecision = decideAcceptEditsTool(input);

    // Auto is an upgrade of accept_edits: preserve direct allows and denies,
    // and replace only manual approval with automatic review.
    if (acceptEditsDecision.kind !== 'need_tool_approval') {
      return acceptEditsDecision;
    }
    if (input.circuitBreakerTripped) {
      return { kind: 'need_tool_approval' };
    }
    return {
      kind: 'need_auto_review',
      toolCallId: '',
      toolName: input.toolName ?? 'unknown',
      reason: 'auto-review required for an operation accept_edits would require approval for',
    };
  };

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
      return decideTool(input);
    },

    shouldAutoReview(input: PolicyInput): PolicyDecision {
      const decision = decideTool(input);
      return decision.kind === 'need_auto_review' ? decision : { kind: 'allow' };
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
 * - proven-local workspace writes and Git mutations: allow
 * - read/plan: allow
 * - network, external writes, and unknown side effects: approval
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
      return decideAcceptEditsTool(input);
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
  mode: 'accept_edits' | 'auto' | 'full',
  sandboxAvailable?: boolean,
  autoConfig?: AutoModeConfig,
): RuntimePolicy {
  switch (mode) {
    case 'accept_edits':
      return createAcceptEditsModePolicy();
    case 'auto':
      return createAutoModePolicy(autoConfig);
    case 'full':
      return createFullModePolicy(sandboxAvailable ?? false);
  }
}
