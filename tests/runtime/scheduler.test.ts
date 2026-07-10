import { describe, expect, test } from 'bun:test';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

describe('decideNextEffect', () => {
  test('gives unresolved user interaction priority over queued tools', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('tool');
    state.tools.calls.tool = {
      toolCallId: 'tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'i',
      toolCallId: 'tool',
      request: { question: 'q', options: [], allow_free_text: true },
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_user_input',
      interactionId: 'i',
      toolCallId: 'tool',
    });
  });

  test('runs queued calls before asking the model again', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('tool');
    state.tools.calls.tool = {
      toolCallId: 'tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['tool'] });
  });
});
