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
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 45000;

describe('TUI PTY System — Interrupt Resume', () => {
  let tui1: PtyProcess;
  let tui2: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response queue for tui1.
    // Slot 0: normal text response to user message
    // Extra slots: consumed by fire-and-forget generateSessionName
    server.setResponses([
      { message: { content: 'Response from the first instance.' }, delay: 50 },
      { message: { content: 'Extra 1' }, delay: 10 },
      { message: { content: 'Extra 2' }, delay: 10 },
      { message: { content: 'Extra 3' }, delay: 10 },
      { message: { content: 'Extra 4' }, delay: 10 },
    ]);

    tui1 = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui1.output(), '❯', 15000);

    tui1.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui1?.killAndWait();
    await tui2?.killAndWait();
    workspace?.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 1 — Warmup + Create Session Data
  // ═══════════════════════════════════════════════════════════

  test(
    'warmup: individual keystrokes reach TUI input line (tui1)',
    async () => {
      const text = 'hello';
      await typeText(tui1, text, 80);
      await sleep(400);

      const output = tui1.output();
      const clean = stripAnsi(output);
      console.log('  output after typing:', clean.slice(-300));
      expect(clean).toContain(text);

      await clearInput(tui1, text.length);
    },
    TIMEOUT,
  );

  test(
    'empty Enter does not submit a message (tui1)',
    async () => {
      const before = server.getRequestCount();
      tui1.write('\r');
      await sleep(500);

      const output = tui1.output();
      expect(screenContains(output, '❯')).toBe(true);
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  test(
    'send message → model responds, checkpoint written to DB',
    async () => {
      await typeText(tui1, 'Hello from tui1');
      tui1.write('\r');
      await waitForRequestMessage(server, 'Hello from tui1', 15000);

      await waitForText(() => tui1.output(), 'Response from the first instance.', 15000);

      const output = tui1.output();
      expect(screenContains(output, 'Hello from tui1')).toBe(true);
      expect(screenContains(output, 'Response from the first instance.')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Exit tui1 via Ctrl+C double-press
  // ═══════════════════════════════════════════════════════════

  test(
    'exit tui1 via Ctrl+C double-press',
    async () => {
      // First Ctrl+C: during idle (agent already finished),
      // sets ctrlCPressed=true
      tui1.write('\x03');
      await sleep(200);

      // Second Ctrl+C: idle + ctrlCPressed=true → exit
      tui1.write('\x03');

      const exitCode = await tui1.waitForExit();
      console.log(`  tui1 exit code: ${exitCode}`);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Restart tui2 on same workspace + Verify Session Recovery
  // ═══════════════════════════════════════════════════════════

  test(
    'restart tui2 on same workspace → session list shows persisted session',
    async () => {
      server.setResponses([
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
        { message: { content: 'dummy' }, delay: 10 },
      ]);

      tui2 = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

      await waitForText(() => tui2.output(), '❯', 15000);

      tui2.setRawMode(true);
      await new Promise((r) => setTimeout(r, 300));

      const output = tui2.output();
      const clean = stripAnsi(output);
      console.log('  tui2 startup output:', clean.slice(-300));
      expect(screenContains(output, '❯')).toBe(true);

      // Open /sessions to verify the persisted session is listed
      await typeText(tui2, '/sessions');
      tui2.write('\r');
      await sleep(1500);

      await waitForText(() => tui2.output(), '搜索', 15000);

      const panelOutput = tui2.output();
      const panelClean = stripAnsi(panelOutput);
      console.log('  tui2 /sessions output:', panelClean.slice(-500));

      // Verify SessionSelector panel is shown
      expect(screenContains(panelOutput, '会话列表')).toBe(true);
      expect(screenContains(panelOutput, '搜索')).toBe(true);

      // The session from tui1 should appear in the list.
      // Session name is generated from the first user message by smart naming.
      expect(screenContains(panelOutput, 'Hello from tui1')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'load persisted session → historical messages restored from DB',
    async () => {
      // The session from tui1 should be at index 0.
      // Press Enter to select and load it.
      tui2.write('\r');
      await sleep(1500);

      const afterLoad = tui2.output();
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
});
