import { expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import type { BackgroundSubagentControlRuntime } from '../src/bootstrap/runtime/subagent/background-runtime';
import { createCombinedTaskControl } from '../src/runtime/tool-execution/router';

test('routes proved followup task IDs without an original lifecycle entry', async () => {
  const state = createRuntimeHostStateInitialState({
    threadId: 'parent',
    userId: 'user',
    workspace: '/workspace',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const calls: string[] = [];
  const control = createCombinedTaskControl({
    state,
    independent: {
      ownsTask: (taskId) => taskId === 'followup-task',
      readTask: async (taskId) => {
        calls.push(`read:${taskId}`);
        return { ok: true, task_id: taskId, status: 'completed', text: 'Followup report' };
      },
      waitTasks: async (taskIds) => {
        calls.push(`wait:${taskIds.join(',')}`);
        return { ok: true, status: 'completed', tasks: [] };
      },
      cancelTask: async (taskId) => {
        calls.push(`cancel:${taskId}`);
        return { ok: true, status: 'completed', cancelled: false };
      },
    },
  });
  expect(await control.readTask('followup-task')).toMatchObject({
    status: 'completed',
    text: 'Followup report',
  });
  expect(await control.waitTasks(['followup-task'], 0)).toMatchObject({ status: 'completed' });
  expect(await control.cancelTask('followup-task')).toMatchObject({ cancelled: false });
  expect(calls).toEqual(['read:followup-task', 'wait:followup-task', 'cancel:followup-task']);
  expect(await control.readTask('foreign-task')).toMatchObject({ status: 'not_found' });
  expect(await control.cancelTask('foreign-task')).toMatchObject({ status: 'not_found' });
  expect(await control.waitTasks(['foreign-task'], 0)).toMatchObject({ status: 'not_found' });
  expect(calls).toHaveLength(3);
});

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
