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
 *   4. 非探索工具边界（write_file，等价 task）切分阶段，后段按
 *      ADR-0047 单次消费规则使用纯工具统计标签
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
interface FixtureToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function expectedFixtureToolResults(calls: readonly FixtureToolCall[]) {
  return calls.map((call) => {
    const path = String(call.args.path ?? '');
    return {
      toolCallId: call.id,
      contentIncludes: [
        call.name === 'search_files'
          ? 'src/app/tui'
          : path === 'package.json'
            ? 'tui-header-merge-fixture'
            : `fixture: ${path}`,
      ],
    };
  });
}

describe('TUI PTY System — Thought Text Header Merge (ADR-0026, real-session replay)', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
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

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'real-session replay: stats suffix on Thought blocks, pure thoughts merge into text headers',
    async () => {
      toolSeq = 0;
      const response1Calls = [
        { id: `t${++toolSeq}`, name: 'search_files', args: { pattern: '**/tui/**' } },
        { id: `t${++toolSeq}`, name: 'search_files', args: { pattern: '**/tui/**/*.tsx' } },
        { id: `t${++toolSeq}`, name: 'read_file', args: { path: 'package.json' } },
      ];
      const response2Calls = readCalls(RESP2_FILES);
      const response3Calls = readCalls(RESP3_FILES);
      const response4Calls = readCalls(RESP4_FILES);
      const response5Calls = readCalls(RESP5_FILES);
      const response6Calls = readCalls(RESP6_FILES);
      server.setResponses([
        // Response 1: reason + search×2 + read×1（真实日志结构）
        {
          message: {
            reasoning_content:
              'The user wants to thoroughly understand the TUI module. Let me first explore the project structure.',
            tool_calls: response1Calls,
          },
        },
        // Response 2: reason + text + read×6
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response1Calls) },
          message: {
            reasoning_content:
              'The user wants to thoroughly understand the TUI module. Let me read all the core files.',
            content: 'Let me read the core files systematically.',
            tool_calls: response2Calls,
          },
          delay: 10,
        },
        // Response 3: reason + read×5
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response2Calls) },
          message: {
            reasoning_content:
              'The user wants to "仔细了解TUI模块" (carefully understand the TUI module). Read-only exploration.',
            tool_calls: response3Calls,
          },
          delay: 10,
        },
        // Response 4: reason + read×6
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response3Calls) },
          message: {
            reasoning_content: 'Let me continue reading the remaining important files.',
            tool_calls: response4Calls,
          },
          delay: 10,
        },
        // Response 5: reason + text + read×6
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response4Calls) },
          message: {
            reasoning_content: 'The user asked to "仔细了解TUI模块". Read-only exploration.',
            content: '继续读取其余关键文件：',
            tool_calls: response5Calls,
          },
          delay: 10,
        },
        // Response 6: reason + text + read×6
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response5Calls) },
          message: {
            reasoning_content:
              'I have now read all the key files. A few more components and hooks.',
            content: '现在让我看完剩下的关键组件和 hooks：',
            tool_calls: response6Calls,
          },
          delay: 10,
        },
        // Response 7: reason + final text（无工具）
        {
          expectedRequest: { toolResults: expectedFixtureToolResults(response6Calls) },
          message: {
            reasoning_content:
              "I've now read a comprehensive set of files. Time to synthesize the full analysis.",
            content: '── TUI 模块全面解析 ──\n\nANALYSIS_DONE: TUI 模块位于 src/app/tui/。',
          },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, '仔细了解TUI模块', { timeout: 15000 });

      // 等最终回答到达 → 全部 7 次模型调用完成
      await waitForText(() => tui.outputSinceLastAction(), 'ANALYSIS_DONE', 45000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // ── 1. Settled Thought 只保留当前阶段的单行摘要 ──
      expect(screenContains(output, 'Thought for')).toBe(true);
      expect(screenContains(output, '· read 6 files')).toBe(true);

      // ── 2. 最终回答作为独立文本块 ──
      expect(screenContains(output, '── TUI 模块全面解析 ──')).toBe(true);
      expect(/Thought for \d+s\r?\n {0,4}── TUI 模块全面解析 ──/.test(clean)).toBe(false);

      // ── 3. settled 后不保留 footer ──
      expect(screenContains(output, '└─ 完成')).toBe(false);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 2 — 非探索工具边界后的思考标签单次消费（ADR-0047）
  //
  // 真实日志 tui-ms0ihe3d-0 第 5 次调用为 search + task + read×2（task
  // 切断 Thought，后段 read 保持非思考标签）。ADR-0047 覆盖 ADR-0027：
  // 前段已经消费 reasoning 与 Thought 标签，后段只有收到新的真实 reason
  // 才能升级为 Thought。harness 无子代理执行环境，以 write_file（同为非
  // 探索工具）触发等价切断。
  // ═══════════════════════════════════════════════════════════════

  test(
    'thinking is consumed once across a write-tool boundary (ADR-0047)',
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
              { id: 'w4', name: 'read_file', args: { path: 'src/app/tui/StatsLine.ts' } },
            ],
          },
        },
        // 新一轮模型调用：model.requested settle 带工具 Thought → 最终回答
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'w1', contentIncludes: ['tui-header-merge-fixture'] },
              { toolCallId: 'w2', contentIncludes: ['Wrote 1 lines to notes.md'] },
              { toolCallId: 'w3', contentIncludes: ['src/app/tui/theme.ts'] },
              { toolCallId: 'w4', contentIncludes: ['src/app/tui/StatsLine.ts'] },
            ],
          },
          message: { content: 'CARRY_DONE: boundary crossed, reading resumed.' },
          delay: 10,
        },
      ]);

      await submitUserMessage(tui, server, '读入口并记笔记', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'CARRY_DONE', 30000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);

      // 边界前：Thought · read 1 file；写入卡片独立渲染
      expect(screenContains(output, '· read 1 file')).toBe(true);
      expect(screenContains(output, 'notes.md')).toBe(true);
      // 边界后：没有新的 reason，因此只显示纯工具统计，不重复 Thought 标签。
      expect(screenContains(output, 'read 2 files')).toBe(true);
      expect(/Thought for \d+s · read 2 files/.test(clean)).toBe(false);
      // 时序：read 1 file Thought → 写入卡片 → 纯统计 read 2 files。
      expect(/read 1 file[\s\S]*notes\.md[\s\S]*read 2 files/.test(clean)).toBe(true);

      console.log('  [carryover] clean output (last 2000 chars):', clean.slice(-2000));
    },
    TIMEOUT,
  );
});
