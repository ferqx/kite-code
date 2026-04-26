import { END } from "@langchain/langgraph";
import type { CodeAgentState } from "./state";
import { getPendingToolRequest } from "./tool-requests";

/** START 入口路由：根据 mode 选择 agent_plan 或 agent_build / Entry routing */
export function routeEntry(state: CodeAgentState): "agent_plan" | "agent_build" {
  return state.mode === "plan" ? "agent_plan" : "agent_build";
}

/** plan agent 节点后的路由: tools | stop_check | END / Routing after plan agent */
export function routeAfterAgentPlan(
  state: CodeAgentState,
): "tools" | "stop_check" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return state.final ? "stop_check" : END;
  }
  return "tools";
}

/** build agent 节点后的路由: approval | tools | stop_check | END / Routing after build agent */
export function routeAfterAgentBuild(
  state: CodeAgentState,
): "approval" | "tools" | "stop_check" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return state.final ? "stop_check" : END;
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
): "stop_check" | "agent_plan" | "agent_build" {
  if (state.final) {
    return "stop_check";
  }
  if (state.mode === "plan" && state.plan) {
    return "stop_check";
  }
  return state.mode === "plan" ? "agent_plan" : "agent_build";
}

/** stop_check 节点后的路由逻辑 / Routing after stop check node */
export function routeAfterStopCheck(
  state: CodeAgentState,
): "approval" | "agent_plan" | "agent_build" | typeof END {
  if (!state.final) {
    return state.mode === "plan" ? "agent_plan" : "agent_build";
  }
  return state.mode === "plan" ? "approval" : END;
}
