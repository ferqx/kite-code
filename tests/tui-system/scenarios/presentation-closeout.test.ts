/**
 * PTY closeout coverage for the projection/rendering convergence plan.
 *
 * These scenarios intentionally exercise the real in-process App Server and
 * mock provider. The only transport manipulation is test-owned delivery
 * ordering in presentation-race-tui.tsx, which lets the same accepted facts
 * cross the Runtime Client/TUI seam in the failure order under test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 45_000;
const raceFixture = resolve(import.meta.dir, '..', 'fixtures', 'presentation-race-tui.tsx');

describe('TUI PTY System — presentation closeout races', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'terminal-before-receipt converges to one completed answer and one prompt',
    async () => {
      server = createMockModelServer();
      workspace = createTestWorkspace({
        configOverrides: { language: 'en-US', sandbox: { enabled: false } },
        projectConfigOverrides: { language: 'en-US', sandbox: { enabled: false } },
      });
      server.setResponses([{ message: { content: 'TERMINAL_BEFORE_RECEIPT_ANSWER' } }]);
      tui = await spawnReadyTui({
        cols: 120,
        rows: 40,
        entryPath: raceFixture,
        mockServer: server,
        workspace: {
          ...workspace,
          env: { ...workspace.env, KITE_TUI_FIXTURE_DELIVERY_MODE: 'terminal-before-receipt' },
        },
      });

      await submitUserMessage(tui, server, 'terminal before receipt', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'TERMINAL_BEFORE_RECEIPT_ANSWER', TIMEOUT);
      await waitForTuiReady(tui);

      const scrollback = stripAnsi(tui.scrollback());
      expect(scrollback.split('TERMINAL_BEFORE_RECEIPT_ANSWER')).toHaveLength(2);
      expect(scrollback.split('terminal before receipt')).toHaveLength(2);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
      expect(screenContains(tui.viewport(), 'Working')).toBe(false);
      expect(screenContains(tui.viewport(), 'Message was not sent')).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'post-terminal text, reasoning, progress, and durable tool events cannot reopen the sealed output',
    async () => {
      server = createMockModelServer();
      workspace = createTestWorkspace({
        configOverrides: {
          language: 'en-US',
          interactionMode: 'full',
          sandbox: { enabled: false },
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
            reasoning_chunks: ['LATE_EPHEMERAL_REASONING_MARKER'],
            content: 'Run one terminal-fenced tool.',
            tool_calls: [
              {
                id: 'terminal-fenced-shell',
                name: 'shell_execute',
                args: { command: 'pwd' },
              },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              {
                toolCallId: 'terminal-fenced-shell',
                contentIncludes: ['LATE_DURABLE_TOOL_LIFECYCLE_MARKER'],
              },
            ],
          },
          message: {
            content_chunks: ['ON_TIME_FINAL_MARKER\n\n', 'LATE_AFTER_TERMINAL'],
          },
          chunk_delay: 100,
        },
      ]);
      tui = await spawnReadyTui({
        cols: 120,
        rows: 40,
        entryPath: raceFixture,
        mockServer: server,
        workspace: {
          ...workspace,
          env: { ...workspace.env, KITE_TUI_FIXTURE_DELIVERY_MODE: 'late-events' },
        },
      });

      await submitUserMessage(tui, server, 'terminal fence all late events', { timeout: 15_000 });
      await waitForText(() => tui.scrollback(), 'ON_TIME_FINAL_MARKER', TIMEOUT);
      await waitForTuiReady(tui);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 5_000, 300, false);

      const settled = stripAnsi(tui.scrollback());
      expect(settled.split('ON_TIME_FINAL_MARKER')).toHaveLength(2);
      for (const marker of [
        'LATE_AFTER_TERMINAL',
        'LATE_EPHEMERAL_REASONING_MARKER',
        'LATE_EPHEMERAL_TOOL_PROGRESS_MARKER',
        'LATE_DURABLE_TOOL_LIFECYCLE_MARKER',
      ]) {
        expect(settled.split(marker).length - 1).toBeLessThanOrEqual(1);
      }
      expect(screenContains(tui.viewport(), 'Working')).toBe(false);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);

      const idleOutput = tui.markOutput();
      const idleFrames = tui.markScreen();
      await waitForOutputQuiescence(() => tui.outputSince(idleOutput), 2_000, 250, false);
      expect(tui.screenFramesSince(idleFrames)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — clearout physical ownership', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: { language: 'en-US', sandbox: { enabled: false } },
    });
    server.setResponses([
      { message: { content: 'CLEAROUT_FIRST_MARKER' } },
      { message: { content: 'CLEAROUT_SECOND_MARKER' } },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    '/clear advances the physical presentation and the next answer is rendered once',
    async () => {
      await submitUserMessage(tui, server, 'first clearout turn', { timeout: 15_000 });
      await waitForText(() => tui.scrollback(), 'CLEAROUT_FIRST_MARKER', 15_000);
      await waitForTuiReady(tui);

      await submitCommand(tui, '/clear');
      await waitForCondition(
        () => !screenContains(tui.viewport(), 'CLEAROUT_FIRST_MARKER'),
        'the pre-clear marker to leave the current viewport',
        10_000,
      );

      await submitUserMessage(tui, server, 'second clearout turn', { timeout: 15_000 });
      await waitForText(() => tui.scrollback(), 'CLEAROUT_SECOND_MARKER', 15_000);
      await waitForTuiReady(tui);

      const current = stripAnsi(tui.viewport());
      expect(current).not.toContain('CLEAROUT_FIRST_MARKER');
      expect(current.split('CLEAROUT_SECOND_MARKER')).toHaveLength(2);
      expect(screenContains(current, '❯')).toBe(true);

      const idleOutput = tui.markOutput();
      const idleFrames = tui.markScreen();
      await waitForOutputQuiescence(() => tui.outputSince(idleOutput), 2_000, 250, false);
      expect(tui.screenFramesSince(idleFrames)).toEqual([]);
    },
    TIMEOUT,
  );
});
