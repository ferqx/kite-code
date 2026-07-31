/**
 * PTY System Test — ask_user Question Flow
 *
 * Verifies that when the agent calls ask_user, the TUI:
 * 1. Renders the question with options in the footer area
 * 2. Accepts Enter to select the recommended/default option
 * 3. Recovers to idle state after answering
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

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
                questions: [
                  {
                    question: 'What is your favorite color?',
                    options: [
                      { label: 'Blue', description: 'Choose a calm primary color.' },
                      { label: 'Red', description: 'Choose a warm primary color.' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'Ask test session' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── ask_user Question → Enter to accept default ────────────

  test(
    'ask_user renders question, Enter accepts default and recovers',
    async () => {
      await typeText(tui, 'Ask me a question');
      tui.write('\r');
      await waitForRequestMessage(server, 'Ask me a question', 15000);

      // Wait for the question to appear in the TUI output
      await waitForText(() => tui.outputSinceLastAction(), 'What is your favorite color?', 15000);

      const output = tui.viewport();
      expect(screenContains(output, 'What is your favorite color?')).toBe(true);
      // Options should be visible
      expect(screenContains(output, 'Blue')).toBe(true);
      expect(screenContains(output, 'Red')).toBe(true);

      // Press Enter to accept the recommended/default option (Blue, index 0)
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

      // TUI should recover — prompt visible
      const afterOutput = tui.viewport();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
