/**
 * PTY System Test — Thought 预整合生命周期
 *
 * 验证客户端安全投影下的工具聚合生命周期：工具类别仍可合并，最终回答仍
 * 可见；reasoning 文本不会作为 RuntimeClientEvent 的展示数据泄漏。
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
import {
  submitCommand,
  submitUserMessage,
  submitUserMessageForDeferredDelivery,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

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
        // Thought rendering is independent from sandbox qualification. Use the
        // canonical Full interaction mode so this PTY suite remains portable;
        // restricted Shell sandbox admission is covered by the platform and
        // sandbox-mode contract suites.
        interactionMode: 'full',
        sandbox: { enabled: false },
      },
      files: {
        'CLAUDE.md': '# Test workspace\n\nFixture used by Thought Lifecycle read-tool scenarios.\n',
        'README.md': '# Kite Code\n\nA controllable coding agent.\n',
        'docs/README.md': '# Documentation\n\nCurrent documentation index.\n',
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
  // Test 0 — 多次模型调用仍归入同一个探索阶段
  //
  // 放在其他测试之前，因为共享 PTY session 中
  // 后续测试的 mock responses 会与前面的 auxiliary calls 竞争。
  //
  // 消息结构：
  //   Response 1: PHASE_ONE 思考 + read_file(CLAUDE.md)
  //   Response 2: PHASE_TWO 思考 + search_files  ← 新一轮模型调用
  //   Response 3: 文本输出（阶段结束，最终回答脱离）
  //
  // 预期 TUI 现象（ADR-0045 / ADR-0169）：
  //   - reasoning completed 后才显示，工具活动在同一窗口覆盖 reasoning
  //   - 带工具响应的流式正文保留归属但不渲染
  //   - 阶段块 settle 后只保留单行统计，最终回答为独立文本块
  // ═══════════════════════════════════════════════════════════════

  test(
    'streamed narration stays hidden across server-owned exploration groups',
    async () => {
      server.setResponses([
        // Response 1: Phase 1 thinking + first tool
        {
          message: {
            reasoning_content: 'PHASE_ONE: checking the project config.',
            content: '先查看项目入口和核心配置。',
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
            content: '继续搜索源码和文档目录。',
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

      // Reasoning and tool activity share one transient window. Tool-bearing
      // narration is not accumulated into the archived Thought.
      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'searched 1 file pattern')).toBe(true);
      expect(screenContains(output, 'read 1 file, searched 1 file pattern')).toBe(false);
      expect(screenContains(output, '先查看项目入口和核心配置。')).toBe(false);
      expect(screenContains(output, '继续搜索源码和文档目录。')).toBe(false);
      expect(screenContains(output, 'PHASE_ONE')).toBe(false);
      expect(screenContains(output, 'PHASE_TWO')).toBe(false);
      const lines = clean.split('\n').map((line) => line.trim());
      expect(lines.filter((line) => line.startsWith('Thinking '))).toHaveLength(1);

      // ── Settled 后工具步骤折叠，保留统计摘要 ──
      expect(screenContains(output, '└─ 完成')).toBe(false);
      expect(screenContains(output, 'TIMELINE_DONE')).toBe(true);

      console.log('  [Test 0] clean output (last 3000 chars):', clean.slice(-3000));
    },
    TIMEOUT,
  );

  test(
    'classifies an exploration answer and preserves completed scrolling across two turns',
    async () => {
      const longTail = Array.from(
        { length: 55 },
        (_, index) =>
          `SCROLL_HISTORY_LINE_${String(index + 1).padStart(2, '0')}: completed detail.`,
      ).join('\n\n');
      server.setResponses([
        {
          message: {
            reasoning_content: 'Reading one file before the final response.',
            tool_calls: [
              { id: 'stream-after-tool', name: 'read_file', args: { path: 'README.md' } },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'stream-after-tool', contentIncludes: ['A controllable coding agent'] },
            ],
          },
          message: {
            reasoning_chunks: ['Composing the final response.'],
            content_chunks: [
              'FINAL_COMPONENT_FIRST: visible paragraph.\n\n',
              'FINAL_COMPONENT_SECOND: visible before completion.\n\n',
              `${longTail}\n\nFINAL_COMPONENT_LAST: visible before terminal.\n\nBUFFERED_TERMINAL_TAIL`,
            ],
          },
          // Keep a deterministic observation window after each content frame,
          // especially after the final delta and before stop/[DONE].
          chunk_delay: 300,
          stream_frame_delays: [0, 300, 300, 1_500, 0, 0],
        },
      ]);

      await submitUserMessage(tui, server, 'Stream a long final answer after reading', {
        timeout: 15_000,
      });
      // The preceding exploration Thought owns these components until the
      // model terminal classifies the response as final. Their post-terminal
      // Static ownership is verified below through scroll stability.
      await waitForText(() => tui.scrollback(), 'FINAL_COMPONENT_LAST', 20_000);
      await waitForText(() => tui.scrollback(), 'BUFFERED_TERMINAL_TAIL', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10_000, 750);
      await tui.settleScreen();
      const expectCompletedScrollToStayIdle = async () => {
        const atBottom = tui.viewportPosition();
        expect(atBottom.baseY).toBeGreaterThan(0);
        expect(atBottom.viewportY).toBe(atBottom.baseY);

        await tui.scrollViewport(-20);
        const scrolled = tui.viewportPosition();
        expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
        const idleFrames = tui.markScreen();

        await tui.writeExact('\x1b[O');
        await tui.writeExact('\x1b[I');
        await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 2_000, 250, false);
        await tui.settleScreen();
        const afterIdleRenderWindow = tui.viewportPosition();
        expect(afterIdleRenderWindow.baseY - afterIdleRenderWindow.viewportY).toBe(
          scrolled.baseY - scrolled.viewportY,
        );
        expect(afterIdleRenderWindow.viewportY).toBeLessThan(afterIdleRenderWindow.baseY);
        expect(tui.screenFramesSince(idleFrames)).toEqual([]);
      };

      await expectCompletedScrollToStayIdle();

      const clean = stripAnsi(tui.scrollback());
      expect(clean.split('FINAL_COMPONENT_FIRST')).toHaveLength(2);
      expect(clean.split('FINAL_COMPONENT_SECOND')).toHaveLength(2);
      expect(clean.split('FINAL_COMPONENT_LAST')).toHaveLength(2);
      expect(clean.split('BUFFERED_TERMINAL_TAIL')).toHaveLength(2);

      await tui.scrollViewport(10_000);
      const secondTail = Array.from(
        { length: 45 },
        (_, index) =>
          `SECOND_TURN_HISTORY_${String(index + 1).padStart(2, '0')}: completed detail.`,
      ).join('\n\n');
      server.setResponses([
        {
          message: {
            content_chunks: [
              'SECOND_TURN_FIRST_COMPONENT: visible paragraph.\n\n',
              `${secondTail}\n\nSECOND_TURN_LAST_COMPONENT: visible paragraph.\n\nSECOND_TURN_BUFFERED_TAIL`,
            ],
          },
          chunk_delay: 300,
        },
      ]);
      await submitUserMessage(tui, server, 'Ask a second long question', { timeout: 15_000 });
      await waitForText(() => tui.scrollback(), 'SECOND_TURN_BUFFERED_TAIL', 15_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10_000, 750);
      await tui.settleScreen();

      await expectCompletedScrollToStayIdle();
      const twoTurnClean = stripAnsi(tui.scrollback());
      expect(twoTurnClean.split('SECOND_TURN_FIRST_COMPONENT')).toHaveLength(2);
      expect(twoTurnClean.split('SECOND_TURN_LAST_COMPONENT')).toHaveLength(2);
      expect(twoTurnClean.split('SECOND_TURN_BUFFERED_TAIL')).toHaveLength(2);
    },
    TIMEOUT,
  );

  test(
    'queueing a successor does not duplicate the active exploration Thought',
    async () => {
      server.setResponses([
        {
          message: {
            reasoning_content: 'Inspecting the project before answering.',
            content: 'First visible progress boundary.',
            tool_calls: [
              { id: 'queue-thought-read', name: 'read_file', args: { path: 'README.md' } },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              {
                toolCallId: 'queue-thought-read',
                contentIncludes: ['A controllable coding agent'],
              },
            ],
          },
          message: {
            reasoning_content: 'Searching after the first visible boundary.',
            content: 'Second visible progress boundary.',
            tool_calls: [
              {
                id: 'queue-thought-search',
                name: 'search_files',
                args: { path: '.', pattern: 'README.md' },
              },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 'queue-thought-search', contentIncludes: ['README.md'] }],
          },
          message: { content: 'QUEUE_THOUGHT_DONE' },
          delay: 2_000,
        },
        { message: { content: 'QUEUE_SUCCESSOR_DONE' }, delay: 10 },
      ]);

      await submitUserMessage(tui, server, 'Inspect before queued successor', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'searched 1 file pattern', 15_000);
      const beforeQueue = stripAnsi(tui.scrollback());
      const beforeThoughtCount = beforeQueue.match(/Thinking /g)?.length ?? 0;

      await submitUserMessageForDeferredDelivery(tui, server, 'Queued successor', {
        acceptWhen: (viewport) => screenContains(viewport, '↵ Queued successor'),
        timeout: 15_000,
      });
      const whileQueued = stripAnsi(tui.scrollback());
      expect(whileQueued.match(/Thinking /g)?.length ?? 0).toBe(beforeThoughtCount);
      expect(whileQueued.match(/read 1 file/g)?.length ?? 0).toBe(1);
      expect(whileQueued.match(/searched 1 file pattern/g)?.length ?? 0).toBe(1);

      await waitForText(() => tui.scrollback(), 'QUEUE_THOUGHT_DONE', 15_000);
      await waitForText(() => tui.scrollback(), 'QUEUE_SUCCESSOR_DONE', 15_000);
    },
    TIMEOUT,
  );

  test(
    'adjacent file searches retain active pattern detail and settle as one plural summary',
    async () => {
      server.setResponses([
        {
          message: {
            tool_calls: [
              { id: 'search-a', name: 'search_files', args: { pattern: 'CLAUDE.md' } },
              { id: 'search-b', name: 'search_files', args: { pattern: 'CLAUDE.md' } },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'search-a', contentIncludes: ['CLAUDE.md'] },
              { toolCallId: 'search-b', contentIncludes: ['CLAUDE.md'] },
            ],
          },
          message: { content: 'SEARCH_PAIR_DONE: both searches completed.' },
          delay: 10,
        },
      ]);

      const searchFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Search two file patterns', { timeout: 15000 });
      await waitForCondition(
        () =>
          tui
            .screenFramesSince(searchFrames)
            .some((frame) => screenContains(frame, 'Find CLAUDE.md')),
        'the active safe search summary to retain its bounded pattern detail',
        10_000,
      );
      await waitForText(() => tui.outputSinceLastAction(), 'SEARCH_PAIR_DONE', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      expect(screenContains(output, 'searched 2 file patterns')).toBe(true);
      expect(screenContains(output, 'searched 1 file pattern')).toBe(false);
      expect(tui.scrollback()).not.toContain('● Find');
      expect(screenContains(output, 'CLAUDE.md')).toBe(false);
      expect(screenContains(output, 'src/index.ts')).toBe(false);
      expect(screenContains(output, 'SEARCH_PAIR_DONE')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
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

      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(/read 1 file[\s\S]*searched for 1 pattern/.test(clean)).toBe(true);

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
  // Test 2 — 相邻探索请求保持同一个 Thought 边界
  //
  // 消息结构：
  //   Response 1: reasoning + read_file(CLAUDE.md)
  //   Response 2: reasoning + read_file(package.json)  ← 新一轮模型调用
  //   Response 3: content 文本输出（阶段结束）
  //
  // 预期 TUI 现象：
  //   - model.requested(requestId) 本身不是可见边界
  //   - 没有正文、独立工具或交互打断时，两轮探索合并为一个 Thought
  // ═══════════════════════════════════════════════════════════════

  test(
    'successive exploration requests retain distinct server groups',
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
      expect(screenContains(output, 'read 2 files')).toBe(false);
      expect(clean.match(/read 1 file/gu)?.length ?? 0).toBe(2);
      expect(clean.match(/Thinking \d+s · read 1 file/gu)?.length ?? 0).toBe(1);
      expect(screenContains(output, 'Phase 1:')).toBe(false);
      expect(screenContains(output, 'Phase 2:')).toBe(false);

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
  // Test 3 — 只读 shell_execute 使用服务端安全展示分类
  //
  // 消息结构：
  //   Response 1: reasoning + read_file + shell_execute(without inspect intent)
  //   Response 2: content 文本输出 → 关闭 Thought
  //
  // 预期 TUI 现象：
  //   - App Server 根据已解析的只读 effect 将 shell 纳入探索摘要
  //   - 客户端不根据原始 command 自行重做分类
  //   - 最终文本正常出现
  // ═══════════════════════════════════════════════════════════════

  test(
    'read-only shell_execute uses the server-owned exploration presentation',
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
      // ── 服务端将已验证的只读 shell 与 read 一起投影为探索摘要 ──
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'ran 1 command')).toBe(false);
      expect(screenContains(output, 'ran 1 shell command')).toBe(true);
      expect(screenContains(output, 'Bash')).toBe(false);
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

  test(
    'post-Bash searches and later reasoning form one exploration thought',
    async () => {
      server.setResponses([
        {
          message: {
            content: 'I will inspect one command, then finish the remaining searches.',
            tool_calls: [
              {
                id: 'post-bash-shell',
                name: 'shell_execute',
                // Keep Bash running until both searches have completed. The
                // standalone terminal then arrives after the aggregate, which
                // is the persisted ordering from the project-overview report.
                args: {
                  command:
                    "if [ -x /bin/sleep ]; then /bin/sleep 0.2; else /usr/bin/sleep 0.2; fi; printf 'status-ok\\n'",
                },
              },
              {
                id: 'post-bash-search-a',
                name: 'search_files',
                args: { pattern: 'CLAUDE.md' },
              },
              {
                id: 'post-bash-search-b',
                name: 'search_files',
                args: { pattern: 'package.json' },
              },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'post-bash-shell', contentIncludes: ['status-ok'] },
              { toolCallId: 'post-bash-search-a', contentIncludes: ['CLAUDE.md'] },
              { toolCallId: 'post-bash-search-b', contentIncludes: ['package.json'] },
            ],
          },
          message: {
            reasoning_content: 'Combining the two search results into the project overview.',
            content: 'POST_BASH_DONE: searches and reasoning stayed together.',
          },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, 'Inspect after a standalone command', {
        timeout: 15_000,
      });
      await waitForText(() => tui.viewport(), '工具授权', 15_000);
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), 'POST_BASH_DONE', 25_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);
      expect(screenContains(output, 'Bash')).toBe(true);
      expect(/Thinking [^\n]*searched 2 file patterns/u.test(clean)).toBe(true);
      expect(clean.match(/Thinking \d+s/gu)?.length ?? 0).toBe(1);
      expect(screenContains(output, 'searched 2 file patterns')).toBe(true);
      const bash = clean.indexOf('● Bash Ran:');
      const explorationThought = clean.lastIndexOf('Thinking ');
      const finalText = clean.indexOf('POST_BASH_DONE:');
      expect(explorationThought).toBeGreaterThan(bash);
      expect(finalText).toBeGreaterThan(explorationThought);
      expect(tui.scrollback()).not.toContain('● Find');

      await waitForCondition(
        () => {
          const observation = observePersistedUserMessageSession(
            workspace,
            'Inspect after a standalone command',
          );
          return observation.status === 'ready' && observation.value !== undefined;
        },
        'post-Bash project overview to persist before restart',
        10_000,
      );

      // Re-open the same persisted session after a real process restart. A
      // fresh current row is expected; `/resume` must select the historical
      // overview rather than relying on a new-session projection.
      await submitCommand(tui, '/exit');
      await tui.waitForExit();
      server.setResponses([]);
      tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitCommand(tui, '/resume');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui.viewport(), 'Inspect after a standalone', {
            active: false,
          }) && !screenContains(tui.viewport(), 'Loading...'),
        'historical post-Bash session to appear in /resume',
        10_000,
      );
      tui.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui.viewport(), 'Inspect after a standalone', {
            selected: true,
            active: false,
          }),
        'historical post-Bash session to be selected',
        5_000,
      );
      tui.write('\r');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return screenContains(viewport, 'POST_BASH_DONE') && screenContains(viewport, '❯');
        },
        'historical post-Bash overview to finish replaying',
        15_000,
      );

      const replay = stripAnsi(tui.viewport());
      const searchLines = replay
        .split('\n')
        .filter((line) => line.includes('searched 2 file patterns'));
      expect(searchLines).toHaveLength(1);
      expect(searchLines[0]?.trim()).toMatch(/^Thinking \d+s · searched 2 file patterns$/u);
      expect(replay.match(/Thinking \d+s/gu)?.length ?? 0).toBe(1);
      expect(replay.indexOf('Thinking ')).toBeGreaterThan(replay.indexOf('● Bash Ran:'));
    },
    TIMEOUT,
  );

  test(
    'project overview preserves server groups without archiving tool-bearing narration',
    async () => {
      const captions = [
        '好的，我来探索一下这个项目。先看看整体结构。',
        '让我继续阅读核心文档和包结构。',
        '再读一下核心架构文档和包结构。',
        '再补充看几个关键部分：app 的 README 和源码目录结构。',
        '我已经掌握了核心信息，再快速看一下仓库当前状态和测试/文档目录组织，然后给你总结。',
      ];
      const reads = (prefix: string) =>
        Array.from({ length: 2 }, (_, index) => ({
          id: `${prefix}-read-${index}`,
          name: 'read_file',
          args: { path: index === 0 ? 'CLAUDE.md' : 'package.json' },
        }));
      const search = (id: string, pattern: string) => ({
        id,
        name: 'search_files',
        args: { pattern },
      });
      const overviewA = [...reads('overview-a'), search('overview-search-a', 'CLAUDE.md')];
      const overviewB = [...reads('overview-b'), search('overview-search-b', 'package.json')];
      const overviewC = [...reads('overview-c'), search('overview-search-c', 'src')];
      const overviewD = [...reads('overview-d'), search('overview-search-d', '*.ts')];
      const bashCalls = [
        {
          id: 'overview-bash',
          name: 'shell_execute',
          args: {
            command: 'git status --short --branch && echo "---" && git log --oneline -3',
          },
        },
      ];
      const postBash = [
        search('overview-post-bash-a', 'CLAUDE.md'),
        search('overview-post-bash-b', 'package.json'),
      ];
      const expectedResults = (calls: ReadonlyArray<{ id: string }>) =>
        calls.map(({ id }) => ({ toolCallId: id }));

      server.setResponses([
        {
          message: {
            reasoning_content: 'Inspecting the project entry points.',
            content: captions[0],
            tool_calls: overviewA,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(overviewA) },
          message: {
            content: captions[1],
            tool_calls: overviewB,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(overviewB) },
          message: {
            content: captions[2],
            tool_calls: overviewC,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(overviewC) },
          message: {
            content: captions[3],
            tool_calls: overviewD,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(overviewD) },
          message: {
            content: captions[4],
            tool_calls: bashCalls,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(bashCalls) },
          message: {
            tool_calls: postBash,
          },
        },
        {
          expectedRequest: { toolResults: expectedResults(postBash) },
          message: {
            reasoning_content: 'Combining the final search results.',
            content: 'PROJECT_OVERVIEW_DONE: 我已经把项目的整体结构、架构和工程规范都看了一遍。',
          },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, '了解一下项目', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'PROJECT_OVERVIEW_DONE', 30_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const lines = stripAnsi(output)
        .split('\n')
        .map((line) => line.trim());
      const thoughtLines = lines.filter((line) => line.startsWith('Thinking '));
      expect(thoughtLines).toHaveLength(2);
      expect(
        lines.filter((line) => line.includes('read 2 files, searched 1 file pattern')),
      ).toHaveLength(4);
      expect(lines.some((line) => line.includes('ran 1 shell command'))).toBe(true);
      expect(lines.some((line) => line.includes('searched 2 file patterns'))).toBe(true);
      captions.forEach((caption) => {
        expect(lines).not.toContain(caption);
      });

      expect(lines.some((line) => line.startsWith('● Bash Ran:'))).toBe(false);
      expect(
        lines.indexOf('PROJECT_OVERVIEW_DONE: 我已经把项目的整体结构、架构和工程规范都看了一遍。'),
      ).toBeGreaterThan(lines.indexOf(thoughtLines[0]!));
      expect(tui.scrollback()).not.toContain('● Find');

      console.log('  [project-overview] clean output:', stripAnsi(output));
    },
    TIMEOUT,
  );

  test(
    'replays server-owned project-inspection groups when a successor queues',
    async () => {
      // Sanitized from tui-384e0e46-bfc7-456b-85f5-3541bdc7494c.
      // The response/tool topology and process narration are preserved;
      // filesystem output and the final answer are reduced to stable fixtures.
      const firstBatch = [
        { id: 'real-search-package', name: 'search_files', args: { pattern: 'package.json' } },
        {
          id: 'real-search-docs',
          name: 'search_files',
          args: { path: 'docs', pattern: '*.md' },
        },
        { id: 'real-read-readme', name: 'read_file', args: { path: 'README.md' } },
      ];
      const secondBatch = [
        { id: 'real-read-package', name: 'read_file', args: { path: 'package.json' } },
        { id: 'real-read-docs', name: 'read_file', args: { path: 'docs/README.md' } },
        {
          id: 'real-git-status',
          name: 'shell_execute',
          args: { command: 'git log --oneline -10 && git status --short' },
        },
      ];
      const thirdBatch = [
        {
          id: 'real-list-root',
          name: 'shell_execute',
          args: { command: 'ls -1 && ls -1 apps packages' },
        },
      ];
      const narrations = [
        '我来了解一下这个项目的整体情况。先并行查看仓库结构和关键文件。',
        '我已有 README 和 CLAUDE.md 的概要，再补充看几个关键配置文件来形成完整图景。',
        '再快速看一下顶层目录结构，然后给出完整总结。',
      ];
      const internalReasoning =
        'The user asked to understand the current project. This is an informational/exploration request.';
      const finalChunks = [
        '我已经对项目做了整体勘察。以下是当前项目',
        '的完整图景：\n\n## 项目定位\n\n**Kite Code** 是一个可控制、可恢复、可验证的终端编码 Agent。\n\n## 技术栈与形态\n\n- Bun + TypeScript ESM monorepo\n- React + Ink TUI\n\nREAL_SESSION_RENDER_DONE',
      ];
      const results = (calls: ReadonlyArray<{ id: string }>) =>
        calls.map(({ id }) => ({ toolCallId: id }));

      server.setResponses([
        {
          message: {
            reasoning_chunks: ['The user greeted the assistant;', ' answer briefly in Chinese.'],
            content_chunks: [
              '你好！我是 Kite，可以在这个仓库里帮你处理任务。\n\n请',
              '问你想做什么？',
            ],
          },
          stream_frame_sequence: ['reasoning', 'reasoning', 'content', 'content'],
          // Hold the terminal after the first complete paragraph so the test
          // proves that text owned by an unresolved Thought stays hidden until
          // model.responded classifies the response.
          stream_frame_delays: [1_600, 500, 2_000, 0],
        },
        {
          message: {
            reasoning_content: 'Inspecting the repository structure and entry documents.',
            content: narrations[0],
            tool_calls: firstBatch,
          },
        },
        {
          expectedRequest: { toolResults: results(firstBatch) },
          message: {
            reasoning_content: 'Reading configuration and repository status.',
            content: narrations[1],
            tool_calls: secondBatch,
          },
        },
        {
          expectedRequest: { toolResults: results(secondBatch) },
          message: {
            reasoning_content: 'Checking the final directory layout.',
            content: narrations[2],
            tool_calls: thirdBatch,
          },
        },
        {
          expectedRequest: { toolResults: results(thirdBatch) },
          message: {
            reasoning_chunks: [internalReasoning],
            content_chunks: finalChunks,
          },
          stream_frame_sequence: ['reasoning', 'content', 'content'],
          // The first incomplete content chunk closes reasoning, then holds
          // the request open so the real session's active-Thought window is
          // observable before the terminal response arrives.
          stream_frame_delays: [0, 2_500, 0],
        },
        { message: { content: 'QUEUED_AFTER_INSPECTION_DONE' }, delay: 10 },
      ]);

      await submitUserMessage(tui, server, '你好', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'Thinking', 15_000);
      expect(screenContains(tui.viewport(), '你好！我是 Kite')).toBe(false);
      await waitForText(
        () => tui.outputSinceLastAction(),
        '你好！我是 Kite，可以在这个仓库里帮你处理任务。',
        15_000,
      );
      await waitForText(() => tui.outputSinceLastAction(), '请问你想做什么？', 15_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await submitUserMessage(tui, server, '了解当前项目', { timeout: 15_000 });

      await waitForCondition(
        () => server.getRequestCount() === 5,
        'real-session final model request',
        20_000,
      );
      await waitForCondition(
        () => {
          const viewport = stripAnsi(tui.viewport());
          return (
            viewport.split('\n').some((line) => line.trim().startsWith('● Thinking ')) &&
            viewport.includes(internalReasoning) &&
            !viewport.includes('REAL_SESSION_RENDER_DONE')
          );
        },
        'real-session final request active Thought',
        10_000,
      );

      const activeFrame = stripAnsi(tui.viewport());
      const activeProjectFrame = activeFrame.slice(activeFrame.indexOf('❯ 了解当前项目'));
      expect(activeProjectFrame.match(/Thinking /g)).toHaveLength(3);
      expect(activeProjectFrame).toContain('read 1 file, searched 2 file patterns');
      expect(activeProjectFrame).toContain('read 2 files, ran 1 shell command');
      expect(activeProjectFrame).toContain('ran 1 shell command');
      narrations.forEach((narration) => {
        expect(activeProjectFrame).not.toContain(narration);
      });
      expect(activeProjectFrame).toContain(internalReasoning);
      expect(activeProjectFrame).not.toContain('REAL_SESSION_RENDER_DONE');

      await submitUserMessageForDeferredDelivery(tui, server, '你好', {
        acceptWhen: (viewport) => screenContains(viewport, '↵ 你好'),
        timeout: 15_000,
      });
      const queuedFrame = stripAnsi(tui.viewport());
      const queuedProjectFrame = queuedFrame.slice(queuedFrame.indexOf('❯ 了解当前项目'));
      expect(queuedProjectFrame.match(/Thinking /g)).toHaveLength(3);
      expect(queuedProjectFrame).toContain('read 1 file, searched 2 file patterns');
      expect(queuedProjectFrame).toContain('read 2 files, ran 1 shell command');
      expect(queuedProjectFrame).toContain('↵ 你好');
      narrations.forEach((narration) => {
        expect(queuedProjectFrame).not.toContain(narration);
      });

      await waitForText(() => tui.outputSinceLastAction(), 'REAL_SESSION_RENDER_DONE', 20_000);
      await waitForText(() => tui.outputSinceLastAction(), 'QUEUED_AFTER_INSPECTION_DONE', 20_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const settled = stripAnsi(tui.viewport());
      const lines = settled.split('\n').map((line) => line.trim());
      expect(
        lines.filter((line) => line.includes('read 1 file, searched 2 file patterns')),
      ).toHaveLength(1);
      expect(
        lines.filter((line) => line.includes('read 2 files, ran 1 shell command')),
      ).toHaveLength(1);
      expect(lines.filter((line) => line === 'REAL_SESSION_RENDER_DONE')).toHaveLength(1);
      expect(lines.filter((line) => line.includes('请问你想做什么？'))).toHaveLength(1);
      expect(settled).not.toContain(internalReasoning);
      expect(settled).not.toContain('└─ The user asked');
      narrations.forEach((narration) => {
        expect(lines).not.toContain(narration);
      });
      expect(lines.findIndex((line) => line.includes('项目定位'))).toBeGreaterThan(-1);
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
      expect(screenContains(actionLocalRender, 'CLAUDE.md')).toBe(true);

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
    'painted reasoning stays one Thinking line when its response starts exploration',
    async () => {
      // Reduced, sanitized reproduction of
      // tui-bb8cec02-4b43-435f-bd03-697ba9ac0389, sequences 5-31:
      // requested -> painted reasoning -> narrated two-tool response -> next request.
      // The original 2026-09-03 trace painted `Thinking 1s`, then promoted the
      // same Thought to Static as `Thinking 3s`, leaving both physical lines.
      const exploration = [
        { id: 'incident-search', name: 'search_files', args: { pattern: 'CLAUDE.md' } },
        {
          id: 'incident-shell',
          name: 'shell_execute',
          args: { command: 'git status --short' },
        },
      ];
      server.setResponses([
        {
          message: {
            reasoning_chunks: ['Inspecting the repository before choosing the next tools.'],
            content_chunks: ['我来先了解一下仓库的当前状况，然后给出总结。'],
            tool_calls: exploration,
          },
          stream_frame_sequence: ['reasoning', 'content'],
          // Preserve the incident's important timing property: Ink paints the
          // live reasoning before the tool-bearing terminal response arrives.
          stream_frame_delays: [2200, 0],
        },
        {
          expectedRequest: {
            toolResults: exploration.map(({ id }) => ({ toolCallId: id })),
          },
          message: { content: 'SESSION_LOG_REPLAY_DONE: project summarized.' },
          delay: 10,
        },
      ]);

      const activityFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Summarize the project', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'SESSION_LOG_REPLAY_DONE', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const viewport = tui.viewport();
      const lines = stripAnsi(viewport)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Thinking '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('searched 1 file pattern');
      expect(lines[0]).toContain('ran 1 shell command');
      expect(screenContains(viewport, '我来先了解一下仓库的当前状况，然后给出总结。')).toBe(false);
      expect(screenContains(viewport, 'SESSION_LOG_REPLAY_DONE')).toBe(true);
      const frames = tui.screenFramesSince(activityFrames);
      expect(
        frames.some((frame) => screenContains(frame, 'Inspecting the repository before choosing')),
      ).toBe(true);
      expect(frames.some((frame) => screenContains(frame, 'Thinking 2s'))).toBe(true);
      expect(
        frames.some(
          (frame) =>
            screenContains(frame, 'searched 1 file pattern') &&
            screenContains(frame, 'ran 1 shell command'),
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );

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

      await waitForText(() => tui.outputSinceLastAction(), 'THINK_ONLY_DONE', 25000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // The completion and a content-free Thought are projected, but the
      // private reason body is not.
      expect(screenContains(output, 'THINK_ONLY_DONE')).toBe(true);
      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(clean).not.toContain('Let me think about the problem');
      const compactLines = clean.split('\n').map((line) => line.trim());
      const thinkingOnlyHeader = compactLines.findIndex((line) => line.startsWith('Thinking '));
      expect(compactLines.indexOf('THINK_ONLY_DONE: thought it through.')).toBe(
        thinkingOnlyHeader + 2,
      );
      expect(compactLines[thinkingOnlyHeader + 1]).toBe('');

      // ── Settled 后无 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);

      // ── TUI idle ──
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  [Test 4-5] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );
});
