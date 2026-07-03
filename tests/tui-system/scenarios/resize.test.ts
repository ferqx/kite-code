/**
 * PTY System Test — Terminal Resize
 *
 * Verifies TUI survives terminal resize operations without crashing.
 *
 * Platform note from Phase 0 (tests/pty-spike/pty-verify.test.ts):
 * - On Windows (win32), ConPTY does NOT forward resize signals (SIGWINCH)
 *   to the child process. `terminal.resize()` is callable but the child's
 *   `process.stdout.columns`/`rows` do not change.
 * - On Linux/macOS, resize triggers SIGWINCH and Ink re-renders.
 *
 * These tests focus on "TUI survives resize" rather than "TUI re-renders
 * at new dimensions" — they pass on all platforms.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Terminal Resize', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Provide an empty mock response so the TUI model provider
    // resolves on startup (defensive — we are not sending messages).
    server.setResponses([{ message: { content: '' }, delay: 0 }]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered before running any test
    await waitForText(() => tui.output(), '❯', 15000);
    // Allow Ink render to settle
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(() => {
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  // ── Test 1: Initial Render at Configured Dimensions ──────────

  test(
    'TUI renders at initial dimensions (120x40)',
    async () => {
      const output = tui.output();
      const clean = stripAnsi(output);

      console.log('  output snapshot (last 500 chars):', clean.slice(-500));

      // Prompt should be visible — basic sign of a live TUI
      expect(screenContains(output, '❯')).toBe(true);

      // Output should have meaningful content — not just an empty PTY buffer
      expect(clean.length).toBeGreaterThan(0);

      // The initial spawn used cols=120, rows=40; the resize() API
      // itself is exercised in the tests below, but we verify the
      // spawn dimensions did not prevent rendering.
    },
    TIMEOUT,
  );

  // ── Test 2: Single Resize to Smaller Terminal ────────────────

  test(
    'TUI survives resize to smaller terminal (80x24)',
    async () => {
      // Call resize — on Linux/macOS this triggers SIGWINCH;
      // on Windows ConPTY the child dimensions do not change
      // but the call itself must not throw.
      tui.resize(80, 24);

      // Give the TUI time to process and re-render.
      await new Promise((r) => setTimeout(r, 800));

      // TUI should still be alive with prompt visible.
      const output = tui.output();
      expect(screenContains(output, '❯')).toBe(true);

      console.log('  resize to 80x24 — prompt still visible, TUI alive');
    },
    TIMEOUT,
  );

  // ── Test 3: Multiple Consecutive Resizes ─────────────────────

  test(
    'TUI survives multiple consecutive resizes',
    async () => {
      // Resize 1: 80x24 → 100x30
      tui.resize(100, 30);
      await new Promise((r) => setTimeout(r, 600));
      expect(screenContains(tui.output(), '❯')).toBe(true);
      console.log('  resize 80x24→100x30 — alive');

      // Resize 2: 100x30 → 80x24
      tui.resize(80, 24);
      await new Promise((r) => setTimeout(r, 600));
      expect(screenContains(tui.output(), '❯')).toBe(true);
      console.log('  resize 100x30→80x24 — alive');

      // Resize 3: 80x24 → 120x40 (back to original)
      tui.resize(120, 40);
      await new Promise((r) => setTimeout(r, 600));
      expect(screenContains(tui.output(), '❯')).toBe(true);
      console.log('  resize 80x24→120x40 — alive');
    },
    TIMEOUT,
  );
});
