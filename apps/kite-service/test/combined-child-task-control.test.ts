import { expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import type { BackgroundSubagentControlRuntime } from '../src/bootstrap/runtime/subagent/background-runtime';
import { createCombinedTaskControl } from '../src/runtime/tool-execution/router';

test('mixed task_wait wakes for an independent child and retains legacy sibling snapshots', async () => {
  const base = createInitialAgentState({
    threadId: 'parent',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const state = {
    ...base,
    capabilities: {
      ...base.capabilities,
      invocations: {
        independent: {
          subagentProviderLifecycle: {
            childInvocationId: 'independent-task',
            childSession: { childThreadId: 'child-session' },
          },
        },
      },
    },
  } as unknown as RuntimeState;
  let independentFinished = false;
  let independentCancelCalls = 0;
  let legacyWaitAborted = false;
  const control = createCombinedTaskControl({
    state,
    independent: {
      readTask: async () => ({
        ok: true,
        task_id: 'independent-task',
        status: independentFinished ? 'completed' : 'running',
      }),
      waitTasks: async () => {
        independentFinished = true;
        return { ok: true, status: 'completed', tasks: [] };
      },
      cancelTask: async () => {
        independentCancelCalls += 1;
        return { ok: true, status: 'cancelled' };
      },
    },
    legacy: {
      readTask: async () => ({ ok: true, task_id: 'legacy-task', status: 'running' }),
      waitTasks: async (
        _owner: string,
        _taskIds: readonly string[],
        _timeout: number,
        signal?: AbortSignal,
      ) =>
        await new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              legacyWaitAborted = true;
              resolve({ ok: true, status: 'timeout', tasks: [] });
            },
            { once: true },
          );
        }),
    } as unknown as BackgroundSubagentControlRuntime,
  });
  const result = await control.waitTasks(['legacy-task', 'independent-task'], 1_000);
  expect(result).toMatchObject({
    ok: true,
    status: 'completed',
    tasks: [{ status: 'running' }, { status: 'completed' }],
  });
  expect(legacyWaitAborted).toBe(true);
  expect(await control.cancelTask('independent-task')).toMatchObject({ status: 'cancelled' });
  expect(independentCancelCalls).toBe(1);
});
