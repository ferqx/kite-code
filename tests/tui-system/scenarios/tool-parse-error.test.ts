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
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Tool Parse Error', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: malformed tool call args (missing closing brace) — triggers parse error
    // Response #2-3: spares for retry after tool parse error (agent → tools → error → agent → model retry)
    // Response #4: recovery response for follow-up message
    // Response #5-6: spare for generateSessionName
    server.setResponses([
      {
        message: {
          content: 'I will run a command.',
          invalid_tool_calls: [{ id: 'call_1', name: 'shell_execute', args: '{"command": "ls' }],
        },
        delay: 50,
      },
      { message: { content: 'Spare retry 1' }, delay: 50 },
      { message: { content: 'Spare retry 2' }, delay: 50 },
      { message: { content: 'Recovery message after parse error!' }, delay: 50 },
      { message: { content: 'Spare 4' } },
      { message: { content: 'Spare 5' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
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

  // ── Malformed Tool Call → Error Recovery ──────────────────

  test(
    'malformed tool call args do not crash TUI, returns to idle',
    async () => {
      await typeText(tui, 'Run a broken command');
      tui.write('\r');
      await waitForRequestMessage(server, 'Run a broken command', 15000);

      // Wait for the TUI to process the malformed tool call and recover
      await sleep(3000);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after parse error:', clean.slice(-500));

      // TUI must still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);

      // Verify the tool was handled: the tool card should be visible (cancelled/error state)
      // The mock returns shell_execute with broken args → tool card shows "Bash"
      const hasToolHandled = screenContains(output, 'Bash') || screenContains(output, 'Cancelled');
      expect(hasToolHandled).toBe(true);
    },
    TIMEOUT,
  );

  // ── Recovery: Accept New Message After Error ───────────────

  test(
    'TUI accepts new message after tool parse error',
    async () => {
      await typeText(tui, 'Hello after broken tool');
      tui.write('\r');
      await waitForRequestMessage(server, 'Hello after broken tool', 15000);

      // Wait for the recovery response
      await waitForText(() => tui.output(), 'Recovery message after parse error!', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Recovery message after parse error!')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
