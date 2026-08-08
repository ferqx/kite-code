import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — session logging status', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
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

  step(
    'keeps the default metadata mode silent without a content disclosure',
    async () => {
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, modelServer, 'Report logging status', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Logging status checked.', 15_000);

      expect(
        screenContains(
          tui.screenFramesSince(conversationFrames).join('\n'),
          'Session logging mode:',
        ),
      ).toBe(false);
      expect(
        screenContains(
          tui.screenFramesSince(conversationFrames).join('\n'),
          'Session content logging is enabled',
        ),
      ).toBe(false);
    },
    30_000,
  );

  step(
    'does not render internal session logging diagnostics in the TUI conversation',
    async () => {
      const sessionsPath = join(workspace.home, '.kite-code', 'sessions');
      rmSync(sessionsPath, { recursive: true, force: true });
      writeFileSync(sessionsPath, 'intentionally blocked for diagnostic isolation');

      modelServer.setResponses([{ message: { content: 'Logging failure stayed internal.' } }]);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, modelServer, 'Trigger an internal logging failure', {
        timeout: 15_000,
      });
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Logging failure stayed internal.',
        15_000,
      );

      const rendered = tui.screenFramesSince(conversationFrames).join('\n');
      expect(rendered).not.toContain('Session logging is unavailable');
      expect(rendered).not.toContain('writer_unavailable');
    },
    30_000,
  );

  test('runs the complete stateful journey', () => journey.run());
});
