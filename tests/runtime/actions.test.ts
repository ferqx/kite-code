import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction } from '../../src/core/runtime/actions';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

describe('runtime user actions', () => {
  test('ignores an action whose interaction id does not match', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'expected',
      toolCallId: 'accept_edits',
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
      toolCallId: 'accept_edits',
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

  test('preserves five-question input answers as structured tool completion data', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'expected',
      toolCallId: 'accept_edits',
      request: {
        question: 'Choose project settings',
        options: [],
        allow_free_text: true,
        questions: [
          { id: 'language', question: 'Language?', options: [] },
          { id: 'framework', question: 'Framework?', options: [] },
          { id: 'database', question: 'Database?', options: [] },
          { id: 'hosting', question: 'Hosting?', options: [] },
          { id: 'testing', question: 'Testing?', options: [] },
        ],
      },
    };
    const answer = 'Use the submitted configuration for the new service.';
    const answers = {
      language: 'TypeScript with strict compiler settings and no implicit any values.',
      framework: 'A lightweight HTTP framework with typed routes and middleware.',
      database: 'PostgreSQL with migrations, indexes, backups, and connection pooling.',
      hosting: 'A regional container platform with managed secrets and observability.',
      testing: 'Unit, integration, and end-to-end tests in continuous integration.',
    };

    const events = eventsForRuntimeAction(state, {
      type: 'input',
      interactionId: 'expected',
      text: answer,
      answers,
    });
    const toolFinished = events[1];

    expect(toolFinished).toMatchObject({
      type: 'tool.finished',
      result: {
        userInput: { answer, answers },
      },
    });
    if (toolFinished?.type !== 'tool.finished') throw new Error('Expected tool.finished event');
    expect(toolFinished.result.stdout.length).toBeGreaterThan(200);
  });
});

test('full access approval is rejected when no sandbox is available', () => {
  const state = createInitialRuntimeState({ threadId: 'auth', userId: 'u', workspace: '/' });
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'tool-1',
    approval: {
      scope: 'once',
      cwd: '/',
      threadId: 'auth',
      tool: 'shell_execute',
      command: 'pwd',
      risk: 'execute_code',
      approvalHash: 'hash',
      summary: 'Run pwd',
      reason: 'test',
      expectedEffects: [],
      grantOptions: ['full_access'],
      recommendedGrant: 'full_access',
    },
  };
  expect(
    eventsForRuntimeAction(
      state,
      { type: 'approve', interactionId: 'approval-1', grant: 'full_access' },
      { sandboxAvailable: false },
    ),
  ).toEqual([
    expect.objectContaining({
      type: 'approval.rejected',
      reason: expect.stringContaining('requires'),
    }),
  ]);
});
