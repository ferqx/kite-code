// ── 组合 reducer：按领域分发到子 reducer ──

import type { TuiState } from "../types";
import type { Action } from "./actions";
import { handleEventAction } from "./handleEvent";
import { uiReducer } from "./uiReducer";
import { sessionReducer } from "./sessionReducer";
import { checkpointReducer } from "./checkpointReducer";
import { skillReducer } from "./skillReducer";
import { agentReducer } from "./agentReducer";

export type { Action } from "./actions";

export function eventReducer(state: TuiState, action: Action): TuiState {
  // EVENT 动作有独立的子类型分发
  if (action.type === "EVENT") {
    return handleEventAction(state, action.event);
  }

  // 按领域顺序尝试：ui → session → checkpoint → skill → agent
  return uiReducer(state, action)
    ?? sessionReducer(state, action)
    ?? checkpointReducer(state, action)
    ?? skillReducer(state, action)
    ?? agentReducer(state, action)
    ?? state;
}
