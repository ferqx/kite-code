import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30_000;

describe('TUI PTY System — model stream reconnect', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: {
          mock: {
            type: 'openai-compatible',
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
          content_chunks: ['RECONNECT_PARTIAL'],
          tool_calls: [{ id: 'discarded-call', name: 'read_file', args: { path: 'WRONG.md' } }],
        },
        disconnect_after_content: true,
        chunk_delay: 100,
      },
      {
        message: {
          content_chunks: ['RECONNECT_PARTIAL', ' RECOVERED'],
          tool_calls: [{ id: 'recovered-call', name: 'read_file', args: { path: 'README.md' } }],
        },
        chunk_delay: 100,
      },
      { message: { content: 'RECONNECT_DONE' } },
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
    'keeps partial text and commits only the recovered tool lifecycle',
    async () => {
      await typeText(tui, 'Reconnect the stream');
      tui.write('\r');
      await waitForRequestMessage(server, 'Reconnect the stream', 15_000);
      await waitForText(() => tui.output(), 'RECONNECT_PARTIAL', 10_000);
      expect(screenContains(tui.output(), 'WRONG.md')).toBe(false);

      await waitForText(() => tui.output(), 'RECOVERED', 10_000);
      await waitForText(() => tui.output(), 'RECONNECT_DONE', 10_000);

      expect(server.getRequestCount()).toBe(3);
      expect(screenContains(tui.output(), 'RECONNECT_PARTIAL')).toBe(true);
      expect(screenContains(tui.output(), 'RECOVERED')).toBe(true);
      expect(screenContains(tui.output(), 'Read README.md')).toBe(true);
      expect(screenContains(tui.output(), 'WRONG.md')).toBe(false);
    },
    TIMEOUT,
  );
});
