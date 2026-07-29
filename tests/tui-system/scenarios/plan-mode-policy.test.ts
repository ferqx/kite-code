/**
 * PTY System Test — Plan Mode policy boundary
 *
 * Covers the full TUI → session runtime → core runner → tool policy chain for
 * Shift+Tab followed by a plain prompt. The mock model deliberately attempts a
 * write_file call. In real Plan Mode, the TUI must pass initialPhase=planning
 * to core so the write is rejected before any approval or filesystem mutation
 * can happen. After the conversation settles, Shift+Tab must still exit.
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
      {
        message: {
          content: 'I will validate the plan.',
          tool_calls: [
            {
              id: 'call_plan_typecheck_deferred',
              name: 'shell_execute',
              args: {
                command: 'bun run typecheck',
                description: 'Type-check the project',
              },
            },
            {
              id: 'call_plan_tests_deferred',
              name: 'shell_execute',
              args: {
                command: 'bun test tests/runtime',
                description: 'Run Runtime tests',
              },
            },
          ],
        },
      },
      { message: { content: 'Recorded validation commands for the execution phase.' } },
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
    'Shift+Tab plan mode applies to a plain conversation and denies write_file',
    async () => {
      const task = 'Create plan-created.txt during planning';
      tui.write('\x1b[Z');
      await waitForText(() => tui.output(), 'Shift+Tab to exit', 5000);
      await typeText(tui, task);
      tui.write('\r');
      await waitForRequestMessage(server, task, 15000);

      await waitForText(() => tui.output(), 'Planning write attempt was blocked.', 15000);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after planning write denial:', clean.slice(-1500));

      expect(
        screenContains(
          output,
          'Plan mode is read-only. No file was written. Describe the intended change in the plan and apply it after plan approval.',
        ),
      ).toBe(true);
      expect(screenContains(output, 'Write (plan-created.txt)')).toBe(false);
      expect(screenContains(output, 'Planning write attempt was blocked.')).toBe(true);
      expect(screenContains(output, '授权执行命令')).toBe(false);
      expect(existsSync(join(workspace.workspace, 'plan-created.txt'))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'Shift+Tab exits plan mode after the conversation completes',
    async () => {
      const outputBeforeExit = tui.output().length;
      tui.write('\x1b[Z');
      await new Promise((resolve) => setTimeout(resolve, 700));
      const render = stripAnsi(tui.output().slice(outputBeforeExit));
      expect(render).toContain('mock-model');
      // Ink may emit one stale plan frame before the building frame in the
      // same PTY delta. The final footer must be the later building render.
      expect(render.lastIndexOf('mock-model')).toBeGreaterThan(
        render.lastIndexOf('Shift+Tab to exit'),
      );
    },
    TIMEOUT,
  );

  test(
    'planning shell validation stays internal without approval or message cards',
    async () => {
      const task = 'Plan the runtime validation commands';
      tui.write('\x1b[Z');
      await waitForText(() => tui.output(), 'Shift+Tab to exit', 5000);
      const outputBeforePrompt = tui.output().length;
      await typeText(tui, task);
      tui.write('\r');
      await waitForRequestMessage(server, task, 15000);
      await waitForText(
        () => tui.output().slice(outputBeforePrompt),
        'Recorded validation commands for the execution phase.',
        15000,
      );

      const output = tui.output().slice(outputBeforePrompt);
      expect(screenContains(output, 'Deferred until execution')).toBe(false);
      expect(screenContains(output, 'bun run typecheck')).toBe(false);
      expect(screenContains(output, 'bun test tests/runtime')).toBe(false);
      expect(screenContains(output, 'Rejected shell_execute during planning phase')).toBe(false);
      expect(screenContains(output, 'Bash Ran:')).toBe(false);
      expect(screenContains(output, '授权执行命令')).toBe(false);
    },
    TIMEOUT,
  );
});
