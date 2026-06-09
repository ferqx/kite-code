import { END } from "@langchain/langgraph";
import type { AuthorizationOverride } from "@/core/types";
import type { CodeAgentState } from "./state";
import { getAllPendingToolRequests, getPendingToolRequest } from "./tool-requests";
import {
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
} from "./tool-policy";

/** Shared routing logic — resolves pending tool requests to a target node */
function resolveToolRoute(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, "read">,
): "approval" | "tools" | "user_input" | null {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) return null;
  if (request.name === "ask_user") return "user_input";

  const workspaceAccess = state.workspaceAccess ?? "write";
  const decision = evaluateToolPolicy({
    request,
    workspaceAccess,
    phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
    workspace: state.workspace,
    threadId: state.threadId,
    authorization: state.authorization,
    override,
    mcpRiskOverride,
  });

  if (!decision.allowed) return "tools";
  return decision.requiresApproval ? "approval" : "tools";
}

/** 入口路由：无待处理工具时回退到 agent / Entry routing: fall back to agent when no pending tools */
export function routeEntry(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, "read">,
): "agent" | "approval" | "tools" | "user_input" {
  return resolveToolRoute(state, override, mcpRiskOverride) ?? "agent";
}

/** agent 节点后路由：无待处理工具时终止 / After-agent routing: END when no pending tools */
export function routeAfterAgent(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, "read">,
): "approval" | "tools" | "user_input" | typeof END {
  return resolveToolRoute(state, override, mcpRiskOverride) ?? END;
}

/** approval 节点后的路由逻辑 / Routing after approval node
 *  若同一批次还有工具未审批 → 循环回 approval；全部审批完 → tools */
export function routeAfterApproval(
  state: CodeAgentState,
): "approval" | "tools" | "agent" {
  const batch = state.approvedBatch ?? {};
  const hasFullAccess = Object.values(batch).some((g) => g === "full_access");

  // full_access → 不再需要审批，直接执行
  if (hasFullAccess) {
    return getPendingToolRequest(state.messages, state.workspace) ? "tools" : "agent";
  }

  // 检查同批次中是否有尚未审批的工具
  const allPending = getAllPendingToolRequests(state.messages, state.workspace);
  for (const r of allPending) {
    if (r.id && !batch[r.id] && r.name !== "ask_user") {
      // 还有工具未审批 → 循环回 approval 节点
      return "approval";
    }
  }

  // 全部已审批 → 执行
  if (allPending.length > 0) return "tools";
  return "agent";
}

/** tools 节点后的路由逻辑 / Routing after tools node */
export function routeAfterTools(_state: CodeAgentState): "agent" {
  return "agent";
}

/** user_input 节点后的路由逻辑 / Routing after user_input node */
export function routeAfterUserInput(_state: CodeAgentState): "agent" {
  return "agent";
}
