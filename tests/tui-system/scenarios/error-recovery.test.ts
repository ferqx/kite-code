/**
 * PTY System Test — Error Recovery
 *
 * Verifies that the TUI exhausts the bounded retry budget for transient
 * model errors (HTTP 500) and remains functional afterwards. After an error,
 * the TUI should:
 * 1. Stay alive with prompt visible
 * 2. Accept and process a new message normally
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
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

describe('TUI PTY System — Error Recovery', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { error: 'Internal server error', delay: 50 },
      { error: 'Internal server error', delay: 50 },
      { error: 'Internal server error', delay: 50 },
      { error: 'Internal server error', delay: 50 },
      { error: 'Internal server error', delay: 50 },
      { message: { content: 'Recovered after bounded model error.' }, delay: 50 },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Model Error Does Not Crash TUI ────────────────────────

  step(
    'bounded HTTP 500 retries exhaust without crashing TUI',
    async () => {
      await submitUserMessage(tui, server, 'Trigger error', { timeout: 15000 });

      await waitForText(() => tui.outputSinceLastAction(), 'Retrying', 15000);
      await waitForText(() => tui.outputSinceLastAction(), 'Internal server error', 15000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return screenContains(viewport, 'Internal server error') && screenContains(viewport, '❯');
        },
        'model error and recovered prompt to coexist in the settled viewport',
        15000,
      );

      const output = tui.viewport();
      console.log('output after error:', stripAnsi(output).slice(-500));

      // TUI must still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);

      // Verify the error message was displayed in the TUI output
      expect(screenContains(output, 'Internal server error')).toBe(true);
      expect(server.getRequestCount()).toBe(5);
    },
    TIMEOUT,
  );

  // ── TUI Accepts New Message After Error ───────────────────

  step(
    'TUI accepts new message after error and processes response normally',
    async () => {
      await submitUserMessage(tui, server, 'Hello after error', { timeout: 15000 });

      // Wait for the next user turn's successful model response.
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Recovered after bounded model error.',
        15000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      expect(screenContains(output, 'Hello after error')).toBe(true);
      expect(screenContains(output, 'Recovered after bounded model error.')).toBe(true);
      // Prompt should still be visible
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
