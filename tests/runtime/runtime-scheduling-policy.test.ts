import { describe, expect, test } from 'bun:test';
import {
  computeRuntimeSchedulingPolicyDigestV1,
  createRuntimeSchedulingPolicyV1,
} from '@/core/runtime/runtime-scheduling-policy';

describe('RuntimeSchedulingPolicyV1', () => {
  test('exports the canonical scheduler snapshot consumed by release tooling', () => {
    const policy = createRuntimeSchedulingPolicyV1();
    expect(policy).toMatchObject({
      version: 1,
      parallelRead: { ceiling: 4, barrier: 'interaction_write_or_unknown' },
      parallelSubagent: {
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
    expect(policy.parallelRead.allowlist).toContain('read_file');
    expect(computeRuntimeSchedulingPolicyDigestV1(policy)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeRuntimeSchedulingPolicyDigestV1()).toBe(
      computeRuntimeSchedulingPolicyDigestV1(structuredClone(policy)),
    );
  });
});
