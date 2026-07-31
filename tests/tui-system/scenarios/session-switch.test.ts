/**
 * PTY System Test — Session Switching via SessionSelector
 *
 * Verifies that the /sessions command opens the SessionSelector panel,
 * arrow-key navigation works, and switching between sessions correctly
 * replays session content. Also verifies session-to-session isolation
 * (each session displays its own content after switching).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
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
import { createTestWorkspace, persistedSessionIds } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Session Switching', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sessionIdsBeforeNew: string[] = [];

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response queue layout (critical ordering):
    // [0]       → main response for session 1 ("Message in session 1")
    // [1-N]     → all "Session 2 response"
    //
    // generateSessionName for session 1 is fire-and-forget. It may or may not
    // consume a slot (depending on whether its model call starts before /new
    // switches the active threadId). To handle both cases, idx 1+ must all
    // contain "Session 2 response" so session 2 always gets the right content.
    server.setResponses([
      { message: { content: 'Session 1 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
      { message: { content: 'Session 2 response' }, delay: 50 },
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

  // ── Send Message in Session 1 ──

  step(
    'send message in session 1 → model responds',
    async () => {
      await typeText(tui, 'Message in session 1');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session 1', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.viewport(), 'Session 1 response', 15000);

      const output = tui.viewport();
      expect(screenContains(output, 'Message in session 1')).toBe(true);
      expect(screenContains(output, 'Session 1 response')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /new Creates Session 2 ──
  //
  // IMPORTANT: /new is ignored when the current session has no user
  // messages yet, so we must send a message in session 1 first (done above).
  // After /new, the InputLine remounts (key changes via activeSessionId),
  // requiring a fresh receipt-confirmed input after the remount.

  step(
    '/new creates session 2, TUI remains responsive',
    async () => {
      sessionIdsBeforeNew = persistedSessionIds(workspace);
      expect(sessionIdsBeforeNew).toHaveLength(1);
      await typeText(tui, '/new');
      tui.write('\r');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = tui.viewport();
      console.log('  output after /new:', stripAnsi(output).slice(-500));

      // Prompt should still be visible (TUI alive and in new session)
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'Message in session 1')).toBe(false);
      expect(screenContains(output, 'Session 1 response')).toBe(false);
    },
    TIMEOUT,
  );

  // ── Send Message in Session 2 ──

  step(
    'send message in session 2 → model responds',
    async () => {
      await typeText(tui, 'Message in session 2');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session 2', 15000);

      // Wait for the second model response
      await waitForText(() => tui.viewport(), 'Session 2 response', 15000);
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

      const output = tui.viewport();
      expect(screenContains(output, 'Message in session 2')).toBe(true);
      expect(screenContains(output, 'Session 2 response')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Open /sessions, filter to session 1, switch ──

  step(
    'open /sessions, filter and switch to session 1',
    async () => {
      // Open SessionSelector
      await typeText(tui, '/sessions');
      tui.write('\r');

      // The selector chrome renders before its asynchronous session query can
      // populate every row. Wait for the complete user-visible list state.
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            screenContains(viewport, '导航') &&
            screenHasSessionRow(viewport, 'Message in session 1', { active: false }) &&
            screenHasSessionRow(viewport, 'Message in session 2', {
              selected: true,
              active: true,
            }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector to load both persisted sessions',
        10_000,
      );

      let output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after /sessions:', clean.slice(-500));

      // Verify panel title, search input, and footer hints are visible
      expect(screenContains(output, '会话列表')).toBe(true);
      expect(screenContains(output, '搜索')).toBe(true);
      expect(screenContains(output, '导航')).toBe(true);

      // Filter to one stable target instead of depending on timestamp order.
      await typeText(tui, 'session 1');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenHasSessionRow(viewport, 'Message in session 1', {
              selected: true,
              active: false,
            }) &&
            !screenHasSessionRow(viewport, 'Message in session 2') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session 1 filter results to replace the unfiltered selector rows',
        10_000,
      );

      // Press Enter to switch to session 1
      console.log('  pressing Enter to switch...');
      tui.write('\r');

      // Wait for session 1 content to be replayed after switch.
      // The TUI loads and replays the session blocks into the OutputArea.
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, 'Message in session 1') &&
            screenContains(viewport, 'Session 1 response') &&
            !screenContains(viewport, 'Message in session 2') &&
            !screenContains(viewport, 'Session 2 response') &&
            screenContains(viewport, '❯')
          );
        },
        'session 1 replay to replace session 2 in the viewport',
        15000,
      );
      output = tui.viewport();
      console.log('  viewport after switch to session 1:', output.slice(-500));

      // After switching, session 1 content must be visible (replayed)
      expect(screenContains(output, 'Message in session 1')).toBe(true);
      expect(screenContains(output, 'Session 1 response')).toBe(true);
      expect(screenContains(output, 'Message in session 2')).toBe(false);
      expect(screenContains(output, 'Session 2 response')).toBe(false);

      // TUI must remain responsive with prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Switch back to session 2 (session isolation) ──
  //
  // The viewport is authoritative for session isolation. Raw PTY history is
  // retained only for diagnostics and must not satisfy these assertions.

  step(
    'switch back to session 2 — correct content replayed',
    async () => {
      // Open SessionSelector again
      await typeText(tui, '/sessions');
      tui.write('\r');

      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            screenHasSessionRow(viewport, 'Message in session 1', { active: true }) &&
            screenHasSessionRow(viewport, 'Message in session 2', {
              selected: true,
              active: false,
            }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector to reload both persisted sessions',
        10_000,
      );

      let output = tui.viewport();
      console.log('  output after second /sessions:', stripAnsi(output).slice(-500));

      // Filter to one stable target instead of depending on timestamp order.
      await typeText(tui, 'session 2');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenHasSessionRow(viewport, 'Message in session 2', {
              selected: true,
              active: false,
            }) &&
            !screenHasSessionRow(viewport, 'Message in session 1') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session 2 filter results to replace the unfiltered selector rows',
        10_000,
      );

      console.log('  pressing Enter to switch to session 2...');
      tui.write('\r');

      // Wait for session 2 content to be replayed
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, 'Message in session 2') &&
            screenContains(viewport, 'Session 2 response') &&
            !screenContains(viewport, 'Message in session 1') &&
            !screenContains(viewport, 'Session 1 response') &&
            screenContains(viewport, '❯')
          );
        },
        'session 2 replay to replace session 1 in the viewport',
        15000,
      );
      output = tui.viewport();
      console.log('  viewport after switch to session 2:', output.slice(-500));

      // Session 2 content must be visible (replayed correctly)
      expect(screenContains(output, 'Message in session 2')).toBe(true);
      expect(screenContains(output, 'Session 2 response')).toBe(true);
      expect(screenContains(output, 'Message in session 1')).toBe(false);
      expect(screenContains(output, 'Session 1 response')).toBe(false);

      // TUI must remain responsive with prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run(), 170_000);
});
