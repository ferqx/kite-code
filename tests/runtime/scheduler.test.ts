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
});
