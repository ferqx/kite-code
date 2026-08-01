/**
 * PTY System Test — Session Lifecycle (/new)
 *
 * Verifies that the /new command creates a new session, clears the
 * TUI output, and isolates content between sessions. Old session
 * content must NOT appear in the new session.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  clearInput,
  submitCommand,
  typeText,
  waitForRequestMessage,
} from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
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
  observePersistedSessionIds,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Session Lifecycle', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sessionIdsBeforeNew: string[] = [];
  let activeSessionId = '';

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      { message: { content: 'First session response!' }, delay: 50 },
      { message: { content: 'Second session response!' }, delay: 50 },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Send Message in First Session ─────────────────────────

  step(
    'send message in first session → model responds',
    async () => {
      await typeText(tui, 'Message in session A');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session A', 15000);

      // Wait for the mock model response
      await waitForText(() => tui.viewport(), 'First session response!', 15000);

      const output = tui.viewport();
      expect(screenContains(output, 'Message in session A')).toBe(true);
      expect(screenContains(output, 'First session response!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'enter plan mode before creating the next session',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab to exit', 5000);
      expect(screenContains(tui.viewport(), 'Shift+Tab to exit')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /new Creates New Session ───────────────────────────
  //
  // The headless terminal model applies Ink's erase/cursor sequences, so this
  // checks the actual viewport instead of accepting stale raw PTY bytes.

  step(
    '/new creates new session, TUI remains responsive',
    async () => {
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
      console.log('output after /new:', stripAnsi(output).slice(-500));

      // Prompt should still be visible (TUI alive and in new session)
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'Message in session A')).toBe(false);
      expect(screenContains(output, 'First session response!')).toBe(false);
      // The new Runtime starts in building mode and must not inherit the
      // outgoing session's planning-only UI projection.
      expect(screenContains(output, 'Shift+Tab to exit')).toBe(false);

      // Shift+Tab remains functional after the InputLine remount. Keep the
      // new session in plan mode so the next test covers exiting only after a
      // complete user/model conversation.
      tui.write('\x1b[Z');
      await waitForText(() => tui.viewport(), 'Shift+Tab to exit', 5000);
    },
    TIMEOUT,
  );

  // ── Send Message in New Session ───────────────────────────

  step(
    'send message in new session → new response arrives',
    async () => {
      await typeText(tui, 'Message in session B');
      tui.write('\r');
      await waitForRequestMessage(server, 'Message in session B', 15000);

      // Wait for the second model response
      await waitForText(() => tui.viewport(), 'Second session response!', 15000);
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
      activeSessionId = requirePersistedRuntimeReady(observePersistedSessionIds(workspace)).find(
        (sessionId) => !sessionIdsBeforeNew.includes(sessionId),
      )!;
      expect(activeSessionId).toBeTruthy();

      const output = tui.viewport();

      // Current session content must be visible
      expect(screenContains(output, 'Message in session B')).toBe(true);
      expect(screenContains(output, 'Second session response!')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'Shift+Tab exits plan mode after a completed conversation',
    async () => {
      tui.write('\x1b[Z');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          !screenContains(tui.viewport(), 'Shift+Tab to exit'),
        'building footer to replace the planning footer',
        5_000,
      );
    },
    TIMEOUT,
  );

  // ── SessionSelector: D-key delete confirm ───────────────

  step(
    'D key triggers delete confirmation, Enter confirms deletion',
    async () => {
      // Open session selector
      await submitCommand(tui, '/sessions');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            screenHasSessionRow(viewport, 'Message in session A', { active: false }) &&
            screenHasSessionRow(viewport, 'Message in session B', {
              selected: true,
              active: true,
            }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector to load both persisted sessions',
        10_000,
      );

      const panelOutput = tui.viewport();
      expect(screenContains(panelOutput, '会话列表')).toBe(true);
      // Both sessions should be visible
      expect(screenContains(panelOutput, 'Message in session A')).toBe(true);
      expect(screenContains(panelOutput, 'Message in session B')).toBe(true);

      // Drive the initial empty-query debounce to a completed filtered result,
      // then clear it and wait for the final full-list reload. D is deliberately
      // disabled while search is non-empty, so navigation happens only after
      // that reload has no pending query transition left.
      await typeText(tui, 'session A');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenHasSessionRow(viewport, 'Message in session A', {
              selected: true,
              active: false,
            }) &&
            !screenHasSessionRow(viewport, 'Message in session B') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session A filter results to replace the unfiltered selector rows',
        10_000,
      );
      await clearInput(tui, Array.from('session A').length);
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenHasSessionRow(viewport, 'Message in session A', { active: false }) &&
            screenHasSessionRow(viewport, 'Message in session B', {
              selected: true,
              active: true,
            }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'cleared search to finish reloading the full session list',
        10_000,
      );

      tui.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui.viewport(), 'Message in session A', {
            selected: true,
            active: false,
          }),
        'session A row to become selected after the settled reload',
        5_000,
      );

      // Press D to trigger delete confirmation
      tui.write('D');
      await waitForText(() => tui.outputSinceLastAction(), '确认', 5000);

      const confirmOutput = tui.viewport();
      // Confirmation dialog should appear
      expect(screenContains(confirmOutput, '确认')).toBe(true);
      expect(screenContains(confirmOutput, 'Enter')).toBe(true);

      // Press Enter to confirm deletion
      tui.write('\r');
      await waitForTuiReady(tui);
      const deletedSessionId = sessionIdsBeforeNew[0]!;
      await waitForCondition(
        () => {
          const observation = observePersistedSessionIds(workspace);
          if (observation.status !== 'ready') return false;
          const remaining = observation.value;
          return !remaining.includes(deletedSessionId) && remaining.includes(activeSessionId);
        },
        'Runtime Store to delete session A while retaining active session B',
        10_000,
      );

      // Re-open session selector to verify session was deleted
      await submitCommand(tui, '/sessions');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            !screenHasSessionRow(viewport, 'Message in session A') &&
            screenHasSessionRow(viewport, 'Message in session B', {
              selected: true,
              active: true,
            }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector to reload the retained session after deletion',
        10_000,
      );

      const afterOutput = tui.viewport();
      expect(screenContains(afterOutput, '搜索')).toBe(true);
      expect(screenHasSessionRow(afterOutput, 'Message in session A')).toBe(false);
      expect(
        screenHasSessionRow(afterOutput, 'Message in session B', {
          selected: true,
          active: true,
        }),
      ).toBe(true);
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── SessionSelector: D-key Esc cancel ─────────────────

  step(
    'D key then Escape cancels deletion, session remains',
    async () => {
      // The previous test deleted one session, so only 1 remains.
      // Attempt to delete the active (only) session but cancel.

      const idsBeforeCancel = requirePersistedRuntimeReady(
        observePersistedSessionIds(workspace),
      ).sort();
      expect(idsBeforeCancel).toEqual([activeSessionId]);

      // Press D to trigger delete confirmation
      tui.write('D');
      await waitForText(() => tui.outputSinceLastAction(), '确认', 5000);

      const confirmOutput = tui.viewport();
      expect(screenContains(confirmOutput, '确认')).toBe(true);

      // Press Escape to cancel deletion
      tui.write('\x1b');
      await waitForTuiReady(tui);
      await submitCommand(tui, '/sessions');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenHasSessionRow(viewport, 'Message in session B', {
              selected: true,
              active: true,
            }) &&
            screenContains(viewport, 'D 删除') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector to reload the retained session after cancel',
        5_000,
      );

      // Session should still be in the list after reopening the panel.
      const cancelOutput = tui.viewport();
      expect(
        screenHasSessionRow(cancelOutput, 'Message in session B', {
          selected: true,
          active: true,
        }),
      ).toBe(true);
      // Panel controls should still be visible
      expect(screenContains(cancelOutput, 'D 删除')).toBe(true);
      expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace)).sort()).toEqual(
        idsBeforeCancel,
      );
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run());
});
