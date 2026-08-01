/**
 * PTY System Test — Tool Parse Error Recovery
 *
 * Verifies that when the model returns malformed tool call arguments
 * (invalid JSON), the TUI handles the parse error gracefully:
 * 1. Does not crash or hang
 * 2. Returns to idle state with prompt visible
 * 3. Accepts a follow-up message after the error
 *
 * The mock server uses `invalid_tool_calls` with raw args strings
 * that simulate what happens when the model produces unparseable JSON.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Tool Parse Error', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: malformed tool call args (missing closing brace) — triggers parse error
    // Response #2: Kernel receives the synthetic tool failure and asks the model to recover.
    // Response #3: recovery response for the follow-up message.
    server.setResponses([
      {
        message: {
          content: 'I will run a command.',
          invalid_tool_calls: [{ id: 'call_1', name: 'shell_execute', args: '{"command": "ls' }],
        },
        delay: 50,
      },
      { message: { content: 'Kernel recovered after the invalid tool input.' }, delay: 50 },
      { message: { content: 'Recovery message after parse error!' }, delay: 50 },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Malformed Tool Call → Error Recovery ──────────────────

  step(
    'malformed tool call args do not crash TUI, returns to idle',
    async () => {
      await typeText(tui, 'Run a broken command');
      tui.write('\r');
      await waitForRequestMessage(server, 'Run a broken command', 15000);

      await waitForText(() => tui.outputSinceLastAction(), 'Invalid input', 15000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            (screenContains(viewport, 'Bash') || screenContains(viewport, 'Cancelled')) &&
            screenContains(viewport, 'Invalid input') &&
            screenContains(viewport, '❯')
          );
        },
        'malformed tool result and recovered prompt to coexist in the settled viewport',
        15000,
      );

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after parse error:', clean.slice(-500));

      // TUI must still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);

      // Verify the tool was handled: the tool card should be visible (cancelled/error state)
      // The mock returns shell_execute with broken args → tool card shows "Bash"
      const hasToolHandled = screenContains(output, 'Bash') || screenContains(output, 'Cancelled');
      expect(hasToolHandled).toBe(true);
      expect(screenContains(output, 'Invalid input')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Recovery: Accept New Message After Error ───────────────

  step(
    'TUI accepts new message after tool parse error',
    async () => {
      await typeText(tui, 'Hello after broken tool');
      tui.write('\r');
      await waitForRequestMessage(server, 'Hello after broken tool', 15000);

      // Wait for the recovery response
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Recovery message after parse error!',
        15000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      expect(screenContains(output, 'Recovery message after parse error!')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run());
});
