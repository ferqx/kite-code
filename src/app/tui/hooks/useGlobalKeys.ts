import { useInput } from "ink";
import type { Dispatch } from "react";
import type { Action } from "../reducers";

/**
 * 全局快捷键 hook。
 * @param overlayActive — overlay 面板或中断激活时，仅保留 Ctrl+C / Escape，
 *   禁用 Ctrl+T/E/L 等修饰快捷键，避免与面板输入冲突。
 */
export function useGlobalKeys(dispatch: Dispatch<Action>, overlayActive = false) {
  useInput((input: string, key: { ctrl?: boolean; escape?: boolean }) => {
    // Ctrl+C 和 Escape 始终生效
    if (key.ctrl && input === "c") {
      dispatch({ type: "CTRL_C" });
      return;
    }
    if (key.escape) {
      dispatch({ type: "ESCAPE" });
      return;
    }
    // overlay 激活时禁用其他全局快捷键
    if (overlayActive) return;
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
  });
}
