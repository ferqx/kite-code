import { describe, expect, test } from 'bun:test';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { createInitialRuntimeState } from '@/core/runtime/state';

describe('executeRuntimeTools', () => {
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
});
