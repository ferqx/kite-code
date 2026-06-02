import { useInput } from "ink";
import type { Dispatch } from "react";

export function useGlobalKeys(dispatch: Dispatch<any>) {
  useInput((input: string, key: { ctrl?: boolean; escape?: boolean }) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "CTRL_C" });
      return;
    }
    if (key.ctrl && input === "t") {
      dispatch({ type: "TOGGLE_ALL_REASON" });
      return;
    }
    if (key.ctrl && input === "e") {
      dispatch({ type: "EXPAND_INPUT" });
      return;
    }
    if (key.ctrl && input === "l") {
      dispatch({ type: "CLEAR_OUTPUT" });
      return;
    }
    if (key.escape) {
      dispatch({ type: "ESCAPE" });
    }
  });
}
