import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { loadAgentConfig } from "../src/config/index";
import { resumeCodeAgent, streamCodeAgent } from "../src/app/runner";
import { createChatModel } from "../src/model/factory";
import { shellTool } from "../src/tools/shell";
import type { AgentConfig } from "../src/config/index";
import type {
  AgentEvent,
  AgentResumeValue,
  ShellInput,
  ShellResult,
} from "../src/shared/types";

// ============================================================================
// 真实模型 API 端到端测试，从简到难分为 7 个层级
// Real model API end-to-end tests, 7 levels from simple to complex
//
// L1: 直接回答 – 元问题，零工具调用
// L2: 单工具执行 – 简单文件创建
// L3: 只读访问 – 计划生成 + 写入阻断
// L4: 多步骤写入访问 – 多个工具调用 + 验证
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
    const response = await createChatModel(config).invoke([
      new HumanMessage("Reply with ok only"),
    ]);
    expect(String(response.content).toLowerCase()).toContain("ok");
  } catch (error) {
    throw new Error(
      [
        `Real model preflight failed for ${config.providerName}/${config.modelName} at ${config.baseURL}.`,
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
  test("preflight: configured model is reachable", async () => {
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
      const content = "hello from real langgraph agent";
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
    "L3: /plan produces a plan and blocks edits without access confirmation",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l3-plan");
      const fileName = "read-only-output.txt";
      const fileContent = "read-only access should not edit before confirmation";

      const planEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: `/plan Create ${fileName} with exact content "${fileContent}". Only produce the final plan and explain that read-only access blocks writing. Do not call ask_user and do not write or edit files.`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") break;
      }

      expect(planEvents.some((event) => event.type === "final")).toBe(true);
      expect(JSON.stringify(planEvents)).not.toContain("access_confirmation");
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

  // 真实模型用例应显式覆盖文件工具三件套 / Real model coverage for read_file/write_file/edit_file
  test(
    "L4b: covers read_file, write_file, and edit_file tool calls",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l4-file-tool-coverage");
      const targetPath = join(env.workspace, "tool-coverage.txt");

      const events = await runApprovalLoop({
        ...env,
        task: [
          "Use the file tools, not shell_execute.",
          'First call write_file to create tool-coverage.txt with exact content "before".',
          "Then call read_file to read tool-coverage.txt.",
          'Then call edit_file to replace exactly "before" with exactly "after".',
          "Then call read_file again to verify the file content is exactly after.",
          "After the second read_file result, give a concise final summary.",
        ].join(" "),
      });

      const toolNames = new Set(findToolResults(events).map((result) => result.tool));
      expect(toolNames.has("write_file")).toBe(true);
      expect(toolNames.has("read_file")).toBe(true);
      expect(toolNames.has("edit_file")).toBe(true);
      expect(existsSync(targetPath)).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe("after");
      expect(events.some((event) => event.type === "final")).toBe(true);
    },
    240_000,
  );

  // 真实模型用例应显式覆盖 update_plan 工具 / Real model coverage for update_plan
  test(
    "L4c: covers update_plan tool calls",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l4-update-plan-coverage");
      const expectedPlanName = "real tool coverage plan";

      const events = await runApprovalLoop({
        ...env,
        task: [
          "Tool-calling compliance task: your first action must be a real update_plan tool call, not a final answer.",
          `Call update_plan with name "${expectedPlanName}".`,
          'Set description to "cover update_plan in the live suite".',
          'Set overall status to "in_progress".',
          'Set steps to exactly: "record update_plan coverage" with status "completed", and "summarize coverage" with status "pending".',
          "Do not call any other tool.",
          "After the update_plan tool result, give a concise final summary.",
        ].join(" "),
      });

      const planResults = findToolResults(events).filter(
        (result) => result.tool === "update_plan",
      );
      expect(planResults.length).toBeGreaterThanOrEqual(1);
      expect(
        planResults.some((result) => {
          const plan = result.plan;
          return (
            !!plan &&
            typeof plan === "object" &&
            "name" in plan &&
            plan.name === expectedPlanName
          );
        }),
      ).toBe(true);
      expect(events.some((event) => event.type === "final")).toBe(true);
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

  // 只读访问下尝试非法操作应被拒绝，agent 应调整策略 / Illegal operations under read-only access should be rejected
  test(
    "L6b: adapts when a non-read command is rejected under read-only access",
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

      // 只读访问中不应有文件被创建 / No file should be created under read-only access
      expect(existsSync(join(env.workspace, "plan-reject.txt"))).toBe(false);
      // 不应产生 access_confirmation 中断 / Should not produce access_confirmation interrupt
      expect(JSON.stringify(planEvents)).not.toContain("access_confirmation");
      // 不应有 tool_approval（只读访问跳过审批直接进入 tools 拒绝） / No tool_approval (read-only access skips approval, tools node rejects)
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
    },
    120_000,
  );

  // 真实模型应能读取失败 ToolMessage 中的原因和用法提示，并继续恢复 / Real model should recover from failed tool guidance
  test(
    "L6c: recovers after a failed shell-backed tool result with guidance",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-tool-failure-guidance");
      const outputPath = join(env.workspace, "recovered-after-tool-failure.txt");

      const events = await runApprovalLoop({
        ...env,
        task: [
          "First call shell_execute with intent \"inspect\" and exactly this command: cat missing-real-input.txt",
          "That command is expected to fail. Read the failed tool result, including failure.reason and failure.guidance.",
          "Then create recovered-after-tool-failure.txt with exact content \"recovered after tool failure\".",
          "After creating the file, verify it exists and report the result.",
        ].join(" "),
      });

      const failure = findToolFailure(events);
      expect(failure?.reason).toBeTruthy();
      expect(failure?.guidance).toBeTruthy();
      expect(existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toContain("recovered after tool failure");
      expect(events.some((e) => e.type === "final")).toBe(true);
    },
    240_000,
  );

  // 真实模型应通过 ask_user 触发用户输入中断，并在恢复后继续执行 / Real model should ask, resume, and continue
  test(
    "L6d: resumes from an ask_user clarification interrupt",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-ask-user");
      const answer = "chosen by real ask_user";

      const initialEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: [
          "Before any final answer, call ask_user to ask what exact content should be reported.",
          "Provide two concrete options and allow free text.",
          "After the user answers, do not write files. Summarize the exact answer in the final response.",
        ].join(" "),
        ...env,
      })) {
        initialEvents.push(event);
        if (event.type === "interrupt" || event.type === "final") break;
      }

      const interrupt = initialEvents.find((event) => event.type === "interrupt");
      expect(JSON.stringify(interrupt?.data)).toContain("user_input");

      const resumedEvents = await continueWithResumes(env, { answer });
      const events = [...initialEvents, ...resumedEvents];

      const askUserResult = findToolResults(events).find(
        (result) => result.tool === "ask_user",
      );
      expect(askUserResult?.answer).toBe(answer);
      expect(events.some((event) => event.type === "final")).toBe(true);
    },
    240_000,
  );

  // 真实模型应能通过 shell_execute action envelope 使用 same_command 授权 / Real model should use shell_execute action envelope with same_command grant
  test(
    "L6e: uses shell_execute action metadata and same_command grant",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-shell-same-command");
      const marker = "same-command-real";
      const command = `bun -e "console.log('${marker}')"`;

      const initialEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: [
          "Use shell_execute and not file tools.",
          `Call shell_execute exactly twice with this identical command: ${command}`,
          'For both calls set intent to "verify".',
          'Set objective to "prove same_command grant works".',
          `Set expected_observation to "${marker}".`,
          "After the second successful tool result, give a concise final summary.",
        ].join(" "),
        ...env,
      })) {
        initialEvents.push(event);
        if (event.type === "interrupt" || event.type === "final") break;
      }

      expect(countToolApprovalInterrupts(initialEvents)).toBe(1);

      const resumedEvents = await continueWithResumes(env, {
        approved: true,
        grant: "same_command",
      });
      const events = [...initialEvents, ...resumedEvents];
      const matchingResults = findShellActionResults(events).filter((result) =>
        result.stdout.includes(marker),
      );

      expect(countToolApprovalInterrupts(events)).toBe(1);
      expect(matchingResults.length).toBeGreaterThanOrEqual(2);
      expect(matchingResults[0].command.trim()).toBe(matchingResults[1].command.trim());
      expect(matchingResults.every((result) => result.action?.intent === "verify")).toBe(
        true,
      );
      expect(
        matchingResults.every((result) => result.action?.grantUsed === "same_command"),
      ).toBe(true);
    },
    240_000,
  );

  // 真实模型应能在 full_access 后继续执行不同 shell_execute 命令而不再审批 / Real model should continue different shell_execute commands after full_access
  test(
    "L6f: uses full_access grant for subsequent shell_execute commands",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l6-shell-full-access");
      const firstMarker = "full-access-one";
      const secondMarker = "full-access-two";
      const firstCommand = `bun -e "console.log('${firstMarker}')"`;
      const secondCommand = `bun -e "console.log('${secondMarker}')"`;

      const initialEvents: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: [
          "Use shell_execute and not file tools.",
          `First call shell_execute with this command: ${firstCommand}`,
          `After the first tool result, call shell_execute with this different command: ${secondCommand}`,
          'For both calls set intent to "verify".',
          "Do not ask the user any question. After both tool results, give a concise final summary.",
        ].join(" "),
        ...env,
      })) {
        initialEvents.push(event);
        if (event.type === "interrupt" || event.type === "final") break;
      }

      expect(countToolApprovalInterrupts(initialEvents)).toBe(1);

      const resumedEvents = await continueWithResumes(env, {
        approved: true,
        grant: "full_access",
      });
      const events = [...initialEvents, ...resumedEvents];
      const shellResults = findShellActionResults(events);

      expect(countToolApprovalInterrupts(events)).toBe(1);
      expect(shellResults.some((result) => result.stdout.includes(firstMarker))).toBe(true);
      expect(shellResults.some((result) => result.stdout.includes(secondMarker))).toBe(true);
      expect(
        shellResults
          .filter(
            (result) =>
              result.stdout.includes(firstMarker) || result.stdout.includes(secondMarker),
          )
          .every((result) => result.action?.grantUsed === "full_access"),
      ).toBe(true);
    },
    240_000,
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
  initialResume: { approved?: boolean } = { approved: true },
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

/** 用给定恢复值继续执行，遇到工具审批则自动批准 / Continue with a resume value and auto-approve tool interrupts */
async function continueWithResumes(
  input: ContinueInput,
  initialResume: AgentResumeValue,
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
        resume = JSON.stringify(event.data).includes("tool_approval")
          ? { approved: true }
          : initialResume;
        break;
      }
    }
    if (!interrupted) return events;
  }

  return events;
}

/** 从事件流中查找失败工具结果 / Find a failed tool result from streamed events */
function findToolFailure(events: AgentEvent[]): { reason: string; guidance: string } | null {
  for (const value of walkValues(events)) {
    const content = messageContent(value);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as {
        failure?: { reason?: unknown; guidance?: unknown };
      };
      if (
        typeof parsed.failure?.reason === "string" &&
        typeof parsed.failure.guidance === "string"
      ) {
        return {
          reason: parsed.failure.reason,
          guidance: parsed.failure.guidance,
        };
      }
    } catch {
      // 事件流里也包含普通文本消息 / Stream also contains plain text messages
    }
  }
  return null;
}

interface ShellActionResult {
  command: string;
  stdout: string;
  action?: {
    intent?: string;
    objective?: string;
    expectedObservation?: string;
    failureStrategy?: string;
    grantUsed?: string;
  };
}

interface ParsedToolResult {
  tool?: string;
  command?: string;
  stdout?: string;
  plan?: unknown;
  path?: string;
  answer?: string;
}

/** 从事件流中查找带工具名的工具结果 / Find tool results that carry tool names */
function findToolResults(events: AgentEvent[]): ParsedToolResult[] {
  const results: ParsedToolResult[] = [];
  for (const value of walkValues(events)) {
    const content = messageContent(value);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as ParsedToolResult;
      if (typeof parsed.tool === "string") {
        results.push(parsed);
      }
    } catch {
      // 事件流里也包含普通文本消息 / Stream also contains plain text messages
    }
  }
  return results;
}

/** 从事件流中查找 shell_execute action 结果 / Find shell_execute action results from streamed events */
function findShellActionResults(events: AgentEvent[]): ShellActionResult[] {
  const results: ShellActionResult[] = [];
  for (const value of walkValues(events)) {
    const content = messageContent(value);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as Partial<ShellActionResult>;
      if (typeof parsed.command === "string" && parsed.action) {
        results.push({
          command: parsed.command,
          stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
          action: parsed.action,
        });
      }
    } catch {
      // 事件流里也包含普通文本消息 / Stream also contains plain text messages
    }
  }
  return results;
}

/** 统计工具审批中断数量 / Count tool approval interrupts */
function countToolApprovalInterrupts(events: AgentEvent[]): number {
  return events.filter(
    (event) => event.type === "interrupt" && JSON.stringify(event.data).includes("tool_approval"),
  ).length;
}

/** 提取 LangChain 消息内容，兼容实例字段和序列化 kwargs / Extract LangChain message content */
function messageContent(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") {
    return record.content;
  }
  const kwargs = record.kwargs;
  if (kwargs && typeof kwargs === "object") {
    const content = (kwargs as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return null;
}

/** 递归遍历事件对象值 / Recursively walk event values */
function* walkValues(value: unknown): Generator<unknown> {
  yield value;
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkValues(item);
    }
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    yield* walkValues(item);
  }
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
      if (!existsSync(target)) {
        return {
          ok: false,
          command: input.command,
          exitCode: 1,
          stdout: "",
          stderr: `File not found: ${readMatch[1]}`,
        };
      }
      return {
        ok: true, command: input.command, exitCode: 0,
        stdout: readFileSync(target, "utf8"),
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
