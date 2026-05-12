import { useCallback } from "react";
import type { Dispatch } from "react";

export type SlashAction =
  | { type: "thinking" }
  | { type: "model"; name?: string }
  | { type: "model_list" }
  | { type: "sessions"; id?: string }
  | { type: "plan" }
  | { type: "code" }
  | { type: "auth"; mode?: string }
  | { type: "clear" }
  | { type: "compact" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "export" }
  | { type: "editor" }
  | { type: "setting" }
  | { type: "help" }
  | { type: "exit" }
  | { type: "unknown"; raw: string };

export function parseSlashCommand(input: string): SlashAction | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const arg = args.join(" ");

  switch (cmd) {
    case "thinking": case "t": return { type: "thinking" };
    case "model":
      if (arg === "list") return { type: "model_list" };
      return { type: "model", name: arg || undefined };
    case "sessions": return { type: "sessions", id: arg || undefined };
    case "plan": return { type: "plan" };
    case "code": return { type: "code" };
    case "auth": return { type: "auth", mode: arg || undefined };
    case "clear": case "c": return { type: "clear" };
    case "compact": return { type: "compact" };
    case "undo": return { type: "undo" };
    case "redo": return { type: "redo" };
    case "export": return { type: "export" };
    case "editor": return { type: "editor" };
    case "setting": case "config": return { type: "setting" };
    case "help": case "h": return { type: "help" };
    case "exit": case "quit": case "q": return { type: "exit" };
    default: return { type: "unknown", raw: input };
  }
}

export function useSlashCommand(dispatch: Dispatch<any>, onExit?: () => void) {
  return useCallback((input: string): boolean => {
    const action = parseSlashCommand(input);
    if (!action) return false;

    switch (action.type) {
      case "thinking":
        dispatch({ type: "TOGGLE_THINKING" });
        break;
      case "model":
        dispatch({ type: "SHOW_MODEL_SELECTOR" });
        break;
      case "model_list":
        dispatch({ type: "LIST_MODELS" });
        break;
      case "sessions":
        dispatch({ type: "SHOW_SESSIONS", id: action.id });
        break;
      case "plan":
        dispatch({ type: "SET_PHASE", phase: "planning" as const });
        dispatch({ type: "SWITCH_AUTH", mode: "default" });
        break;
      case "code":
        dispatch({ type: "SET_PHASE", phase: "building" as const });
        dispatch({ type: "SWITCH_AUTH", mode: "full_access" });
        break;
      case "auth":
        dispatch({ type: "SWITCH_AUTH", mode: action.mode ?? "toggle" });
        break;
      case "clear":
        dispatch({ type: "CLEAR_OUTPUT" });
        break;
      case "compact":
        dispatch({ type: "COMPACT_CONTEXT" });
        break;
      case "undo":
        dispatch({ type: "UNDO" });
        break;
      case "redo":
        dispatch({ type: "REDO" });
        break;
      case "export":
        dispatch({ type: "EXPORT_SESSION" });
        break;
      case "editor":
        dispatch({ type: "OPEN_EDITOR" });
        break;
      case "setting":
        dispatch({ type: "SHOW_SETTING" });
        break;
      case "help":
        dispatch({ type: "SHOW_HELP" });
        break;
      case "exit":
        if (onExit) onExit();
        else process.exit(0);
        break;
      default:
        return false;
    }
    return true;
  }, [dispatch, onExit]);
}
