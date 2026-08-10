/**
 * PTY System Test — /compact survives session switch
 *
 * Verifies that the /compact slash command produces a visible response
 * (either "Not enough messages to compact." or compaction events) after
 * switching between sessions. Regression test for the Ink 7 useInput
 * stale closure bug where slash commands silently fail after the
 * InputLine component remounts via key={activeSessionId}.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedSessionIds,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — /compact after session switch', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sessionIdsBeforeNew: string[] = [];

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Slash commands stay local; only the explicit session-1 message calls the model.
    server.setResponses([{ message: { content: 'Session 1 response' }, delay: 50 }]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Session 1 — /compact should produce a visible response ──

  step(
    '/compact in session 1 produces a response',
    async () => {
      const screenStart = tui.markScreen();
      await submitCommand(tui, '/compact');

      // /compact is a slash command — it should NOT trigger a model call.
      // The response is LOCAL_TEXT: either "Not enough messages to compact."
      // or compaction queued/completed events.
      await waitForText(() => tui.outputSinceLastAction(), 'Not enough messages', 10000);

      const output = tui.screenFramesSince(screenStart).join('\n');
      const clean = stripAnsi(output);
      console.log('  output after /compact (session 1):', clean.slice(-500));

      // At minimum, the /compact command text should appear as USER_MESSAGE.
      const hasCompactCommand = screenContains(output, '/compact');
      expect(hasCompactCommand).toBe(true);

      // And there should be some response text.
      const hasResponse =
        screenContains(output, 'Not enough messages') ||
        screenContains(output, 'compaction') ||
        screenContains(output, 'Compacting');
      expect(hasResponse).toBe(true);

      // Prompt still visible — TUI responsive.
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Create session 2 via /new ──

  step(
    '/new creates session 2',
    async () => {
      // Send a message first so /new is not ignored.
      await submitUserMessage(tui, server, 'Session 1 message', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Session 1 response', 15000);

      await waitForCondition(
        () => {
          const observation = observePersistedSessionIds(workspace);
          return observation.status === 'ready' && observation.value.length === 1;
        },
        'Runtime Store to persist session 1 before /new',
        10_000,
      );
      sessionIdsBeforeNew = requirePersistedRuntimeReady(observePersistedSessionIds(workspace));
      await submitCommand(tui, '/new');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      console.log('  output after /new:', stripAnsi(output).slice(-500));
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Session 2 — /compact should STILL produce a response ──
  // This is the regression test: after InputLine remounts (key change),
  // the useInput handler must still invoke the slash command callback.

  step(
    '/compact in session 2 produces a response (regression)',
    async () => {
      const screenStart = tui.markScreen();
      await submitCommand(tui, '/compact');

      await waitForText(() => tui.outputSinceLastAction(), 'Not enough messages', 10000);
      await waitForCondition(
        () => {
          const observation = observePersistedSessionIds(workspace);
          if (observation.status !== 'ready') return false;
          const current = observation.value;
          return (
            current.length === sessionIdsBeforeNew.length + 1 &&
            sessionIdsBeforeNew.every((sessionId) => current.includes(sessionId))
          );
        },
        'Runtime Store to persist the distinct session created by /new',
        10_000,
      );

      const output = tui.screenFramesSince(screenStart).join('\n');
      const clean = stripAnsi(output);
      console.log('  output after /compact (session 2):', clean.slice(-500));

      // /compact command should appear.
      const hasCompactCommand = screenContains(output, '/compact');
      expect(hasCompactCommand).toBe(true);

      // Response must be visible — if useInput stale, nothing appears.
      const hasResponse =
        screenContains(output, 'Not enough messages') ||
        screenContains(output, 'compaction') ||
        screenContains(output, 'Compacting');
      expect(hasResponse).toBe(true);

      // TUI still responsive.
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
