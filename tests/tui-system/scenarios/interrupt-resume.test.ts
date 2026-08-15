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
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 45000;

describe('TUI PTY System — Interrupt Resume', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui1: PtyProcess;
  let tui2: PtyProcess;
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
      tuis: [tui1, tui2],
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
            screenHasSessionRow(viewport, 'Hello from tui1', {
              selected: true,
              active: false,
            }) && !screenContains(viewport, 'Loading...')
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
      expect(
        screenHasSessionRow(panelOutput, 'Hello from tui1', {
          selected: true,
          active: false,
        }),
      ).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'load persisted session → historical messages restored from DB',
    async () => {
      // The session from tui1 should be at index 0.
      // Press Enter to select and load it.
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
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
