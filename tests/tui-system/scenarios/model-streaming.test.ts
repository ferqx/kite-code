import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
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
    'streams complete answer components under one stable Thinking owner',
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
      // Completed reasoning is visible only in the active Thought window;
      // once answer components become visible, the settled transcript omits it.
      expect(screenContains(responseHistory, 'Thinking ')).toBe(true);
      expect(screenContains(responseHistory, '└─ STREAM_THINKING')).toBe(true);
      expect(screenContains(responseHistory, 'STREAM_PRIVATE_TAIL')).toBe(true);
      expect(clean).not.toContain('STREAM_THINKING');
      expect(clean).not.toContain('STREAM_PRIVATE_TAIL');
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
    'keeps completed answer components Static when reasoning arrives later',
    async () => {
      const responseFrames = tui.markScreen();
      await submitUserMessage(tui, server, '你好', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'GREETING_ANSWER_ONCE', 10_000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const clean = stripAnsi(tui.viewport());
      expect(clean.split('GREETING_ANSWER_ONCE')).toHaveLength(2);
      const postAnswerFrames = tui
        .screenFramesSince(responseFrames)
        .filter((frame) => screenContains(frame, 'GREETING_ANSWER_ONCE'))
        .join('\n');
      expect(screenContains(postAnswerFrames, 'Thinking ')).toBe(false);
      expect(server.getRequests()[0]?.body.stream).toBe(true);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — late reasoning after visible content', () => {
  let tui: PtyProcess;
  let resumedTui: PtyProcess | undefined;
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
    // Deliberately model the screenshot race: a partial reasoning segment opens
    // a pure Thought, visible text becomes its pending caption, then a late
    // suffix/completion arrives before the terminal stop/[DONE].
    server.setResponses([
      {
        message: {
          content_chunks: ['LATE_REASONING_ANSWER_ONCE: the visible answer.'],
          reasoning_chunks: [
            'LATE_REASONING_PREFIX_MARKER: may render only before answer. ',
            'LATE_REASONING_SUFFIX_MARKER: must never render.',
          ],
        },
        stream_frame_sequence: ['reasoning', 'content', 'reasoning'],
        // Keep prefix/content observable, then deliver the late suffix and
        // terminal back-to-back so the durable completion can overtake it.
        stream_frame_delays: [350, 350, 0, 0],
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui, resumedTui],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  test(
    'keeps an interleaved Thought settled in every live and replayed terminal frame',
    async () => {
      const responseFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Reproduce late reasoning', { timeout: 15_000 });

      // The fixture emitted the reasoning prefix before this answer, and delays
      // the suffix plus terminal after it.
      await waitForText(() => tui.viewport(), 'LATE_REASONING_ANSWER_ONCE', 10_000);
      const answerFrameIndex = tui
        .screenFramesSince(responseFrames)
        .findIndex((frame) => screenContains(frame, 'LATE_REASONING_ANSWER_ONCE'));
      expect(answerFrameIndex).toBeGreaterThanOrEqual(0);

      // Wait for the late completed-reasoning projection before looking for a
      // settled terminal state. A normal output-quiescence window is shorter
      // than this fixture's per-frame delay, so it is not a terminal signal.
      await waitForCondition(
        () =>
          tui.screenFramesSince(responseFrames).some((frame) => screenContains(frame, 'Thinking ')),
        'the compact header created by the late reasoning frame',
        10_000,
      );
      const thinkingFrameIndex = tui
        .screenFramesSince(responseFrames)
        .findIndex((frame) => screenContains(frame, 'Thinking '));
      // Pure reasoning becomes visible first; the answer later consumes the
      // same presentation owner without creating another scrollback header.
      expect(thinkingFrameIndex).toBeLessThan(answerFrameIndex);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10_000, 750);

      const frames = tui.screenFramesSince(responseFrames);
      const liveFrames = stripAnsi(frames.join('\n'));
      const postAnswerFrames = stripAnsi(frames.slice(answerFrameIndex).join('\n'));
      const clean = stripAnsi(tui.scrollback());
      const compactLines = clean.split('\n').map((line) => line.trim());
      const thinkingHeader = compactLines.findIndex((line) => /^Thinking \d+s$/.test(line));

      expect(clean.match(/Thinking \d+s/g) ?? []).toHaveLength(1);
      // Both completed reasoning fragments may be shown while the answer is
      // still buffered. Once the answer becomes visible, the window must never
      // reappear or persist in replay.
      expect(postAnswerFrames).not.toContain('LATE_REASONING_PREFIX_MARKER');
      expect(postAnswerFrames).not.toContain('LATE_REASONING_SUFFIX_MARKER');
      expect(postAnswerFrames).not.toContain('● Thinking');
      expect(liveFrames).toContain('LATE_REASONING_SUFFIX_MARKER');
      expect(clean).not.toContain('● Thinking');
      expect(clean).not.toContain('LATE_REASONING_PREFIX_MARKER');
      expect(clean).not.toContain('LATE_REASONING_SUFFIX_MARKER');
      expect(clean).not.toContain('执行中');
      expect(clean.split('LATE_REASONING_ANSWER_ONCE')).toHaveLength(2);
      expect(compactLines.indexOf('LATE_REASONING_ANSWER_ONCE: the visible answer.')).toBe(
        thinkingHeader + 2,
      );
      expect(compactLines[thinkingHeader + 1]).toBe('');
      expect(server.getRequests()[0]?.body.stream).toBe(true);

      // Persist the settled live projection, then load it through the normal
      // PTY resume flow. A replay must not resurrect the transient spinner,
      // private reasoning string, or a duplicate answer block.
      await submitCommand(tui, '/exit');
      await tui.waitForExit();
      server.setResponses([]);
      resumedTui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitCommand(resumedTui, '/resume');
      await waitForCondition(
        () =>
          screenHasSessionRow(resumedTui!.viewport(), 'Reproduce late reasoning', {
            active: false,
          }),
        'the late-reasoning session to appear in /resume',
        10_000,
      );
      resumedTui.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(resumedTui!.viewport(), 'Reproduce late reasoning', {
            selected: true,
            active: false,
          }),
        'the persisted late-reasoning session row to become selected',
        5_000,
      );
      resumedTui.write('\r');
      await waitForText(() => resumedTui!.viewport(), 'LATE_REASONING_ANSWER_ONCE', 15_000);

      const replay = stripAnsi(resumedTui.scrollback());
      expect(replay.match(/Thinking \d+s/g) ?? []).toHaveLength(1);
      expect(replay).not.toContain('● Thinking');
      expect(replay).not.toContain('LATE_REASONING_PREFIX_MARKER');
      expect(replay).not.toContain('LATE_REASONING_SUFFIX_MARKER');
      expect(replay).not.toContain('执行中');
      expect(replay.split('LATE_REASONING_ANSWER_ONCE')).toHaveLength(2);
    },
    TIMEOUT,
  );
});
