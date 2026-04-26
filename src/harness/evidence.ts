import type { AgentEvidence } from "../shared/types";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";
import { uniqueTail } from "./utils";

/** 更新执行证据记录 / Update execution evidence records */
export function updateEvidence(
  current: AgentEvidence | undefined,
  request: PendingToolRequest,
  result: ToolExecutionResult,
): AgentEvidence {
  const next: AgentEvidence = {
    commands: [...(current?.commands ?? [])],
    files: [...(current?.files ?? [])],
    verification: [...(current?.verification ?? [])],
  };

  if ("command" in result && result.command) {
    next.commands.push(result.command);
    if (/\b(test|typecheck|lint|build)\b/i.test(result.command)) {
      next.verification.push(
        `${result.command}: ${result.ok ? "ok" : "failed"} (${result.exitCode})`,
      );
    }
  }

  if (
    request.name === "read_file" ||
    request.name === "edit_file" ||
    request.name === "write_file"
  ) {
    const filePath = "path" in result ? result.path : undefined;
    if (filePath && result.ok) {
      next.files.push(filePath);
    }
  }

  return {
    commands: uniqueTail(next.commands, 20),
    files: uniqueTail(next.files, 20),
    verification: uniqueTail(next.verification, 20),
  };
}
