import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { effectiveSubagentInteractionMode } from '../../src/runtime/tool-execution/subagent-executor';

type QueueRecord = {
  interactionId: string;
  parentToolCallId: string;
  childSubagentId: string;
  toolCallId: string;
  route: 'auto' | 'user';
  state: string;
  generation: number;
  sequence: number;
  approvalHash: string;
  commandKey: string;
};

type ApprovalQueueState = {
  pendingApprovals: Map<string, QueueRecord>;
  activeApprovalId: string | null;
};

function initialState(mode: RuntimeState['mode'] = 'accept_edits'): RuntimeState {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'saq-queue-test',
    userId: 'test-user',
    workspace: '/tmp/saq-queue-test',
  });
  return { ...state, mode };
}

function addTask(
  state: RuntimeState,
  toolCallId: string,
  input: { role: 'explore' | 'plan' | 'code' | 'review'; modelMessageId?: string } = {
    role: 'explore',
  },
): RuntimeState {
  let next = reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId,
    name: 'task',
    args: {
      name: `${input.role}-${toolCallId}`,
      subagent_type: input.role,
      task: `Run ${input.role} child ${toolCallId}`,
    },
  });
  const call = next.tools.calls[toolCallId];
  if (!call) throw new Error(`fixture did not queue ${toolCallId}`);
  next = {
    ...next,
    tools: {
      ...next.tools,
      calls: {
        ...next.tools.calls,
        [toolCallId]: {
          ...call,
          modelMessageId: input.modelMessageId ?? 'same-model-message',
          args: { subagent_type: input.role },
        },
      },
    },
  };
  return next;
}

function approvalEvent(input: {
  interactionId: string;
  toolCallId: string;
  parentToolCallId?: string;
  childSubagentId?: string;
  route?: 'auto' | 'user';
  generation?: number;
  sequence?: number;
  command?: string;
  approvalHash?: string;
}): RuntimeEvent {
  const command = input.command ?? 'printf saq';
  return {
    type: 'approval.requested',
    interactionId: input.interactionId,
    toolCallId: input.toolCallId,
    approval: {
      scope: 'once',
      cwd: '/tmp/saq-queue-test',
      threadId: 'saq-queue-test',
      tool: 'shell_execute',
      command,
      risk: 'execute_code',
      approvalHash: input.approvalHash ?? `${input.interactionId}-hash`,
      summary: `Run ${command}`,
      reason: 'SAQ queue fixture',
      expectedEffects: [],
      grantOptions: ['approve_once', 'same_command'],
      recommendedGrant: 'approve_once',
    },
    // These fields are the durable queue contract; current State drops them.
    parentToolCallId: input.parentToolCallId ?? 'parent-task',
    childSubagentId: input.childSubagentId ?? `child-${input.toolCallId}`,
    approvalRoute: input.route ?? 'user',
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: true,
    queueGeneration: input.generation ?? 1,
    queueSequence: input.sequence ?? 1,
  } as unknown as RuntimeEvent;
}

function reduce(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  return reduceRuntimeState(state, event);
}

function queue(state: RuntimeState): Map<string, QueueRecord> {
  const value = (state as unknown as Partial<ApprovalQueueState>).pendingApprovals;
  expect(value, 'durable approval queue is missing from RuntimeState').toBeInstanceOf(Map);
  return value as Map<string, QueueRecord>;
}

describe('SAQ-13/14/15 — durable subagent approval queue', () => {
  test('derives Auto only for same-turn concurrent Explore children', () => {
    let state = initialState('accept_edits');
    state = addTask(state, 'explore-a', { role: 'explore' });
    state = addTask(state, 'explore-b', { role: 'explore' });
    expect(effectiveSubagentInteractionMode(state, 'explore-a')).toBe('auto');

    for (const role of ['plan', 'code', 'review'] as const) {
      let siblingState = initialState('accept_edits');
      siblingState = addTask(siblingState, 'child-a', { role, modelMessageId: 'same' });
      siblingState = addTask(siblingState, 'child-b', { role, modelMessageId: 'same' });
      expect(effectiveSubagentInteractionMode(siblingState, 'child-a')).toBe('accept_edits');
    }

    let singleExplore = initialState('accept_edits');
    singleExplore = addTask(singleExplore, 'explore-only', { role: 'explore' });
    expect(effectiveSubagentInteractionMode(singleExplore, 'explore-only')).toBe('accept_edits');

    let full = initialState('full');
    full = addTask(full, 'explore-a', { role: 'explore' });
    full = addTask(full, 'explore-b', { role: 'explore' });
    expect(effectiveSubagentInteractionMode(full, 'explore-a')).toBe('full');
  });

  test('persists canonical route, generation, sequence, and parent-child binding', () => {
    let state = initialState();
    state = addTask(state, 'task-a');
    state = reduce(
      state,
      approvalEvent({
        interactionId: 'approval-a',
        toolCallId: 'task-a',
        parentToolCallId: 'parent-1',
        childSubagentId: 'child-a',
        route: 'auto',
        generation: 7,
        sequence: 42,
        approvalHash: 'sha256:approval-a',
      }),
    );

    const record = queue(state).get('approval-a');
    expect(record).toMatchObject({
      interactionId: 'approval-a',
      parentToolCallId: 'parent-1',
      childSubagentId: 'child-a',
      toolCallId: 'task-a',
      route: 'auto',
      generation: 7,
      sequence: 42,
      approvalHash: 'sha256:approval-a',
    });
  });

  test('keeps two child requests and one acknowledgement independent', () => {
    let state = initialState();
    state = addTask(state, 'task-a');
    state = addTask(state, 'task-b');
    state = reduce(
      state,
      approvalEvent({
        interactionId: 'approval-a',
        toolCallId: 'task-a',
        sequence: 1,
        command: 'printf shared',
      }),
    );
    state = reduce(
      state,
      approvalEvent({
        interactionId: 'approval-b',
        toolCallId: 'task-b',
        sequence: 2,
        command: 'printf shared',
      }),
    );

    expect(queue(state)).toHaveProperty('size', 2);
    expect(queue(state).get('approval-a')?.state).toBe('awaiting_user');
    expect(queue(state).get('approval-b')?.state).toBe('awaiting_user');

    state = reduce(state, {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'task-a',
      grant: 'approve_once',
      receiptId: 'receipt-a',
      generation: 1,
    } as RuntimeEvent);
    expect(queue(state).get('approval-a')?.state).toBe('authorized_queued');
    expect(queue(state).get('approval-b')?.state).toBe('awaiting_user');
    expect(state.tools.calls['task-b']?.status).not.toBe('failed');
  });

  test('restores focus and ignores stale or late acknowledgements after restart', () => {
    let state = initialState();
    state = addTask(state, 'task-a');
    state = addTask(state, 'task-b');
    state = reduce(state, approvalEvent({ interactionId: 'approval-a', toolCallId: 'task-a' }));
    state = reduce(state, approvalEvent({ interactionId: 'approval-b', toolCallId: 'task-b' }));

    const restored = structuredClone(state) as RuntimeState;
    expect(queue(restored).get('approval-a')?.state).toBe('awaiting_user');
    expect(queue(restored).get('approval-b')?.state).toBe('awaiting_user');
    expect((restored as unknown as Partial<ApprovalQueueState>).activeApprovalId).toBe(
      'approval-a',
    );

    const before = structuredClone(restored);
    const stale = reduce(restored, {
      type: 'approval.granted',
      interactionId: 'unknown-interaction',
      toolCallId: 'task-a',
      grant: 'approve_once',
      receiptId: 'late-receipt',
      generation: 1,
    } as RuntimeEvent);
    expect(stale).toEqual(before);
  });
});
