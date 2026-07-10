import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction } from '../../src/core/runtime/actions';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

describe('runtime user actions', () => {
  test('ignores an action whose interaction id does not match', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'expected',
      toolCallId: 'ask',
      request: { question: 'q', options: [], allow_free_text: true },
    };
    expect(
      eventsForRuntimeAction(state, { type: 'input', interactionId: 'wrong', text: 'answer' }),
    ).toEqual([]);
  });

  test('turns matching input into answer and tool completion facts', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'expected',
      toolCallId: 'ask',
      request: { question: 'q', options: [], allow_free_text: true },
    };
    expect(
      eventsForRuntimeAction(state, {
        type: 'input',
        interactionId: 'expected',
        text: 'answer',
      }).map((event) => event.type),
    ).toEqual(['user_input.answered', 'tool.finished']);
  });
});
