import type {
  AgentPhase,
  AgentPlan,
  ShellGrantUsed,
  WorkspaceAccess,
} from "../../protocol/events";
import type {
  AuthorizationOverride,
  ShellResult,
  ThreadAuthorizationState,
} from "../types";
import { editFile, readFile, writeFile } from "../tools/file";
import { shellTool, type ShellExecutor } from "../tools/shell";
import {
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  normalizeAuthorizationState,
} from "./tool-policy";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  workspaceAccess: WorkspaceAccess = "write",
  _existingPlan: AgentPlan | null = null,
  phase: AgentPhase = defaultPhaseForWorkspaceAccess(workspaceAccess),
  authorization: ThreadAuthorizationState | null = null,
  approvedGrant: ShellGrantUsed = "none",
  threadId = "",
  override?: AuthorizationOverride,
): Promise<ToolExecutionResult> {
  const policy = evaluateToolPolicy({
    request,
    workspaceAccess,
    phase,
    workspace,
    threadId,
    authorization: normalizeAuthorizationState(authorization),
    override,
  });
  if (!policy.allowed) {
    return withFailureGuidance(request, {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: `Rejected by tool policy: ${policy.reason}`,
    });
  }

  if (request.name === "update_plan") {
    return withFailureGuidance(request, {
      ok: true,
      command: "update_plan",
      exitCode: 0,
      stdout: "",
      stderr: "",
      plan: request.args,
    });
  }

  if (request.name === "read_file") {
    const result = readFile({
      workspace,
      path: request.args.path ?? "",
      offset: request.args.offset,
      limit: request.args.limit,
    });
    return withFailureGuidance(request, {
      ok: result.ok,
      command: `read_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.content,
      stderr: result.error ?? "",
      path: request.args.path,
    });
  }

  if (request.name === "edit_file") {
    if (!request.args.old_string) {
      return withFailureGuidance(request, {
        ok: false,
        command: `edit_file ${request.args.path ?? ""}`,
        exitCode: -1,
        stdout: "",
        stderr: "edit_file requires old_string to locate the text to replace.",
      });
    }
    const result = editFile({
      workspace,
      path: request.args.path ?? "",
      oldString: request.args.old_string,
      newString: request.args.new_string ?? "",
      replaceAll: request.args.replace_all,
    });
    return withFailureGuidance(request, {
      ok: result.ok,
      command: `edit_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.ok
        ? `Replaced ${result.replacements ?? 1} occurrence(s) at line ${result.fromLine}-${result.toLine}`
        : "",
      stderr: result.error ?? "",
      path: request.args.path,
    });
  }

  if (request.name === "write_file") {
    const result = writeFile({
      workspace,
      path: request.args.path ?? "",
      content: request.args.content ?? "",
    });
    return withFailureGuidance(request, {
      ok: result.ok,
      command: `write_file ${request.args.path ?? ""}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.ok ? `Wrote ${result.lines ?? 0} line(s) to ${request.args.path}` : "",
      stderr: result.error ?? "",
      path: request.args.path,
    });
  }

  if (request.name === "ask_user") {
    return withFailureGuidance(request, {
      ok: false,
      command: "ask_user",
      exitCode: -1,
      stdout: "",
      stderr: "ask_user must be handled by the user_input interrupt node.",
    });
  }

  if (request.name === "set_authorization_mode") {
    if (override) {
      override.current = request.args.mode;
    }
    const newAuth: ThreadAuthorizationState = {
      mode: request.args.mode,
      commandGrants: authorization?.commandGrants ?? {},
    };
    return withFailureGuidance(request, {
      ok: true,
      command: `set_authorization_mode ${request.args.mode}`,
      exitCode: 0,
      stdout: `Authorization mode set to: ${request.args.mode}`,
      stderr: "",
      authorization: newAuth,
    });
  }

  if (request.name === "shell_execute") {
    const result = await runShellForTool(workspace, request.args.command, shellExecutor);
    return withFailureGuidance(request, {
      ...result,
      action: {
        intent: request.args.intent,
        objective: request.args.objective,
        expectedObservation: request.args.expected_observation,
        failureStrategy: request.args.failure_strategy,
        prefixRule: request.args.prefix_rule,
        grantUsed: approvedGrant === "none" ? policy.grantUsed : approvedGrant,
      },
    });
  }

  return {
    ok: false,
    command: "unsupported_tool",
    exitCode: -1,
    stdout: "",
    stderr: "Unsupported tool request.",
  };
}

/** 执行 shell 并把异常转换为工具失败结果，避免阻断 ToolMessage 返回 / Convert shell exceptions into failed tool results */
async function runShellForTool(
  workspace: string,
  command: string,
  shellExecutor?: ShellExecutor,
): Promise<ShellResult> {
  try {
    return await (shellExecutor ?? shellTool)({ workspace, command });
  } catch (error) {
    return {
      ok: false,
      command,
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 给失败工具结果补充模型可直接使用的原因和正确用法 / Add model-facing failure guidance to failed tool results */
function withFailureGuidance(
  request: PendingToolRequest,
  result: ToolExecutionResult,
): ToolExecutionResult {
  const resultWithTool = {
    ...result,
    tool: request.name,
  };

  if (result.ok !== false) {
    return resultWithTool;
  }

  const reason =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `Tool ${request.name} failed with exit code ${result.exitCode}.`;

  return {
    ...resultWithTool,
    failure: {
      message: "Tool execution failed.",
      tool: request.name,
      reason,
      guidance: toolUsageGuidance(request),
    },
  };
}

/** 按工具类型生成失败后的正确使用提示 / Build per-tool usage guidance after failure */
function toolUsageGuidance(request: PendingToolRequest): string {
  switch (request.name) {
    case "read_file":
      return "Use read_file with a relative path inside the workspace. If the path is uncertain, use shell_execute with intent inspect and a read-only command such as rg, ls, find, or git status to locate the file first, then retry with the exact path.";
    case "edit_file":
      return "Use edit_file only after read_file. old_string must exactly match existing file content, including whitespace and indentation; if the same text appears multiple times, make old_string more specific or set replace_all: true.";
    case "write_file":
      return "Use write_file with a relative path and complete file content when creating or fully overwriting a file. For small changes to an existing file, prefer read_file followed by edit_file.";
    case "shell_execute":
      return "Use shell_execute with a concrete command and action metadata. Set intent to inspect for read-only checks such as rg, ls, cat, or git status; set intent to verify for tests, typecheck, build, lint, or smoke checks. Provide objective, expected_observation, and failure_strategy when they help review and recovery.";
    case "update_plan":
      return "Use update_plan with a complete plan object: name, description, status, and ordered steps with statuses. It must only update planning state and must not mutate the workspace.";
    case "ask_user":
      return "Use ask_user only when progress is blocked by a focused clarification. Provide one concise question, concrete options, and allow free text when appropriate; the user_input node handles the interrupt.";
    case "set_authorization_mode":
      return "Use set_authorization_mode only when the user explicitly requests a mode change. Choose 'full_access' for auto-execute without confirmation, or 'default' to restore confirmation requirements.";
  }
}
