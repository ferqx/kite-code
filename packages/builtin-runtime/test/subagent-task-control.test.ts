import { describe, expect, test } from 'bun:test';
import { createBuiltinRuntimeModules } from '@kite-ai/builtin-runtime';
import { SUBAGENT_CAPABILITY_REVISIONS_ } from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';

describe('Builtin background task control projection', () => {
  for (const [operationId, method] of [
    ['builtin:task_read', 'readTask'],
    ['builtin:task_cancel', 'cancelTask'],
  ] as const) {
    test(`${operationId} projects the exact task terminal into resultMeta`, async () => {
      const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
      const executor = registry.executor(operationId);
      if (!executor) throw new Error(`${operationId} executor is unavailable.`);
      const revision = SUBAGENT_CAPABILITY_REVISIONS_[operationId];
      const calls: string[] = [];
      const control = {
        readTask: async (taskId: string) => {
          calls.push(`read:${taskId}`);
          return { ok: true, task_id: taskId, status: 'completed' };
        },
        cancelTask: async (taskId: string) => {
          calls.push(`cancel:${taskId}`);
          return { ok: true, task_id: taskId, status: 'cancelled' };
        },
      };
      const receipt = await executor.execute(
        {
          invocationId: `${method}-invocation`,
          capabilityId: operationId,
          capabilityRevision: revision,
          input: { task_id: 'child-1' },
        },
        {
          grant: {
            grantId: 'grant-1',
            capabilityId: operationId,
            capabilityRevision: revision,
            authority: {},
          },
          requestDigest: 'request-digest',
          signal: new AbortController().signal,
          environment: {
            environmentId: 'test',
            kind: 'in_process',
            mechanisms: Object.freeze({ taskControl: Object.freeze(control) }),
          },
          attempt: { invocationId: `${method}-invocation`, attemptId: 'attempt-1' },
        },
      );
      expect(receipt.status).toBe('succeeded');
      if (receipt.status !== 'succeeded') throw new Error('task control receipt failed');
      if (!receipt.value || typeof receipt.value !== 'object' || Array.isArray(receipt.value)) {
        throw new Error('task control value is malformed');
      }
      const value = receipt.value as Readonly<Record<string, unknown>>;
      expect(value.resultMeta).toEqual({
        taskId: 'child-1',
        taskStatus: method === 'readTask' ? 'completed' : 'cancelled',
      });
      expect(calls).toEqual([`${method === 'readTask' ? 'read' : 'cancel'}:child-1`]);
    });
  }

  test('task_wait forwards distinct task identities, the default timeout, and cancellation signal', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const operationId = 'builtin:task_wait' as const;
    const executor = registry.executor(operationId);
    if (!executor) throw new Error(`${operationId} executor is unavailable.`);
    const revision = SUBAGENT_CAPABILITY_REVISIONS_[operationId];
    const controller = new AbortController();
    const calls: unknown[] = [];
    const receipt = await executor.execute(
      {
        invocationId: 'wait-invocation',
        capabilityId: operationId,
        capabilityRevision: revision,
        input: { task_ids: ['child-1', 'child-2'] },
      },
      {
        grant: {
          grantId: 'grant-1',
          capabilityId: operationId,
          capabilityRevision: revision,
          authority: {},
        },
        requestDigest: 'request-digest',
        signal: controller.signal,
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms: Object.freeze({
            taskControl: Object.freeze({
              waitTasks: async (
                taskIds: readonly string[],
                timeoutMs: number,
                signal?: AbortSignal,
              ) => {
                calls.push([taskIds, timeoutMs, signal]);
                return { ok: true, status: 'completed', reason: 'terminal', cursor: 4 };
              },
            }),
          }),
        },
        attempt: { invocationId: 'wait-invocation', attemptId: 'attempt-1' },
      },
    );
    expect(receipt.status).toBe('succeeded');
    if (receipt.status !== 'succeeded') throw new Error('task wait receipt failed');
    expect(receipt.value).toMatchObject({
      resultMeta: {
        taskIds: ['child-1', 'child-2'],
        taskStatus: 'completed',
        reason: 'terminal',
        cursor: 4,
      },
    });
    expect(calls).toEqual([[['child-1', 'child-2'], 30_000, controller.signal]]);
  });

  test('an observed child failure is readable without failing task_read or task_wait', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    for (const operationId of ['builtin:task_read', 'builtin:task_wait'] as const) {
      const executor = registry.executor(operationId);
      if (!executor) throw new Error(`${operationId} executor is unavailable.`);
      const receipt = await executor.execute(
        {
          invocationId: `${operationId}-failed-child`,
          capabilityId: operationId,
          capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
          input:
            operationId === 'builtin:task_read'
              ? { task_id: 'child-1' }
              : { task_ids: ['child-1'], timeout_ms: 10 },
        },
        {
          grant: {
            grantId: 'grant-1',
            capabilityId: operationId,
            capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
            authority: {},
          },
          requestDigest: 'request-digest',
          signal: new AbortController().signal,
          environment: {
            environmentId: 'test',
            kind: 'in_process',
            mechanisms: Object.freeze({
              taskControl: Object.freeze({
                readTask: async () => ({ ok: false, task_id: 'child-1', status: 'failed' }),
                waitTasks: async () => ({
                  ok: false,
                  status: 'failed',
                  tasks: [{ ok: false, task_id: 'child-1', status: 'failed' }],
                }),
              }),
            }),
          },
          attempt: { invocationId: `${operationId}-failed-child`, attemptId: 'attempt-1' },
        },
      );
      expect(receipt.status).toBe('succeeded');
      if (receipt.status !== 'succeeded') throw new Error('task control receipt failed');
      expect(receipt.value).toMatchObject({ ok: true, stderr: '' });
      const value = receipt.value as { stdout: string };
      expect(JSON.parse(value.stdout)).toMatchObject({ ok: false, status: 'failed' });
    }
  });

  test('a foreign task identity remains a failed status operation', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    for (const operationId of ['builtin:task_read', 'builtin:task_wait'] as const) {
      const executor = registry.executor(operationId);
      if (!executor) throw new Error(`${operationId} executor is unavailable.`);
      const revision = SUBAGENT_CAPABILITY_REVISIONS_[operationId];
      const receipt = await executor.execute(
        {
          invocationId: `${operationId}-foreign-task`,
          capabilityId: operationId,
          capabilityRevision: revision,
          input:
            operationId === 'builtin:task_read'
              ? { task_id: 'foreign' }
              : { task_ids: ['foreign'], timeout_ms: 0 },
        },
        {
          grant: {
            grantId: 'grant-1',
            capabilityId: operationId,
            capabilityRevision: revision,
            authority: {},
          },
          requestDigest: 'request-digest',
          signal: new AbortController().signal,
          environment: {
            environmentId: 'test',
            kind: 'in_process',
            mechanisms: Object.freeze({
              taskControl: Object.freeze({
                readTask: async () => ({ ok: false, task_id: 'foreign', status: 'not_found' }),
                waitTasks: async () => ({ ok: false, status: 'not_found', tasks: [] }),
              }),
            }),
          },
          attempt: { invocationId: `${operationId}-foreign-task`, attemptId: 'attempt-1' },
        },
      );
      expect(receipt.status).toBe('succeeded');
      expect(receipt.value).toMatchObject({ ok: false, stdout: '' });
    }
  });
});
