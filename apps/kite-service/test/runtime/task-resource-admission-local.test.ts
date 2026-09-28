import { describe, expect, test } from 'bun:test';
import { createToolRecoveryJournal } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { createMockModel } from '../../../../tests/helpers/mock-model';
import {
  executeTestRuntimeTools,
  testSubagentComposition,
} from '../../../../tests/helpers/runtime-model';
import { createPipelineSubagentRuntime } from '../../src/bootstrap/runtime/subagent/pipeline-runtime';

const taskConfig = {
  apiKey: 'unused',
  baseURL: 'https://example.invalid',
  providerName: 'fixture',
  providerType: 'openai-compatible' as const,
  modelName: 'fixture',
  sandbox: { enabled: false },
};

async function runTaskWithChildResourceFailure(
  reason: 'tool_concurrency_saturated' | 'shell_concurrency_saturated' | 'budget_exhausted',
) {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: `task-${reason}`,
    userId: 'user',
    workspace: process.cwd(),
  });
  state.tools.calls.task = {
    toolCallId: 'task',
    modelInvocationId: 'parent-model',
    modelMessageId: 'parent-message',
    name: 'task',
    args: { subagent_type: 'review', task: 'Inspect the workspace.' },
    status: 'queued',
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'task'];
  const runtime = createPipelineSubagentRuntime(() => testSubagentComposition());
  return executeTestRuntimeTools({
    state,
    toolCallIds: ['task'],
    taskConfig,
    taskModel: createMockModel([]),
    subagentRuntimeFactory: () => ({
      ...runtime,
      start: async (deps) => ({
        ok: false,
        summary: 'Child permit wait timed out.',
        error: 'Child permit wait timed out.',
        terminalStatus: 'failed',
        toolCallCount: 0,
        durationMs: 0,
        steps: [],
        executionJournal: [],
        exhaustedFingerprints: {},
        toolRecovery: createToolRecoveryJournal(deps.recoveryIdentityKey),
        resourceAdmissionFailure: {
          reason,
          message: 'Child permit wait timed out.',
          parentInvocationId: deps.subagentInvocationIdentity!.invocationId,
          parentToolCallId: deps.modelInvocationParentToolCallId!,
          childInvocationId: 'fixture-child',
        },
      }),
    }),
  });
}

describe('committed child resource admission failure', () => {
  test.each([
    'tool_concurrency_saturated',
    'shell_concurrency_saturated',
  ] as const)('keeps a %s failure on the Task Tool instead of aborting the parent Run', async (reason) => {
    const events = await runTaskWithChildResourceFailure(reason);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'task',
        failure: expect.objectContaining({ kind: 'resource_saturated' }),
      }),
    );
    expect(
      events.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
    ).toBe(false);
  });

  test('keeps shared budget exhaustion at the Run recovery boundary', async () => {
    await expect(runTaskWithChildResourceFailure('budget_exhausted')).rejects.toMatchObject({
      reason: 'budget_exhausted',
    });
  });
});
