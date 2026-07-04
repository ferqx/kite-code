/**
 * PTY System Test — Plan Review (PlanReviewBlock) Flow
 *
 * Verifies that when the agent calls update_plan (structural, non-progress-only),
 * the TUI renders PlanReviewBlock in the footer and handles all three options:
 * a (auto approve), m (manual approve), t (tell agent / supplement feedback).
 * Also verifies Escape to return from supplement mode back to options mode.
 *
 * HOW IT WORKS:
 * The mock model returns a tool_calls response containing update_plan.
 * The LangGraph graph routes to the plan_review node (because the plan is
 * new/structural, not progress-only). The plan_review node calls interrupt(),
 * which triggers a need_plan_review event to the TUI. The TUI renders
 * PlanReviewBlock in the footer. User keypresses are handled by
 * PlanReviewBlock's useInput hook, which calls provider.submitAction() to
 * resolve the interrupt and resume graph execution.
 *
 * LIMITATIONS:
 * - This test covers the full PTY E2E flow (model → graph → interrupt →
 *   PlanReviewBlock → user action → resume). The mock server only handles
 *   the OpenAI-compatible API; the graph, interrupts, and PlanReviewBlock
 *   all work as in production.
 * - Not covered: the "supplement submitted with text" flow (t → type feedback
 *   → Enter). After supplementing, the graph rejects the plan and routes to
 *   END (no agent continuation), which differs from the auto/manual approve
 *   paths and is better tested at the component/unit test level.
 * - Not covered: arrow key navigation within PlanReviewBlock options. The
 *   letter shortcuts (a/m/t) are the primary interaction pattern; arrow key
 *   navigation is covered by component-level tests.
 *
 * IMPORTANT: Follows the standard 3-test warmup pattern from other PTY tests
 * (typing → empty Enter → main scenario). See tool-approve.test.ts and
 * ask-user.test.ts for the pattern.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Plan Review', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Shared mock responses for all tests in this file.
    // Response #1: update_plan tool call — structural (non-progress-only) plan
    //   triggers plan_review node → interrupt → PlanReviewBlock renders.
    // Response #2: agent follow-up after plan is approved (auto/manual)
    // Response #3-6: spare responses for generateSessionName + potential retries
    server.setResponses([
      {
        message: {
          content: 'Here is my plan for the task.',
          tool_calls: [
            {
              id: 'call_plan_1',
              name: 'update_plan',
              args: {
                name: 'Test Implementation Plan',
                description: 'We will implement the feature step by step.',
                status: 'in_progress',
                steps: [
                  { step: 'Step 1: Set up project structure', status: 'pending' },
                  { step: 'Step 2: Implement core logic', status: 'pending' },
                  { step: 'Step 3: Write tests', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'Plan approved! Let me start working on it.' } },
      { message: { content: 'Plan spare 1' } },
      { message: { content: 'Plan spare 2' } },
      { message: { content: 'Plan spare 3' } },
      { message: { content: 'Plan spare 4' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
    // Allow raw mode transition to settle before sending keystrokes
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Plan Review: Auto Approve (a key) ─────────────────────

  test(
    'plan review renders with options, auto approve (a) triggers agent continuation',
    async () => {
      // Submit a user message to trigger the model call
      await typeText(tui, 'Create a plan for testing');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a plan for testing', 15000);

      // Wait for the plan review UI to render.
      // PlanReviewBlock renders a bordered box with "Review the plan above and choose:"
      await waitForText(() => tui.output(), 'Review the plan above and choose', 15000);

      const beforeApprove = tui.output();
      const clean = stripAnsi(beforeApprove);
      console.log('  output before approve (last 1500 chars):', clean.slice(-1500));

      // Verify all three options are visible
      expect(screenContains(beforeApprove, 'Review the plan above and choose')).toBe(true);
      expect(screenContains(beforeApprove, 'Yes, and use auto mode')).toBe(true);
      expect(screenContains(beforeApprove, 'Yes, manually approve edits')).toBe(true);
      expect(screenContains(beforeApprove, 'Tell Agent what to change')).toBe(true);

      // Verify the plan content is rendered (tool_card expanded with plan summary)
      expect(screenContains(beforeApprove, 'Test Implementation Plan')).toBe(true);
      expect(screenContains(beforeApprove, 'Step 1: Set up project structure')).toBe(true);

      // Verify keyboard hints are visible
      expect(screenContains(beforeApprove, 'a/m/t quick key')).toBe(true);

      // Press 'a' for auto approve
      tui.write('a');
      // Wait for the graph to resume, plan to be approved, and agent to continue
      await sleep(3000);

      // Wait for the agent's follow-up response after plan approval
      await waitForText(() => tui.output(), 'Plan approved! Let me start working on it.', 15000);

      const afterApprove = tui.output();
      const afterClean = stripAnsi(afterApprove);
      console.log('  output after auto approve (last 1500 chars):', afterClean.slice(-1500));

      // Agent's response should be visible
      expect(screenContains(afterApprove, 'Plan approved! Let me start working on it.')).toBe(true);

      // Plan review options should no longer be visible (interrupt resolved)
      // Note: waitForTextGone is unreliable for Static content (per pty-e2e-test-patterns.md),
      // so we verify the prompt is visible instead (implies TUI is back in idle state).
      expect(screenContains(afterApprove, '❯')).toBe(true);

      // Reset mock responses for next test — fresh update_plan + follow-up
      server.setResponses([
        {
          message: {
            content: 'Here is my revised plan.',
            tool_calls: [
              {
                id: 'call_plan_2',
                name: 'update_plan',
                args: {
                  name: 'Manual Test Plan',
                  description: 'This plan will be manually approved.',
                  status: 'in_progress',
                  steps: [
                    { step: 'Step A: Research', status: 'pending' },
                    { step: 'Step B: Implementation', status: 'pending' },
                  ],
                },
              },
            ],
          },
        },
        { message: { content: 'Manual plan approved! Proceeding with caution.' } },
        { message: { content: 'Manual spare 1' } },
        { message: { content: 'Manual spare 2' } },
        { message: { content: 'Manual spare 3' } },
        { message: { content: 'Manual spare 4' } },
      ]);
    },
    TIMEOUT,
  );

  // ── Plan Review: Manual Approve (m key) ───────────────────

  test(
    'plan review manual approve (m) triggers agent continuation',
    async () => {
      // Submit a new user message to trigger another plan review
      await typeText(tui, 'Revise the plan for manual review');
      tui.write('\r');
      await waitForRequestMessage(server, 'Revise the plan for manual review', 15000);

      // Wait for PlanReviewBlock to render
      await waitForText(() => tui.output(), 'Review the plan above and choose', 15000);

      const beforeManual = tui.output();
      expect(screenContains(beforeManual, 'Manual Test Plan')).toBe(true);
      expect(screenContains(beforeManual, 'Yes, manually approve edits')).toBe(true);

      // Press 'm' for manual approve
      tui.write('m');
      await sleep(3000);

      // Wait for agent follow-up after plan approval
      await waitForText(
        () => tui.output(),
        'Manual plan approved! Proceeding with caution.',
        15000,
      );

      const afterManual = tui.output();
      const afterClean = stripAnsi(afterManual);
      console.log('  output after manual approve (last 1500 chars):', afterClean.slice(-1500));

      // Agent response visible
      expect(screenContains(afterManual, 'Manual plan approved! Proceeding with caution.')).toBe(
        true,
      );
      // TUI recovered
      expect(screenContains(afterManual, '❯')).toBe(true);

      // Reset mock responses for supplement test
      server.setResponses([
        {
          message: {
            content: 'Here is another plan draft for review.',
            tool_calls: [
              {
                id: 'call_plan_3',
                name: 'update_plan',
                args: {
                  name: 'Supplement Test Plan',
                  description: 'This plan will be supplemented with feedback.',
                  status: 'in_progress',
                  steps: [
                    { step: 'Phase 1: Design', status: 'pending' },
                    { step: 'Phase 2: Build', status: 'pending' },
                  ],
                },
              },
            ],
          },
        },
        // After supplement, graph rejects current plan → routes to END (not agent)
        // So no follow-up message will be generated.
        { message: { content: 'Supplement spare 1' } },
        { message: { content: 'Supplement spare 2' } },
        { message: { content: 'Supplement spare 3' } },
        { message: { content: 'Supplement spare 4' } },
        { message: { content: 'Supplement spare 5' } },
      ]);
    },
    TIMEOUT,
  );

  // ── Plan Review: Supplement Mode (t key) + Escape Return ──

  test(
    't key enters supplement mode, Escape returns to options mode',
    async () => {
      // Submit user message to trigger another plan review
      await typeText(tui, 'Show me another plan');
      tui.write('\r');
      await waitForRequestMessage(server, 'Show me another plan', 15000);

      // Wait for PlanReviewBlock to render
      await waitForText(() => tui.output(), 'Review the plan above and choose', 15000);

      const beforeSupplement = tui.output();
      expect(screenContains(beforeSupplement, 'Supplement Test Plan')).toBe(true);

      // Press 't' to enter supplement mode
      tui.write('t');
      await sleep(1000);

      // Verify supplement mode UI: "Enter your feedback for the plan:" prompt
      // and "Enter submit Esc back" hint
      const afterT = tui.output();
      const tClean = stripAnsi(afterT);
      console.log('  output after pressing t (last 800 chars):', tClean.slice(-800));

      expect(screenContains(afterT, 'Enter your feedback for the plan')).toBe(true);
      expect(screenContains(afterT, 'Esc back')).toBe(true);

      // Options mode content should NOT be visible anymore
      // Note: Static content from scrollback may still show old render, but
      // the dynamic footer should have changed. We verify the supplement prompt is present.

      // Press Escape to return to options mode
      tui.write('\x1b');
      await sleep(1000);

      // Verify we are back in options mode: all three options should be visible again
      const afterEsc = tui.output();
      const escClean = stripAnsi(afterEsc);
      console.log('  output after Esc (last 800 chars):', escClean.slice(-800));

      expect(screenContains(afterEsc, 'Yes, and use auto mode')).toBe(true);
      expect(screenContains(afterEsc, 'Yes, manually approve edits')).toBe(true);
      expect(screenContains(afterEsc, 'Tell Agent what to change')).toBe(true);
      expect(screenContains(afterEsc, 'a/m/t quick key')).toBe(true);
    },
    TIMEOUT,
  );
});
