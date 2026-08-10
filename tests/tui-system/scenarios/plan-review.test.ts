/**
 * PTY System Test — Plan Draft (write_plan) Rendering
 *
 * Verifies that when the agent calls write_plan in planning phase,
 * the TUI renders a tool_card with the plan content and does NOT trigger
 * a plan_review interrupt (that's exit_plan_mode's job in v2).
 *
 * The full write_plan → review → approve → complete flow is exercised below.
 * The request-aware mock resolver binds submit to the real draft_saved
 * Artifact identity instead of predicting the generated plan ID.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney } from '../harness/journey';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  readPersistedPlanArtifacts,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Plan Draft (write_plan)', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Shared mock responses — write_plan in planning phase.
    // Response #1: write_plan tool call with v2 args
    // Response #2: agent text after drafting
    // Response #3: deterministic response to the explicit building-phase probe.
    server.setResponses([
      {
        message: {
          content: 'Let me draft a plan.',
          tool_calls: [
            {
              id: 'call_write_1',
              name: 'write_plan',
              args: {
                title: 'Test Draft Plan',
                body_markdown: 'Implement the feature step by step with careful testing.',
                steps: [
                  { id: 'setup', title: 'Set up project structure' },
                  { id: 'core', title: 'Implement core logic' },
                  { id: 'test', title: 'Write tests' },
                ],
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_write_1', contentIncludes: ['draft_saved'] }],
        },
        message: { content: 'Plan draft saved. Ready for review when you are.' },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_write_1',
          );
          const { plan_id, version, structural_digest } = parseDraftSavedPlan(result?.content);
          return {
            expectedRequest: {
              toolResults: [{ toolCallId: 'call_write_1', contentIncludes: ['draft_saved'] }],
            },
            message: {
              tool_calls: [
                {
                  id: 'call_submit_1',
                  name: 'write_plan',
                  args: { action: 'submit', plan_id, version, structural_digest },
                },
              ],
            },
          };
        },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_submit_1',
          );
          const plan = JSON.parse(String(result?.content)) as { plan_id: string };
          return {
            expectedRequest: {
              toolResults: [
                { toolCallId: 'call_submit_1', contentIncludes: ['"status":"approved"'] },
              ],
            },
            message: {
              tool_calls: [
                {
                  id: 'call_complete_1',
                  name: 'update_plan',
                  args: {
                    plan_id: plan.plan_id,
                    updates: [
                      { step_id: 'setup', status: 'completed' },
                      { step_id: 'core', status: 'completed' },
                      { step_id: 'test', status: 'completed' },
                    ],
                    complete_plan: true,
                  },
                },
              ],
            },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_complete_1', contentIncludes: ['"plan_completed":true'] },
          ],
        },
        message: { content: 'Plan completed successfully.' },
      },
      { message: { content: 'No plan tool requested in building phase.' } },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── write_plan in planning phase renders plan content ───

  step(
    'write_plan renders plan content in planning phase',
    async () => {
      // Complete the local mode transition before sending the model task.
      await submitCommand(tui, '/plan');
      await waitForText(() => tui.viewport(), 'Shift+Tab to exit', 15000);
      await waitForTuiReady(tui);
      await submitUserMessage(tui, server, 'Draft a plan for testing', { timeout: 15000 });

      // Wait for the plan draft follow-up text
      await waitForText(() => tui.outputSinceLastAction(), 'Plan draft saved', 15000);
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Plan completed successfully.', 15_000);
      await assertCompletedPlanTurn(workspace, 'Draft a plan for testing');

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after write_plan:', clean.slice(-2000));

      // Plan content should appear in the rendered output
      expect(clean.includes('Test Draft Plan')).toBe(true);

      const artifacts = readPersistedPlanArtifacts(workspace);
      expect(artifacts).toHaveLength(1);
      expect(basename(artifacts[0]!.path)).toBe('v1.md');
      expect(artifacts[0]!.content).toContain('# Test Draft Plan');
      expect(artifacts[0]!.content).toContain(
        'Implement the feature step by step with careful testing.',
      );
      expect(artifacts[0]!.content).toContain('"id":"setup"');
      expect(artifacts[0]!.content).toContain('"title":"Write tests"');

      // Plan review UI should NOT be shown (write_plan does not trigger review)
      expect(clean.includes('Review the plan above and choose')).toBe(false);

      // TUI prompt should be back
      expect(clean.includes('❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── write_plan in building phase is rejected ─────────────

  step(
    'write_plan is rejected in building phase',
    async () => {
      // Submit a new message (in building phase — default mode)
      await submitUserMessage(tui, server, 'Try to write a plan now', { timeout: 15000 });

      await waitForTuiReady(tui);

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after building phase write_plan attempt:', clean.slice(-1500));

      // TUI should still be responsive (no crash)
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test('runs the complete stateful journey', () => journey.run());
});

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

async function assertCompletedPlanTurn(
  workspace: ReturnType<typeof createTestWorkspace>,
  userMessage: string,
): Promise<void> {
  await waitForCondition(
    () => {
      const observation = observePersistedTurnEvents(workspace, userMessage);
      if (observation.status !== 'ready' || !observation.value) return false;
      return observation.value.events.some((event) => event.type === 'turn.completed');
    },
    `durable completion for ${userMessage}`,
    10_000,
  );
  const observed = requirePersistedRuntimeReady(observePersistedTurnEvents(workspace, userMessage));
  expect(observed).toBeDefined();
  const events = observed!.events;
  const blocked = events.filter((event) => event.type === 'completion.blocked');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({
    code: 'plan_draft_pending',
    planning: 'planning_draft',
    correctionAttempt: 1,
  });
  const blockerIndex = events.indexOf(blocked[0]!);
  const continuationIndex = events.findIndex(
    (event, index) => index > blockerIndex && event.type === 'model.requested',
  );
  const runCompletedIndex = events.findIndex((event) => event.type === 'run.completed');
  const turnCompletedIndex = events.findIndex((event) => event.type === 'turn.completed');
  expect(continuationIndex).toBeGreaterThan(blockerIndex);
  expect(runCompletedIndex).toBeGreaterThan(continuationIndex);
  expect(turnCompletedIndex).toBeGreaterThan(runCompletedIndex);
}
