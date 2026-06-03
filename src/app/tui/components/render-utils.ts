import { darkTheme } from "../theme";
const dt = darkTheme;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function toolColor(status: string): string {
  switch (status) {
    case "done": return dt.success;
    case "error": return dt.error;
    case "running": return dt.warning;
    default: return dt.muted;
  }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
