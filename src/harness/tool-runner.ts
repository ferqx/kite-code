import type { AgentPlan, WorkspaceAccess } from "../shared/types";
import { editFile, readFile, writeFile } from "../tools/file";
import { isReadOnlyShellCommand } from "../tools/definitions";
import { shellTool, type ShellExecutor } from "../tools/shell";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  workspaceAccess: WorkspaceAccess = "write",
  _existingPlan: AgentPlan | null = null,
): Promise<ToolExecutionResult> {
  if (request.name === "update_plan") {
    return {
      ok: true,
      command: "update_plan",
      exitCode: 0,
      stdout: "",
      stderr: "",
      plan: request.args,
    };
  }

  if (request.name === "shell_read") {
    if (!isReadOnlyShellCommand(request.args.command)) {
      return {
        ok: false,
        command: request.args.command,
        exitCode: -1,
        stdout: "",
        stderr: "Rejected: shell_read only accepts read-only shell commands.",
      };
    }
    return (shellExecutor ?? shellTool)({
      workspace,
      command: request.args.command,
    });
  }

  if (request.name === "search") {
    return (shellExecutor ?? shellTool)({
      workspace,
      command: buildSearchShellCommand(request.args.pattern, request.args.path),
    });
  }

  if (request.name === "read_file") {
    const result = readFile({
      workspace,
      path: request.args.path ?? "",
      offset: request.args.offset,
      limit: request.args.limit,
    });
    return {
      ok: result.ok,
      command: `read_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.content,
      stderr: result.error ?? "",
      path: request.args.path,
    };
  }

  if (workspaceAccess === "read-only") {
    return {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: "Rejected: read-only workspace access allows read-only tools only.",
    };
  }

  if (request.name === "edit_file") {
    if (!request.args.old_string) {
      return {
        ok: false,
        command: `edit_file ${request.args.path ?? ""}`,
        exitCode: -1,
        stdout: "",
        stderr: "edit_file requires old_string to locate the text to replace.",
      };
    }
    const result = editFile({
      workspace,
      path: request.args.path ?? "",
      oldString: request.args.old_string,
      newString: request.args.new_string ?? "",
      replaceAll: request.args.replace_all,
    });
    return {
      ok: result.ok,
      command: `edit_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.ok
        ? `Replaced ${result.replacements ?? 1} occurrence(s) at line ${result.fromLine}-${result.toLine}`
        : "",
      stderr: result.error ?? "",
      path: request.args.path,
    };
  }

  if (request.name === "write_file") {
    const result = writeFile({
      workspace,
      path: request.args.path ?? "",
      content: request.args.content ?? "",
    });
    return {
      ok: result.ok,
      command: `write_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.ok ? `Wrote ${result.lines ?? 0} line(s) to ${request.args.path}` : "",
      stderr: result.error ?? "",
      path: request.args.path,
    };
  }

  if (request.name === "ask_user") {
    return {
      ok: false,
      command: "ask_user",
      exitCode: -1,
      stdout: "",
      stderr: "ask_user must be handled by the user_input interrupt node.",
    };
  }

  return (shellExecutor ?? shellTool)({
    workspace,
    command: request.args.command,
  });
}

/** 构建 search 工具的 shell 命令 / Build shell command for search tool */
function buildSearchShellCommand(pattern: string, globPath?: string): string {
  const escaped = pattern.replace(/'/g, "'\\''");
  const pathArg = globPath ? `--glob '${globPath.replace(/'/g, "'\\''")}'` : "";
  return `rg -n --no-heading ${pathArg} '${escaped}'`;
}
