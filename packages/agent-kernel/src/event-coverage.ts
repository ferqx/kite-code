import { CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, type RuntimeEventType } from './events';

export type State26ReducerOwner =
  | 'core/authorization'
  | 'core/completion'
  | 'core/intent'
  | 'core/lease'
  | 'core/lifecycle'
  | 'domains/capability'
  | 'domains/context'
  | 'domains/interaction'
  | 'domains/recovery'
  | 'domains/verification'
  | 'domains/work';

/**
 * Auditable one-owner classification of all 136 State26 discriminants. The
 * reducer implementation may observe a fact in a secondary journal reducer,
 * but this table names the single primary state owner for replay review.
 */
export const STATE26_EVENT_REDUCER_COVERAGE: Readonly<
  Record<State26ReducerOwner, readonly RuntimeEventType[]>
> = Object.freeze({
  'core/authorization': [
    'approval.command_replaced',
    'approval.granted',
    'approval.rejected',
    'approval.requested',
    'authorization.changed',
    'auto_review.completed',
    'auto_review.requested',
    'interaction_mode.changed',
  ],
  'core/completion': [
    'completion.blocked',
    'provider.data_policy_status',
    'run.completed',
    'run.error',
    'runtime.action_ignored',
    'turn.aborted',
    'turn.completed',
  ],
  'core/intent': [
    'mcp.egress_decided',
    'network.admission_decided',
    'tool.cancelled',
    'tool.failed',
    'tool.file_change',
    'tool.finished',
    'tool.progress',
    'tool.queued',
    'tool.rejected',
    'tool.retry_recorded',
    'tool.started',
  ],
  'core/lease': [
    'provider.readiness_attempt_started',
    'provider.readiness_failed',
    'provider.readiness_intent_recorded',
    'provider.readiness_succeeded',
    'provider.readiness_waiter_registered',
    'resource_budget.configured',
    'resource_budget.dispatch_started',
    'resource_budget.reconciled',
    'resource_budget.released',
    'resource_budget.reserved',
    'resource_budget.unknown',
    'resource_budget.waiter_cancelled',
    'resource_budget.waiter_enqueued',
    'resource_budget.waiter_promoted',
    'resource_budget.waiter_timed_out',
  ],
  'core/lifecycle': [
    'plan.completed',
    'plan.drafted',
    'plan.progress_updated',
    'planning.entered',
    'planning.exited',
    'task.cancelled',
    'task.completed',
    'task.started',
    'turn.started',
    'user.command_invoked',
  ],
  'domains/capability': [
    'capability.bindings_issued',
    'capability.execution_failed',
    'capability.execution_result_recorded',
    'capability.execution_started',
    'capability.execution_succeeded',
    'capability.execution_unknown',
    'capability.filesystem_intent_recorded',
    'capability.filesystem_mutation_ready',
    'capability.invocation_recorded',
    'capability.reconciliation_resolved',
    'capability.sandbox_disposal_completed',
    'capability.sandbox_disposal_started',
    'capability.sandbox_execution_dispatch_intent_recorded',
    'capability.sandbox_execution_supervisor_started',
    'capability.sandbox_preparation_abandonment_completed',
    'capability.sandbox_preparation_abandonment_started',
    'capability.sandbox_preparation_intent_recorded',
    'capability.sandbox_preparation_ready',
    'capability.search_completed',
    'capability.subagent_cleanup_completed',
    'capability.subagent_cleanup_started',
    'capability.subagent_dispatch_intent_recorded',
    'capability.subagent_handle_recorded',
    'capability.subagent_observation_recorded',
  ],
  'domains/context': [
    'context.compaction_completed',
    'context.compaction_failed',
    'context.compaction_requested',
    'context.compaction_reset',
    'context.hard_block_cleared',
    'context.hard_blocked',
    'model.cache_metrics',
    'model.context_metrics',
    'model.invocation_attempt_started',
    'model.invocation_completed',
    'model.invocation_evidence_unavailable',
    'model.invocation_interrupted',
    'model.invocation_prepared',
    'model.reasoning_completed',
    'model.reasoning_delta',
    'model.requested',
    'model.responded',
    'model.retry',
    'model.text_delta',
    'user.message_appended',
  ],
  'domains/interaction': [
    'plan.approved',
    'plan.review_cancelled',
    'plan.review_requested',
    'plan.revision_requested',
    'provider.action_completed',
    'provider.action_deferred',
    'provider.action_failed',
    'provider.action_required',
    'provider.action_started',
    'provider.admission_cancelled',
    'provider.admission_required',
    'provider.admission_retry_failed',
    'provider.admission_retry_requested',
    'provider.admission_satisfied',
    'provider.admission_waived',
    'user_input.answered',
    'user_input.cancelled',
    'user_input.requested',
  ],
  'domains/recovery': [
    'runtime.cancellation_diagnostic',
    'subagent.approval_deferred',
    'subagent.cache_metrics',
    'subagent.completed',
    'subagent.failed',
    'subagent.recovery_journal_merged',
    'subagent.started',
    'subagent.step',
    'subagent.suspended',
    'subagent.tool_result',
  ],
  'domains/verification': [
    'verification.check_completed',
    'verification.compensation_completed',
    'verification.compensation_requested',
    'verification.completed',
    'verification.repair_requested',
    'verification.replan_requested',
    'verification.requested',
    'verification.started',
    'verification.waived',
  ],
  'domains/work': [
    'skill.activation_started',
    'skill.catalog_refreshed',
    'skill.frame_closed',
    'plan.replan_requested',
  ],
});

const COVERED_EVENT_TYPES = Object.freeze(Object.values(STATE26_EVENT_REDUCER_COVERAGE).flat());

if (
  COVERED_EVENT_TYPES.length !== Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS).length ||
  new Set(COVERED_EVENT_TYPES).size !== COVERED_EVENT_TYPES.length ||
  COVERED_EVENT_TYPES.some((type) => !Object.hasOwn(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, type))
) {
  throw new Error('State26 reducer coverage must classify every event exactly once.');
}
