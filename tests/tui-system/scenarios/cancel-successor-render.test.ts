/**
 * PTY regression for the Windows cancellation/render race.
 *
 * A cancelled shell can spend noticeable time unwinding its process tree and
 * sandbox resources. The user is allowed to submit one successor prompt during
 * that cleanup window. The prompt must render once, the older run must not
 * reset the successor to idle, and the successor tool card must remain dynamic
 * so live output continues to repaint.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { tuiSystemDelay } from '../harness/cancellation';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  activeInput,
  submitCurrentInput,
  submitUserMessage,
  typeText,
  waitForRequestMessage,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 45_000;

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('TUI PTY System — cancel shell then render successor', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'auto',
        sandbox: { enabled: false },
      },
    });
    server.setResponses([
      {
        message: {
          content: 'Starting the cancellable shell.',
          tool_calls: [
            {
              id: 'old-shell',
              name: 'shell_execute',
              args: { command: 'pwd' },
            },
          ],
        },
        toolContinuation: 'aborted',
      },
      {
        message: {
          content: 'Starting the successor shell.',
          tool_calls: [
            {
              id: 'successor-shell',
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
              toolCallId: 'successor-shell',
              contentIncludes: ['SUCCESSOR_LINE_ONE', 'SUCCESSOR_LINE_TWO'],
            },
          ],
        },
        message: {
          reasoning_chunks: ['Checking the successor lifecycle.'],
          content_chunks: ['Successor completed once', '.'],
        },
      },
    ]);

    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'cancel-successor-tui.tsx'),
      mockServer: server,
      workspace,
    });
  });

  afterAll(async () => {
    // Exit through the TUI so Windows releases the PTY and temporary workspace
    // before the generic process-tree fallback runs.
    if (tui) {
      tui.write('\x03');
      await tuiSystemDelay(100);
      tui.write('\x03');
      await tui.waitForExit().catch(() => {});
    }
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'queues one successor prompt and keeps its shell output live without duplicate messages',
    async () => {
      await submitUserMessage(tui, server, 'start old shell', { delayMs: 0, timeout: 15_000 });
      await waitForText(() => tui.viewport(), 'OLD_SHELL_RUNNING', 15_000);

      tui.write('\x03');
      // Do not use waitForTuiReady here: its output-quiescence phase can spend
      // the whole synthetic cleanup window waiting on animated frames. We only
      // need proof that cancellation reopened the main input before submitting.
      await waitForCondition(
        () => {
          const input = activeInput(tui.inputViewport());
          return (
            input?.kind === 'main' &&
            input.value === '' &&
            !screenContains(tui.viewport(), 'Working · Running')
          );
        },
        'main input after cancellation',
        2_000,
        25,
      );
      await waitForText(() => tui.viewport(), 'cancelled', 2_000);

      const successorRequestBaseline = server.getRequestCount();
      expect(successorRequestBaseline).toBe(1);

      await typeText(tui, 'continue with successor', 0);
      // Record an explicit semantic input lifecycle. The successor is expected
      // to remain queued until predecessor cleanup completes, so submission
      // only waits for Ink to accept the input rather than for a model request.
      await submitCurrentInput(tui, { submitReceiptTimeoutMs: 2_000 });

      // The prompt is optimistic and visible while the cancelled predecessor
      // is still inside its synthetic five-second Windows cleanup delay.
      await waitForText(() => tui.viewport(), 'continue with successor', 2_000);
      expect(server.getRequestCount()).toBe(successorRequestBaseline);
      expect(screenContains(tui.viewport(), 'continue with successor')).toBe(true);

      await waitForRequestMessage(server, 'continue with successor', 15_000, {
        since: successorRequestBaseline,
        tui,
      });

      const progressFrames = tui.markScreen();
      await waitForText(() => tui.viewport(), 'SUCCESSOR_LINE_ONE', 15_000);
      const output = tui.viewport();
      expect(screenContains(output, 'SUCCESSOR_LINE_ONE')).toBe(true);
      expect(screenContains(output, 'SUCCESSOR_LINE_TWO')).toBe(false);
      expect(screenContains(output, 'Working · Running')).toBe(true);

      await waitForCondition(
        () =>
          tui
            .screenFramesSince(progressFrames)
            .some(
              (frame) =>
                screenContains(frame, 'Thought for') &&
                !screenContains(frame, 'Successor completed once.'),
            ),
        'a committed Thought frame before the successor answer',
        15_000,
        25,
      );

      await waitForText(() => tui.viewport(), 'Successor completed once.', 15_000);
      const renderedProgress = tui.screenFramesSince(progressFrames).join('\n');
      expect(screenContains(renderedProgress, 'SUCCESSOR_LINE_TWO')).toBe(true);
      await waitForTuiReady(tui);

      const finalScreen = stripAnsi(tui.scrollback());
      expect(occurrenceCount(finalScreen, 'continue with successor')).toBe(1);
      expect(occurrenceCount(finalScreen, 'Successor completed once.')).toBe(1);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
