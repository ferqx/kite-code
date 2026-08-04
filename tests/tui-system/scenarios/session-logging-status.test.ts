import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — session logging status', () => {
  let tui: PtyProcess;
  let modelServer: ReturnType<typeof createMockModelServer>;
  let workspace: TestWorkspace;

  beforeAll(async () => {
    modelServer = createMockModelServer();
    modelServer.setResponses([{ message: { content: 'Logging status checked.' } }]);
    workspace = createTestWorkspace();
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [modelServer],
      workspaces: [workspace],
    });
  });

  test('keeps the default metadata mode silent without a content disclosure', async () => {
    const conversationFrames = tui.markScreen();
    await submitUserMessage(tui, modelServer, 'Report logging status', { timeout: 15_000 });
    await waitForText(() => tui.outputSinceLastAction(), 'Logging status checked.', 15_000);

    expect(
      screenContains(tui.screenFramesSince(conversationFrames).join('\n'), 'Session logging mode:'),
    ).toBe(false);
    expect(
      screenContains(
        tui.screenFramesSince(conversationFrames).join('\n'),
        'Session content logging is enabled',
      ),
    ).toBe(false);
  }, 30_000);
});
