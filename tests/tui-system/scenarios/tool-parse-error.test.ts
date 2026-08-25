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
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
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
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_1', contentIncludes: ['tool_invalid_args'] }],
        },
        message: { content: 'Kernel recovered after the invalid tool input.' },
        delay: 50,
      },
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
      await submitUserMessage(tui, server, 'Run a broken command', { timeout: 15000 });

      await waitForText(
        () => tui.outputSinceLastAction(),
        'Kernel recovered after the invalid tool input.',
        15000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, 'Kernel recovered after the invalid tool input.') &&
            screenContains(viewport, '❯')
          );
        },
        'malformed tool result and recovered prompt to coexist in the settled viewport',
        15000,
      );

      const output = tui.viewport();
      // TUI must still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'Kernel recovered after the invalid tool input.')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Recovery: Accept New Message After Error ───────────────

  step(
    'TUI accepts new message after tool parse error',
    async () => {
      await submitUserMessage(tui, server, 'Hello after broken tool', { timeout: 15000 });

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
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
