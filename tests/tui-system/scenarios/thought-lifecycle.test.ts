/**
 * PTY System Test — Thought 预整合生命周期
 *
 * 验证 M0 TUI pre-consolidation 机制：
 * 1. reason + 探索工具 → 合并为一个 Thought 块，文本输出 → 关闭
 * 2. 多阶段思考 → 同一 Thought 内累积（中间不间断）
 * 3. 多轮对话 → 每轮产生独立的 Thought 块
 *
 * 模拟消息结构：
 *   每个 MockResponse 可含 reasoning_content / tool_calls / content，
 *   由 MockModelServer 以 SSE streaming 发送，模拟 DeepSeek-style 思考链。
 *
 *   完整的一轮对话 = 用户消息 → N 次模型调用（每轮含 reason+tool 或 content）
 *   → TUI 将同一个思考周期内的探索工具合并为一个 tool_summary Thought 块。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 40000;

describe('TUI PTY System — Thought Lifecycle', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: {
          mock: {
            type: 'deepseek',
            apiKey: 'test-key',
            baseURL: server.baseURL,
            model: 'mock-model',
            models: [{ name: 'mock-model', default: true, streaming: true }],
          },
        },
        model: { default: { provider: 'mock', name: 'mock-model' } },
        sandbox: { enabled: false },
      },
      files: {
        'CLAUDE.md': '# Test workspace\n\nFixture used by Thought Lifecycle read-tool scenarios.\n',
        'package.json': '{"name":"thought-lifecycle-fixture"}\n',
        'src/index.ts': 'export const runtime = "langgraph migration fixture";\n',
      },
    });

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 0 — 多轮探索跨模型调用聚合为单一阶段块（ADR-0030 / 规则 24）
  //
  // 放在其他测试之前，因为共享 PTY session 中
  // 后续测试的 mock responses 会与前面的 auxiliary calls 竞争。
  //
  // 消息结构：
  //   Response 1: PHASE_ONE 思考 + read_file(CLAUDE.md)
  //   Response 2: PHASE_TWO 思考 + search_files  ← 新一轮模型调用
  //   Response 3: 文本输出（阶段结束，最终回答脱离）
  //
  // 预期 TUI 现象（ADR-0030）：
  //   - model.requested 不再切分：两轮工具同块，标题
  //     "Thinking Xs · read 1 file, searched 1 file pattern"
  //   - 阶段块 settle 为单行摘要，最终回答为独立文本块
  // ═══════════════════════════════════════════════════════════════

  test(
    'multi-round exploration aggregates into one phase block across model calls (ADR-0030)',
    async () => {
      server.setResponses([
        // Response 1: Phase 1 thinking + first tool
        {
          message: {
            reasoning_content: 'PHASE_ONE: checking the project config.',
            tool_calls: [{ id: 't1', name: 'read_file', args: { path: 'CLAUDE.md' } }],
          },
        },
        // Response 2: Phase 2 thinking + second tool (same thought cycle)
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 't1', contentIncludes: ['Fixture used by Thought'] }],
          },
          message: {
            reasoning_content: 'PHASE_TWO: also searching the source tree.',
            tool_calls: [
              { id: 't2', name: 'search_files', args: { pattern: 'CLAUDE.md', path: '.' } },
            ],
          },
        },
        // Response 3: text closes the Thought
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 't2', contentIncludes: ['CLAUDE.md'] }],
          },
          message: { content: 'TIMELINE_DONE: exploration complete.' },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, 'Timeline test', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'TIMELINE_DONE', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── 单一阶段块：两轮工具合并统计（ADR-0030 / 规则 24）──
      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(screenContains(output, '· read 1 file, searched 1 file pattern')).toBe(true);

      // ── Settled 后工具步骤折叠，保留统计摘要 ──
      expect(screenContains(output, '└─ 完成')).toBe(false);
      expect(screenContains(output, 'TIMELINE_DONE')).toBe(true);

      console.log('  [Test 0] clean output (last 3000 chars):', clean.slice(-3000));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 1 — 基础 Thought 生命周期
  //
  // 消息结构：
  //   Response 1: reasoning + 2 个探索 tool_call（无 content）
  //   Response 2: content 文本输出（关闭 Thought）
  //
  // 预期 TUI 现象：
  //   - Thought 标题 = "Thinking Xs · read 1 file, searched for 1 pattern"（规则 22）
  //   - 工具步骤 tree 展开：├─ Read CLAUDE.md / ├─ Search: langgraph
  //   - settled 后无 footer
  //   - 模型回复文本可见
  // ═══════════════════════════════════════════════════════════════

  test(
    'single Thought: reasoning + exploration tools → text closes Thought',
    async () => {
      server.setResponses([
        // Response 1: thinking + exploration tool calls
        {
          message: {
            reasoning_content: 'Let me explore the codebase structure.',
            tool_calls: [
              { id: 'c1', name: 'read_file', args: { path: 'CLAUDE.md' } },
              { id: 'c2', name: 'search_content', args: { pattern: 'langgraph', path: 'src' } },
            ],
          },
        },
        // Response 2: plain text output → closes the Thought
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'c1', contentIncludes: ['Fixture used by Thought'] },
              { toolCallId: 'c2', contentIncludes: ['langgraph migration fixture'] },
            ],
          },
          message: { content: 'EXPLORE_DONE: project uses LangGraph.' },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, 'Explore the codebase', { timeout: 15000 });

      // Wait for final text → Thought is settled in scrollback
      await waitForText(() => tui.outputSinceLastAction(), 'EXPLORE_DONE', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── Thought 标题 = "Thinking Xs · <工具统计>"（规则 22）──
      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(screenContains(output, '· read 1 file, searched for 1 pattern')).toBe(true);

      // ── reasoning 正文始终隐藏，工具步骤 settle 后折叠 ──
      expect(screenContains(output, 'Let me explore the codebase structure.')).toBe(false);

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── Model text response ──
      expect(screenContains(output, 'EXPLORE_DONE')).toBe(true);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 1] clean output (last 1500 chars):', clean.slice(-1500));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 2 — 多阶段思考跨模型调用合并为一个阶段块（ADR-0030 / 规则 24）
  //
  // 消息结构：
  //   Response 1: reasoning + read_file(CLAUDE.md)
  //   Response 2: reasoning + read_file(package.json)  ← 新一轮模型调用
  //   Response 3: content 文本输出（阶段结束）
  //
  // 预期 TUI 现象（ADR-0030）：
  //   - 两轮合并为单个 "Thinking Xs · read 2 files" 阶段块
  //     （模型调用是 kernel 实现细节，不是用户感知的思考边界）
  //   - 两个工具步骤同块可见
  // ═══════════════════════════════════════════════════════════════

  test(
    'multi-phase reasoning merges into one phase block across model calls (ADR-0030)',
    async () => {
      server.setResponses([
        // Phase 1
        {
          message: {
            reasoning_content: 'Phase 1: checking the main config.',
            tool_calls: [{ id: 'm1', name: 'read_file', args: { path: 'CLAUDE.md' } }],
          },
        },
        // Phase 2 — same thought cycle
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 'm1', contentIncludes: ['Fixture used by Thought'] }],
          },
          message: {
            reasoning_content: 'Phase 2: also need to check package.json.',
            tool_calls: [{ id: 'm2', name: 'read_file', args: { path: 'package.json' } }],
          },
        },
        // Phase 3: text closes the accumulated Thought
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 'm2', contentIncludes: ['thought-lifecycle-fixture'] }],
          },
          message: { content: 'TWO_PHASE_DONE: both files reviewed.' },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, 'Check config files', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'TWO_PHASE_DONE', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── 两轮合并统计为 "read 2 files"（ADR-0030 跨调用聚合）──
      expect(screenContains(output, '· read 2 files')).toBe(true);
      expect(screenContains(output, 'Thinking ')).toBe(true);

      // ── 工具步骤 settle 后折叠 ──

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── Final text ──
      expect(screenContains(output, 'TWO_PHASE_DONE')).toBe(true);

      console.log('  [Test 2] clean output (last 1500 chars):', clean.slice(-1500));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 3 — shell_execute 无 inspect intent 时使用独立工具块
  //
  // 消息结构：
  //   Response 1: reasoning + read_file + shell_execute(without inspect intent)
  //   Response 2: content 文本输出 → 关闭 Thought
  //
  // 预期 TUI 现象：
  //   - shell_execute 无 intent=inspect 时不纳入 Thought
  //   - read_file 保持探索摘要
  //   - shell_execute 使用独立 tool_card
  //   - 最终文本正常出现
  // ═══════════════════════════════════════════════════════════════

  test(
    'shell_execute keeps its governed tool lifecycle with a verified result',
    async () => {
      server.setResponses([
        {
          message: {
            reasoning_content: 'Let me explore the project structure with a shell command.',
            tool_calls: [
              { id: 's1', name: 'read_file', args: { path: 'CLAUDE.md' } },
              {
                id: 's2',
                name: 'shell_execute',
                args: { command: 'grep "name" package.json' },
              },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 's1', contentIncludes: ['Fixture used by Thought'] },
              { toolCallId: 's2', contentIncludes: ['thought-lifecycle-fixture'] },
            ],
          },
          message: { content: 'SHELL_THOUGHT_DONE: exploration complete.' },
          delay: 10,
        },
      ]);

      const shellFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Explore with shell', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'SHELL_THOUGHT_DONE', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);
      const shellHistory = tui.screenFramesSince(shellFrames).join('\n');

      // ── shell_execute without inspect intent stays as independent tool_card ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'ran 1 command')).toBe(false);
      expect(screenContains(shellHistory, 'thought-lifecycle-fixture')).toBe(true);
      expect(screenContains(shellHistory, 'exit: error')).toBe(false);

      // ── 独立工具卡完成后可折叠；最终回答仍可见 ──
      expect(screenContains(output, 'SHELL_THOUGHT_DONE')).toBe(true);

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 3] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 4 — 仅工具、无思考 → 不带 "Thinking" 前缀
  //
  // 消息结构：
  //   Response 1: tool_calls（read_file）  ← 无 reasoning_content
  //   Response 2: content
  //
  // 预期 TUI 现象：
  //   - summaryLine = "read 1 file"（不带 "Thinking Xs, " 前缀）
  //   - 无 Thinking preview 行
  // ═══════════════════════════════════════════════════════════════

  test(
    'tools-only (no reasoning) → label is bare tool count without Thought prefix',
    async () => {
      server.setResponses([
        // Response 1: tool_call only, NO reasoning_content
        {
          message: {
            tool_calls: [{ id: 'n1', name: 'read_file', args: { path: 'CLAUDE.md' } }],
          },
        },
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 'n1', contentIncludes: ['Fixture used by Thought'] }],
          },
          message: { content: 'TOOLS_ONLY_DONE: file read.' },
          delay: 10,
        },
      ]);

      const toolsOnlyFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Tools only no thinking', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'TOOLS_ONLY_DONE: file read.', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── 关键断言：不应该有 "Thinking" 前缀 ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      const actionLocalRender = tui
        .screenFramesSince(toolsOnlyFrames)
        .map((frame) => frame.slice(Math.max(0, frame.lastIndexOf('❯ Tools only no thinking'))))
        .join('\n');
      expect(screenContains(actionLocalRender, 'Thinking ')).toBe(false);

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 4] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 5 — 仅思考、无工具 → "Thinking Xs" 并入回答题头
  //
  // 消息结构：
  //   Response 1: reasoning_content  ← 纯思考，无 tool_calls
  //   Response 2: content
  //
  // 预期 TUI 现象（ADR-0026）：
  //   - "Thinking Xs" 作为回答文本的暗色题头行（无圆点、无独立块）
  //   - settle 后随文本块保留在消息列表中（时长并入题头，信息不丢失）
  // ═══════════════════════════════════════════════════════════════

  test(
    'thinking-only (no tools) → label is Thinking Xs without tool counts',
    async () => {
      server.setResponses([
        // Response 1: reasoning only, NO tool_calls
        {
          message: {
            reasoning_content: 'Let me think about the problem without using any tools.',
          },
        },
        { message: { content: 'THINK_ONLY_DONE: thought it through.' }, delay: 10 },
      ]);

      await submitUserMessage(tui, server, 'Think only no tools', { timeout: 15000 });

      // 等 Thought 完成
      await waitForText(() => tui.outputSinceLastAction(), 'Thinking ', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── 有 "Thinking" 但没有工具统计后缀 ──
      expect(screenContains(output, 'Thinking ')).toBe(true);

      // ── 纯思考块持久化：settle 后（text 到达 2s 后）最终屏幕仍含 "Thinking"
      //    （累计 PTY 缓冲尾部 ≈ 最终画面；若块被删除则尾部不会有该标签）──
      expect(clean.slice(-1500)).toContain('Thinking ');

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 4-5] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );
});
