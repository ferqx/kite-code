/**
 * PTY System Test — Multi-turn Messages
 *
 * Verifies that one TUI process can submit two user messages in the same
 * session and receive two model responses. This covers the PTY-level symptom
 * where the first message worked but a second message did not trigger a new
 * model request.
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Multi-turn Messages', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { message: { content: 'First PTY turn response' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.output(), '❯', 15000);

    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  test(
    'individual keystrokes reach TUI input line',
    async () => {
      const text = 'hello';
      await typeText(tui, text, 80);
      await sleep(400);

      const clean = stripAnsi(tui.output());
      expect(clean).toContain(text);

      await clearInput(tui, text.length);
    },
    TIMEOUT,
  );

  test(
    'empty Enter (no text) does not submit a message',
    async () => {
      const before = server.getRequestCount();
      tui.write('\r');
      await sleep(500);

      expect(screenContains(tui.output(), '❯')).toBe(true);
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  test(
    'second message in same PTY session triggers another model request',
    async () => {
      await typeText(tui, 'First multi-turn message');
      tui.write('\r');
      await waitForRequestMessage(server, 'First multi-turn message', 15000);
      await waitForText(() => tui.output(), 'First PTY turn response', 15000);

      await sleep(2000);

      await typeText(tui, 'Second multi-turn message');
      tui.write('\r');
      await waitForRequestMessage(server, 'Second multi-turn message', 15000);
      await waitForText(() => tui.output(), 'Second PTY turn response', 15000);

      expect(screenContains(tui.output(), 'First multi-turn message')).toBe(true);
      expect(screenContains(tui.output(), 'Second multi-turn message')).toBe(true);
      expect(screenContains(tui.output(), 'First PTY turn response')).toBe(true);
      expect(screenContains(tui.output(), 'Second PTY turn response')).toBe(true);
    },
    TIMEOUT,
  );
});
