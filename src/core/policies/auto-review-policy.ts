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
