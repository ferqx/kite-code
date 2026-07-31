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
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, persistedSessionIds } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — /compact after session switch', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sessionIdsBeforeNew: string[] = [];

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Multiple responses: each /compact triggers handleContextCompaction
    // which may call inspectManualContextCompaction (read-only). Model
    // responses are only needed for user messages, not for slash commands.
    server.setResponses([
      { message: { content: 'Session 1 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
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

  // ── Session 1 — /compact should produce a visible response ──

  test(
    '/compact in session 1 produces a response',
    async () => {
      const outputStart = tui.markOutput();
      await typeText(tui, '/compact');
      tui.write('\r');

      // /compact is a slash command — it should NOT trigger a model call.
      // The response is LOCAL_TEXT: either "Not enough messages to compact."
      // or compaction queued/completed events.
      await waitForText(() => tui.outputSinceLastAction(), 'Not enough messages', 10000);

      const output = tui.outputSince(outputStart);
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
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Create session 2 via /new ──

  test(
    '/new creates session 2',
    async () => {
      // Send a message first so /new is not ignored.
      await typeText(tui, 'Session 1 message');
      tui.write('\r');
      await waitForRequestMessage(server, 'Session 1 message', 15000);
      await waitForText(() => tui.outputSinceLastAction(), 'Session 1 response', 15000);

      sessionIdsBeforeNew = persistedSessionIds(workspace);
      expect(sessionIdsBeforeNew).toHaveLength(1);
      await typeText(tui, '/new');
      tui.write('\r');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.output();
      console.log('  output after /new:', stripAnsi(output).slice(-500));
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Session 2 — /compact should STILL produce a response ──
  // This is the regression test: after InputLine remounts (key change),
  // the useInput handler must still invoke the slash command callback.

  test(
    '/compact in session 2 produces a response (regression)',
    async () => {
      const outputStart = tui.markOutput();
      await typeText(tui, '/compact');
      tui.write('\r');

      await waitForText(() => tui.outputSinceLastAction(), 'Not enough messages', 10000);
      await waitForCondition(
        () => {
          const current = persistedSessionIds(workspace);
          return (
            current.length === sessionIdsBeforeNew.length + 1 &&
            sessionIdsBeforeNew.every((sessionId) => current.includes(sessionId))
          );
        },
        'Runtime Store to persist the distinct session created by /new',
        10_000,
      );

      const output = tui.outputSince(outputStart);
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
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Persistence: /compact survives a real TUI process restart ──

  test(
    '/compact command persists after exiting and restarting TUI',
    async () => {
      // Create a command with a unique marker in the active session.
      const marker = 'restart-persistence-marker';
      await typeText(tui, `/compact ${marker}`);
      tui.write('\r');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(screenContains(tui.outputSinceLastAction(), marker)).toBe(true);

      // Exit the first process gracefully so all RuntimeStore writes are
      // closed, then start a fresh TUI against the same HOME/workspace.
      await typeText(tui, '/exit');
      tui.write('\r');
      await tui.waitForExit();

      server.setResponses([
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
      ]);
      tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);
      tui.setRawMode(true);

      await typeText(tui, '/sessions');
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '会话列表', 10000);
      // The command-bearing session was just updated, so it is first.
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), marker, 15000);

      // tui is a fresh process: this cannot match output accumulated before
      // restart and therefore proves RuntimeEvent replay restored the command.
      const restartedOutput = tui.output();
      expect(screenContains(restartedOutput, `/compact ${marker}`)).toBe(true);
      expect(screenContains(restartedOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
