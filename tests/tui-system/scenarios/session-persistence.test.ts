/**
 * PTY System Test — Session Persistence (跨进程恢复)
 *
 * Verifies that after the TUI exits and restarts on the same workspace,
 * previous sessions and their data can be recovered from the SQLite
 * checkpoint database.
 *
 * Core scenario:
 * 1. Start TUI instance 1, send a message, get model response
 * 2. Exit TUI (graceful shutdown via /exit)
 * 3. Start TUI instance 2 on the same workspace (shared checkpoint DB)
 * 4. Open /sessions — verify previous session appears in the list
 * 5. Load the historical session — verify messages are replayed correctly
 *
 * IMPORTANT: Both TUI instances share the same isolated HOME and workspace,
 * so they resolve the same production Runtime Store path.
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
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Session Persistence', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui1: PtyProcess;
  let tui2: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let persistedThreadId: string | undefined;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([{ message: { content: 'Hello from session!' }, delay: 50 }]);

    tui1 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui1, tui2],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 1 — Message
  // ═══════════════════════════════════════════════════════════

  step(
    'send message in tui1 → model responds, checkpoint written',
    async () => {
      await submitUserMessage(tui1, server, 'Message before restart', { timeout: 15000 });

      // Wait for the mock model response to appear in the TUI
      await waitForText(() => tui1.outputSinceLastAction(), 'Hello from session!', 15000);

      const output = tui1.viewport();
      expect(screenContains(output, 'Message before restart')).toBe(true);
      expect(screenContains(output, 'Hello from session!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);

      await waitForCondition(
        () => {
          const observation = observePersistedUserMessageSession(
            workspace,
            'Message before restart',
          );
          if (observation.status !== 'ready' || !observation.value) return false;
          persistedThreadId = observation.value.threadId;
          return true;
        },
        'exact user.message_appended event to be durable before exit',
        10_000,
      );
      expect(persistedThreadId).toBeTruthy();
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Exit tui1 + Restart tui2 on same workspace
  // ═══════════════════════════════════════════════════════════

  step(
    'exit tui1, restart tui2 on same workspace → prompt visible',
    async () => {
      // Graceful exit via /exit command
      await submitCommand(tui1, '/exit');

      // Wait for tui1 process to exit (handleExit calls process.exit(0) after 300ms)
      const exitCode = await tui1.waitForExit();
      console.log(`  tui1 exit code: ${exitCode}`);

      // Restart and session selection do not call the model.
      server.setResponses([]);

      // Spawn tui2 on the SAME workspace — shares checkpoint DB
      tui2 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

      // Wait for TUI to finish rendering
      // Enable raw mode for tui2

      const output = tui2.viewport();
      const clean = stripAnsi(output);
      console.log('  tui2 startup output:', clean.slice(-300));
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 2 — Verify session persistence
  // ═══════════════════════════════════════════════════════════

  step(
    'open /sessions → previous session appears in session list',
    async () => {
      // Open SessionSelector
      await submitCommand(tui2, '/sessions');

      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenHasSessionRow(viewport, 'Message before restart', {
              selected: true,
              active: false,
            }) &&
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            screenContains(viewport, '导航') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'persisted session row and complete selector chrome to render',
        10_000,
      );

      const output = tui2.viewport();
      const clean = stripAnsi(output);
      console.log('  tui2 output after /sessions:', clean.slice(-500));

      // Verify panel UI elements are visible
      expect(screenContains(output, '会话列表')).toBe(true);
      expect(screenContains(output, '搜索')).toBe(true);
      expect(screenContains(output, '导航')).toBe(true);

      // The session from tui1 should appear in the list.
      // Session name defaults to threadId; after smart naming, it becomes
      // the first user message text (truncated to 30 chars).
      expect(
        screenHasSessionRow(output, 'Message before restart', {
          selected: true,
          active: false,
        }),
      ).toBe(true);
      const persisted = observePersistedUserMessageSession(workspace, 'Message before restart');
      expect(persisted.status).toBe('ready');
      expect(persisted.status === 'ready' ? persisted.value?.threadId : undefined).toBe(
        persistedThreadId,
      );
    },
    TIMEOUT,
  );

  step(
    'load historical session → message content restored from checkpoint DB',
    async () => {
      // The session from tui1 should be at index 0 (only persisted session).
      // Press Enter to load it.
      console.log('  pressing Enter to load historical session...');
      tui2.write('\r');

      // Wait for the historical session content to be replayed.
      // Both the user message and model response should be restored.
      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenContains(viewport, 'Message before restart') &&
            screenContains(viewport, 'Hello from session!') &&
            screenContains(viewport, '❯')
          );
        },
        'historical user and assistant messages to finish replaying in the viewport',
        15000,
      );

      const output = tui2.viewport();
      console.log('  tui2 output after loading session:', stripAnsi(output).slice(-500));

      // Verify historical user message is visible (replayed from DB)
      expect(screenContains(output, 'Message before restart')).toBe(true);
      // Verify historical model response is visible (replayed from DB)
      expect(screenContains(output, 'Hello from session!')).toBe(true);
      // TUI must remain responsive with prompt visible
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
