/**
 * PTY System Test — Interrupt Resume (中断恢复)
 *
 * Verifies that when the TUI exits while a session has data and restarts
 * on the same workspace, the session can be loaded and its historical
 * messages are restored from the checkpoint DB.
 *
 * NOTE: Full interrupt restoration (loading a session with a pending
 * approval/question interrupt and resolving it) has architectural
 * limitations. When Ctrl+C cancels an active interrupt, the reducer
 * marks the interrupt as resolved and rt.abort() is called. The
 * checkpoint DB may or may not preserve the pending interrupt writes
 * depending on abort timing. This test therefore focuses on session
 * data persistence, which is the prerequisite for interrupt recovery.
 *
 * See ask-user.test.ts and approval.test.ts for single-process
 * interrupt handling coverage.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedSessionSummaries } from '../harness/test-workspace';

const TIMEOUT = 45000;

describe('TUI PTY System — Interrupt Resume', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui1: PtyProcess;
  let tui2: PtyProcess;
  let tui3: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([{ message: { content: 'Response from the first instance.' }, delay: 50 }]);

    tui1 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui1, tui2, tui3],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 1 — Create Session Data
  // ═══════════════════════════════════════════════════════════

  step(
    'send message → model responds, checkpoint written to DB',
    async () => {
      await submitUserMessage(tui1, server, 'Hello from tui1', { timeout: 15000 });

      await waitForText(
        () => tui1.outputSinceLastAction(),
        'Response from the first instance.',
        15000,
      );

      const output = tui1.viewport();
      expect(screenContains(output, 'Hello from tui1')).toBe(true);
      expect(screenContains(output, 'Response from the first instance.')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);

      await waitForCondition(
        () => {
          const observation = observePersistedSessionSummaries(workspace);
          return (
            observation.status === 'ready' &&
            observation.value.some((session) => session.name === 'Hello from tui1')
          );
        },
        'exact persisted session summary before graceful exit',
        10_000,
      );
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Exit tui1 gracefully before reopening the persisted workspace
  // ═══════════════════════════════════════════════════════════

  step(
    'exit tui1 gracefully with /exit',
    async () => {
      await submitCommand(tui1, '/exit');

      const exitCode = await tui1.waitForExit();
      console.log(`  tui1 exit code: ${exitCode}`);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Restart tui2 on same workspace + Verify Session Recovery
  // ═══════════════════════════════════════════════════════════

  step(
    'restart tui2 on same workspace → session list shows persisted session',
    async () => {
      server.setResponses([]);

      tui2 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

      const output = tui2.viewport();
      const clean = stripAnsi(output);
      console.log('  tui2 startup output:', clean.slice(-300));
      expect(screenContains(output, '❯')).toBe(true);

      // Open /resume to verify the persisted session is listed
      await submitCommand(tui2, '/resume');

      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenHasSessionRow(viewport, 'Hello from tui1', { active: false }) &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'persisted session row to load in the selector',
        15_000,
      );

      const panelOutput = tui2.viewport();
      const panelClean = stripAnsi(panelOutput);
      console.log('  tui2 /resume output:', panelClean.slice(-500));

      // Verify SessionSelector panel is shown
      expect(screenContains(panelOutput, '会话列表')).toBe(true);
      expect(screenContains(panelOutput, '搜索')).toBe(true);

      // The session from tui1 should appear in the list.
      // Session name is generated from the first user message by smart naming.
      expect(screenHasSessionRow(panelOutput, 'Hello from tui1', { active: false })).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'load persisted session → historical messages restored from DB',
    async () => {
      // Runtime Server V1 keeps a fresh current row at index 0, so select the
      // persisted historical row explicitly before loading it.
      tui2.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui2.viewport(), 'Hello from tui1', {
            selected: true,
            active: false,
          }),
        'persisted session row to become selected',
        5_000,
      );
      tui2.write('\r');
      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenContains(viewport, 'Hello from tui1') &&
            screenContains(viewport, 'Response from the first instance.') &&
            screenContains(viewport, '❯')
          );
        },
        'persisted user and assistant messages to finish replaying in the viewport',
        15000,
      );

      const afterLoad = tui2.viewport();
      const cleanLoad = stripAnsi(afterLoad);
      console.log('  tui2 after session load:', cleanLoad.slice(-500));

      // Verify historical messages are replayed from the checkpoint DB
      expect(screenContains(afterLoad, 'Hello from tui1')).toBe(true);
      expect(screenContains(afterLoad, 'Response from the first instance.')).toBe(true);
      // TUI must remain responsive with prompt visible
      expect(screenContains(afterLoad, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'terminate the TUI during an active model turn',
    async () => {
      server.setResponses([
        {
          message: { content: 'This response must not survive the terminated owner.' },
          delay: 10_000,
        },
      ]);
      await submitUserMessage(tui2, server, 'Interrupted model turn before restart', {
        timeout: 15_000,
      });
      await waitForText(() => tui2.viewport(), 'Interrupted model turn before restart', 10_000);
      expect(server.getRequestCount()).toBeGreaterThan(1);
      expect(
        screenContains(tui2.viewport(), 'This response must not survive the terminated owner.'),
      ).toBe(false);

      expect(await tui2.killAndWait()).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'restart and load the interrupted session → historical content remains but no running state survives',
    async () => {
      server.setResponses([]);
      tui3 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitCommand(tui3, '/resume');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui3.viewport(), 'Hello from tui1', { active: false }) &&
          !screenContains(tui3.viewport(), 'Loading...'),
        'interrupted session row to become selectable after restart recovery',
        15_000,
      );
      tui3.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui3.viewport(), 'Hello from tui1', {
            selected: true,
            active: false,
          }),
        'interrupted session row to become selected after restart recovery',
        5_000,
      );
      tui3.write('\r');
      await waitForCondition(
        () =>
          screenContains(tui3.viewport(), 'Interrupted model turn before restart') &&
          screenContains(tui3.viewport(), '❯'),
        'post-recovery Session event tail to finish replaying',
        15_000,
      );

      const restored = tui3.viewport();
      expect(screenContains(restored, 'Hello from tui1')).toBe(true);
      expect(screenContains(restored, 'Interrupted model turn before restart')).toBe(true);
      expect(screenContains(restored, 'This response must not survive the terminated owner.')).toBe(
        false,
      );
      expect(screenContains(restored, 'Thinking')).toBe(false);
      expect(screenContains(restored, 'Working')).toBe(false);
    },
    TIMEOUT,
  );
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
