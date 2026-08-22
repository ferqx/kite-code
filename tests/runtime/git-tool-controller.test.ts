import { describe, expect, test } from 'bun:test';
import type { GitBrokerV1 } from '@kite/builtin-runtime/git';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import type { AgentConfig } from '#app/config/index';
import { State26HostSessionHarnessV1 as AgentKernel } from '../../scripts/support/runtime-host-state26';
import { openState26Store5ForTestV1 } from '../../scripts/support/runtime-storage';
import { executeTestRuntimeToolsV1 } from '../helpers/runtime-model';

function config(): AgentConfig {
  return {
    features: { brokeredGitV1: true },
    executionCapabilitySurface: {
      inProcessReadOnlyTools: null,
      network: false,
      process: true,
      write: true,
      workspaceWrite: true,
      shell: true,
      skillChild: false,
      localStdioMcp: false,
      gitInspect: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
    },
  } as AgentConfig;
}

describe('ACORE-GIT Controller and Kernel integration', () => {
  test('Registry failure persists one strict typed outcome with stable Git detail and no replay', async () => {
    let inspectDispatches = 0;
    const broker: GitBrokerV1 = {
      featureRevision: 'brokered-git-r1',
      inspect: async () => {
        inspectDispatches++;
        return {
          ok: false,
          output: 'Protected Git path is denied.',
          failureCode: 'protected_path_denied',
          nextCapability: 'git_inspect',
        };
      },
    };
    const store = openState26Store5ForTestV1(':memory:');
    const kernel = new AgentKernel({
      store,
      interactionMode: 'accept_edits',
      initialState: createRuntimeHostState26InitialStateV1({
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
      const events = await executeTestRuntimeToolsV1({
        state: kernel.getState(),
        toolCallIds: ['git-inspect'],
        gitBroker: broker,
        taskConfig: config(),
      });
      expect(inspectDispatches).toBe(1);
      expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
      kernel.processEventBatch(events);
      expect(kernel.getState().tools.calls['git-inspect']?.outcomeV1).toMatchObject({
        status: 'failed',
        failure: { kind: 'tool_runtime_error', detailCode: 'protected_path_denied' },
        dispatchState: 'started',
        externalEffects: 'none',
        recovery: { disposition: 'never', maximumAdditionalCalls: 0 },
      });
    } finally {
      kernel.close();
    }
  });
});
