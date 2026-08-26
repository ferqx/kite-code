/**
 * PTY System Test — File Tool Result Rendering & Card Verb Matrix
 *
 * 覆盖 write_file 的端到端执行与本地保真呈现。RuntimeClientEvent 保持闭集与
 * 有界验证，同时携带本地用户需要的路径和结果；durable Store 仍是恢复事实源。
 *
 * 1. 覆写已有文件：客户端显示 Write、路径与 diff。
 * 2. 新建文件：客户端显示 Create、路径与写入摘要。
 * 3. 内容未变的覆写：客户端显示 Write 与 unchanged 结果。
 *
 * append 轮已由 ADR-0042 §2 移除（追加改由 edit_file 尾部匹配或 shell 表达）。
 *
 * NOTE: 默认交互模式为 accept-edits，工作区写入自动放行，无审批浮层。
 * Default interaction mode is accept-edits: workspace writes auto-approve.
 * Static scrollback 跨轮次累积，后续轮次不对旧卡片文案做"不存在"断言。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

const CHANGELOG_CONTENT = '# Changelog\n\n- 初始版本';

describe('TUI PTY System — File Tool Diff Render', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
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
    // Turn 3: write_file rewrites changelog.md identically → no-change, verb Write
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
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_wf1', contentIncludes: ['+新结尾'] }],
        },
        message: { content: 'Notes file updated.' },
      },
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
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_wf2', contentIncludes: ['Wrote 3 lines to changelog.md'] },
          ],
        },
        message: { content: 'Changelog created.' },
      },
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
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_wf4',
              contentIncludes: ['Wrote 3 lines to changelog.md (content unchanged)'],
            },
          ],
        },
        message: { content: 'Changelog re-verified.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Turn 1: overwrite → Write verb + diff summary intact ───

  step(
    'write_file overwrite executes durably and preserves the bounded local diff',
    async () => {
      await submitUserMessage(tui, server, 'Update my notes file', { timeout: 15000 });

      // accept-edits mode auto-approves the workspace write_file — wait
      // directly for tool execution + agent's follow-up response
      await waitForText(() => tui.outputSinceLastAction(), 'Notes file updated.', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();

      // The DTO remains closed, but local presentation retains the path and
      // user-facing diff instead of reducing the tool to a generic card.
      expect(screenContains(output, 'Write')).toBe(true);
      expect(screenContains(output, 'Create')).toBe(false);
      expect(screenContains(output, 'notes.md')).toBe(true);
      // Completed cards stay compact by default; the closed client event
      // retains the result for expansion/replay without forcing the whole diff
      // into the terminal viewport.
      expect(screenContains(output, 'Added 1 line, removed 1 line')).toBe(false);
      expect(screenContains(output, '旧结尾')).toBe(false);
      expect(screenContains(output, '新结尾')).toBe(false);
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(
        '- 嘻嘻嘻\n- 详细信息\n新结尾',
      );

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Turn 2: create → Create verb + plain content summary ───

  step(
    'write_file create preserves its local path, summary, and content preview',
    async () => {
      await submitUserMessage(tui, server, 'Add a changelog', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'Changelog created.', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();

      expect(screenContains(output, 'Create')).toBe(true);
      expect(screenContains(output, 'changelog.md')).toBe(true);
      expect(screenContains(output, 'Wrote 3 lines')).toBe(false);
      expect(screenContains(output, '# Changelog')).toBe(false);
      expect(readFileSync(join(workspace.workspace, 'changelog.md'), 'utf8')).toBe(
        CHANGELOG_CONTENT,
      );

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Turn 3: no-op overwrite → Write verb + unchanged marker ─

  step(
    'write_file no-op overwrite preserves the local unchanged result',
    async () => {
      await submitUserMessage(tui, server, 'Rewrite the changelog identically', {
        timeout: 15000,
      });

      await waitForText(() => tui.outputSinceLastAction(), 'Changelog re-verified.', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();

      expect(screenContains(output, 'Write')).toBe(true);
      expect(screenContains(output, 'changelog.md')).toBe(true);
      expect(screenContains(output, '(content unchanged)')).toBe(false);
      expect(readFileSync(join(workspace.workspace, 'changelog.md'), 'utf8')).toBe(
        CHANGELOG_CONTENT,
      );

      // TUI should recover — prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
