/**
 * PTY regression for two concurrent children issuing the same tool name.
 *
 * The provider queue deliberately returns the slower alpha child before the
 * faster beta child. Their model/tool/result notifications therefore
 * interleave while the parent still owns one aggregation group.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 45_000;
const ALPHA_TASK = 'INTERLEAVED_ALPHA_TASK';
const BETA_TASK = 'INTERLEAVED_BETA_TASK';
const ALPHA_FILE = 'interleaved-alpha.txt';
const BETA_FILE = 'interleaved-beta.txt';

function requestText(messages: readonly { content?: unknown }[]): string {
  return messages.map((message) => String(message.content ?? '')).join('\n');
}

describe('TUI PTY System — concurrent same-name Subagent steps', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: { language: 'en-US', sandbox: { enabled: false } },
      files: {
        [ALPHA_FILE]: 'ALPHA_STEP_FILE_CONTENT',
        [BETA_FILE]: 'BETA_STEP_FILE_CONTENT',
      },
    });
    const alphaPath = join(workspace.workspace, ALPHA_FILE);
    const betaPath = join(workspace.workspace, BETA_FILE);

    server.setResponses([
      {
        message: {
          content: 'I will inspect two same-name tool children concurrently.',
          tool_calls: [
            {
              id: 'same-name-alpha-parent',
              name: 'task',
              args: {
                name: 'Same-name tool child',
                subagent_type: 'explore',
                task: `${ALPHA_TASK}: read ${alphaPath}`,
              },
            },
            {
              id: 'same-name-beta-parent',
              name: 'task',
              args: {
                name: 'Same-name tool child',
                subagent_type: 'explore',
                task: `${BETA_TASK}: read ${betaPath}`,
              },
            },
          ],
        },
      },
      {
        response: ({ messages }) => {
          const text = requestText(messages);
          const alpha = text.includes(ALPHA_TASK);
          const beta = text.includes(BETA_TASK);
          if (alpha === beta) {
            throw new Error(`expected exactly one child task in first step: ${text}`);
          }
          return {
            // Alpha is intentionally slower, so Beta's matching read_file
            // step can complete while Alpha is still in the same group.
            delay: alpha ? 350 : 25,
            message: {
              content: `${alpha ? 'Alpha' : 'Beta'} child starts the same-name read_file step.`,
              tool_calls: [
                {
                  id: alpha ? 'same-name-alpha-step-tool' : 'same-name-beta-step-tool',
                  name: 'read_file',
                  args: { path: alpha ? alphaPath : betaPath },
                },
              ],
            },
          };
        },
      },
      {
        response: ({ messages }) => {
          const text = requestText(messages);
          const alpha = text.includes(ALPHA_TASK);
          const beta = text.includes(BETA_TASK);
          if (alpha === beta) {
            throw new Error(`expected exactly one child task in second step: ${text}`);
          }
          return {
            delay: alpha ? 350 : 25,
            message: {
              content: `${alpha ? 'Alpha' : 'Beta'} child issued the same-name read_file step.`,
              tool_calls: [
                {
                  id: alpha ? 'same-name-alpha-step-tool' : 'same-name-beta-step-tool',
                  name: 'read_file',
                  args: { path: alpha ? alphaPath : betaPath },
                },
              ],
            },
          };
        },
      },
      {
        response: ({ messages }) => {
          const text = requestText(messages);
          if (text.includes('ALPHA_STEP_FILE_CONTENT')) {
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'same-name-alpha-step-tool',
                    contentIncludes: ['ALPHA_STEP_FILE_CONTENT'],
                  },
                ],
              },
              delay: 250,
              message: { content: 'ALPHA_STEP_DONE' },
            };
          }
          if (text.includes('BETA_STEP_FILE_CONTENT')) {
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'same-name-beta-step-tool',
                    contentIncludes: ['BETA_STEP_FILE_CONTENT'],
                  },
                ],
              },
              delay: 25,
              message: { content: 'BETA_STEP_DONE' },
            };
          }
          throw new Error(`expected one same-name child tool result: ${text}`);
        },
      },
      {
        response: ({ messages }) => {
          const text = requestText(messages);
          if (text.includes('ALPHA_STEP_FILE_CONTENT')) {
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'same-name-alpha-step-tool',
                    contentIncludes: ['ALPHA_STEP_FILE_CONTENT'],
                  },
                ],
              },
              delay: 250,
              message: { content: 'ALPHA_STEP_DONE' },
            };
          }
          if (text.includes('BETA_STEP_FILE_CONTENT')) {
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'same-name-beta-step-tool',
                    contentIncludes: ['BETA_STEP_FILE_CONTENT'],
                  },
                ],
              },
              delay: 25,
              message: { content: 'BETA_STEP_DONE' },
            };
          }
          throw new Error(`expected one same-name child continuation: ${text}`);
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'same-name-alpha-parent',
              contentIncludes: ['ALPHA_STEP_DONE'],
            },
            {
              toolCallId: 'same-name-beta-parent',
              contentIncludes: ['BETA_STEP_DONE'],
            },
          ],
        },
        message: { content: 'INTERLEAVED_PARENT_DONE' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps same-name child steps bound to their own identity during interleaved execution',
    async () => {
      await submitUserMessage(tui, server, 'Run interleaved same-name child steps', {
        timeout: 15_000,
      });
      await waitForText(() => tui.outputSinceLastAction(), 'Delegating · 2 agents', TIMEOUT);

      const active = stripAnsi(tui.viewport());
      expect(active.match(/Same-name tool child/g)).toHaveLength(2);

      await waitForText(() => tui.outputSinceLastAction(), 'INTERLEAVED_PARENT_DONE', TIMEOUT);
      await waitForCondition(
        () => screenContains(tui.viewport(), '❯') && !screenContains(tui.viewport(), 'Working'),
        'prompt recovery after both same-name children finish',
        10_000,
      );

      const settled = stripAnsi(tui.scrollback());
      expect(settled.match(/INTERLEAVED_PARENT_DONE/g)).toHaveLength(1);
      expect(settled).not.toContain('Encountered two children with the same key');
      expect(settled).not.toContain('Message was not sent');

      const persisted = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, 'Run interleaved same-name child steps'),
      );
      if (!persisted) throw new Error('Expected persisted same-name child turn.');
      const serialized = JSON.stringify(persisted.events);
      expect(serialized).toContain('same-name-alpha-step-tool');
      expect(serialized).toContain('same-name-beta-step-tool');
      expect(serialized).toContain('ALPHA_STEP_DONE');
      expect(serialized).toContain('BETA_STEP_DONE');
    },
    TIMEOUT,
  );
});
