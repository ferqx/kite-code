import { sha256Hex } from './hash';
import { MAX_PARALLEL_READ_TOOLS, MAX_PARALLEL_SUBAGENTS } from './scheduler';

export interface RuntimeSchedulingPolicyV1 {
  version: 1;
  parallelRead: {
    concurrencyGroup: 'parallel-read';
    ceiling: number;
    barrier: 'interaction_write_or_unknown';
  };
  parallelSubagent: {
    concurrencyGroup: 'parallel-subagent';
    ceiling: number;
    scope: 'same_task_and_model_message';
    admission: 'approval_free_and_shared_budget';
  };
  shellOverlap: {
    scope: 'same_task_and_model_message';
    approval: 'per_invocation';
    rejection: 'stop_undispatched_siblings';
  };
  concurrencyAdmission: {
    queue: 'fifo_per_resource';
    compoundPermits: 'atomic_all_or_none';
    deadline: 'min_wait_deadline_and_run_deadline';
    permits: readonly ['tool', 'shell_invocation'];
  };
  lateEventPolicy: 'diagnostic_or_reconciliation_only';
}

export function createRuntimeSchedulingPolicyV1(): RuntimeSchedulingPolicyV1 {
  return Object.freeze({
    version: 1 as const,
    parallelRead: Object.freeze({
      concurrencyGroup: 'parallel-read' as const,
      ceiling: MAX_PARALLEL_READ_TOOLS,
      barrier: 'interaction_write_or_unknown' as const,
    }),
    parallelSubagent: Object.freeze({
      concurrencyGroup: 'parallel-subagent' as const,
      ceiling: MAX_PARALLEL_SUBAGENTS,
      scope: 'same_task_and_model_message' as const,
      admission: 'approval_free_and_shared_budget' as const,
    }),
    shellOverlap: Object.freeze({
      scope: 'same_task_and_model_message' as const,
      approval: 'per_invocation' as const,
      rejection: 'stop_undispatched_siblings' as const,
    }),
    concurrencyAdmission: Object.freeze({
      queue: 'fifo_per_resource' as const,
      compoundPermits: 'atomic_all_or_none' as const,
      deadline: 'min_wait_deadline_and_run_deadline' as const,
      permits: ['tool', 'shell_invocation'] as const,
    }),
    lateEventPolicy: 'diagnostic_or_reconciliation_only' as const,
  });
}

export function computeRuntimeSchedulingPolicyDigestV1(
  policy = createRuntimeSchedulingPolicyV1(),
): string {
  return `sha256:${sha256Hex(`kite.runtime-scheduling-policy.v1\0${JSON.stringify(policy)}`)}`;
}
