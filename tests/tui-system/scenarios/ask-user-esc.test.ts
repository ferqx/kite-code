/**
 * PTY System Test — ask_user Escape to Cancel
 *
 * Verifies that when an ask_user question is active, pressing Escape
 * cancels the interrupt and the TUI recovers to idle state.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — ask_user Escape', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: ask_user tool call — triggers need_input interrupt
    // Response #2: the same turn continues after the user declines to answer
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
                    question: 'What is your preferred programming language?',
                    options: [
                      { label: 'TypeScript', description: 'Use static types and Bun tooling.' },
                      { label: 'Python', description: 'Use the Python runtime and ecosystem.' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'Continued after question cancellation.' } },
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

  // ── ask_user Question → Escape → Cancel & Recover ──────────

  test(
    'ask_user renders question, Escape cancels and recovers TUI',
    async () => {
      await typeText(tui, 'Ask a question');
      tui.write('\r');
      await waitForRequestMessage(server, 'Ask a question', 15000);

      // Wait for the question to appear in the TUI output
      await waitForText(
        () => tui.outputSinceLastAction(),
        'What is your preferred programming language?',
        15000,
      );

      const output = tui.viewport();
      expect(screenContains(output, 'What is your preferred programming language?')).toBe(true);
      // Options should be visible
      expect(screenContains(output, 'TypeScript')).toBe(true);
      expect(screenContains(output, 'Python')).toBe(true);

      // Press Escape to cancel the ask_user interrupt
      tui.write('\x1b');
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Continued after question cancellation.',
        15000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // TUI should render the follow-up model response and then recover to the prompt.
      const afterOutput = tui.viewport();
      expect(screenContains(afterOutput, 'Continued after question cancellation.')).toBe(true);
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
