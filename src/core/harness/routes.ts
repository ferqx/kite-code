import { END } from "@langchain/langgraph";
import type { AuthorizationOverride } from "@/core/types";
import type { CodeAgentState } from "./state";
import { getPendingToolRequest } from "./tool-requests";
import {
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
} from "./tool-policy";

/** START 入口路由：检查是否有待处理工具调用，避免从 checkpoint 恢复时模型收到悬空 tool_calls / Entry routing — check for pending tool calls to avoid dangling tool_calls on checkpoint restore */
export function routeEntry(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, "read">,
): "agent" | "approval" | "tools" | "user_input" {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return "agent";
  }
  if (request.name === "ask_user") {
    return "user_input";
  }
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

/** agent 节点后的路由: approval | tools | user_input | END / Routing after agent */
export function routeAfterAgent(
  state: CodeAgentState,
  override?: AuthorizationOverride,
  mcpRiskOverride?: Record<string, "read">,
): "approval" | "tools" | "user_input" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return END;
  }
  if (request.name === "ask_user") {
    return "user_input";
  }
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

/** approval 节点后的路由逻辑 / Routing after approval node */
export function routeAfterApproval(
  state: CodeAgentState,
): "tools" | "agent" {
  if (getPendingToolRequest(state.messages, state.workspace)) {
    return "tools";
  }
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
