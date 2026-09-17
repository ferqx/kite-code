import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-service/config/index';
import { StateHostSessionHarness as AgentKernel } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { executeTestRuntimeTools } from '../../../../tests/helpers/runtime-model';

function config(): AgentConfig {
  return { sandbox: { enabled: true } } as AgentConfig;
}

describe('ACORE-GIT Controller and Kernel integration', () => {
  test('does not dispatch internal typed Git from a model tool call', async () => {
    const store = openStateStoreForTest(':memory:');
    const kernel = new AgentKernel({
      store,
      interactionMode: 'accept_edits',
      initialState: createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'git-controller-outcome',
        userId: 'user',
        workspace: '/workspace',
      }),
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'git-inspect',
        modelMessageId: 'model-1',
        name: 'git_inspect',
        args: { operation: 'diff', paths: ['.git/config'] },
        ordinal: 0,
        effectClass: 'read_only',
        sideEffect: false,
      });
      const events = await executeTestRuntimeTools({
        state: kernel.getState(),
        toolCallIds: ['git-inspect'],
        taskConfig: config(),
      });
      expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
      kernel.processEventBatch(events);
      expect(kernel.getState().tools.calls['git-inspect']?.outcome).toMatchObject({
        status: 'failed',
        failure: { kind: 'tool_not_found' },
        dispatchState: 'not_started',
        externalEffects: 'none',
      });
    } finally {
      kernel.close();
    }
  });
});
