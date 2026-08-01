/**
 * PTY System Test — Slash Commands
 *
 * Verifies that all client-side slash commands produce visible output
 * in the TUI terminal. No model responses are needed (these commands
 * are handled entirely on the client side).
 *
 * Command list: /help, /clear, /theme, /plan, /effort, /sessions,
 * /permissions, /model, /export, /rewind, /mcp, /exit
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, submitCommand, submitUserMessage, typeText } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Slash Commands', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Exactly one model call is made by the explicit "hello world" turn.
    server.setResponses([{ message: { content: 'Conversation response before clear.' } }]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── /help ────────────────────────────────────────────────────

  step(
    '/help opens help panel',
    async () => {
      await submitCommand(tui, '/help');

      // Help panel renders with Chinese shortcut title
      await waitForText(() => tui.outputSinceLastAction(), '快捷键', 10000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after /help:', clean.slice(-500));
      expect(screenContains(output, '快捷键')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes help ──────────────────────────────────────────

  step(
    'Esc closes help panel',
    async () => {
      // Send Escape to close the help overlay
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // Prompt should be visible again (help panel closed, TUI in normal mode)
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /clear ───────────────────────────────────────────────────

  step(
    '/clear command returns to an interactive prompt',
    async () => {
      // First send some text as user message to create content to clear
      await submitUserMessage(tui, server, 'hello world');
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Conversation response before clear.',
        10000,
      );

      // The reducer clearing contract is covered by tui-reducer.test.ts.
      // Ink <Static> lines already written to a physical terminal cannot be
      // retracted, so this PTY step only verifies command routing/recovery.
      const before = stripAnsi(tui.viewport());
      console.log('  output before /clear:', before.slice(-300));

      // Now clear
      await submitCommand(tui, '/clear');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const after = tui.viewport();
      const cleanAfter = stripAnsi(after);
      console.log('  output after /clear:', cleanAfter.slice(-500));

      // Prompt should still be visible and accept subsequent command input.
      expect(screenContains(after, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /theme purple ────────────────────────────────────────────

  step(
    '/theme purple shows theme message',
    async () => {
      await submitCommand(tui, '/theme purple');

      // Theme change should produce a status message
      await waitForText(() => tui.outputSinceLastAction(), 'Theme set to purple', 10000);

      const output = tui.viewport();
      expect(screenContains(output, 'Theme set to purple')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /theme purple again (dedup) ──────────────────────────────

  step(
    '/theme same preset twice does not duplicate message',
    async () => {
      // Get current output to use as baseline
      const before = tui.viewport();

      // Send same theme command again
      await submitCommand(tui, '/theme purple');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const after = tui.viewport();

      // Count occurrences of "Theme set to purple"
      const themeMsg = 'Theme set to purple';
      const beforeCount = stripAnsi(before).split(themeMsg).length - 1;
      const afterCount = stripAnsi(after).split(themeMsg).length - 1;

      console.log(`  "Theme set to purple" count: before=${beforeCount}, after=${afterCount}`);

      // Should not have added another theme message (dedup in TUI logic)
      expect(afterCount).toBe(beforeCount);
    },
    TIMEOUT,
  );

  // ── /plan ────────────────────────────────────────────────────

  step(
    '/plan enters planning mode',
    async () => {
      await submitCommand(tui, '/plan');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab to exit', 10000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after /plan:', clean.slice(-500));

      // Planning mode indicator: the prompt area shows a plan separator and exit hint.
      expect(screenContains(output, 'plan')).toBe(true);
      expect(screenContains(output, 'Shift+Tab to exit')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Shift+Tab exits planning ─────────────────────────────────

  step(
    'Shift+Tab exits planning mode',
    async () => {
      // Shift+Tab is ESC [ Z sequence
      tui.write('\x1b[Z');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after Shift+Tab:', clean.slice(-500));

      // Planning mode indicator should be gone
      // After exiting planning, check that 'Planning' is no longer in status area
      // We verify by checking prompt is visible and TUI is responsive
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /effort max ──────────────────────────────────────────────
  // NOTE: mock-model is not a DeepSeek provider, so effort level
  // is NOT displayed in StatsLine. The test verifies the command
  // is processed without crash and the TUI remains responsive.

  step(
    '/effort max does not crash TUI',
    async () => {
      await submitCommand(tui, '/effort max');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after /effort max:', clean.slice(-500));

      // TUI must still be alive — prompt visible, no crash
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /sessions ────────────────────────────────────────────────

  step(
    '/sessions opens session selector',
    async () => {
      await submitCommand(tui, '/sessions');

      // Session selector overlay has search + footer hints
      await waitForText(() => tui.outputSinceLastAction(), '搜索', 10000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after /sessions:', clean.slice(-500));
      expect(screenContains(output, '搜索')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes session selector ──────────────────────────────

  step(
    'Esc closes session selector',
    async () => {
      // Send Escape to close the session selector overlay
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // Prompt should be visible again (session selector closed, TUI in normal mode)
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /permissions selects an interaction mode ───────────────────

  step(
    '/permissions selects auto interaction mode',
    async () => {
      // Auto is available on every platform. Full intentionally remains
      // disabled when the CI runner has no supported sandbox backend.
      await submitCommand(tui, '/permissions auto', 80);
      await waitForText(() => tui.outputSinceLastAction(), '自动审批', 5000);

      const output = tui.viewport();
      expect(screenContains(output, '自动审批')).toBe(true);

      // The reverse transition is isolated in permissions-mode.test.ts so it
      // does not depend on this stateful journey's prior suggestion renders.
    },
    TIMEOUT,
  );

  // ── /model opens model selector ────────────────────────────

  step(
    '/model opens model selector',
    async () => {
      await submitCommand(tui, '/model');
      await waitForText(() => tui.outputSinceLastAction(), 'default', 10000);

      // Model selector overlay should show model list
      const output = tui.viewport();
      console.log('  output after /model:', stripAnsi(output).slice(-500));
      // The mock config has 'mock-model', selector should show it
      expect(screenContains(output, 'mock-model')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes model selector ──────────────────────────────

  step(
    'Esc closes model selector',
    async () => {
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /export exports session ────────────────────────────────

  step(
    '/export exports current session to file',
    async () => {
      await submitCommand(tui, '/export');
      await waitForText(() => tui.outputSinceLastAction(), 'Session exported', 10000);

      const output = tui.viewport();
      console.log('  output after /export:', stripAnsi(output).slice(-500));
      // /export writes a file and appends a text block with the path
      expect(screenContains(output, 'Session exported')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /rewind opens rewind checkpoint panel ──────────────────

  step(
    '/rewind opens checkpoint panel',
    async () => {
      await submitCommand(tui, '/rewind');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      console.log('  output after /rewind:', stripAnsi(output).slice(-500));
      // Fresh workspace has no checkpoints — empty state message
      const hasRewindUI =
        screenContains(output, 'No checkpoints') || screenContains(output, '检查点');
      expect(hasRewindUI).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes rewind panel ────────────────────────────────

  step(
    'Esc closes rewind panel',
    async () => {
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /mcp suggestion and panel ──────────────────────────────

  step(
    'partial /mc input suggests /mcp',
    async () => {
      await typeText(tui, '/mc');
      await waitForText(() => tui.outputSinceLastAction(), 'Manage MCP servers', 10000);

      const output = tui.viewport();
      expect(screenContains(output, '命令匹配 /mc')).toBe(true);
      expect(screenContains(output, '/mcp')).toBe(true);
      expect(screenContains(output, 'Manage MCP servers')).toBe(true);

      await clearInput(tui, '/mc'.length);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
    },
    TIMEOUT,
  );

  step(
    '/mcp opens MCP panel',
    async () => {
      await submitCommand(tui, '/mcp');
      await waitForText(() => tui.outputSinceLastAction(), 'MCP Servers', 10000);

      const output = tui.viewport();
      console.log('  output after /mcp:', stripAnsi(output).slice(-500));
      expect(screenContains(output, 'MCP Servers')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes MCP panel ───────────────────────────────────

  step(
    'Esc closes MCP panel',
    async () => {
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /exit (MUST be last test) ────────────────────────────────

  step(
    '/exit exits process with code 0',
    async () => {
      await submitCommand(tui, '/exit');

      const exitCode = await tui.waitForExit();
      console.log(`  TUI exited with code ${exitCode}`);
      expect(exitCode).toBe(0);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run());
});
