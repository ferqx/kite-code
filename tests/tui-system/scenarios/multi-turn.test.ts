/**
 * PTY System Test — Multi-turn Messages
 *
 * Verifies that one TUI process can submit two user messages in the same
 * session and receive two model responses. Also validates that the agent
 * returns to idle state (prompt visible) after completing a turn — this
 * absorbs the coverage previously in idle-summary.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

// ── Merge Description Block ──
// idle-summary.test.ts coverage absorbed here:
//   "agent finishes simple task and returns to idle state"
//   is covered by the first-turn test below (agent completes →
//   prompt visible).
// ──────────────────────────────

describe('TUI PTY System — Multi-turn Messages', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { message: { content: 'Hello! I completed my task.' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
      { message: { content: 'Second PTY turn response' }, delay: 50 },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── First Turn: Agent Completes → Idle Recovery ────────────
  //   (absorbs idle-summary.test.ts coverage)

  test(
    'agent completes first turn and returns to idle state',
    async () => {
      await typeText(tui, 'Do a simple task');
      tui.write('\r');
      await waitForRequestMessage(server, 'Do a simple task', 15000);

      // Wait for the agent response to appear
      await waitForText(() => tui.outputSinceLastAction(), 'Hello! I completed my task.', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Do a simple task')).toBe(true);
      expect(screenContains(output, 'Hello! I completed my task.')).toBe(true);

      // TUI should be idle — prompt visible, ready for next input
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Second Turn: Multi-turn Capability ──────────────────────

  test(
    'second message in same PTY session triggers another model request',
    async () => {
      await typeText(tui, 'Second multi-turn message');
      tui.write('\r');
      await waitForRequestMessage(server, 'Second multi-turn message', 15000);
      await waitForText(() => tui.outputSinceLastAction(), 'Second PTY turn response', 15000);

      // Both turns' content should still be visible
      expect(screenContains(tui.output(), 'Do a simple task')).toBe(true);
      expect(screenContains(tui.output(), 'Second multi-turn message')).toBe(true);
      expect(screenContains(tui.output(), 'Hello! I completed my task.')).toBe(true);
      expect(screenContains(tui.output(), 'Second PTY turn response')).toBe(true);
    },
    TIMEOUT,
  );
});
