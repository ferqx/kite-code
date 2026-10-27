import { publicAgentResponses } from '../harness/public-agent-responses';
/**
 * PTY regression for two concurrent children issuing the same tool name.
 *
 * The provider queue deliberately returns the slower alpha child before the
 * faster beta child. Their model/tool/result notifications therefore
 * interleave while the parent still owns one aggregation group.
 */

import { Database } from 'bun:sqlite';
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
  observePersistedSessionEvents,
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

    server.setResponses(
      publicAgentResponses(workspace, [
        {
          message: {
            content: 'I will inspect two same-name tool children concurrently.',
            tool_calls: [
              {
                id: 'same-name-alpha-parent',
                name: 'spawn_agent',
                args: {
                  task_name: 'Same-name tool child',
                  preset: 'explore',
                  prompt: `${ALPHA_TASK}: read ${alphaPath}`,
                },
              },
              {
                id: 'same-name-beta-parent',
                name: 'spawn_agent',
                args: {
                  task_name: 'Same-name tool child',
                  preset: 'explore',
                  prompt: `${BETA_TASK}: read ${betaPath}`,
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
      ]),
    );

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
      expect(settled).not.toContain('Task could not continue');

      const persisted = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, 'Run interleaved same-name child steps'),
      );
      if (!persisted) throw new Error('Expected persisted same-name child turn.');
      // Core keeps each child's events in its own original Session/Run. Resolve
      // the actual carrier chain before observing those logs, rather than
      // treating root-Run events as a flattened legacy descendant journal.
      using database = new Database(workspace.databasePath, { readonly: true });
      const children = database
        .query<
          {
            parent_call_id: string;
            carrier_id: string;
            child_session_id: string;
            child_run_id: string;
            state: string;
          },
          [string, string]
        >(`
          SELECT p.call_id AS parent_call_id,c.id AS carrier_id,
            c.child_session_id,r.id AS child_run_id,c.state
          FROM execution p JOIN run root ON root.id=p.run_id AND root.session_id=p.session_id
          JOIN execution c ON c.parent_execution_id=p.id AND c.kind='job'
          JOIN session s ON s.id=c.child_session_id AND s.parent_id=p.session_id
          JOIN session parent ON parent.id=p.session_id
          JOIN run r ON r.session_id=s.id
          WHERE p.session_id=? AND p.run_id=? AND p.kind='tool'
            AND p.call_id IN ('same-name-alpha-parent','same-name-beta-parent')
            AND c.origin_store_id=p.origin_store_id AND p.origin_store_id=root.origin_store_id
            AND r.origin_store_id=root.origin_store_id
            AND c.root_work_command_id=p.root_work_command_id
            AND c.root_work_seq=p.root_work_seq
            AND p.root_work_command_id=root.root_work_command_id
            AND p.root_work_seq=root.root_work_seq
            AND r.root_work_command_id=root.root_work_command_id
            AND r.root_work_seq=root.root_work_seq
            AND c.root_session_id=p.root_session_id AND s.root_id=p.root_session_id
            AND parent.root_id=p.root_session_id
            AND s.workspace_id=parent.workspace_id
        `)
        .all(persisted.threadId, persisted.turnId);
      expect(children).toHaveLength(2);
      expect(new Set(children.map((child) => child.parent_call_id))).toEqual(
        new Set(['same-name-alpha-parent', 'same-name-beta-parent']),
      );
      expect(new Set(children.map((child) => child.carrier_id)).size).toBe(2);
      expect(new Set(children.map((child) => child.child_session_id)).size).toBe(2);
      expect(new Set(children.map((child) => child.child_run_id)).size).toBe(2);
      const descendantEvents = children.flatMap((child) => {
        expect(child.state).toBe('succeeded');
        const events = requirePersistedRuntimeReady(
          observePersistedSessionEvents(workspace, child.child_session_id),
        ).filter((event) => event.turnId === child.child_run_id);
        const alpha = child.parent_call_id === 'same-name-alpha-parent';
        const ownCall = alpha ? 'same-name-alpha-step-tool' : 'same-name-beta-step-tool';
        const otherCall = alpha ? 'same-name-beta-step-tool' : 'same-name-alpha-step-tool';
        const finished = events.filter(
          (event) => event.sourceType === 'execution.finished' && event.callId === ownCall,
        );
        expect(finished).toHaveLength(1);
        expect(finished[0]!.status).toBe('succeeded');
        expect(JSON.stringify(events)).toContain(alpha ? 'ALPHA_STEP_DONE' : 'BETA_STEP_DONE');
        expect(JSON.stringify(events)).not.toContain(otherCall);
        return events;
      });
      const serialized = JSON.stringify([...persisted.events, ...descendantEvents]);
      expect(serialized).toContain('same-name-alpha-step-tool');
      expect(serialized).toContain('same-name-beta-step-tool');
      expect(serialized).toContain('ALPHA_STEP_DONE');
      expect(serialized).toContain('BETA_STEP_DONE');
    },
    TIMEOUT,
  );
});
