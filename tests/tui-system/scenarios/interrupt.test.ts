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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Ctrl+C Interrupt', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Two delayed responses: one for test 1 (interrupted), one for test 3 (interrupted + exit).
    // test 2 does not send messages, so it does not consume a response.
    server.setResponses([
      { message: { content: 'This response will be interrupted by single Ctrl+C.' }, delay: 5000 },
      { message: { content: 'This response will be interrupted by double Ctrl+C.' }, delay: 5000 },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered.
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately.
    // In canonical/line-buffered mode, input only arrives after CRLF.
    tui.setRawMode(true);
    // Allow raw mode transition to settle before sending keystrokes.
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    // tui.kill() is safe even if the process already exited (test 3).
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  // ── Test 1: Single Ctrl+C cancels the run ──────────────────────

  test(
    'single Ctrl+C during agent response cancels the run and TUI recovers to idle',
    async () => {
      // Send a message to trigger the agent run (uses the first delayed mock response).
      tui.write('Interrupt me\r');

      // Wait for the user message to appear in the TUI output — this confirms
      // the TUI processed the input and is now in a running state.
      await waitForText(() => tui.output(), 'Interrupt me', 10000);

      // Send Ctrl+C to cancel the run.
      tui.write('\x03');
      // Allow TUI to process the interrupt, update state, and re-render.
      await new Promise((r) => setTimeout(r, 1000));

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after Ctrl+C:', clean.slice(-300));

      // TUI should still be alive — prompt must be visible.
      expect(screenContains(output, '❯')).toBe(true);

      // The delayed response should NOT have arrived (5s delay, checked at ~1.5s)
      expect(screenContains(output, 'This response will be interrupted')).toBe(false);

      // Reset ctrlCPressed by sending a harmless key.  After cancelInterrupt
      // the flag is true, and if it leaks into test 2 the next Ctrl+C would
      // be interpreted as a double-press (exitRequested) instead of an idle
      // single-press.  Any non-Ctrl+C key triggers RESET_CTRL_C in useGlobalKeys.
      tui.write(' ');
      await new Promise((r) => setTimeout(r, 200));
    },
    TIMEOUT,
  );

  // ── Test 2: Ctrl+C on idle does nothing harmful ─────────────────

  test(
    'Ctrl+C on idle does nothing harmful — TUI stays alive and prompt is visible',
    async () => {
      // Send Ctrl+C while TUI is idle (no agent running, ctrlCPressed=false).
      tui.write('\x03');
      await new Promise((r) => setTimeout(r, 500));

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after idle Ctrl+C:', clean.slice(-300));

      // TUI should still be alive.
      expect(screenContains(output, '❯')).toBe(true);

      // Reset ctrlCPressed so test 3 starts with a clean flag.
      tui.write(' ');
      await new Promise((r) => setTimeout(r, 200));
    },
    TIMEOUT,
  );

  // ── Test 3: Double Ctrl+C exits TUI ────────────────────────────
  //
  // IMPORTANT: this test must be last in the file because it exits the
  // TUI process.  Bun runs describe-block tests sequentially by default.

  test(
    'double Ctrl+C during agent response exits the TUI process with code 0',
    async () => {
      // Send a message to trigger the agent run (uses the second delayed mock response).
      tui.write('Exit after double Ctrl+C\r');

      // Wait for the user message to appear, confirming the TUI is in a
      // running state before we send the interrupt.
      await waitForText(() => tui.output(), 'Exit after double Ctrl+C', 10000);

      // First Ctrl+C: cancels the run (running=true → cancelInterrupt).
      // Sets running=false and ctrlCPressed=true.
      tui.write('\x03');
      // Brief pause to let React process the first CTRL_C state update.
      // The reducer runs synchronously but Ink needs one render cycle.
      await new Promise((r) => setTimeout(r, 150));

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
