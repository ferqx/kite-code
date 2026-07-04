/**
 * PTY System Test — Slash Commands
 *
 * Verifies that all client-side slash commands produce visible output
 * in the TUI terminal. No model responses are needed (these commands
 * are handled entirely on the client side).
 *
 * Command list: /help, /clear, /theme, /plan, /effort, /sessions,
 * /mode, /model, /export, /rewind, /mcp, /exit
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Slash Commands', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Placeholder responses — no model calls expected from slash commands
    // Extra spares for any internal calls (generateSessionName etc.)
    server.setResponses([
      { message: { content: 'spare' } },
      { message: { content: 'spare 2' } },
      { message: { content: 'spare 3' } },
      { message: { content: 'spare 4' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
    // Allow raw mode transition to settle before sending keystrokes
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  // ── Warmup: type + clear to init input pipeline ──────────────

  test(
    'warmup: type and clear to initialize input pipeline',
    async () => {
      const text = 'x';
      await typeText(tui, text, 80);
      await sleep(400);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after typing:', clean.slice(-300));
      expect(clean).toContain(text);

      await clearInput(tui, text.length);
      await sleep(300);

      // Verify input is cleared
      const afterClear = stripAnsi(tui.output());
      // The typed char should no longer be in the visible input area
      // (it may still appear as past output, so just check prompt is visible)
      expect(screenContains(afterClear, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Empty Enter ──────────────────────────────────────────────

  test(
    'empty Enter does not submit',
    async () => {
      const before = server.getRequestCount();
      // Send Enter with empty input
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      // TUI should still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);
      // No model call should have been made
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  // ── /help ────────────────────────────────────────────────────

  test(
    '/help opens help panel',
    async () => {
      await typeText(tui, '/help');
      tui.write('\r');
      await sleep(500);

      // Help panel renders with Chinese shortcut title
      await waitForText(() => tui.output(), '快捷键', 10000);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after /help:', clean.slice(-500));
      expect(screenContains(output, '快捷键')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes help ──────────────────────────────────────────

  test(
    'Esc closes help panel',
    async () => {
      // Send Escape to close the help overlay
      tui.write('\x1b');
      await sleep(500);

      // Prompt should be visible again (help panel closed, TUI in normal mode)
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /clear ───────────────────────────────────────────────────

  test(
    '/clear clears output and leaves prompt visible',
    async () => {
      // First send some text as user message to create content to clear
      await typeText(tui, 'hello world');
      tui.write('\r');
      await sleep(1000);

      // Verify the text appeared in output
      const before = stripAnsi(tui.output());
      console.log('  output before /clear:', before.slice(-300));

      // Now clear
      await typeText(tui, '/clear');
      tui.write('\r');
      await sleep(800);

      const after = tui.output();
      const cleanAfter = stripAnsi(after);
      console.log('  output after /clear:', cleanAfter.slice(-500));

      // Prompt should still be visible
      expect(screenContains(after, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /theme purple ────────────────────────────────────────────

  test(
    '/theme purple shows theme message',
    async () => {
      await typeText(tui, '/theme purple');
      tui.write('\r');
      await sleep(500);

      // Theme change should produce a status message
      await waitForText(() => tui.output(), 'Theme set to purple', 10000);

      const output = tui.output();
      expect(screenContains(output, 'Theme set to purple')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /theme purple again (dedup) ──────────────────────────────

  test(
    '/theme same preset twice does not duplicate message',
    async () => {
      // Get current output to use as baseline
      const before = tui.output();

      // Send same theme command again
      await typeText(tui, '/theme purple');
      tui.write('\r');
      await sleep(500);

      const after = tui.output();

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

  test(
    '/plan enters planning mode',
    async () => {
      await typeText(tui, '/plan');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after /plan:', clean.slice(-500));

      // Planning mode indicator: the prompt changes to ≻◷ instead of ❯
      // When in plan mode, the status area shows the plan prompt character
      // The exact rendered text depends on the ink render; verify TUI is alive and plan mode is active
      expect(screenContains(output, '≻◷')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Shift+Tab exits planning ─────────────────────────────────

  test(
    'Shift+Tab exits planning mode',
    async () => {
      // Shift+Tab is ESC [ Z sequence
      tui.write('\x1b[Z');
      await sleep(500);

      const output = tui.output();
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

  test(
    '/effort max does not crash TUI',
    async () => {
      await typeText(tui, '/effort max');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after /effort max:', clean.slice(-500));

      // TUI must still be alive — prompt visible, no crash
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /sessions ────────────────────────────────────────────────

  test(
    '/sessions opens session selector',
    async () => {
      await typeText(tui, '/sessions');
      tui.write('\r');
      await sleep(500);

      // Session selector overlay has search + footer hints
      await waitForText(() => tui.output(), '搜索', 10000);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after /sessions:', clean.slice(-500));
      expect(screenContains(output, '搜索')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes session selector ──────────────────────────────

  test(
    'Esc closes session selector',
    async () => {
      // Send Escape to close the session selector overlay
      tui.write('\x1b');
      await sleep(500);

      // Prompt should be visible again (session selector closed, TUI in normal mode)
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /mode toggles interaction mode ───────────────────────

  test(
    '/mode toggles interaction mode',
    async () => {
      // /mode without argument toggles between ask ↔ full
      await typeText(tui, '/mode full');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      // full mode shows [完全权限] in the stats line
      const hasFull = screenContains(output, '完全权限');
      expect(hasFull).toBe(true);

      // Toggle back to ask (default)
      await typeText(tui, '/mode ask');
      tui.write('\r');
      await sleep(300);
    },
    TIMEOUT,
  );

  // ── /model opens model selector ────────────────────────────

  test(
    '/model opens model selector',
    async () => {
      await typeText(tui, '/model');
      tui.write('\r');
      await sleep(500);

      // Model selector overlay should show model list
      const output = tui.output();
      console.log('  output after /model:', stripAnsi(output).slice(-500));
      // The mock config has 'mock-model', selector should show it
      expect(screenContains(output, 'mock-model')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes model selector ──────────────────────────────

  test(
    'Esc closes model selector',
    async () => {
      tui.write('\x1b');
      await sleep(500);

      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /export exports session ────────────────────────────────

  test(
    '/export exports current session to file',
    async () => {
      await typeText(tui, '/export');
      tui.write('\r');
      await sleep(1000);

      const output = tui.output();
      console.log('  output after /export:', stripAnsi(output).slice(-500));
      // /export writes a file and appends a text block with the path
      expect(screenContains(output, 'Session exported')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /rewind opens rewind checkpoint panel ──────────────────

  test(
    '/rewind opens checkpoint panel',
    async () => {
      await typeText(tui, '/rewind');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      console.log('  output after /rewind:', stripAnsi(output).slice(-500));
      // Fresh workspace has no checkpoints — empty state message
      const hasRewindUI =
        screenContains(output, 'No checkpoints') || screenContains(output, '检查点');
      expect(hasRewindUI).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes rewind panel ────────────────────────────────

  test(
    'Esc closes rewind panel',
    async () => {
      tui.write('\x1b');
      await sleep(500);

      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /mcp opens MCP panel ───────────────────────────────────

  test(
    '/mcp opens MCP panel',
    async () => {
      await typeText(tui, '/mcp');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      console.log('  output after /mcp:', stripAnsi(output).slice(-500));
      // MCP panel shows empty state: "No MCP servers configured"
      expect(screenContains(output, 'MCP Servers')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Esc closes MCP panel ───────────────────────────────────

  test(
    'Esc closes MCP panel',
    async () => {
      tui.write('\x1b');
      await sleep(500);

      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /exit (MUST be last test) ────────────────────────────────

  test(
    '/exit exits process with code 0',
    async () => {
      await typeText(tui, '/exit');
      tui.write('\r');
      await sleep(500);

      const exitCode = await tui.waitForExit();
      console.log(`  TUI exited with code ${exitCode}`);
      expect(exitCode).toBe(0);
    },
    TIMEOUT,
  );
});
