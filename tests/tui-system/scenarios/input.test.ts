/**
 * PTY System Test — Input & Message Send
 *
 * Verifies basic text input, empty Enter rejection,
 * and full message send → agent response cycle.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Input & Message', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([{ message: { content: 'I received your message!' }, delay: 50 }]);

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

  // ── Text Input ────────────────────────────────────────────

  test(
    'individual keystrokes reach TUI input line',
    async () => {
      // In raw mode, individual bytes go directly to child stdin.
      // Send chars one at a time with delays matching human typing speed.
      const text = 'hello';
      await typeText(tui, text, 80);
      // Allow Ink to re-render the input state
      await sleep(400);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after typing:', clean.slice(-300));
      // The typed text should appear in the input area
      // (CtrlSafeTextInput renders the current value near the prompt)
      expect(clean).toContain(text);

      await clearInput(tui, text.length);
    },
    TIMEOUT,
  );

  // ── Empty Enter ───────────────────────────────────────────

  test(
    'empty Enter (no text) does not submit a message',
    async () => {
      const before = server.getRequestCount();
      // Send Enter with empty input
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      // TUI should still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  // ── Send Message → Response ───────────────────────────────

  test(
    'send message → agent responds with mock text',
    async () => {
      await typeText(tui, 'Test message from PTY');
      tui.write('\r');
      await waitForRequestMessage(server, 'Test message from PTY', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.output(), 'I received your message!', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Test message from PTY')).toBe(true);
      expect(screenContains(output, 'I received your message!')).toBe(true);
    },
    TIMEOUT,
  );
});
