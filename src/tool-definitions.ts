import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { shellTool, type ShellExecutor } from "./tools";
import {
  readFile,
  editFile,
  writeFile,
  search,
} from "./file-tools";

/** 创建代码 Agent 工具集输入 / Input for creating code agent tools */
export interface CreateCodeAgentToolsInput {
  /** 工作目录 / Workspace directory */
  workspace: string;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
}

/** 创建 builder 模式的工具集（read_file, edit_file, write_file, search, shell_execute, update_plan） */
export function createCodeAgentTools(input: CreateCodeAgentToolsInput) {
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

  const searchTool = tool(
    async ({ pattern, path, context_lines, case_sensitive, max_results }) =>
      JSON.stringify(
        await search({
          workspace: input.workspace,
          pattern,
          globPath: path,
          contextLines: context_lines,
          caseSensitive: case_sensitive,
          maxResults: max_results,
        }),
      ),
    {
      name: "search",
      description:
        "Search for a pattern in workspace files. Use this to find function definitions, variable usages, imports, or any text pattern. Returns matching lines with file paths and line numbers. Supports regex patterns wrapped in / /.",
      schema: z.object({
        pattern: z.string().describe("Text or regex pattern to search for. Use /pattern/flags for regex (e.g. '/function\\s+\\w+/')"),
        path: z.string().optional().describe("Glob pattern to filter files (e.g. 'src/**/*.ts', default: all source files)"),
        context_lines: z.number().optional().describe("Number of context lines around each match (default: 0)"),
        case_sensitive: z.boolean().optional().describe("Case sensitive search (default: false)"),
        max_results: z.number().optional().describe("Maximum number of results (default: 50)"),
      }),
    },
  );

  const shellExecute = tool(
    async ({ command }) =>
      JSON.stringify(
        await shellTool({
          workspace: input.workspace,
          command,
        }),
      ),
    {
      name: "shell_execute",
      description:
        "Execute a platform shell command in the local workspace. Use this for reading, deleting, listing, testing, and running local commands. Commands are reviewed before execution.",
      schema: z.object({
        command: z.string().describe("Shell command to execute in the workspace"),
      }),
    },
  );

  return [readFileTool, editFileTool, writeFileTool, searchTool, shellExecute, createUpdatePlanTool()];
}

/** 创建 plan 模式的工具集（shell_read, update_plan）/ Create plan mode tool set (read-only: shell_read, update_plan) */
export function createPlanAgentTools(input: CreateCodeAgentToolsInput) {
  const shellRead = tool(
    async ({ command }) => {
      // 拒绝非只读命令 / Reject non-read-only commands
      if (!isPlanReadOnlyShellCommand(command)) {
        return JSON.stringify({
          ok: false,
          command,
          exitCode: -1,
          stdout: "",
          stderr: "Rejected: plan mode allows read-only shell commands only.",
        });
      }

      return JSON.stringify(
        await (input.shellExecutor ?? shellTool)({
          workspace: input.workspace,
          command,
        }),
      );
    },
    {
      name: "shell_read",
      description:
        "Read-only shell command for plan mode. Use it only to inspect files, list directories, search text, and read git status/diff/log/show. It must not write, delete, run tests, install dependencies, or execute project code.",
      schema: z.object({
        command: z.string().describe("Read-only shell command to execute in the workspace"),
      }),
    },
  );

  return [shellRead, createUpdatePlanTool()];
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
        "Update the current plan state. In plan mode use it to create or revise a concise implementation plan; it must not edit files, run commands, install dependencies, or mutate the workspace.",
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

/** Plan 模式允许的只读命令白名单 / Read-only command allowlist for plan mode */
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

/** Plan 模式允许的 Git 只读子命令白名单 / Read-only git subcommand allowlist for plan mode */
const PLAN_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "show",
  "status",
]);

/** 检查命令是否在 plan 模式只读白名单中 / Check if command is in plan mode read-only allowlist */
export function isPlanReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  // 拒绝对空命令和包含输出重定向的命令 / Reject empty commands and commands with output redirection
  if (!trimmed || /(^|[^>])>{1,2}($|[^>])/.test(trimmed)) {
    return false;
  }

  // 拆分为多个命令段并逐一检查 / Split into multiple command segments and check each one
  return splitShellSegments(trimmed).every(isPlanReadOnlySegment);
}

/** 将 Shell 命令按分隔符拆分为多个段 / Split shell command into segments by separators */
function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 检查单个命令段是否为 plan 模式允许的只读命令 / Check if individual command segment is plan mode read-only */
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
