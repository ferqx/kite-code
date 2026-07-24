/**
 * PTY System Test — Plan Mode policy boundary
 *
 * Covers the full TUI → session runtime → core runner → tool policy chain for
 * `/plan <task>`. The mock model deliberately attempts a write_file call. In
 * real Plan Mode, the TUI must pass initialPhase=planning to core so the write
 * is rejected before any approval or filesystem mutation can happen.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Plan Mode Policy Boundary', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      {
        message: {
          content: 'I will try to write during planning.',
          tool_calls: [
            {
              id: 'call_plan_write_denied',
              name: 'write_file',
              args: {
                path: 'plan-created.txt',
                content: 'This file must not be created from planning mode.',
              },
            },
          ],
        },
      },
      { message: { content: 'Planning write attempt was blocked.' } },
      { message: { content: 'Plan policy spare 1' } },
      { message: { content: 'Plan policy spare 2' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
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
    '/plan <task> starts core in planning phase and denies write_file',
    async () => {
      const task = 'Create plan-created.txt during planning';
      await typeText(tui, `/plan ${task}`);
      tui.write('\r');
      await waitForRequestMessage(server, task, 15000);

      await waitForText(() => tui.output(), 'Planning write attempt was blocked.', 15000);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after planning write denial:', clean.slice(-1500));

      expect(screenContains(output, 'Rejected write_file during planning phase')).toBe(true);
      expect(screenContains(output, 'Planning write attempt was blocked.')).toBe(true);
      expect(screenContains(output, '授权执行命令')).toBe(false);
      expect(existsSync(join(workspace.workspace, 'plan-created.txt'))).toBe(false);
    },
    TIMEOUT,
  );
});
