import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { AgentConfig } from '../src/core/config/index';
import { loadAgentConfig } from '../src/core/config/index';
import { createChatModel } from '../src/core/model/factory';
import { runAgent } from '../src/core/runner';
import { shellTool } from '../src/core/tools/shell';
import type {
  AuthorizationOverride,
  ModelRetryEvent,
  ShellInput,
  ShellResult,
} from '../src/core/types';
import type {
  AgentEvent,
  InterruptPayload,
  UserAction,
  UserInputProvider,
} from '../src/protocol/index';
import { REAL_TEST_MODEL_ENV, REAL_TEST_PROVIDER_ENV } from './real-test-options';

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
    const response = await createChatModel(config).invoke([new HumanMessage('Reply with ok only')]);
    expect(String(response.content).toLowerCase()).toContain('ok');
  } catch (error) {
    throw new Error(
      [
        `Real model preflight failed for ${config.providerName}/${config.modelName} at ${config.baseURL}.`,
        `Proxy env: ${proxyEnvSummary()}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
      { cause: error },
    );
  }
}

function proxyEnvSummary(): string {
  return ['all_proxy', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY']
    .map((name) => `${name}=${process.env[name] ?? '<unset>'}`)
    .join(' ');
}

// ============================================================================
// L1–L4: 基础场景 / Basic scenarios
// ============================================================================
describe('L1-L4: basic runAgent scenarios', () => {
  test('preflight: configured model is reachable', async () => {
    await ensureRealModelAvailable();
  }, 120_000);

  // L1: 元问题直接回答，不触发工具审批 / Meta question answered directly without tool approval
  test('L1: answers model and context questions directly without tool approval', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l1-direct');
    const events = await runAgentTest({
      ...env,
      task: '你当前是什么模型？上下文有多长',
    });

    expect(events.filter((e) => e.type === 'need_approval').length).toBe(0);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L1 direct');
  }, 120_000);

  // L2: 单文件创建 / Single file creation
  test('L2: creates a single file with one approval cycle', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l2-single-file');
    const content = 'hello from real langgraph agent';
    const events = await runAgentTest({
      ...env,
      task: `Create agent-output.txt with exact content "${content}". Do not create any other files.`,
    });

    expect(existsSync(join(env.workspace, 'agent-output.txt'))).toBe(true);
    expect(readFileSync(join(env.workspace, 'agent-output.txt'), 'utf8')).toContain(content);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    expect(existsSync(env.checkpointPath)).toBe(true);
    logCacheAggregate(events, 'L2 single-file');
  }, 120_000);

  // L2b: 启动时 full_access 覆盖，跳过审批直接创建 / Start with full_access override, skip approval
  test('L2b: creates file without approval under startup full_access override', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l2b-full-access-startup');
    const content = 'hello from full access startup';
    const events = await runAgentTest({
      ...env,
      task: `Create agent-output.txt with exact content "${content}". Do not create any other files.`,
      authorizationOverride: { current: 'full_access' },
    });

    expect(existsSync(join(env.workspace, 'agent-output.txt'))).toBe(true);
    expect(readFileSync(join(env.workspace, 'agent-output.txt'), 'utf8')).toContain(content);
    expect(events.filter((e) => e.type === 'need_approval').length).toBe(0);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L2b full-access startup');
  }, 120_000);

  // L3: /plan 只产出计划，不触发非危险确认 / /plan produces a plan without non-dangerous confirmation
  test('L3: /plan produces a plan and blocks edits without access confirmation', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l3-plan');
    const fileName = 'read-only-output.txt';
    const fileContent = 'read-only access should not edit before confirmation';

    const events = await runAgentTest({
      ...env,
      task: `/plan Create ${fileName} with exact content "${fileContent}". Only produce the final plan and explain that read-only access blocks writing. Do not call ask_user and do not write or edit files.`,
    });

    expect(events.some((event) => event.type === 'final')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('access_confirmation');
    expect(JSON.stringify(events)).not.toContain('tool_approval');
    expect(existsSync(join(env.workspace, fileName))).toBe(false);
    logCacheAggregate(events, 'L3 plan');
  }, 120_000);

  // L4: 多文件创建 + 验证 / Multi-file creation + verification
  test('L4: creates multiple files and verifies all of them', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l4-multi-file');
    const files = [
      { name: 'a.txt', content: 'AAA' },
      { name: 'b.txt', content: 'BBB' },
    ];

    const events = await runAgentTest({
      ...env,
      task: `Create ${files.map((f) => `${f.name} containing "${f.content}"`).join(' and ')}. After creating all files, verify each one exists and has the correct content.`,
    });

    for (const f of files) {
      expect(existsSync(join(env.workspace, f.name))).toBe(true);
      expect(readFileSync(join(env.workspace, f.name), 'utf8')).toContain(f.content);
    }
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L4 multi-file');
  }, 180_000);

  // 真实模型用例应显式覆盖文件工具三件套 / Real model coverage for read_file/write_file/edit_file
  test('L4b: covers read_file, write_file, and edit_file tool calls', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l4-file-tool-coverage');
    const targetPath = join(env.workspace, 'tool-coverage.txt');

    const events = await runAgentTest({
      ...env,
      task: [
        'Use the file tools, not shell_execute.',
        'First call write_file to create tool-coverage.txt with exact content "before".',
        'Then call read_file to read tool-coverage.txt.',
        'Then call edit_file to replace exactly "before" with exactly "after".',
        'Then call read_file again to verify the file content is exactly after.',
        'After the second read_file result, give a concise final summary.',
      ].join(' '),
    });

    const toolNames = new Set(
      events.filter((e) => e.type === 'tool_call').map((e) => (e.data as { name: string }).name),
    );
    expect(toolNames.has('write_file')).toBe(true);
    expect(toolNames.has('read_file')).toBe(true);
    expect(toolNames.has('edit_file')).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('after');
    expect(events.some((event) => event.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L4b file-tools');
  }, 240_000);

  // 真实模型用例应显式覆盖 update_plan 工具 / Real model coverage for update_plan
  test('L4c: covers update_plan tool calls', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l4-update-plan-coverage');
    const expectedPlanName = 'real tool coverage plan';

    const events = await runAgentTest({
      ...env,
      task: [
        'Tool-calling compliance task: your first action must be a real update_plan tool call, not a final answer.',
        `Call update_plan with name "${expectedPlanName}".`,
        'Set description to "cover update_plan in the live suite".',
        'Set overall status to "in_progress".',
        'Set steps to exactly: "record update_plan coverage" with status "completed", and "summarize coverage" with status "pending".',
        'Do not call any other tool.',
        'After the update_plan tool result, give a concise final summary.',
      ].join(' '),
    });

    const planCalls = events.filter(
      (e) => e.type === 'tool_call' && (e.data as { name: string }).name === 'update_plan',
    );
    expect(planCalls.length).toBeGreaterThanOrEqual(1);
    const planStateChanges = events.filter(
      (e) => e.type === 'state_change' && (e.data as { plan?: unknown }).plan,
    );
    expect(planStateChanges.length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L4c update-plan');
  }, 180_000);
});

// ============================================================================
// L5: 代码修改 + 验证 / Code modification + verification
// ============================================================================
describe('L5: code modification with verification', () => {
  // 创建代码文件 → 验证 / Create code → verify
  test('L5: creates a TypeScript file and verifies with typecheck', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l5-code-verify');

    // 预置 tsconfig.json，使 tsc 能工作 / Pre-create tsconfig.json so tsc works
    await Bun.write(
      join(env.workspace, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext', noEmit: true },
        },
        null,
        2,
      ),
    );

    const events = await runAgentTest({
      ...env,
      task: `Create a file calc.ts with a function add(a: number, b: number): number that returns a + b. Export it. After creating the file, verify it compiles and is syntactically correct by running the type checker. If verification passes, report success. If it fails, fix the issue and retry until it passes.`,
    });

    const calcPath = join(env.workspace, 'calc.ts');
    expect(existsSync(calcPath)).toBe(true);
    const calcContent = readFileSync(calcPath, 'utf8');
    expect(calcContent).toContain('add');
    expect(calcContent).toContain('number');
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L5 code-verify');
  }, 180_000);

  // 创建简单代码文件并验证 / Create simple code file and verify
  test('L5b: creates a file and verifies content', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l5-lint-verify');

    const events = await runAgentTest({
      ...env,
      task: `Create a file named greeting.ts containing:
  export function greet(name: string): string {
    return "Hello, " + name + "!";
  }
After creating the file, verify the file exists and contains the expected content. Do not run TypeScript compiler since it may not be installed - just use basic file content verification.`,
    });

    const greetPath = join(env.workspace, 'greeting.ts');
    expect(existsSync(greetPath)).toBe(true);
    const greetContent = readFileSync(greetPath, 'utf8');
    expect(greetContent).toContain('export function greet');
    expect(greetContent).toContain(`"Hello, "`);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L5b lint-verify');
  }, 180_000);
});

// ============================================================================
// L6: 错误恢复 + 中断场景 / Error recovery + interrupt scenarios
// ============================================================================
describe('L6: error recovery + interrupt scenarios', () => {
  // 要求 agent 在遇到失败后通过检查错误并修正来恢复 / Agent must recover from failure by inspecting error and fixing
  test('L6: recovers from a malformed command by inspecting and retrying', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6-error-recovery');

    const events = await runAgentTest({
      ...env,
      task: `Write a file named "notes.txt" with content "line1\\nline2\\nline3". Then verify the file was written correctly. If any tool fails, inspect the error, understand what went wrong, and retry with the correct approach.`,
    });

    expect(existsSync(join(env.workspace, 'notes.txt'))).toBe(true);
    const content = readFileSync(join(env.workspace, 'notes.txt'), 'utf8');
    expect(content).toContain('line1');
    expect(content).toContain('line3');
    expect(events.filter((e) => e.type === 'final').length).toBeGreaterThanOrEqual(1);
    logCacheAggregate(events, 'L6 error-recovery');
  }, 240_000);

  // 真实模型应能读取失败 ToolMessage 中的原因和用法提示，并继续恢复 / Real model should recover from failed tool guidance
  test('L6c: recovers after a failed shell-backed tool result with guidance', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6-tool-failure-guidance');
    const outputPath = join(env.workspace, 'recovered-after-tool-failure.txt');

    const events = await runAgentTest({
      ...env,
      task: [
        'First call shell_execute with intent "inspect" and exactly this command: cat missing-real-input.txt',
        'That command is expected to fail. Read the failed tool result, including failure.reason and failure.guidance.',
        'Then create recovered-after-tool-failure.txt with exact content "recovered after tool failure".',
        'After creating the file, verify it exists and report the result.',
      ].join(' '),
    });

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('recovered after tool failure');
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L6c tool-failure');
  }, 240_000);

  // 真实模型应通过 ask_user 触发用户输入中断，并在恢复后继续执行 / Real model should ask, resume, and continue
  test('L6-ask: resumes from an ask_user clarification interrupt', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6-ask-user');
    const answer = 'chosen by real ask_user';

    const events = await runAgentTest({
      ...env,
      task: [
        'Before any final answer, call ask_user to ask what exact content should be reported.',
        'Provide two concrete options and allow free text.',
        'After the user answers, do not write files. Summarize the exact answer in the final response.',
      ].join(' '),
      inputAnswer: answer,
    });

    expect(events.some((e) => e.type === 'need_input')).toBe(true);
    expect(events.some((event) => event.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L6-ask ask-user');
  }, 240_000);

  // 真实模型应能通过 shell_execute 使用 same_command 授权 / Real model should use shell_execute with same_command grant
  test('L6e-same-cmd: uses same_command grant for repeated shell_execute', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6-shell-same-command');
    const marker = 'same-command-real';
    const command = `echo ${marker}`;

    const events = await runAgentTest({
      ...env,
      task: [
        'Use shell_execute and not file tools.',
        `Call shell_execute exactly twice with this identical command: ${command}`,
        'After both results, give a concise final summary.',
      ].join(' '),
      grant: 'same_command',
    });

    expect(events.filter((e) => e.type === 'need_approval').length).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L6e same-cmd');
  }, 180_000);

  // 真实模型应能在 full_access 后继续执行不同 shell_execute 命令而不再审批 / Full_access grant skips different commands too
  test('L6f-full-access: uses full_access grant for subsequent different commands', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6-shell-full-access');
    const firstMarker = 'full-access-one';
    const secondMarker = 'full-access-two';
    const firstCmd = `echo ${firstMarker}`;
    const secondCmd = `echo ${secondMarker}`;

    const events = await runAgentTest({
      ...env,
      task: [
        'Use shell_execute and not file tools.',
        `First call shell_execute with this command: ${firstCmd}`,
        `Then call shell_execute with this different command: ${secondCmd}`,
        'Do not ask the user any question. After both results, give a concise final summary.',
      ].join(' '),
      grant: 'full_access',
    });

    expect(events.filter((e) => e.type === 'need_approval').length).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L6f full-access');
  }, 180_000);

  // 真实模型应在用户要求"不需要确认"时调用 set_authorization_mode 工具 / Real model calls set_authorization_mode tool
  test('L6g: switches to full_access via set_authorization_mode tool', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l6g-set-auth-mode');
    const filePath = 'auto-output.txt';
    const fileContent = 'auto-executed without confirmation';

    const events = await runAgentTest({
      ...env,
      task: [
        `Create ${filePath} with exact content "${fileContent}".`,
        'First, call set_authorization_mode to switch to full_access mode so that subsequent write_file operations do not require confirmation.',
        'Then, write the file using write_file.',
        'Do not ask the user any question.',
      ].join(' '),
    });

    const authModeCalls = events.filter(
      (e) =>
        e.type === 'tool_call' && (e.data as { name: string }).name === 'set_authorization_mode',
    );
    expect(authModeCalls.length).toBeGreaterThanOrEqual(1);

    expect(existsSync(join(env.workspace, filePath))).toBe(true);
    expect(readFileSync(join(env.workspace, filePath), 'utf8')).toContain(fileContent);
    logCacheAggregate(events, 'L6g set-auth-mode');
  }, 240_000);
});

// ============================================================================
// L7: 长时间运行 – 多文件项目，计划迭代，多次验证
// L7: Long-running – multi-file project with plan iteration and multiple verifications
// ============================================================================
describe('L7: long-running multi-file project', () => {
  test('L7: builds a small multi-file utility project with iterative verification', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l7-long-run');

    const events = await runAgentTest({
      ...env,
      task: `Create two files:
1. Create src/helpers.ts containing: export function add(a: number, b: number): number { return a + b; }
2. Create src/index.ts containing: export { add } from "./helpers.js";
After creating both files, verify they exist and contain the correct content. Report the result.`,
    });

    expect(existsSync(join(env.workspace, 'src/helpers.ts'))).toBe(true);
    const helpersContent = readFileSync(join(env.workspace, 'src/helpers.ts'), 'utf8');
    expect(helpersContent).toContain('export');

    const indexInSrc = existsSync(join(env.workspace, 'src/index.ts'));
    const indexInRoot = existsSync(join(env.workspace, 'index.ts'));
    expect(indexInSrc || indexInRoot).toBe(true);
    const indexPath = indexInSrc
      ? join(env.workspace, 'src/index.ts')
      : join(env.workspace, 'index.ts');
    const indexContent = readFileSync(indexPath, 'utf8');
    expect(indexContent).toContain('export');
    expect(indexContent).toContain('add');

    expect(existsSync(env.checkpointPath)).toBe(true);
    logCacheAggregate(events, 'L7 long-run');
  }, 300_000);
});

// ============================================================================
// Cache: 缓存命中率验证 / Cache hit rate verification
// 20 轮简单工具调用，验证 warm cache 命中率是否合理
// 20 simple tool-call rounds, verify warm cache hit rate is reasonable
// ============================================================================
describe('Cache: hit rate over 20 rounds', () => {
  test('10 rounds of alternating read-write show reasonable cache hit rate', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('cache-20-rounds');

    // 10 轮交替读写：每轮必须先读上一轮的输出，再写新文件
    // 10 rounds of alternating read-write: each round must read previous output before writing
    const rounds: string[] = [];
    rounds.push('Use write_file to create cache-01.txt with content "round-1".');
    for (let i = 2; i <= 10; i++) {
      const prev = `cache-${String(i - 1).padStart(2, '0')}.txt`;
      const curr = `cache-${String(i).padStart(2, '0')}.txt`;
      rounds.push(
        `Use read_file to read ${prev}, then use write_file to create ${curr} with content "round-${i}".`,
      );
    }
    rounds.push('After completing all 10 rounds, give a short summary.');

    const events = await runAgentTest({
      ...env,
      task: rounds.join('\n'),
      authorizationOverride: { current: 'full_access' },
    });

    const cacheEvents = events.filter((e) => e.type === 'cache_metrics');
    // 至少 10 次模型调用（链式读写任务需要多轮）
    // At least 10 model calls (chain read-write task needs multiple rounds)
    expect(cacheEvents.length).toBeGreaterThanOrEqual(10);

    logCacheAggregate(events, 'cache-10-rounds');

    // 验证整体命中率合理（> 70%）
    // Verify overall hit rate is reasonable (> 70%)
    let totalHit = 0,
      totalInput = 0;
    for (const e of cacheEvents) {
      if (e.type !== 'cache_metrics') continue;
      totalHit += e.data.cacheHitTokens;
      totalInput += e.data.inputTokens;
    }
    const overallRate = totalInput > 0 ? totalHit / totalInput : 0;
    expect(overallRate).toBeGreaterThan(0.7);
  }, 600_000);
});

// ============================================================================
// L8: 长时间复杂场景 – 多轮迭代，高 token 量，持续 10 分钟以上
// L8: Long-running complex scenarios – multi-round iteration, high token volume, 10+ min sustained
// ============================================================================
describe('L8: extended long-running complex scenarios', () => {
  // L8a: 构建并分层扩展工具库 / Build and iteratively extend a utility library
  test('L8a: builds and iteratively extends a TypeScript utility library', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l8-utility-lib');

    const events = await runAgentTest({
      ...env,
      task: [
        'Build a TypeScript utility library in the src/ directory. Work in distinct phases and verify each phase:',
        '(1) Create tsconfig.json with strict settings.',
        '(2) Create src/math.ts with add, subtract, multiply, divide — each with types and JSDoc.',
        '(3) Create src/string.ts with capitalize, reverse, truncate — each with types and JSDoc.',
        '(4) Create src/index.ts barrel re-exports for all functions.',
        '(5) Verify all files created so far, then extend src/math.ts with clamp(min,max,value) and average(numbers[]).',
        '(6) Extend src/string.ts with padStart and padEnd.',
        '(7) Update src/index.ts to export the new functions.',
        '(8) Create README.md documenting all exported functions with usage examples.',
        '(9) Final verification — use read_file on every file and confirm consistency.',
      ].join(' '),
    });

    const mathPath = join(env.workspace, 'src/math.ts');
    expect(existsSync(mathPath)).toBe(true);
    const mathContent = readFileSync(mathPath, 'utf8');
    expect(mathContent).toContain('add');
    expect(mathContent).toContain('clamp');

    const stringPath = join(env.workspace, 'src/string.ts');
    expect(existsSync(stringPath)).toBe(true);
    const stringContent = readFileSync(stringPath, 'utf8');
    expect(stringContent).toContain('capitalize');
    expect(stringContent).toContain('padStart');

    const indexPath = join(env.workspace, 'src/index.ts');
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toContain('export');

    const readmePath = join(env.workspace, 'README.md');
    if (existsSync(readmePath)) {
      const readmeContent = readFileSync(readmePath, 'utf8');
      expect(readmeContent).toContain('add');
      expect(readmeContent).toContain('capitalize');
    }

    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L8a util-lib');
  }, 900_000);

  // L8b: 构建带服务层的数据模型 / Build a data model with service layer
  test('L8b: builds a TypeScript service layer with data models', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l8-data-service');

    const events = await runAgentTest({
      ...env,
      task: [
        'Build a TypeScript data model and service layer in the src/ directory. Verify each step:',
        '(1) Create src/models.ts with interfaces: User { id: number, name: string, email: string } and Product { id: number, title: string, price: number }.',
        '(2) Create src/database.ts with a Database class that stores User[] and Product[] arrays, with add, remove, getAll methods.',
        '(3) Create src/user-service.ts wrapping database with addUser(name,email) and getUserByEmail(email) methods.',
        '(4) Create src/product-service.ts wrapping database with addProduct(title,price) and getProductsByPriceRange(min,max) methods.',
        '(5) Create src/index.ts barrel exports for all modules.',
        '(6) Use read_file to verify every file has correct content.',
        '(7) Final summary.',
      ].join(' '),
    });

    const modelsPath = join(env.workspace, 'src/models.ts');
    expect(existsSync(modelsPath)).toBe(true);
    const modelsContent = readFileSync(modelsPath, 'utf8');
    expect(modelsContent).toContain('User');
    expect(modelsContent).toContain('Product');

    const dbPath = join(env.workspace, 'src/database.ts');
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toContain('class');

    const userServicePath = join(env.workspace, 'src/user-service.ts');
    expect(existsSync(userServicePath)).toBe(true);

    const indexPath = join(env.workspace, 'src/index.ts');
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toContain('export');

    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L8b data-service');
  }, 900_000);

  // L8c: 构建 API 客户端库及错误处理，并生成文档 / Build API client lib with error handling and docs
  test('L8c: builds a TypeScript API client library with error handling and documentation', async () => {
    await ensureRealModelAvailable();
    const env = createEnv('l8-api-client');

    const events = await runAgentTest({
      ...env,
      task: [
        'Build a TypeScript API client library with error handling in the src/ directory. Work in phases:',
        '(1) Create tsconfig.json.',
        '(2) Create src/errors.ts with custom error classes: ApiError (status, body), NetworkError (cause), ValidationError (field, message), all extending a BaseError.',
        '(3) Create src/http.ts with typed fetchJson<T>(url) and postJson<T>(url, body) functions that parse JSON responses and throw ApiError on non-ok status.',
        '(4) Create src/retry.ts with a retry<T>(fn, options: { maxRetries, backoffMs }) that retries on NetworkError with exponential backoff.',
        '(5) Update src/http.ts to use retry from src/retry.ts for fetchJson.',
        '(6) Create src/client.ts with a simple ApiClient class wrapping http functions with a baseUrl.',
        '(7) Create src/index.ts barrel exports.',
        '(8) Create README.md documenting all exports with usage examples.',
        '(9) Use read_file on every src file to verify imports and exports are consistent.',
        '(10) Final summary.',
      ].join(' '),
    });

    const errorsPath = join(env.workspace, 'src/errors.ts');
    expect(existsSync(errorsPath)).toBe(true);
    expect(readFileSync(errorsPath, 'utf8')).toContain('class');

    const httpPath = join(env.workspace, 'src/http.ts');
    expect(existsSync(httpPath)).toBe(true);
    const httpContent = readFileSync(httpPath, 'utf8');
    expect(httpContent).toContain('fetchJson');
    expect(httpContent).toContain('retry');

    const retryPath = join(env.workspace, 'src/retry.ts');
    expect(existsSync(retryPath)).toBe(true);
    expect(readFileSync(retryPath, 'utf8')).toContain('retry');

    const clientPath = join(env.workspace, 'src/client.ts');
    expect(existsSync(clientPath)).toBe(true);

    const indexPath = join(env.workspace, 'src/index.ts');
    expect(existsSync(indexPath)).toBe(true);

    const readmePath = join(env.workspace, 'README.md');
    if (existsSync(readmePath)) {
      expect(readFileSync(readmePath, 'utf8').length).toBeGreaterThan(0);
    }

    expect(events.some((e) => e.type === 'final')).toBe(true);
    logCacheAggregate(events, 'L8c api-client');
  }, 900_000);
});

// ============================================================================
// Retry: 模型服务错误恢复 / Model service error recovery
//
// 通过本地 HTTP 代理模拟瞬时 5xx 错误，验证模型调用能自动重试并最终成功。
// 覆盖链路：代理 503 → isTransientModelConnectionError → withTransientModelRetry → 真实 API
// Use a local HTTP proxy to simulate transient 5xx errors, verifying retry recovery.
// Covered: proxy 503 → isTransientModelConnectionError → withTransientModelRetry → real API.
// ============================================================================
describe('Retry: model service error recovery', () => {
  test('recovers from transient 503 errors and reports retry events', async () => {
    await ensureRealModelAvailable();
    const config = loadRealModelConfig();

    let requestCount = 0;
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        if (requestCount <= 2) {
          return new Response(JSON.stringify({ error: { message: 'Service Unavailable' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const url = new URL(req.url);
        const targetUrl = `${config.baseURL}${url.pathname}${url.search}`;
        const headers = new Headers(req.headers);
        headers.delete('host');
        try {
          const body = await req.text();
          return await fetch(targetUrl, {
            method: req.method,
            headers,
            body: body || undefined,
          });
        } catch (_) {
          return new Response('Bad Gateway', { status: 502 });
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
        maxAttempts: number,
        error: unknown,
        delayMs: number,
      ) => {
        retryEvents.push({
          attempt,
          maxAttempts,
          error: String(error).slice(0, 200),
          delayMs,
        });
      };

      const response = await model.invoke([new HumanMessage("Reply with 'hello' only")]);

      expect(retryEvents.length).toBe(2);
      expect(retryEvents[0]!.attempt).toBe(1);
      expect(retryEvents[1]!.attempt).toBe(2);
      expect(requestCount).toBe(3);
      expect(String(response.content).toLowerCase()).toMatch(/hello/);
    } finally {
      proxy.stop();
    }
  }, 120_000);
});

// ============================================================================
// 测试辅助函数 / Test helpers
// ============================================================================

function createEnv(name: string): ContinueInput {
  const root = join(tmpdir(), `openpx-${name}`);
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'data');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  return {
    userId: `${name}-user`,
    threadId: `${name}-thread`,
    workspace,
    checkpointPath: join(dataDir, 'checkpoints.sqlite'),
    config: loadRealModelConfig(),
    shellExecutor: createTestShellExecutor(),
  };
}

interface RunAgentTestInput extends ContinueInput {
  task: string;
  autoApprove?: boolean;
  inputAnswer?: string;
  authorizationOverride?: AuthorizationOverride;
  mode?: 'auto' | 'write' | 'builder';
  grant?: 'approve_once' | 'same_command' | 'full_access';
}

async function runAgentTest(input: RunAgentTestInput): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const autoApprove = input.autoApprove !== false;
  const inputAnswer = input.inputAnswer ?? 'test answer from provider';
  const grant = input.grant ?? 'approve_once';

  const provider: UserInputProvider = {
    onEvent(event: AgentEvent) {
      events.push(event);
    },
    async requestAction(payload: InterruptPayload): Promise<UserAction> {
      if (payload.kind === 'approval') {
        return autoApprove ? { type: 'approve', grant } : { type: 'reject' };
      }
      return { type: 'input', text: inputAnswer };
    },
  };

  const generator = runAgent(provider, {
    task: input.task,
    userId: input.userId,
    threadId: input.threadId,
    workspace: input.workspace,
    checkpointPath: input.checkpointPath,
    config: input.config,
    shellExecutor: input.shellExecutor,
    mode: input.mode,
    authorizationOverride: input.authorizationOverride,
  });

  for await (const _ of generator) {
    /* drive generator — events collected by provider.onEvent */
  }

  return events;
}

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
      const content = Buffer.from(encoded, 'base64').toString('utf8');
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
      const target = isAbsolute(readMatch[1]!)
        ? readMatch[1]!
        : join(input.workspace, readMatch[1]!);
      if (!existsSync(target)) {
        return {
          ok: false,
          command: input.command,
          exitCode: 1,
          stdout: '',
          stderr: `File not found: ${readMatch[1]!}`,
        };
      }
      return {
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: readFileSync(target, 'utf8'),
        stderr: '',
      };
    }

    return shellTool(input);
  };
}

function parseBunWriteCommand(command: string): { path: string; content: string } | null {
  if (!command.includes('fs.writeFileSync')) return null;
  const args =
    command.match(/'((?:'\\''|[^'])*)'/g)?.map((arg) => unescapePosixShellArg(arg.slice(1, -1))) ??
    [];
  const encoded = args.at(-1);
  const path = args.at(-2);
  if (!path || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  return { path, content: Buffer.from(encoded, 'base64').toString('utf8') };
}

function unescapePosixShellArg(value: string): string {
  return value.replaceAll("'\\''", "'");
}

function logCacheAggregate(events: AgentEvent[], label: string): void {
  let calls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalHit = 0;
  let totalMiss = 0;
  for (const e of events) {
    if (e.type !== 'cache_metrics') continue;
    const d = e.data;
    calls++;
    totalInput += d.inputTokens;
    totalOutput += d.outputTokens ?? 0;
    totalHit += d.cacheHitTokens;
    totalMiss += d.cacheMissTokens;
  }
  if (calls === 0) return;
  const totalTokens = totalInput + totalOutput;
  const rate = totalInput > 0 ? (totalHit / totalInput) * 100 : 0;
  console.log(
    `[cache] ${label.padEnd(20)} ${rate.toFixed(1)}%  (hit: ${totalHit}, miss: ${totalMiss}, input: ${totalInput}, output: ${totalOutput}, total: ${totalTokens}, ${calls} calls)`,
  );
}

function parsePlainWriteCommand(command: string): { path: string; content: string } | null {
  const setContent = command.match(
    /Set-Content\s+(?:-(?:LiteralPath|Path)\s+)?["']?([^"'\s]+)["']?\s+-Value\s+["']([^"']*)["']/i,
  );
  if (setContent) return { path: setContent[1]!, content: setContent[2]! };

  const writeAllText = command.match(
    /\[System\.IO\.File\]::WriteAllText\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/i,
  );
  if (writeAllText) return { path: writeAllText[1]!, content: writeAllText[2]! };

  const redirect = command.match(/echo\s+["']([^"']*)["']\s*>\s*["']?([^"'\s]+)["']?/i);
  if (redirect) return { path: redirect[2]!, content: redirect[1]! };

  return null;
}
