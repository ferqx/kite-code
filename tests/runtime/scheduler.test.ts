import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction } from '../../src/core/runtime/actions';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState } from '../../src/core/runtime/state';

describe('decideNextEffect', () => {
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
});
