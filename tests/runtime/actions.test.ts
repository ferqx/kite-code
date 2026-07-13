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

  test('cancels a matching user-input interaction into a tool completion', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.calls['ask-1'] = {
      toolCallId: 'ask-1',
      modelMessageId: 'model-1',
      name: 'ask_user',
      args: { question: 'q' },
      status: 'awaiting_user_input',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input-1',
      toolCallId: 'ask-1',
      request: { question: 'q', options: [], allow_free_text: true },
    };

    const events = eventsForRuntimeAction(state, {
      type: 'cancel',
      interactionId: 'input-1',
      reason: 'Cancelled with Esc.',
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: 'ask-1',
        name: 'ask_user',
        result: expect.objectContaining({ ok: false, stdout: 'Cancelled' }),
      }),
    );
  });

  test('cancels a matching tool approval into an approval rejection', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      approval: {
        scope: 'once',
        cwd: '/',
        threadId: 't',
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'hash',
        summary: 'Run pwd',
        reason: 'test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };

    expect(
      eventsForRuntimeAction(state, {
        type: 'cancel',
        interactionId: 'approval-1',
        reason: 'Cancelled with Ctrl+C.',
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'approval.rejected',
        interactionId: 'approval-1',
        reason: 'Cancelled with Ctrl+C.',
      }),
    ]);
  });

  test.each([
    'awaiting_user_input',
    'awaiting_tool_approval',
    'awaiting_review',
  ] as const)('ignores a stale generic cancel for %s', (kind) => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.interactions =
      kind === 'awaiting_user_input'
        ? {
            kind,
            interactionId: 'current',
            toolCallId: 'ask-1',
            request: { question: 'q', options: [], allow_free_text: true },
          }
        : kind === 'awaiting_tool_approval'
          ? {
              kind,
              interactionId: 'current',
              toolCallId: 'approval-1',
              approval: {
                scope: 'once',
                cwd: '/',
                threadId: 't',
                tool: 'shell_execute',
                command: 'pwd',
                risk: 'execute_code',
                approvalHash: 'hash',
                summary: 'Run pwd',
                reason: 'test',
                expectedEffects: [],
                grantOptions: ['approve_once'],
                recommendedGrant: 'approve_once',
              },
            }
          : {
              kind,
              interactionId: 'current',
              toolCallId: 'plan-1',
              planId: 'plan-1',
              version: 1,
              structuralDigest: 'digest',
              plan: { name: 'Plan', description: '', status: 'pending', steps: [] },
              planSummary: 'Plan',
            };

    expect(eventsForRuntimeAction(state, { type: 'cancel', interactionId: 'stale' })).toEqual([]);
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
