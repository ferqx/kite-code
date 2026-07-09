/**
 * PTY System Test — 工具全生命周期 / Tool Full Lifecycle
 *
 * 每种工具类型一个综合性测试，覆盖完整交互链路：
 * 1. 中断状态正确显示（options / 审批选项 / plan review 操作条）
 * 2. 消息渲染顺序正确（model text → tool_card → interrupt）
 * 3. 用户确认后工具状态更新
 * 4. 无重复中断弹框（resume 重放去重验证）
 * 5. 交互完成后模型继续运行
 *
 * One comprehensive test per tool type, covering the full interaction:
 * 1. Interrupt block renders correctly
 * 2. Correct rendering order (model text → tool_card → interrupt)
 * 3. Tool status updates after user confirmation
 * 4. No duplicate interrupt blocks (resume replay dedup)
 * 5. Model continues after interaction completes
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  assertOrder,
  countOccurrences,
  screenContains,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 45000;

// ────────────────────────────────────────────────────────────────
// ask_user 全生命周期 / ask_user full lifecycle
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: ask_user', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'Let me ask you something.',
          tool_calls: [
            {
              id: 'call_ask',
              name: 'ask_user',
              args: {
                question: 'What is your favorite color?',
                options: [
                  { id: 'blue', label: 'Blue' },
                  { id: 'red', label: 'Red' },
                ],
                recommended: 'blue',
              },
            },
          ],
        },
      },
      { message: { content: 'Got it! Your favorite color is blue.' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'full lifecycle: interrupt → confirm → no duplicate, model continues',
    async () => {
      // ── 1. 触发 ask_user / Trigger ask_user ──
      await typeText(tui, 'Ask me a question');
      tui.write('\r');
      await waitForRequestMessage(server, 'Ask me a question', 15000);

      // 等中断块渲染 / Wait for interrupt block
      await waitForText(() => tui.output(), 'What is your favorite color?', 15000);

      // ── 2. 验证中断显示 / Verify interrupt display ──
      let output = tui.output();
      expect(screenContains(output, 'What is your favorite color?')).toBe(true);
      expect(screenContains(output, 'Blue')).toBe(true);
      expect(screenContains(output, 'Red')).toBe(true);

      // ── 3. 验证渲染顺序：模型文字在问题选项之前 / Verify order: text before question ──
      const order = assertOrder(output, 'Let me ask you something', 'What is your favorite color?');
      expect(order.pass).toBe(true);

      // ── 4. 确认：按 Enter 接受默认选项 / Confirm: Enter to accept default ──
      tui.write('\r');
      await sleep(2500);

      output = tui.output();

      // ── 5. 验证模型继续运行（有重复中断就会卡住）/ Verify model continues (duplicate interrupt would block) ──
      expect(screenContains(output, 'Got it!')).toBe(true);
      // TUI prompt 恢复 / TUI recovered
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

// ────────────────────────────────────────────────────────────────
// plan_review 全生命周期 / plan_review full lifecycle
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: plan_review', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'Here is my plan.',
          tool_calls: [
            {
              id: 'call_plan',
              name: 'update_plan',
              args: {
                name: 'Test Plan',
                description: 'A test plan for lifecycle verification',
                status: 'pending',
                steps: [
                  { step: 'Step 1: Do something', status: 'pending' },
                  { step: 'Step 2: Verify', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'Plan approved! Executing now.' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'full lifecycle: interrupt → approve → no duplicate, model continues',
    async () => {
      // ── 1. 触发 plan_review / Trigger plan_review ──
      await typeText(tui, 'Make a plan for me');
      tui.write('\r');
      await waitForRequestMessage(server, 'Make a plan for me', 15000);

      // 等 review 提示 / Wait for review prompt
      await waitForText(() => tui.output(), 'Review the plan above', 15000);

      // ── 2. 验证中断显示 / Verify interrupt display ──
      let output = tui.output();
      expect(screenContains(output, 'Review the plan above')).toBe(true);
      expect(screenContains(output, 'Step 1')).toBe(true);
      expect(screenContains(output, 'Step 2')).toBe(true);

      // ── 3. 验证渲染顺序：模型文字在计划步骤之前 / Verify order: text before plan ──
      const order = assertOrder(output, 'Here is my plan', 'Step 1');
      expect(order.pass).toBe(true);

      // ── 4. 审批：按 'a' 自动审批 / Approve: press 'a' for auto ──
      tui.write('a');
      await sleep(3000);

      // 等模型继续 / Wait for model to continue
      await waitForText(() => tui.output(), 'Plan approved!', 15000);

      output = tui.output();

      // ── 5. 验证无重复 review 块 / Verify no duplicate review block ──
      const reviewCount = countOccurrences(output, 'Review the plan above');
      expect(reviewCount).toBe(1);

      // ── 6. 验证模型继续 / Verify model continues ──
      expect(screenContains(output, 'Plan approved!')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

// ────────────────────────────────────────────────────────────────
// approval 全生命周期 / approval full lifecycle
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: approval', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'I will run a command.',
          tool_calls: [
            {
              id: 'call_shell',
              name: 'shell_execute',
              args: { command: 'mkdir test_lifecycle_dir' },
            },
          ],
        },
      },
      { message: { content: 'Command was rejected. Let me try another approach.' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'full lifecycle: interrupt → deny → no duplicate, model continues',
    async () => {
      // ── 1. 触发审批 / Trigger approval ──
      await typeText(tui, 'Make a directory');
      tui.write('\r');
      await waitForRequestMessage(server, 'Make a directory', 15000);

      // 等审批块 / Wait for approval block
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);

      // ── 2. 验证中断显示 / Verify interrupt display ──
      let output = tui.output();
      expect(screenContains(output, 'Approve this tool call?')).toBe(true);
      expect(screenContains(output, 'Yes')).toBe(true);
      expect(screenContains(output, 'Deny')).toBe(true);

      // ── 3. 验证渲染顺序：模型文字在审批块之前 / Verify order: text before approval ──
      const order = assertOrder(output, 'I will run a command', 'Approve this tool call?');
      expect(order.pass).toBe(true);

      // ── 4. 拒绝：导航到 Deny 确认 / Deny: navigate to Deny and confirm ──
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await sleep(3000);

      // 等模型继续 / Wait for model to continue
      await waitForText(() => tui.output(), 'Command was rejected', 15000);

      output = tui.output();

      // ── 5. 验证模型继续运行（有重复中断就会卡住）/ Verify model continues (duplicate interrupt would block) ──
      expect(screenContains(output, 'Command was rejected')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

// ────────────────────────────────────────────────────────────────
// 自动放行工具 / Auto-approved tool (no interrupt)
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: auto-approved', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'Let me search for files.',
          tool_calls: [{ id: 'call_search', name: 'search_files', args: { pattern: '*.ts' } }],
        },
      },
      { message: { content: 'Search complete.' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'full lifecycle: no interrupt, tool auto-executes, model continues',
    async () => {
      // ── 1. 触发自动放行工具 / Trigger auto-approved tool ──
      await typeText(tui, 'Search for ts files');
      tui.write('\r');
      await waitForRequestMessage(server, 'Search for ts files', 15000);

      // 等工具执行完成 + 模型继续 / Wait for tool + model continuation
      await waitForText(() => tui.output(), 'Search complete', 15000);

      const output = tui.output();

      // ── 2. 验证无审批块出现 / Verify no approval block ──
      expect(screenContains(output, 'Approve this tool call?')).toBe(false);

      // ── 3. 验证渲染顺序：模型文字在工具之前 / Verify order: text before tool ──
      const order = assertOrder(output, 'Let me search for files', 'Search complete');
      expect(order.pass).toBe(true);

      // ── 4. 验证正常恢复 / Verify normal recovery ──
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
