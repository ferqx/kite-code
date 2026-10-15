/**
 * PTY System Test — Sub-agent External Write Approval
 *
 * Verifies that when a sub-agent attempts to write a file outside the workspace
 * (an absolute path outside the workspace), the approval flow is triggered correctly:
 *   1. Main agent spawns a code sub-agent via the task tool
 *   2. Sub-agent attempts write_file with an absolute path
 *   3. Approval dialog appears for the external write
 *   4. User approves → tool executes → sub-agent continues → completes
 *
 * Original Model fixtures are translated to the current public Tool contracts.
 * The production Service owns task.execute, the child Run and its scoped
 * permission intersection; the PTY and actual durable receipts prove the journey.
 */

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import {
  createMockModelServer,
  type MockChatRequest,
  type MockResponse,
} from '../harness/fixtures';
import { submitUserMessage, submitUserMessageForDeferredDelivery } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

// Explicit original workload; V1.3 D17 retired hidden cumulative child step limits.
const EXPLORATION_FIXTURE_READS = 12;
const TIMEOUT = 30000;

describe('TUI PTY System — Sub-agent External Write Approval', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'accept_edits',
      },
    });
    externalFile = join(workspace.home, 'external-subagent-write.txt');

    // Response sequence:
    // #1: Main agent → dispatches a code sub-agent (task tool)
    // #2: Sub-agent → attempts write_file with absolute path (triggers approval)
    // #3: Sub-agent after approval → summary
    // #4: Main agent after sub-agent completes → final response
    server.setResponses([
      {
        message: {
          content: 'I will dispatch a sub-agent to test external file write authorization.',
          tool_calls: [
            {
              id: 'call_spawn_subagent',
              name: 'task',
              args: {
                name: 'Write external test file',
                subagent_type: 'code',
                task: `Write a test file at ${externalFile} with content "Test: sub-agent external write". Report whether the write succeeded or was blocked.`,
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will write the test file.',
          tool_calls: [
            {
              id: 'call_subagent_write',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'Test: sub-agent external write',
              },
            },
          ],
        },
      },
      {
        // Keep the resumed child alive long enough to assert that the local
        // approval acknowledgement updates its card before the next model
        // response or durable child progress can do so incidentally.
        delay: 750,
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_subagent_write', contentIncludes: ['external-subagent-write.txt'] },
          ],
        },
        message: {
          content: 'The write succeeded after approval.',
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_spawn_subagent', contentIncludes: ['write succeeded'] },
          ],
        },
        message: {
          content: 'Sub-agent completed successfully.',
        },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step(
    'sub-agent external write triggers approval dialog, approve → tool executes → completes',
    async () => {
      // Type the user message
      await submitUserMessage(tui, server, 'Test subagent external file write authorization', {
        timeout: 15000,
      });

      // Wait for the sub-agent to start and the external write to trigger approval
      await waitForText(() => tui.viewport(), '工具授权', TIMEOUT);
      await waitForText(() => tui.viewport(), 'files.write_path', TIMEOUT);
      await waitForText(() => tui.viewport(), externalFile, TIMEOUT);

      const beforeApprove = tui.viewport();
      const clean = stripAnsi(beforeApprove);
      console.log('  output during approval:', clean.slice(-2000));

      // Verify approval dialog content
      expect(screenContains(beforeApprove, '工具授权')).toBe(true);
      expect(screenContains(beforeApprove, '人工审批')).toBe(false);
      expect(screenContains(beforeApprove, '人工审批队列')).toBe(false);
      expect(screenContains(beforeApprove, '代次')).toBe(false);
      // The approval surface shows the bounded original command, including
      // its concrete target, while authority remains bound to the closed
      // interaction identity rather than reconstructed from this text.
      expect(externalFile.startsWith(workspace.workspace)).toBe(false);
      expect(screenContains(beforeApprove, 'files.write_path')).toBe(true);
      expect(screenContains(beforeApprove, 'external-subagent-write')).toBe(true);
      expect(screenContains(beforeApprove, externalFile)).toBe(true);
      expect(existsSync(externalFile)).toBe(false);

      // Measure the actual external effect separately from UI acknowledgement.
      const approvalSubmittedAt = performance.now();
      tui.write('\r');
      await waitForCondition(
        () => existsSync(externalFile),
        'approved child write to reach the filesystem',
        TIMEOUT,
        10,
      );
      const approvalToEffectMs = Math.round(performance.now() - approvalSubmittedAt);
      expect(readFileSync(externalFile, 'utf8')).toContain('Test: sub-agent external write');
      const persisted = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, 'Test subagent external file write authorization'),
      );
      expect(persisted).toBeDefined();
      const database = new Database(workspace.databasePath, { readonly: true });
      try {
        const owner = database
          .query<
            {
              id: string;
              kind: string;
              call_id: string;
              session_id: string;
              root_session_id: string;
              parent_execution_id: string;
              state: string;
              answer_json: string;
              accepted_decision_revision: number;
              granted: number;
              started: number;
            },
            [string]
          >(`SELECT e.id,e.kind,e.call_id,e.session_id,e.root_session_id,e.parent_execution_id,
          e.state,i.answer_json,i.accepted_decision_revision,
          (SELECT MIN(cursor) FROM change_event WHERE object_id=i.id AND scope_session_id=e.session_id AND type='interaction.answered') AS granted,
          (SELECT MIN(cursor) FROM change_event WHERE object_id=e.id AND scope_session_id=e.session_id AND type='execution.dispatching') AS started
          FROM execution e JOIN interaction i ON i.execution_id=e.id AND i.session_id=e.session_id
          WHERE e.call_id=? AND i.kind='approval'`)
          .get('call_subagent_write');
        expect(owner).toBeDefined();
        expect(owner!.granted).toBeGreaterThanOrEqual(0);
        expect(owner).toEqual(
          expect.objectContaining({ kind: 'tool', call_id: 'call_subagent_write' }),
        );
        expect(owner!.session_id).not.toBe(owner!.root_session_id);
        expect(owner!.root_session_id).toBe(persisted!.threadId);
        expect(owner!.parent_execution_id).toBeTruthy();
        expect(JSON.parse(owner!.answer_json)).toMatchObject({
          kind: 'approval',
          decision: 'approve',
        });
        expect(owner!.accepted_decision_revision).toBeGreaterThan(0);
        expect(owner!.started).toBeGreaterThan(owner!.granted);
        console.log(JSON.stringify({ approvalToEffectMs, originalChildApproval: owner }));
      } finally {
        database.close();
      }

      // The optimistic `approving` projection may be shorter than one Ink
      // frame.  Require the first canonical post-grant child state instead:
      // either the durable authorized queue acknowledgement or its immediate
      // running successor.
      const postGrantDiagnostic = setTimeout(
        () => console.log('post-grant viewport', stripAnsi(tui.viewport())),
        2500,
      );
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            !screenContains(viewport, '人工审批队列') &&
            !screenContains(viewport, '工具授权') &&
            (screenContains(viewport, '已授权 · 等待执行') || screenContains(viewport, '进行中'))
          );
        },
        'exact child approval to leave the human queue after its durable acknowledgement',
        TIMEOUT,
      );
      clearTimeout(postGrantDiagnostic);
      const acknowledged = tui.viewport();
      expect(screenContains(acknowledged, '人工审批队列')).toBe(false);
      expect(screenContains(acknowledged, '工具授权')).toBe(false);

      // After approval, the sub-agent should continue and complete
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Sub-agent completed successfully.',
        TIMEOUT,
      );

      const afterApprove = tui.viewport();
      const clean2 = stripAnsi(afterApprove);
      console.log('  output after approval (last 2000 chars):', clean2.slice(-2000));

      // Verify the sub-agent completed
      expect(screenContains(afterApprove, 'Sub-agent completed successfully.')).toBe(true);
      expect(screenContains(afterApprove, '● Tool')).toBe(false);

      // TUI should recover — prompt visible
      expect(screenContains(afterApprove, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'external file was actually written after approval',
    async () => {
      expect(existsSync(externalFile)).toBe(true);
      const content = readFileSync(externalFile, 'utf8');
      expect(content).toContain('Test: sub-agent external write');
    },
    TIMEOUT,
  );
  test(
    'runs the complete external-write approval journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

describe('TUI PTY System — Sub-agent Approval Cancellation', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'accept_edits',
      },
    });
    externalFile = join(workspace.home, 'cancelled-subagent-write.txt');

    // Keep both model responses explicitly aborted.  The first response still
    // creates a real child; the second response reaches the child approval
    // boundary.  No continuation response is allowed after any cancellation
    // key, which makes an accidental parent-model continuation observable as
    // an exhausted/invalid fixture request.
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will delegate the external write.',
          tool_calls: [
            {
              id: 'call_cancelled_child',
              name: 'task',
              args: {
                name: 'Cancel child write',
                subagent_type: 'code',
                task: `Write a file at ${externalFile}. This operation will be cancelled by the user.`,
              },
            },
          ],
        },
      },
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will write the delegated file.',
          tool_calls: [
            {
              id: 'call_cancelled_child_write',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'must not be written',
              },
            },
          ],
        },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test.each(['reject', 'escape', 'ctrl-c'] as const)(
    'child approval %s leaves no manual approval or Working surface and never executes the tool',
    async (action) => {
      const prompt = `Cancel child approval with ${action}`;
      await submitUserMessage(tui, server, prompt, { timeout: 15_000 });
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '工具授权') &&
            screenContains(viewport, '❯ 允许一次') &&
            screenContains(viewport, '拒绝')
          );
        },
        'child approval modal to become interactive',
        15_000,
      );

      const approvalFrame = tui.viewport();
      expect(screenContains(approvalFrame, '工具授权')).toBe(true);
      expect(screenContains(approvalFrame, 'Working')).toBe(false);
      expect(screenContains(approvalFrame, 'cancelled-subagent-write')).toBe(true);
      const requestCountBeforeAction = server.getRequestCount();

      if (action === 'reject') {
        tui.write('\x1b[B');
        await waitForText(() => tui.viewport(), '❯ 拒绝', 5_000);
        tui.write('\r');
      } else if (action === 'escape') {
        tui.write('\x1b');
      } else {
        tui.write('\x03');
      }

      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '❯') &&
            !screenContains(viewport, '工具授权') &&
            !screenContains(viewport, 'Working')
          );
        },
        `child approval ${action} to return to the prompt`,
        15_000,
      );
      await waitForTuiReady(tui);

      const output = stripAnsi(tui.viewport());
      expect(output).not.toContain('工具授权');
      expect(output).not.toContain('Working');
      expect(output).toContain('❯');
      expect(existsSync(externalFile)).toBe(false);
      // Cancellation/rejection is terminal for this fixture; a parent model
      // continuation would consume a third response and fail cleanup.
      if (server.getRequestCount() !== requestCountBeforeAction) {
        console.log(
          'unexpected child cancellation continuation',
          server.getRequests().map((request) => request.messages.at(-1)),
        );
        const observation = new Database(workspace.databasePath, { readonly: true });
        try {
          console.log(
            'actual cancelled child facts',
            observation.query('SELECT id,kind,adapter_id,state,result_json FROM execution').all(),
          );
        } finally {
          observation.close();
        }
      }
      expect(server.getRequestCount()).toBe(requestCountBeforeAction);

      const persisted = requirePersistedRuntimeReady(observePersistedTurnEvents(workspace, prompt));
      expect(persisted).toBeDefined();
      const database = new Database(workspace.databasePath, { readonly: true });
      try {
        const run = database
          .query<{ status: string }, [string]>('SELECT status FROM run WHERE id=?')
          .get(persisted!.turnId);
        expect(['cancelled', 'failed', 'completed']).toContain(run?.status);
        const writes = database
          .query<{ dispatched: number; state: string }, [string]>(
            'SELECT dispatched,state FROM execution WHERE call_id=?',
          )
          .all('call_cancelled_child_write');
        expect(
          writes.some((execution) => execution.dispatched !== 0 || execution.state === 'succeeded'),
        ).toBe(false);
      } finally {
        database.close();
      }
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Sub-agent Automatic Review', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'auto',
        sandbox: { enabled: false },
      },
    });
    externalFile = join(workspace.home, 'auto-reviewed-subagent-write.txt');

    server.setResponses([
      {
        message: {
          content: 'I will delegate this external write.',
          tool_calls: [
            {
              id: 'call_spawn_auto_reviewed_subagent',
              name: 'task',
              args: {
                name: 'Write auto-reviewed file',
                subagent_type: 'code',
                task: `Write "auto review succeeded" to ${externalFile}.`,
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will write the requested file.',
          tool_calls: [
            {
              id: 'call_auto_reviewed_write',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'auto review succeeded',
              },
            },
          ],
        },
      },
      {
        response: ({ messages }) => {
          const reviewRequest = String(messages.at(-1)?.content ?? '');
          const actual = JSON.parse(reviewRequest) as {
            request: {
              kind: string;
              policies: {
                scope: string;
                request: {
                  context: {
                    task: {
                      availability: string;
                      workspaceRoot: string;
                      isChild: boolean;
                      role: { id: string; version: string };
                      rootUserTask: string;
                      parentUserTask: string;
                    };
                  };
                };
              }[];
            };
          };
          expect(actual.request.kind).toBe('parent_child_permission_intersection');
          expect(actual.request.policies.map((policy) => policy.scope)).toEqual([
            'parent',
            'child',
          ]);
          for (const policy of actual.request.policies) {
            expect(policy.request.context.task).toMatchObject({
              availability: 'available',
              workspaceRoot: workspace.workspace,
              isChild: true,
              role: { id: 'code', version: '1' },
              rootUserTask: 'Use a subagent to perform the external fixture write',
              parentUserTask: 'Use a subagent to perform the external fixture write',
            });
          }
          return {
            // Keep the reviewer request in flight long enough to assert the transient TUI state.
            delay: 750,
            message: {
              content: JSON.stringify({
                decision: 'approve_once',
                reason: 'The requested fixture write is scoped and reversible.',
              }),
            },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_auto_reviewed_write',
              contentIncludes: ['auto-reviewed-subagent-write.txt'],
            },
          ],
        },
        message: { content: 'The automatically reviewed write succeeded.' },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_spawn_auto_reviewed_subagent',
              contentIncludes: ['automatically reviewed write succeeded'],
            },
          ],
        },
        message: { content: 'Automatic sub-agent review completed successfully.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'auto review completes durably without relying on a transient client state',
    async () => {
      const reviewFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Use a subagent to perform the external fixture write', {
        timeout: 15000,
      });

      // The reviewer response is deliberately delayed. Capture the actual
      // child phase instead of treating the final parent answer as proof that
      // the intermediate projection was rendered correctly.
      await waitForCondition(
        () => {
          const frames = tui.screenFramesSince(reviewFrames).map(stripAnsi);
          return frames.some(
            (frame) => frame.includes('等待自动审查') || frame.includes('自动审查中'),
          );
        },
        'auto-review child phase to become visible',
        15_000,
      );
      const phaseFrame = tui
        .screenFramesSince(reviewFrames)
        .map(stripAnsi)
        .find((frame) => frame.includes('等待自动审查') || frame.includes('自动审查中'));
      expect(phaseFrame).toBeDefined();
      expect(phaseFrame).not.toContain('工具授权');
      expect(phaseFrame).not.toContain('人工审批');
      expect(phaseFrame).not.toContain('人工审批队列');
      expect(phaseFrame).not.toContain('Working');

      await waitForText(
        () => tui.outputSinceLastAction(),
        'Automatic sub-agent review completed successfully.',
        TIMEOUT,
      );

      const completed = tui.viewport();
      expect(screenContains(completed, 'Automatic sub-agent review completed successfully.')).toBe(
        true,
      );
      // Auto review is an internal decision and may settle between PTY frames;
      // the durable reviewer request above plus this completed child result are
      // the stable evidence. It must never become a human approval prompt.
      expect(screenContains(completed, '工具授权')).toBe(false);
      expect(screenContains(completed, '人工审批队列')).toBe(false);
      expect(screenContains(completed, '❯')).toBe(true);
      expect(existsSync(externalFile)).toBe(true);
      expect(readFileSync(externalFile, 'utf8')).toContain('auto review succeeded');
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Sub-agent Read File Flow', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Write a file inside the workspace so the sub-agent can read it
    writeFileSync(join(workspace.workspace, 'data.txt'), 'hello from workspace\nline 2');

    // Response #1: Main agent dispatches an explore sub-agent for the read-only task
    // Response #2: Sub-agent reads data.txt with absolute path (should succeed, no approval)
    // Response #3: Sub-agent reports result
    // Response #4: Main agent final response
    server.setResponses([
      {
        message: {
          content: 'I will dispatch a sub-agent to read a file.',
          tool_calls: [
            {
              id: 'call_spawn_reader',
              name: 'task',
              args: {
                name: 'Read workspace data file',
                subagent_type: 'explore',
                task: `Read the file at ${join(workspace.workspace, 'data.txt')} using its absolute path. Report the content.`,
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will read the file.',
          tool_calls: [
            {
              id: 'call_subagent_read',
              name: 'read_file',
              args: { path: join(workspace.workspace, 'data.txt') },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_subagent_read', contentIncludes: ['hello from workspace'] },
          ],
        },
        message: { content: 'File content: hello from workspace.' },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_spawn_reader', contentIncludes: ['hello from workspace'] },
          ],
        },
        message: { content: 'Sub-agent read completed successfully.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'sub-agent read_file with absolute path inside workspace succeeds without approval',
    async () => {
      await submitUserMessage(tui, server, 'Use an explore subagent to inspect data.txt', {
        timeout: 15000,
      });

      // Wait for sub-agent to complete — read should NOT trigger approval
      try {
        await waitForText(
          () => tui.outputSinceLastAction(),
          'Sub-agent read completed successfully.',
          TIMEOUT - 5000,
        );
      } catch (error) {
        console.log('  output after read timeout:', stripAnsi(tui.viewport()).slice(-4000));
        console.log(
          '  model requests after read timeout:',
          server.getRequests().map((request) => request.messages.at(-1)),
        );
        throw error;
      }

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after read:', clean.slice(-2000));

      // Sub-agent should have completed without cancellation
      expect(screenContains(output, 'Sub-agent read completed successfully.')).toBe(true);
      // No approval dialog should have appeared
      expect(screenContains(output, '工具授权')).toBe(false);
      // TUI prompt should be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Sub-agent Multi-round Natural Summary', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let summaryRetainedReadCapability = false;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    const evidenceFiles = Array.from({ length: EXPLORATION_FIXTURE_READS }, (_, index) => {
      const filename = `bounded-evidence-${index + 1}.txt`;
      writeFileSync(join(workspace.workspace, filename), `evidence ${index + 1}\n`);
      return filename;
    });
    server.setResponses([
      {
        message: {
          content: 'I will delegate a bounded exploration.',
          tool_calls: [
            {
              id: 'call_bounded_explore',
              name: 'task',
              args: {
                name: 'Bounded exploration',
                subagent_type: 'explore',
                task: 'Read the available evidence and report a concise result.',
              },
            },
          ],
        },
      },
      ...evidenceFiles.map((filename, index) => ({
        ...(index === 0
          ? {}
          : {
              expectedRequest: {
                toolResults: [{ toolCallId: `call_bounded_read_${index}` }],
              },
            }),
        message: {
          tool_calls: [
            {
              id: `call_bounded_read_${index + 1}`,
              name: 'read_file',
              args: { path: filename },
            },
          ],
        },
      })),
      {
        response: (request) => {
          const tools = request.body.tools;
          summaryRetainedReadCapability =
            Array.isArray(tools) &&
            tools.some(
              (tool) =>
                tool &&
                typeof tool === 'object' &&
                tool.function &&
                typeof tool.function === 'object' &&
                tool.function.name === 'files.read',
            );
          return {
            expectedRequest: {
              toolResults: [{ toolCallId: `call_bounded_read_${EXPLORATION_FIXTURE_READS}` }],
            },
            message: { content: 'BOUNDED_CHILD_FINAL\n第二项发现\n- multiline child result' },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_bounded_explore',
              contentIncludes: ['BOUNDED_CHILD_FINAL', '第二项发现', 'multiline child result'],
            },
          ],
        },
        message: { content: 'BOUNDED_PARENT_FINAL' },
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'retains read capability through the original complete workload and lets the child naturally summarize before the parent completes',
    async () => {
      await submitUserMessage(tui, server, 'Run a bounded explore child', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'BOUNDED_PARENT_FINAL', TIMEOUT);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      const output = stripAnsi(tui.scrollback());
      expect(summaryRetainedReadCapability).toBe(true);
      expect(server.getRequestCount()).toBe(EXPLORATION_FIXTURE_READS + 3);
      expect(output).toContain('BOUNDED_PARENT_FINAL');
      expect(output).not.toContain('Working');
      expect(output).not.toContain('Cancellation was not accepted');
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Concurrent Sub-agent Aggregation', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'I will inspect two independent areas concurrently.',
          tool_calls: [
            {
              id: 'call_parallel_runtime',
              name: 'task',
              args: {
                name: 'Inspect runtime packages',
                subagent_type: 'explore',
                task: 'Inspect the runtime package layout and report a short summary.',
              },
            },
            {
              id: 'call_parallel_tests',
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
      { delay: 1_000, message: { content: 'Runtime package inspection complete.' } },
      { delay: 1_000, message: { content: 'Test layout inspection complete.' } },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_parallel_runtime',
              contentIncludes: ['inspection complete'],
            },
            {
              toolCallId: 'call_parallel_tests',
              contentIncludes: ['inspection complete'],
            },
          ],
        },
        message: { content: 'Concurrent delegation completed.' },
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps concurrently dispatched children in one stable card without duplicate React keys',
    async () => {
      await submitUserMessage(tui, server, 'Inspect runtime and tests with parallel subagents', {
        timeout: 15_000,
      });
      await waitForText(() => tui.outputSinceLastAction(), 'Delegating · 2 agents', TIMEOUT);

      const active = stripAnsi(tui.viewport());
      expect(active).toContain('Explore · Inspect runtime packages');
      expect(active).toContain('Explore · Inspect test layout');
      expect(active).not.toContain('Encountered two children with the same key');

      await waitForText(
        () => tui.outputSinceLastAction(),
        'Concurrent delegation completed.',
        TIMEOUT,
      );
      const completed = stripAnsi(tui.viewport());
      expect(completed).toContain('Delegated · 2 agents · 2 succeeded');
      expect(completed.match(/Delegated · 2 agents/g)).toHaveLength(1);
      expect(completed).not.toContain('Encountered two children with the same key');
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Concurrent Sub-agent Cancellation Queue', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    const childStarts = new Set<number>();
    let searchContinued = false;
    // Concurrent child requests and the search continuation have no global order.
    // Bind the original response to its actual user task/result, not its queue slot.
    const childResponse = (request: MockChatRequest): MockResponse => {
      const result = request.messages.filter(
        (message) => message.role === 'tool' && message.tool_call_id === 'call_cancel_empty_search',
      );
      if (result.length) {
        if (result.length !== 1 || !childStarts.has(1) || searchContinued)
          throw Error('original cancellation search continuation identity mismatch');
        searchContinued = true;
        return {
          expectedRequest: { toolResults: [{ toolCallId: 'call_cancel_empty_search' }] },
          delay: 5_000,
          message: { content: 'Cancellation area 1 inspection complete.' },
        };
      }
      const user = request.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n');
      const matches = [1, 2, 3, 4].filter((area) =>
        user.includes(`Inspect cancellation area ${area} and report a short summary.`),
      );
      if (matches.length !== 1 || childStarts.has(matches[0]!))
        throw Error('original cancellation child task identity mismatch');
      const area = matches[0]!;
      childStarts.add(area);
      return area === 1
        ? {
            message: {
              tool_calls: [
                {
                  id: 'call_cancel_empty_search',
                  name: 'search_content',
                  args: { pattern: 'KITE_EMPTY_SUBAGENT_CANCEL_SENTINEL_7D7C', path: '.' },
                },
              ],
            },
          }
        : { delay: 5_000, message: { content: `Cancellation area ${area} inspection complete.` } };
    };
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will inspect four areas concurrently.',
          tool_calls: Array.from({ length: 4 }, (_, index) => ({
            id: `call_cancel_child_${index + 1}`,
            name: 'task',
            args: {
              name: `Inspect cancellation area ${index + 1}`,
              subagent_type: 'explore',
              task: `Inspect cancellation area ${index + 1} and report a short summary.`,
            },
          })),
        },
      },
      ...Array.from({ length: 5 }, () => ({ response: childResponse })),
      { message: { content: 'Queued successor completed after child cleanup.' } },
    ]);
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'four-subagents-tui.tsx'),
    });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps child identities visible and admits a queued successor only after cancellation cleanup',
    async () => {
      await submitUserMessage(tui, server, 'Start four cancellable subagents', {
        timeout: 15_000,
      });
      await waitForText(() => tui.outputSinceLastAction(), 'Delegating · 4 agents', TIMEOUT);
      await waitForCondition(
        () => server.getRequestCount() === 6,
        'an empty child search result to reach the next model request',
        TIMEOUT,
      );
      await waitForText(() => tui.viewport(), 'Search .', TIMEOUT);
      await tui.settleScreen();
      expect(stripAnsi(tui.scrollback())).not.toContain('Invalid AcceptedPresentationEnvelope');
      const active = stripAnsi(tui.viewport());
      for (let index = 1; index <= 4; index += 1) {
        expect(active).toContain(`Explore · Inspect cancellation area ${index}`);
      }
      const activeGroupStart = active.indexOf('Delegating · 4 agents');
      const activeGroupEnd = active.indexOf('\n\n', activeGroupStart);
      const activeGroup = active
        .slice(activeGroupStart, activeGroupEnd < 0 ? undefined : activeGroupEnd)
        .replace(/\d+s/g, '<elapsed>');

      const queued = await submitUserMessageForDeferredDelivery(
        tui,
        server,
        'Run after cancellation cleanup',
        {
          acceptWhen: (viewport) => screenContains(viewport, '↵ Run after cancellation cleanup'),
          timeout: 15_000,
        },
      );
      expect(
        server.hasRequestMessage('Run after cancellation cleanup', queued.requestBaseline),
      ).toBe(false);
      const queuedViewport = stripAnsi(tui.viewport());
      const queuedGroupStart = queuedViewport.indexOf('Delegating · 4 agents');
      const queuedGroupEnd = queuedViewport.indexOf('\n\n', queuedGroupStart);
      const queuedGroup = queuedViewport
        .slice(queuedGroupStart, queuedGroupEnd < 0 ? undefined : queuedGroupEnd)
        .replace(/\d+s/g, '<elapsed>');
      expect(queuedGroup).toBe(activeGroup);

      const cancelStartedAt = Date.now();
      const cancellationFrames = tui.markScreen();
      tui.write('\x1b');
      await waitForCondition(
        () =>
          tui
            .screenFramesSince(cancellationFrames)
            .some((frame) => screenContains(frame, 'Cancelling')),
        'visible cancellation acknowledgement before authoritative terminal',
        1_000,
      );
      expect(Date.now() - cancelStartedAt).toBeLessThan(1_000);
      // Repeated keys must coalesce onto the same in-flight Runtime command.
      tui.write('\x1b');
      tui.write('\x1b');

      await waitForCondition(
        () =>
          server
            .getRequests()
            .slice(queued.requestBaseline)
            .some((request) =>
              request.messages.some(
                (message) =>
                  message.role === 'user' && message.content === 'Run after cancellation cleanup',
              ),
            ),
        'queued successor model request after subagent cleanup',
        TIMEOUT,
      );
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Queued successor completed after child cleanup.',
        TIMEOUT,
      );

      const output = stripAnsi(tui.scrollback());
      expect(output).not.toContain('Task could not continue: Internal error');
      expect(output).not.toContain('Cancellation was not accepted');
      expect(output).not.toContain('Invalid AcceptedPresentationEnvelope');
      const successorPromptCount = output.split('Run after cancellation cleanup').length - 1;
      if (successorPromptCount !== 1) {
        throw new Error(
          `expected one visible successor prompt, found ${successorPromptCount}:\n${output}`,
        );
      }
      const persisted = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, 'Start four cancellable subagents'),
      );
      if (!persisted) throw new Error('Expected the cancelled predecessor turn.');
      const database = new Database(workspace.databasePath, { readonly: true });
      try {
        // The new Runtime's scoped terminal receipts replace retired synthetic cleanup
        // events: all four original parent calls must own a stopped child carrier.
        const carriers = database
          .query<
            {
              id: string;
              call_id: string;
              child_session_id: string;
              state: string;
              completed_cursor: number;
              result_json: string;
            },
            [string, string]
          >(`
        SELECT c.id,p.call_id,c.child_session_id,c.state,c.completed_cursor,c.result_json
        FROM execution c JOIN execution p ON c.parent_execution_id=p.id
        WHERE p.run_id=? AND p.session_id=? AND c.kind='job'
          AND p.call_id IN ('call_cancel_child_1','call_cancel_child_2',
                           'call_cancel_child_3','call_cancel_child_4')
          AND c.root_work_command_id=p.root_work_command_id
          AND c.root_work_seq=p.root_work_seq
          AND c.origin_store_id=p.origin_store_id
          AND c.root_session_id=p.root_session_id
      `)
          .all(persisted.turnId, persisted.threadId);
        expect(carriers).toHaveLength(4);
        expect(new Set(carriers.map((carrier) => carrier.call_id)).size).toBe(4);
        for (const carrier of carriers) {
          expect(carrier.state).toBe('cancelled');
          expect(carrier.completed_cursor).toBeGreaterThan(0);
          const result = JSON.parse(carrier.result_json);
          expect(result).toMatchObject({
            outcome: 'cancelled',
            details: { childSessionId: carrier.child_session_id, status: 'cancelled' },
          });
          const child = database
            .query<{ status: string; is_active: number }, [string, string]>(
              'SELECT status,is_active FROM run WHERE id=? AND session_id=?',
            )
            .get(result.details.runId, carrier.child_session_id);
          expect(child).toEqual({ status: 'cancelled', is_active: 0 });
        }
        const successor = database
          .query<{ cursor: number }, [string, string]>(`
        SELECT e.cursor FROM message m JOIN message_part p ON p.message_id=m.id
        JOIN change_event e ON e.object_id=m.id AND e.scope_session_id=m.session_id
        WHERE m.role='user' AND m.session_id=? AND p.ordinal=0
          AND json_extract(p.json,'$.content')=? AND e.type='message.updated'
        ORDER BY e.cursor LIMIT 1
      `)
          .get(persisted.threadId, 'Run after cancellation cleanup');
        expect(successor?.cursor).toBeGreaterThan(
          Math.max(...carriers.map((carrier) => carrier.completed_cursor)),
        );
        const unknown = database
          .query<{ total: number }, [string]>(
            "SELECT count(*) AS total FROM execution WHERE root_work_command_id=(SELECT root_work_command_id FROM run WHERE id=?) AND state='outcome_unknown'",
          )
          .get(persisted.turnId);
        expect(unknown?.total).toBe(0);
      } finally {
        database.close();
      }
    },
    TIMEOUT,
  );
});
