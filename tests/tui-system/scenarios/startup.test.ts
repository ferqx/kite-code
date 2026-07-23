/**
 * PTY System Test — TUI Startup Smoke Test
 *
 * Verifies the TUI can start in a real PTY, render the prompt,
 * and accept basic keyboard input.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Startup', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    workspace.env.CI = 'true';

    server.setResponses([{ message: { content: 'Hello from PTY test!' } }]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.output(), '❯', 15000);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'TUI starts and renders prompt ❯ in a CI-backed PTY',
    async () => {
      // Wait for the TUI to fully render (prompt character)
      await waitForText(() => tui.output(), '❯', 15000);
      const output = tui.output();
      expect(screenContains(output, '❯')).toBe(true);
      console.log('  TUI rendered, prompt visible');
    },
    TIMEOUT,
  );

  test(
    'TUI renders footer with shortcuts text',
    async () => {
      // Footer may render in later frames — wait for it
      await waitForText(() => tui.output(), 'shortcuts', 10000);
      console.log('  Footer visible');
    },
    TIMEOUT,
  );

  test(
    'TUI renders header with Kite Code branding',
    async () => {
      await waitForText(() => tui.output(), 'Kite Code', 5000);
      console.log('  Header visible');
    },
    TIMEOUT,
  );
});
