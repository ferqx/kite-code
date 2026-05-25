import { useInput } from "ink";
import type { Dispatch } from "react";

export function useGlobalKeys(dispatch: Dispatch<any>, running: boolean, overlayActive?: boolean) {
  useInput((input: string, key: { ctrl?: boolean; escape?: boolean; tab?: boolean; shift?: boolean }) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "CTRL_C" });
      return;
    }
    if (key.ctrl && input === "n") {
      dispatch({ type: "NEW_SESSION" });
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
      dispatch({ type: "TOGGLE_ALL_REASON" });
      return;
    }
    if ((key.ctrl && input === "h") || input === "\x1bOP" || input === "\x1b[11~") {
      dispatch({ type: "SHOW_HELP" });
      return;
    }
    if (key.ctrl && input === "e") {
      dispatch({ type: "OPEN_EDITOR" });
      return;
    }
    if (key.ctrl && input === "o") {
      // Clear any open overlays (help, sessions, model selector) and reset navigation
      dispatch({ type: "ESCAPE" });
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

export function useLeaderKeys(dispatch: Dispatch<any>, leaderPending: boolean, onCompactRequest?: () => void) {
  useInput((input: string, key: { escape?: boolean }) => {
    if (!leaderPending) return;
    if (key.escape) {
      dispatch({ type: "LEADER_CANCEL" });
      return;
    }
    switch (input.toLowerCase()) {
      case "n":
        dispatch({ type: "NEW_SESSION" });
        dispatch({ type: "LEADER_CANCEL" });
        break;
      case "c":
        dispatch({ type: "COMPACT_CONTEXT" });
        if (onCompactRequest) onCompactRequest();
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
      case "q":
        process.exit(0);
        break;
      default:
        dispatch({ type: "LEADER_CANCEL" });
        break;
    }
  });
}
