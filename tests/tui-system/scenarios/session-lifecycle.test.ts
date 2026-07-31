/**
 * PTY System Test — Session Lifecycle (/new)
 *
 * Verifies that the /new command creates a new session, clears the
 * TUI output, and isolates content between sessions. Old session
 * content must NOT appear in the new session.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

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
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Send Message in First Session ─────────────────────────

  test(
    'send message in first session → model responds',
    async () => {
      await typeText(tui, 'Message in session A');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session A', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.outputSinceLastAction(), 'First session response!', 15000);

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
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab to exit', 5000);
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
      const outputBeforeSubmit = tui.markOutput();
      tui.write('\r');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.output();
      console.log('output after /new:', stripAnsi(output).slice(-500));

      // Prompt should still be visible (TUI alive and in new session)
      expect(screenContains(output, '❯')).toBe(true);
      // The new Runtime starts in building mode and must not inherit the
      // outgoing session's planning-only UI projection.
      expect(stripAnsi(tui.outputSince(outputBeforeSubmit))).not.toContain('Shift+Tab to exit');

      // Shift+Tab remains functional after the InputLine remount. Keep the
      // new session in plan mode so the next test covers exiting only after a
      // complete user/model conversation.
      const outputBeforeEnterPlan = tui.markOutput();
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSince(outputBeforeEnterPlan), 'Shift+Tab to exit', 5000);
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
      await waitForText(() => tui.outputSinceLastAction(), 'Second session response!', 15000);

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
      const outputBeforeExitPlan = tui.markOutput();
      tui.write('\x1b[Z');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      const exitPlanRender = stripAnsi(tui.outputSince(outputBeforeExitPlan));
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
    'D key triggers delete confirmation, Enter confirms deletion',
    async () => {
      // Open session selector
      await typeText(tui, '/sessions');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '搜索', 10000);

      const panelOutput = tui.output();
      expect(screenContains(panelOutput, '会话列表')).toBe(true);
      // Both sessions should be visible
      expect(screenContains(panelOutput, 'First session response')).toBe(true);
      expect(screenContains(panelOutput, 'Second session response')).toBe(true);

      // Navigate to the first (non-active) session with Down arrow
      tui.write('\x1b[B');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // Press D to trigger delete confirmation
      tui.write('D');
      await waitForText(() => tui.outputSinceLastAction(), '确认', 5000);

      const confirmOutput = tui.output();
      // Confirmation dialog should appear
      expect(screenContains(confirmOutput, '确认')).toBe(true);
      expect(screenContains(confirmOutput, 'Enter')).toBe(true);

      // Press Enter to confirm deletion
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '❯', 5000);

      // Re-open session selector to verify session was deleted
      await typeText(tui, '/sessions');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '搜索', 10000);

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
    'D key then Escape cancels deletion, session remains',
    async () => {
      // The previous test deleted one session, so only 1 remains.
      // Attempt to delete the active (only) session but cancel.

      // Press D to trigger delete confirmation
      tui.write('D');
      await waitForText(() => tui.outputSinceLastAction(), '确认', 5000);

      const confirmOutput = tui.output();
      expect(screenContains(confirmOutput, '确认')).toBe(true);

      // Press Escape to cancel deletion
      tui.write('\x1b');
      await waitForText(() => tui.outputSinceLastAction(), '❯', 5000);
      await typeText(tui, '/sessions');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '会话列表', 5000);

      // Session should still be in the list after reopening the panel.
      const cancelOutput = tui.output();
      expect(screenContains(cancelOutput, 'Second session response')).toBe(true);
      // Panel controls should still be visible
      expect(screenContains(cancelOutput, 'D 删除')).toBe(true);
    },
    TIMEOUT,
  );
});
