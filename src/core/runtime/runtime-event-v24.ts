import { createHash } from 'node:crypto';
import type { RuntimeEvent, RuntimeEventEnvelope } from './events';

export const CANONICAL_RUNTIME_EVENT_REGISTRY_ID_V24 = 'runtime-event-registry:v24' as const;
/** Exact top-level payload fields frozen for every v24 event discriminant. */
export const RUNTIME_EVENT_FIELDS_V24 = {
  'approval.command_replaced': ['command', 'interactionId', 'type'],
  'approval.granted': ['grant', 'interactionId', 'toolCallId', 'type'],
  'approval.rejected': ['failure', 'interactionId', 'reason', 'toolCallId', 'type'],
  'approval.requested': ['approval', 'interactionId', 'toolCallId', 'type'],
  'authorization.changed': ['commandGrants', 'mode', 'modeGrantedAt', 'modeSource', 'type'],
  'auto_review.completed': ['result', 'reviewId', 'toolCallId', 'type'],
  'auto_review.requested': ['approval', 'reason', 'reviewId', 'toolCallId', 'toolName', 'type'],
  'capability.bindings_issued': [
    'bindings',
    'catalogRevision',
    'disclosures',
    'loadedCapabilities',
    'searchId',
    'type',
  ],
  'capability.execution_failed': ['error', 'finishedAt', 'invocationId', 'type'],
  'capability.execution_started': ['invocationId', 'startedAt', 'type'],
  'capability.execution_succeeded': [
    'artifact',
    'evidenceDigest',
    'externalReferences',
    'finishedAt',
    'invocationId',
    'resultDigest',
    'type',
  ],
  'capability.execution_unknown': ['finishedAt', 'invocationId', 'reason', 'type'],
  'capability.invocation_recorded': [
    'argumentsDigest',
    'authorizationDigest',
    'capabilityId',
    'capabilityRevision',
    'effectiveEffects',
    'effectiveEffectsDigest',
    'idempotencyKey',
    'invocationId',
    'planId',
    'planStepId',
    'recordedAt',
    'taskId',
    'toolCallId',
    'type',
  ],
  'capability.reconciliation_resolved': [
    'decision',
    'invocationId',
    'reason',
    'reconciledAt',
    'type',
  ],
  'capability.search_completed': ['result', 'type'],
  'context.checkpoint_v3_rebound_v1': ['checkpoint', 'parentCheckpointId', 'proof', 'type'],
  'context.compaction_completed': [
    'checkpoint',
    'compactionId',
    'durationMs',
    'providerUsage',
    'sourceRevision',
    'type',
  ],
  'context.compaction_failed': [
    'compactionId',
    'durationMs',
    'errorKind',
    'message',
    'providerDispatchState',
    'requestedAtTurnId',
    'retryable',
    'sourceRevision',
    'type',
  ],
  'context.compaction_guard_carried_forward': ['type'],
  'context.compaction_guard_reset': ['type'],
  'context.compaction_migration_cancelled': ['compactionId', 'outcome', 'sourceRevision', 'type'],
  'context.compaction_refill_observed': ['type'],
  'context.compaction_requested': [
    'compactionId',
    'customInstructions',
    'estimate',
    'force',
    'reason',
    'requestedAtRevision',
    'requestedAtTurnId',
    'type',
  ],
  'context.compaction_reset': ['checkpointId', 'reason', 'type'],
  'context.compaction_unknown_external_outcome': [
    'compactionId',
    'reservationId',
    'sourceRevision',
    'type',
  ],
  'context.hard_block_cleared': ['reason', 'sourceDigest', 'type'],
  'context.hard_blocked': ['createdAtTurnId', 'message', 'reason', 'sourceDigest', 'type'],
  'context.normal_continuation_superseded_v1': ['attemptId', 'reason', 'type'],
  'context.normal_reprepare_consumed_v1': ['consumptionKey', 'type'],
  'context.normal_reprepare_consumption_detached_v1': ['attemptId', 'receipt', 'receiptId', 'type'],
  'context.normal_reprepare_required_v1': ['receipt', 'summaryResolutionBatchKey', 'type'],
  'context.normal_resource_resolution_required_v1': [
    'attempt',
    'continuation',
    'resourceReservationId',
    'resourceUnknownEventId',
    'terminalBatchKey',
    'type',
  ],
  'context.reclaim_commit_advanced': [
    'commit',
    'commitDigest',
    'receipt',
    'terminalBatchId',
    'type',
  ],
  'context.summary_branch_abandoned_v1': ['attemptId', 'phase', 'reason', 'type'],
  'context.summary_completed_v1': [
    'attemptId',
    'checkpoint',
    'providerDispatchState',
    'providerUsage',
    'terminalBatchKey',
    'type',
  ],
  'context.summary_dispatch_started_v1': ['attemptId', 'startBatchKey', 'type'],
  'context.summary_failed_v1': [
    'attemptId',
    'errorKind',
    'message',
    'providerDispatchState',
    'terminalBatchKey',
    'type',
  ],
  'context.summary_requested_v1': ['attempt', 'continuation', 'type'],
  'context.summary_unknown_external_outcome_v1': ['attemptId', 'terminalBatchKey', 'type'],
  'interaction_mode.changed': ['changedAt', 'mode', 'source', 'type'],
  'mcp.egress_decided': ['decision', 'toolCallId', 'type'],
  'model.cache_metrics': ['cacheHitTokens', 'cacheMissTokens', 'hitRate', 'inputTokens', 'type'],
  'model.context_metrics': [
    'contextWindowSource',
    'contextWindowTokens',
    'estimate',
    'modelName',
    'providerSafetyMarginTokens',
    'reservedOutputTokens',
    'status',
    'tokenizerSource',
    'totalInputTokens',
    'type',
    'usableInputTokens',
    'utilization',
  ],
  'model.reasoning_completed': ['segmentId', 'text', 'type'],
  'model.reasoning_delta': ['segmentId', 'text', 'type'],
  'model.requested': ['requestId', 'type'],
  'model.responded': [
    'contextEvidence',
    'createdAt',
    'durationMs',
    'inputTokens',
    'messageId',
    'outputTokens',
    'ownedToolQueue',
    'reasoningText',
    'text',
    'toolCalls',
    'type',
  ],
  'model.retry': ['attempt', 'delayMs', 'error', 'maxAttempts', 'type'],
  'model.text_delta': ['text', 'type'],
  'network.admission_decided': ['decision', 'toolCallId', 'type'],
  'plan.approved': [
    'executionMode',
    'interactionId',
    'planId',
    'structuralDigest',
    'toolCallId',
    'type',
    'version',
  ],
  'plan.completed': ['plan', 'toolCallId', 'type'],
  'plan.drafted': [
    'artifact',
    'plan',
    'planId',
    'replanReason',
    'structuralHash',
    'supersedesPlanVersion',
    'taskId',
    'toolCallId',
    'type',
    'version',
  ],
  'plan.progress_updated': ['plan', 'toolCallId', 'type'],
  'plan.rejected': [
    'interactionId',
    'planId',
    'reason',
    'structuralDigest',
    'toolCallId',
    'type',
    'version',
  ],
  'plan.replan_requested': ['reason', 'supersedesPlanVersion', 'toolCallId', 'type'],
  'plan.review_cancelled': [
    'interactionId',
    'planId',
    'reason',
    'structuralDigest',
    'toolCallId',
    'type',
    'version',
  ],
  'plan.review_requested': [
    'artifact',
    'interactionId',
    'plan',
    'planId',
    'planSummary',
    'structuralDigest',
    'taskId',
    'toolCallId',
    'type',
    'version',
  ],
  'plan.revision_requested': [
    'feedback',
    'interactionId',
    'planId',
    'structuralDigest',
    'toolCallId',
    'type',
    'version',
  ],
  'planning.entered': ['source', 'taskId', 'type'],
  'planning.exited': ['reason', 'taskId', 'type'],
  'provider.action_completed': [
    'interactionId',
    'originatingToolCallId',
    'providerDirectoryRevision',
    'type',
  ],
  'provider.action_deferred': ['interactionId', 'originatingToolCallId', 'type'],
  'provider.action_failed': ['failureCode', 'interactionId', 'originatingToolCallId', 'type'],
  'provider.action_required': [
    'action',
    'interactionId',
    'originatingToolCallId',
    'providerId',
    'type',
  ],
  'provider.action_started': ['interactionId', 'type'],
  'provider.admission_cancelled': ['interactionId', 'providerId', 'type'],
  'provider.admission_required': [
    'diagnosticCode',
    'interactionId',
    'providerId',
    'providerStatus',
    'retryable',
    'source',
    'type',
  ],
  'provider.admission_retry_failed': ['diagnosticCode', 'interactionId', 'providerStatus', 'type'],
  'provider.admission_retry_requested': ['interactionId', 'type'],
  'provider.admission_satisfied': ['interactionId', 'providerDirectoryRevision', 'type'],
  'provider.admission_waived': [
    'interactionId',
    'providerId',
    'reason',
    'source',
    'type',
    'waivedAt',
  ],
  'provider.data_policy_status': ['policyRevision', 'reason', 'registryDigest', 'status', 'type'],
  'resource_budget.configured': ['budget', 'deadlineAt', 'runId', 'startedAt', 'type'],
  'resource_budget.dispatch_started': [
    'normalReprepareConsumptionKey',
    'reservationId',
    'summaryStartBatchKey',
    'type',
  ],
  'resource_budget.reconciled': [
    'actual',
    'reservationId',
    'summaryResolutionBatchKey',
    'summaryTerminalBatchKey',
    'terminalBatchId',
    'type',
  ],
  'resource_budget.released': [
    'proof',
    'reservationId',
    'summaryDispatchGuardProof',
    'summaryTerminalBatchKey',
    'type',
  ],
  'resource_budget.reserved': [
    'normalReprepareConsumptionKey',
    'reservation',
    'summaryResolutionBatchKey',
    'summaryStartBatchKey',
    'summaryTerminalBatchKey',
    'type',
  ],
  'resource_budget.unknown': [
    'normalReprepareConsumptionKey',
    'reservationId',
    'summaryTerminalBatchKey',
    'type',
  ],
  'resource_budget.waiter_cancelled': ['invocationId', 'type'],
  'resource_budget.waiter_enqueued': ['type', 'waiter'],
  'resource_budget.waiter_promoted': ['invocationId', 'type'],
  'resource_budget.waiter_timed_out': ['invocationId', 'type'],
  'run.completed': ['outcome', 'output', 'turnId', 'type'],
  'run.error': ['effectId', 'failure', 'message', 'outcome', 'recoverable', 'turnId', 'type'],
  'runtime.action_ignored': ['interactionId', 'reason', 'type'],
  'runtime.cancellation_diagnostic': [
    'failure',
    'toolCallId',
    'type',
    'unconfirmedDescendantCount',
  ],
  'skill.activation_started': ['activation', 'type'],
  'skill.catalog_refreshed': ['catalogRevision', 'type'],
  'skill.frame_closed': ['activationId', 'closedAt', 'output', 'reason', 'status', 'type'],
  'subagent.cache_metrics': ['subagent', 'type'],
  'subagent.completed': ['subagent', 'type'],
  'subagent.failed': ['subagent', 'type'],
  'subagent.started': ['subagent', 'type'],
  'subagent.step': ['subagent', 'type'],
  'subagent.suspended': ['snapshot', 'toolCallId', 'type'],
  'subagent.tool_result': ['subagent', 'type'],
  'task.cancelled': ['reason', 'taskId', 'type'],
  'task.completed': ['taskId', 'turnId', 'type'],
  'task.started': ['taskId', 'turnId', 'type', 'userGoal'],
  'tool.cancelled': ['modelResult', 'reason', 'toolCallId', 'type'],
  'tool.execution_ready': ['toolCallId', 'type'],
  'tool.failed': ['error', 'failure', 'modelResult', 'toolCallId', 'type'],
  'tool.file_change': [
    'kind',
    'linesAdded',
    'linesRemoved',
    'path',
    'preview',
    'toolCallId',
    'type',
  ],
  'tool.finished': ['createdAt', 'modelResult', 'name', 'result', 'toolCallId', 'type'],
  'tool.progress': ['chunk', 'lineCount', 'stream', 'toolCallId', 'type'],
  'tool.queued': [
    'args',
    'bindingId',
    'capabilityId',
    'capabilityRevision',
    'classificationReason',
    'effectClass',
    'modelMessageId',
    'name',
    'ordinal',
    'resultBudgetV2',
    'sideEffect',
    'taskId',
    'toolCallId',
    'type',
  ],
  'tool.rejected': ['failure', 'modelResult', 'reason', 'toolCallId', 'type'],
  'tool.started': ['toolCallId', 'type'],
  'turn.aborted': ['cause', 'reason', 'turnId', 'type'],
  'turn.completed': ['turnId', 'type'],
  'turn.started': ['turnId', 'type'],
  'user.command_invoked': ['command', 'commandId', 'type'],
  'user.message_appended': ['content', 'createdAt', 'messageId', 'type'],
  'user_input.answered': ['answer', 'answers', 'interactionId', 'toolCallId', 'type'],
  'user_input.cancelled': ['interactionId', 'reason', 'toolCallId', 'type'],
  'user_input.requested': ['interactionId', 'request', 'toolCallId', 'type'],
  'verification.check_completed': ['result', 'type', 'verificationId'],
  'verification.compensation_completed': [
    'completedAt',
    'outcome',
    'summary',
    'type',
    'verificationId',
  ],
  'verification.compensation_requested': ['requestedAt', 'type', 'verificationId'],
  'verification.completed': ['completedAt', 'outcome', 'type', 'verificationId'],
  'verification.repair_requested': [
    'instruction',
    'repairAttempt',
    'requestedAt',
    'type',
    'verificationId',
  ],
  'verification.replan_requested': ['instruction', 'requestedAt', 'type', 'verificationId'],
  'verification.requested': ['mode', 'requestedAt', 'spec', 'taskId', 'type', 'verificationId'],
  'verification.started': ['attempt', 'startedAt', 'type', 'verificationId'],
  'verification.waived': ['actor', 'reason', 'type', 'verificationId', 'waivedAt'],
} as const satisfies Record<RuntimeEvent['type'], readonly string[]>;

/** Required top-level fields; optional fields may be omitted but never invented. */
export const REQUIRED_RUNTIME_EVENT_FIELDS_V24 = {
  'approval.command_replaced': ['command', 'interactionId', 'type'],
  'approval.granted': ['grant', 'interactionId', 'type'],
  'approval.rejected': ['interactionId', 'reason', 'type'],
  'approval.requested': ['approval', 'interactionId', 'toolCallId', 'type'],
  'authorization.changed': ['mode', 'type'],
  'auto_review.completed': ['result', 'reviewId', 'toolCallId', 'type'],
  'auto_review.requested': ['approval', 'reason', 'reviewId', 'toolCallId', 'toolName', 'type'],
  'capability.bindings_issued': ['bindings', 'catalogRevision', 'type'],
  'capability.execution_failed': ['error', 'finishedAt', 'invocationId', 'type'],
  'capability.execution_started': ['invocationId', 'startedAt', 'type'],
  'capability.execution_succeeded': [
    'evidenceDigest',
    'finishedAt',
    'invocationId',
    'resultDigest',
    'type',
  ],
  'capability.execution_unknown': ['finishedAt', 'invocationId', 'reason', 'type'],
  'capability.invocation_recorded': [
    'argumentsDigest',
    'authorizationDigest',
    'capabilityId',
    'capabilityRevision',
    'effectiveEffects',
    'effectiveEffectsDigest',
    'invocationId',
    'recordedAt',
    'toolCallId',
    'type',
  ],
  'capability.reconciliation_resolved': ['decision', 'invocationId', 'reconciledAt', 'type'],
  'capability.search_completed': ['result', 'type'],
  'context.checkpoint_v3_rebound_v1': ['checkpoint', 'parentCheckpointId', 'proof', 'type'],
  'context.compaction_completed': ['checkpoint', 'compactionId', 'sourceRevision', 'type'],
  'context.compaction_failed': [
    'compactionId',
    'errorKind',
    'message',
    'retryable',
    'sourceRevision',
    'type',
  ],
  'context.compaction_guard_carried_forward': ['type'],
  'context.compaction_guard_reset': ['type'],
  'context.compaction_migration_cancelled': ['compactionId', 'outcome', 'sourceRevision', 'type'],
  'context.compaction_refill_observed': ['type'],
  'context.compaction_requested': [
    'compactionId',
    'estimate',
    'force',
    'reason',
    'requestedAtRevision',
    'requestedAtTurnId',
    'type',
  ],
  'context.compaction_reset': ['checkpointId', 'reason', 'type'],
  'context.compaction_unknown_external_outcome': ['compactionId', 'sourceRevision', 'type'],
  'context.hard_block_cleared': ['reason', 'sourceDigest', 'type'],
  'context.hard_blocked': ['createdAtTurnId', 'message', 'reason', 'sourceDigest', 'type'],
  'context.normal_continuation_superseded_v1': ['attemptId', 'reason', 'type'],
  'context.normal_reprepare_consumed_v1': ['consumptionKey', 'type'],
  'context.normal_reprepare_consumption_detached_v1': ['attemptId', 'receipt', 'receiptId', 'type'],
  'context.normal_reprepare_required_v1': ['receipt', 'type'],
  'context.normal_resource_resolution_required_v1': [
    'attempt',
    'continuation',
    'resourceReservationId',
    'resourceUnknownEventId',
    'terminalBatchKey',
    'type',
  ],
  'context.reclaim_commit_advanced': [
    'commit',
    'commitDigest',
    'receipt',
    'terminalBatchId',
    'type',
  ],
  'context.summary_branch_abandoned_v1': ['attemptId', 'phase', 'reason', 'type'],
  'context.summary_completed_v1': [
    'attemptId',
    'checkpoint',
    'providerDispatchState',
    'terminalBatchKey',
    'type',
  ],
  'context.summary_dispatch_started_v1': ['attemptId', 'startBatchKey', 'type'],
  'context.summary_failed_v1': [
    'attemptId',
    'errorKind',
    'message',
    'providerDispatchState',
    'terminalBatchKey',
    'type',
  ],
  'context.summary_requested_v1': ['attempt', 'type'],
  'context.summary_unknown_external_outcome_v1': ['attemptId', 'terminalBatchKey', 'type'],
  'interaction_mode.changed': ['changedAt', 'mode', 'source', 'type'],
  'mcp.egress_decided': ['decision', 'toolCallId', 'type'],
  'model.cache_metrics': ['cacheHitTokens', 'cacheMissTokens', 'hitRate', 'inputTokens', 'type'],
  'model.context_metrics': ['estimate', 'modelName', 'status', 'totalInputTokens', 'type'],
  'model.reasoning_completed': ['segmentId', 'text', 'type'],
  'model.reasoning_delta': ['text', 'type'],
  'model.requested': ['requestId', 'type'],
  'model.responded': ['messageId', 'type'],
  'model.retry': ['attempt', 'delayMs', 'error', 'maxAttempts', 'type'],
  'model.text_delta': ['text', 'type'],
  'network.admission_decided': ['decision', 'toolCallId', 'type'],
  'plan.approved': ['executionMode', 'interactionId', 'type'],
  'plan.completed': ['plan', 'toolCallId', 'type'],
  'plan.drafted': ['plan', 'planId', 'structuralHash', 'toolCallId', 'type', 'version'],
  'plan.progress_updated': ['plan', 'toolCallId', 'type'],
  'plan.rejected': ['interactionId', 'reason', 'type'],
  'plan.replan_requested': ['reason', 'supersedesPlanVersion', 'toolCallId', 'type'],
  'plan.review_cancelled': ['interactionId', 'reason', 'type'],
  'plan.review_requested': ['interactionId', 'plan', 'planSummary', 'toolCallId', 'type'],
  'plan.revision_requested': ['feedback', 'interactionId', 'type'],
  'planning.entered': ['source', 'taskId', 'type'],
  'planning.exited': ['taskId', 'type'],
  'provider.action_completed': ['interactionId', 'type'],
  'provider.action_deferred': ['interactionId', 'type'],
  'provider.action_failed': ['failureCode', 'interactionId', 'type'],
  'provider.action_required': [
    'action',
    'interactionId',
    'originatingToolCallId',
    'providerId',
    'type',
  ],
  'provider.action_started': ['interactionId', 'type'],
  'provider.admission_cancelled': ['interactionId', 'providerId', 'type'],
  'provider.admission_required': [
    'interactionId',
    'providerId',
    'providerStatus',
    'retryable',
    'source',
    'type',
  ],
  'provider.admission_retry_failed': ['interactionId', 'providerStatus', 'type'],
  'provider.admission_retry_requested': ['interactionId', 'type'],
  'provider.admission_satisfied': ['interactionId', 'providerDirectoryRevision', 'type'],
  'provider.admission_waived': [
    'interactionId',
    'providerId',
    'reason',
    'source',
    'type',
    'waivedAt',
  ],
  'provider.data_policy_status': ['reason', 'status', 'type'],
  'resource_budget.configured': ['budget', 'deadlineAt', 'runId', 'startedAt', 'type'],
  'resource_budget.dispatch_started': ['reservationId', 'type'],
  'resource_budget.reconciled': ['actual', 'reservationId', 'type'],
  'resource_budget.released': ['reservationId', 'type'],
  'resource_budget.reserved': ['reservation', 'type'],
  'resource_budget.unknown': ['reservationId', 'type'],
  'resource_budget.waiter_cancelled': ['invocationId', 'type'],
  'resource_budget.waiter_enqueued': ['type', 'waiter'],
  'resource_budget.waiter_promoted': ['invocationId', 'type'],
  'resource_budget.waiter_timed_out': ['invocationId', 'type'],
  'run.completed': ['output', 'turnId', 'type'],
  'run.error': ['message', 'recoverable', 'type'],
  'runtime.action_ignored': ['reason', 'type'],
  'runtime.cancellation_diagnostic': [
    'failure',
    'toolCallId',
    'type',
    'unconfirmedDescendantCount',
  ],
  'skill.activation_started': ['activation', 'type'],
  'skill.catalog_refreshed': ['catalogRevision', 'type'],
  'skill.frame_closed': ['activationId', 'closedAt', 'reason', 'status', 'type'],
  'subagent.cache_metrics': ['subagent', 'type'],
  'subagent.completed': ['subagent', 'type'],
  'subagent.failed': ['subagent', 'type'],
  'subagent.started': ['subagent', 'type'],
  'subagent.step': ['subagent', 'type'],
  'subagent.suspended': ['snapshot', 'toolCallId', 'type'],
  'subagent.tool_result': ['subagent', 'type'],
  'task.cancelled': ['reason', 'taskId', 'type'],
  'task.completed': ['taskId', 'turnId', 'type'],
  'task.started': ['taskId', 'turnId', 'type', 'userGoal'],
  'tool.cancelled': ['reason', 'toolCallId', 'type'],
  'tool.execution_ready': ['toolCallId', 'type'],
  'tool.failed': ['error', 'toolCallId', 'type'],
  'tool.file_change': ['kind', 'path', 'toolCallId', 'type'],
  'tool.finished': ['name', 'result', 'toolCallId', 'type'],
  'tool.progress': ['chunk', 'stream', 'toolCallId', 'type'],
  'tool.queued': ['args', 'name', 'toolCallId', 'type'],
  'tool.rejected': ['reason', 'toolCallId', 'type'],
  'tool.started': ['toolCallId', 'type'],
  'turn.aborted': ['reason', 'turnId', 'type'],
  'turn.completed': ['turnId', 'type'],
  'turn.started': ['turnId', 'type'],
  'user.command_invoked': ['command', 'commandId', 'type'],
  'user.message_appended': ['content', 'messageId', 'type'],
  'user_input.answered': ['answer', 'interactionId', 'toolCallId', 'type'],
  'user_input.cancelled': ['interactionId', 'reason', 'toolCallId', 'type'],
  'user_input.requested': ['interactionId', 'request', 'toolCallId', 'type'],
  'verification.check_completed': ['result', 'type', 'verificationId'],
  'verification.compensation_completed': [
    'completedAt',
    'outcome',
    'summary',
    'type',
    'verificationId',
  ],
  'verification.compensation_requested': ['requestedAt', 'type', 'verificationId'],
  'verification.completed': ['completedAt', 'outcome', 'type', 'verificationId'],
  'verification.repair_requested': [
    'instruction',
    'repairAttempt',
    'requestedAt',
    'type',
    'verificationId',
  ],
  'verification.replan_requested': ['instruction', 'requestedAt', 'type', 'verificationId'],
  'verification.requested': ['mode', 'requestedAt', 'spec', 'type', 'verificationId'],
  'verification.started': ['attempt', 'startedAt', 'type', 'verificationId'],
  'verification.waived': ['actor', 'reason', 'type', 'verificationId', 'waivedAt'],
} as const satisfies Record<RuntimeEvent['type'], readonly string[]>;

export const RUNTIME_EVENT_DURABILITY_V24 = {
  'approval.command_replaced': 'durable',
  'approval.granted': 'durable',
  'approval.rejected': 'durable',
  'approval.requested': 'durable',
  'authorization.changed': 'durable',
  'auto_review.completed': 'durable',
  'auto_review.requested': 'durable',
  'capability.bindings_issued': 'durable',
  'capability.execution_failed': 'durable',
  'capability.execution_started': 'durable',
  'capability.execution_succeeded': 'durable',
  'capability.execution_unknown': 'durable',
  'capability.invocation_recorded': 'durable',
  'capability.reconciliation_resolved': 'durable',
  'capability.search_completed': 'durable',
  'context.checkpoint_v3_rebound_v1': 'durable',
  'context.compaction_completed': 'durable',
  'context.compaction_failed': 'durable',
  'context.compaction_guard_carried_forward': 'durable',
  'context.compaction_guard_reset': 'durable',
  'context.compaction_migration_cancelled': 'durable',
  'context.compaction_refill_observed': 'durable',
  'context.compaction_requested': 'durable',
  'context.compaction_reset': 'durable',
  'context.compaction_unknown_external_outcome': 'durable',
  'context.hard_block_cleared': 'durable',
  'context.hard_blocked': 'durable',
  'context.normal_continuation_superseded_v1': 'durable',
  'context.normal_reprepare_consumed_v1': 'durable',
  'context.normal_reprepare_consumption_detached_v1': 'durable',
  'context.normal_reprepare_required_v1': 'durable',
  'context.normal_resource_resolution_required_v1': 'durable',
  'context.reclaim_commit_advanced': 'durable',
  'context.summary_branch_abandoned_v1': 'durable',
  'context.summary_completed_v1': 'durable',
  'context.summary_dispatch_started_v1': 'durable',
  'context.summary_failed_v1': 'durable',
  'context.summary_requested_v1': 'durable',
  'context.summary_unknown_external_outcome_v1': 'durable',
  'interaction_mode.changed': 'durable',
  'mcp.egress_decided': 'durable',
  'model.cache_metrics': 'durable',
  'model.context_metrics': 'durable',
  'model.reasoning_completed': 'ephemeral',
  'model.reasoning_delta': 'ephemeral',
  'model.requested': 'durable',
  'model.responded': 'durable',
  'model.retry': 'durable',
  'model.text_delta': 'ephemeral',
  'network.admission_decided': 'durable',
  'plan.approved': 'durable',
  'plan.completed': 'durable',
  'plan.drafted': 'durable',
  'plan.progress_updated': 'durable',
  'plan.rejected': 'durable',
  'plan.replan_requested': 'durable',
  'plan.review_cancelled': 'durable',
  'plan.review_requested': 'durable',
  'plan.revision_requested': 'durable',
  'planning.entered': 'durable',
  'planning.exited': 'durable',
  'provider.action_completed': 'durable',
  'provider.action_deferred': 'durable',
  'provider.action_failed': 'durable',
  'provider.action_required': 'durable',
  'provider.action_started': 'durable',
  'provider.admission_cancelled': 'durable',
  'provider.admission_required': 'durable',
  'provider.admission_retry_failed': 'durable',
  'provider.admission_retry_requested': 'durable',
  'provider.admission_satisfied': 'durable',
  'provider.admission_waived': 'durable',
  'provider.data_policy_status': 'durable',
  'resource_budget.configured': 'durable',
  'resource_budget.dispatch_started': 'durable',
  'resource_budget.reconciled': 'durable',
  'resource_budget.released': 'durable',
  'resource_budget.reserved': 'durable',
  'resource_budget.unknown': 'durable',
  'resource_budget.waiter_cancelled': 'durable',
  'resource_budget.waiter_enqueued': 'durable',
  'resource_budget.waiter_promoted': 'durable',
  'resource_budget.waiter_timed_out': 'durable',
  'run.completed': 'durable',
  'run.error': 'durable',
  'runtime.action_ignored': 'durable',
  'runtime.cancellation_diagnostic': 'durable',
  'skill.activation_started': 'durable',
  'skill.catalog_refreshed': 'durable',
  'skill.frame_closed': 'durable',
  'subagent.cache_metrics': 'durable',
  'subagent.completed': 'durable',
  'subagent.failed': 'durable',
  'subagent.started': 'durable',
  'subagent.step': 'durable',
  'subagent.suspended': 'durable',
  'subagent.tool_result': 'durable',
  'task.cancelled': 'durable',
  'task.completed': 'durable',
  'task.started': 'durable',
  'tool.cancelled': 'durable',
  'tool.execution_ready': 'durable',
  'tool.failed': 'durable',
  'tool.file_change': 'durable',
  'tool.finished': 'durable',
  'tool.progress': 'ephemeral',
  'tool.queued': 'durable',
  'tool.rejected': 'durable',
  'tool.started': 'durable',
  'turn.aborted': 'durable',
  'turn.completed': 'durable',
  'turn.started': 'durable',
  'user.command_invoked': 'durable',
  'user.message_appended': 'durable',
  'user_input.answered': 'durable',
  'user_input.cancelled': 'durable',
  'user_input.requested': 'durable',
  'verification.check_completed': 'durable',
  'verification.compensation_completed': 'durable',
  'verification.compensation_requested': 'durable',
  'verification.completed': 'durable',
  'verification.repair_requested': 'durable',
  'verification.replan_requested': 'durable',
  'verification.requested': 'durable',
  'verification.started': 'durable',
  'verification.waived': 'durable',
} as const satisfies Record<RuntimeEvent['type'], 'durable' | 'ephemeral'>;

export const EPHEMERAL_RUNTIME_EVENT_TYPES_V24 = new Set<RuntimeEvent['type']>(
  Object.entries(RUNTIME_EVENT_DURABILITY_V24)
    .filter(([, durability]) => durability === 'ephemeral')
    .map(([type]) => type as RuntimeEvent['type']),
);

function assertRegisteredRuntimeEventTypeV24(event: RuntimeEvent): void {
  if (!Object.hasOwn(RUNTIME_EVENT_DURABILITY_V24, event.type)) {
    throw new Error(`Unknown Runtime event type '${String(event.type)}' for registry v24.`);
  }
}

function assertExactRuntimeEventFieldsV24(event: RuntimeEvent): void {
  assertRegisteredRuntimeEventTypeV24(event);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Runtime event payload must be an object.');
  }
  const allowed = new Set<string>(RUNTIME_EVENT_FIELDS_V24[event.type]);
  const unknown = Object.keys(event).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime event '${event.type}' contains unknown v24 field '${unknown.sort()[0]}'.`,
    );
  }
  const missing = REQUIRED_RUNTIME_EVENT_FIELDS_V24[event.type].filter(
    (key) =>
      !(
        event.type === 'tool.failed' &&
        key === 'error' &&
        Object.hasOwn(event, 'failure') &&
        event.failure !== undefined
      ) &&
      (!Object.hasOwn(event, key) ||
        (event as unknown as Record<string, unknown>)[key] === undefined),
  );
  if (missing.length > 0) {
    throw new Error(
      `Runtime event '${event.type}' is missing required v24 field '${missing.sort()[0]}'.`,
    );
  }
  assertRuntimeEventNestedSchemasV24(event);
  assertRuntimeEventValueBudgetV24(event);
}

function assertNestedKeysV24(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  const missing = required.filter(
    (key) => !Object.hasOwn(record, key) || record[key] === undefined,
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} contains missing or unknown v24 fields.`);
  }
}

function assertNestedArrayV24(
  value: unknown,
  label: string,
  validate: (entry: unknown) => void,
): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  for (const entry of value) validate(entry);
}

function assertClassifiedFailureV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'kind',
      'message',
      'retryable',
      'modelFixable',
      'needsUserIntervention',
      'terminatesTurn',
      'journal',
      'executionCertainty',
      'knownExternalEffects',
      'parseFailureCode',
    ],
    [
      'kind',
      'message',
      'retryable',
      'modelFixable',
      'needsUserIntervention',
      'terminatesTurn',
      'journal',
    ],
    'Classified failure',
  );
}

function assertRunTerminalOutcomeV1(value: unknown): void {
  const fields = [
    'version',
    'status',
    'reasonCode',
    'knownExternalEffects',
    'safeRetry',
    'recoveryEntry',
    'pendingVerification',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Run terminal outcome');
}

function assertAgentPlanV24(value: unknown): void {
  const fields = ['name', 'description', 'status', 'steps'] as const;
  assertNestedKeysV24(value, fields, fields, 'Agent plan');
  assertNestedArrayV24(value.steps, 'Agent plan steps', (step) =>
    assertNestedKeysV24(
      step,
      ['step', 'status', 'id', 'note'],
      ['step', 'status'],
      'Agent plan step',
    ),
  );
}

function assertPlanArtifactV24(value: unknown): void {
  const fields = [
    'artifactId',
    'taskId',
    'planId',
    'version',
    'fileName',
    'relativePath',
    'displayPath',
    'structuralDigest',
    'byteLength',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Plan artifact');
}

function assertToolApprovalV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'scope',
      'callId',
      'cwd',
      'threadId',
      'tool',
      'command',
      'risk',
      'approvalHash',
      'summary',
      'reason',
      'expectedEffects',
      'grantOptions',
      'recommendedGrant',
      'plan',
      'subagentId',
      'reviewFailure',
      'capabilityId',
      'capabilityRevision',
      'argumentsDigest',
      'effectiveEffectsDigest',
    ],
    [
      'scope',
      'cwd',
      'threadId',
      'tool',
      'command',
      'risk',
      'approvalHash',
      'summary',
      'reason',
      'expectedEffects',
      'grantOptions',
      'recommendedGrant',
    ],
    'Tool approval',
  );
  if (value.plan !== undefined) assertAgentPlanV24(value.plan);
}

function assertUserInputV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['question', 'options', 'allow_free_text', 'context', 'recommended', 'questions'],
    ['question', 'options', 'allow_free_text'],
    'User input request',
  );
  const option = (entry: unknown) =>
    assertNestedKeysV24(
      entry,
      ['id', 'label', 'description'],
      ['id', 'label'],
      'User input option',
    );
  assertNestedArrayV24(value.options, 'User input options', option);
  if (value.questions !== undefined) {
    assertNestedArrayV24(value.questions, 'User input questions', (question) => {
      assertNestedKeysV24(
        question,
        ['id', 'question', 'options', 'recommended', 'allow_free_text'],
        ['question', 'options'],
        'User input question',
      );
      assertNestedArrayV24(question.options, 'User input question options', option);
    });
  }
}

function assertEffectProfileV24(value: unknown): void {
  const fields = ['filesystem', 'network', 'externalState'] as const;
  assertNestedKeysV24(value, fields, fields, 'Capability effect profile');
}

function assertCapabilityBindingV24(value: unknown): void {
  const fields = [
    'bindingId',
    'capabilityId',
    'capabilityRevision',
    'exposedToolName',
    'schemaDigest',
    'issuedForTurnId',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Capability binding');
}

function assertCapabilityDisclosureV24(value: unknown): void {
  const fields = ['capabilityId', 'capabilityRevision', 'issuedForTurnId'] as const;
  assertNestedKeysV24(value, fields, fields, 'Capability disclosure');
}

function assertLoadedCapabilityV24(value: unknown): void {
  const fields = ['capabilityId', 'capabilityRevision', 'firstLoadedAtTurnId'] as const;
  assertNestedKeysV24(value, fields, fields, 'Loaded capability');
}

function assertCapabilitySearchResultV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['searchId', 'query', 'catalogRevision', 'requestedAtTurnId', 'candidates', 'providers'],
    ['searchId', 'query', 'catalogRevision', 'requestedAtTurnId', 'candidates'],
    'Capability search result',
  );
  assertNestedArrayV24(value.candidates, 'Capability search candidates', (candidate) =>
    assertNestedKeysV24(
      candidate,
      [
        'candidateRef',
        'capabilityId',
        'capabilityRevision',
        'kind',
        'displayName',
        'providerType',
        'providerId',
      ],
      [
        'candidateRef',
        'capabilityId',
        'capabilityRevision',
        'kind',
        'displayName',
        'providerType',
        'providerId',
      ],
      'Capability search candidate',
    ),
  );
  if (value.providers !== undefined) {
    assertNestedArrayV24(value.providers, 'Capability provider diagnostics', (provider) =>
      assertNestedKeysV24(
        provider,
        ['providerId', 'status', 'nextAction', 'diagnosticCode'],
        ['providerId', 'status', 'nextAction'],
        'Capability provider diagnostic',
      ),
    );
  }
}

function assertCapabilityArtifactV24(value: unknown): void {
  const fields = ['artifactId', 'relativePath', 'byteLength', 'digest'] as const;
  assertNestedKeysV24(value, fields, fields, 'Capability artifact');
}

function assertResourceBudgetV24(value: unknown): void {
  const fields = [
    'version',
    'maxRunDurationMs',
    'maxTurns',
    'maxModelRequests',
    'maxToolInvocations',
    'maxRunInputTokens',
    'maxRunOutputTokens',
    'maxConcurrentSubagents',
    'maxConcurrentWriters',
    'maxConcurrentToolInvocations',
    'maxConcurrentShellInvocations',
    'maxConcurrencyWaitMs',
    'maxArtifactBytes',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Resource budget');
}

function assertResourceUsageV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['counters', 'gauges', 'source', 'estimatorVersion'],
    ['counters', 'gauges', 'source'],
    'Resource usage',
  );
  const counterFields = [
    'turns',
    'modelRequests',
    'toolInvocations',
    'inputTokens',
    'outputTokens',
    'artifactBytes',
  ] as const;
  assertNestedKeysV24(value.counters, counterFields, counterFields, 'Resource usage counters');
  const gaugeFields = [
    'elapsedRunMs',
    'activeSubagents',
    'activeWriters',
    'activeToolInvocations',
    'activeShellInvocations',
  ] as const;
  assertNestedKeysV24(value.gauges, gaugeFields, gaugeFields, 'Resource usage gauges');
}

function assertBudgetReservationV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'version',
      'reservationId',
      'runId',
      'invocationId',
      'parentReservationId',
      'resourceKind',
      'executableUpperBound',
      'actual',
      'state',
    ],
    [
      'version',
      'reservationId',
      'runId',
      'invocationId',
      'resourceKind',
      'executableUpperBound',
      'state',
    ],
    'Budget reservation',
  );
  assertResourceUsageV24(value.executableUpperBound);
  if (value.actual !== undefined) assertResourceUsageV24(value.actual);
}

function assertConcurrencyWaiterV24(value: unknown): void {
  const fields = [
    'version',
    'runId',
    'invocationId',
    'requiredPermits',
    'sequence',
    'enqueuedAt',
    'deadlineAt',
    'state',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Concurrency waiter');
}

function assertProviderUsageV24(value: unknown): void {
  const fields = ['inputTokens', 'outputTokens'] as const;
  assertNestedKeysV24(value, fields, fields, 'Provider usage');
}

function assertCheckpointV24(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Context checkpoint must be an object.');
  }
  const version = (value as Record<string, unknown>).version;
  if (version === 1) {
    assertNestedKeysV24(
      value,
      [
        'compactionId',
        'version',
        'sourceRevision',
        'sourceDigest',
        'coveredThroughMessageId',
        'coveredThroughTurnId',
        'summary',
        'inputTokensBefore',
        'inputTokensAfter',
        'reason',
        'createdAt',
        'baseCheckpointId',
      ],
      [
        'compactionId',
        'version',
        'sourceRevision',
        'sourceDigest',
        'coveredThroughMessageId',
        'coveredThroughTurnId',
        'summary',
        'inputTokensBefore',
        'inputTokensAfter',
        'reason',
        'createdAt',
      ],
      'Context checkpoint v1',
    );
    return;
  }
  // Checkpoint-v2 is a read-only compatibility payload. The Kernel's legacy
  // boundary rejects live production before persistence; restore validates its
  // historical closed schema in the dedicated legacy reader.
  if (version === 2) return;
  if (version !== 3) {
    throw new Error('Schema-v24 events may contain only checkpoint v1 or verified checkpoint v3.');
  }
  assertNestedKeysV24(
    value,
    [
      'version',
      'checkpointId',
      'compactionId',
      'reason',
      'source',
      'summary',
      'summaryContentDigest',
      'inputTokensBefore',
      'inputTokensAfter',
      'promptContractId',
      'routeIdentityDigest',
      'baseCheckpoint',
      'createdAt',
    ],
    [
      'version',
      'checkpointId',
      'compactionId',
      'reason',
      'source',
      'summary',
      'summaryContentDigest',
      'inputTokensBefore',
      'inputTokensAfter',
      'promptContractId',
      'routeIdentityDigest',
      'createdAt',
    ],
    'Verified context checkpoint v3',
  );
  assertNestedKeysV24(
    value.source,
    [
      'firstMessageId',
      'coveredThroughMessageId',
      'coveredThroughTurnId',
      'sourceRevision',
      'sourceProducingEventCutV1',
      'sourceRangeDigest',
      'sourceProjectionPolicyId',
    ],
    [
      'firstMessageId',
      'coveredThroughMessageId',
      'coveredThroughTurnId',
      'sourceRevision',
      'sourceProducingEventCutV1',
      'sourceRangeDigest',
      'sourceProjectionPolicyId',
    ],
    'Verified checkpoint source',
  );
  assertEventCutV1(value.source.sourceProducingEventCutV1);
  if (value.baseCheckpoint !== undefined) {
    const baseFields = ['checkpointId', 'summaryContentDigest'] as const;
    assertNestedKeysV24(value.baseCheckpoint, baseFields, baseFields, 'Checkpoint base identity');
  }
}

function assertContextPrimaryEvidenceV24(value: unknown): void {
  const fields = [
    'version',
    'purpose',
    'terminalBatchId',
    'requestId',
    'effectLeaseId',
    'reservationId',
    'preparedDigest',
    'sourceIdentityDigest',
    'requestIdentityDigest',
    'finalProviderPayloadDigest',
    'admittedRequestDigest',
    'reclaimReceiptDigest',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Primary request evidence');
}

function assertReclaimCommitV24(value: unknown): void {
  const fields = [
    'version',
    'policyId',
    'toolResultBudgetPolicyId',
    'settledThroughMessageId',
    'settledThroughTurnId',
    'checkpointIdentity',
    'rawFramesDigest',
    'appliedFramesDigest',
    'selectedCoverageDigest',
    'selectedBlockCount',
    'selectedCallCount',
    'estimatorId',
    'projectionEnvironmentDigest',
    'cacheAffectingEnvironmentDigest',
    'toolSetSchemaDigest',
    'projectionContractId',
    'cacheEpochId',
    'committedAtTurnIndex',
  ] as const;
  assertNestedKeysV24(
    value,
    fields,
    fields.filter((field) => field !== 'checkpointIdentity'),
    'Context reclaim commit',
  );
}

function assertReclaimReceiptV24(value: unknown): void {
  const fields = [
    'version',
    'terminalBatchId',
    'previousCommitDigest',
    'effectiveProjectionDigest',
    'sourceIdentityDigest',
    'requestIdentityDigest',
    'proposedCommitDigest',
    'admittedRequestDigest',
    'responseMessageId',
    'receiptDigest',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Context reclaim receipt');
}

function assertVerificationSpecV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['schemaVersion', 'verificationId', 'taskId', 'subject', 'checks', 'repair', 'compensation'],
    ['schemaVersion', 'verificationId', 'subject', 'checks', 'repair'],
    'Verification specification',
  );
  assertNestedKeysV24(value.repair, ['maxAttempts'], ['maxAttempts'], 'Verification repair policy');
  if (value.compensation !== undefined) {
    assertNestedKeysV24(
      value.compensation,
      ['command', 'cwd', 'timeoutMs'],
      ['command'],
      'Verification compensation',
    );
  }
  assertNestedArrayV24(value.checks, 'Verification checks', (check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new Error('Verification check must be an object.');
    }
    const record = check as Record<string, unknown>;
    const common = ['checkId', 'description', 'type'];
    switch (record.type) {
      case 'file_assertion':
        assertNestedKeysV24(
          check,
          [...common, 'path', 'assertion', 'expectedDigest'],
          [...common, 'path', 'assertion'],
          'File verification check',
        );
        break;
      case 'command':
        assertNestedKeysV24(
          check,
          [...common, 'command', 'cwd', 'timeoutMs', 'expectedExitCode'],
          [...common, 'command'],
          'Command verification check',
        );
        break;
      case 'schema': {
        assertNestedKeysV24(
          check,
          [...common, 'subject', 'schema'],
          [...common, 'subject', 'schema'],
          'Schema verification check',
        );
        const subject = record.subject as Record<string, unknown>;
        assertNestedKeysV24(
          subject,
          subject.kind === 'literal'
            ? ['kind', 'value']
            : subject.kind === 'skill_output'
              ? ['kind', 'activationId']
              : ['kind', 'invocationId'],
          subject.kind === 'literal'
            ? ['kind', 'value']
            : subject.kind === 'skill_output'
              ? ['kind', 'activationId']
              : ['kind', 'invocationId'],
          'Schema verification subject',
        );
        break;
      }
      case 'mcp_read_after_write':
        assertNestedKeysV24(
          check,
          [
            ...common,
            'invocationId',
            'capabilityId',
            'capabilityRevision',
            'arguments',
            'outputSchema',
          ],
          [...common, 'invocationId', 'capabilityId', 'capabilityRevision', 'arguments'],
          'MCP read-after-write verification check',
        );
        break;
      case 'external_reference':
        assertNestedKeysV24(
          check,
          [...common, 'invocationId', 'uri'],
          [...common, 'invocationId'],
          'External-reference verification check',
        );
        break;
      case 'reviewer':
        assertNestedKeysV24(
          check,
          [...common, 'invocationIds', 'activationIds', 'instructions'],
          [...common, 'instructions'],
          'Reviewer verification check',
        );
        break;
      default:
        throw new Error('Verification check contains an unknown v24 discriminant.');
    }
  });
}

function assertVerificationResultV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['checkId', 'outcome', 'summary', 'evidenceDigest', 'startedAt', 'finishedAt'],
    ['checkId', 'outcome', 'summary', 'startedAt', 'finishedAt'],
    'Verification check result',
  );
}

function assertNetworkDecisionV24(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Network decision must be an object.');
  }
  const record = value as Record<string, unknown>;
  const common = [
    'version',
    'outcome',
    'toolCallId',
    'invocationId',
    'hop',
    'policyRevision',
    'canonicalOrigin',
    'host',
    'expectedEndpointRevision',
    'receiptDigest',
  ];
  assertNestedKeysV24(
    value,
    record.outcome === 'allowed'
      ? [...common, 'address', 'family', 'endpointRevision']
      : [...common, 'failureCode'],
    record.outcome === 'allowed'
      ? [
          'version',
          'outcome',
          'toolCallId',
          'invocationId',
          'hop',
          'policyRevision',
          'canonicalOrigin',
          'host',
          'address',
          'family',
          'endpointRevision',
          'receiptDigest',
        ]
      : [
          'version',
          'outcome',
          'toolCallId',
          'invocationId',
          'hop',
          'policyRevision',
          'canonicalOrigin',
          'host',
          'failureCode',
          'receiptDigest',
        ],
    'Network decision',
  );
}

function assertRemoteMcpDecisionV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'version',
      'invocationId',
      'toolCallId',
      'serverIdentity',
      'endpointRevision',
      'toolRevision',
      'argumentDigest',
      'dataClassifications',
      'payloadKinds',
      'admitted',
      'reason',
      'nonceDigest',
      'permitExpiresAt',
      'decidedAt',
      'receiptDigest',
    ],
    [
      'version',
      'invocationId',
      'toolCallId',
      'serverIdentity',
      'endpointRevision',
      'toolRevision',
      'argumentDigest',
      'dataClassifications',
      'payloadKinds',
      'admitted',
      'reason',
      'decidedAt',
      'receiptDigest',
    ],
    'Remote MCP decision',
  );
}

function assertToolResultBudgetV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'source',
      'toolIdentity',
      'bindingDigest',
      'budget',
      'projectorId',
      'projectorRevision',
      'validatorId',
      'policyId',
      'outputSchema',
    ],
    [
      'source',
      'toolIdentity',
      'bindingDigest',
      'budget',
      'projectorId',
      'projectorRevision',
      'validatorId',
      'policyId',
    ],
    'Tool result budget binding',
  );
  const budget = value.budget as Record<string, unknown>;
  const budgetFields =
    budget.kind === 'stream_head_tail'
      ? ['kind', 'maxCharsPerStream']
      : budget.kind === 'line_window'
        ? ['kind', 'maxUtf8Bytes', 'continuation', 'decoderContractId']
        : budget.kind === 'serialized'
          ? ['kind', 'maxUtf8Bytes']
          : ['kind', 'maxUtf8Bytes', 'projectorId'];
  assertNestedKeysV24(budget, budgetFields, budgetFields, 'Tool model-result budget');
  if (value.outputSchema !== undefined) {
    const schema = value.outputSchema as Record<string, unknown>;
    assertNestedKeysV24(
      schema,
      schema.status === 'frozen'
        ? ['status', 'schemaDigest', 'schema']
        : ['status', 'schemaDigest'],
      schema.status === 'frozen'
        ? ['status', 'schemaDigest', 'schema']
        : ['status', 'schemaDigest'],
      'Frozen runtime output schema',
    );
  }
}

function assertToolResultReceiptV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'version',
      'projectionMode',
      'policyId',
      'toolIdentity',
      'bindingDigest',
      'projectorId',
      'projectorRevision',
      'validatorId',
      'rawResultDigest',
      'modelContentDigest',
      'modelContentUtf8Bytes',
      'streamProjection',
      'continuation',
    ],
    [
      'version',
      'projectionMode',
      'policyId',
      'toolIdentity',
      'bindingDigest',
      'projectorId',
      'projectorRevision',
      'validatorId',
      'rawResultDigest',
      'modelContentDigest',
      'modelContentUtf8Bytes',
    ],
    'Tool result receipt',
  );
  if (value.streamProjection !== undefined) {
    const streamFields = ['stdoutDigest', 'stderrDigest', 'stdoutChars', 'stderrChars'] as const;
    assertNestedKeysV24(
      value.streamProjection,
      streamFields,
      streamFields,
      'Tool stream projection receipt',
    );
  }
  if (value.continuation !== undefined) assertToolContinuationV24(value.continuation);
}

function assertToolContinuationV24(value: unknown): void {
  assertNestedKeysV24(value, ['kind', 'status', 'cursor'], ['kind', 'status'], 'Tool continuation');
  if (value.cursor !== undefined) {
    const fields = [
      'lineOffset',
      'utf8ByteOffsetInLine',
      'endLineExclusive',
      'pathDigest',
      'resourceRevision',
      'initialOffset',
      'effectiveInitialLimit',
      'windowIdentity',
      'cursorDigest',
    ] as const;
    assertNestedKeysV24(value.cursor, fields, fields, 'Tool continuation cursor');
  }
}

function assertToolResultMetaV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'path',
      'totalLines',
      'command',
      'intent',
      'matchCount',
      'truncated',
      'contentDigest',
      'resourceRevision',
      'workspaceMutationScope',
      'rawResultDigest',
      'modelContentDigest',
      'digestScope',
      'toolResultReceipt',
      'terminalIdentity',
      'terminalKind',
      'continuation',
      'processCleanupConfirmed',
      'unconfirmedDescendantCount',
      'projectionFailure',
      'terminalMigration',
      'networkPolicyRevision',
      'networkAdmissionDigests',
      'networkFailureCode',
    ],
    [],
    'Tool result metadata',
  );
  if (value.toolResultReceipt !== undefined) assertToolResultReceiptV24(value.toolResultReceipt);
  if (value.continuation !== undefined) assertToolContinuationV24(value.continuation);
  if (value.projectionFailure !== undefined) assertClassifiedFailureV24(value.projectionFailure);
  if (value.terminalMigration !== undefined) assertMigratedToolResultV24(value.terminalMigration);
}

function assertMigratedToolResultV24(value: unknown): void {
  const fields = ['kind', 'migratedFromSchemaVersion', 'originalEventPosition'] as const;
  assertNestedKeysV24(value, fields, fields, 'Migrated tool result');
}

function assertToolTerminalModelResultV24(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool terminal model result must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'legacy_unverified') {
    assertMigratedToolResultV24(value);
    return;
  }
  assertNestedKeysV24(
    value,
    ['kind', 'terminalIdentity', 'ok', 'modelContent', 'streams', 'resultMeta'],
    ['kind', 'terminalIdentity', 'ok', 'modelContent', 'resultMeta'],
    'Verified tool model result',
  );
  if (value.streams !== undefined) {
    const fields = ['stdout', 'stderr'] as const;
    assertNestedKeysV24(value.streams, fields, fields, 'Tool model-result streams');
  }
  assertToolResultMetaV24(value.resultMeta);
}

function assertToolFinishedResultV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'ok',
      'command',
      'exitCode',
      'stdout',
      'stderr',
      'status',
      'totalLines',
      'toolTokenCount',
      'userInput',
      'resultMeta',
    ],
    ['ok', 'command', 'exitCode', 'stdout', 'stderr'],
    'Tool finished result',
  );
  if (value.userInput !== undefined) {
    assertNestedKeysV24(value.userInput, ['answer', 'answers'], ['answer'], 'User input result');
  }
  if (value.resultMeta !== undefined) assertToolResultMetaV24(value.resultMeta);
}

function assertSubagentPayloadV24(event: RuntimeEvent): void {
  if (
    event.type !== 'subagent.started' &&
    event.type !== 'subagent.step' &&
    event.type !== 'subagent.tool_result' &&
    event.type !== 'subagent.completed' &&
    event.type !== 'subagent.failed' &&
    event.type !== 'subagent.cache_metrics'
  )
    return;
  const fields =
    event.type === 'subagent.started'
      ? ['id', 'role', 'task']
      : event.type === 'subagent.step'
        ? ['id', 'toolName', 'toolArgs', 'durationMs']
        : event.type === 'subagent.tool_result'
          ? [
              'id',
              'toolName',
              'ok',
              'summary',
              'totalLines',
              'toolTokenCount',
              'durationMs',
              'failureReason',
            ]
          : event.type === 'subagent.completed'
            ? ['id', 'summary', 'toolCallCount', 'durationMs']
            : event.type === 'subagent.failed'
              ? ['id', 'error', 'summary', 'toolCallCount', 'durationMs']
              : ['subagentId', 'cacheHitTokens', 'cacheMissTokens', 'inputTokens'];
  const required =
    event.type === 'subagent.started'
      ? ['id', 'role', 'task']
      : event.type === 'subagent.step'
        ? ['id', 'toolName', 'toolArgs']
        : event.type === 'subagent.tool_result'
          ? ['id', 'toolName', 'ok']
          : event.type === 'subagent.completed'
            ? ['id', 'summary', 'toolCallCount', 'durationMs']
            : event.type === 'subagent.failed'
              ? ['id', 'error']
              : ['subagentId', 'cacheHitTokens', 'cacheMissTokens', 'inputTokens'];
  assertNestedKeysV24(event.subagent, fields, required, 'Subagent event payload');
}

function assertSuspendedSubagentV24(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'subagentId',
      'role',
      'task',
      'messages',
      'toolCallCount',
      'steps',
      'executionJournal',
      'exhaustedFingerprints',
      'blockedTool',
    ],
    ['subagentId', 'role', 'task', 'messages', 'toolCallCount', 'steps', 'blockedTool'],
    'Suspended subagent snapshot',
  );
  assertNestedArrayV24(value.messages, 'Suspended subagent messages', (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Suspended subagent message must be an object.');
    }
    const record = message as Record<string, unknown>;
    const base = ['type', 'id', 'name', 'content', 'responseMetadata'];
    const fields =
      record.type === 'ai'
        ? [...base, 'toolCalls', 'additionalKwargs', 'invalidToolCalls', 'usageMetadata']
        : record.type === 'tool'
          ? [...base, 'toolCallId', 'status', 'artifact', 'metadata']
          : base;
    const required =
      record.type === 'ai'
        ? ['type', 'content', 'toolCalls', 'additionalKwargs']
        : record.type === 'tool'
          ? ['type', 'content', 'toolCallId']
          : ['type', 'content'];
    assertNestedKeysV24(message, fields, required, 'Suspended subagent message');
    if (record.type === 'ai') {
      assertNestedArrayV24(record.toolCalls, 'Suspended subagent tool calls', (call) =>
        assertNestedKeysV24(call, ['id', 'name', 'args'], ['name', 'args'], 'Subagent tool call'),
      );
    }
  });
  assertNestedArrayV24(value.steps, 'Suspended subagent steps', (step) =>
    assertNestedKeysV24(
      step,
      ['toolName', 'toolArgs', 'status', 'ok', 'totalLines'],
      ['toolName', 'toolArgs', 'status'],
      'Suspended subagent step',
    ),
  );
  if (value.executionJournal !== undefined) {
    assertNestedArrayV24(value.executionJournal, 'Subagent execution journal', (entry) =>
      assertNestedKeysV24(
        entry,
        [
          'toolCallId',
          'toolName',
          'status',
          'startedAt',
          'finishedAt',
          'errorCode',
          'fingerprint',
          'stderrDigest',
        ],
        ['toolCallId', 'toolName', 'status', 'startedAt'],
        'Subagent execution journal entry',
      ),
    );
  }
  assertNestedKeysV24(
    value.blockedTool,
    ['toolCallId', 'toolName', 'args', 'command'],
    ['toolCallId', 'toolName', 'args', 'command'],
    'Suspended subagent blocked tool',
  );
}

function assertSourceIdentityV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'version',
      'firstMessageId',
      'coveredThroughMessageId',
      'coveredThroughTurnId',
      'canonicalSourceDigest',
      'sourceProjectionPolicyId',
    ],
    [
      'version',
      'firstMessageId',
      'coveredThroughMessageId',
      'coveredThroughTurnId',
      'canonicalSourceDigest',
      'sourceProjectionPolicyId',
    ],
    'Summary source identity',
  );
}

function assertEventCutV1(value: unknown): void {
  assertNestedKeysV24(value, ['revision', 'eventId'], ['revision', 'eventId'], 'Event cut');
}

function assertTokenEstimateV1(value: unknown): void {
  const fields = [
    'systemTokens',
    'toolSchemaTokens',
    'transcriptTokens',
    'summaryTokens',
    'dynamicRuntimeTokens',
    'framingTokens',
    'totalInputTokens',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Context token estimate');
}

function assertContinuationV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['version', 'turnId', 'requestedAtRevision', 'summarySourceIdentity'],
    ['turnId', 'requestedAtRevision', 'summarySourceIdentity'],
    'Summary continuation',
  );
  assertSourceIdentityV1(value.summarySourceIdentity);
}

function assertAttemptV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'attemptId',
      'compactionId',
      'reason',
      'trigger',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'estimate',
      'customInstructions',
    ],
    [
      'attemptId',
      'compactionId',
      'reason',
      'trigger',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'estimate',
    ],
    'Summary attempt',
  );
  assertSourceIdentityV1(value.summarySourceIdentity);
  assertEventCutV1(value.sourceProducingEventCutV1);
  assertTokenEstimateV1(value.estimate);
}

function assertDispatchStartV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'startBatchId',
      'summaryEffectLeaseId',
      'resourceReservationId',
      'preparedSummaryRequestIdentity',
      'requestId',
      'expectedPayloadDigest',
      'expectedMaxOutputTokens',
      'expectedToolSetSchemaDigest',
    ],
    [
      'startBatchId',
      'summaryEffectLeaseId',
      'resourceReservationId',
      'preparedSummaryRequestIdentity',
      'requestId',
      'expectedPayloadDigest',
      'expectedMaxOutputTokens',
      'expectedToolSetSchemaDigest',
    ],
    'Summary dispatch start',
  );
}

function assertStartBatchKeyV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'startBatchId',
      'attemptId',
      'compactionId',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'dispatchStart',
    ],
    [
      'startBatchId',
      'attemptId',
      'compactionId',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'dispatchStart',
    ],
    'Summary start batch key',
  );
  assertSourceIdentityV1(value.summarySourceIdentity);
  assertEventCutV1(value.sourceProducingEventCutV1);
  assertDispatchStartV1(value.dispatchStart);
}

function assertTerminalBatchKeyV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'terminalBatchId',
      'causationId',
      'resourceDispatchCausationId',
      'attemptId',
      'compactionId',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'dispatchStart',
      'admission',
    ],
    [
      'terminalBatchId',
      'causationId',
      'attemptId',
      'compactionId',
      'summarySourceIdentity',
      'requestedAtRevision',
      'requestedAtTurnId',
      'sourceProducingEventCutV1',
      'admission',
    ],
    'Summary terminal batch key',
  );
  assertSourceIdentityV1(value.summarySourceIdentity);
  assertEventCutV1(value.sourceProducingEventCutV1);
  if (value.dispatchStart !== undefined) assertDispatchStartV1(value.dispatchStart);
  const admission = value.admission as Record<string, unknown>;
  assertNestedKeysV24(
    admission,
    admission.stage === 'not_completed'
      ? ['stage', 'proof']
      : admission.stage === 'denied'
        ? ['stage', 'proof']
        : admission.stage === 'admitted'
          ? ['stage', 'evidence']
          : ['stage'],
    admission.stage === 'not_completed' || admission.stage === 'denied'
      ? ['stage', 'proof']
      : admission.stage === 'admitted'
        ? ['stage', 'evidence']
        : ['stage'],
    'Summary terminal admission',
  );
  if (admission.stage === 'not_completed') {
    assertNestedKeysV24(
      admission.proof,
      ['kind', 'guardNonce', 'producerGeneration', 'summaryStartBatchId'],
      ['kind', 'guardNonce', 'producerGeneration', 'summaryStartBatchId'],
      'Summary zero-execution proof',
    );
  } else if (admission.stage === 'admitted') {
    assertNestedKeysV24(
      admission.evidence,
      [
        'admittedRequestDigest',
        'finalPayloadDigest',
        'providerDataAdmissionReceiptDigest',
        'finalMaxOutputTokens',
        'finalToolSetSchemaDigest',
      ],
      [
        'admittedRequestDigest',
        'finalPayloadDigest',
        'providerDataAdmissionReceiptDigest',
        'finalMaxOutputTokens',
        'finalToolSetSchemaDigest',
      ],
      'Summary final admission evidence',
    );
  }
}

function assertReprepareReceiptV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    ['version', 'generation', 'attemptId', 'compactionId', 'continuation', 'origin'],
    ['version', 'generation', 'attemptId', 'compactionId', 'continuation', 'origin'],
    'Normal reprepare receipt',
  );
  assertContinuationV1(value.continuation);
  const origin = value.origin as Record<string, unknown>;
  assertNestedKeysV24(
    origin,
    origin.kind === 'summary_terminal'
      ? ['kind', 'terminalBatchId', 'terminalEventId', 'resourceTerminalEventId']
      : [
          'kind',
          'originalTerminalBatchId',
          'resolutionBatchId',
          'resourceUnknownEventId',
          'resourceReconciledEventId',
        ],
    origin.kind === 'summary_terminal'
      ? ['kind', 'terminalBatchId', 'terminalEventId', 'resourceTerminalEventId']
      : [
          'kind',
          'originalTerminalBatchId',
          'resolutionBatchId',
          'resourceUnknownEventId',
          'resourceReconciledEventId',
        ],
    'Normal reprepare origin',
  );
}

function assertConsumptionKeyV1(value: unknown): void {
  assertNestedKeysV24(
    value,
    [
      'version',
      'generation',
      'consumptionBatchId',
      'attemptId',
      'compactionId',
      'continuation',
      'originReceipt',
      'primaryEffectLeaseId',
      'primaryInvocationId',
      'primaryRequestId',
      'resourceReservationId',
    ],
    [
      'version',
      'generation',
      'consumptionBatchId',
      'attemptId',
      'compactionId',
      'continuation',
      'originReceipt',
      'primaryEffectLeaseId',
      'primaryInvocationId',
      'primaryRequestId',
      'resourceReservationId',
    ],
    'Normal reprepare consumption key',
  );
  assertContinuationV1(value.continuation);
  assertReprepareReceiptV1(value.originReceipt);
}

function assertSummaryResolutionBatchKeyV1(value: unknown): void {
  const fields = [
    'version',
    'resolutionBatchId',
    'causationId',
    'generation',
    'attemptId',
    'compactionId',
    'originalTerminalBatchId',
    'resourceReservationId',
    'resourceUnknownEventId',
    'continuation',
    'actualUsageDigest',
  ] as const;
  assertNestedKeysV24(value, fields, fields, 'Summary resolution batch key');
  assertContinuationV1(value.continuation);
}

function assertProgressiveContextNestedSchemasV24(event: RuntimeEvent): void {
  if (event.type === 'context.compaction_requested') {
    assertTokenEstimateV1(event.estimate);
  } else if (event.type === 'context.summary_requested_v1') {
    assertAttemptV1(event.attempt);
    if (event.continuation) assertContinuationV1(event.continuation);
  } else if (event.type === 'context.summary_dispatch_started_v1') {
    assertStartBatchKeyV1(event.startBatchKey);
  } else if (
    event.type === 'context.summary_completed_v1' ||
    event.type === 'context.summary_failed_v1' ||
    event.type === 'context.summary_unknown_external_outcome_v1'
  ) {
    assertTerminalBatchKeyV1(event.terminalBatchKey);
  } else if (event.type === 'context.normal_resource_resolution_required_v1') {
    assertAttemptV1(event.attempt);
    assertTerminalBatchKeyV1(event.terminalBatchKey);
    assertContinuationV1(event.continuation);
  } else if (event.type === 'context.normal_reprepare_required_v1') {
    assertReprepareReceiptV1(event.receipt);
    if (event.summaryResolutionBatchKey)
      assertSummaryResolutionBatchKeyV1(event.summaryResolutionBatchKey);
  } else if (event.type === 'context.normal_reprepare_consumed_v1') {
    assertConsumptionKeyV1(event.consumptionKey);
  } else if (event.type === 'context.normal_reprepare_consumption_detached_v1') {
    assertNestedKeysV24(
      event.receipt,
      [
        'version',
        'receiptId',
        'sourceThreadId',
        'targetThreadId',
        'sourceGeneration',
        'targetGeneration',
        'selectedCutDigest',
        'consumption',
        'primaryState',
        'runErrorEventId',
        'resourceTerminalEventId',
        'turnAbortedEventId',
        'checksum',
      ],
      [
        'version',
        'receiptId',
        'sourceThreadId',
        'targetThreadId',
        'sourceGeneration',
        'targetGeneration',
        'selectedCutDigest',
        'consumption',
        'primaryState',
        'checksum',
      ],
      'Normal reprepare detach receipt',
    );
    assertConsumptionKeyV1(event.receipt.consumption);
  }
  if (
    (event.type === 'resource_budget.reserved' ||
      event.type === 'resource_budget.dispatch_started') &&
    event.summaryStartBatchKey
  ) {
    assertStartBatchKeyV1(event.summaryStartBatchKey);
  }
  if (
    (event.type === 'resource_budget.reserved' ||
      event.type === 'resource_budget.dispatch_started') &&
    event.normalReprepareConsumptionKey
  ) {
    assertConsumptionKeyV1(event.normalReprepareConsumptionKey);
  }
  if (
    (event.type === 'resource_budget.reconciled' ||
      event.type === 'resource_budget.released' ||
      event.type === 'resource_budget.unknown') &&
    event.summaryTerminalBatchKey
  ) {
    assertTerminalBatchKeyV1(event.summaryTerminalBatchKey);
  }
  if (
    (event.type === 'resource_budget.reserved' || event.type === 'resource_budget.reconciled') &&
    event.summaryResolutionBatchKey
  ) {
    assertSummaryResolutionBatchKeyV1(event.summaryResolutionBatchKey);
  }
}

function assertRuntimeEventNestedSchemasV24(event: RuntimeEvent): void {
  assertProgressiveContextNestedSchemasV24(event);
  assertSubagentPayloadV24(event);
  switch (event.type) {
    case 'approval.requested':
    case 'auto_review.requested':
      assertToolApprovalV24(event.approval);
      return;
    case 'approval.rejected':
      if (event.failure) assertClassifiedFailureV24(event.failure);
      return;
    case 'authorization.changed':
      if (event.commandGrants) {
        for (const grant of Object.values(event.commandGrants)) {
          assertNestedKeysV24(
            grant,
            ['workspace', 'threadId', 'command', 'source', 'grantedAt', 'expiresAt'],
            ['workspace', 'threadId', 'command', 'source', 'grantedAt'],
            'Authorization command grant',
          );
        }
      }
      return;
    case 'auto_review.completed':
      assertNestedKeysV24(
        event.result,
        event.result.ok
          ? ['ok', 'approved', 'grant', 'reason', 'reviewerModelName', 'durationMs']
          : ['ok', 'approved', 'failureType', 'reason', 'reviewerModelName', 'durationMs'],
        event.result.ok
          ? ['ok', 'approved', 'reviewerModelName', 'durationMs']
          : ['ok', 'approved', 'failureType', 'reviewerModelName', 'durationMs'],
        'Auto-review result',
      );
      return;
    case 'capability.bindings_issued':
      assertNestedArrayV24(event.bindings, 'Capability bindings', assertCapabilityBindingV24);
      if (event.disclosures)
        assertNestedArrayV24(
          event.disclosures,
          'Capability disclosures',
          assertCapabilityDisclosureV24,
        );
      if (event.loadedCapabilities)
        assertNestedArrayV24(
          event.loadedCapabilities,
          'Loaded capabilities',
          assertLoadedCapabilityV24,
        );
      return;
    case 'capability.execution_succeeded':
      if (event.artifact) assertCapabilityArtifactV24(event.artifact);
      return;
    case 'capability.invocation_recorded':
      assertEffectProfileV24(event.effectiveEffects);
      return;
    case 'capability.search_completed':
      assertCapabilitySearchResultV24(event.result);
      return;
    case 'context.compaction_completed':
      assertCheckpointV24(event.checkpoint);
      if (event.providerUsage) assertProviderUsageV24(event.providerUsage);
      return;
    case 'context.summary_completed_v1':
      assertCheckpointV24(event.checkpoint);
      if (event.providerUsage) assertProviderUsageV24(event.providerUsage);
      return;
    case 'context.checkpoint_v3_rebound_v1':
      assertCheckpointV24(event.checkpoint);
      assertNestedKeysV24(
        event.proof,
        [
          'version',
          'generation',
          'ledgerBaseId',
          'parentSourceProducingEventCutV1',
          'forkLocalSourceProducingEventCutV1',
          'sourceRangeDigest',
          'checksum',
        ],
        [
          'version',
          'generation',
          'ledgerBaseId',
          'parentSourceProducingEventCutV1',
          'forkLocalSourceProducingEventCutV1',
          'sourceRangeDigest',
          'checksum',
        ],
        'Checkpoint rebound proof',
      );
      assertEventCutV1(event.proof.parentSourceProducingEventCutV1);
      assertEventCutV1(event.proof.forkLocalSourceProducingEventCutV1);
      return;
    case 'context.reclaim_commit_advanced':
      assertReclaimCommitV24(event.commit);
      assertReclaimReceiptV24(event.receipt);
      return;
    case 'mcp.egress_decided':
      assertRemoteMcpDecisionV24(event.decision);
      return;
    case 'network.admission_decided':
      assertNetworkDecisionV24(event.decision);
      return;
    case 'model.context_metrics':
      assertTokenEstimateV1(event.estimate);
      return;
    case 'model.responded':
      if (event.contextEvidence) assertContextPrimaryEvidenceV24(event.contextEvidence);
      if (event.toolCalls) {
        assertNestedArrayV24(event.toolCalls, 'Model tool calls', (call) =>
          assertNestedKeysV24(
            call,
            ['id', 'name', 'args'],
            ['id', 'name', 'args'],
            'Model tool call',
          ),
        );
      }
      if (event.ownedToolQueue) {
        for (const queued of event.ownedToolQueue) assertExactRuntimeEventFieldsV24(queued);
      }
      return;
    case 'plan.completed':
    case 'plan.progress_updated':
      assertAgentPlanV24(event.plan);
      return;
    case 'plan.drafted':
      assertAgentPlanV24(event.plan);
      if (event.artifact) assertPlanArtifactV24(event.artifact);
      return;
    case 'plan.review_requested':
      assertAgentPlanV24(event.plan);
      if (event.artifact) assertPlanArtifactV24(event.artifact);
      return;
    case 'resource_budget.configured':
      assertResourceBudgetV24(event.budget);
      return;
    case 'resource_budget.reserved':
      assertBudgetReservationV24(event.reservation);
      return;
    case 'resource_budget.reconciled':
      assertResourceUsageV24(event.actual);
      return;
    case 'resource_budget.released':
      if (event.summaryDispatchGuardProof) {
        assertNestedKeysV24(
          event.summaryDispatchGuardProof,
          ['kind', 'guardNonce', 'producerGeneration', 'summaryStartBatchId'],
          ['kind', 'guardNonce', 'producerGeneration', 'summaryStartBatchId'],
          'Summary dispatch guard proof',
        );
      }
      return;
    case 'resource_budget.waiter_enqueued':
      assertConcurrencyWaiterV24(event.waiter);
      return;
    case 'run.completed':
      if (event.outcome) assertRunTerminalOutcomeV1(event.outcome);
      return;
    case 'run.error':
      if (event.failure) assertClassifiedFailureV24(event.failure);
      if (event.outcome) assertRunTerminalOutcomeV1(event.outcome);
      return;
    case 'runtime.cancellation_diagnostic':
      assertClassifiedFailureV24(event.failure);
      return;
    case 'skill.activation_started':
      assertNestedKeysV24(
        event.activation,
        [
          'activationId',
          'skillId',
          'skillRevision',
          'taskId',
          'input',
          'contextMode',
          'agent',
          'capabilityCeiling',
          'verificationMode',
          'requestedBy',
          'activatedAt',
        ],
        [
          'activationId',
          'skillId',
          'skillRevision',
          'taskId',
          'input',
          'contextMode',
          'agent',
          'capabilityCeiling',
          'verificationMode',
          'requestedBy',
          'activatedAt',
        ],
        'Skill activation',
      );
      return;
    case 'subagent.suspended':
      assertSuspendedSubagentV24(event.snapshot);
      return;
    case 'tool.queued':
      if (event.resultBudgetV2) assertToolResultBudgetV24(event.resultBudgetV2);
      return;
    case 'tool.finished':
      assertToolFinishedResultV24(event.result);
      if (event.modelResult) assertToolTerminalModelResultV24(event.modelResult);
      return;
    case 'tool.failed':
      if (event.failure) assertClassifiedFailureV24(event.failure);
      if (event.modelResult) assertToolTerminalModelResultV24(event.modelResult);
      return;
    case 'tool.rejected':
      if (event.failure) assertClassifiedFailureV24(event.failure);
      if (event.modelResult) assertToolTerminalModelResultV24(event.modelResult);
      return;
    case 'tool.cancelled':
      if (event.modelResult) assertToolTerminalModelResultV24(event.modelResult);
      return;
    case 'user_input.requested':
      assertUserInputV24(event.request);
      return;
    case 'verification.requested':
      assertVerificationSpecV24(event.spec);
      return;
    case 'verification.check_completed':
      assertVerificationResultV24(event.result);
      return;
    default:
      return;
  }
}

const RUNTIME_EVENT_MAX_DEPTH_V24 = 24;
const RUNTIME_EVENT_MAX_ARRAY_ITEMS_V24 = 4096;
const RUNTIME_EVENT_MAX_OBJECT_FIELDS_V24 = 256;
const RUNTIME_EVENT_MAX_STRING_BYTES_V24 = 128 * 1024;

/** Bound every nested JSON value before canonicalization or persistence. */
function assertRuntimeEventValueBudgetV24(value: unknown, depth = 0): void {
  if (depth > RUNTIME_EVENT_MAX_DEPTH_V24) {
    throw new Error('Runtime event v24 nested value exceeds the depth limit.');
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > RUNTIME_EVENT_MAX_STRING_BYTES_V24) {
      throw new Error('Runtime event v24 string exceeds the byte limit.');
    }
    return;
  }
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Runtime event v24 number must be finite.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > RUNTIME_EVENT_MAX_ARRAY_ITEMS_V24) {
      throw new Error('Runtime event v24 array exceeds the item limit.');
    }
    for (const entry of value) assertRuntimeEventValueBudgetV24(entry, depth + 1);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('Runtime event v24 contains a non-JSON value.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Runtime event v24 nested value must be a plain JSON object.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RUNTIME_EVENT_MAX_OBJECT_FIELDS_V24) {
    throw new Error('Runtime event v24 object exceeds the field limit.');
  }
  for (const [key, entry] of entries) {
    if (Buffer.byteLength(key, 'utf8') > 256) {
      throw new Error('Runtime event v24 object key exceeds the byte limit.');
    }
    if (entry !== undefined) assertRuntimeEventValueBudgetV24(entry, depth + 1);
  }
}

export function isEphemeralRuntimeEventV24(event: RuntimeEvent): boolean {
  assertExactRuntimeEventFieldsV24(event);
  return EPHEMERAL_RUNTIME_EVENT_TYPES_V24.has(event.type);
}

/** Canonical opaque batch correlation derived only from frozen payload bindings. */
export function runtimeEventCausationIdV24(event: RuntimeEvent): string | null {
  if (
    event.type === 'context.summary_dispatch_started_v1' ||
    event.type === 'resource_budget.reserved' ||
    event.type === 'resource_budget.dispatch_started'
  ) {
    return event.type === 'context.summary_dispatch_started_v1'
      ? event.startBatchKey.startBatchId
      : (event.summaryStartBatchKey?.startBatchId ?? null);
  }
  if (
    event.type === 'context.summary_completed_v1' ||
    event.type === 'context.summary_failed_v1' ||
    event.type === 'context.summary_unknown_external_outcome_v1' ||
    event.type === 'context.normal_resource_resolution_required_v1'
  )
    return event.terminalBatchKey.causationId;
  if (
    event.type === 'resource_budget.reconciled' ||
    event.type === 'resource_budget.released' ||
    event.type === 'resource_budget.unknown'
  ) {
    return event.type === 'resource_budget.reconciled' && event.summaryResolutionBatchKey
      ? event.summaryResolutionBatchKey.causationId
      : (event.summaryTerminalBatchKey?.causationId ?? null);
  }
  if (event.type === 'context.normal_reprepare_required_v1' && event.summaryResolutionBatchKey)
    return event.summaryResolutionBatchKey.causationId;
  return null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validCausationId(value: string | null | undefined): boolean {
  return value == null || (value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128);
}

export interface RuntimeEventEnvelopeV24 extends RuntimeEventEnvelope {
  schemaVersion: 24;
  generation: number;
  causationId?: string | null;
}

export function canonicalRuntimeEventEnvelopeBytesV24(
  envelope: Omit<RuntimeEventEnvelopeV24, 'eventId'> | RuntimeEventEnvelopeV24,
): string {
  return canonical({
    schemaVersion: 24,
    threadId: envelope.threadId,
    generation: envelope.generation,
    revision: envelope.revision,
    causationId: envelope.causationId ?? null,
    occurredAt: envelope.occurredAt,
    event: envelope.payload,
  });
}

/** Full persisted-envelope authority used by copied terminal closures. */
export function canonicalRuntimeEventEnvelopeAuthorityBytesV24(
  envelope: RuntimeEventEnvelopeV24,
): string {
  return canonical({
    schemaVersion: 24,
    threadId: envelope.threadId,
    generation: envelope.generation,
    eventId: envelope.eventId,
    revision: envelope.revision,
    causationId: envelope.causationId ?? null,
    occurredAt: envelope.occurredAt,
    event: envelope.payload,
  });
}

export function canonicalRuntimeEventIdV24(
  envelope: Omit<RuntimeEventEnvelopeV24, 'eventId'> | RuntimeEventEnvelopeV24,
): string {
  return createHash('sha256')
    .update('runtime-event-envelope:v24\0')
    .update(canonicalRuntimeEventEnvelopeBytesV24(envelope))
    .digest('hex');
}

export function buildRuntimeEventEnvelopeV24(input: {
  threadId: string;
  generation: number;
  revision: number;
  causationId?: string | null;
  occurredAt: string;
  payload: RuntimeEvent;
}): RuntimeEventEnvelopeV24 {
  if (isEphemeralRuntimeEventV24(input.payload)) {
    throw new Error(`Ephemeral event '${input.payload.type}' cannot enter the durable registry.`);
  }
  if (!input.threadId || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('Canonical event producer identity is invalid.');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error('Canonical event revision must be a positive safe integer.');
  }
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error('Canonical event timestamp is invalid.');
  }
  if (!validCausationId(input.causationId)) {
    throw new Error('Canonical event causationId must be 1..128 UTF-8 bytes.');
  }
  const expectedCausationId = runtimeEventCausationIdV24(input.payload);
  if (expectedCausationId != null && (input.causationId ?? null) !== expectedCausationId) {
    throw new Error('Canonical event named causation does not match its payload binding.');
  }
  const withoutId = {
    schemaVersion: 24 as const,
    threadId: input.threadId,
    generation: input.generation,
    revision: input.revision,
    causationId: input.causationId ?? null,
    occurredAt: input.occurredAt,
    payload: structuredClone(input.payload),
  };
  return { ...withoutId, eventId: canonicalRuntimeEventIdV24(withoutId) };
}

export function assertCanonicalRuntimeEventEnvelopeV24(
  envelope: RuntimeEventEnvelope,
): asserts envelope is RuntimeEventEnvelopeV24 {
  const candidate = envelope as RuntimeEventEnvelopeV24;
  if (
    candidate.schemaVersion !== 24 ||
    !candidate.threadId ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation < 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    !Number.isFinite(Date.parse(candidate.occurredAt)) ||
    !validCausationId(candidate.causationId)
  ) {
    throw new Error('Schema-v24 durable event envelope metadata is missing.');
  }
  if (isEphemeralRuntimeEventV24(candidate.payload)) {
    throw new Error(`Ephemeral event '${candidate.payload.type}' was presented as durable.`);
  }
  const expectedCausationId = runtimeEventCausationIdV24(candidate.payload);
  if (expectedCausationId != null && (candidate.causationId ?? null) !== expectedCausationId) {
    throw new Error('Schema-v24 named event causation mismatch.');
  }
  if (canonicalRuntimeEventIdV24(candidate) !== candidate.eventId) {
    throw new Error('Schema-v24 canonical event identity mismatch.');
  }
}
