import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  createInitialAgentState,
  decidePlanReviewSiblingCancellationsV1,
} from '../src';

describe('State interaction governance', () => {
  test('cancels only later queued siblings from the same model message', () => {
    const initial = createInitialAgentState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'thread-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
    });
    const state = {
      ...initial,
      tools: {
        ...initial.tools,
        calls: {
          opening: {
            toolCallId: 'opening',
            name: 'write_plan',
            args: {},
            modelMessageId: 'message-1',
            ordinal: 1,
            createdAtTurnId: initial.turn.turnId,
            status: 'running',
          },
          earlier: {
            toolCallId: 'earlier',
            name: 'read_file',
            args: {},
            modelMessageId: 'message-1',
            ordinal: 0,
            createdAtTurnId: initial.turn.turnId,
            status: 'queued',
          },
          later: {
            toolCallId: 'later',
            name: 'read_file',
            args: {},
            modelMessageId: 'message-1',
            ordinal: 2,
            createdAtTurnId: initial.turn.turnId,
            status: 'queued',
          },
          otherMessage: {
            toolCallId: 'otherMessage',
            name: 'read_file',
            args: {},
            modelMessageId: 'message-2',
            ordinal: 3,
            createdAtTurnId: initial.turn.turnId,
            status: 'queued',
          },
          approved: {
            toolCallId: 'approved',
            name: 'read_file',
            args: {},
            modelMessageId: 'message-1',
            ordinal: 4,
            createdAtTurnId: initial.turn.turnId,
            status: 'approved',
          },
        },
      },
    } satisfies AgentState;

    expect(decidePlanReviewSiblingCancellationsV1(state, 'opening')).toEqual([
      {
        toolCallId: 'later',
        reason: 'Cancelled because an earlier tool call opened an interaction.',
      },
    ]);
    expect(decidePlanReviewSiblingCancellationsV1(state, 'missing')).toEqual([]);
  });
});
