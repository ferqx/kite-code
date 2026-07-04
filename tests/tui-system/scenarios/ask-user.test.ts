/**
 * PTY System Test — ask_user Question Flow
 *
 * Verifies that when the agent calls ask_user, the TUI:
 * 1. Renders the question with options in the footer area
 * 2. Accepts Enter to select the recommended/default option
 * 3. Recovers to idle state after answering
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts
 * and approval.test.ts. Without warmup, model calls are silently skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — ask_user', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: ask_user tool call — triggers need_input interrupt
    // Response #2: spare for generateSessionName wrap-around
    server.setResponses([
      {
        message: {
          content: 'Let me ask you something.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'ask_user',
              args: {
                question: 'What is your favorite color?',
                options: [
                  { id: 'blue', label: 'Blue' },
                  { id: 'red', label: 'Red' },
                ],
                recommended: 'blue',
              },
            },
          ],
        },
      },
      { message: { content: 'Ask test session' } },
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

  // ── ask_user Question → Enter to accept default ────────────

  test(
    'ask_user renders question, Enter accepts default and recovers',
    async () => {
      await typeText(tui, 'Ask me a question');
      tui.write('\r');
      await waitForRequestMessage(server, 'Ask me a question', 15000);

      // Wait for the question to appear in the TUI output
      await waitForText(() => tui.output(), 'What is your favorite color?', 15000);

      const output = tui.output();
      expect(screenContains(output, 'What is your favorite color?')).toBe(true);
      // Options should be visible
      expect(screenContains(output, 'Blue')).toBe(true);
      expect(screenContains(output, 'Red')).toBe(true);

      // Press Enter to accept the recommended/default option (Blue, index 0)
      tui.write('\r');
      await sleep(2000);

      // TUI should recover — prompt visible
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
