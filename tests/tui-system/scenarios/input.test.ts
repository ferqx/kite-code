/**
 * PTY System Test — Input & Message Send
 *
 * Verifies basic text input, empty Enter rejection,
 * and full message send → agent response cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Input & Message', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: {
        'package.json': '{"name":"input-search-fixture"}\n',
      },
    });

    server.setResponses([]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Send Message → Response ───────────────────────────────

  test(
    'send message → agent responds with mock text',
    async () => {
      server.setResponses([{ message: { content: 'I received your message!' }, delay: 50 }]);
      await typeText(tui, 'Test message from PTY');
      tui.write('\r');
      await waitForRequestMessage(server, 'Test message from PTY', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);

      const output = tui.viewport();
      expect(screenContains(output, 'Test message from PTY')).toBe(true);
      expect(screenContains(output, 'I received your message!')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Shift+Enter Soft Newline ─────────────────────────────

  test(
    'Shift+Enter inserts a newline in the input',
    async () => {
      server.setResponses([{ message: { content: 'I received your message!' }, delay: 50 }]);
      await typeText(tui, 'Line1');
      // Kitty keyboard protocol: Shift+Enter
      tui.write('\x1b[13;2u');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await typeText(tui, 'Line2', { append: true });

      tui.write('\r');
      await waitForRequestMessage(server, 'Line1\nLine2', 15000);

      // Verify the model received multi-line input and responded
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);

      const output = tui.viewport();
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
      server.setResponses([
        { message: { content: 'I received your message!' }, delay: 50 },
        { message: { content: 'I received your message!' }, delay: 50 },
      ]);
      // Send first message
      await typeText(tui, 'History message A');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);

      // Send second message
      await typeText(tui, 'History message B');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);

      // Press Up to recall the last message
      tui.write('\x1b[A');
      await waitForText(() => tui.outputSinceLastAction(), 'History message B', 5000);

      const output = tui.viewport();
      // The recalled text should appear in the input area
      expect(screenContains(output, 'History message B')).toBe(true);

      // Press Down to clear (navigate forward past the newest entry)
      tui.write('\x1b[B');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // Type something to verify input still works
      await typeText(tui, 'After history');
      expect(screenContains(tui.viewport(), 'After history')).toBe(true);
      await clearInput(tui, 'After history'.length);
    },
    TIMEOUT,
  );

  // ── @ File Search ───────────────────────────────────────

  test(
    '@ triggers file search with matching results',
    async () => {
      await typeText(tui, '@pack');
      await waitForText(() => tui.outputSinceLastAction(), 'package.json', 5000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after @pack:', clean.slice(-500));

      // File search panel title should appear
      expect(screenContains(output, '文件匹配')).toBe(true);
      // package.json should be in the results
      expect(screenContains(output, 'package.json')).toBe(true);

      // Escape to dismiss the file search dropdown
      tui.write('\x1b');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
    },
    TIMEOUT,
  );
});
