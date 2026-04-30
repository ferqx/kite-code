import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { shellTool, type ShellExecutor } from "./shell";
import {
  readFile,
  editFile,
  writeFile,
} from "./file";

/** 创建 Agent 工具集输入 / Input for creating agent tools */
export interface CreateAgentToolsInput {
  /** 工作目录 / Workspace directory */
  workspace: string;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
}

/** 创建 Agent 工具集（跨工作区访问权限保持 schema 稳定，由工具执行层强制边界） */
export function createAgentTools(input: CreateAgentToolsInput) {
  const readFileTool = tool(
    async ({ path, offset, limit }) =>
      JSON.stringify(
        readFile({ workspace: input.workspace, path, offset, limit }),
      ),
    {
      name: "read_file",
      description:
        "Read a file from the workspace. Returns the file content with line numbers. Use this BEFORE edit_file to see the current content and pick precise old_string values.",
      schema: z.object({
        path: z.string().describe("Relative path to the file"),
        offset: z.number().optional().describe("Starting line number (1-indexed, default 1)"),
        limit: z.number().optional().describe("Maximum number of lines to read"),
      }),
    },
  );

  const editFileTool = tool(
    async ({ path, old_string, new_string, replace_all }) =>
      JSON.stringify(
        editFile({
          workspace: input.workspace,
          path,
          oldString: old_string,
          newString: new_string,
          replaceAll: replace_all,
        }),
      ),
    {
      name: "edit_file",
      description:
        "Edit a file by replacing old_string with new_string. Use read_file first to get the exact text to replace. The old_string MUST exactly match the file content — include all whitespace, indentation, and surrounding lines for uniqueness. If the same text appears multiple times, set replace_all: true or make old_string longer to be unique.",
      schema: z.object({
        path: z.string().describe("Relative path to the file to edit"),
        old_string: z.string().describe("The exact text to replace. Must match the file content exactly, including whitespace."),
        new_string: z.string().describe("The new text to replace old_string with"),
        replace_all: z.boolean().optional().describe("Replace all occurrences (default: false, fails if multiple matches found)"),
      }),
    },
  );

  const writeFileTool = tool(
    async ({ path, content }) =>
      JSON.stringify(
        writeFile({ workspace: input.workspace, path, content }),
      ),
    {
      name: "write_file",
      description:
        "Create a new file or overwrite an existing file with new content. Use this for creating new files or completely rewriting existing files. For editing existing files, prefer edit_file.",
      schema: z.object({
        path: z.string().describe("Relative path to the file"),
        content: z.string().describe("Complete file content to write"),
      }),
    },
  );

  const shellExecute = tool(
    async ({ command }) =>
      JSON.stringify(
        await (input.shellExecutor ?? shellTool)({
          workspace: input.workspace,
          command,
        }),
      ),
    {
      name: "shell_execute",
      description:
        "Execute a shell command action envelope in the local workspace. Use intent='verify' for tests, typecheck, build, lint, or smoke checks. Provide objective, justification, expected_observation, failure_strategy, and optional grant_request when they help the user review the command. Commands are reviewed by the harness before execution.",
      schema: z.object({
        command: z.string().describe("Shell command to execute in the workspace"),
        intent: z
          .enum(["inspect", "verify", "build", "test", "git", "other"])
          .optional()
          .describe("Command intent"),
        objective: z.string().optional().describe("What this command should accomplish"),
        justification: z.string().optional().describe("Why this command is needed"),
        expected_observation: z
          .string()
          .optional()
          .describe("Expected stdout/stderr or observable result"),
        failure_strategy: z
          .string()
          .optional()
          .describe("How to proceed if the command fails"),
        prefix_rule: z
          .array(z.string())
          .optional()
          .describe("Suggested future prefix grant rule for audit only"),
        grant_request: z
          .enum(["approve_once", "same_command", "full_access"])
          .optional()
          .describe("Suggested approval grant; the user resume payload decides the actual grant"),
      }),
    },
  );

  return [
    readFileTool,
    editFileTool,
    writeFileTool,
    shellExecute,
    createUpdatePlanTool(),
    createAskUserTool(),
  ];
}

/** 兼容旧名称：创建代码 Agent 工具集 / Backward-compatible alias for agent tools */
export function createCodeAgentTools(input: CreateAgentToolsInput) {
  return createAgentTools(input);
}

/** 兼容旧名称：创建计划 Agent 工具集 / Backward-compatible alias for agent tools */
export function createPlanAgentTools(input: CreateAgentToolsInput) {
  return createAgentTools(input);
}

/** 创建 update_plan 工具定义，用于创建或更新执行计划 / Create update_plan tool definition for creating/updating execution plans */
function createUpdatePlanTool() {
  return tool(
    async ({ name, description, status, steps }) =>
      JSON.stringify({
        ok: true,
        plan: {
          name,
          description,
          status,
          steps,
        },
      }),
    {
      name: "update_plan",
      description:
        "Update the current plan state with concise ordered steps. Use it when planning or progress tracking materially helps; it must not edit files, run commands, install dependencies, or mutate the workspace.",
      schema: z.object({
        name: z.string().describe("Short plan name"),
        description: z.string().describe("Short plan description"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Current status for the plan"),
        steps: z
          .array(
            z.object({
              step: z.string().describe("Plan step"),
              status: z
                .enum(["pending", "in_progress", "completed"])
                .describe("Current status for this step"),
            }),
          )
          .describe("Ordered plan steps"),
      }),
    },
  );
}

/** 创建 ask_user 工具定义，用于规划时向用户澄清关键不确定性 / Create ask_user tool definition for user clarification */
function createAskUserTool() {
  return tool(
    async ({ question, options, allow_free_text, context }) =>
      JSON.stringify({
        ok: false,
        question,
        options,
        allow_free_text: allow_free_text ?? true,
        context,
        stderr: "ask_user is handled by the harness as a user_input interrupt.",
      }),
    {
      name: "ask_user",
      description:
        "Ask the user one focused clarification question when planning is blocked by meaningful uncertainty. Provide concrete options and allow free-text input when appropriate.",
      schema: z.object({
        question: z
          .string()
          .min(1)
          .describe("One concise question for the user to answer"),
        options: z
          .array(
            z.object({
              id: z
                .string()
                .optional()
                .describe("Stable option id, e.g. 'minimal' or 'full'"),
              label: z.string().min(1).describe("User-facing option label"),
              description: z
                .string()
                .optional()
                .describe("Short explanation of the trade-off for this option"),
            }),
          )
          .min(1)
          .describe("Suggested answer options for the user"),
        allow_free_text: z
          .boolean()
          .optional()
          .describe("Whether the user may type a custom answer; default true"),
        context: z
          .string()
          .optional()
          .describe("Short context explaining why this clarification is needed"),
      }),
    },
  );
}

/** shell_execute inspect 允许直通的只读命令白名单 / Read-only command allowlist for shell_execute inspect */
const PLAN_READ_ONLY_COMMANDS = new Set([
  "awk",
  "cat",
  "du",
  "file",
  "find",
  "gc",
  "gci",
  "get-childitem",
  "get-content",
  "get-location",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "select-object",
  "select-string",
  "sed",
  "sls",
  "stat",
  "tail",
  "test",
  "type",
  "wc",
]);

/** shell_execute inspect 允许直通的 Git 只读子命令白名单 / Read-only git subcommand allowlist for shell_execute inspect */
const PLAN_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "show",
  "status",
]);

/** 检查命令是否可作为 shell_execute inspect 直通 / Check if command can bypass approval as shell_execute inspect */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  // 拒绝对空命令和包含输出重定向的命令 / Reject empty commands and commands with output redirection
  if (!trimmed || /(^|[^>])>{1,2}($|[^>])/.test(trimmed)) {
    return false;
  }

  // 拆分为多个命令段并逐一检查 / Split into multiple command segments and check each one
  return splitShellSegments(trimmed).every(isPlanReadOnlySegment);
}

/** 兼容旧名称 / Backward-compatible alias */
export const isPlanReadOnlyShellCommand = isReadOnlyShellCommand;

/** 将 Shell 命令按分隔符拆分为多个段 / Split shell command into segments by separators */
function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 检查单个命令段是否为允许直通的只读命令 / Check if individual segment is read-only */
function isPlanReadOnlySegment(segment: string): boolean {
  // 将命令段解析为 token 数组，支持引号 / Parse segment into token array, supporting quotes
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  // 第一个 token 为命令名，去除引号后转小写 / First token is the command name, strip quotes and lower-case
  const command = stripQuotes(tokens[0] ?? "").toLowerCase();
  if (!command) {
    return false;
  }

  // git 命令需额外检查子命令白名单 / Git command requires additional subcommand allowlist check
  if (command === "git") {
    return PLAN_READ_ONLY_GIT_SUBCOMMANDS.has(stripQuotes(tokens[1] ?? "").toLowerCase());
  }

  // sed 命令禁止 -i 原地编辑标志 / sed command forbids -i in-place edit flag
  if (command === "sed") {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => /^-.*i/.test(stripQuotes(token)))
    );
  }

  // find 命令禁止 -exec、-execdir、-delete 等危险选项 / find command forbids dangerous options: -exec, -execdir, -delete
  if (command === "find") {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => ["-exec", "-execdir", "-delete"].includes(stripQuotes(token)))
    );
  }

  // awk 命令禁止 system() 调用 / awk command forbids system() call
  if (command === "awk") {
    return PLAN_READ_ONLY_COMMANDS.has(command) && !/\bsystem\s*\(/.test(segment);
  }

  return PLAN_READ_ONLY_COMMANDS.has(command);
}

/** 去除字符串首尾引号 / Strip surrounding quotes from string */
function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
