import { describe, expect, test } from 'bun:test';
import {
  computeRuntimeSchedulingPolicyDigest,
  createRuntimeSchedulingPolicy,
} from '@kite-ai/agent-kernel';

describe('RuntimeSchedulingPolicy', () => {
  test('exports the canonical scheduler snapshot consumed by release tooling', () => {
    const policy = createRuntimeSchedulingPolicy();
    expect(policy).toMatchObject({
      version: 1,
      parallelRead: {
        concurrencyGroup: 'parallel-read',
        ceiling: 4,
        barrier: 'interaction_write_or_unknown',
      },
      parallelSubagent: {
        concurrencyGroup: 'parallel-subagent',
        ceiling: 4,
        scope: 'same_task_and_model_message',
        admission: 'approval_free_and_shared_budget',
      },
      shellOverlap: {
        scope: 'same_task_and_model_message',
        approval: 'per_invocation',
      },
      concurrencyAdmission: {
        queue: 'fifo_per_resource',
        compoundPermits: 'atomic_all_or_none',
      },
      lateEventPolicy: 'diagnostic_or_reconciliation_only',
    });
    expect(computeRuntimeSchedulingPolicyDigest(policy)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeRuntimeSchedulingPolicyDigest()).toBe(
      computeRuntimeSchedulingPolicyDigest(structuredClone(policy)),
    );
  });
});
