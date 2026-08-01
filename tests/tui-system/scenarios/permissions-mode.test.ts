import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System — Permissions Mode', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({ configOverrides: { interactionMode: 'auto' } });
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.outputSinceLastAction(), '❯', 15_000);
    await waitForText(() => tui.viewport(), '自动审批', 10_000);
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'selects accept_edits from a non-default auto state',
    async () => {
      expect(screenContains(tui.viewport(), '自动审批')).toBe(true);

      await submitCommand(tui, '/permissions accept_edits', 80);
      await waitForText(() => tui.outputSinceLastAction(), '接受编辑', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const settled = tui.viewport();
      expect(screenContains(settled, '接受编辑')).toBe(true);
      expect(screenContains(settled, '自动审批')).toBe(false);
    },
    TIMEOUT,
  );
});
