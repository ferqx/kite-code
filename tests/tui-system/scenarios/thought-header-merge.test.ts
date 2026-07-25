/**
 * PTY System Test — 探索阶段块（ADR-0030）：真实会话回放
 *
 * 测试数据取自真实会话日志 ~/.kite-code/sessions/tui/tui-ms0cuzee-0
 * （"仔细了解TUI模块" 对话：7 次模型调用 / 32 次工具调用），按原结构回放：
 *
 *   Response 1: reason + search_files×2 + read_file×1
 *   Response 2: reason + text + read_file×6   （旁白 → 块顶字幕）
 *   Response 3: reason + read_file×5
 *   Response 4: reason + read_file×6
 *   Response 5: reason + text + read_file×6   （旁白 → 块顶字幕）
 *   Response 6: reason + text + read_file×6   （旁白 → 块顶字幕）
 *   Response 7: reason + final text（无工具） → 最终回答脱离为独立块
 *
 * 核心断言（ADR-0030 / 规则 24）：
 *   1. 整段只读探索 = 单一阶段块："Thought for Xs · read 30 files,
 *      searched 2 file patterns"（跨 7 次模型调用聚合，时长累加）
 *   2. 三段旁白文本作为块顶字幕按序渲染，不产生独立文本块
 *   3. 最终回答脱离为独立文本块（思考时长已计入阶段块，不重复出题头）
 *   4. 非探索工具边界（write_file，等价 task）仍切分阶段，后段继承
 *      思考标签（ADR-0027）
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 60000;

/** 真实日志中的 32 个被读取路径 → fixture 文件（按响应分组） */
const RESP2_FILES = [
  'src/app/tui/index.tsx',
  'src/app/tui/types.ts',
  'src/app/tui/constants.ts',
  'src/app/tui/theme.ts',
  'src/app/tui/initialState.ts',
  'src/app/tui/provider.ts',
];
const RESP3_FILES = [
  'src/app/tui/App.tsx',
  'src/app/tui/reducers/index.ts',
  'src/app/tui/reducers/actions.ts',
  'src/app/tui/session-manager.ts',
  'src/app/tui/run-agent.ts',
];
const RESP4_FILES = [
  'src/app/tui/OutputArea.tsx',
  'src/app/tui/Header.tsx',
  'src/app/tui/Footer.tsx',
  'src/app/tui/StatusBar.tsx',
  'src/app/tui/run-status.ts',
  'src/app/tui/replay-blocks.ts',
];
const RESP5_FILES = [
  'src/app/tui/reducers/agentReducer.ts',
  'src/app/tui/reducers/handleEvent.ts',
  'src/app/tui/reducers/uiReducer.ts',
  'src/app/tui/reducers/sessionReducer.ts',
  'src/app/tui/reducers/consolidateTools.ts',
  'src/app/tui/interaction-mode.ts',
];
const RESP6_FILES = [
  'src/app/tui/components/BlockRenderer.tsx',
  'src/app/tui/components/ToolCardBlock.tsx',
  'src/app/tui/components/MarkdownBlock.tsx',
  'src/app/tui/components/InputLine.tsx',
  'src/app/tui/hooks/useGlobalKeys.ts',
  'src/app/tui/StatsLine.ts',
];

let toolSeq = 0;
const readCalls = (paths: string[]) =>
  paths.map((path) => ({ id: `t${++toolSeq}`, name: 'read_file', args: { path } }));

describe('TUI PTY System — Thought Text Header Merge (ADR-0026, real-session replay)', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();

    // fixture 工作区复刻真实日志的文件布局（搜索 **/tui/** 与读取均命中）
    const files: Record<string, string> = {
      'package.json': '{"name":"tui-header-merge-fixture"}\n',
    };
    for (const p of [
      ...RESP2_FILES,
      ...RESP3_FILES,
      ...RESP4_FILES,
      ...RESP5_FILES,
      ...RESP6_FILES,
    ]) {
      files[p] = `// fixture: ${p}\nexport const fixture = true;\n`;
    }
    workspace = createTestWorkspace({ files });

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
    'warmup: TUI input pipeline functional',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'real-session replay: stats suffix on Thought blocks, pure thoughts merge into text headers',
    async () => {
      toolSeq = 0;
      server.setResponses([
        // Response 1: reason + search×2 + read×1（真实日志结构）
        {
          message: {
            reasoning_content:
              'The user wants to thoroughly understand the TUI module. Let me first explore the project structure.',
            tool_calls: [
              { id: `t${++toolSeq}`, name: 'search_files', args: { pattern: '**/tui/**' } },
              { id: `t${++toolSeq}`, name: 'search_files', args: { pattern: '**/*tui*' } },
              { id: `t${++toolSeq}`, name: 'read_file', args: { path: 'package.json' } },
            ],
          },
        },
        // Response 2: reason + text + read×6
        {
          message: {
            reasoning_content:
              'The user wants to thoroughly understand the TUI module. Let me read all the core files.',
            content: 'Let me read the core files systematically.',
            tool_calls: readCalls(RESP2_FILES),
          },
          delay: 10,
        },
        // Response 3: reason + read×5
        {
          message: {
            reasoning_content:
              'The user wants to "仔细了解TUI模块" (carefully understand the TUI module). Read-only exploration.',
            tool_calls: readCalls(RESP3_FILES),
          },
          delay: 10,
        },
        // Response 4: reason + read×6
        {
          message: {
            reasoning_content: 'Let me continue reading the remaining important files.',
            tool_calls: readCalls(RESP4_FILES),
          },
          delay: 10,
        },
        // Response 5: reason + text + read×6
        {
          message: {
            reasoning_content: 'The user asked to "仔细了解TUI模块". Read-only exploration.',
            content: '继续读取其余关键文件：',
            tool_calls: readCalls(RESP5_FILES),
          },
          delay: 10,
        },
        // Response 6: reason + text + read×6
        {
          message: {
            reasoning_content:
              'I have now read all the key files. A few more components and hooks.',
            content: '现在让我看完剩下的关键组件和 hooks：',
            tool_calls: readCalls(RESP6_FILES),
          },
          delay: 10,
        },
        // Response 7: reason + final text（无工具）
        {
          message: {
            reasoning_content:
              "I've now read a comprehensive set of files. Time to synthesize the full analysis.",
            content: '── TUI 模块全面解析 ──\n\nANALYSIS_DONE: TUI 模块位于 src/app/tui/。',
          },
          delay: 10,
        },
        { message: { content: 'spare-h1' }, delay: 10 },
        { message: { content: 'spare-h2' }, delay: 10 },
      ]);

      await typeText(tui, '仔细了解TUI模块');
      tui.write('\r');
      await waitForRequestMessage(server, '仔细了解TUI模块', 15000);

      // 等最终回答到达 → 全部 7 次模型调用完成
      await waitForText(() => tui.output(), 'ANALYSIS_DONE', 45000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // ── 1. 单一阶段块：7 次调用的 32 个只读工具聚合（ADR-0030）──
      // 1 read + 6+5+6+6+6 reads = 30 files；2 search_files patterns
      expect(screenContains(output, 'Thought for')).toBe(true);
      expect(screenContains(output, '· read 30 files, searched 2 file patterns')).toBe(true);
      // 工具步骤可见（32 步折叠后仍展示最后若干步）
      expect(screenContains(output, '已折叠')).toBe(true);
      expect(screenContains(output, 'Read StatsLine.ts')).toBe(true); // Resp6 末段可见
      // 最终画面（累计缓冲尾部 ≈ 最终屏）不含按调用切分的旧形态统计，
      // 且早期步骤（Find **/tui/**）已折叠不可见。
      // （完整缓冲含生长中间帧，缺席断言只看尾部最终画面。）
      const tail = clean.slice(-2500);
      expect(tail).not.toContain('· read 1 file, searched 2 file patterns');
      expect(tail).not.toContain('· read 5 files');
      expect(tail).not.toContain('Find **/tui/**');

      // ── 2. 三段旁白作为块顶字幕（位于标题行之下，无独立文本块间隔）──
      expect(screenContains(output, 'Let me read the core files systematically.')).toBe(true);
      expect(screenContains(output, '继续读取其余关键文件：')).toBe(true);
      expect(screenContains(output, '现在让我看完剩下的关键组件和 hooks：')).toBe(true);
      // 字幕紧跟阶段块标题之后、在步骤树之前（按序）
      const headerIdx = clean.lastIndexOf('read 30 files, searched 2 file patterns');
      const cap1 = clean.lastIndexOf('Let me read the core files systematically.');
      const cap2 = clean.lastIndexOf('继续读取其余关键文件：');
      const cap3 = clean.lastIndexOf('现在让我看完剩下的关键组件和 hooks：');
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(cap1).toBeGreaterThan(headerIdx);
      expect(cap2).toBeGreaterThan(cap1);
      expect(cap3).toBeGreaterThan(cap2);

      // ── 3. 最终回答脱离为独立文本块（无 Thought 题头，时长已在块内）──
      expect(screenContains(output, '── TUI 模块全面解析 ──')).toBe(true);
      expect(/Thought for \d+s\r?\n {0,4}── TUI 模块全面解析 ──/.test(clean)).toBe(false);
      // 回答在阶段块之后
      expect(clean.lastIndexOf('── TUI 模块全面解析 ──')).toBeGreaterThan(cap3);

      // ── 4. settled footer 存在（块全部完成）──
      expect(screenContains(output, '└─ 完成')).toBe(true);

      console.log('  [header-merge] clean output (last 2500 chars):', clean.slice(-2500));
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 2 — 思考延续跨过非探索工具边界（ADR-0027）
  //
  // 真实日志 tui-ms0ihe3d-0 第 5 次调用为 search + task + read×2（task
  // 切断 Thought，后段 read 保持非思考标签——改规前的行为）。ADR-0027 后
  // 后段继承思考标记。harness 无子代理执行环境，以 write_file（同为非
  // 探索工具，accept_edits 下自动审批）触发等价切断。
  // ═══════════════════════════════════════════════════════════════

  test(
    'thinking carries over a write-tool boundary within one batch (ADR-0027)',
    async () => {
      server.setResponses([
        {
          message: {
            reasoning_content: 'Reading the entry, taking a note, then continuing to read.',
            tool_calls: [
              { id: 'w1', name: 'read_file', args: { path: 'package.json' } },
              {
                id: 'w2',
                name: 'write_file',
                args: { path: 'notes.md', content: 'entry: src/app/tui/index.tsx\n' },
              },
              { id: 'w3', name: 'read_file', args: { path: 'src/app/tui/theme.ts' } },
              { id: 'w4', name: 'read_file', args: { path: 'src/app/tui/StatsLine.tsx' } },
            ],
          },
        },
        // 新一轮模型调用：model.requested settle 带工具 Thought → 最终回答
        { message: { content: 'CARRY_DONE: boundary crossed, reading resumed.' }, delay: 10 },
        { message: { content: 'spare-c1' }, delay: 10 },
        { message: { content: 'spare-c2' }, delay: 10 },
      ]);

      await typeText(tui, '读入口并记笔记');
      tui.write('\r');
      await waitForRequestMessage(server, '读入口并记笔记', 15000);

      await waitForText(() => tui.output(), 'CARRY_DONE', 30000);
      await sleep(2000);

      const output = tui.output();
      const clean = stripAnsi(output);

      // 边界前：Thought · read 1 file；写入卡片独立渲染
      expect(screenContains(output, '· read 1 file')).toBe(true);
      expect(screenContains(output, 'notes.md')).toBe(true);
      // 边界后：继承思考标记（不再是纯统计 "● read 2 files"）
      expect(/Thought for \d+s · read 2 files/.test(clean)).toBe(true);
      // 时序：read 1 file 块 → 写入卡片 → 继承的 Thought 块
      expect(/read 1 file[\s\S]*notes\.md[\s\S]*Thought for \d+s · read 2 files/.test(clean)).toBe(
        true,
      );

      console.log('  [carryover] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );
});
