/**
 * PTY System Test — Input & Message Send
 *
 * Verifies basic text input, empty Enter rejection,
 * and full message send → agent response cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  clearInput,
  pasteText,
  submitCurrentInput,
  submitUserMessage,
  submitUserMessageForDeferredDelivery,
  typeText,
  waitForRequestMessage,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
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
      await submitUserMessage(tui, server, 'Test message from PTY', { timeout: 15000 });

      // Wait for the mock model response
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);

      const output = tui.viewport();
      expect(screenContains(output, 'Test message from PTY')).toBe(true);
      expect(screenContains(output, 'I received your message!')).toBe(true);
      expect(stripAnsi(output).split('Test message from PTY').length - 1).toBe(1);
    },
    TIMEOUT,
  );

  test(
    'queues a second message while the current turn is running',
    async () => {
      server.setResponses([
        { message: { content: 'First turn completed.' }, delay: 800 },
        { message: { content: 'Queued turn completed.' }, delay: 50 },
      ]);

      await submitUserMessage(tui, server, 'First message', { timeout: 15000 });

      const queuedDelivery = await submitUserMessageForDeferredDelivery(
        tui,
        server,
        'Second queued message',
        {
          acceptWhen: (viewport) => screenContains(viewport, '↵ Second queued message'),
          timeout: 15000,
        },
      );

      expect(server.getRequestCount()).toBe(queuedDelivery.requestBaseline);
      const queuedViewport = stripAnsi(tui.viewport());
      expect(queuedViewport).not.toContain('Working');
      expect(queuedViewport).toContain('Second queued message');
      await queuedDelivery.waitForRuntimeRequest();
      await waitForText(() => tui.viewport(), 'Queued turn completed.', 15000);

      const output = stripAnsi(tui.viewport());
      expect(output.split('First message').length - 1).toBe(1);
      expect(output.split('Second queued message').length - 1).toBe(1);
      expect(output.indexOf('First turn completed.')).toBeLessThan(
        output.indexOf('Queued turn completed.'),
      );
    },
    TIMEOUT,
  );

  // ── Multiline Input ──────────────────────────────────────

  test(
    'bracketed paste preserves a newline in the submitted message',
    async () => {
      server.setResponses([{ message: { content: 'I received your message!' }, delay: 50 }]);
      const requestBaseline = server.getRequestCount();
      await pasteText(tui, 'Line1\nLine2');

      await submitCurrentInput(tui);
      await waitForRequestMessage(server, 'Line1\nLine2', 15000, {
        since: requestBaseline,
        tui,
      });

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
      await submitUserMessage(tui, server, 'History message A', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);
      await waitForTuiReady(tui);

      // Send second message
      await submitUserMessage(tui, server, 'History message B', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'I received your message!', 15000);
      await waitForTuiReady(tui);

      // Press Up to recall the last message
      tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), 'History message B', 5000);

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
      await waitForText(() => tui.viewport(), 'package.json', 5000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after @pack:', clean.slice(-500));

      // File search panel title should appear
      expect(screenContains(output, '文件匹配')).toBe(true);
      // package.json should be in the results
      expect(screenContains(output, 'package.json')).toBe(true);

      // Select the matched path, then explicitly clear the resulting input.
      // This proves the overlay owns the current query and leaves no hidden
      // input state for the next scenario.
      tui.write('\t');
      await waitForText(() => tui.viewport(), '@package.json', 5000);
      await clearInput(tui, '@package.json '.length);
    },
    TIMEOUT,
  );
});
