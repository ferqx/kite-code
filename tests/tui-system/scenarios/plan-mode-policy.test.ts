/**
 * PTY System Test — Plan Mode policy boundary
 *
 * Covers the full TUI → session runtime → core runner → tool policy chain for
 * a planning-mode plain prompt. The mock model deliberately attempts a
 * write_file call. V2 keeps the declaration stable, while Runtime policy
 * returns a phase-constraint result before any approval or filesystem mutation
 * can happen. Because that rejected Tool is an unresolved completion blocker,
 * the scenario cancels review instead of pretending the Plan can complete,
 * then explicitly exits Plan Mode before exercising the next clean lifecycle.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, parseDraftSavedPlan } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  type PersistedTurnEvent,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Plan Mode Policy Boundary', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let planningShellResult: 'workspace' | 'sandbox_exec_denied' | 'sandbox_unavailable' | undefined;

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
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_plan_write_denied',
              contentIncludes: ['Plan mode is read-only', 'No file was written'],
            },
          ],
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
                body_markdown:
                  'Record the planning write denial and complete this validation safely.',
                steps: [{ id: 'validate-denial', title: 'Validate planning write denial' }],
              },
            },
          ],
        },
      },
      planSubmitResponse('call_plan_save_denial', 'call_plan_submit_denial'),
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_plan_submit_denial',
              contentIncludes: ['Plan execution confirmation cancelled by user.'],
            },
          ],
        },
        message: {
          content: 'I will validate the plan.',
          tool_calls: [
            {
              id: 'call_plan_baseline_shell',
              name: 'shell_execute',
              args: {
                command: 'pwd && ls -la',
                description: 'Inspect the workspace inside the planning baseline',
              },
            },
          ],
        },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) =>
              message.role === 'tool' && message.tool_call_id === 'call_plan_baseline_shell',
          );
          const content = String(result?.content ?? '');
          if (content.includes(workspace.workspace)) {
            planningShellResult = 'workspace';
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'call_plan_baseline_shell',
                    contentIncludes: [workspace.workspace],
                  },
                ],
              },
              // The test consumes the real Tool result below and cancels the
              // turn before a completion-policy retry can ask the model for
              // another response.
              delay: 5_000,
              message: { content: 'Validated commands inside the planning read-only baseline.' },
            };
          }
          if (content.includes('sandbox-exec') && content.includes('Operation not permitted')) {
            planningShellResult = 'sandbox_exec_denied';
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'call_plan_baseline_shell',
                    contentIncludes: ['sandbox-exec', 'Operation not permitted'],
                    contentExcludes: [workspace.workspace],
                  },
                ],
              },
              // A sandbox-exec denial is terminal for this Tool result. The
              // test cancels before any completion-policy retry can invite an
              // unsafe recovery or a second model turn.
              delay: 5_000,
              message: { content: 'Sandbox execution was blocked.' },
            };
          }
          if (content.includes('This capability requires an available workspace sandbox.')) {
            planningShellResult = 'sandbox_unavailable';
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: 'call_plan_baseline_shell',
                    contentIncludes: ['This capability requires an available workspace sandbox.'],
                  },
                ],
              },
              delay: 5_000,
              message: {
                content: 'Planning baseline failed closed without an available workspace sandbox.',
              },
            };
          }
          throw new Error(
            'Planning shell result was neither workspace success nor a fail-closed denial.',
          );
        },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step(
    'Shift+Tab plan mode applies to a plain conversation and denies write_file',
    async () => {
      const task = 'Create plan-created.txt during planning';
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab 退出计划模式', 5000);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, server, task, { timeout: 15000 });

      await waitForText(() => tui.viewport(), 'Planning write attempt was blocked.', 15000);

      const output = tui.viewport();

      // A tool rejected before `tool.started` must not invent an execution
      // card. The durable event and model follow-up prove the rejection.
      expect(screenContains(output, 'Tool execution rejected.')).toBe(false);
      await waitForCondition(
        () => {
          const observation = observePersistedTurnEvents(workspace, task);
          if (observation.status !== 'ready' || !observation.value) return false;
          return observation.value.events.some(
            (event) =>
              event.type === 'tool.rejected' &&
              event.toolCallId === 'call_plan_write_denied' &&
              typeof event.failure === 'object' &&
              event.failure !== null &&
              'kind' in event.failure &&
              event.failure.kind === 'phase_denied',
          );
        },
        'durable planning-phase write denial',
        15_000,
      );
      const renderedFrames = tui.screenFramesSince(conversationFrames).join('\n');
      expect(screenContains(renderedFrames, 'Write (plan-created.txt)')).toBe(false);
      expect(screenContains(output, 'Planning write attempt was blocked.')).toBe(true);
      expect(screenContains(renderedFrames, '工具授权')).toBe(false);
      expect(existsSync(join(workspace.workspace, 'plan-created.txt'))).toBe(false);
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\x1b');
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'Shift+Tab 退出计划模式') &&
          !screenContains(tui.viewport(), '方案审核'),
        'cancelled review returns to the Plan Mode prompt',
        15_000,
      );
      tui.write('\x1b[Z');
    },
    TIMEOUT,
  );

  step(
    'cancelled blocked plan can explicitly return the TUI to building mode',
    async () => {
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          !screenContains(tui.viewport(), 'Shift+Tab 退出计划模式'),
        'building footer after the completed plan',
        5_000,
      );
    },
    TIMEOUT,
  );

  step(
    'planning Shell baseline validates its actual sandbox execution result',
    async () => {
      const task = 'Plan the runtime validation commands';
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab 退出计划模式', 5000);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, server, task, { timeout: 15000 });
      await waitForCondition(
        () => planningShellResult !== undefined,
        'model receipt for the planning shell result',
        15_000,
        25,
      );

      // The mock records the actual Tool outcome before responding. Stop this
      // policy probe at that boundary: it must neither wait for nor authorize
      // a model completion/recovery after a sandbox denial.
      const modelRequestsAtShellResult = server.getRequestCount();
      tui.write('\x03');
      await waitForText(() => tui.viewport(), 'Cancelled', 5_000);
      expect(server.getRequestCount()).toBe(modelRequestsAtShellResult);

      const output = tui.screenFramesSince(conversationFrames).join('\n');
      expect(screenContains(output, 'Deferred until execution')).toBe(false);
      if (planningShellResult === 'workspace') {
        expect(screenContains(output, 'Bash')).toBe(true);
        expect(
          screenContains(output, 'This capability requires an available workspace sandbox.'),
        ).toBe(false);
      } else {
        // The result contract above proves no host-shell fallback produced the
        // workspace path. Local presentation now retains the bounded concrete
        // sandbox diagnostic so the user can diagnose the failure directly.
        expect(screenContains(output, 'Sandbox execution was blocked.')).toBe(false);
        expect(screenContains(output, 'Operation not permitted')).toBe(true);
        expect(screenContains(output, 'sandbox-exec')).toBe(true);
        let persistedEvents: PersistedTurnEvent[] | undefined;
        await waitForCondition(
          () => {
            const observation = observePersistedTurnEvents(workspace, task);
            if (observation.status !== 'ready' || !observation.value) return false;
            const terminal = observation.value.events.find(
              (event) =>
                (event.type === 'tool.finished' ||
                  event.type === 'tool.failed' ||
                  event.type === 'tool.rejected') &&
                event.toolCallId === 'call_plan_baseline_shell' &&
                (planningShellResult === 'sandbox_exec_denied' ||
                  (typeof event.failure === 'object' &&
                    event.failure !== null &&
                    'kind' in event.failure &&
                    event.failure.kind === 'mandatory_policy_unavailable')),
            );
            if (!terminal) return false;
            persistedEvents = observation.value.events;
            return true;
          },
          'Runtime Store to persist the fail-closed planning shell result',
          20_000,
        );
        if (!persistedEvents) throw new Error('Persisted planning denial observation was lost.');
        if (planningShellResult === 'sandbox_unavailable') {
          expect(
            persistedEvents.some(
              (event) =>
                event.type === 'capability.invocation_recorded' &&
                event.toolCallId === 'call_plan_baseline_shell',
            ),
          ).toBe(false);
          expect(
            persistedEvents.some(
              (event) => event.type === 'capability.sandbox_execution_dispatch_intent_recorded',
            ),
          ).toBe(false);
        } else {
          expect(
            persistedEvents.some(
              (event) => event.type === 'capability.sandbox_execution_dispatch_intent_recorded',
            ),
          ).toBe(true);
        }
      }
      expect(screenContains(output, 'Rejected shell_execute during planning phase')).toBe(false);
      expect(screenContains(output, "Tool 'shell_execute' is not available in this context")).toBe(
        false,
      );
      expect(screenContains(output, '工具授权')).toBe(false);
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
          toolResults: [{ toolCallId: saveCallId, contentIncludes: ['draft_saved'] }],
        },
        toolContinuation: 'aborted' as const,
        message: {
          tool_calls: [
            {
              id: submitCallId,
              name: 'write_plan',
              args: { action: 'submit', plan_id, version, structural_digest },
            },
          ],
        },
      };
    },
  };
}
