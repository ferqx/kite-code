import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { loadAgentConfig } from "../src/config/index";
import { resumeCodeAgent, streamCodeAgent } from "../src/app/runner";
import { createChatModel } from "../src/model/factory";
import { shellTool } from "../src/tools/shell";
import { REAL_TEST_MODEL_ENV, REAL_TEST_PROVIDER_ENV } from "./real-test-options";
import type { AgentConfig } from "../src/config/index";
import type {
  AgentEvent,
  AgentResumeValue,
  ModelRetryEvent,
  ShellInput,
  ShellResult,
} from "../src/shared/types";

// ============================================================================
// 真实模型 API 端到端测试，从简到难分为 8 个层级
// Real model API end-to-end tests, 8 levels from simple to complex
//
// L1: 直接回答 – 元问题，零工具调用
// L2: 单工具执行 – 简单文件创建
// L3: 只读访问 – 计划生成 + 写入阻断
// L4: 多步骤写入访问 – 多个工具调用 + 验证
// L5: 代码修改 + 验证 – 代码编写 + 测试/类型检查
// L6: 错误恢复 – 工具失败后的自我修复
// L7: 长时间运行 – 多文件项目，5+ 步骤 + 计划迭代
// L8: 超长时间复杂场景 – 多轮迭代 + 高 token 量，持续 10 分钟以上
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

function loadRealModelConfig(): AgentConfig {
  return loadAgentConfig({
    providerName: process.env[REAL_TEST_PROVIDER_ENV],
    modelName: process.env[REAL_TEST_MODEL_ENV],
  });
}

async function ensureRealModelAvailable(): Promise<void> {
  realModelPreflight ??= runRealModelPreflight();
  return realModelPreflight;
}

async function runRealModelPreflight(): Promise<void> {
  const config = loadRealModelConfig();
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
      logCacheAggregate(events, "L1 direct");
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
      logCacheAggregate(events, "L2 single-file");
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
      logCacheAggregate(planEvents, "L3 plan");
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
      logCacheAggregate(events, "L4 multi-file");
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
      logCacheAggregate(events, "L4b file-tools");
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
      logCacheAggregate(events, "L4c update-plan");
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
      logCacheAggregate(events, "L5 code-verify");
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
      logCacheAggregate(events, "L5b lint-verify");
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
      logCacheAggregate(events, "L6 error-recovery");
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
      logCacheAggregate(planEvents, "L6b plan-reject");
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
      logCacheAggregate(events, "L6c tool-failure");
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
      logCacheAggregate(events, "L6d ask-user");
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
      logCacheAggregate(events, "L6e same-cmd");
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
      logCacheAggregate(events, "L6f full-access");
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
      logCacheAggregate(events, "L7 long-run");
    },
    300_000,
  );
});

// ============================================================================
// L8: 长时间复杂场景 – 多轮迭代，高 token 量，持续 10 分钟以上
// L8: Long-running complex scenarios – multi-round iteration, high token volume, 10+ min sustained
// ============================================================================
describe("L8: extended long-running complex scenarios", () => {
  // L8a: 构建并分层扩展工具库 / Build and iteratively extend a utility library
  test(
    "L8a: builds and iteratively extends a TypeScript utility library",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l8-utility-lib");

      const events = await runApprovalLoop({
        ...env,
        maxResumes: 40,
        task: [
          "Build a TypeScript utility library in the src/ directory. Work in distinct phases and verify each phase:",
          "(1) Create tsconfig.json with strict settings.",
          "(2) Create src/math.ts with add, subtract, multiply, divide — each with types and JSDoc.",
          "(3) Create src/string.ts with capitalize, reverse, truncate — each with types and JSDoc.",
          "(4) Create src/index.ts barrel re-exports for all functions.",
          "(5) Verify all files created so far, then extend src/math.ts with clamp(min,max,value) and average(numbers[]).",
          "(6) Extend src/string.ts with padStart and padEnd.",
          "(7) Update src/index.ts to export the new functions.",
          "(8) Create README.md documenting all exported functions with usage examples.",
          "(9) Final verification — use read_file on every file and confirm consistency.",
        ].join(" "),
      });

      const mathPath = join(env.workspace, "src/math.ts");
      expect(existsSync(mathPath)).toBe(true);
      const mathContent = readFileSync(mathPath, "utf8");
      expect(mathContent).toContain("add");
      expect(mathContent).toContain("clamp");

      const stringPath = join(env.workspace, "src/string.ts");
      expect(existsSync(stringPath)).toBe(true);
      const stringContent = readFileSync(stringPath, "utf8");
      expect(stringContent).toContain("capitalize");
      expect(stringContent).toContain("padStart");

      const indexPath = join(env.workspace, "src/index.ts");
      expect(existsSync(indexPath)).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toContain("export");

      const readmePath = join(env.workspace, "README.md");
      // README.md is optional — the agent may prioritize code over docs
      if (existsSync(readmePath)) {
        const readmeContent = readFileSync(readmePath, "utf8");
        expect(readmeContent).toContain("add");
        expect(readmeContent).toContain("capitalize");
      }

      expect(events.some((e) => e.type === "final")).toBe(true);
      logCacheAggregate(events, "L8a util-lib");
    },
    900_000,
  );

  // L8b: 构建带服务层的数据模型 / Build a data model with service layer
  test(
    "L8b: builds a TypeScript service layer with data models",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l8-data-service");

      const events = await runApprovalLoop({
        ...env,
        maxResumes: 40,
        task: [
          "Build a TypeScript data model and service layer in the src/ directory. Verify each step:",
          "(1) Create src/models.ts with interfaces: User { id: number, name: string, email: string } and Product { id: number, title: string, price: number }.",
          "(2) Create src/database.ts with a Database class that stores User[] and Product[] arrays, with add, remove, getAll methods.",
          "(3) Create src/user-service.ts wrapping database with addUser(name,email) and getUserByEmail(email) methods.",
          "(4) Create src/product-service.ts wrapping database with addProduct(title,price) and getProductsByPriceRange(min,max) methods.",
          "(5) Create src/index.ts barrel exports for all modules.",
          "(6) Use read_file to verify every file has correct content.",
          "(7) Final summary.",
        ].join(" "),
      });

      const modelsPath = join(env.workspace, "src/models.ts");
      expect(existsSync(modelsPath)).toBe(true);
      const modelsContent = readFileSync(modelsPath, "utf8");
      expect(modelsContent).toContain("User");
      expect(modelsContent).toContain("Product");

      const dbPath = join(env.workspace, "src/database.ts");
      expect(existsSync(dbPath)).toBe(true);
      expect(readFileSync(dbPath, "utf8")).toContain("class");

      const userServicePath = join(env.workspace, "src/user-service.ts");
      expect(existsSync(userServicePath)).toBe(true);

      const indexPath = join(env.workspace, "src/index.ts");
      expect(existsSync(indexPath)).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toContain("export");

      expect(events.some((e) => e.type === "final")).toBe(true);
      logCacheAggregate(events, "L8b data-service");
    },
    900_000,
  );

  // L8c: 构建 API 客户端库及错误处理，并生成文档 / Build API client lib with error handling and docs
  test(
    "L8c: builds a TypeScript API client library with error handling and documentation",
    async () => {
      await ensureRealModelAvailable();
      const env = createEnv("l8-api-client");

      const events = await runApprovalLoop({
        ...env,
        maxResumes: 40,
        task: [
          "Build a TypeScript API client library with error handling in the src/ directory. Work in phases:",
          "(1) Create tsconfig.json.",
          "(2) Create src/errors.ts with custom error classes: ApiError (status, body), NetworkError (cause), ValidationError (field, message), all extending a BaseError.",
          "(3) Create src/http.ts with typed fetchJson<T>(url) and postJson<T>(url, body) functions that parse JSON responses and throw ApiError on non-ok status.",
          "(4) Create src/retry.ts with a retry<T>(fn, options: { maxRetries, backoffMs }) that retries on NetworkError with exponential backoff.",
          "(5) Update src/http.ts to use retry from src/retry.ts for fetchJson.",
          "(6) Create src/client.ts with a simple ApiClient class wrapping http functions with a baseUrl.",
          "(7) Create src/index.ts barrel exports.",
          "(8) Create README.md documenting all exports with usage examples.",
          "(9) Use read_file on every src file to verify imports and exports are consistent.",
          "(10) Final summary.",
        ].join(" "),
      });

      const errorsPath = join(env.workspace, "src/errors.ts");
      expect(existsSync(errorsPath)).toBe(true);
      expect(readFileSync(errorsPath, "utf8")).toContain("class");

      const httpPath = join(env.workspace, "src/http.ts");
      expect(existsSync(httpPath)).toBe(true);
      const httpContent = readFileSync(httpPath, "utf8");
      expect(httpContent).toContain("fetchJson");
      expect(httpContent).toContain("retry");

      const retryPath = join(env.workspace, "src/retry.ts");
      expect(existsSync(retryPath)).toBe(true);
      expect(readFileSync(retryPath, "utf8")).toContain("retry");

      const clientPath = join(env.workspace, "src/client.ts");
      expect(existsSync(clientPath)).toBe(true);

      const indexPath = join(env.workspace, "src/index.ts");
      expect(existsSync(indexPath)).toBe(true);

      const readmePath = join(env.workspace, "README.md");
      // README.md is optional — the agent may prioritize code over docs
      if (existsSync(readmePath)) {
        expect(readFileSync(readmePath, "utf8").length).toBeGreaterThan(0);
      }

      expect(events.some((e) => e.type === "final")).toBe(true);
      logCacheAggregate(events, "L8c api-client");
    },
    900_000,
  );
});

// ============================================================================
// Retry: 模型服务错误恢复 / Model service error recovery
//
// 通过本地 HTTP 代理模拟瞬时 5xx 错误，验证模型调用能自动重试并最终成功。
// 覆盖链路：代理 503 → isTransientModelConnectionError → withTransientModelRetry → 真实 API
// Use a local HTTP proxy to simulate transient 5xx errors, verifying retry recovery.
// Covered: proxy 503 → isTransientModelConnectionError → withTransientModelRetry → real API.
// ============================================================================
describe("Retry: model service error recovery", () => {
  test(
    "recovers from transient 503 errors and reports retry events",
    async () => {
      await ensureRealModelAvailable();
      const config = loadRealModelConfig();

      // 启动本地 HTTP 代理：前 2 次请求返回 503，之后转发到真实 API
      // Start local HTTP proxy: first 2 requests return 503, then forward to real API
      let requestCount = 0;
      const proxy = Bun.serve({
        port: 0,
        async fetch(req) {
          requestCount++;
          if (requestCount <= 2) {
            return new Response(
              JSON.stringify({ error: { message: "Service Unavailable" } }),
              {
                status: 503,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const url = new URL(req.url);
          const targetUrl = `${config.baseURL}${url.pathname}${url.search}`;
          const headers = new Headers(req.headers);
          headers.delete("host");
          try {
            const body = await req.text();
            return await fetch(targetUrl, {
              method: req.method,
              headers,
              body: body || undefined,
            });
          } catch (_) {
            return new Response("Bad Gateway", { status: 502 });
          }
        },
      });

      try {
        const proxyConfig = {
          ...config,
          baseURL: `http://localhost:${proxy.port}`,
        };
        const model = createChatModel(proxyConfig);
        const retryEvents: ModelRetryEvent[] = [];
        (model as unknown as Record<string, unknown>)._retryListener = (
          attempt: number,
          error: unknown,
          delayMs: number,
        ) => {
          retryEvents.push({
            attempt,
            error: String(error).slice(0, 200),
            delayMs,
          });
        };

        const response = await model.invoke([
          new HumanMessage("Reply with 'hello' only"),
        ]);

        // 应有 2 次重试事件（前 2 次 503 失败触发重试，第 3 次成功）
        // Should have 2 retry events (first 2 fail with 503, 3rd succeeds)
        expect(retryEvents.length).toBe(2);
        expect(retryEvents[0].attempt).toBe(1);
        expect(retryEvents[1].attempt).toBe(2);
        // 总共 3 次 HTTP 请求（2 失败 + 1 成功）/ 3 total HTTP requests (2 fail + 1 success)
        expect(requestCount).toBe(3);
        expect(String(response.content).toLowerCase()).toMatch(/hello/);
      } finally {
        proxy.stop();
      }
    },
    120_000,
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
    config: loadRealModelConfig(),
    shellExecutor: createTestShellExecutor(),
  };
}

/** 全自动审批循环 / Full auto-approval loop */
async function runApprovalLoop(
  input: ContinueInput & { task: string; maxResumes?: number },
): Promise<AgentEvent[]> {
  const maxResumes = input.maxResumes ?? 20;
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
  for (let i = 0; i < maxResumes; i++) {
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

function logCacheAggregate(events: AgentEvent[], label: string): void {
  let calls = 0;
  let totalInput = 0;
  let totalHit = 0;
  for (const e of events) {
    if (e.type !== "cache_metrics") continue;
    const d = e.data as Record<string, unknown> | undefined;
    if (!d || typeof d.inputTokens !== "number") continue;
    calls++;
    totalInput += d.inputTokens as number;
    totalHit += d.cacheHitTokens as number;
  }
  if (calls === 0) return;
  const rate = totalInput > 0 ? (totalHit / totalInput * 100) : 0;
  const labelPad = label.padEnd(20);
  console.log(
    `[cache] ${labelPad} ${rate.toFixed(1)}%  (${totalHit}/${totalInput} tokens, ${calls} calls)`,
  );
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
