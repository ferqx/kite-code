/**
 * Original Plan Mode policy journey, migrated to the current Core contract.
 * Before review, exact readonly metadata is allowed; Full does not permit
 * writes, Shell Jobs, or child tasks. No legacy sandbox dispatch/event is
 * treated as proof. Single-use planning does not persist as a Session mode.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, parseDraftSavedPlan } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedTurnEvents } from '../harness/test-workspace';

const TIMEOUT = 30000;
const firstTask = 'Create plan-created.txt during planning';
const readonlyTask = 'Plan the runtime validation commands';

describe('TUI PTY System — Plan Mode Policy Boundary', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let readonlyReceipt = false;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: { 'planning-baseline.txt': 'Exact readonly baseline.\n' },
      configOverrides: { interactionMode: 'full' },
    });
    server.setResponses([
      {
        message: {
          content: 'I will try effects during planning.',
          tool_calls: [
            {
              id: 'call_plan_write_denied',
              name: 'write_file',
              args: {
                path: 'plan-created.txt',
                content: 'This file must not be created from planning mode.',
              },
            },
            { id: 'call_plan_shell_denied', name: 'shell_execute', args: { command: 'pwd' } },
            {
              id: 'call_plan_child_denied',
              name: 'spawn_agent',
              args: {
                task_name: 'Forbidden planning child',
                preset: 'code',
                prompt: 'Do not start before approval.',
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: ['write', 'shell', 'child'].map((kind) => ({
            toolCallId: `call_plan_${kind}_denied`,
            contentIncludes: ['Plan mode is read-only', 'not dispatched'],
          })),
        },
        message: {
          content: 'Planning write attempt was blocked.',
          tool_calls: [
            {
              id: 'call_plan_save_denial',
              name: 'write_plan',
              args: {
                action: 'save',
                title: 'Plan-safe write validation',
                body_markdown: 'Record the planning effect denials safely.',
                steps: [{ id: 'validate-denial', title: 'Validate planning write denial' }],
              },
            },
          ],
        },
      },
      planSubmitResponse('call_plan_save_denial', 'call_plan_submit_denial'),
      { message: { content: 'Ordinary follow-up recovered without inheriting a plan.' } },
      {
        message: {
          tool_calls: [
            {
              id: 'call_plan_baseline_readonly',
              name: 'files.list',
              args: { limit: 100 },
            },
          ],
        },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) =>
              message.role === 'tool' && message.tool_call_id === 'call_plan_baseline_readonly',
          );
          if (!String(result?.content).includes('planning-baseline.txt'))
            throw Error('planning_readonly_actual_baseline_missing');
          readonlyReceipt = true;
          return {
            expectedRequest: {
              toolResults: [
                {
                  toolCallId: 'call_plan_baseline_readonly',
                  contentIncludes: ['planning-baseline.txt'],
                },
              ],
            },
            delay: 5_000,
            message: { content: 'Validated actual readonly metadata during planning.' },
          };
        },
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });
  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  async function observedRun(task: string, status?: string) {
    let identity: { threadId: string; turnId: string } | undefined;
    await waitForCondition(
      () => {
        const observation = observePersistedTurnEvents(workspace, task);
        if (observation.status !== 'ready' || !observation.value) return false;
        if (
          status &&
          !observation.value.events.some(
            (event) => event.type === 'run.finished' && event.status === status,
          )
        )
          return false;
        identity = observation.value;
        return true;
      },
      `actual Core Run ${status ?? 'identity'} for ${task}`,
      15_000,
    );
    if (!identity) throw Error('planning_run_source_missing');
    return identity;
  }
  function assertNoEffectDispatch(runId: string) {
    using db = new Database(workspace.databasePath, { readonly: true });
    expect(
      db.query("SELECT id FROM execution WHERE run_id=? AND kind='job'").all(runId),
    ).toHaveLength(0);
    expect(
      db
        .query('SELECT id FROM execution WHERE run_id=? AND child_session_id IS NOT NULL')
        .all(runId),
    ).toHaveLength(0);
    expect(
      db.query("SELECT id FROM interaction WHERE run_id=? AND kind='approval'").all(runId),
    ).toHaveLength(0);
    expect(existsSync(join(workspace.workspace, 'plan-created.txt'))).toBe(false);
  }

  step(
    'Shift+Tab plan mode applies to a plain conversation and denies write_file',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab 退出计划模式', 5000);
      const frames = tui.markScreen();
      await submitUserMessage(tui, server, firstTask, { timeout: 15000 });
      await waitForText(() => tui.viewport(), 'Planning write attempt was blocked.', 15000);
      await waitForText(() => tui.viewport(), '方案审核', 15000);
      const identity = await observedRun(firstTask);
      using db = new Database(workspace.databasePath, { readonly: true });
      for (const [callId, adapterId] of [
        ['call_plan_write_denied', 'files.write'],
        ['call_plan_shell_denied', 'shell.execute'],
        ['call_plan_child_denied', 'task.spawn'],
      ]) {
        const actual = db
          .query<
            { state: string; dispatched: number; result_json: string },
            [string, string, string]
          >(
            'SELECT state,dispatched,result_json FROM execution WHERE run_id=? AND call_id=? AND adapter_id=?',
          )
          .get(identity.turnId, callId!, adapterId!);
        expect(actual).toBeDefined();
        expect(actual!.state).toBe('failed');
        expect(actual!.dispatched).toBe(0);
        const result = JSON.parse(actual!.result_json);
        expect(result.content).toContain('Plan mode is read-only');
        expect(result.details.reason).toBe('plan_approval_required');
        expect(result.details.dispatchCommitted).toBe(false);
        expect(result.details.adapterAttempted).toBe(false);
      }
      const rendered = tui.screenFramesSince(frames).join('\n');
      // Current Core records a real failed Execution before dispatch; its card must
      // retain that refusal, without presenting a successful file effect.
      expect(screenContains(rendered, 'Write (plan-created.txt)')).toBe(true);
      expect(screenContains(rendered, 'Plan mode is read-only')).toBe(true);
      expect(screenContains(rendered, 'Workspace file changed.')).toBe(false);
      expect(screenContains(rendered, '工具授权')).toBe(false);
      assertNoEffectDispatch(identity.turnId);
      // Cancel the real active Run, rather than treating a review denial as a Session toggle.
      tui.write('\x03');
      await observedRun(firstTask, 'cancelled');
      await waitForTuiReady(tui);
      expect(screenContains(tui.viewport(), '方案审核')).toBe(false);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
      assertNoEffectDispatch(identity.turnId);
    },
    TIMEOUT,
  );

  step(
    'cancelled blocked plan returns the next TUI input to ordinary work',
    async () => {
      expect(screenContains(tui.viewport(), 'Shift+Tab 退出计划模式')).toBe(false);
      const task = 'Continue after the cancelled plan';
      await submitUserMessage(tui, server, task, { timeout: 15000 });
      await waitForText(() => tui.viewport(), 'Ordinary follow-up recovered', 15000);
      const identity = await observedRun(task, 'completed');
      assertNoEffectDispatch(identity.turnId);
      await waitForTuiReady(tui);
      expect(screenContains(tui.viewport(), 'mock-model')).toBe(true);
      expect(screenContains(tui.viewport(), 'Shift+Tab 退出计划模式')).toBe(false);
    },
    TIMEOUT,
  );

  step(
    'planning readonly baseline validates its actual result without Job dispatch',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab 退出计划模式', 5000);
      const frames = tui.markScreen();
      await submitUserMessage(tui, server, readonlyTask, { timeout: 15000 });
      await waitForCondition(
        () => readonlyReceipt,
        'actual planning readonly Model receipt',
        15000,
        25,
      );
      const identity = await observedRun(readonlyTask);
      using db = new Database(workspace.databasePath, { readonly: true });
      const actual = db
        .query<{ state: string; dispatched: number; result_json: string }, [string]>(
          "SELECT state,dispatched,result_json FROM execution WHERE run_id=? AND call_id='call_plan_baseline_readonly' AND adapter_id='files.list'",
        )
        .get(identity.turnId);
      expect(actual).toBeDefined();
      expect(actual!.state).toBe('succeeded');
      expect(actual!.dispatched).toBe(1);
      expect(actual!.result_json).toContain('planning-baseline.txt');
      const result = JSON.parse(actual!.result_json);
      expect(result.outcome).toBe('succeeded');
      expect(JSON.parse(result.content).entries).toContainEqual({
        name: 'planning-baseline.txt',
        kind: 'file',
      });
      const modelRequestsAtResult = server.getWorkRequestCount();
      tui.write('\x03');
      await observedRun(readonlyTask, 'cancelled');
      await waitForText(() => tui.viewport(), 'Cancelled', 5000);
      expect(server.getWorkRequestCount()).toBe(modelRequestsAtResult);
      const output = tui.screenFramesSince(frames).join('\n');
      expect(screenContains(output, 'Deferred until execution')).toBe(false);
      expect(screenContains(output, '工具授权')).toBe(false);
      // Readonly exploration is an aggregate on the main screen. Its original
      // directory entries remain readable through the ordinary execution panel.
      await waitForTuiReady(tui);
      tui.write('\x05');
      await waitForText(() => tui.viewport(), 'files.list', 5000);
      await waitForText(
        () => tui.viewport().replace(/\s*\n\s*/g, ''),
        'planning-baseline.txt',
        5000,
      );
      expect(server.getWorkRequestCount()).toBe(modelRequestsAtResult);
      tui.write('\x1b');
      await waitForTuiReady(tui);
      assertNoEffectDispatch(identity.turnId);
    },
    TIMEOUT,
  );
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

function planSubmitResponse(saveCallId: string, submitCallId: string) {
  return {
    response(request: {
      messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
    }) {
      const result = request.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === saveCallId,
      );
      const { plan_id, version, structural_digest } = parseDraftSavedPlan(result?.content);
      return {
        expectedRequest: {
          toolResults: [{ toolCallId: saveCallId, contentIncludes: ['"planId"'] }],
        },
        toolContinuation: 'aborted' as const,
        message: {
          tool_calls: [
            {
              id: submitCallId,
              name: 'write_plan',
              args: {
                action: 'submit',
                plan_id,
                version,
                structural_digest,
              },
            },
          ],
        },
      };
    },
  };
}
