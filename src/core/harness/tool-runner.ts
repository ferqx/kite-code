import type {
  AgentPhase,
  AgentPlan,
  ShellGrantUsed,
  WorkspaceAccess,
} from "@/protocol/events";
import type {
  AuthorizationOverride,
  ShellResult,
  ThreadAuthorizationState,
} from "@/core/types";
import { editFile, readFile, writeFile } from "@/core/tools/file";
import { shellTool, type ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import { parseMcpToolName } from "@/core/mcp/tool-adapter";
import {
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  normalizeAuthorizationState,
} from "./tool-policy";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import { getSkillContent } from "@/core/skills/loader";

/** runApprovedTool 输入参数 / Input for runApprovedTool */
export interface RunApprovedToolInput {
  workspace: string;
  request: PendingToolRequest;
  shellExecutor?: ShellExecutor;
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  authorization?: ThreadAuthorizationState | null;
  approvedGrant?: ShellGrantUsed;
  threadId?: string;
  override?: AuthorizationOverride;
  mcpManager?: McpManager;
  mcpRiskOverride?: Record<string, "read">;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
}

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function runApprovedTool(
  input: RunApprovedToolInput,
): Promise<ToolExecutionResult> {
  const {
    workspace,
    request,
    shellExecutor,
    workspaceAccess = "write",
    phase = defaultPhaseForWorkspaceAccess(workspaceAccess),
    authorization = null,
    approvedGrant = "none",
    threadId = "",
    override,
    mcpManager,
    mcpRiskOverride,
    skillManifests,
    skillOptions,
    signal,
  } = input;
  const policy = evaluateToolPolicy({
    request,
    workspaceAccess,
    phase,
    workspace,
    threadId,
    authorization: normalizeAuthorizationState(authorization),
    override,
    mcpRiskOverride,
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

  if (request.name === "read_mcp_resource") {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${request.args.server ?? ""}`,
        exitCode: -1,
        stdout: "",
        stderr: "MCP manager is not available. No MCP servers are configured.",
      });
    }
    const { server, uri } = request.args;
    if (!server || !uri) {
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${server ?? ""}`,
        exitCode: -1,
        stdout: "",
        stderr: "server and uri are required",
      });
    }
    try {
      const content = await mcpManager.readResource(server, uri);
      return withFailureGuidance(request, {
        ok: true,
        command: `read_mcp_resource ${server}`,
        exitCode: 0,
        stdout: content,
        stderr: "",
      });
    } catch (err) {
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${server}`,
        exitCode: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (request.name === "Skill") {
    if (!skillManifests || !skillOptions) {
      return withFailureGuidance(request, {
        ok: false,
        command: "Skill",
        exitCode: -1,
        stdout: "",
        stderr: "Skills system not configured. No skill manifests available.",
      });
    }
    const skillName = request.args.skill as string;
    if (!skillName) {
      return withFailureGuidance(request, {
        ok: false,
        command: "Skill",
        exitCode: -1,
        stdout: "",
        stderr: "Skill name is required.",
      });
    }
    const result = getSkillContent(skillManifests, skillName, skillOptions);
    if (!result) {
      return withFailureGuidance(request, {
        ok: false,
        command: "Skill",
        exitCode: -1,
        stdout: "",
        stderr: `Skill not found: ${skillName}`,
      });
    }
    const important = extractSkillImportant(result.content);
    return withFailureGuidance(request, {
      ok: true,
      command: `Skill ${skillName}`,
      exitCode: 0,
      stdout: `Skill loaded: ${result.name}\n\n${result.content}`,
      stderr: "",
      ...(important ? { activeSkillInstructions: important } : {}),
    });
  }

  if (request.name.startsWith("mcp__")) {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: "",
        stderr: "MCP manager is not available. No MCP servers are configured.",
      });
    }
    const parsed = parseMcpToolName(request.name);
    const serverName = parsed?.serverName ?? "";
    const toolName = parsed?.toolName ?? "";
    if (!serverName || !toolName) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: "",
        stderr: `Invalid MCP tool name format: ${request.name}. Expected mcp__<server>__<tool>.`,
      });
    }
    try {
      const output = await mcpManager.callTool(serverName, toolName, request.args as unknown as Record<string, unknown>);
      return withFailureGuidance(request, {
        ok: true,
        command: request.name,
        exitCode: 0,
        stdout: output,
        stderr: "",
      });
    } catch (err) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (request.name === "shell_execute") {
    const result = await runShellForTool(workspace, request.args.command, shellExecutor, signal);
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
  signal?: AbortSignal,
): Promise<ShellResult> {
  try {
    return await (shellExecutor ?? shellTool)({ workspace, command, signal });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      command,
      exitCode: isAbort ? 130 : -1,
      stdout: "",
      stderr: isAbort ? "Command cancelled by user." : (error instanceof Error ? error.message : String(error)),
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
      return "Use shell_execute with a concrete command and action metadata. Set intent to inspect for read-only checks such as rg, ls, cat, or git status; set intent to verify for tests, typecheck, build, lint, or smoke checks. Provide description to explain what the command does. Include grant_request for commands needing approval.";
    case "update_plan":
      return "Use update_plan with a complete plan object: name, description, status, and ordered steps with statuses. It must only update planning state and must not mutate the workspace.";
    case "ask_user":
      return "Use ask_user only when progress is blocked by a focused clarification. Provide one concise question, concrete options, and allow free text when appropriate; the user_input node handles the interrupt.";
    case "Skill":
      return "Use Skill with the name of a skill from the Available Skills list. The skill name must exactly match. Only use skills listed in the system prompt under Available Skills.";
    default:
      return "";
  }
}

/** 从 Skill 内容中提取 <EXTREMELY-IMPORTANT> 标签文本，注入 runtime context / Extract <EXTREMELY-IMPORTANT> content from skill body for runtime context injection */
function extractSkillImportant(content: string): string | null {
  const match = content.match(/<EXTREMELY-IMPORTANT>([\s\S]*?)<\/EXTREMELY-IMPORTANT>/);
  return match ? match[1].trim() : null;
}
