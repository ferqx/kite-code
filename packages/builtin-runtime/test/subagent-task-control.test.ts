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
});
