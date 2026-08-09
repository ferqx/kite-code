import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText, waitForTextGone } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Sandbox Mode', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        sandbox: { enabled: false },
      },
    });

    server.setResponses([]);
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
    });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  step(
    'keeps development execution, release, and telemetry boundaries inactive',
    async () => {
      await submitCommand(tui, '/permissions', undefined, {
        requireAcceptWhen: true,
        acceptWhen: (viewport) => screenContains(viewport, '选择权限模式'),
      });
      await waitForText(() => tui.viewport(), '选择权限模式', 10000);
      await waitForText(() => tui.viewport(), '当前未在沙箱环境开启', 10000);
      expect(screenContains(tui.viewport(), 'Execution boundary: not admitted')).toBe(false);
      tui.write('\u001b');
      await waitForTextGone(() => tui.viewport(), '选择权限模式', 10_000);

      await submitCommand(tui, '/release');
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Release control: inactive (artifact_disabled)',
        10000,
      );

      expect(screenContains(tui.viewport(), 'Release control: inactive (artifact_disabled)')).toBe(
        true,
      );
      expect(screenContains(tui.viewport(), 'Capabilities: unavailable until artifact')).toBe(true);

      await submitCommand(tui, '/telemetry');
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Observability: inactive (artifact_disabled)',
        10000,
      );

      expect(screenContains(tui.viewport(), 'Artifact authority: absent')).toBe(true);
      expect(screenContains(tui.viewport(), 'Remote exporter: not configured')).toBe(true);
      expect(screenContains(tui.viewport(), 'Disk spool: disabled')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'does not write the bare-shell fallback diagnostic into the TUI terminal',
    async () => {
      server.setResponses([{ message: { content: 'Sandbox fallback stayed internal.' } }]);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Run without a sandbox', {
        timeout: 15_000,
      });
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Sandbox fallback stayed internal.',
        15_000,
      );

      const rendered = tui.screenFramesSince(conversationFrames).join('\n');
      expect(rendered).not.toContain('[sandbox]');
      expect(rendered).not.toContain('Shell commands will run without isolation');
    },
    TIMEOUT,
  );

  test('runs the complete stateful journey', () => journey.run(), TIMEOUT);
});
