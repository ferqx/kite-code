import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

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
          reasoning_chunks: ['STREAM_THINKING'],
          content_chunks: ['STREAM_FIRST', ' STREAM_FINAL'],
        },
        chunk_delay: 300,
      },
    ]);
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15_000);
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'renders an early text delta before the streamed response completes',
    async () => {
      await typeText(tui, 'Stream an answer');
      tui.write('\r');
      await waitForRequestMessage(server, 'Stream an answer', 15_000);
      await waitForText(() => tui.output(), 'STREAM_FIRST', 10_000);

      const partialOutput = tui.output();
      expect(screenContains(partialOutput, 'STREAM_FIRST')).toBe(true);
      expect(screenContains(partialOutput, 'STREAM_FINAL')).toBe(false);

      await waitForText(() => tui.output(), 'STREAM_FINAL', 10_000);
      expect(screenContains(tui.output(), 'STREAM_FIRST STREAM_FINAL')).toBe(true);
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});
