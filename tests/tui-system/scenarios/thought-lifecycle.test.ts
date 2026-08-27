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
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
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

      // Adjacent closed categories merge across model requests. Local
      // reasoning reached the reducer but is folded out of the settled view.
      expect(screenContains(output, 'Thinking ')).toBe(true);
      expect(screenContains(output, 'read 1 file, searched 1 file pattern')).toBe(true);
      expect(screenContains(output, '先查看项目入口和核心配置。')).toBe(true);
      expect(screenContains(output, '继续搜索源码和文档目录。')).toBe(true);
      expect(screenContains(output, 'PHASE_ONE')).toBe(false);
      expect(screenContains(output, 'PHASE_TWO')).toBe(false);
      const lines = clean.split('\n').map((line) => line.trim());
      const headerIndex = lines.findIndex((line) => line.startsWith('Thinking '));
      const firstCaptionIndex = lines.indexOf('先查看项目入口和核心配置。');
      expect(firstCaptionIndex).toBe(headerIndex + 1);
      expect(lines.indexOf('继续搜索源码和文档目录。')).toBe(firstCaptionIndex + 1);

      // ── Settled 后工具步骤折叠，保留统计摘要 ──
      expect(screenContains(output, '└─ 完成')).toBe(false);
      expect(screenContains(output, 'TIMELINE_DONE')).toBe(true);

      console.log('  [Test 0] clean output (last 3000 chars):', clean.slice(-3000));
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

      // The adjacent terminal reads merge by closed category. Their local
      // paths/reasoning were available while active and fold at settlement.
      expect(screenContains(output, 'read 2 files')).toBe(true);
      expect(screenContains(output, 'Thinking ')).toBe(true);
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
      // The read starts after the shell boundary as a separate safe summary;
      // it never renders a transient standalone Read card.
      expect(screenContains(output, 'read 1 file')).toBe(true);
      expect(screenContains(output, 'ran 1 command')).toBe(false);
      expect(screenContains(output, 'Bash')).toBe(true);
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
    'post-Bash searches and later reasoning settle as one upgraded phase',
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
                  command: `bun -e "await Bun.sleep(200); console.log('status-ok')"`,
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
      await waitForText(() => tui.outputSinceLastAction(), 'POST_BASH_DONE', 25_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);
      expect(screenContains(output, 'Bash')).toBe(true);
      expect(/Thinking [^\n]*searched 2 file patterns/u.test(clean)).toBe(true);
      expect(clean.match(/Thinking \d+s/gu)?.length ?? 0).toBe(1);
      expect(screenContains(output, 'searched 2 file patterns')).toBe(true);
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
      expect(searchLines[0]).toMatch(/Thinking \d+s.*searched 2 file patterns/u);
      expect(replay.match(/Thinking \d+s/gu)?.length ?? 0).toBe(1);
    },
    TIMEOUT,
  );

  test(
    'project overview sequence keeps captions compact and upgrades post-error searches',
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
      const firstThinking = lines.findIndex(
        (line) =>
          line.startsWith('Thinking ') && line.includes('read 8 files, searched 4 file patterns'),
      );
      expect(firstThinking).toBeGreaterThan(-1);
      captions.slice(0, -1).forEach((caption, index) => {
        expect(lines[firstThinking + index + 1]).toBe(caption);
      });

      // The fifth narration trails the settled first Thought as final text;
      // it receives the same single-row block gap, not a duplicated caption
      // paragraph gap. The four confirmed captions remain consecutive.
      const lastCaption = lines.indexOf(captions.at(-1)!);
      expect(lastCaption).toBe(lines.indexOf(captions.at(-2)!) + 2);
      expect(lines[lastCaption - 1]).toBe('');

      const bash = lines.findIndex((line) => line.startsWith('● Bash Ran:'));
      expect(bash).toBeGreaterThan(lastCaption);
      const secondThinking = lines.findIndex(
        (line, index) =>
          index > bash && line.startsWith('Thinking ') && line.includes('searched 2 file patterns'),
      );
      expect(secondThinking).toBeGreaterThan(bash);
      expect(lines).not.toContain('searched 2 file patterns');
      expect(lines[secondThinking + 1]).toBe('');
      expect(lines[secondThinking + 2]).toBe(
        'PROJECT_OVERVIEW_DONE: 我已经把项目的整体结构、架构和工程规范都看了一遍。',
      );
      expect(tui.scrollback()).not.toContain('● Find');

      console.log('  [project-overview] clean output:', stripAnsi(output));
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
