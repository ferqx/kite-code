/**
 * PTY System Test — independent client-side slash command flows.
 *
 * Each test owns its TUI, model server, workspace, and state. This keeps one
 * command failure from hiding unrelated command coverage and makes every
 * behavior independently filterable and repeatable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, submitCommand, submitUserMessage, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
  waitForTextGone,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System — Slash Commands', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([]);
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
    });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  test(
    '/help opens and Esc closes the help panel',
    async () => {
      await submitCommand(tui, '/help');
      await waitForText(() => tui.viewport(), '快捷键', 10_000);
      expect(screenContains(tui.viewport(), '快捷键')).toBe(true);

      tui.write('\x1b');
      await waitForCondition(
        () => !screenContains(tui.viewport(), 'Esc 关闭') && screenContains(tui.viewport(), '❯'),
        'help panel to close and restore the main prompt',
        5_000,
      );
    },
    TIMEOUT,
  );

  test(
    '/clear removes prior conversation state from a later export',
    async () => {
      server.setResponses([{ message: { content: 'Conversation response before clear.' } }]);
      await submitUserMessage(tui, server, 'hello world');
      await waitForText(() => tui.viewport(), 'Conversation response before clear.', 10_000);
      await waitForTuiReady(tui);

      await submitCommand(tui, '/clear');
      await waitForTuiReady(tui);
      await submitCommand(tui, '/theme');
      await waitForText(() => tui.viewport(), '选择色彩主题', 10_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 紫', 10_000);
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '选择色彩主题', 10_000);
      await waitForText(() => tui.viewport(), 'Theme set to purple', 10_000);
      await waitForTuiReady(tui);
      await submitCommand(tui, '/export');
      await waitForText(() => tui.viewport(), 'Session exported', 10_000);

      const exportDirectory = join(workspace.home, '.kite-code');
      const exportedFiles = readdirSync(exportDirectory).filter(
        (name) => name.startsWith('session-') && name.endsWith('.md'),
      );
      expect(exportedFiles).toHaveLength(1);
      const exportedContent = readFileSync(join(exportDirectory, exportedFiles[0]!), 'utf8');
      expect(exportedContent).toContain('# Kite Code Session Export');
      expect(exportedContent).toContain('**You:** /theme purple');
      expect(exportedContent).not.toContain('**You:** hello world');
      expect(exportedContent).not.toContain('Conversation response before clear.');
    },
    TIMEOUT,
  );

  test(
    '/theme opens a selector and deduplicates the same preset status message',
    async () => {
      await submitCommand(tui, '/theme');
      await waitForText(() => tui.viewport(), '选择色彩主题', 10_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 紫', 10_000);
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '选择色彩主题', 10_000);
      const beforeCount = stripAnsi(tui.viewport()).split('Theme set to purple').length - 1;

      await submitCommand(tui, '/theme');
      await waitForText(() => tui.viewport(), '选择色彩主题', 10_000);
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '选择色彩主题', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      const afterCount = stripAnsi(tui.viewport()).split('Theme set to purple').length - 1;
      expect(afterCount).toBe(beforeCount);
    },
    TIMEOUT,
  );

  test(
    '/plan enters planning and Shift+Tab returns to building mode',
    async () => {
      await submitCommand(tui, '/plan');
      await waitForText(() => tui.viewport(), 'Shift+Tab to exit', 10_000);
      expect(screenContains(tui.viewport(), 'plan')).toBe(true);

      tui.write('\x1b[Z');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          screenContains(tui.viewport(), '❯') &&
          !screenContains(tui.viewport(), 'Shift+Tab to exit'),
        'building footer after leaving planning mode',
        5_000,
      );
    },
    TIMEOUT,
  );

  test(
    '/effort refreshes the static Header and keeps a non-reasoning model interactive',
    async () => {
      await submitCommand(tui, '/effort');
      await waitForText(() => tui.viewport(), '选择推理深度', 10_000);
      tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), '❯ 高', 10_000);
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '选择推理深度', 10_000);
      await waitForText(() => tui.viewport(), 'mock-model high', 10_000);
      await waitForTuiReady(tui);
      expect(tui.viewport().match(/high/g) ?? []).toHaveLength(2);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    '/resume opens a populated selector and Esc closes it',
    async () => {
      server.setResponses([{ message: { content: 'Session selector fixture response.' } }]);
      await submitUserMessage(tui, server, 'session selector fixture');
      await waitForText(() => tui.viewport(), 'Session selector fixture response.', 10_000);
      await waitForTuiReady(tui);

      await submitCommand(tui, '/resume');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'session selector fixture') &&
          screenContains(tui.viewport(), '搜索'),
        'populated session selector to become visible',
        10_000,
      );
      expect(screenContains(tui.viewport(), '搜索: —')).toBe(true);
      const selectorLines = stripAnsi(tui.viewport()).split('\n');
      const searchRow = selectorLines.findIndex((line) => line.includes('搜索: —'));
      expect(searchRow).toBeGreaterThanOrEqual(0);
      expect(selectorLines[searchRow + 1]?.trim()).toBe('');

      tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), '❯ 搜索:', 5_000);

      tui.write('hello');
      await waitForText(() => tui.viewport(), '搜索: hello', 5_000);
      await clearInput(tui, 'hello'.length);
      await waitForText(() => tui.viewport(), '❯ 搜索:', 5_000);

      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '搜索: —', 5_000);
      tui.write('\x1b');
      await waitForTuiReady(tui);
    },
    TIMEOUT,
  );

  test(
    '/permissions opens the selector and switches automatic approval to accept edits',
    async () => {
      await submitCommand(tui, '/permissions', 80);
      await waitForText(() => tui.viewport(), '选择权限模式', 5_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 自动审批', 5_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), '自动审批', 5_000);
      expect(screenContains(tui.viewport(), '自动审批')).toBe(true);

      await submitCommand(tui, '/permissions', 80);
      await waitForText(() => tui.viewport(), '选择权限模式', 5_000);
      tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), '❯ 接受编辑', 5_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), '接受编辑', 5_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(screenContains(tui.viewport(), '自动审批')).toBe(false);
      expect(screenContains(tui.viewport(), '接受编辑')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    '/model opens the configured model selector and Esc closes it',
    async () => {
      await submitCommand(tui, '/model');
      await waitForText(() => tui.viewport(), 'mock-model', 10_000);
      expect(screenContains(tui.viewport(), 'default')).toBe(false);
      tui.write('\x1b');
      await waitForTuiReady(tui);
    },
    TIMEOUT,
  );

  test(
    '/rewind opens a checkpoint panel after a completed turn',
    async () => {
      server.setResponses([{ message: { content: 'Checkpoint fixture response.' } }]);
      await submitUserMessage(tui, server, 'checkpoint fixture');
      await waitForText(() => tui.viewport(), 'Checkpoint fixture response.', 10_000);
      await waitForTuiReady(tui);

      await submitCommand(tui, '/rewind');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), '检查点') ||
          screenContains(tui.viewport(), 'event #') ||
          screenContains(tui.viewport(), 'No checkpoints'),
        'rewind checkpoint panel',
        10_000,
      );
      tui.write('\x1b');
      await waitForTuiReady(tui);
    },
    TIMEOUT,
  );

  test(
    'partial /mc input suggests /mcp and can be explicitly cleared',
    async () => {
      await typeText(tui, '/mc');
      await waitForText(() => tui.viewport(), '管理 MCP Server', 10000);

      const output = tui.viewport();
      expect(screenContains(output, '命令匹配')).toBe(true);
      expect(screenContains(output, '命令匹配 /mc')).toBe(false);
      expect(screenContains(output, '/mcp')).toBe(true);
      expect(screenContains(output, '管理 MCP Server')).toBe(true);
      await clearInput(tui, '/mc'.length);
    },
    TIMEOUT,
  );

  test(
    'a scrolled command palette can navigate back to its first command',
    async () => {
      tui.resize(120, 16);
      await typeText(tui, '/');
      await waitForText(() => tui.viewport(), '1 / 17', 10_000);

      for (let index = 0; index < 16; index++) tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '17 / 17', 10_000);
      expect(screenContains(tui.viewport(), '/exit')).toBe(true);

      for (let index = 0; index < 16; index++) tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), '1 / 17', 10_000);
      expect(screenContains(tui.viewport(), '/effort')).toBe(true);
      await clearInput(tui, 1);
    },
    TIMEOUT,
  );

  test(
    '/mcp opens the server panel and Esc closes it',
    async () => {
      await submitCommand(tui, '/mcp');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, 'MCP 服务器') && screenContains(viewport, '添加 MCP 服务器')
          );
        },
        'MCP server panel actions to become visible',
        10_000,
      );
      tui.write('\x1b');
      await waitForTuiReady(tui);
    },
    TIMEOUT,
  );

  test(
    '/exit terminates the TUI cleanly',
    async () => {
      await submitCommand(tui, '/exit');
      expect(await tui.waitForExit()).toBe(0);
    },
    TIMEOUT,
  );
});
