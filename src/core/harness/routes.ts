import { END } from '@langchain/langgraph';
import type { AuthorizationOverride } from '@/core/types';
import type { AgentPlan } from '@/protocol/events';
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
  const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
  if (allRequests.length === 0) return null;

  const workspaceAccess = state.workspaceAccess ?? 'write';
  const phase = state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess);

  let hasApprovalRequired = false;

  for (const request of allRequests) {
    // Priority 1: ask_user 必须由 user_input 中断节点处理，不能被 tools 节点执行
    if (request.name === 'ask_user') return 'user_input';

    // Priority 2: 结构性 update_plan（名称/描述/步骤文本变化）必须经过 plan_review
    // 纯进度更新（仅 status 变化）可直通 tools
    if (request.name === 'update_plan' && !isPlanProgressOnlyUpdate(state.plan, request.args)) {
      return 'plan_review';
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
  const batch = state.approvedBatch ?? {};
  const hasFullAccess = Object.values(batch).some((g) => g === 'full_access');

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

/** tools 节点后的路由逻辑 / Routing after tools node */
export function routeAfterTools(_state: CodeAgentState): 'agent' {
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

function isPlanProgressOnlyUpdate(current: AgentPlan | null | undefined, next: AgentPlan): boolean {
  if (!current) return false;
  if (current.name !== next.name) return false;
  if (current.description !== next.description) return false;
  if (current.steps.length !== next.steps.length) return false;
  return current.steps.every((step, index) => step.step === next.steps[index]?.step);
}
