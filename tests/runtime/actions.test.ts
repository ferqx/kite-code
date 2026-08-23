import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState, LIMITED_RESOURCE_BUDGET_ } from '@kite/runtime-host';
import {
  eventsForRunCancellation,
  eventsForRuntimeAction,
} from '#app/bootstrap/runtime/state-actions';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

describe('runtime user actions', () => {
  test('waives a required provider with a redacted session-scoped fact', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
    state.interactions = {
      kind: 'awaiting_provider_admission',
      interactionId: 'admission',
      providerId: 'github',
      source: 'project',
      providerStatus: 'login_required',
      diagnosticCode: 'auth_required',
      retryable: false,
    };
    const events = eventsForRuntimeAction(state, {
      type: 'provider_admission_decision',
      interactionId: 'admission',
      decision: { kind: 'waive' },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'provider.admission_waived',
        interactionId: 'admission',
        providerId: 'github',
        source: 'project',
        reason: 'user_session_waiver',
        waivedAt: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('auth_required');
  });

  test('records required-provider retry outcome without inventing capability visibility', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
    state.interactions = {
      kind: 'awaiting_provider_admission',
      interactionId: 'admission',
      providerId: 'github',
      source: 'user',
      providerStatus: 'failed',
      retryable: true,
    };
    expect(
      eventsForRuntimeAction(state, {
        type: 'provider_admission_decision',
        interactionId: 'admission',
        decision: {
          kind: 'retry',
          outcome: 'ready',
          providerDirectoryRevision: 'directory-r2',
        },
      }),
    ).toEqual([
      { type: 'provider.admission_retry_requested', interactionId: 'admission' },
      {
        type: 'provider.admission_satisfied',
        interactionId: 'admission',
        providerDirectoryRevision: 'directory-r2',
      },
    ]);
  });

  test('completes provider recovery by clearing the interaction and starting a new turn', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
    const previousTurnId = state.turn.turnId;
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: { secret: 'must-not-be-copied' },
      status: 'failed',
      createdAtTurnId: previousTurnId,
    };
    state.interactions = {
      kind: 'awaiting_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
      status: 'started',
    };

    const events = eventsForRuntimeAction(state, {
      type: 'provider_action_result',
      interactionId: 'provider-action',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-r2',
    });

    expect(events[0]).toEqual({
      type: 'provider.action_completed',
      interactionId: 'provider-action',
      originatingToolCallId: 'mcp',
      providerDirectoryRevision: 'directory-r2',
    });
    expect(events[1]).toMatchObject({ type: 'turn.started' });
    if (events[1]?.type !== 'turn.started') throw new Error('Expected a new turn');
    expect(events[1].turnId).not.toBe(previousTurnId);
    expect(JSON.stringify(events)).not.toContain('must-not-be-copied');
  });

  test('maps provider recovery cancellation to a durable defer without starting a turn', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
    state.interactions = {
      kind: 'awaiting_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
      status: 'required',
    };
    expect(
      eventsForRuntimeAction(state, {
        type: 'cancel',
        interactionId: 'provider-action',
        reason: 'contains no durable payload',
      }),
    ).toEqual([
      {
        type: 'provider.action_deferred',
        interactionId: 'provider-action',
        originatingToolCallId: 'mcp',
      },
    ]);
  });

  test('ignores an action whose interaction id does not match', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
        type: 'user_input.cancelled',
        interactionId: 'input-1',
        toolCallId: 'ask-1',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: 'ask-1',
        name: 'ask_user',
        result: expect.objectContaining({ ok: false, stdout: 'Cancelled' }),
      }),
    );
  });

  test('cancelling auto_review durably cancels the tool without escalating to approval', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.interactions = {
      kind: 'awaiting_auto_review',
      interactionId: 'review-1',
      toolCallId: 'tool-1',
      toolName: 'shell_execute',
      reason: 'review',
      approval: {} as never,
    };
    const events = eventsForRuntimeAction(state, {
      type: 'cancel',
      interactionId: 'review-1',
      reason: 'user_cancelled',
    });
    expect(events).toEqual([
      { type: 'tool.cancelled', toolCallId: 'tool-1', reason: 'user_cancelled' },
    ]);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  test('a process-level user cancellation records auto_review as user_cancelled', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.tools.calls['tool-1'] = {
      toolCallId: 'tool-1',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: { command: 'npm test' },
      status: 'awaiting_auto_review',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_auto_review',
      interactionId: 'review-1',
      toolCallId: 'tool-1',
      toolName: 'shell_execute',
      reason: 'review',
      approval: {} as never,
    };

    expect(eventsForRunCancellation(state)).toContainEqual({
      type: 'tool.cancelled',
      toolCallId: 'tool-1',
      reason: 'user_cancelled',
    });
  });

  test.each([
    'cancel',
    'reject',
  ] as const)('%s on a matching tool approval rejects the target and aborts the whole turn', (actionType) => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'awaiting_approval',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-running'] = {
      toolCallId: 'shell-running',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: { command: 'sleep 10' },
      status: 'running',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['read-queued'] = {
      toolCallId: 'read-queued',
      modelMessageId: 'model-1',
      name: 'read_file',
      args: { path: '/tmp/example' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
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

    const events = eventsForRuntimeAction(state, {
      type: actionType,
      interactionId: 'approval-1',
      reason: 'Cancelled with Ctrl+C.',
    });

    expect(events.map((event) => event.type)).toEqual([
      'approval.rejected',
      'tool.cancelled',
      'tool.cancelled',
      'turn.aborted',
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval.rejected',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        reason: 'Cancelled with Ctrl+C.',
      }),
      expect.objectContaining({
        type: 'tool.cancelled',
        toolCallId: 'shell-running',
      }),
      expect.objectContaining({
        type: 'tool.cancelled',
        toolCallId: 'read-queued',
      }),
      expect.objectContaining({
        type: 'turn.aborted',
        cause: 'user',
        reason: 'Cancelled with Ctrl+C.',
      }),
    ]);
  });

  test.each([
    'awaiting_user_input',
    'awaiting_tool_approval',
    'awaiting_review',
  ] as const)('ignores a stale generic cancel for %s', (kind) => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'auth',
    userId: 'u',
    workspace: '/',
  });
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
      toolCallId: 'tool-1',
      reason: expect.stringContaining('requires'),
    }),
  ]);
});

test('bounded cancellation removes every durable waiter before aborting the turn', () => {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'wait-cancel',
    userId: 'u',
    workspace: '/',
  });
  state = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: 'run-1',
    startedAt: '2026-07-30T00:00:00Z',
    deadlineAt: '2026-07-30T00:30:00Z',
    budget: LIMITED_RESOURCE_BUDGET_,
  });
  state = reduceRuntimeState(state, {
    type: 'resource_budget.waiter_enqueued',
    waiter: {
      version: 1,
      runId: 'run-1',
      invocationId: 'tool:queued',
      requiredPermits: ['tool'],
      sequence: 0,
      enqueuedAt: '2026-07-30T00:00:01Z',
      deadlineAt: '2026-07-30T00:00:10Z',
      state: 'waiting',
    },
  });

  const events = eventsForRunCancellation(state, 'Run deadline exceeded.', 'error');
  expect(events.map((event) => event.type)).toEqual([
    'resource_budget.waiter_cancelled',
    'turn.aborted',
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', cause: 'error' });
  const cancelled = events.reduce(reduceRuntimeState, state);
  expect(cancelled.resourceBudget).toMatchObject({
    status: 'active',
    waiters: { 'tool:queued': { state: 'cancelled' } },
  });
});

test('approval ignores grants that were not offered by the pending interaction', () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'auth',
    userId: 'u',
    workspace: '/',
  });
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'tool-1',
    approval: {
      scope: 'once',
      cwd: '/',
      threadId: 'auth',
      tool: 'write_file',
      command: 'write_file /tmp/example',
      risk: 'write_file',
      approvalHash: 'hash',
      summary: 'Write file',
      reason: 'test',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    },
  };

  expect(
    eventsForRuntimeAction(state, {
      type: 'approve',
      interactionId: 'approval-1',
      grant: 'same_command',
    }),
  ).toEqual([]);
});
