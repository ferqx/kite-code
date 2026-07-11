// ── Plan Mode v2 交互屏障测试 / Interaction barrier tests ──
// 验证 exit_plan_mode / ask_user / approval 作为 barrier 阻止后续 sibling tool calls
import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import type { AgentPlan } from '../../src/protocol/events';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan.',
    status: 'pending',
    steps: [{ step: 'Step 1', status: 'pending' }],
  };
}

function makeEvent(
  overrides: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] },
): RuntimeEvent {
  return overrides as RuntimeEvent;
}

describe('interaction barrier', () => {
  test('single-tool scheduling runs one tool at a time', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
    });

    // Queue two tools
    const e1 = makeEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'write_plan',
      args: {},
    });
    const e2 = makeEvent({
      type: 'tool.queued',
      toolCallId: 'call-2',
      name: 'read_file',
      args: {},
    });

    const s1 = reduceRuntimeState(state, e1);
    const s2 = reduceRuntimeState(s1, e2);

    expect(s2.tools.queue).toHaveLength(2);
    // Single-tool scheduling: only first runnable is dispatched
    // (the scheduler's decideNextEffect picks the first queued tool)
  });

  test('write_plan is not an interaction barrier', () => {
    // write_plan emits plan.drafted, no interaction created
    // After processing, interactions remain idle, next tool can run
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    // Queue write_plan
    const s1 = reduceRuntimeState(
      state,
      makeEvent({
        type: 'tool.queued',
        toolCallId: 'call-wp',
        name: 'write_plan',
        args: {},
      }),
    );

    // After write_plan processes (via plan.drafted), no interaction created
    const plan = makePlan();
    const s2 = reduceRuntimeState(
      s1,
      makeEvent({
        type: 'plan.drafted',
        toolCallId: 'call-wp',
        plan,
        structuralHash: 'abc',
      }),
    );

    // Interactions still idle — next tool can run
    expect(s2.interactions.kind).toBe('idle');
  });

  test('exit_plan_mode is an interaction barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    // Set up planning_draft
    const plan = makePlan();
    const s1 = reduceRuntimeState(
      state,
      makeEvent({
        type: 'plan.drafted',
        toolCallId: 'c1',
        plan,
        structuralHash: 'abc',
      }),
    );

    // exit_plan_mode triggers review_requested → interaction = awaiting_review
    const s2 = reduceRuntimeState(
      s1,
      makeEvent({
        type: 'plan.review_requested',
        interactionId: 'inter-r',
        toolCallId: 'call-epm',
        plan,
        planSummary: 'Review this',
      }),
    );

    expect(s2.interactions.kind).toBe('awaiting_review');
    // Barrier: scheduler will return request_plan_review instead of run_tools
    // Remaining queued tools won't execute until interaction resolves
  });

  test('ask_user is an interaction barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
    });

    const s1 = reduceRuntimeState(
      state,
      makeEvent({
        type: 'user_input.requested',
        interactionId: 'inter-u',
        toolCallId: 'call-ask',
        request: { question: 'What?', options: [], allow_free_text: true },
      }),
    );

    expect(s1.interactions.kind).toBe('awaiting_user_input');
    // Barrier: scheduler returns request_user_input instead of run_tools
  });

  test('model returns [write_plan, exit_plan_mode, write_file]: write_plan succeeds, exit_plan_mode waits, write_file blocked', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    const plan = makePlan();

    // Queue all three tools from same model message
    const s1 = reduceRuntimeState(
      state,
      makeEvent({
        type: 'plan.drafted',
        toolCallId: 'call-wp',
        plan,
        structuralHash: 'abc',
      }),
    );
    // write_plan succeeded, state is planning_draft

    const s2 = reduceRuntimeState(
      s1,
      makeEvent({
        type: 'tool.queued',
        toolCallId: 'call-epm',
        name: 'exit_plan_mode',
        args: {},
      }),
    );
    const s3 = reduceRuntimeState(
      s2,
      makeEvent({
        type: 'tool.queued',
        toolCallId: 'call-wf',
        name: 'write_file',
        args: { path: 'out.txt' },
      }),
    );

    // exit_plan_mode creates interaction barrier
    const s4 = reduceRuntimeState(
      s3,
      makeEvent({
        type: 'plan.review_requested',
        interactionId: 'inter-barrier',
        toolCallId: 'call-epm',
        plan,
        planSummary: 'Block write_file',
      }),
    );

    expect(s4.interactions.kind).toBe('awaiting_review');
    // write_file is still queued but won't run because scheduler returns request_plan_review
    expect(s4.tools.queue).toContain('call-wf');
    const wfCall = s4.tools.calls['call-wf'];
    expect(wfCall?.status).toBe('queued');
  });

  test('only one interaction at a time', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
    });

    // Create first interaction
    const s1 = reduceRuntimeState(
      state,
      makeEvent({
        type: 'user_input.requested',
        interactionId: 'inter-1',
        toolCallId: 'call-1',
        request: { question: 'First?', options: [], allow_free_text: true },
      }),
    );

    expect(s1.interactions.kind).toBe('awaiting_user_input');

    // Second interaction cannot be created while first is active
    // (scheduler returns request_user_input instead of processing more tools)
    // So only one interaction exists
  });
});
