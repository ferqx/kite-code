// ── Auto-Review 策略 / Auto-Review Policy ──
// Phase 4 补全: 将 auto-review 决策逻辑从 graph.ts approval 节点中抽取为独立策略。
// 封装断路器、doom-loop、_safety 快速路径等决策，不执行任何 I/O。
//
// Completes Phase 4: Extracts auto-review decision logic from graph.ts approval node
// into a standalone policy. Encapsulates circuit breaker, doom-loop, _safety fast-path
// decisions. Pure functions, no I/O.
//
// 注意：本策略只做决策（是否应 auto-review），不调用 reviewer model。
// 实际的 model 调用在 auto-review-controller.ts 中执行。
// Note: This policy only makes decisions (should we auto-review?), it does NOT
// call the reviewer model. Actual model calls happen in auto-review-controller.ts.

import type { ShellApprovalGrant } from '@/protocol/events';
import type { PolicyDecision, PolicyInput, RuntimePolicy } from './runtime-policy';

// ── _safety Fast-Path 类型 / _safety Fast-Path Types ──

/** _safety 快速路径评估输入 / Input for _safety fast-path evaluation */
export interface SafetyFastPathInput {
  /** Agent 自声明的安全等级 / Agent-declared safety level */
  agentSafety?: 'safe' | 'caution' | 'dangerous';
  /** 工具风险分类 / Tool risk classification */
  toolRisk: string;
  /** 断路器是否已触发 / Whether circuit breaker has tripped */
  circuitBreakerTripped: boolean;
}

/** _safety 快速路径评估结果 / Result of _safety fast-path evaluation */
export type SafetyFastPathResult =
  | { kind: 'no_fast_path' }
  | { kind: 'auto_approve'; grant: ShellApprovalGrant; reason: string }
  | { kind: 'force_deny'; reason: string }
  | { kind: 'force_interrupt'; reason: string };

/**
 * 评估 _safety 快速路径 — 纯逻辑，无副作用，不依赖 graph 状态。
 * Evaluate _safety fast-path — pure logic, no side effects, no graph dependency.
 *
 * 三种快速路径 / Three fast paths:
 * 1. `_safety=safe` + 低风险（write_file / execute_code / read）且断路器未触发
 *    → auto_approve: 跳过 reviewer 直接批准
 * 2. `_safety=safe` + destructive
 *    → force_deny: belt-and-suspenders 覆盖，agent 不能将 destructive 声明为 safe
 * 3. `_safety=dangerous`
 *    → force_interrupt: 跳过 reviewer，直接交用户审批
 *
 * 断路器评估、doom-loop 追踪等执行层关注点由调用方（graph.ts）处理。
 * Circuit breaker evaluation and doom-loop tracking are execution concerns handled by the caller.
 */
export function evaluateSafetyFastPath(input: SafetyFastPathInput): SafetyFastPathResult {
  const { agentSafety, toolRisk, circuitBreakerTripped } = input;

  // safe + 低风险 → 快速路径自动批准（断路器已触发时不允许）
  // safe + low risk → fast-path auto-approve (blocked when circuit breaker is tripped)
  if (
    agentSafety === 'safe' &&
    !circuitBreakerTripped &&
    (toolRisk === 'write_file' || toolRisk === 'execute_code' || toolRisk === 'read')
  ) {
    return {
      kind: 'auto_approve',
      grant: 'approve_once',
      reason: '[_safety=safe] auto-approved by agent self-assessment',
    };
  }

  // safe + destructive → belt-and-suspenders 覆盖
  // safe + destructive → belt-and-suspenders override — agent CANNOT declare destructive as safe
  if (agentSafety === 'safe' && toolRisk === 'destructive') {
    return {
      kind: 'force_deny',
      reason: 'Agent claimed _safety=safe on destructive command',
    };
  }

  // dangerous → 跳过 reviewer，直接用户审批 / dangerous → skip reviewer, force user interrupt
  if (agentSafety === 'dangerous') {
    return {
      kind: 'force_interrupt',
      reason: 'Agent declared _safety=dangerous — forcing user interrupt',
    };
  }

  // 无快速路径 → 走正常 reviewer 流程 / No fast path → follow normal reviewer flow
  return { kind: 'no_fast_path' };
}

// ── 配置 / Configuration ──

/** Auto-review 策略配置 / Auto-review policy configuration */
export interface AutoReviewPolicyConfig {
  /** 是否允许 fail-open（review 失败时放行）/ Whether to allow fail-open on review failure */
  failOpen?: boolean;
  /** doop-loop 触发阈值 / Doom-loop trigger threshold (repeat count) */
  doomLoopThreshold?: number;
  /** 断路器最大拒绝次数 / Circuit breaker max rejections */
  circuitBreakerMaxRejections?: number;
}

const DEFAULT_DOOM_LOOP_THRESHOLD = 3;
// DEFAULT_CIRCUIT_BREAKER_MAX (5) reserved for future circuit breaker integration

// ── 辅助函数 / Helpers ──

/** 判断工具风险是否需要 auto-review / Returns true if the tool risk warrants auto-review */
function requiresAutoReview(risk: PolicyInput['toolRisk']): boolean {
  if (!risk) return false;
  // 只读和计划类工具不需要 auto-review / Read and plan tools don't need auto-review
  if (risk === 'read' || risk === 'plan') return false;
  // 破坏性工具由 approval 策略拒绝，不走 auto-review / Destructive tools are denied by approval policy
  if (risk === 'destructive') return false;
  // 所有其他风险级别（write_file, execute_code, network, vcs_mutation, mcp, unknown）都需要
  return true;
}

// ── Auto-Review 策略实现 / Auto-Review Policy Implementation ──

/**
 * 创建 Auto-Review 策略 — 封装 auto-mode 下工具自动审查的决策逻辑。
 * Create Auto-Review policy — encapsulates auto-review decision logic for auto-mode.
 *
 * 与 mode-policy.ts 中的 auto-mode 配合使用：mode-policy 决定"哪些工具需要审批"，
 * auto-review-policy 决定"审批是否可以自动完成"。
 *
 * Used together with auto-mode in mode-policy.ts: mode-policy decides "which tools
 * need approval", auto-review-policy decides "can approval be automated".
 *
 * 决策矩阵 / Decision matrix:
 * - 破坏性工具 → deny（不可绕过）
 * - 已缓存审批 → allow（直通）
 * - 断路器跳闸 → need_tool_approval（回退到人工审批）
 * - doom-loop 超阈值 → need_tool_approval（回退到人工审批）
 * - 只读/计划类 → allow（直通）
 * - 写/执行/网络等 → need_auto_review（走 auto-review）
 */
export function createAutoReviewPolicy(config?: AutoReviewPolicyConfig): RuntimePolicy {
  const doomLoopThreshold = config?.doomLoopThreshold ?? DEFAULT_DOOM_LOOP_THRESHOLD;
  // circuitBreakerMaxRejections reserved for future circuit breaker integration
  void config?.circuitBreakerMaxRejections;
  const failOpen = config?.failOpen ?? false;

  return {
    name: 'auto-review',

    // ── 计划相关 / Plan-related ──
    // auto-review 策略不干预计划生命周期，委托给 mode-policy + plan-policy
    // Auto-review policy does not intervene in plan lifecycle; delegates to mode-policy + plan-policy

    shouldRequirePlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    shouldReviewPlan(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    // ── 用户交互 / User interaction ──
    // auto-review 策略不干预 ask_user，委托给 mode-policy
    // Auto-review policy does not intervene in ask_user; delegates to mode-policy

    shouldAskUser(_input: PolicyInput): PolicyDecision {
      return { kind: 'allow' };
    },

    // ── 工具审批 / Tool approval ──
    // 核心决策：工具是否可以通过 auto-review 自动审批
    // Core decision: can this tool be automatically approved via auto-review?

    shouldApproveTool(input: PolicyInput): PolicyDecision {
      // 破坏性工具 — 不可绕过 / Destructive — never bypass
      if (input.toolRisk === 'destructive') {
        return {
          kind: 'deny',
          reason: 'Destructive operations cannot be auto-reviewed.',
        };
      }

      // 已有审批缓存 — 直通 / Already cached approval — allow
      if (input.approvalCached) {
        return { kind: 'allow' };
      }

      // 断路器跳闸 — 回退到人工审批 / Circuit breaker tripped — fall back to manual
      if (input.circuitBreakerTripped) {
        return {
          kind: 'need_tool_approval',
        };
      }

      // doom-loop 检测 — 超过阈值回退到人工审批
      // Doom-loop detection — fall back to manual if threshold exceeded
      if (input.doomLoopCount !== undefined && input.doomLoopCount >= doomLoopThreshold) {
        return {
          kind: 'need_tool_approval',
        };
      }

      // 只读/计划类 — 直通 / Read/plan — allow directly
      if (input.toolRisk === 'read' || input.toolRisk === 'plan') {
        return { kind: 'allow' };
      }

      // 所有其他风险级别 — 走 auto-review / All other risk levels — go through auto-review
      if (requiresAutoReview(input.toolRisk)) {
        return {
          kind: 'need_auto_review',
          toolCallId: '',
          toolName: input.toolName ?? 'unknown',
          reason: `Auto-review required for tool "${input.toolName ?? 'unknown'}" with risk "${input.toolRisk ?? 'unknown'}".`,
        };
      }

      // 未知风险 — 保守处理：走 auto-review / Unknown risk — conservative: go through auto-review
      return {
        kind: 'need_auto_review',
        toolCallId: '',
        toolName: input.toolName ?? 'unknown',
        reason: 'Auto-review required for tool with unknown risk classification.',
      };
    },

    // ── Auto-Review 决策 / Auto-Review decision ──
    // 判断当前是否应启动 auto-review（区别于 shouldApproveTool：
    // shouldApproveTool 回答"这个工具需要什么？"，shouldAutoReview 回答"这个工具能否自动审批？"）
    // Distinguishing from shouldApproveTool: shouldApproveTool answers "what does this tool need?",
    // shouldAutoReview answers "can this tool be auto-reviewed?"

    shouldAutoReview(input: PolicyInput): PolicyDecision {
      // 断路器跳闸 — 跳过 auto-review / Circuit breaker tripped — skip
      if (input.circuitBreakerTripped) {
        return { kind: 'allow' }; // 跳过 = 不进 auto-review，由 shouldApproveTool 处理
      }

      // doom-loop — 跳过 / Doom-loop — skip
      if (input.doomLoopCount !== undefined && input.doomLoopCount >= doomLoopThreshold) {
        return { kind: 'allow' }; // 跳过
      }

      // 破坏性 — 不自动审查 / Destructive — don't auto-review
      if (input.toolRisk === 'destructive') {
        return { kind: 'allow' }; // 由 shouldApproveTool 拒绝
      }

      // 只读/计划 — 不需要 / Read/plan — not needed
      if (input.toolRisk === 'read' || input.toolRisk === 'plan') {
        return { kind: 'allow' };
      }

      // 需要自动审查的工具 / Tools that need auto-review
      if (requiresAutoReview(input.toolRisk)) {
        return {
          kind: 'need_auto_review',
          toolCallId: '',
          toolName: input.toolName ?? 'unknown',
          reason: `Auto-review invoked for "${input.toolName ?? 'unknown'}" (risk: ${input.toolRisk ?? 'unknown'}, failOpen: ${failOpen}).`,
        };
      }

      return { kind: 'allow' };
    },

    // ── 循环 / Loop ──
    // auto-review 不支持 loop-mode / Auto-review does not support loop-mode

    shouldContinueLoop(_input: PolicyInput): PolicyDecision {
      return { kind: 'stop' };
    },
  };
}

// ── 工厂函数 / Factory ──

/**
 * 创建默认 auto-review 策略 / Creates the default auto-review policy.
 *
 * 默认行为：fail-closed, doom-loop threshold=3, circuit-breaker max rejections=5。
 * Default behavior: fail-closed, doom-loop threshold=3, circuit-breaker max rejections=5.
 */
export function createDefaultAutoReviewPolicy(): RuntimePolicy {
  return createAutoReviewPolicy();
}
