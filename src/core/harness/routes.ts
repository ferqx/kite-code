import { END } from '@langchain/langgraph';
import { migratePermitBatch } from '@/core/execution/permit';
import type { AuthorizationOverride } from '@/core/types';
import { type AgentPlan, isFullAccessMode } from '@/protocol/events';
import type { CodeAgentState } from './state';
import { defaultPhaseForWorkspaceAccess, evaluateToolPolicy } from './tool-policy';
import { getAllPendingToolRequests } from './tool-requests';

/** 共享路由逻辑：扫描全部待处理工具请求，按优先级决定目标节点。
 *  Shared routing — scans ALL pending tool requests, picks target by priority.
 *
 *  优先级 / Priority:
 *   1. ask_user           → user_input   （必须由中断节点处理 / must be handled by interrupt）
 *   2. update_plan (结构性) → plan_review  （名称/描述/步骤文本改变须用户审查）
 *   3. 任一需审批          → approval     （整批进入审批，一次审批一个）
 *   4. 其余               → tools        （只读、纯进度更新、被拒绝的工具统一在此执行） */
function resolveToolRoute(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, 'read'>,
): 'approval' | 'tools' | 'user_input' | 'plan_review' | null {
  if (state.pendingSubagentApproval) {
    const batch = migratePermitBatch(state.approvedBatch);
    const id = state.pendingSubagentApproval.request.id;
    return id && batch[id] ? 'tools' : 'approval';
  }

  const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
  if (allRequests.length === 0) return null;

  const workspaceAccess = state.workspaceAccess ?? 'write';
  const phase = state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess);

  let hasApprovalRequired = false;

  for (const request of allRequests) {
    // Priority 1: ask_user 必须由 user_input 中断节点处理；full 下不能挂起
    if (request.name === 'ask_user') {
      if (isFullAccessMode(state.interactionMode)) continue;
      return 'user_input';
    }

    // Priority 2: 结构性 update_plan → plan_review
    // - 纯进度更新（仅 status 变化）→ 直通 tools（isPlanProgressOnlyUpdate）
    // - 已审批方案的重入追踪（名称和步骤数未变，允许文本微调）→ 直通 tools
    // - 新增/删除步骤或方案名称变化 → plan_review
    // Structural update_plan → plan_review
    // - Progress-only (status change only) → tools directly
    // - Re-entrant tracking for already-approved plan (same name & step count) → tools
    // - New/removed steps or renamed plan → plan_review
    if (request.name === 'update_plan' && !isPlanProgressOnlyUpdate(state.plan, request.args)) {
      if (state.planReviewed && isSamePlanTrackingUpdate(state.plan, request.args)) {
        // 已审批 + 同结构 → 直通 tools，不重复触发 plan_review
        // Already approved + same structure → tools, skip redundant plan_review
      } else {
        return 'plan_review';
      }
    }

    const decision = evaluateToolPolicy({
      request,
      workspaceAccess,
      phase,
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: state.authorization,
      override,
      mcpRiskOverride,
    });

    // Priority 3: 任一允许且需要审批的工具 → 整批进入 approval
    // 仅统计 allowed + requiresApproval 的工具；被拒绝的工具不触发审批循环
    if (decision.allowed && decision.requiresApproval) {
      hasApprovalRequired = true;
    }
  }

  // Priority 4: 全部不需审批 → tools（含只读、纯进度更新、被策略拒绝的工具）
  if (hasApprovalRequired) return 'approval';
  return 'tools';
}

/** 入口路由：无待处理工具时回退到 agent / Entry routing: fall back to agent when no pending tools */
export function routeEntry(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, 'read'>,
): 'agent' | 'approval' | 'tools' | 'user_input' | 'plan_review' {
  return resolveToolRoute(state, override, mcpRiskOverride) ?? 'agent';
}

/** agent 节点后路由：无待处理工具时终止 / After-agent routing: END when no pending tools */
export function routeAfterAgent(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, 'read'>,
): 'approval' | 'tools' | 'user_input' | 'plan_review' | typeof END {
  return resolveToolRoute(state, override, mcpRiskOverride) ?? END;
}

/** approval 节点后的路由逻辑 / Routing after approval node
 *  若同一批次还有工具未审批 → 循环回 approval；全部审批完 → tools */
export function routeAfterApproval(state: CodeAgentState): 'approval' | 'tools' | 'agent' {
  const batch = migratePermitBatch(state.approvedBatch);
  if (state.pendingSubagentApproval) {
    const id = state.pendingSubagentApproval.request.id;
    return id && batch[id] ? 'tools' : 'approval';
  }

  const hasFullAccess = Object.values(batch).some((p) => !p.consumed && p.grant === 'full_access');

  // full_access → 不再需要审批，直接执行
  // 必须扫描全部 pending tools，不能只看第一个：批次中可能混合了不同工具类型
  if (hasFullAccess) {
    return getAllPendingToolRequests(state.messages, state.workspace).length > 0
      ? 'tools'
      : 'agent';
  }

  // 检查同批次中是否有尚未审批的工具
  const allPending = getAllPendingToolRequests(state.messages, state.workspace);
  for (const r of allPending) {
    if (r.id && !batch[r.id] && r.name !== 'ask_user') {
      // 还有工具未审批 → 循环回 approval 节点
      return 'approval';
    }
  }

  // 全部已审批 → 执行
  if (allPending.length > 0) return 'tools';
  return 'agent';
}

/** tools 节点后的路由逻辑 / Routing after tools node
 *
 *  耗尽处理策略 / Exhaustion routing strategy:
 *  - full / auto 模式：无人在回路中 → 直接 END，防止模型绕过耗尽守卫。
 *    full/auto modes: no human in the loop → END, prevent model workarounds.
 *  - ask 模式：用户在回路中，可自行判断是否继续 → 路由到 agent 让模型响应。
 *    ask mode: human in the loop can decide → route to agent for model response.
 *
 *  设计理由：见 docs/space/plans/2026-06-30-approval-execution-sandbox.md「跨轮重置」——
 *  系统不应替用户做"这个操作不该重试"的判断，但在无人值守模式下必须自行终止。 */
export function routeAfterTools(state: CodeAgentState): 'approval' | 'agent' | typeof END {
  if (state.pendingSubagentApproval) return 'approval';
  const exhausted = state.exhaustedFingerprints ?? {};
  if (Object.keys(exhausted).length > 0) {
    // full/auto: terminate to prevent the model from trying workarounds
    if (state.interactionMode === 'full' || state.interactionMode === 'auto') return END;
    // ask: human is watching — let them see the exhaustion and decide
    return 'agent';
  }
  return 'agent';
}

/** user_input 节点后的路由逻辑 / Routing after user_input node */
export function routeAfterUserInput(_state: CodeAgentState): 'agent' {
  return 'agent';
}

/** plan_review 节点后的路由逻辑 / Routing after plan_review node */
export function routeAfterPlanReview(state: CodeAgentState): 'agent' | typeof END {
  const msgs = state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Record<string, unknown> | undefined;
    if (m?.name !== 'update_plan') continue;
    const content = typeof m?.content === 'string' ? m.content : '';
    try {
      const p = JSON.parse(content);
      if (p?.ok === false) {
        // Supplement feedback: route to agent so it can revise and re-call update_plan
        // Hard reject (Esc/Ctrl+C): route to END
        if (typeof p?.reason === 'string' && p.reason.startsWith('Plan needs revision')) {
          return 'agent';
        }
        return END;
      }
    } catch {
      /* not JSON */
    }
    break;
  }
  return 'agent';
}

/** 判断 update_plan 是否为纯进度更新。
 *  比较 name、description、步骤数量和每条步骤文本是否完全一致。
 *  若结构（文本）未变，则只可能是 status 字段变化 → 纯进度更新，无需触发 plan_review。
 *
 *  容错：模型在进度追踪调用中偶尔会省略 name / description 字段。
 *  缺失字段视为「与当前 plan 一致」，不触发误判。
 *
 *  Checks whether an update_plan call is a progress-only update (only status fields changed).
 *  If name, description, step count, and every step's text are identical to the current plan,
 *  the only possible change is step status — no plan_review needed.
 *
 *  Tolerance: the model sometimes omits name/description in progress-tracking calls.
 *  Missing fields are treated as "unchanged from current plan" to avoid false positives. */
function isPlanProgressOnlyUpdate(current: AgentPlan | null | undefined, next: AgentPlan): boolean {
  if (!current) return false;
  // 模型在进度追踪调用中可能省略 name/description → 视为未变化
  // Model may omit name/description in progress-tracking calls → treat as unchanged
  // 模型可能省略 name/description，也可能传空字符串（Zod 将缺失字段转为 ""）。
  // 缺失或空值 → 视为「与当前 plan 一致」，不触发误判。
  // Model may omit name/description or pass "" (Zod defaults missing strings to "").
  // Missing or empty → treated as "unchanged from current plan".
  if (next.name && current.name !== next.name) return false;
  if (next.description && current.description !== next.description) return false;
  if (current.steps.length !== next.steps.length) return false;
  return current.steps.every((step, index) => step.step === next.steps[index]?.step);
}

/** 判断 update_plan 是否为同计划的追踪更新（已审批方案的重入，仅做进度/文本微调）。
 *  与 isPlanProgressOnlyUpdate 不同：本函数允许步骤文本变化（模型执行时常会扩充描述），
 *  仅检查计划名称和步骤数量是否一致，确保结构未发生根本变化。
 *
 *  多轮 plan 保护：当前计划状态为 completed 时视为该计划周期已结束，后续任何
 *  update_plan 均视为新计划，必须重新走 plan_review，避免同名称、同步数的新计划被跳过。
 *
 *  容错：模型在进度追踪调用中偶尔会省略 name 字段。缺失字段视为「与当前 plan 一致」。
 *
 *  Checks whether a re-entrant update_plan is a tracking update for an already-approved plan.
 *  Unlike isPlanProgressOnlyUpdate, this ALLOWS step text changes (model often elaborates
 *  during execution) and only guards against name changes or step count changes.
 *
 *  Multi-cycle guard: when the current plan is completed, treat any subsequent update_plan
 *  as a NEW plan requiring full review — prevents skipping review for a new plan that
 *  happens to have the same name and step count as a completed previous plan.
 *
 *  Tolerance: the model sometimes omits name in re-entrant calls. Missing fields are
 *  treated as "unchanged from current plan" to avoid false positives. */
function isSamePlanTrackingUpdate(current: AgentPlan | null | undefined, next: AgentPlan): boolean {
  if (!current) return false;
  // 上一轮计划已完成 → 视为新计划，必须走 plan_review
  // Previous plan completed → treat as new plan, must go through plan_review
  if (current.status === 'completed') return false;
  // 模型在进度追踪调用中可能省略 name → 视为未变化
  // Model may omit name in re-entrant calls → treat as unchanged
  if (next.name && current.name !== next.name) return false;
  if (current.steps.length !== next.steps.length) return false;
  return true;
}
