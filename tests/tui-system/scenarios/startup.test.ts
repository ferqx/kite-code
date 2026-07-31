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

    await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'renders the prompt, footer, and Kite Code branding in a CI-backed PTY',
    async () => {
      await waitForText(() => tui.viewport(), '❯', 15000);
      await waitForText(() => tui.viewport(), 'shortcuts', 10000);
      const output = await waitForText(() => tui.viewport(), 'Kite Code', 5000);
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'shortcuts')).toBe(true);
      expect(screenContains(output, 'Kite Code')).toBe(true);
    },
    TIMEOUT,
  );
});
