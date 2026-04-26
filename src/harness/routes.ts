import { END } from "@langchain/langgraph";
import type { CodeAgentState } from "./state";
import { getPendingToolRequest } from "./tool-requests";

/** START 入口路由：根据 mode 选择 agent_plan 或 agent_build / Entry routing */
export function routeEntry(state: CodeAgentState): "agent_plan" | "agent_build" {
  return state.mode === "plan" ? "agent_plan" : "agent_build";
}

/** plan agent 节点后的路由: tools | END / Routing after plan agent */
export function routeAfterAgentPlan(state: CodeAgentState): "tools" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return END;
  }
  return "tools";
}

/** build agent 节点后的路由: approval | tools | END / Routing after build agent */
export function routeAfterAgentBuild(
  state: CodeAgentState,
): "approval" | "tools" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return END;
  }
  if (
    request.name === "update_plan" ||
    request.name === "read_file" ||
    request.name === "search"
  ) {
    return "tools";
  }
  return "approval";
}

/** approval 节点后的路由逻辑 / Routing after approval node */
export function routeAfterApproval(
  state: CodeAgentState,
): "tools" | "agent_plan" | "agent_build" {
  if (getPendingToolRequest(state.messages, state.workspace)) {
    return "tools";
  }
  return state.mode === "plan" ? "agent_plan" : "agent_build";
}

/** tools 节点后的路由逻辑 / Routing after tools node */
export function routeAfterTools(_state: CodeAgentState): "reflect" {
  return "reflect";
}

/** reflect 节点后的路由逻辑 / Routing after reflect node */
export function routeAfterReflect(
  state: CodeAgentState,
): "agent_plan" | "agent_build" | typeof END {
  if (state.final) {
    return END;
  }
  return state.mode === "plan" ? "agent_plan" : "agent_build";
}
