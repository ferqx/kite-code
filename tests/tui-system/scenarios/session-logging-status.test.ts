import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — session logging status', () => {
  let tui: PtyProcess;
  let modelServer: ReturnType<typeof createMockModelServer>;
  let workspace: TestWorkspace;

  beforeAll(async () => {
    modelServer = createMockModelServer();
    modelServer.setResponses([{ message: { content: 'Logging status checked.' } }]);
    workspace = createTestWorkspace({
      configOverrides: {
        features: { sessionLoggingPolicyV1: true },
      },
      projectConfigOverrides: {
        features: { sessionLoggingPolicyV1: true },
      },
    });
    tui = spawnTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15_000);
    tui.setRawMode(true);
  });

  afterAll(async () => {
    modelServer?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test('shows the resolved metadata mode without a content disclosure', async () => {
    await typeText(tui, 'Report logging status');
    tui.write('\r');
    await waitForRequestMessage(modelServer, 'Report logging status', 15_000);
    const output = await waitForText(
      () => tui.outputSinceLastAction(),
      'Session logging mode: metadata.',
      15_000,
    );
    await waitForText(() => tui.outputSinceLastAction(), 'Logging status checked.', 15_000);

    expect(screenContains(output, 'Session content logging is enabled')).toBe(false);
  }, 30_000);
});
