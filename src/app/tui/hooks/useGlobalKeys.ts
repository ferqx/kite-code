import { useInput } from "ink";
import type { Dispatch } from "react";

export function useGlobalKeys(dispatch: Dispatch<any>) {
  useInput((input: string, key: { ctrl?: boolean; escape?: boolean }) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "CTRL_C" });
      return;
    }
    if (key.ctrl && input === "l") {
      dispatch({ type: "CLEAR_OUTPUT" });
      return;
    }
    if (key.ctrl && input === "r") {
      dispatch({ type: "SWITCH_AUTH", mode: "toggle" });
      return;
    }
    if (key.ctrl && input === "t") {
      dispatch({ type: "TOGGLE_THINKING" });
      return;
    }
    if (key.ctrl && (input === "h")) {
      dispatch({ type: "SHOW_HELP" });
      return;
    }
    if (key.ctrl && input === "e") {
      dispatch({ type: "OPEN_EDITOR" });
      return;
    }
    if (key.ctrl && input === "x") {
      dispatch({ type: "LEADER_PENDING" });
      return;
    }
    if (key.escape) {
      dispatch({ type: "ESCAPE" });
      return;
    }
  });
}

export function useLeaderKeys(dispatch: Dispatch<any>, leaderPending: boolean) {
  useInput((input: string, key: { escape?: boolean }) => {
    if (!leaderPending) return;
    if (key.escape) {
      dispatch({ type: "LEADER_CANCEL" });
      return;
    }
    switch (input.toLowerCase()) {
      case "c":
        dispatch({ type: "COMPACT_CONTEXT" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "m":
        dispatch({ type: "SHOW_MODEL_SELECTOR" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "l":
        dispatch({ type: "SHOW_SESSIONS" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "e":
        dispatch({ type: "OPEN_EDITOR" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "n":
        dispatch({ type: "CLEAR_OUTPUT" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "q":
        process.exit(0);
        break;
      default:
        dispatch({ type: "LEADER_CANCEL" });
        break;
    }
  });
}
