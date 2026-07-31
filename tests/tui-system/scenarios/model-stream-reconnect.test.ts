import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

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
      // Spares — absorb generateSessionName and other background calls
      // without wrapping back to the disconnect response.
      { message: { content: 'spare 1' } },
      { message: { content: 'spare 2' } },
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
    'keeps partial text and commits only the recovered tool lifecycle',
    async () => {
      const reconnectFrames = tui.markScreen();
      await typeText(tui, 'Reconnect the stream');
      tui.write('\r');
      await waitForRequestMessage(server, 'Reconnect the stream', 15_000);
      await waitForText(() => tui.outputSinceLastAction(), 'RECONNECT_PARTIAL', 10_000);

      await waitForText(() => tui.outputSinceLastAction(), 'RECOVERED', 10_000);
      await waitForText(() => tui.outputSinceLastAction(), 'RECONNECT_DONE', 10_000);

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(3);
      const renderedLifecycle = tui.scrollback();
      expect(screenContains(renderedLifecycle, 'RECONNECT_PARTIAL')).toBe(true);
      expect(screenContains(renderedLifecycle, 'RECOVERED')).toBe(true);
      expect(screenContains(renderedLifecycle, 'read 1 file')).toBe(true);
      expect(screenContains(tui.screenFramesSince(reconnectFrames).join('\n'), 'WRONG.md')).toBe(
        false,
      );
    },
    TIMEOUT,
  );
});
