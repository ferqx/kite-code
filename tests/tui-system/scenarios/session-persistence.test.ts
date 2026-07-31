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
 * IMPORTANT: Both TUI instances share the same workspace (checkpointDir),
 * which is the key to cross-process persistence.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Session Persistence', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui1: PtyProcess;
  let tui2: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response queue for tui1.
    // Slot 0 is consumed by the user message model call.
    // Extra slots handle fire-and-forget generateSessionName calls
    // that may or may not complete before /exit.
    server.setResponses([
      { message: { content: 'Hello from session!' }, delay: 50 },
      { message: { content: 'Hello from session!' }, delay: 50 },
      { message: { content: 'Hello from session!' }, delay: 50 },
      { message: { content: 'Hello from session!' }, delay: 50 },
      { message: { content: 'Hello from session!' }, delay: 50 },
    ]);

    tui1 = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui1.outputSinceLastAction(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    tui1.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    // tui1 may already be dead (exited via /exit in test 4); killAndWait is a no-op in that case
    await tui1?.killAndWait();
    // Kill tui2 if it was spawned (may be undefined if test 4 failed before spawn)
    await tui2?.killAndWait();
    workspace?.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 1 — Message
  // ═══════════════════════════════════════════════════════════

  step(
    'send message in tui1 → model responds, checkpoint written',
    async () => {
      await typeText(tui1, 'Message before restart');
      tui1.write('\r');
      await waitForRequestMessage(server, 'Message before restart', 15000);

      // Wait for the mock model response to appear in the TUI
      await waitForText(() => tui1.outputSinceLastAction(), 'Hello from session!', 15000);

      const output = tui1.viewport();
      expect(screenContains(output, 'Message before restart')).toBe(true);
      expect(screenContains(output, 'Hello from session!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);
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
      await typeText(tui1, '/exit');
      tui1.write('\r');

      // Wait for tui1 process to exit (handleExit calls process.exit(0) after 300ms)
      const exitCode = await tui1.waitForExit();
      console.log(`  tui1 exit code: ${exitCode}`);

      // Set fresh mock responses for tui2.
      // tui2 will fire generateSessionName when SessionSelector opens,
      // which consumes mock slots. Provide generous buffer.
      server.setResponses([
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
      ]);

      // Spawn tui2 on the SAME workspace — shares checkpoint DB
      tui2 = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

      // Wait for TUI to finish rendering
      await waitForText(() => tui2.outputSinceLastAction(), '❯', 15000);

      // Enable raw mode for tui2
      tui2.setRawMode(true);

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
      await typeText(tui2, '/sessions');
      tui2.write('\r');

      // Verify SessionSelector panel is visible
      await waitForText(() => tui2.outputSinceLastAction(), '搜索', 10000);

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
      expect(screenContains(output, 'Message before restart')).toBe(true);
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
  test('runs the complete stateful journey', () => journey.run(), 170_000);
});
