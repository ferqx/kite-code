/**
 * PTY System Test — Plan Mode policy boundary
 *
 * Covers the full TUI → session runtime → core runner → tool policy chain for
 * a planning-mode plain prompt. The mock model deliberately attempts a
 * write_file call. In real Plan Mode, the TUI must pass initialPhase=planning
 * to core so the write is rejected before any approval or filesystem mutation
 * can happen. The scenario then completes the real Plan lifecycle and verifies
 * that the TUI returns to building mode.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Plan Mode Policy Boundary', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
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
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_plan_write_denied', contentIncludes: ['Plan mode is read-only'] },
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
      planCompleteResponse('call_plan_submit_denial', 'call_plan_complete_denial', [
        'validate-denial',
      ]),
      planFinalResponse('call_plan_complete_denial', 'Planning write validation completed.'),
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
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_plan_typecheck_deferred',
              contentIncludes: ['"deferred":true', '"until_phase":"building"'],
            },
            {
              toolCallId: 'call_plan_tests_deferred',
              contentIncludes: ['"deferred":true', '"until_phase":"building"'],
            },
          ],
        },
        message: {
          content: 'Recorded validation commands for the execution phase.',
          tool_calls: [
            {
              id: 'call_plan_save_shell',
              name: 'write_plan',
              args: {
                action: 'save',
                title: 'Plan-safe shell validation',
                body_markdown:
                  'Record deferred planning validation commands and complete the plan lifecycle.',
                steps: [{ id: 'validate-shell', title: 'Validate planning shell policy' }],
              },
            },
          ],
        },
      },
      planSubmitResponse('call_plan_save_shell', 'call_plan_submit_shell'),
      planCompleteResponse('call_plan_submit_shell', 'call_plan_complete_shell', [
        'validate-shell',
      ]),
      planFinalResponse('call_plan_complete_shell', 'Planning shell validation completed.'),
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
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab to exit', 5000);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, server, task, { timeout: 15000 });

      await waitForText(() => tui.viewport(), 'Planning write attempt was blocked.', 15000);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after planning write denial:', clean.slice(-1500));

      expect(
        screenContains(
          output,
          'Plan mode is read-only. No file was written. Describe the intended change in the plan and apply it after plan approval.',
        ),
      ).toBe(true);
      const renderedFrames = tui.screenFramesSince(conversationFrames).join('\n');
      expect(screenContains(renderedFrames, 'Write (plan-created.txt)')).toBe(false);
      expect(screenContains(output, 'Planning write attempt was blocked.')).toBe(true);
      expect(screenContains(renderedFrames, '工具授权')).toBe(false);
      expect(existsSync(join(workspace.workspace, 'plan-created.txt'))).toBe(false);
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Planning write validation completed.', 15_000);
    },
    TIMEOUT,
  );

  step(
    'completed plan returns the TUI to building mode',
    async () => {
      await waitForCondition(
        () =>
          screenContains(tui.viewport(), 'mock-model') &&
          !screenContains(tui.viewport(), 'Shift+Tab to exit'),
        'building footer after the completed plan',
        5_000,
      );
    },
    TIMEOUT,
  );

  step(
    'planning shell validation stays internal without approval or message cards',
    async () => {
      const task = 'Plan the runtime validation commands';
      tui.write('\x1b[Z');
      await waitForText(() => tui.outputSinceLastAction(), 'Shift+Tab to exit', 5000);
      const conversationFrames = tui.markScreen();
      await submitUserMessage(tui, server, task, { timeout: 15000 });
      await waitForText(
        () => tui.viewport(),
        'Recorded validation commands for the execution phase.',
        15000,
      );
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Planning shell validation completed.', 15_000);

      const output = tui.screenFramesSince(conversationFrames).join('\n');
      expect(screenContains(output, 'Deferred until execution')).toBe(false);
      expect(screenContains(output, 'bun run typecheck')).toBe(false);
      expect(screenContains(output, 'bun test tests/runtime')).toBe(false);
      expect(screenContains(output, 'Rejected shell_execute during planning phase')).toBe(false);
      expect(screenContains(output, 'Bash Ran:')).toBe(false);
      expect(screenContains(output, '工具授权')).toBe(false);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run());
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

function parseDraftSavedPlan(content: unknown): {
  plan_id: string;
  version: number;
  structural_digest: string;
} {
  const value: unknown = JSON.parse(String(content));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('plan_id' in value) ||
    typeof value.plan_id !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('structural_digest' in value) ||
    typeof value.structural_digest !== 'string'
  ) {
    throw new Error('write_plan draft_saved result did not contain a valid plan identity');
  }
  return {
    plan_id: value.plan_id,
    version: value.version,
    structural_digest: value.structural_digest,
  };
}

function planCompleteResponse(submitCallId: string, completeCallId: string, stepIds: string[]) {
  return {
    response(request: {
      messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
    }) {
      const result = request.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === submitCallId,
      );
      const plan = JSON.parse(String(result?.content)) as { plan_id: string };
      return {
        expectedRequest: {
          toolResults: [{ toolCallId: submitCallId, contentIncludes: ['"status":"approved"'] }],
        },
        message: {
          tool_calls: [
            {
              id: completeCallId,
              name: 'update_plan',
              args: {
                plan_id: plan.plan_id,
                updates: stepIds.map((step_id) => ({ step_id, status: 'completed' })),
                complete_plan: true,
              },
            },
          ],
        },
      };
    },
  };
}

function planFinalResponse(completeCallId: string, content: string) {
  return {
    expectedRequest: {
      toolResults: [{ toolCallId: completeCallId, contentIncludes: ['"plan_completed":true'] }],
    },
    message: { content },
  };
}
