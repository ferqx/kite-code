import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { stripAnsi, waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 40_000;

function longAnswer(prefix: string): string {
  return Array.from(
    { length: 55 },
    (_, index) => `${prefix}_${String(index + 1).padStart(2, '0')}: completed detail.`,
  ).join('\n\n');
}

async function expectCompletedScrollToStayIdle(tui: PtyProcess): Promise<void> {
  await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10_000, 750);
  await tui.settleScreen();
  const atBottom = tui.viewportPosition();
  expect(atBottom.baseY).toBeGreaterThan(0);
  expect(atBottom.viewportY).toBe(atBottom.baseY);

  await tui.scrollViewport(-20);
  const scrolled = tui.viewportPosition();
  expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
  const idleFrames = tui.markScreen();

  await tui.writeExact('\x1b[O');
  await tui.writeExact('\x1b[I');
  await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 2_000, 250, false);
  await tui.settleScreen();
  const afterFocusReports = tui.viewportPosition();
  expect(afterFocusReports.baseY - afterFocusReports.viewportY).toBe(
    scrolled.baseY - scrolled.viewportY,
  );
  expect(afterFocusReports.viewportY).toBeLessThan(afterFocusReports.baseY);
  expect(tui.screenFramesSince(idleFrames)).toEqual([]);
}

describe('TUI PTY System — terminal standalone tool Static ownership', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    const answer = longAnswer('STANDALONE_STATIC_LINE');
    server.setResponses([
      {
        message: {
          content: 'I will create one workspace marker before answering.',
          tool_calls: [
            {
              id: 'standalone-static-write',
              name: 'write_file',
              args: {
                path: join(workspace.workspace, 'standalone-static-marker.txt'),
                content: 'created',
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'standalone-static-write',
              contentIncludes: ['standalone-static-marker.txt'],
            },
          ],
        },
        message: {
          content_chunks: [
            'STANDALONE_STATIC_FIRST: first complete component.\n\n',
            `${answer}\n\nSTANDALONE_STATIC_LAST: terminal component.`,
          ],
        },
        chunk_delay: 250,
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 30, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'freezes the terminal tool and every final component before completed scrolling',
    async () => {
      await submitUserMessage(tui, server, 'Create a marker and return a long answer', {
        timeout: 15_000,
      });
      await waitForText(() => tui.scrollback(), 'STANDALONE_STATIC_LAST', TIMEOUT);

      const clean = stripAnsi(tui.scrollback());
      expect(clean.match(/STANDALONE_STATIC_FIRST/g)).toHaveLength(1);
      expect(clean.match(/STANDALONE_STATIC_LAST/g)).toHaveLength(1);
      await expectCompletedScrollToStayIdle(tui);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — terminal concurrent Subagent Static ownership', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    const answer = longAnswer('SUBAGENT_STATIC_LINE');
    server.setResponses([
      {
        message: {
          content: 'I will inspect two independent areas concurrently.',
          tool_calls: [
            {
              id: 'subagent-static-runtime',
              name: 'task',
              args: {
                name: 'Inspect runtime packages',
                subagent_type: 'explore',
                task: 'Inspect the runtime package layout and report a short summary.',
              },
            },
            {
              id: 'subagent-static-tests',
              name: 'task',
              args: {
                name: 'Inspect test layout',
                subagent_type: 'explore',
                task: 'Inspect the test layout and report a short summary.',
              },
            },
          ],
        },
      },
      { delay: 500, message: { content: 'Runtime package inspection complete.' } },
      { delay: 500, message: { content: 'Test layout inspection complete.' } },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'subagent-static-runtime', contentIncludes: ['inspection complete'] },
            { toolCallId: 'subagent-static-tests', contentIncludes: ['inspection complete'] },
          ],
        },
        message: {
          content_chunks: [
            'SUBAGENT_STATIC_FIRST: first complete component.\n\n',
            `${answer}\n\nSUBAGENT_STATIC_LAST: terminal component.`,
          ],
        },
        chunk_delay: 250,
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 30, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'freezes one terminal group and every final component before completed scrolling',
    async () => {
      await submitUserMessage(tui, server, 'Delegate two inspections and return a long answer', {
        timeout: 15_000,
      });
      await waitForText(() => tui.scrollback(), 'SUBAGENT_STATIC_LAST', TIMEOUT);

      const clean = stripAnsi(tui.scrollback());
      expect(clean.match(/Delegated · 2 agents/g)).toHaveLength(1);
      expect(clean.match(/SUBAGENT_STATIC_FIRST/g)).toHaveLength(1);
      expect(clean.match(/SUBAGENT_STATIC_LAST/g)).toHaveLength(1);
      expect(clean).not.toContain('Encountered two children with the same key');
      await expectCompletedScrollToStayIdle(tui);
    },
    TIMEOUT,
  );
});
