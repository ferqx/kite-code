import type { AgentMode, AgentPlan, AgentProgressLedger, ShellResult } from "../shared/types";
import { editFile, readFile, writeFile } from "../tools/file";
import { isPlanReadOnlyShellCommand } from "../tools/definitions";
import { shellTool, type ShellExecutor } from "../tools/shell";
import { DOOM_LOOP_REPEAT_LIMIT } from "./constants";
import { buildToolSignature } from "./progress";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  mode: AgentMode = "builder",
  existingPlan: AgentPlan | null = null,
  progress?: AgentProgressLedger,
): Promise<ToolExecutionResult> {
  const repeatedToolBlock = repeatedToolBlockResult(request, progress);
  if (repeatedToolBlock) {
    return repeatedToolBlock;
  }

  if (request.name === "update_plan") {
    return {
      ok: true,
      command: "update_plan",
      exitCode: 0,
      stdout: "",
      stderr: "",
      plan: request.args,
      ...(mode === "builder" && !existingPlan ? { mode: "plan" as AgentMode } : {}),
    };
  }

  if (request.name === "shell_read") {
    if (!isPlanReadOnlyShellCommand(request.args.command)) {
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

  if (mode === "plan") {
    return {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: "Rejected: Plan mode allows read-only shell commands only.",
    };
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

  return (shellExecutor ?? shellTool)({
    workspace,
    command: request.args.command,
  });
}

/** 检测死循环并返回拦截结果 / Detect doom-loop and return blocking result */
function repeatedToolBlockResult(
  request: PendingToolRequest,
  progress?: AgentProgressLedger,
): ShellResult | null {
  if (!progress) {
    return null;
  }

  const signature = buildToolSignature(request.name, request.args);
  const repeatedCallCount =
    progress.lastToolSignature === signature ? progress.repeatedCallCount + 1 : 1;
  if (repeatedCallCount < DOOM_LOOP_REPEAT_LIMIT) {
    return null;
  }

  return {
    ok: false,
    command: commandForRequest(request),
    exitCode: -1,
    stdout: "",
    stderr:
      "Repeated tool request blocked: same tool and input were requested 3 consecutive times. Change strategy before retrying.",
  };
}

/** 从工具请求中提取命令字符串 / Extract command string from tool request */
function commandForRequest(request: PendingToolRequest): string {
  if ("command" in request.args) {
    return request.args.command;
  }
  if (request.name === "update_plan") {
    return "update_plan";
  }
  return request.protectedCommand;
}

/** 构建 search 工具的 shell 命令 / Build shell command for search tool */
function buildSearchShellCommand(pattern: string, globPath?: string): string {
  const escaped = pattern.replace(/'/g, "'\\''");
  const pathArg = globPath ? `--glob '${globPath.replace(/'/g, "'\\''")}'` : "";
  return `rg -n --no-heading ${pathArg} '${escaped}'`;
}
