import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { shellTool, type ShellExecutor } from "./shell";
import {
  readFile,
  editFile,
  writeFile,
} from "./file";
import {
  READ_FILE_CONTRACT,
  EDIT_FILE_CONTRACT,
  WRITE_FILE_CONTRACT,
  SHELL_EXECUTE_CONTRACT,
  READ_MCP_RESOURCE_CONTRACT,
  UPDATE_PLAN_CONTRACT,
  ASK_USER_CONTRACT,
  SET_AUTHORIZATION_MODE_CONTRACT,
} from "./tool-contracts";
import { adaptMcpTool } from "@/core/mcp/tool-adapter";
import { createSkillTool } from "@/core/skills/skill-tool";
import { createTaskTool } from "@/core/subagent/task-tool";
import type { SupportedChatModel } from "@/core/model/factory";

/** 创建 Agent 工具集输入 / Input for creating agent tools */
export interface CreateAgentToolsInput {
  /** 工作目录 / Workspace directory */
  workspace: string;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
  /** 可选 MCP 管理器 / Optional MCP manager */
  mcpManager?: import("@/core/mcp/manager").McpManager;
  /** 可选技能清单 / Optional skill manifests */
  skills?: import("@/core/skills/types").SkillManifest[];
  /** 可选技能扫描选项 / Optional skill scan options */
  skillOptions?: import("@/core/skills/types").SkillScanOptions;
  /** Agent 配置（task 工具创建模型实例时需要） */
  config?: import("@/core/config/index").AgentConfig;
  /** 子 agent 事件回调（用于 task 工具） */
  subagentEventSink?: import("@/core/subagent/types").SubAgentEventSink;
  /** 外部中止信号（用于 task 工具） */
  subagentSignal?: AbortSignal;
  /** 可选自定义模型实例（用于 E2E mock 注入）/ Optional custom model instance (for E2E mock injection) */
  model?: SupportedChatModel;
}
let _cachedKey: string | null = null;
let _cachedTools: ReturnType<typeof createAgentTools> | null = null;

/** 创建 Agent 工具集（跨工作区访问权限保持 schema 稳定，由工具执行层强制边界） */
export function createAgentTools(input: CreateAgentToolsInput) {
  // 缓存：同一个 agent 迭代中参数不变时避免重建全部工具（包括 MCP 适配）
  const cacheKey = `${input.workspace}|${!!input.shellExecutor}|${!!input.mcpManager}|${input.skills?.length ?? 0}`;
  if (cacheKey === _cachedKey && _cachedTools) return _cachedTools;
  const readFileTool = tool(
    async ({ path, offset, limit }) =>
      JSON.stringify(
        readFile({ workspace: input.workspace, path, offset, limit }),
      ),
    {
      name: "read_file",
      description: READ_FILE_CONTRACT.description,
      schema: z.object({
        path: z.string().describe("Path to the file (relative to workspace, or absolute)"),
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
      description: EDIT_FILE_CONTRACT.description,
      schema: z.object({
        path: z.string().describe("Path to the file to edit (relative to workspace, or absolute)"),
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
      description: WRITE_FILE_CONTRACT.description,
      schema: z.object({
        path: z.string().describe("Path to the file (relative to workspace, or absolute)"),
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
      description: SHELL_EXECUTE_CONTRACT.description,
      schema: z.object({
        command: z.string().describe("Shell command to execute in the workspace"),
        description: z.string().optional().describe("Short human-readable description of what this command does (shown to the user)"),
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

  const readMcpResource = tool(
    async ({ server, uri }) => {
      if (!input.mcpManager) {
        return JSON.stringify({
          ok: false,
          stderr: "No MCP manager available. Configure mcpServers in openpx.jsonc.",
        });
      }
      try {
        const content = await input.mcpManager.readResource(server, uri);
        return JSON.stringify({ ok: true, content });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          stderr: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "read_mcp_resource",
      description: READ_MCP_RESOURCE_CONTRACT.description,
      schema: z.object({
        server: z.string().describe("MCP server name"),
        uri: z.string().describe("Resource URI to read (e.g. file:///docs/api.md)"),
      }),
    },
  );

  let skillTool: ReturnType<typeof createSkillTool> | null = null;
  if (input.skills && input.skills.length > 0 && input.skillOptions) {
    skillTool = createSkillTool(input.skills, input.skillOptions);
  }

  const taskTool = input.subagentEventSink && input.config
    ? createTaskTool({
        config: input.config,
        model: input.model,
        workspace: input.workspace,
        shellExecutor: input.shellExecutor,
        mcpManager: input.mcpManager,
        skills: input.skills,
        skillOptions: input.skillOptions,
        eventSink: input.subagentEventSink,
        signal: input.subagentSignal,
      })
    : null;

  const builtinTools = [
    readFileTool,
    editFileTool,
    writeFileTool,
    shellExecute,
    readMcpResource,
    ...(skillTool ? [skillTool] : []),
    ...(taskTool ? [taskTool] : []),
    createUpdatePlanTool(),
    createAskUserTool(),
    createSetAuthorizationModeTool(),
  ];

  // MCP 工具合成
  if (input.mcpManager) {
    const mcpEntries = input.mcpManager.getAllTools();
    const mcpTools = mcpEntries.map(({ server, tool }) =>
      adaptMcpTool(server, tool, input.mcpManager!),
    );
    const all = [...builtinTools, ...mcpTools];
    _cachedKey = cacheKey;
    _cachedTools = all;
    return all;
  }

  _cachedKey = cacheKey;
  _cachedTools = builtinTools;
  return builtinTools;
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
      description: UPDATE_PLAN_CONTRACT.description,
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
      description: ASK_USER_CONTRACT.description,
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

/** 创建 set_authorization_mode 工具定义，用于切换授权模式 / Create set_authorization_mode tool definition */
function createSetAuthorizationModeTool() {
  return tool(
    async ({ mode }) =>
      JSON.stringify({
        ok: true,
        mode,
      }),
    {
      name: "set_authorization_mode",
      description: SET_AUTHORIZATION_MODE_CONTRACT.description,
      schema: z.object({
        mode: z
          .enum(["default", "full_access"])
          .describe("Target authorization mode: 'default' requires confirmation for dangerous tools, 'full_access' executes all tools automatically"),
      }),
    },
  );
}

/** shell_execute inspect 允许直通的只读命令白名单 / Read-only command allowlist for shell_execute inspect */
const PLAN_READ_ONLY_COMMANDS = new Set([
  "awk",
  "cat",
  "du",
  "echo",
  "file",
  "find",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "test",
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
  // 拒绝对空命令和包含文件输出重定向的命令（允许 >&N stderr 重定向到 fd）
  // Reject empty commands and file output redirection; allow >&N stderr-to-fd redirect
  if (!trimmed || /(^|[^>])>{1,2}(?!&[12])(?:$|[^>])/.test(trimmed)) {
    return false;
  }

  // 拒绝命令替换 — $() 和反引号中可能包含写入命令，直通会导致绕过审批
  // Reject command substitution — $() and backticks may contain write commands
  if (/\$\(/.test(trimmed) || /`/.test(trimmed)) {
    return false;
  }

  // 拒绝裸 & 命令分隔符（cmd.exe: cmd1 & cmd2, bash: cmd1 & cmd2）
  // 允许 &&（逻辑与，已按分隔符拆段）、>&N / N>&M（stderr 重定向）
  // Reject bare & command separator; allow && and >&N stderr redirect
  const stripped = trimmed.replace(/&&/g, "").replace(/\d?>&\d?/g, "");
  if (stripped.includes("&")) {
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
