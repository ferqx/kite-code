import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction } from '../../src/core/runtime/actions';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

describe('decideNextEffect', () => {
  test('stops the current turn after auto compaction failure and retries admission next turn', () => {
    const state = createInitialRuntimeState({ threadId: 'compact', userId: 'u', workspace: '/' });
    const failedTurnId = state.turn.turnId;
    state.context.lastFailure = {
      compactionId: 'failed-auto',
      sourceRevision: state.revision,
      errorKind: 'summary_model_failed',
      message: 'provider rejected summary',
      retryable: true,
      reason: 'auto',
      requestedAtTurnId: failedTurnId,
    };

    expect(decideNextEffect(state)).toEqual({ type: 'stop' });

    const nextTurn = reduceRuntimeState(state, { type: 'turn.started', turnId: 'next-turn' });
    expect(decideNextEffect(nextTurn)).toEqual({ type: 'call_model' });
  });

  test('gates model execution on the first required provider admission', () => {
    const state = createInitialRuntimeState({ threadId: 'provider', userId: 'u', workspace: '/' });
    const record = {
      interactionId: 'admission',
      providerId: 'github',
      source: 'project' as const,
      providerStatus: 'login_required' as const,
      diagnosticCode: 'auth_required' as const,
      retryable: false,
    };
    state.providerAdmission.pending = [record];
    state.interactions = { kind: 'awaiting_provider_admission', ...record };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_provider_admission',
      interactionId: 'admission',
      providerId: 'github',
      providerStatus: 'login_required',
      retryable: false,
    });
  });

  test('schedules a provider action without requeueing its terminal tool', () => {
    const state = createInitialRuntimeState({ threadId: 'provider', userId: 'u', workspace: '/' });
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: {},
      status: 'failed',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
      status: 'required',
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
    });
    expect(state.tools.queue).toEqual([]);
    expect(state.tools.active).toEqual([]);
  });

  test('blocks scheduling until an unknown external invocation is reconciled', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.capabilities.invocations.unknown = {
      invocationId: 'unknown',
      toolCallId: 'mcp-call',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision',
      argumentsDigest: 'args',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'unknown',
      recordedAt: '2026-07-14T00:00:00.000Z',
      finishedAt: '2026-07-14T00:00:01.000Z',
    };
    expect(decideNextEffect(state)).toMatchObject({
      type: 'recovery_blocked',
      reason: expect.stringContaining('unknown external outcome'),
    });
    const events = eventsForRuntimeAction(state, {
      type: 'reconcile_invocation',
      invocationId: 'unknown',
      decision: 'confirmed_success',
    });
    const reconciled = reduceRuntimeState(state, events[0]!);
    expect(reconciled.capabilities.invocations.unknown?.status).toBe('succeeded');
    expect(decideNextEffect(reconciled)).toEqual({ type: 'call_model' });
  });

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

  test('picks approved tool from active list (sub-agent approval resume)', () => {
    // Bug reproduction: after tool.started moves a tool from queue → active,
    // and the tool is later approved (approval.granted), the scheduler must
    // find it in active to issue run_tools, not fall through to call_model.
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    // Tool was started → moved to active, not in queue
    state.tools.active.push('task-tool');
    state.tools.calls['task-tool'] = {
      toolCallId: 'task-tool',
      modelMessageId: '',
      name: 'task',
      args: {},
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    // Queue is empty — approval.granted cleared interaction, but tool stayed in active
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['task-tool'] });
  });

  test('prefers queued tools over active tools', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    // Queued tool
    state.tools.queue.push('queued-tool');
    state.tools.calls['queued-tool'] = {
      toolCallId: 'queued-tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    // Active approved tool
    state.tools.active.push('active-tool');
    state.tools.calls['active-tool'] = {
      toolCallId: 'active-tool',
      modelMessageId: '',
      name: 'task',
      args: {},
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    // Queue takes priority
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['queued-tool'] });
  });

  test('resumes a queued tool after auto-review approval', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('shell-tool');
    state.tools.calls['shell-tool'] = {
      toolCallId: 'shell-tool',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'printf ok' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    const approval = {
      risk: 'execute_code',
      summary: 'Run shell command',
      reason: 'Needs review',
      command: 'printf ok',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    };
    const awaiting = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'review-1',
      toolCallId: 'shell-tool',
      toolName: 'shell_execute',
      reason: 'Needs review',
      approval: approval as never,
    });
    const approved = reduceRuntimeState(awaiting, {
      type: 'auto_review.completed',
      reviewId: 'review-1',
      toolCallId: 'shell-tool',
      result: {
        ok: true,
        approved: true,
        grant: 'approve_once',
        reviewerModelName: 'test',
        durationMs: 1,
      },
    });

    expect(approved.interactions.kind).toBe('idle');
    expect(decideNextEffect(approved)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-tool'],
    });
  });

  test('collects sibling shell decisions before starting the approved batch', () => {
    let state = createInitialRuntimeState({
      threadId: 'parallel-shell-approvals',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'parallel-shell-model';
    for (const [ordinal, toolCallId] of ['shell-1', 'shell-2', 'shell-3'].entries()) {
      state.tools.queue.push(toolCallId);
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId,
        ordinal,
        name: 'shell_execute',
        args: { command: `node task-${ordinal + 1}.js` },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
    }
    const approval = {
      risk: 'execute_code',
      summary: 'Run shell command',
      reason: 'Needs review',
      command: 'node task.js',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    };

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      grant: 'approve_once',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-2'],
    });

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-2',
      toolCallId: 'shell-2',
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.rejected',
      interactionId: 'approval-2',
      reason: 'Rejected by user.',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-3'],
    });

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-3',
      toolCallId: 'shell-3',
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-3',
      grant: 'approve_once',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-1', 'shell-3'],
    });
  });

  test('does not batch shell calls across an interaction barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 'shell-interaction-barrier',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'mixed-tool-model';
    state.tools.queue.push('shell-before', 'question', 'shell-after');
    state.tools.calls['shell-before'] = {
      toolCallId: 'shell-before',
      modelMessageId,
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.question = {
      toolCallId: 'question',
      modelMessageId,
      ordinal: 1,
      name: 'ask_user',
      args: { question: 'Continue?' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-after'] = {
      toolCallId: 'shell-after',
      modelMessageId,
      ordinal: 2,
      name: 'shell_execute',
      args: { command: 'git status' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-before'],
    });
  });

  test('stops when all tools from the latest model response are rejected', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    const apprFailure = {
      kind: 'approval_rejected' as const,
      message: 'Rejected',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'rejected',
      failure: apprFailure,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'rejected',
      failure: apprFailure,
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('calls model when not all tools from the latest model response are rejected', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'rejected',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });

  test('stops when all tools from the latest model response are cancelled', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    const cancFailure = {
      kind: 'approval_rejected' as const,
      message: 'Cancelled',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'cancelled',
      failure: cancFailure,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'cancelled',
      failure: cancFailure,
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('stops when a single tool from the latest model response is rejected', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [{ id: 'shell-1', name: 'shell_execute', args: { command: 'rm -rf /' } }],
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'rm -rf /' },
      status: 'rejected',
      failure: {
        kind: 'approval_rejected' as const,
        message: 'Rejected',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('skips the rejection stop when the latest assistant message has no tool calls', () => {
    // When the last assistant message is text-only, fall through to call_model.
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: 'model-msg',
      toolCalls: [],
    });
    // Even with stray rejected calls from a prior message, the check only
    // considers the *latest* assistant message with tool calls — and there is none.
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'stale',
      name: 'shell_execute',
      args: {},
      status: 'rejected',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });
});
