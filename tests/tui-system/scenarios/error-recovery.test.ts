/**
 * PTY System Test — Error Recovery
 *
 * Verifies that the TUI gracefully handles model errors (HTTP 500)
 * and remains functional afterwards. After an error, the TUI should:
 * 1. Stay alive with prompt visible
 * 2. Accept and process a new message normally
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Error Recovery', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { error: 'Internal server error', delay: 50 },
      // Extra spare: TUI may retry once after error before attempting user's second message
      { message: { content: 'Spare for retry' }, delay: 50 },
      { message: { content: 'Second attempt: hello from model!' }, delay: 50 },
      { message: { content: 'Spare 2' } },
      { message: { content: 'Spare 3' } },
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

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Model Error Does Not Crash TUI ────────────────────────

  test(
    'model error (HTTP 500) does not crash TUI, prompt remains visible',
    async () => {
      await typeText(tui, 'Trigger error');
      tui.write('\r');
      await waitForRequestMessage(server, 'Trigger error', 15000);

      // Allow time for the TUI to process the error response
      await sleep(2000);

      const output = tui.output();
      console.log('output after error:', stripAnsi(output).slice(-500));

      // TUI must still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);

      // Verify the error message was displayed in the TUI output
      expect(screenContains(output, 'Internal server error')).toBe(true);
    },
    TIMEOUT,
  );

  // ── TUI Accepts New Message After Error ───────────────────

  test(
    'TUI accepts new message after error and processes response normally',
    async () => {
      await typeText(tui, 'Hello after error');
      tui.write('\r');
      await waitForRequestMessage(server, 'Hello after error', 15000);

      // Wait for the second model response
      await waitForText(() => tui.output(), 'Second attempt: hello from model!', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Hello after error')).toBe(true);
      expect(screenContains(output, 'Second attempt: hello from model!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
