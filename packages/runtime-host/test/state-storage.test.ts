import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  createInitialAgentState,
  encodeCurrentAgentStateJson,
  type RuntimeEvent,
} from '@kite/agent-kernel';
import { createRuntimeHostStateStorageBindingV1 } from '@kite/runtime-host';

const RECOVERY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function state(): AgentState {
  return createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

describe('Runtime Host State storage binding', () => {
  test('owns exact event/state bytes and the session summary projection', () => {
    const binding = createRuntimeHostStateStorageBindingV1();
    const event: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'hello',
    };
    expect(binding.codec.encodeEvent(event)).toBe(JSON.stringify(event));
    expect(binding.codec.decodeEvent(JSON.stringify(event))).toEqual(event);

    const currentState = state();
    expect(binding.codec.encodeState(currentState)).toBe(encodeCurrentAgentStateJson(currentState));
    expect(binding.codec.decodeState<AgentState>(binding.codec.encodeState(currentState))).toEqual(
      currentState,
    );
    expect(binding.codec.eventSummary?.(event)).toEqual({
      isSessionNameCandidate: true,
      searchText: 'hello',
    });
    expect(() => binding.codec.decodeEvent('{"type":"retired.event"}')).toThrow(
      /not part of the current format/u,
    );
  });

  test('fails closed on snapshot identity and preserves fork/request semantics', () => {
    const binding = createRuntimeHostStateStorageBindingV1();
    const currentState = state();
    const valid = {
      state: currentState,
      sessionId: 'session-1',
      eventPosition: 0,
      stateRevision: 0,
      schemaVersion: 26,
      eventRevision: 0,
    };
    expect(() => binding.codec.validateSnapshot?.(valid)).not.toThrow();
    for (const invalid of [
      { ...valid, sessionId: 'session-2' },
      { ...valid, stateRevision: 1 },
      { ...valid, schemaVersion: 25 },
      { ...valid, eventRevision: 1 },
      { ...valid, eventPosition: -1 },
    ]) {
      expect(() => binding.codec.validateSnapshot?.(invalid)).toThrow(/identity or revision/u);
    }

    const request = { question: 'continue?', options: [], allow_free_text: true };
    const waiting: AgentState = {
      ...currentState,
      tools: {
        calls: {
          'tool-1': {
            toolCallId: 'tool-1',
            name: 'ask_user',
            modelMessageId: 'message-1',
            args: {},
            createdAtTurnId: 'turn-1',
            status: 'awaiting_user_input',
          },
        },
        queue: [],
        active: [],
      },
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        request,
      },
    };
    expect(
      binding.codec.isCurrentPendingInteractionRequest?.(waiting, {
        type: 'user_input.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        request,
      }),
    ).toBe(true);
    const fork = binding.codec.rebindForkState(waiting, 'session-2', 'b'.repeat(64)) as AgentState;
    expect(fork.session.threadId).toBe('session-2');
    expect(fork.toolRecovery).toMatchObject({
      identityKey: 'b'.repeat(64),
      failures: {},
      order: [],
    });
    expect(fork.interactions).toEqual({ kind: 'idle' });
    expect(binding.codec.canFork?.(fork)).toBe(true);
  });
});
