import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
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
      files: { 'README.md': 'RECONNECT_FILE_OK\n' },
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
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'recovered-call', contentIncludes: ['RECONNECT_FILE_OK'] }],
        },
        message: { content: 'RECONNECT_DONE' },
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps partial text and commits only the recovered tool lifecycle',
    async () => {
      const reconnectFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Reconnect the stream', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'RECONNECT_PARTIAL', 10_000);

      await waitForText(() => tui.outputSinceLastAction(), 'RECOVERED', 10_000);
      await waitForText(() => tui.outputSinceLastAction(), 'RECONNECT_DONE', 10_000);

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(3);
      const renderedLifecycle = tui.scrollback();
      expect(screenContains(renderedLifecycle, 'RECONNECT_PARTIAL')).toBe(true);
      expect(screenContains(renderedLifecycle, 'RECOVERED')).toBe(true);
      expect(screenContains(renderedLifecycle, '● tool')).toBe(false);
      expect(screenContains(renderedLifecycle, 'read 1 file')).toBe(true);
      expect(screenContains(tui.screenFramesSince(reconnectFrames).join('\n'), 'WRONG.md')).toBe(
        false,
      );
    },
    TIMEOUT,
  );
});
