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
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Input & Message', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { message: { content: 'I received your message!' }, delay: 50 },
      { message: { content: 'spare 1' }, delay: 10 },
      { message: { content: 'spare 2' }, delay: 10 },
      { message: { content: 'spare 3' }, delay: 10 },
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

  // ── Shift+Enter Soft Newline ─────────────────────────────

  test(
    'Shift+Enter inserts a newline in the input',
    async () => {
      await typeText(tui, 'Line1');
      // Kitty keyboard protocol: Shift+Enter
      tui.write('\x1b[13;2u');
      await sleep(200);
      await typeText(tui, 'Line2');
      await sleep(400);

      tui.write('\r');
      await waitForRequestMessage(server, 'Line1\nLine2', 15000);

      // Verify the model received multi-line input and responded
      await waitForText(() => tui.output(), 'I received your message!', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Line1')).toBe(true);
      expect(screenContains(output, 'Line2')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── History Navigation ──────────────────────────────────

  test(
    'Up arrow recalls last message from history',
    async () => {
      // Send first message
      await typeText(tui, 'History message A');
      tui.write('\r');
      await waitForText(() => tui.output(), 'I received your message!', 15000);

      // Send second message
      await typeText(tui, 'History message B');
      tui.write('\r');
      await waitForText(() => tui.output(), 'I received your message!', 15000);

      // Press Up to recall the last message
      tui.write('\x1b[A');
      await sleep(500);

      const output = tui.output();
      // The recalled text should appear in the input area
      expect(screenContains(output, 'History message B')).toBe(true);

      // Press Down to clear (navigate forward past the newest entry)
      tui.write('\x1b[B');
      await sleep(300);

      // Type something to verify input still works
      await typeText(tui, 'After history');
      await sleep(200);
      expect(screenContains(tui.output(), 'After history')).toBe(true);
      await clearInput(tui, 'After history'.length);
    },
    TIMEOUT,
  );

  // ── @ File Search ───────────────────────────────────────

  test(
    '@ triggers file search with matching results',
    async () => {
      await typeText(tui, '@pack');
      await sleep(800);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after @pack:', clean.slice(-500));

      // File search panel title should appear
      expect(screenContains(output, '文件匹配')).toBe(true);
      // package.json should be in the results
      expect(screenContains(output, 'package.json')).toBe(true);

      // Escape to dismiss the file search dropdown
      tui.write('\x1b');
      await sleep(300);
      await clearInput(tui, '@pack'.length);
    },
    TIMEOUT,
  );
});
