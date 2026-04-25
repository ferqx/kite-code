import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { loadAgentConfig } from "../src/config";
import { resumeCodeAgent, streamCodeAgent } from "../src/runner";
import { shellTool } from "../src/tools";
import type { AgentConfig } from "../src/config";
import type { ShellInput, ShellResult } from "../src/types";
import type { AgentEvent } from "../src/types";

interface ContinueInput {
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

// 真实 DeepSeek API 端到端测试 —— 需要本地配置可用的 DeepSeek API 连接 / Real DeepSeek API end-to-end tests — requires a working DeepSeek API connection configured locally
describe("real DeepSeek LangGraph code agent", () => {
  // 验证 agent 能直接回答关于其模型和上下文的元问题，无需触发工具审批流程 / Verify agent answers meta questions about its model and context directly without tool approval
  test(
    "answers model and context questions directly without tool approval",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-direct-answer-agent");

      const events: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: "你当前是什么模型？上下文有多长",
        ...env,
      })) {
        events.push(event);
        if (event.type === "interrupt" || event.type === "final") {
          break;
        }
      }

      // 直接回答不应触发工具审批 / Direct answer should not trigger tool approval
      expect(JSON.stringify(events)).not.toContain("tool_approval");
      const final = events.find((event) => event.type === "final");
      // 返回结果应包含当前使用的模型名称 / Response should contain the model name being used
      expect(String(final?.data)).toContain(env.config.modelName);
      // 返回结果应包含中文"上下文"关键词 / Response should contain the Chinese keyword "上下文"
      expect(String(final?.data)).toContain("上下文");
    },
    120_000,
  );

  // 验证 /plan 命令完整流程：生成计划 → 阻止编辑 → 确认后切换到 builder 模式并执行 / Verify /plan command full flow: produce plan → block edits → confirm and switch to builder mode to execute
  test(
    "/plan produces a plan, blocks edits, and confirmation switches to builder mode",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-plan-mode-agent");
      const fileName = "plan-mode-output.txt";
      const fileContent = "plan mode should not edit before confirmation";

      const planEvents = [];
      for await (const event of streamCodeAgent({
        task: `/plan Create ${fileName} with exact content "${fileContent}".`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") {
          break;
        }
      }

      // 检查中断事件包含模式确认信息 / Verify interrupt event contains mode confirmation
      const modeInterrupt = planEvents.find((event) => event.type === "interrupt");
      expect(JSON.stringify(modeInterrupt)).toContain("mode_confirmation");
      expect(JSON.stringify(modeInterrupt)).toContain("builder");
      // 计划阶段不应触发任何工具审批（只有只读操作） / Plan stage should not trigger any tool approval (read-only only)
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
      // 计划模式下不应创建任何文件 / No file should be created in plan mode
      expect(existsSync(join(env.workspace, fileName))).toBe(false);

      // 确认计划，切换到 builder 模式继续执行 / Confirm plan and switch to builder mode to continue
      const executeEvents = await continueApproving(env, {
        approved: true,
        nextMode: "builder",
      });

      // builder 模式下应触发工具审批并执行工具调用 / Builder mode should trigger tool approval and execute tool calls
      expect(JSON.stringify(executeEvents)).toContain("tool_approval");
      expect(JSON.stringify(executeEvents)).toContain("tool_call_id");
      // 执行完成后文件应存在且内容正确 / After execution, file should exist with correct content
      expect(existsSync(join(env.workspace, fileName))).toBe(true);
      expect(readFileSync(join(env.workspace, fileName), "utf8")).toContain(fileContent);
    },
    120_000,
  );

  // 验证自然语言描述的规划请求也能生成计划而不编辑文件 / Verify natural-language planning request also produces a plan without editing files
  test(
    "natural-language planning request produces a plan without editing",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-natural-plan-agent");
      const fileName = "natural-plan-output.txt";

      const planEvents = [];
      for await (const event of streamCodeAgent({
        task: `Plan first and do not edit files yet. Later create ${fileName}.`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") {
          break;
        }
      }

      // 检查中断事件包含模式确认 / Verify interrupt event contains mode confirmation
      const modeInterrupt = planEvents.find((event) => event.type === "interrupt");
      expect(JSON.stringify(modeInterrupt)).toContain("mode_confirmation");
      // 自然语言规划阶段不应触发工具审批 / Natural-language planning stage should not trigger tool approval
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
      // 文件在规划阶段不应被创建 / File should not be created during planning stage
      expect(existsSync(join(env.workspace, fileName))).toBe(false);
    },
    120_000,
  );

  // 验证 builder 模式运行完整的 ReAct 工具循环（审批 → 执行 → 写文件），并持久化 checkpoint 到 SQLite / Verify builder mode runs full ReAct tool loop (approve → execute → write file) and persists checkpoint to SQLite
  test(
    "builder mode runs a ReAct tool loop with persisted checkpoints",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-react-agent");
      const fileName = "agent-output.txt";
      const fileContent = "hello from real deepseek langgraph agent";

      const startEvents = [];
      for await (const event of streamCodeAgent({
        task: `Create ${fileName} with exact content "${fileContent}".`,
        ...env,
      })) {
        startEvents.push(event);
        if (event.type === "interrupt") {
          break;
        }
      }

      // builder 模式下应触发工具审批 / Builder mode should trigger tool approval
      expect(JSON.stringify(startEvents)).toContain("tool_approval");

      // 审批通过后继续执行 / Continue execution after approval
      const resumedEvents = await continueApproving(env, { approved: true });

      // 检查工具调用已执行（出现 tool_call_id）/ Verify tool call was executed (tool_call_id present)
      expect(JSON.stringify(resumedEvents)).toContain("tool_call_id");
      // 检查输出文件已创建且内容正确 / Verify output file created with correct content
      expect(existsSync(join(env.workspace, fileName))).toBe(true);
      expect(readFileSync(join(env.workspace, fileName), "utf8")).toContain(fileContent);
      // 检查 checkpoint SQLite 文件已持久化 / Verify checkpoint SQLite file was persisted
      expect(existsSync(env.checkpointPath)).toBe(true);
    },
    120_000,
  );
});

// 创建真实端到端测试环境：工作目录、checkpoint 路径、配置等 / Create real end-to-end test environment: workspace, checkpoint path, config, etc.
function createRealTestEnv(name: string): ContinueInput & { task?: string } {
  const root = join(tmpdir(), name);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  return {
    userId: `${name}-user`,
    threadId: `${name}-thread`,
    workspace,
    checkpointPath: join(dataDir, "checkpoints.sqlite"),
    config: loadAgentConfig(),
    shellExecutor: createTestShellExecutor(),
  };
}

// 持续审批恢复的循环辅助函数，最多迭代 12 次，直到收到 final 事件 / Continuously approve and resume loop helper, max 12 iterations until final event received
async function continueApproving(
  input: ContinueInput,
  initialResume: { approved?: boolean; nextMode?: "builder" } = { approved: true },
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resume = initialResume;

  for (let i = 0; i < 12; i++) {
    let interrupted = false;
    for await (const event of resumeCodeAgent({
      ...input,
      resume,
    })) {
      events.push(event);
      if (event.type === "final") {
        return events;
      }
      if (event.type === "interrupt") {
        interrupted = true;
        break;
      }
    }
    if (!interrupted) {
      return events;
    }
    resume = { approved: true };
  }

  return events;
}

// 创建测试用 shell 执行器，拦截常见的文件写入/读取命令模式（Bun、PowerShell、echo redirect 等）/ Create test shell executor that intercepts common file write/read command patterns (Bun, PowerShell, echo redirect, etc.)
function createTestShellExecutor() {
  return async (input: ShellInput): Promise<ShellResult> => {
    const bunWrite = parseBunWriteCommand(input.command);
    if (bunWrite) {
      mkdirSync(dirname(bunWrite.path), { recursive: true });
      await Bun.write(bunWrite.path, bunWrite.content);
    }
    const encoded = input.command.match(/\$encoded = '([^']+)'/)?.[1];
    const path = input.command.match(/Set-Content -LiteralPath '((?:''|[^'])+)'/)?.[1];
    if (encoded && path) {
      const target = path.replaceAll("''", "'");
      const content = Buffer.from(encoded, "base64").toString("utf8");
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
    const plainWrite = parsePlainWriteCommand(input.command);
    if (plainWrite) {
      const target = join(input.workspace, plainWrite.path.split(/[\\/]/).pop() ?? plainWrite.path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, plainWrite.content);
    }
    const readMatch =
      input.command.match(/Get-Content\s+"?([^"\s]+)"?(?:\s+-Raw)?/i) ??
      input.command.match(/cat\s+([^"\s]+)/i) ??
      input.command.match(/type\s+([^"\s]+)/i);
    if (readMatch) {
      const target = isAbsolute(readMatch[1]) ? readMatch[1] : join(input.workspace, readMatch[1]);
      return {
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: existsSync(target) ? readFileSync(target, "utf8") : "",
        stderr: "",
      };
    }

    return shellTool(input);
  };
}

function parseBunWriteCommand(command: string): { path: string; content: string } | null {
  if (!command.includes("fs.writeFileSync")) {
    return null;
  }
  const args = command.match(/'((?:'\\''|[^'])*)'/g)?.map((arg) =>
    unescapePosixShellArg(arg.slice(1, -1)),
  ) ?? [];
  const encoded = args.at(-1);
  const path = args.at(-2);
  if (!path || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return null;
  }

  return {
    path,
    content: Buffer.from(encoded, "base64").toString("utf8"),
  };
}

function unescapePosixShellArg(value: string): string {
  return value.replaceAll("'\\''", "'");
}

function parsePlainWriteCommand(command: string): { path: string; content: string } | null {
  const setContent = command.match(
    /Set-Content\s+(?:-(?:LiteralPath|Path)\s+)?["']?([^"'\s]+)["']?\s+-Value\s+["']([^"']*)["']/i,
  );
  if (setContent) {
    return { path: setContent[1], content: setContent[2] };
  }

  const writeAllText = command.match(
    /\[System\.IO\.File\]::WriteAllText\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/i,
  );
  if (writeAllText) {
    return { path: writeAllText[1], content: writeAllText[2] };
  }

  const redirect = command.match(/echo\s+["']([^"']*)["']\s*>\s*["']?([^"'\s]+)["']?/i);
  if (redirect) {
    return { path: redirect[2], content: redirect[1] };
  }

  return null;
}
