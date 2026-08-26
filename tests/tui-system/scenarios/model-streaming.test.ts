import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
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
        sandbox: { enabled: false },
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
    'commits completed reasoning before streaming answer components',
    async () => {
      const responseFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Stream an answer', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'Thinking', 10_000);

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
      expect(firstAnswerFrameIndex).toBeGreaterThanOrEqual(0);
      expect(screenContains(tui.viewport(), 'STREAM_FINAL')).toBe(false);

      await waitForText(() => tui.viewport(), 'STREAM_FINAL', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(screenContains(tui.viewport(), 'STREAM_MIDDLE')).toBe(true);
      const clean = stripAnsi(tui.viewport());
      const responseHistory = tui.screenFramesSince(responseFrames).join('\n');
      // A completed segment gets one live Thought frame before answer deltas;
      // settled scrollback keeps only the compact Thinking header.
      expect(screenContains(responseHistory, 'Thinking ')).toBe(true);
      expect(clean.lastIndexOf('STREAM_FIRST')).toBeLessThan(clean.lastIndexOf('STREAM_MIDDLE'));
      expect(clean.lastIndexOf('STREAM_MIDDLE')).toBeLessThan(clean.lastIndexOf('STREAM_FINAL'));
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — model delivery races', () => {
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
        sandbox: { enabled: false },
      },
    });
    server.setResponses([
      {
        message: {
          content_chunks: [
            '你好！👋\n\nGREETING_ANSWER_ONCE\n\n我是 Kite，可以在这个工作区帮你处理编码任务。',
          ],
          reasoning_chunks: ['Preparing the greeting after visible content.'],
        },
        stream_frame_order: 'content_first',
        chunk_delay: 150,
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'renders one answer when visible content arrives before reasoning',
    async () => {
      await submitUserMessage(tui, server, '你好', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'GREETING_ANSWER_ONCE', 10_000);
      await waitForText(() => tui.viewport(), 'Thinking', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const clean = stripAnsi(tui.viewport());
      expect(clean.split('GREETING_ANSWER_ONCE')).toHaveLength(2);
      expect(clean.indexOf('Thinking ')).toBeLessThan(clean.indexOf('GREETING_ANSWER_ONCE'));
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});
