import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';

export type RuntimeClientEventCoverageDecision =
  | 'client_visible'
  | 'internal_only'
  | 'client_unavailable'
  | 'normalized_by';

const CLIENT_VISIBLE = [
  'approval.granted',
  'approval.batch_released',
  'approval.rejected',
  'approval.requested',
  'auto_review.completed',
  'auto_review.requested',
  'context.compaction_completed',
  'context.compaction_failed',
  'context.compaction_requested',
  'context.compaction_reset',
  'interaction_mode.changed',
  'model.cache_metrics',
  'model.reasoning_completed',
  'model.reasoning_delta',
  'model.requested',
  'model.responded',
  'model.retry',
  'model.text_delta',
  'plan.approved',
  'plan.completed',
  'plan.progress_updated',
  'plan.review_cancelled',
  'plan.review_requested',
  'plan.revision_requested',
  'planning.entered',
  'planning.exited',
  'provider.action_completed',
  'provider.action_deferred',
  'provider.action_failed',
  'provider.action_required',
  'provider.admission_cancelled',
  'provider.admission_required',
  'provider.admission_satisfied',
  'provider.admission_waived',
  'run.completed',
  'run.error',
  'subagent.approval_deferred',
  'subagent.completed',
  'subagent.failed',
  'subagent.started',
  'subagent.step',
  'subagent.suspended',
  'subagent.tool_result',
  'task.cancelled',
  'task.completed',
  'tool.cancelled',
  'tool.failed',
  'tool.file_change',
  'tool.finished',
  'tool.progress',
  'tool.queued',
  'tool.rejected',
  'tool.started',
  'turn.aborted',
  'turn.completed',
  'user.message_appended',
  'user_input.answered',
  'user_input.cancelled',
  'user_input.requested',
  'verification.completed',
  'verification.requested',
  'verification.started',
  'verification.waived',
] as const satisfies readonly RuntimeEvent['type'][];

const INTERNAL_ONLY = [
  'approval.command_replaced',
  'approval.session_grants_cleared',
  'capability.bindings_issued',
  'capability.execution_failed',
  'capability.execution_started',
  'capability.execution_result_recorded',
  'capability.execution_succeeded',
  'capability.execution_unknown',
  'capability.filesystem_mutation_ready',
  'capability.filesystem_intent_recorded',
  'capability.sandbox_preparation_intent_recorded',
  'capability.sandbox_preparation_ready',
  'capability.sandbox_execution_dispatch_intent_recorded',
  'capability.sandbox_execution_supervisor_started',
  'capability.sandbox_disposal_started',
  'capability.sandbox_disposal_completed',
  'capability.sandbox_preparation_abandonment_started',
  'capability.sandbox_preparation_abandonment_completed',
  'capability.subagent_dispatch_intent_recorded',
  'capability.subagent_handle_recorded',
  'capability.subagent_observation_recorded',
  'capability.subagent_cleanup_started',
  'capability.subagent_cleanup_completed',
  'capability.invocation_recorded',
  'capability.reconciliation_resolved',
  'capability.search_completed',
  'completion.blocked',
  'context.hard_block_cleared',
  'context.hard_blocked',
  'model.context_metrics',
  'model.invocation_attempt_started',
  'model.invocation_completed',
  'model.invocation_evidence_unavailable',
  'model.invocation_interrupted',
  'model.invocation_prepared',
  'network.admission_decided',
  'provider.admission_retry_failed',
  'provider.admission_status',
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
  'runtime.action_ignored',
  'runtime.cancellation_diagnostic',
  'skill.activation_started',
  'skill.catalog_refreshed',
  'skill.frame_closed',
  'subagent.cache_metrics',
  'subagent.recovery_journal_merged',
  'tool.retry_recorded',
  'user.command_invoked',
  'verification.check_completed',
  'verification.compensation_completed',
  'verification.compensation_requested',
  'verification.repair_requested',
  'verification.replan_requested',
] as const satisfies readonly RuntimeEvent['type'][];

const NORMALIZED_BY = [
  'plan.drafted',
  'plan.replan_requested',
  'provider.action_started',
  'provider.admission_retry_requested',
  'session.rewind_requested',
  'session.rewind_completed',
  'session.rewind_failed',
  'task.started',
  'turn.started',
] as const satisfies readonly RuntimeEvent['type'][];

const CLIENT_UNAVAILABLE = [] as const satisfies readonly RuntimeEvent['type'][];

type ClassifiedEventType =
  | (typeof CLIENT_VISIBLE)[number]
  | (typeof INTERNAL_ONLY)[number]
  | (typeof NORMALIZED_BY)[number]
  | (typeof CLIENT_UNAVAILABLE)[number];

const ALL_CURRENT_EVENTS_CLASSIFIED: Exclude<
  RuntimeEvent['type'],
  ClassifiedEventType
> extends never
  ? true
  : never = true;
void ALL_CURRENT_EVENTS_CLASSIFIED;

const decisions = new Map<RuntimeEvent['type'], RuntimeClientEventCoverageDecision>();
for (const [decision, types] of [
  ['client_visible', CLIENT_VISIBLE],
  ['internal_only', INTERNAL_ONLY],
  ['client_unavailable', CLIENT_UNAVAILABLE],
  ['normalized_by', NORMALIZED_BY],
] as const) {
  for (const type of types) {
    if (decisions.has(type)) throw new Error(`Runtime event coverage is duplicated: ${type}`);
    decisions.set(type, decision);
  }
}

export function runtimeClientEventCoverageDecision(
  type: RuntimeEvent['type'],
): RuntimeClientEventCoverageDecision {
  const decision = decisions.get(type);
  if (!decision) throw new Error(`Runtime event coverage is missing: ${type}`);
  return decision;
}

export function runtimeClientEventCoverageEntries(): ReadonlyMap<
  RuntimeEvent['type'],
  RuntimeClientEventCoverageDecision
> {
  return new Map(decisions);
}
