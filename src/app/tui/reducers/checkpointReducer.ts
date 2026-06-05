// ── Checkpoint 操作 ──

import type { Action } from "./actions";
import type { TuiState } from "../types";

export function checkpointReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "REVERT_TO_CHECKPOINT":
      return { ...state, showRewind: false, checkpoints: [], rewindCounter: state.rewindCounter + 1 };
    case "FORK_FROM_CHECKPOINT":
      return { ...state, showRewind: false, checkpoints: [], rewindCounter: state.rewindCounter + 1 };
    case "SET_CHECKPOINTS":
      return { ...state, checkpoints: action.checkpoints };
    default:
      return null;
  }
}
