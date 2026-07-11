import { describe, expect, test } from 'bun:test';
import { executeRuntimeTools, toRuntimeSubagentEvent } from '@/core/controllers/tool-controller';
import { createInitialRuntimeState } from '@/core/runtime/state';

describe('executeRuntimeTools', () => {
  test('converts delegated lifecycle facts to the public RuntimeEvent protocol', () => {
    expect(
      toRuntimeSubagentEvent({
        type: 'start',
        data: { id: 'sub-1', role: 'explore', task: 'find callers' },
      }),
    ).toEqual({
      type: 'subagent.started',
      subagent: { id: 'sub-1', role: 'explore', task: 'find callers' },
    });
  });

  test('emits a rejection without executing a policy-denied tool', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-tool-policy',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'node -e "process.exit(0)"' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('denied');
    let executed = false;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['denied'],
      shellExecutor: async () => {
        executed = true;
        return { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executed).toBe(false);
    expect(events).toEqual([
      {
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason: 'Rejected shell_execute during planning phase.',
      },
    ]);
  });

  test('finishes write_plan once and returns the persisted plan identity', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-write',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'model',
      name: 'write_plan',
      args: {
        title: 'Inspect runtime',
        body_markdown: 'Inspect the runtime lifecycle and verify every transition.',
        steps: [{ id: 'inspect-runtime', title: 'Inspect runtime lifecycle' }],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('write');

    const events = await executeRuntimeTools({ state, toolCallIds: ['write'] });

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toBeDefined();
    if (finished?.type === 'tool.finished') {
      expect(finished.name).toBe('write_plan');
      expect(JSON.parse(finished.result.stdout)).toMatchObject({
        ok: true,
        version: 1,
        review_required: false,
      });
    }
  });

  test('cancels later sibling calls when exit_plan_mode opens review', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-barrier',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    const document = {
      planId: 'plan-1',
      version: 1,
      title: 'Inspect',
      bodyMarkdown: 'Inspect runtime state transitions in detail.',
      steps: [{ id: 'inspect', title: 'Inspect runtime', status: 'pending' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    };
    state.planning = { kind: 'planning_draft', document };
    state.tools.calls.exit = {
      toolCallId: 'exit',
      modelMessageId: 'message-1',
      ordinal: 0,
      name: 'exit_plan_mode',
      args: { plan_id: 'plan-1', expected_version: 1, expected_digest: 'digest' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'message-1',
      ordinal: 1,
      name: 'write_file',
      args: { path: 'unsafe.txt', content: 'unsafe' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('exit', 'write');

    const events = await executeRuntimeTools({ state, toolCallIds: ['exit'] });

    expect(events).toContainEqual({
      type: 'tool.cancelled',
      toolCallId: 'write',
      reason: 'Cancelled because an earlier tool call opened an interaction.',
    });
  });
});
