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
import {
  submitCommand,
  submitUserMessage,
  typeText,
  waitForRequestMessage,
} from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  persistedCommandSession,
  persistedSessionIds,
  persistedSessionSummaries,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

function promptRowCount(output: string): number {
  return stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => /^\s*❯(?:\s|$)/.test(line)).length;
}

function activePromptIsEmpty(output: string): boolean {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (/^\s*❯(?:\s|$)/.test(line)) return /^\s*❯\s*$/.test(line);
  }
  return false;
}

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
      await typeText(tui, 'Session 1 message');
      tui.write('\r');
      await waitForRequestMessage(server, 'Session 1 message', 15000);
      await waitForText(() => tui.outputSinceLastAction(), 'Session 1 response', 15000);

      sessionIdsBeforeNew = persistedSessionIds(workspace);
      expect(sessionIdsBeforeNew).toHaveLength(1);
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
          const current = persistedSessionIds(workspace);
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

  // ── Persistence: /compact survives a real TUI process restart ──

  step(
    '/compact command persists after exiting and restarting TUI',
    async () => {
      // Give the target session a unique first message. RuntimeStore search
      // matches explicit names and first messages, but intentionally does not
      // search the thread-id display fallback.
      const sessionSearchIdentity = 'restart persistence target identity';
      const sessionResponse = 'Restart persistence target response';
      server.setResponses(
        Array.from({ length: 8 }, () => ({
          message: { content: sessionResponse },
          delay: 10,
        })),
      );
      await submitUserMessage(tui, server, sessionSearchIdentity, { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), sessionResponse, 15000);

      // Create a command with a unique marker in the active session.
      const marker = 'restart-persistence-marker';
      const command = `/compact ${marker}`;
      const promptRowsBeforeSubmit = promptRowCount(tui.scrollback());
      await submitCommand(tui, command);

      // First prove the keyboard action committed into the current terminal
      // history. Merely seeing the command can be an unsubmitted input echo;
      // committing it adds a new historical prompt row and restores a distinct
      // empty active prompt. Persistence is a separate observation boundary.
      await waitForCondition(
        () => {
          const history = tui.scrollback();
          return (
            screenContains(history, command) &&
            promptRowCount(history) > promptRowsBeforeSubmit &&
            activePromptIsEmpty(tui.viewport())
          );
        },
        'marked compact command to commit as history before returning to an empty prompt',
        10000,
      );

      // Then prove the exact audit event reached the Runtime Store using a
      // read-only observer. Binding the witness to its thread avoids relying
      // on second-resolution session recency ordering.
      let persistedCommand: ReturnType<typeof persistedCommandSession>;
      await waitForCondition(
        () => {
          persistedCommand = persistedCommandSession(workspace, command);
          return persistedCommand !== undefined;
        },
        'user.command_invoked event to reach the Runtime Store',
        10000,
      );
      expect(persistedCommand).toBeDefined();
      const targetSession = persistedCommand!;
      expect(targetSession.name).not.toBe(targetSession.threadId);

      // Exit the first process gracefully so all RuntimeStore writes are
      // closed, then start a fresh TUI against the same HOME/workspace.
      await submitCommand(tui, '/exit');
      await tui.waitForExit();

      server.setResponses([
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
      ]);
      tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);
      tui.setRawMode(true);
      const restoredTargetSession = persistedCommandSession(workspace, command);
      expect(restoredTargetSession?.threadId).toBe(targetSession.threadId);
      const otherSessionNames = persistedSessionSummaries(workspace)
        .filter((session) => session.threadId !== targetSession.threadId)
        .map((session) => session.name);
      expect(otherSessionNames.length).toBeGreaterThan(0);

      await submitCommand(tui, '/sessions');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector chrome to finish its initial load',
        10_000,
      );

      // Filter by the unique first message of the exact thread carrying the
      // command event. Requiring every non-target row to disappear proves the
      // debounced query replaced the initial list before Enter is sent.
      await typeText(tui, sessionSearchIdentity);
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenHasSessionRow(viewport, restoredTargetSession!.name, {
              selected: true,
              active: false,
            }) &&
            otherSessionNames.every((name) => !screenHasSessionRow(viewport, name)) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'command-bearing session filter to select the exact persisted thread',
        10_000,
      );
      tui.write('\r');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, command) &&
            screenContains(viewport, '❯') &&
            !screenContains(viewport, '会话列表')
          );
        },
        'persisted compact command to replace the session selector after restart',
        15000,
      );

      // tui is a fresh process: this cannot match output accumulated before
      // restart and therefore proves RuntimeEvent replay restored the command.
      const restartedOutput = tui.viewport();
      expect(screenContains(restartedOutput, command)).toBe(true);
      expect(screenContains(restartedOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run(), 170_000);
});
