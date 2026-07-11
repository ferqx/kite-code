// ── Runtime Policy 接口 / Runtime Policy interface ──
// Phase 4: Mode → Policy 统一抽象
// ask-mode、auto-mode、full-mode、未来的 loop-mode 都实现同一接口，
// 策略决策从 graph 节点的 if-else 中解耦。
//
// Unified policy abstraction for all modes (ask / auto / full / loop).
// Policy decisions are decoupled from graph node if-else chains.

import type { AgentPlan, ToolApprovalPayload, UserInputPayload } from '@/protocol/events';

// ── 策略决策 / Policy decision ──

/**
 * 策略决策 — 策略评估的返回值，指示下一步应执行的效果。
 * Policy decision — the return value of policy evaluation, indicating the next effect to execute.
 *
 * 与 RuntimeEffect 不同：PolicyDecision 回答"应该做什么"，RuntimeEffect 回答"系统要执行什么"。
 * Unlike RuntimeEffect: PolicyDecision answers "what should be done", RuntimeEffect answers "what the system will execute".
 */
export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'need_user_input'; request: UserInputPayload }
  | { kind: 'need_plan_review'; plan?: AgentPlan }
  | { kind: 'need_tool_approval'; approval?: ToolApprovalPayload }
  | { kind: 'need_auto_review'; toolCallId: string; toolName: string; reason: string }
  | { kind: 'continue_loop' }
  | { kind: 'stop' };

// ── 策略输入 / Policy input ──

/** 策略评估的输入上下文 / Input context for policy evaluation */
export interface PolicyInput {
  /** 当前交互模式 / Current interaction mode */
  interactionMode: 'ask' | 'auto' | 'full';
  /** 当前执行阶段 / Current execution phase */
  phase: 'planning' | 'building';
  /** 当前方案生命周期状态 / Current plan lifecycle state kind (v2: PlanningState kinds) */
  planKind:
    | 'building_without_plan'
    | 'planning_empty'
    | 'planning_draft'
    | 'awaiting_review'
    | 'executing'
    | 'completed'
    | 'cancelled';
  /** 工具名称（审批决策时使用）/ Tool name (used in approval decisions) */
  toolName?: string;
  /** 工具参数（审批决策时使用）/ Tool arguments (used in approval decisions) */
  toolArgs?: Record<string, unknown>;
  /** 工具风险分类 / Tool risk classification */
  toolRisk?:
    | 'read'
    | 'plan'
    | 'write_file'
    | 'execute_code'
    | 'destructive'
    | 'network'
    | 'vcs_mutation'
    | 'mcp'
    | 'unknown';
  /** 是否已有审批缓存 / Whether approval is already cached */
  approvalCached?: boolean;
  /** 沙箱是否可用（full mode 前提条件）/ Whether sandbox is available (prerequisite for full mode) */
  sandboxAvailable?: boolean;
  /** doop-loop 计数 / Doom-loop repeat count */
  doomLoopCount?: number;
  /** 断路器是否已跳闸 / Whether circuit breaker has tripped */
  circuitBreakerTripped?: boolean;
}

// ── RuntimePolicy 接口 / RuntimePolicy interface ──

/**
 * 运行时策略接口 — 所有 mode（ask / auto / full / loop）的统一抽象。
 * Runtime policy interface — unified abstraction for all modes.
 *
 * 每个方法接收 PolicyInput 并返回 PolicyDecision，不产生副作用。
 * 策略实现是纯函数，可独立单元测试。
 *
 * Each method receives PolicyInput and returns PolicyDecision, with no side effects.
 * Policy implementations are pure functions, independently unit-testable.
 */
export interface RuntimePolicy {
  /** 策略名称（用于日志和调试）/ Policy name (for logging and debugging) */
  readonly name: string;

  /** 是否需要生成执行方案 / Whether an execution plan is required */
  shouldRequirePlan(input: PolicyInput): PolicyDecision;

  /** 方案是否需要人工审核 / Whether the plan requires human review */
  shouldReviewPlan(input: PolicyInput): PolicyDecision;

  /** 工具调用是否需要向用户提问 / Whether tool call requires asking the user */
  shouldAskUser(input: PolicyInput): PolicyDecision;

  /** 工具调用是否需要审批 / Whether tool call requires approval */
  shouldApproveTool(input: PolicyInput): PolicyDecision;

  /** 是否需要自动审查 / Whether auto-review is needed */
  shouldAutoReview(input: PolicyInput): PolicyDecision;

  /** 循环是否应继续（loop mode 专用）/ Whether the loop should continue (loop mode only) */
  shouldContinueLoop(input: PolicyInput): PolicyDecision;
}
