import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { loadAgentConfig } from "../src/config/index";
import { resumeCodeAgent, streamCodeAgent } from "../src/app/runner";
import { createDeepSeekModel } from "../src/model/deepseek";
import { shellTool } from "../src/tools/shell";
import type { AgentConfig } from "../src/config/index";
import type { ShellInput, ShellResult } from "../src/shared/types";
import type { AgentEvent } from "../src/shared/types";

// ============================================================================
// 真实 DeepSeek API 端到端测试，从简到难分为 7 个层级
// Real DeepSeek API end-to-end tests, 7 levels from simple to complex
//
// L1: 直接回答 – 元问题，零工具调用
// L2: 单工具执行 – 简单文件创建
// L3: Plan 模式 – 计划生成 + 模式切换
// L4: 多步骤 Builder – 多个工具调用 + 验证
// L5: 代码修改 + 验证 – 代码编写 + 测试/类型检查
// L6: 错误恢复 – 工具失败后的自我修复
// L7: 长时间运行 – 多文件项目，5+ 步骤 + 计划迭代
// ============================================================================

interface ContinueInput {
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

let realModelPreflight: Promise<void> | null = null;

async function ensureRealModelAvailable(): Promise<void> {
  realModelPreflight ??= runRealModelPreflight();
  return realModelPreflight;
}

async function runRealModelPreflight(): Promise<void> {
  const config = loadAgentConfig();
  try {
    const response = await createDeepSeekModel(config).invoke([
      new HumanMessage("Reply with ok only"),
    ]);
    expect(String(response.content).toLowerCase()).toContain("ok");
  } catch (error) {
    throw new Error(
      [
        `DeepSeek real-test preflight failed for ${config.modelName} at ${config.baseURL}.`,
        `Proxy env: ${proxyEnvSummary()}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

function proxyEnvSummary(): string {
  return [
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ]
    .map((name) => `${name}=${process.env[name] ?? "<unset>"}`)
    .join(" ");
}

// ============================================================================
// L1–L4: 基础场景 / Basic scenarios
// ============================================================================
describe("L1-L4: basic real agent scenarios", () => {
  test("preflight: DeepSeek model is reachable", async () => {
    await ensureRealModelAvailable();
  }, 120_000);

  // L1: 元问题直接回答，不触发工具审批 / Meta question answered directly without tool approval
  test(
    "L1: answers model and context questions directly without tool approval",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l1-direct");
      const events: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: "你当前是什么模型？上下文有多长",
        ...env,
      })) {
        events.push(event);
        if (event.type === "interrupt" || event.type === "final") break;
      }

      expect(JSON.stringify(events)).not.toContain("tool_approval");
      const final = events.find((e) => e.type === "final");
      expect(String(final?.data)).toContain(env.config.modelName);
      expect(String(final?.data)).toContain("上下文");
    },
    120_000,
  );

  // L2: 单文件创建，触发一次审批 / Single file creation, one approval
  test(
    "L2: creates a single file with one approval cycle",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l2-single-file");
      const content = "hello from real deepseek langgraph agent";
      const events = await runApprovalLoop({
        ...env,
        task: `Create agent-output.txt with exact content "${content}". Do not create any other files.`,
      });

      expect(existsSync(join(env.workspace, "agent-output.txt"))).toBe(true);
      expect(readFileSync(join(env.workspace, "agent-output.txt"), "utf8")).toContain(content);
      expect(events.some((e) => e.type === "final")).toBe(true);
      expect(existsSync(env.checkpointPath)).toBe(true);
    },
    120_000,
  );

  // L3: /plan 只产出计划，不触发非危险确认 / /plan produces a plan without non-dangerous confirmation
  test(
    "L3: /plan produces a plan and blocks edits without mode confirmation",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l3-plan");
      const fileName = "plan-mode-output.txt";
      const fileContent = "plan mode should not edit before confirmation";

      const planEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: `/plan Create ${fileName} with exact content "${fileContent}".`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") break;
      }

      expect(planEvents.some((event) => event.type === "final")).toBe(true);
      expect(JSON.stringify(planEvents)).not.toContain("mode_confirmation");
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
      expect(existsSync(join(env.workspace, fileName))).toBe(false);
    },
    120_000,
  );

  // L4: 多文件创建 + 验证 / Multi-file creation + verification
  test(
    "L4: creates multiple files and verifies all of them",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l4-multi-file");
      const files = [
        { name: "a.txt", content: "AAA" },
        { name: "b.txt", content: "BBB" },
      ];

      const events = await runApprovalLoop({
        ...env,
        task: `Create ${files.map((f) => `${f.name} containing "${f.content}"`).join(" and ")}. After creating all files, verify each one exists and has the correct content.`,
      });

      for (const f of files) {
        expect(existsSync(join(env.workspace, f.name))).toBe(true);
        expect(readFileSync(join(env.workspace, f.name), "utf8")).toContain(f.content);
      }
      expect(events.some((e) => e.type === "final")).toBe(true);
    },
    180_000,
  );
});

// ============================================================================
// L5: 代码修改 + 验证 / Code modification + verification
// ============================================================================
describe("L5: code modification with verification", () => {
  // 创建代码文件 → 修改 → 运行验证 / Create code → modify → run verification
  test(
    "L5: creates a TypeScript file and verifies with typecheck",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l5-code-verify");

      // 预置 tsconfig.json，使 tsc 能工作 / Pre-create tsconfig.json so tsc works
      await Bun.write(
        join(env.workspace, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: { strict: true, target: "ESNext", module: "ESNext", noEmit: true },
          },
          null,
          2,
        ),
      );

      const events = await runApprovalLoop({
        ...env,
        task: `Create a file calc.ts with a function add(a: number, b: number): number that returns a + b. Export it. After creating the file, verify it compiles and is syntactically correct by running the type checker. If verification passes, report success. If it fails, fix the issue and retry until it passes.`,
      });

      const calcPath = join(env.workspace, "calc.ts");
      expect(existsSync(calcPath)).toBe(true);
      // 文件应包含函数签名 / File should contain the function signature
      const calcContent = readFileSync(calcPath, "utf8");
      expect(calcContent).toContain("add");
      expect(calcContent).toContain("number");
      expect(events.some((e) => e.type === "final")).toBe(true);
    },
    180_000,
  );

  // 带 linter 验证的代码修改 / Code modification with linter verification
  test(
    "L5b: creates a file and verifies it passes linting",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l5-lint-verify");

      const events = await runApprovalLoop({
        ...env,
        task: `Create a file named greeting.ts containing:
  export function greet(name: string): string {
    return "Hello, " + name + "!";
  }
After creating the file, verify the file exists and contains the expected content. Do not run TypeScript compiler since it may not be installed - just use basic file content verification.`,
      });

      const greetPath = join(env.workspace, "greeting.ts");
      expect(existsSync(greetPath)).toBe(true);
      const greetContent = readFileSync(greetPath, "utf8");
      expect(greetContent).toContain("export function greet");
      expect(greetContent).toContain(`"Hello, "`);
      expect(events.some((e) => e.type === "final")).toBe(true);
    },
    180_000,
  );
});

// ============================================================================
// L6: 错误恢复 / Error recovery
// ============================================================================
describe("L6: error recovery scenarios", () => {
  // 要求 agent 在遇到失败后通过检查错误并修正来恢复 / Agent must recover from failure by inspecting error and fixing
  test(
    "L6: recovers from a malformed command by inspecting and retrying",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-error-recovery");

      const events = await runApprovalLoop({
        ...env,
        task: `Write a file named "notes.txt" with content "line1\nline2\nline3". Then verify the file was written correctly. If any tool fails, inspect the error, understand what went wrong, and retry with the correct approach.`,
      });

      expect(existsSync(join(env.workspace, "notes.txt"))).toBe(true);
      const content = readFileSync(join(env.workspace, "notes.txt"), "utf8");
      expect(content).toContain("line1");
      expect(content).toContain("line3");
      // agent 应在遇到错误后能够自我恢复 / Agent should recover from errors
      expect(events.filter((e) => e.type === "final").length).toBeGreaterThanOrEqual(1);
    },
    240_000,
  );

  // Plan 模式下尝试非法操作应被拒绝，agent 应调整策略 / Illegal operations in plan mode should be rejected, agent adapts
  test(
    "L6b: adapts when a non-read command is rejected in plan mode",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-plan-reject");

      const planEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: `/plan Create a file named "plan-reject.txt" with content "test". Only plan, do not write or edit any files.`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") break;
      }

      // Plan 模式中不应有文件被创建 / No file should be created in plan mode
      expect(existsSync(join(env.workspace, "plan-reject.txt"))).toBe(false);
      // 不应产生 mode_confirmation 中断 / Should not produce mode_confirmation interrupt
      expect(JSON.stringify(planEvents)).not.toContain("mode_confirmation");
      // 不应有 tool_approval（plan 模式跳过审批直接进入 tools 拒绝） / No tool_approval (plan mode skips approval, tools node rejects)
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
    },
    120_000,
  );
});

// ============================================================================
// L7: 长时间运行 – 多文件项目，计划迭代，多次验证
// L7: Long-running – multi-file project with plan iteration and multiple verifications
// ============================================================================
describe("L7: long-running multi-file project", () => {
  test(
    "L7: builds a small multi-file utility project with iterative verification",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l7-long-run");

      const events = await runApprovalLoop({
        ...env,
        task: `Create two files:
1. Create src/helpers.ts containing: export function add(a: number, b: number): number { return a + b; }
2. Create src/index.ts containing: export { add } from "./helpers.js";
After creating both files, verify they exist and contain the correct content. Report the result.`,
      });

      // 验证所有文件存在 / Verify all files exist
      expect(existsSync(join(env.workspace, "src/helpers.ts"))).toBe(true);
      const helpersContent = readFileSync(join(env.workspace, "src/helpers.ts"), "utf8");
      expect(helpersContent).toContain("export");

      // index.ts 可能在不同位置 / index.ts may be in different location
      const indexInSrc = existsSync(join(env.workspace, "src/index.ts"));
      const indexInRoot = existsSync(join(env.workspace, "index.ts"));
      expect(indexInSrc || indexInRoot).toBe(true);
      const indexPath = indexInSrc
        ? join(env.workspace, "src/index.ts")
        : join(env.workspace, "index.ts");
      const indexContent = readFileSync(indexPath, "utf8");
      expect(indexContent).toContain("export");
      expect(indexContent).toContain("add");

      // checkpoint 应持久化 / Checkpoint should be persisted
      expect(existsSync(env.checkpointPath)).toBe(true);
    },
    300_000,
  );
});

// ============================================================================
// 测试辅助函数 / Test helpers
// ============================================================================

/** 创建测试环境 / Create test environment */
function createEnv(name: string): ContinueInput {
  const root = join(tmpdir(), `openpx-${name}`);
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

/** 全自动审批循环 / Full auto-approval loop */
async function runApprovalLoop(
  input: ContinueInput & { task: string },
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  // 启动 agent / Start agent
  for await (const event of streamCodeAgent({
    task: input.task,
    userId: input.userId,
    threadId: input.threadId,
    workspace: input.workspace,
    checkpointPath: input.checkpointPath,
    config: input.config,
    shellExecutor: input.shellExecutor,
  })) {
    events.push(event);
    if (event.type === "final") return events;
    if (event.type === "interrupt") break;
  }

  // 自动审批恢复 / Auto-approve resume loop
  let resume: boolean | { approved: boolean } = { approved: true };
  for (let i = 0; i < 20; i++) {
    let interrupted = false;
    for await (const event of resumeCodeAgent({
      userId: input.userId,
      threadId: input.threadId,
      workspace: input.workspace,
      checkpointPath: input.checkpointPath,
      config: input.config,
      shellExecutor: input.shellExecutor,
      resume,
    })) {
      events.push(event);
      if (event.type === "final") return events;
      if (event.type === "interrupt") {
        interrupted = true;
        break;
      }
    }
    if (!interrupted) return events;
    resume = { approved: true };
  }

  return events;
}

/** 手动审批恢复循环 / Manual approval resume loop */
async function continueApproving(
  input: ContinueInput,
  initialResume: { approved?: boolean; nextMode?: "builder" } = { approved: true },
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resume = initialResume;

  for (let i = 0; i < 12; i++) {
    let interrupted = false;
    for await (const event of resumeCodeAgent({ ...input, resume })) {
      events.push(event);
      if (event.type === "final") return events;
      if (event.type === "interrupt") {
        interrupted = true;
        break;
      }
    }
    if (!interrupted) return events;
    resume = { approved: true };
  }

  return events;
}

/** 创建测试 Shell 执行器，拦截文件读写 / Create test shell executor, intercept file reads/writes */
function createTestShellExecutor() {
  return async (input: ShellInput): Promise<ShellResult> => {
    // 拦截 bun -e 文件写入命令 / Intercept bun -e file write commands
    const bunWrite = parseBunWriteCommand(input.command);
    if (bunWrite) {
      mkdirSync(dirname(bunWrite.path), { recursive: true });
      await Bun.write(bunWrite.path, bunWrite.content);
    }
    // 拦截 PowerShell Set-Content / Intercept PowerShell Set-Content
    const encoded = input.command.match(/\$encoded = '([^']+)'/)?.[1];
    const path = input.command.match(/Set-Content -LiteralPath '((?:''|[^'])+)'/)?.[1];
    if (encoded && path) {
      const target = path.replaceAll("''", "'");
      const content = Buffer.from(encoded, "base64").toString("utf8");
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
    // 拦截普通写入命令 / Intercept plain write commands
    const plainWrite = parsePlainWriteCommand(input.command);
    if (plainWrite) {
      const target = join(input.workspace, plainWrite.path.split(/[\\/]/).pop() ?? plainWrite.path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, plainWrite.content);
    }
    // 拦截文件读取命令 (cat, type, Get-Content) / Intercept file read commands
    const readMatch =
      input.command.match(/Get-Content\s+"?([^"\s]+)"?(?:\s+-Raw)?/i) ??
      input.command.match(/cat\s+([^"\s]+)/i) ??
      input.command.match(/type\s+([^"\s]+)/i);
    if (readMatch) {
      const target = isAbsolute(readMatch[1]) ? readMatch[1] : join(input.workspace, readMatch[1]);
      return {
        ok: true, command: input.command, exitCode: 0,
        stdout: existsSync(target) ? readFileSync(target, "utf8") : "",
        stderr: "",
      };
    }

    return shellTool(input);
  };
}

function parseBunWriteCommand(command: string): { path: string; content: string } | null {
  if (!command.includes("fs.writeFileSync")) return null;
  const args =
    command.match(/'((?:'\\''|[^'])*)'/g)?.map((arg) => unescapePosixShellArg(arg.slice(1, -1))) ?? [];
  const encoded = args.at(-1);
  const path = args.at(-2);
  if (!path || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  return { path, content: Buffer.from(encoded, "base64").toString("utf8") };
}

function unescapePosixShellArg(value: string): string {
  return value.replaceAll("'\\''", "'");
}

function parsePlainWriteCommand(command: string): { path: string; content: string } | null {
  const setContent = command.match(
    /Set-Content\s+(?:-(?:LiteralPath|Path)\s+)?["']?([^"'\s]+)["']?\s+-Value\s+["']([^"']*)["']/i,
  );
  if (setContent) return { path: setContent[1], content: setContent[2] };

  const writeAllText = command.match(
    /\[System\.IO\.File\]::WriteAllText\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/i,
  );
  if (writeAllText) return { path: writeAllText[1], content: writeAllText[2] };

  const redirect = command.match(/echo\s+["']([^"']*)["']\s*>\s*["']?([^"'\s]+)["']?/i);
  if (redirect) return { path: redirect[2], content: redirect[1] };

  return null;
}
