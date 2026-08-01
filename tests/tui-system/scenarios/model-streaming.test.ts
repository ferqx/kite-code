import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  expectTextAbsentFor,
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System — model streaming', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: {
          mock: {
            type: 'deepseek',
            apiKey: 'test-key',
            baseURL: server.baseURL,
            model: 'mock-model',
            models: [{ name: 'mock-model', default: true, streaming: true }],
          },
        },
        model: { default: { provider: 'mock', name: 'mock-model' } },
      },
    });
    server.setResponses([
      {
        message: {
          reasoning_chunks: ['STREAM_THINKING\n\n', 'STREAM_PRIVATE_TAIL'],
          content_chunks: ['STREAM_FIRST\n\n', 'STREAM_MIDDLE\n\n', 'STREAM_FINAL'],
        },
        chunk_delay: 300,
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'shows the complete reasoning stream atomically before committing answer components',
    async () => {
      const responseFrames = tui.markScreen();
      await typeText(tui, 'Stream an answer');
      tui.write('\r');
      await waitForRequestMessage(server, 'Stream an answer', 15_000);
      await expectTextAbsentFor(
        () => tui.screenFramesSince(responseFrames).join('\n'),
        'STREAM_THINKING',
        400,
      );

      await waitForCondition(
        () =>
          tui
            .screenFramesSince(responseFrames)
            .some(
              (frame) =>
                screenContains(frame, 'STREAM_THINKING') &&
                screenContains(frame, 'STREAM_PRIVATE_TAIL') &&
                !screenContains(frame, 'STREAM_FIRST'),
            ),
        'a complete reasoning frame before answer streaming',
        10_000,
      );

      const reasoningFrames = tui.screenFramesSince(responseFrames);
      const partialOutput = reasoningFrames.find(
        (frame) =>
          screenContains(frame, 'STREAM_THINKING') &&
          screenContains(frame, 'STREAM_PRIVATE_TAIL') &&
          !screenContains(frame, 'STREAM_FIRST'),
      )!;
      expect(screenContains(partialOutput, 'STREAM_THINKING')).toBe(true);
      expect(screenContains(partialOutput, 'STREAM_PRIVATE_TAIL')).toBe(true);
      expect(screenContains(partialOutput, 'STREAM_FIRST')).toBe(false);
      expect(screenContains(partialOutput, 'STREAM_FINAL')).toBe(false);

      await waitForCondition(
        () =>
          tui
            .screenFramesSince(responseFrames)
            .some((frame) => screenContains(frame, 'STREAM_FIRST')),
        'the first answer frame',
        10_000,
      );
      const firstAnswerFrameIndex = tui
        .screenFramesSince(responseFrames)
        .findIndex((frame) => screenContains(frame, 'STREAM_FIRST'));
      const reasoningFrameIndex = tui
        .screenFramesSince(responseFrames)
        .findIndex((frame) => screenContains(frame, 'STREAM_PRIVATE_TAIL'));
      expect(reasoningFrameIndex).toBeGreaterThanOrEqual(0);
      expect(firstAnswerFrameIndex).toBeGreaterThan(reasoningFrameIndex);
      expect(screenContains(tui.viewport(), 'STREAM_FINAL')).toBe(false);

      await waitForText(() => tui.viewport(), 'STREAM_FINAL', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(screenContains(tui.viewport(), 'STREAM_MIDDLE')).toBe(true);
      const clean = stripAnsi(tui.viewport());
      // The final viewport keeps the consolidated Thought header, while the
      // detailed reasoning text belongs only to the earlier modeled frame.
      expect(clean.lastIndexOf('STREAM_THINKING')).toBeLessThan(clean.lastIndexOf('STREAM_FINAL'));
      expect(clean.lastIndexOf('Thought for')).toBeLessThan(clean.lastIndexOf('STREAM_FIRST'));
      expect(clean.lastIndexOf('STREAM_FIRST')).toBeLessThan(clean.lastIndexOf('STREAM_MIDDLE'));
      expect(clean.lastIndexOf('STREAM_MIDDLE')).toBeLessThan(clean.lastIndexOf('STREAM_FINAL'));
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});
