import { sha256Hex } from './hash';
import { MAX_PARALLEL_SUBAGENTS } from './scheduler';

export interface RuntimeSchedulingPolicy {
  version: 1;
  parallelRead: {
    concurrencyGroup: 'parallel-read';
    batch: 'all_compatible_in_model_response';
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
    scope: 'subagent_and_writer';
    queue: 'fifo_per_resource';
    deadline: 'min_wait_deadline_and_run_deadline';
  };
  lateEventPolicy: 'diagnostic_or_reconciliation_only';
}

export function createRuntimeSchedulingPolicy(): RuntimeSchedulingPolicy {
  return Object.freeze({
    version: 1 as const,
    parallelRead: Object.freeze({
      concurrencyGroup: 'parallel-read' as const,
      batch: 'all_compatible_in_model_response' as const,
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
      scope: 'subagent_and_writer' as const,
      queue: 'fifo_per_resource' as const,
      deadline: 'min_wait_deadline_and_run_deadline' as const,
    }),
    lateEventPolicy: 'diagnostic_or_reconciliation_only' as const,
  });
}

export function computeRuntimeSchedulingPolicyDigest(
  policy = createRuntimeSchedulingPolicy(),
): string {
  return `sha256:${sha256Hex(`kite.runtime-scheduling-policy.v1\0${JSON.stringify(policy)}`)}`;
}
