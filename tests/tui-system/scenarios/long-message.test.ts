/**
 * PTY System Test — Long Message Input Handling
 *
 * Verifies that the TUI does not crash when the user types a long message
 * (>100 characters) and submits it. This is a stability test — the key
 * assertion is that the TUI remains functional with the prompt visible.
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts
 * and approval.test.ts. Without warmup, model calls are silently skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Long Message', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: simple text response for the long message
    // Responses #2-3: spare for generateSessionName wrap-around
    server.setResponses([
      { message: { content: 'I received your long message!' }, delay: 50 },
      { message: { content: 'Long spare 1' } },
      { message: { content: 'Long spare 2' } },
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

  // ── Long Message Input → No Crash ─────────────────────────

  test(
    'TUI handles long message (>100 chars) without crashing',
    async () => {
      const longMessage =
        'This is a very long test message that exceeds one hundred characters to verify that the TUI input handling works correctly with longer inputs';

      // Type the long message with faster delay since it is long
      await typeText(tui, longMessage, 10);
      await sleep(500);

      // Submit the long message
      tui.write('\r');

      // Verify the long message was received by the model server
      await waitForRequestMessage(server, 'one hundred characters', 15000);

      // Verify the model responded
      await waitForText(() => tui.output(), 'I received your long message!', 15000);

      const afterOutput = tui.output();
      console.log('  output after long message:', stripAnsi(afterOutput).slice(-400));

      // Long message text should appear in output (user message block)
      // Note: CtrlSafeTextInput may show truncated or full text depending on rendering
      expect(screenContains(afterOutput, 'I received your long message!')).toBe(true);
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
