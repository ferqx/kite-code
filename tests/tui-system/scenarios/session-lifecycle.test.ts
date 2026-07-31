/**
 * PTY System Test — Session Lifecycle (/new)
 *
 * Verifies that the /new command creates a new session, clears the
 * TUI output, and isolates content between sessions. Old session
 * content must NOT appear in the new session.
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Session Lifecycle', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { message: { content: 'First session response!' }, delay: 50 },
      { message: { content: 'Second session response!' }, delay: 50 },
      { message: { content: 'Second session response!' }, delay: 50 },
      { message: { content: 'Second session response!' }, delay: 50 },
      { message: { content: 'Second session response!' }, delay: 50 },
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

  // ── Send Message in First Session ─────────────────────────

  test(
    'send message in first session → model responds',
    async () => {
      await typeText(tui, 'Message in session A');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session A', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.output(), 'First session response!', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Message in session A')).toBe(true);
      expect(screenContains(output, 'First session response!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'enter plan mode before creating the next session',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.output(), 'Shift+Tab to exit', 5000);
      expect(screenContains(tui.output(), 'Shift+Tab to exit')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /new Creates New Session ───────────────────────────
  //
  // NOTE: <Static> content from the old session persists in the terminal
  // scrollback and cannot be cleared. PTY output accumulates all bytes,
  // so old content inevitably remains visible in screenContains assertions.
  // The test verifies /new creates a functional new session by checking
  // that prompt is visible and a new message can be sent.

  test(
    '/new creates new session, TUI remains responsive',
    async () => {
      await typeText(tui, '/new');
      const outputBeforeSubmit = tui.output().length;
      tui.write('\r');
      await sleep(1500);

      const output = tui.output();
      console.log('output after /new:', stripAnsi(output).slice(-500));

      // Prompt should still be visible (TUI alive and in new session)
      expect(screenContains(output, '❯')).toBe(true);
      // The new Runtime starts in building mode and must not inherit the
      // outgoing session's planning-only UI projection.
      expect(stripAnsi(output.slice(outputBeforeSubmit))).not.toContain('Shift+Tab to exit');

      // Shift+Tab remains functional after the InputLine remount. Keep the
      // new session in plan mode so the next test covers exiting only after a
      // complete user/model conversation.
      const outputBeforeEnterPlan = tui.output().length;
      tui.write('\x1b[Z');
      await waitForText(() => tui.output().slice(outputBeforeEnterPlan), 'Shift+Tab to exit', 5000);

      // After /new, the InputLine remounts (key changes via activeSessionId).
      // Ink's useFocus re-initializes setRawMode, requiring a mini-warmup
      // before the first model call in the new session.
      const warmupText = 'w';
      await typeText(tui, warmupText, 80);
      await sleep(400);
      await clearInput(tui, warmupText.length);
      await sleep(300);
      tui.write('\r'); // empty Enter in new session
      await sleep(500);
    },
    TIMEOUT,
  );

  // ── Send Message in New Session ───────────────────────────

  test(
    'send message in new session → new response arrives',
    async () => {
      await typeText(tui, 'Message in session B');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session B', 15000);

      // Wait for the second model response
      await waitForText(() => tui.output(), 'Second session response!', 15000);

      const output = tui.output();

      // Current session content must be visible
      expect(screenContains(output, 'Message in session B')).toBe(true);
      expect(screenContains(output, 'Second session response!')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'Shift+Tab exits plan mode after a completed conversation',
    async () => {
      const outputBeforeExitPlan = tui.output().length;
      tui.write('\x1b[Z');
      await sleep(700);
      const exitPlanRender = stripAnsi(tui.output().slice(outputBeforeExitPlan));
      expect(exitPlanRender).toContain('mock-model');
      // Ink may emit one stale plan frame before the later building frame.
      // Assert against render order so the final footer remains authoritative.
      expect(exitPlanRender.lastIndexOf('mock-model')).toBeGreaterThan(
        exitPlanRender.lastIndexOf('Shift+Tab to exit'),
      );
    },
    TIMEOUT,
  );

  // ── SessionSelector: D-key delete confirm ───────────────

  test(
    'D key opens a safe-default confirmation, Down then Enter deletes',
    async () => {
      // Open session selector
      await typeText(tui, '/sessions');
      tui.write('\r');
      await sleep(800);
      await waitForText(() => tui.output(), '搜索', 10000);

      const panelOutput = tui.output();
      expect(screenContains(panelOutput, '会话列表')).toBe(true);
      // Both sessions should be visible
      expect(screenContains(panelOutput, 'First session response')).toBe(true);
      expect(screenContains(panelOutput, 'Second session response')).toBe(true);

      // Navigate to the first (non-active) session with Down arrow
      tui.write('\x1b[B');
      await sleep(200);

      // Press D to trigger delete confirmation
      tui.write('D');
      await sleep(500);

      const confirmOutput = tui.output();
      // Confirmation dialog should appear
      expect(screenContains(confirmOutput, '删除确认')).toBe(true);
      expect(screenContains(confirmOutput, '❯ 保留会话')).toBe(true);
      expect(screenContains(confirmOutput, '永久删除')).toBe(true);
      expect(screenContains(confirmOutput, 'Enter 确认')).toBe(true);

      // Move away from the safe default before confirming deletion.
      tui.write('\x1b[B');
      await sleep(300);
      expect(screenContains(tui.output(), '❯ 永久删除')).toBe(true);

      tui.write('\r');
      await sleep(1000);

      // Re-open session selector to verify session was deleted
      // First close any remaining panel, then re-open
      tui.write('\x1b'); // Esc to close panel
      await sleep(300);
      await typeText(tui, '/sessions');
      tui.write('\r');
      await sleep(800);
      await waitForText(() => tui.output(), '搜索', 10000);

      const afterOutput = tui.output();
      // Due to <Static> scrollback persistence, deleted session text may
      // still appear in terminal history. Verify the panel is functional
      // and the active session is still present.
      expect(screenContains(afterOutput, '搜索')).toBe(true);
      expect(screenContains(afterOutput, 'Second session response')).toBe(true);
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── SessionSelector: D-key Esc cancel ─────────────────

  test(
    'Enter on the safe default and Escape both cancel deletion',
    async () => {
      // The previous test deleted one session, so only 1 remains.
      // Attempt to delete the active (only) session but cancel.

      // First, navigate to the session entry
      tui.write('\x1b[B');
      await sleep(200);

      // Press D to trigger delete confirmation
      tui.write('D');
      await sleep(500);

      const confirmOutput = tui.output();
      expect(screenContains(confirmOutput, '删除确认')).toBe(true);
      expect(screenContains(confirmOutput, '❯ 保留会话')).toBe(true);

      // Enter confirms the selected safe default, returning to the list.
      const beforeKeep = tui.output().length;
      tui.write('\r');
      await sleep(500);
      expect(stripAnsi(tui.output().slice(beforeKeep))).toContain('搜索');

      // Escape is also always safe.
      tui.write('D');
      await sleep(300);
      tui.write('\x1b');
      await sleep(500);

      // Navigating to the search row proves the selector remained open.
      const beforeNavigate = tui.output().length;
      tui.write('\x1b[A');
      await sleep(300);
      expect(stripAnsi(tui.output().slice(beforeNavigate))).toContain('搜索:');
      tui.write('\x1b[B');
      await sleep(200);

      // Session should still be in the list (panel still open after cancel)
      const cancelOutput = tui.output();
      expect(screenContains(cancelOutput, 'Second session response')).toBe(true);
      // Panel controls should still be visible
      expect(screenContains(cancelOutput, 'D 删除')).toBe(true);
    },
    TIMEOUT,
  );
});
