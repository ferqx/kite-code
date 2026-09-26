import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { testToolPipelineComposition } from '../../../tests/helpers/runtime-model';
import { executeAppRuntimeTools } from '../src/runtime/tool-execution/router';

function childWithQueuedTool(name: string) {
  const state = createRuntimeHostStateInitialState({
    threadId: 'child-test',
    userId: 'test',
    workspace: process.cwd(),
    recoveryIdentityKey: '1'.repeat(64),
  });
  state.childSessionOrigin = {
    parentSessionId: 'parent',
    parentInvocationId: 'invocation',
    parentToolCallId: 'task-call',
    attempt: 1,
    childInvocationId: 'child-invocation',
    grantDigest: `sha256:${'2'.repeat(64)}`,
    taskArtifactRef: {
      artifactId: 'task-artifact',
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'3'.repeat(64)}`,
      byteLength: 4,
    },
    taskArtifactDigest: `sha256:${'3'.repeat(64)}`,
    taskTextDigest: `sha256:${'4'.repeat(64)}`,
    taskInputAdmitted: true,
    role: 'explore',
    fundingRunId: 'parent-run',
    delegatedReservationId: 'reservation',
    delegatedUpperBoundDigest: `sha256:${'5'.repeat(64)}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  state.tools.calls['child-tool'] = {
    toolCallId: 'child-tool',
    modelInvocationId: 'model',
    modelMessageId: 'message',
    name,
    args: {},
    status: 'queued',
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = ['child-tool'];
  return state;
}

test('independent child Tool router rejects missing or widened grant before dispatch', async () => {
  for (const [name, allowedTools] of [
    ['write_file', ['read_file']],
    ['task', ['task']],
    ['read_file', []],
  ] as const) {
    const state = childWithQueuedTool(name);
    const events = await executeAppRuntimeTools({
      state,
      toolCallIds: ['child-tool'],
      toolPipelineComposition: testToolPipelineComposition(),
      childToolCeiling: {
        grantDigest: state.childSessionOrigin!.grantDigest,
        role: 'explore',
        allowedTools,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tool.rejected');
  }
  const missing = childWithQueuedTool('read_file');
  const events = await executeAppRuntimeTools({
    state: missing,
    toolCallIds: ['child-tool'],
    toolPipelineComposition: testToolPipelineComposition(),
  });
  expect(events[0]?.type).toBe('tool.rejected');
});
