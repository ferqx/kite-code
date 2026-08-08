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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Terminal Resize', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let probeSequence = 0;

  async function expectInteractiveAfterResize(): Promise<void> {
    const probe = `rz${++probeSequence}`;
    await typeText(tui, probe);
    expect(screenContains(tui.viewport(), probe)).toBe(true);
    await clearInput(tui, probe.length);
    expect(screenContains(tui.viewport(), probe)).toBe(false);
  }

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Provide an empty mock response so the TUI model provider
    // resolves on startup (defensive — we are not sending messages).
    server.setResponses([]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered before running any test
    // Enable raw mode so individual characters reach the child immediately
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Multiple Consecutive Resizes ─────────────────────────────

  test(
    'TUI survives consecutive resizes and remains interactive',
    async () => {
      // Resize 1: 80x24 → 100x30
      tui.resize(100, 30);
      await expectInteractiveAfterResize();
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
      console.log('  resize 80x24→100x30 — alive');

      // Resize 2: 100x30 → 80x24
      tui.resize(80, 24);
      await expectInteractiveAfterResize();
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
      console.log('  resize 100x30→80x24 — alive');

      // Resize 3: 80x24 → 120x40 (back to original)
      tui.resize(120, 40);
      await expectInteractiveAfterResize();
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
      console.log('  resize 80x24→120x40 — alive');
    },
    TIMEOUT,
  );
});
