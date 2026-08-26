/**
 * PTY System Test — Ctrl+C Interrupt Scenarios
 *
 * Verifies:
 * - Single Ctrl+C during agent response cancels the run and recovers to idle
 * - Ctrl+C on idle does nothing harmful (TUI stays alive)
 * - Double Ctrl+C exits the TUI process (exitRequested → process.exit(0))
 *
 * Ctrl+C state machine (from agentReducer.ts CTRL_C handler):
 *   running=true           → cancelInterrupt(…, true) → running=false, ctrlCPressed=true
 *   running=false ∧ ctrlCPressed  → exitRequested=true → process.exit(0)
 *   running=false ∧ !ctrlCPressed → ctrlCPressed=true
 *
 * ctrlCPressed is reset by any other key press OR a 1-second timer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Ctrl+C Interrupt', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered.
    // Enable raw mode so individual characters reach the child immediately.
    // In canonical/line-buffered mode, input only arrives after CRLF.
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Test 1: Single Ctrl+C cancels the run ──────────────────────

  test(
    'single Ctrl+C during agent response cancels the run and TUI recovers to idle',
    async () => {
      server.setResponses([
        { message: { content: 'This response will be interrupted by Ctrl+C.' }, delay: 5000 },
      ]);
      // Send a message to trigger the agent run.
      await submitUserMessage(tui, server, 'Interrupt me');

      // Send Ctrl+C to cancel the run.
      tui.write('\x03');
      await waitForTuiReady(tui);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after Ctrl+C:', clean.slice(-300));
      const scrollback = stripAnsi(tui.scrollback());

      // TUI should still be alive — prompt must be visible.
      expect(screenContains(output, '❯')).toBe(true);

      // The delayed response should NOT have arrived (5s delay, checked at ~1.5s)
      expect(screenContains(output, 'This response will be interrupted')).toBe(false);
      expect(scrollback.split('Interrupt me').length - 1).toBe(1);
    },
    TIMEOUT,
  );

  test(
    'cancelling after the first visible model activity keeps the user prompt single in scrollback',
    async () => {
      server.setResponses([
        {
          message: {
            reasoning_chunks: ['Thinking before cancellation.'],
            content_chunks: ['unfinished', ' response'],
          },
          chunk_delay: 700,
        },
      ]);

      await submitUserMessage(tui, server, 'Cancel after Thought appears');
      // Reasoning content is redacted; cancel once a safe answer delta is visible.
      await waitForText(() => tui.viewport(), 'unfinished', 10_000);
      tui.write('\x03');
      await waitForTuiReady(tui);

      const scrollback = stripAnsi(tui.scrollback());
      expect(scrollback.split('Cancel after Thought appears').length - 1).toBe(1);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Test 2: Ctrl+C on idle does nothing harmful ─────────────────

  test(
    'Ctrl+C on idle does nothing harmful — TUI stays alive and prompt is visible',
    async () => {
      // Send Ctrl+C while TUI is idle (no agent running, ctrlCPressed=false).
      tui.write('\x03');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 1000, 250, false);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after idle Ctrl+C:', clean.slice(-300));

      // TUI should still be alive.
      expect(tui.exited).toBe(false);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Test 3: Double Ctrl+C exits TUI ────────────────────────────
  //
  test(
    'double Ctrl+C during agent response exits the TUI process with code 0',
    async () => {
      server.setResponses([
        { message: { content: 'This response will be interrupted by Ctrl+C.' }, delay: 5000 },
      ]);
      // Send a message to trigger the agent run.
      await submitUserMessage(tui, server, 'Exit after double Ctrl+C');

      // First Ctrl+C: cancels the run (running=true → cancelInterrupt).
      // Sets running=false and ctrlCPressed=true.
      tui.write('\x03');
      await waitForTuiReady(tui);

      // Second Ctrl+C: running=false ∧ ctrlCPressed=true → exitRequested=true.
      // This triggers process.exit(0) in the TUI's useEffect.
      tui.write('\x03');

      // Wait for the process to exit.
      const exitCode = await tui.waitForExit();
      console.log('  TUI process exited with code:', exitCode);

      expect(exitCode).toBe(0);
    },
    TIMEOUT,
  );
});
