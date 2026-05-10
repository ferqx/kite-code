import { join, resolve } from "node:path";
import { loadAgentConfig } from "../config/index";
import { createSandboxExecutor } from "../sandbox/index";
import { resumeCodeAgent, streamCodeAgent } from "./runner";
import type { AuthorizationOverride, ShellApprovalGrant, WorkspaceAccessRequest } from "../shared/types";

/** CLI 解析后的参数 / CLI parsed arguments */
export interface ParsedArgs {
  /** 命令（run/resume/help）/ Command */
  command: "run" | "resume" | "help";
  /** 任务文本 / Task text */
  task?: string;
  /** 线程 ID / Thread ID */
  threadId: string;
  /** 用户 ID / User ID */
  userId: string;
  /** 工作目录路径 / Workspace path */
  workspace: string;
  /** Checkpoint 路径 / Checkpoint path */
  checkpointPath: string;
  /** 兼容 mode 参数或工作区访问请求 / Compatible mode argument or workspace access request */
  mode: WorkspaceAccessRequest;
  /** 授权模式 / Authorization mode */
  authorizationMode?: "default" | "full_access";
  /** 恢复时是否审批通过 / Whether approved on resume */
  approve: boolean;
  /** 用户选择的 shell 授权粒度 / User-selected shell approval grant */
  approvalGrant?: ShellApprovalGrant;
  /** 审批请求 hash / Approval request hash */
  approvalHash?: string;
  /** 替换后审批执行的命令 / Replacement command to approve */
  replacementCommand?: string;
  /** 恢复 ask_user 中断时传入的用户回答 / User answer for ask_user interrupt resume */
  answer?: string;
  /** 是否启用沙箱（默认 true）/ Whether sandbox is enabled (default true) */
  sandbox: boolean;
}

/** CLI 入口函数 / CLI entry point */
export async function main(): Promise<void> {
  // 解析命令行参数 / Parse command line arguments
  const args = parseArgs(process.argv.slice(2));
  // 帮助命令直接打印并返回 / Print help and return for help command
  if (args.command === "help") {
    printHelp();
    return;
  }

  // 加载 Agent 配置 / Load agent configuration
  const config = loadAgentConfig();
  // 创建沙箱 Shell 执行器 / Create sandboxed shell executor
  const shellExecutor = createSandboxExecutor({
    enabled: args.sandbox,
    workspace: args.workspace,
  });

  // 创建授权覆盖 / Create authorization override
  const authorizationOverride: AuthorizationOverride | undefined =
    args.authorizationMode !== undefined
      ? { current: args.authorizationMode }
      : undefined;

  // 根据命令类型发起流 / Start stream based on command type
  const events =
    args.command === "run"
      ? streamCodeAgent({
          task: args.task ?? "",
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          mode: args.mode,
          shellExecutor,
          authorizationOverride,
        })
      : resumeCodeAgent({
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          shellExecutor,
          authorizationOverride,
          resume:
            args.answer === undefined
              ? {
                  approved: args.approve,
                  grant: args.approvalGrant,
                  approvalHash: args.approvalHash,
                  replacementCommand: args.replacementCommand,
                }
              : { answer: args.answer },
        });

  // 逐行输出事件 JSON / Output events as JSON lines
  for await (const event of events) {
    console.log(JSON.stringify(event));
  }
}

/** 解析命令行参数 / Parse command line arguments */
export function parseArgs(argv: string[]): ParsedArgs {
  // 确定命令类型 / Determine command type
  const command = argv[0] === "resume" ? "resume" : argv[0] === "run" ? "run" : "help";
  // 获取当前工作目录 / Get current working directory
  const cwd = process.cwd();
  // 辅助函数：提取选项值 / Helper: extract option value
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const optionalValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? "" : undefined;
  };
  const noSandbox = argv.includes("--no-sandbox");
  const explicitThread = value("--thread", "");
  const mode = parseMode(value("--mode", "auto"));
  const authorizationMode = parseAuthorizationMode(
    optionalValue("--authorization-mode") ?? "",
  );
  const answer = optionalValue("--answer");
  const approvalHash = optionalValue("--approval-hash");
  const replacementCommand = optionalValue("--replace-command");
  const approvalGrant = parseApprovalGrant(argv);

  return {
    command,
    task: command === "run" ? value("--task", positionalTask(argv)) : "",
    threadId: explicitThread || (command === "run" ? freshThreadId() : "default-thread"),
    userId: value("--user", "default-user"),
    workspace: resolve(value("--workspace", cwd)),
    checkpointPath: resolve(
      value("--checkpoints", join(cwd, ".openpx", "checkpoints.sqlite")),
    ),
    mode,
    authorizationMode,
    approve: approvalGrant !== undefined,
    approvalGrant,
    approvalHash,
    replacementCommand,
    answer,
    sandbox: !noSandbox,
  };
}

/** 解析审批授权粒度；--approve 保持 approve_once 兼容语义 / Parse approval grant flags */
function parseApprovalGrant(argv: string[]): ShellApprovalGrant | undefined {
  if (argv.includes("--full-access")) {
    return "full_access";
  }
  if (argv.includes("--approve-same-command")) {
    return "same_command";
  }
  if (argv.includes("--approve")) {
    return "approve_once";
  }
  return undefined;
}

/** 提取非选项参数拼接为任务文本 / Extract non-option args as task text */
function positionalTask(argv: string[]): string {
  if (argv[0] !== "run") {
    return "";
  }

  // 需要值的选项名称集合 / Set of option names that require values
  const optionNamesWithValues = new Set([
    "--task",
    "--thread",
    "--user",
    "--workspace",
    "--checkpoints",
    "--mode",
    "--answer",
    "--approval-hash",
    "--replace-command",
  ]);
  const parts: string[] = [];
  // 收集非选项位置参数 / Collect non-option positional args
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (optionNamesWithValues.has(item)) {
      index++;
      continue;
    }
    if (item.startsWith("--")) {
      continue;
    }
    parts.push(item);
  }
  return parts.join(" ").trim();
}

/** 解析访问权限参数，保留 plan/builder 兼容值 / Parse access argument, preserving legacy plan/builder values */
function parseMode(value: string): WorkspaceAccessRequest {
  if (
    value === "read-only" ||
    value === "write" ||
    value === "plan" ||
    value === "builder"
  ) {
    return value;
  }
  return "auto";
}

/** 解析授权模式参数 / Parse authorization mode argument */
function parseAuthorizationMode(value: string): "default" | "full_access" | undefined {
  if (value === "full_access" || value === "full-access") {
    return "full_access";
  }
  if (value === "default") {
    return "default";
  }
  return undefined;
}

/** 生成新线程 ID / Generate fresh thread ID */
function freshThreadId(): string {
  // 生成包含时间戳和随机数的线程 ID / Generate thread ID with timestamp and random part
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 打印帮助信息 / Print help information */
function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt with exact content \\"hi\\""
  bun run agent resume --thread default-thread --approve

Options:
  --task <text>          Task for run
  --thread <id>          LangGraph thread id
  --user <id>            User id for the run
  --workspace <path>     Tool workspace
  --checkpoints <path>   SQLite checkpoint path
  --mode <mode>          auto, read-only, write, plan, or builder
  --approve              Resume a tool approval interrupt with approval
  --approve-same-command Approve current command and future exact same shell command in this thread
  --full-access          Allow all future shell_execute commands in this thread
  --approval-hash <hash> Approval hash from the tool_approval interrupt
  --replace-command <cmd> Replace the pending command and approve that command
  --answer <text>        Resume a user input interrupt with an answer
  --authorization-mode <mode>  default or full-access; set initial authorization mode for the thread
  --no-sandbox           Disable sandbox isolation (for debugging)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
