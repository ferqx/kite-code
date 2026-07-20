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
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — /compact after session switch', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

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

    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Warmup ──

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Session 1 — /compact should produce a visible response ──

  test(
    '/compact in session 1 produces a response',
    async () => {
      const outputStart = tui.output().length;
      await typeText(tui, '/compact');
      tui.write('\r');

      // /compact is a slash command — it should NOT trigger a model call.
      // The response is LOCAL_TEXT: either "Not enough messages to compact."
      // or compaction queued/completed events.
      await sleep(1000);

      const output = tui.output().slice(outputStart);
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
      await waitForText(() => tui.output(), 'Session 1 response', 15000);

      await typeText(tui, '/new');
      tui.write('\r');
      await sleep(1500);

      const output = tui.output();
      console.log('  output after /new:', stripAnsi(output).slice(-500));
      expect(screenContains(output, '❯')).toBe(true);

      // Mini-warmup after InputLine remount.
      const warmupText = 'w';
      await typeText(tui, warmupText, 80);
      await sleep(400);
      await clearInput(tui, warmupText.length);
      await sleep(300);
      tui.write('\r');
      await sleep(500);
    },
    TIMEOUT,
  );

  // ── Session 2 — /compact should STILL produce a response ──
  // This is the regression test: after InputLine remounts (key change),
  // the useInput handler must still invoke the slash command callback.

  test(
    '/compact in session 2 produces a response (regression)',
    async () => {
      const outputStart = tui.output().length;
      await typeText(tui, '/compact');
      tui.write('\r');

      await sleep(1000);

      const output = tui.output().slice(outputStart);
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
      // Close any overlay left by the preceding navigation test, then create a
      // command with a unique marker in the currently active session.
      tui.write('\x1b');
      await sleep(300);
      const marker = 'restart-persistence-marker';
      await typeText(tui, `/compact ${marker}`);
      tui.write('\r');
      await sleep(1000);
      expect(screenContains(tui.output(), marker)).toBe(true);

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
      await waitForText(() => tui.output(), '❯', 15000);
      tui.setRawMode(true);
      await sleep(300);

      await typeText(tui, '/sessions');
      tui.write('\r');
      await waitForText(() => tui.output(), '会话列表', 10000);
      // The command-bearing session was just updated, so it is first.
      tui.write('\r');
      await waitForText(() => tui.output(), marker, 15000);

      // tui is a fresh process: this cannot match output accumulated before
      // restart and therefore proves RuntimeEvent replay restored the command.
      const restartedOutput = tui.output();
      expect(screenContains(restartedOutput, `/compact ${marker}`)).toBe(true);
      expect(screenContains(restartedOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
