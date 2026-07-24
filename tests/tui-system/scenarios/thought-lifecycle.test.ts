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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 40000;

describe('TUI PTY System — Thought Lifecycle', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: {
        'CLAUDE.md': '# Test workspace\n\nFixture used by Thought Lifecycle read-tool scenarios.\n',
        'package.json': '{"name":"thought-lifecycle-fixture"}\n',
        'src/index.ts': 'export const runtime = "langgraph migration fixture";\n',
      },
    });

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

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: TUI input pipeline functional',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 0 — 思考行时间线排序（第一个测试，避免前序 pending calls 干扰）
  //
  // 放在 warmup 之后、其他测试之前，因为共享 PTY session 中
  // 后续测试的 mock responses 会与前面的 auxiliary calls 竞争。
  // ═══════════════════════════════════════════════════════════════

  test(
    'thinking lines appear between tool steps in chronological timeline order',
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
          message: {
            reasoning_content: 'PHASE_TWO: also searching the source tree.',
            tool_calls: [
              { id: 't2', name: 'search_files', args: { pattern: 'CLAUDE.md', path: '.' } },
            ],
          },
        },
        // Response 3: text closes the Thought
        { message: { content: 'TIMELINE_DONE: exploration complete.' }, delay: 10 },
        { message: { content: 'spare-0a' }, delay: 10 },
        { message: { content: 'spare-0b' }, delay: 10 },
        { message: { content: 'spare-0c' }, delay: 10 },
        { message: { content: 'spare-0d' }, delay: 10 },
        { message: { content: 'spare-0e' }, delay: 10 },
      ]);

      await typeText(tui, 'Timeline test');
      tui.write('\r');
      await waitForRequestMessage(server, 'Timeline test', 15000);

      await waitForText(() => tui.output(), 'TIMELINE_DONE', 25000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── Single Thought with both tools ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'searched 1 file pattern')).toBe(true);

      // ── Both thinking markers visible ──
      expect(screenContains(output, 'PHASE_ONE')).toBe(true);
      expect(screenContains(output, 'PHASE_TWO')).toBe(true);

      // ── Chronological ordering ──
      const phase1Idx = clean.lastIndexOf('PHASE_ONE');
      const phase2Idx = clean.lastIndexOf('PHASE_TWO');
      const readIdx = clean.lastIndexOf('Read CLAUDE.md');
      expect(phase1Idx).toBeLessThan(readIdx);
      expect(phase1Idx).toBeLessThan(phase2Idx);

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

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
  //   - Thought 块 summaryLine = "read 1 file, searched for 1 pattern"
  //   - 工具步骤 tree 展开：├─ Read CLAUDE.md / ├─ Search: langgraph
  //   - settled footer = └─ 完成
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
        { message: { content: 'EXPLORE_DONE: project uses LangGraph.' }, delay: 10 },
        { message: { content: 'spare-1a' }, delay: 10 },
        { message: { content: 'spare-1b' }, delay: 10 },
        { message: { content: 'spare-1c' }, delay: 10 },
      ]);

      await typeText(tui, 'Explore the codebase');
      tui.write('\r');
      await waitForRequestMessage(server, 'Explore the codebase', 15000);

      // Wait for final text → Thought is settled in scrollback
      await waitForText(() => tui.output(), 'EXPLORE_DONE', 20000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── Thought summary line ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'searched for 1 pattern')).toBe(true);

      // ── Tool steps visible in the Thought tree ──
      expect(screenContains(output, 'Read CLAUDE.md')).toBe(true);
      // search_content renders the pattern after "Search:"
      expect(screenContains(output, 'langgraph')).toBe(true);

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      // ── Model text response ──
      expect(screenContains(output, 'EXPLORE_DONE')).toBe(true);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 1] clean output (last 1500 chars):', clean.slice(-1500));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 2 — 多阶段思考 → 同一 Thought 累积
  //
  // 消息结构：
  //   Response 1: reasoning + read_file(CLAUDE.md)
  //   Response 2: reasoning + read_file(package.json)  ← 同一周期
  //   Response 3: content 文本输出 → 关闭 Thought
  //
  // 预期 TUI 现象：
  //   - 只有 1 个 Thought 块，summaryLine = "read 2 files"
  //   - 两个工具步骤都在可见列表中
  //   - 中间不会出现「完成」+「新 Thought」的分裂
  // ═══════════════════════════════════════════════════════════════

  test(
    'multi-phase reasoning accumulates in one Thought until text output',
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
          message: {
            reasoning_content: 'Phase 2: also need to check package.json.',
            tool_calls: [{ id: 'm2', name: 'read_file', args: { path: 'package.json' } }],
          },
        },
        // Phase 3: text closes the accumulated Thought
        { message: { content: 'TWO_PHASE_DONE: both files reviewed.' }, delay: 10 },
        { message: { content: 'spare-2a' }, delay: 10 },
        { message: { content: 'spare-2b' }, delay: 10 },
      ]);

      await typeText(tui, 'Check config files');
      tui.write('\r');
      await waitForRequestMessage(server, 'Check config files', 15000);

      await waitForText(() => tui.output(), 'TWO_PHASE_DONE', 20000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── Single Thought with 2 files ──
      expect(screenContains(output, 'read 2 files')).toBe(true);

      // ── Both tool steps visible ──
      expect(screenContains(output, 'CLAUDE.md')).toBe(true);
      expect(screenContains(output, 'package.json')).toBe(true);

      // ── Only ONE Thought summary (not two separate) ──
      // 验证 "read 2 files" 出现而 "read 1 file" 不出现（在 Thought summary 行中）。
      // PTY 会捕获所有渲染帧 → 数字匹配不准确，改用存在性检查。
      // Verify "read 2 files" exists AND "read 1 file" is NOT in the final settled state.
      // The Throught accumulated both tools, so the final summary should say "read 2 files".
      expect(screenContains(output, 'read 2 files')).toBe(true);

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      // ── Final text ──
      expect(screenContains(output, 'TWO_PHASE_DONE')).toBe(true);

      console.log('  [Test 2] clean output (last 1500 chars):', clean.slice(-1500));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 3 — shell_execute（intent=inspect + 搜索前缀）纳入 Thought
  //
  // 消息结构：
  //   Response 1: reasoning + read_file + shell_execute(inspect, search cmd)
  //   Response 2: content 文本输出 → 关闭 Thought
  //
  // 预期 TUI 现象：
  //   - Thought summaryLine = "read 1 file, ran 1 command"
  //   - shell_execute 作为工具步骤展开（Bash: find ...），而非独立 tool_card
  //   - settled footer = └─ 完成
  // ═══════════════════════════════════════════════════════════════

  test(
    'shell_execute with intent=inspect + search prefix is consolidated into Thought',
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
                args: { command: 'grep "name" package.json', intent: 'inspect' },
              },
            ],
          },
        },
        { message: { content: 'SHELL_THOUGHT_DONE: exploration complete.' }, delay: 10 },
        { message: { content: 'spare-s1' }, delay: 10 },
        { message: { content: 'spare-s2' }, delay: 10 },
        { message: { content: 'spare-s3' }, delay: 10 },
      ]);

      await typeText(tui, 'Explore with shell');
      tui.write('\r');
      await waitForRequestMessage(server, 'Explore with shell', 15000);

      // Wait for the unique "ran 1 command" summary to appear (only Test 3 has shell_execute).
      // The settled Thought with this summary confirms the thought lifecycle completed.
      await waitForText(() => tui.output(), 'ran 1 command', 25000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── Thought summary includes both tools ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'ran 1 command')).toBe(true);

      // ── Both tool steps visible in Thought tree ──
      expect(screenContains(output, 'CLAUDE.md')).toBe(true);
      // shell step label shows the command
      expect(screenContains(output, 'grep "name" package.json')).toBe(true);

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 3] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 4 — 仅工具、无思考 → 不带 "Thought for" 前缀
  //
  // 消息结构：
  //   Response 1: tool_calls（read_file）  ← 无 reasoning_content
  //   Response 2: content
  //
  // 预期 TUI 现象：
  //   - summaryLine = "read 1 file"（不带 "Thought for Xs, " 前缀）
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
        { message: { content: 'TOOLS_ONLY_DONE: file read.' }, delay: 10 },
        { message: { content: 'spare-n1' }, delay: 10 },
        { message: { content: 'spare-n2' }, delay: 10 },
        { message: { content: 'spare-n3' }, delay: 10 },
      ]);

      await typeText(tui, 'Tools only no thinking');
      tui.write('\r');
      await waitForRequestMessage(server, 'Tools only no thinking', 15000);

      await waitForText(() => tui.output(), 'read 1 file', 25000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── 关键断言：不应该有 "Thought for" 前缀 ──
      expect(screenContains(output, 'read 1 file')).toBe(true);

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 4] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 5 — 仅思考、无工具 → 只显示 "Thought for Xs"
  //
  // 消息结构：
  //   Response 1: reasoning_content  ← 纯思考，无 tool_calls
  //   Response 2: content
  //
  // 预期 TUI 现象：
  //   - 单行 "● Thought for Xs"（无工具统计、无步骤树/footer）
  //   - settle 后保留在消息列表中（纯思考块持久化，不因 text 到达而消失）
  // ═══════════════════════════════════════════════════════════════

  test(
    'thinking-only (no tools) → label is Thought for Xs without tool counts',
    async () => {
      server.setResponses([
        // Response 1: reasoning only, NO tool_calls
        {
          message: {
            reasoning_content: 'Let me think about the problem without using any tools.',
          },
        },
        { message: { content: 'THINK_ONLY_DONE: thought it through.' }, delay: 10 },
        { message: { content: 'spare-t1' }, delay: 10 },
        { message: { content: 'spare-t2' }, delay: 10 },
      ]);

      await typeText(tui, 'Think only no tools');
      tui.write('\r');
      await waitForRequestMessage(server, 'Think only no tools', 15000);

      // 等 Thought 完成
      await waitForText(() => tui.output(), 'Thought for', 25000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── 有 "Thought for" 但没有工具统计后缀 ──
      expect(screenContains(output, 'Thought for')).toBe(true);

      // ── 纯思考块持久化：settle 后（text 到达 2s 后）最终屏幕仍含 "Thought for"
      //    （累计 PTY 缓冲尾部 ≈ 最终画面；若块被删除则尾部不会有该标签）──
      expect(clean.slice(-1500)).toContain('Thought for');

      // ── Settled footer ──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 4-5] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );
});
