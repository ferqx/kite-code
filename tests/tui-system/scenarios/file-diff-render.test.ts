/**
 * PTY System Test — File Tool Result Rendering & Card Verb Matrix
 *
 * 覆盖 write_file 四种结果路径的端到端渲染（文本级；染色精确性由组件测试
 * tests/tui-file-diff-render.test.tsx 保证，e2e 的 stripAnsi 断言不可见颜色）：
 * Covers all four write_file result paths end-to-end at the text level
 * (coloring precision is guaranteed by the component test; e2e stripAnsi
 * assertions cannot see colors):
 *
 * 1. 覆写已有文件 / Overwrite of an existing file (notes.md):
 *    卡片动词 Write（非 Create）；diff 统计行；Markdown 列表项 "- 嘻嘻嘻"
 *    作为上下文行完整渲染（回归场景："- " 开头正文曾被宽松正则误判为
 *    删除行）；真删除/新增标记紧贴正文。
 * 2. 新建文件 / Create of a new file (changelog.md):
 *    卡片动词 Create；纯内容摘要 "Wrote N lines to …" 与内容行。
 * 3. 追加 / Append to an existing file (notes.md, mode='append'):
 *    卡片动词 Append；"Appended N lines to …" 摘要与追加行。
 * 4. 内容未变的覆写 / No-op overwrite (changelog.md, identical content):
 *    卡片动词 Write（非 Create）；摘要含 "(content unchanged)" 标记。
 *
 * NOTE: 默认交互模式为 accept-edits，工作区写入自动放行，无审批浮层。
 * Default interaction mode is accept-edits: workspace writes auto-approve.
 * Static scrollback 跨轮次累积，后续轮次不对旧卡片文案做"不存在"断言。
 *
 * IMPORTANT: Like approval.test.ts, this test requires a warmup phase
 * before the first model call.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

const CHANGELOG_CONTENT = '# Changelog\n\n- 初始版本';

describe('TUI PTY System — File Tool Diff Render', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    // Pre-create a Markdown file with list items — the overwrite keeps them
    // as diff context lines; only the final line changes.
    workspace = createTestWorkspace({
      files: { 'notes.md': '- 嘻嘻嘻\n- 详细信息\n旧结尾' },
    });

    // Turn 1: write_file overwrites notes.md → diff summary, verb Write
    // Turn 2: write_file creates changelog.md → plain summary, verb Create
    // Turn 3: write_file appends to notes.md → Appended summary, verb Append
    // Turn 4: write_file rewrites changelog.md identically → no-change, verb Write
    // Spares for generateSessionName + potential retries
    server.setResponses([
      {
        message: {
          content: 'I will update your notes.',
          tool_calls: [
            {
              id: 'call_wf1',
              name: 'write_file',
              args: { path: 'notes.md', content: '- 嘻嘻嘻\n- 详细信息\n新结尾' },
            },
          ],
        },
      },
      { message: { content: 'Notes file updated.' } },
      {
        message: {
          content: 'I will add a changelog.',
          tool_calls: [
            {
              id: 'call_wf2',
              name: 'write_file',
              args: { path: 'changelog.md', content: CHANGELOG_CONTENT },
            },
          ],
        },
      },
      { message: { content: 'Changelog created.' } },
      {
        message: {
          content: 'I will append an entry.',
          tool_calls: [
            {
              id: 'call_wf3',
              name: 'write_file',
              args: { path: 'notes.md', mode: 'append', content: '\n- 追加条目' },
            },
          ],
        },
      },
      { message: { content: 'Entry appended.' } },
      {
        message: {
          content: 'I will rewrite the changelog identically.',
          tool_calls: [
            {
              id: 'call_wf4',
              name: 'write_file',
              args: { path: 'changelog.md', content: CHANGELOG_CONTENT },
            },
          ],
        },
      },
      { message: { content: 'Changelog re-verified.' } },
      { message: { content: 'diff render spare 1' } },
      { message: { content: 'diff render spare 2' } },
      { message: { content: 'diff render spare 3' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    tui.setRawMode(true);
    // Allow raw mode transition to settle before sending keystrokes
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Turn 1: overwrite → Write verb + diff summary intact ───

  test(
    'write_file overwrite renders Write verb and diff summary with list-item context lines intact',
    async () => {
      await typeText(tui, 'Update my notes file');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes file', 15000);

      // accept-edits mode auto-approves the workspace write_file — wait
      // directly for tool execution + agent's follow-up response
      await waitForText(() => tui.output(), 'Notes file updated.', 20000);
      await sleep(500);

      const output = tui.output();

      // Card verb distinguishes overwrite from create
      expect(screenContains(output, 'Write (notes.md)')).toBe(true);
      expect(screenContains(output, 'Create (notes.md)')).toBe(false);

      // Diff stats line present (both counts are 1 → singular "line" twice)
      expect(screenContains(output, 'Added 1 line, removed 1 line')).toBe(true);

      // Markdown list items appear as unchanged context lines — the regression
      // case: these "- " lines must render as plain content, not vanish
      expect(screenContains(output, '- 嘻嘻嘻')).toBe(true);
      expect(screenContains(output, '- 详细信息')).toBe(true);

      // Genuine removed/added lines: marker glued to the text
      expect(screenContains(output, '3 -旧结尾')).toBe(true);
      expect(screenContains(output, '3 +新结尾')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Turn 2: create → Create verb + plain content summary ───

  test(
    'write_file create renders Create verb and plain content summary',
    async () => {
      await typeText(tui, 'Add a changelog');
      tui.write('\r');
      await waitForRequestMessage(server, 'Add a changelog', 15000);

      await waitForText(() => tui.output(), 'Changelog created.', 20000);
      await sleep(500);

      const output = tui.output();

      // Card verb for a brand-new file
      expect(screenContains(output, 'Create (changelog.md)')).toBe(true);

      // Plain content summary (no diff markers for new files)
      expect(screenContains(output, 'Wrote 3 lines to changelog.md')).toBe(true);
      expect(screenContains(output, '# Changelog')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Turn 3: append → Append verb + Appended summary ────────

  test(
    'write_file append renders Append verb and Appended summary',
    async () => {
      await typeText(tui, 'Append an entry to my notes');
      tui.write('\r');
      await waitForRequestMessage(server, 'Append an entry to my notes', 15000);

      await waitForText(() => tui.output(), 'Entry appended.', 20000);
      await sleep(500);

      const output = tui.output();

      // Card verb for append mode
      expect(screenContains(output, 'Append (notes.md)')).toBe(true);

      // Appended summary header + appended content line visible
      expect(screenContains(output, 'Appended 2 lines to notes.md')).toBe(true);
      expect(screenContains(output, '- 追加条目')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Turn 4: no-op overwrite → Write verb + unchanged marker ─

  test(
    'write_file no-op overwrite renders Write verb with content-unchanged marker',
    async () => {
      await typeText(tui, 'Rewrite the changelog identically');
      tui.write('\r');
      await waitForRequestMessage(server, 'Rewrite the changelog identically', 15000);

      await waitForText(() => tui.output(), 'Changelog re-verified.', 20000);
      await sleep(500);

      const output = tui.output();

      // Card verb: no-op overwrite is Write, not Create
      // (Create (changelog.md) from turn 2 persists in Static scrollback —
      // assert presence of the new card's label only)
      expect(screenContains(output, 'Write (changelog.md)')).toBe(true);
      expect(screenContains(output, '(content unchanged)')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
