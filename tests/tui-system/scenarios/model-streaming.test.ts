import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  expectTextAbsentFor,
  screenContains,
  stripAnsi,
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
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15_000);
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'shows the complete reasoning stream atomically before committing answer components',
    async () => {
      await typeText(tui, 'Stream an answer');
      tui.write('\r');
      await waitForRequestMessage(server, 'Stream an answer', 15_000);
      await expectTextAbsentFor(() => tui.outputSinceLastAction(), 'STREAM_THINKING', 400);
      expect(screenContains(tui.outputSinceLastAction(), 'STREAM_PRIVATE_TAIL')).toBe(false);

      await waitForText(() => tui.outputSinceLastAction(), 'STREAM_THINKING', 10_000);

      const partialOutput = tui.output();
      expect(screenContains(partialOutput, 'STREAM_THINKING')).toBe(true);
      expect(screenContains(partialOutput, 'STREAM_PRIVATE_TAIL')).toBe(true);
      expect(screenContains(partialOutput, 'STREAM_FIRST')).toBe(false);
      expect(screenContains(partialOutput, 'STREAM_FINAL')).toBe(false);

      await waitForText(() => tui.outputSinceLastAction(), 'STREAM_FIRST', 10_000);
      const firstAnswerFrameHistory = stripAnsi(tui.output());
      expect(firstAnswerFrameHistory.lastIndexOf('STREAM_THINKING')).toBeLessThan(
        firstAnswerFrameHistory.lastIndexOf('STREAM_FIRST'),
      );
      expect(firstAnswerFrameHistory.lastIndexOf('STREAM_PRIVATE_TAIL')).toBeLessThan(
        firstAnswerFrameHistory.lastIndexOf('STREAM_FIRST'),
      );
      expect(screenContains(tui.output(), 'STREAM_FINAL')).toBe(false);

      await waitForText(() => tui.outputSinceLastAction(), 'STREAM_FINAL', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(screenContains(tui.output(), 'STREAM_MIDDLE')).toBe(true);
      const clean = stripAnsi(tui.output());
      // Raw PTY capture retains overwritten frames; ensure reasoning was only
      // printed in the earlier active frame, never again after final output.
      expect(clean.lastIndexOf('STREAM_THINKING')).toBeLessThan(clean.lastIndexOf('STREAM_FINAL'));
      expect(clean.lastIndexOf('Thought for')).toBeLessThan(clean.lastIndexOf('STREAM_FIRST'));
      expect(clean.lastIndexOf('STREAM_FIRST')).toBeLessThan(clean.lastIndexOf('STREAM_MIDDLE'));
      expect(clean.lastIndexOf('STREAM_MIDDLE')).toBeLessThan(clean.lastIndexOf('STREAM_FINAL'));
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});
