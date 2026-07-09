// Route logic for the LangGraph agent graph.
// Phase 4 部分完成: resolveToolRoute 中的 interactionMode 直接检查已替换为
// policy 评估（shouldAskUser / shouldContinueLoop）。routeAfterTools 中的
// 耗尽检查同样通过 policy 判断是否有人值守。
//
// Phase 4 partial: direct interactionMode checks in resolveToolRoute replaced
// with policy evaluation (shouldAskUser / shouldContinueLoop). Exhaustion check
// in routeAfterTools also uses policy to determine human-in-the-loop presence.
//
// 迁移步骤剩余 / Remaining migration steps:
//   1. ✅ routeEntry / routeAfterAgent 中的 ask_user + 耗尽 policy 评估
//   2. routeAfterApproval / routeAfterTools 中的 full_access / exhausted 逻辑移入 scheduler
//   3. 删除本文件，所有路由决策由 decideNextEffect 接管

import { END } from '@langchain/langgraph';
import { migratePermitBatch } from '@/core/execution/permit';
import { createModePolicy } from '@/core/policies/mode-policy';
import { isPlanProgressOnlyUpdate, isSamePlanTrackingUpdate } from '@/core/policies/plan-policy';
import type { AuthorizationOverride } from '@/core/types';
import type { CodeAgentState } from './state';
import { defaultPhaseForWorkspaceAccess, evaluateToolPolicy } from './tool-policy';
import { getAllPendingToolRequests } from './tool-requests';

/** 根据 graph state 构建 PolicyInput 的基础上下文 / Build base PolicyInput context from graph state */
function buildPolicyContext(state: CodeAgentState) {
  return {
    interactionMode: (state.interactionMode ?? 'ask') as 'ask' | 'auto' | 'full',
    phase: (state.phase ?? 'building') as 'planning' | 'building',
    planKind: (!state.plan ? 'none' : state.planReviewed ? 'approved' : 'drafted') as
      | 'none'
      | 'drafted'
      | 'awaiting_review'
      | 'approved'
      | 'building'
      | 'needs_revision'
      | 'completed',
  };
}

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
    // Priority 1: ask_user 必须由 user_input 中断节点处理；通过 policy 判断是否允许挂起
    // Priority 1: ask_user must be handled by user_input interrupt; policy decides if suspension is allowed
    if (request.name === 'ask_user') {
      const mode = (state.interactionMode ?? 'ask') as 'ask' | 'auto' | 'full';
      const policy = createModePolicy(mode);
      const decision = policy.shouldAskUser({
        ...buildPolicyContext(state),
        toolName: request.name,
      });
      // full mode denies ask_user → skip (don't suspend)
      if (decision.kind === 'deny') continue;
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
    // 通过 policy 判断是否有人值守 / Use policy to determine if human is in the loop
    // ask mode: shouldApproveTool 对写工具返回 need_tool_approval → 有人值守 → agent
    // auto mode: shouldApproveTool 返回 need_auto_review → 无人值守 → END
    // full mode: shouldApproveTool 返回 allow（sandbox 可用）→ 无人值守 → END
    // 枯竭检查假设 full mode 的 sandbox 可用（sandbox 回退是安全网，不等于有人值守）
    const mode = (state.interactionMode ?? 'ask') as 'ask' | 'auto' | 'full';
    const policy = createModePolicy(mode, /* sandboxAvailable */ true);
    const approvalDecision = policy.shouldApproveTool({
      ...buildPolicyContext(state),
      toolName: 'write_file',
      toolRisk: 'write_file',
    });
    // Only ask mode requires human tool approval → human is watching
    if (approvalDecision.kind === 'need_tool_approval') return 'agent';
    // Auto/full: unattended → terminate to prevent model workarounds
    return END;
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
