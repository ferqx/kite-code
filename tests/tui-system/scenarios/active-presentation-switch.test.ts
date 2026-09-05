/**
 * PTY closeout coverage for presentation changes while a Run is streaming.
 *
 * Model selection exercises the real App Control snapshot/select path and
 * checks the provider request body at both Run admissions. Theme/language
 * selection stays entirely client-side and must not create another Run.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
  waitForTextGone,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 45_000;

function streamingTail(prefix: string, finalMarker: string, middleCount = 10): string[] {
  return [
    `${prefix}_FIRST\n\n`,
    ...Array.from(
      { length: middleCount },
      (_, index) => `${prefix}_MIDDLE_${String(index + 1).padStart(2, '0')}\n\n`,
    ),
    finalMarker,
  ];
}

async function moveSelectorDownTo(tui: PtyProcess, selectedLabel: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    tui.write('\x1b[B');
    try {
      await waitForText(() => tui.viewport(), `❯ ${selectedLabel}`, 1_500);
      return;
    } catch (error) {
      lastError = error;
      await waitForText(() => tui.viewport(), '语言', 5_000);
    }
  }
  throw lastError;
}

describe('TUI PTY System — active Run model selection', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        language: 'en-US',
        sandbox: { enabled: false },
        provider: {
          mock: {
            type: 'deepseek',
            apiKey: 'test-key',
            baseURL: server.baseURL,
            model: 'mock-model',
            models: [
              { name: 'mock-model', default: true, streaming: true },
              { name: 'next-model', default: false, streaming: true },
            ],
          },
        },
        model: { default: { provider: 'mock', name: 'mock-model' } },
      },
    });
    server.setResponses([
      {
        message: {
          content_chunks: streamingTail('ACTIVE_OLD_MODEL', 'ACTIVE_OLD_MODEL_FINAL'),
        },
        chunk_delay: 450,
      },
      { message: { content: 'ACTIVE_NEXT_MODEL_FINAL' } },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps the active Run on its admitted model and applies the selection to the next Run',
    async () => {
      await submitUserMessage(tui, server, 'stream on the old model', { timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'ACTIVE_OLD_MODEL_FIRST', 10_000);
      expect(server.getRequestCount()).toBe(1);
      expect(server.getRequests()[0]?.body.model).toBe('mock-model');
      expect(screenContains(tui.viewport(), 'mock-model')).toBe(true);

      await submitCommand(tui, '/model');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          screenContains(tui.viewport(), 'next-model'),
        'model selector options during active streaming',
        10_000,
      );
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ next-model', 5_000);
      tui.write('\r');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          !screenContains(tui.viewport(), '❯ next-model') &&
          !screenContains(tui.viewport(), 'Saving'),
        'active Run header to retain the admitted model after selection closes',
        10_000,
      );

      // Selecting a model is App Control state only; it must not submit a
      // second Runtime turn while the first stream remains in flight.
      expect(server.getRequestCount()).toBe(1);
      expect(screenContains(tui.viewport(), 'next-model')).toBe(false);

      await waitForText(() => tui.scrollback(), 'ACTIVE_OLD_MODEL_FINAL', TIMEOUT);
      await waitForCondition(
        () => screenContains(tui.viewport(), 'next-model') && screenContains(tui.viewport(), '❯'),
        'next-model header and prompt after the first Run settles',
        10_000,
      );
      await submitUserMessage(tui, server, 'stream on the selected next model', {
        timeout: 15_000,
      });
      await waitForText(() => tui.scrollback(), 'ACTIVE_NEXT_MODEL_FINAL', 15_000);
      await waitForCondition(
        () => screenContains(tui.viewport(), 'next-model') && screenContains(tui.viewport(), '❯'),
        'next-model prompt after the second Run settles',
        10_000,
      );

      expect(server.getRequestCount()).toBe(2);
      expect(server.getRequests()[1]?.body.model).toBe('next-model');
      const settled = stripAnsi(tui.scrollback());
      expect(settled.split('ACTIVE_OLD_MODEL_FINAL')).toHaveLength(2);
      expect(settled.split('ACTIVE_NEXT_MODEL_FINAL')).toHaveLength(2);
      expect(screenContains(tui.viewport(), 'next-model')).toBe(true);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — active Run theme and language changes', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        language: 'zh-CN',
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
          content_chunks: streamingTail('ACTIVE_VISUAL_EPOCH', 'ACTIVE_VISUAL_EPOCH_FINAL', 24),
        },
        chunk_delay: 500,
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'redraws the current viewport for theme/language changes without restarting the Run',
    async () => {
      await submitUserMessage(tui, server, 'stream while changing presentation', {
        timeout: 15_000,
      });
      await waitForText(() => tui.viewport(), 'ACTIVE_VISUAL_EPOCH_FIRST', 10_000);
      const requestBaseline = server.getRequestCount();

      await submitCommand(tui, '/theme');
      await waitForText(() => tui.viewport(), '选择色彩主题', 10_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 紫', 5_000);
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '选择色彩主题', 10_000);
      await waitForCondition(
        () => screenContains(tui.viewport(), 'Theme set to purple'),
        'theme selection acknowledgement',
        10_000,
      );
      expect(server.getRequestCount()).toBe(requestBaseline);

      await submitCommand(tui, '/language');
      await waitForText(() => tui.viewport(), '语言', 10_000);
      await waitForText(() => tui.viewport(), '❯ 简体中文', 5_000);
      await moveSelectorDownTo(tui, 'English');
      tui.write('\r');
      await waitForTextGone(() => tui.viewport(), '语言', 10_000);
      expect(server.getRequestCount()).toBe(requestBaseline);

      // Opening a translated local overlay gives a semantic receipt for the
      // language epoch; it does not touch Runtime or the in-flight stream.
      await submitCommand(tui, '/help');
      await waitForText(() => tui.viewport(), 'Shortcuts', 10_000);
      expect(screenContains(tui.viewport(), '快捷键')).toBe(false);
      tui.write('\x1b');

      await waitForText(() => tui.scrollback(), 'ACTIVE_VISUAL_EPOCH_FINAL', TIMEOUT);
      await waitForCondition(
        () => screenContains(tui.viewport(), '❯') && !screenContains(tui.viewport(), 'Working'),
        'prompt recovery after active visual presentation changes',
        15_000,
      );
      const settled = stripAnsi(tui.scrollback());
      expect(server.getRequestCount()).toBe(requestBaseline);
      expect(settled.split('ACTIVE_VISUAL_EPOCH_FIRST')).toHaveLength(2);
      expect(settled.split('ACTIVE_VISUAL_EPOCH_FINAL')).toHaveLength(2);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
