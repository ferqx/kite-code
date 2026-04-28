import { END } from "@langchain/langgraph";
import type { CodeAgentState } from "./state";
import { getPendingToolRequest } from "./tool-requests";

/** START 入口路由：进入单一 agent / Entry routing to the single agent */
export function routeEntry(_state: CodeAgentState): "agent" {
  return "agent";
}

/** agent 节点后的路由: approval | tools | user_input | END / Routing after agent */
export function routeAfterAgent(
  state: CodeAgentState,
): "approval" | "tools" | "user_input" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return END;
  }
  if (request.name === "ask_user") {
    return "user_input";
  }
  if (state.workspaceAccess === "read-only") {
    return "tools";
  }
  if (
    request.name === "update_plan" ||
    request.name === "read_file" ||
    request.name === "search" ||
    request.name === "shell_read"
  ) {
    return "tools";
  }
  return "approval";
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
