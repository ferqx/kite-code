import type { RuntimeEvent } from './events';

type RequiredFieldManifest = {
  [K in RuntimeEvent['type']]: readonly Exclude<keyof Extract<RuntimeEvent, { type: K }>, 'type'>[];
};

// Generated from the RuntimeEvent union's non-optional properties. This single
// manifest owns both the current discriminants and their required persisted fields.
const CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS = {
  'approval.command_replaced': ['interactionId', 'command'],
  'approval.granted': ['interactionId', 'toolCallId', 'grant'],
  'approval.rejected': ['interactionId', 'toolCallId', 'reason'],
  'approval.requested': ['interactionId', 'toolCallId', 'approval'],
  'authorization.changed': ['mode'],
  'auto_review.completed': ['reviewId', 'toolCallId', 'result'],
  'auto_review.requested': ['reviewId', 'toolCallId', 'toolName', 'reason', 'approval'],
  'capability.bindings_issued': ['catalogRevision', 'bindings'],
  'capability.execution_failed': ['invocationId', 'error', 'finishedAt'],
  'capability.execution_started': ['invocationId', 'startedAt'],
  'capability.execution_succeeded': [
    'invocationId',
    'resultDigest',
    'evidenceDigest',
    'finishedAt',
  ],
  'capability.execution_unknown': ['invocationId', 'reason', 'finishedAt'],
  'capability.invocation_recorded': [
    'invocationId',
    'toolCallId',
    'capabilityId',
    'capabilityRevision',
    'argumentsDigest',
    'authorizationDigest',
    'effectiveEffectsDigest',
    'effectiveEffects',
    'recordedAt',
  ],
  'capability.reconciliation_resolved': ['invocationId', 'decision', 'reconciledAt'],
  'capability.search_completed': ['result'],
  'completion.blocked': [
    'turnId',
    'guardVersion',
    'code',
    'nextAction',
    'planning',
    'correctionAttempt',
  ],
  'context.compaction_completed': ['compactionId', 'sourceRevision', 'checkpoint'],
  'context.compaction_failed': [
    'compactionId',
    'sourceRevision',
    'errorKind',
    'message',
    'retryable',
  ],
  'context.compaction_requested': [
    'compactionId',
    'reason',
    'requestedAtRevision',
    'requestedAtTurnId',
    'force',
    'estimate',
  ],
  'context.compaction_reset': ['checkpointId', 'reason'],
  'context.hard_block_cleared': ['reason', 'sourceDigest'],
  'context.hard_blocked': ['reason', 'sourceDigest', 'message', 'createdAtTurnId'],
  'interaction_mode.changed': ['mode', 'source', 'changedAt'],
  'mcp.egress_decided': ['toolCallId', 'decision'],
  'model.cache_metrics': ['inputTokens', 'cacheHitTokens', 'cacheMissTokens', 'hitRate'],
  'model.context_metrics': ['modelName', 'totalInputTokens', 'status', 'estimate'],
  'model.invocation_attempt_started': ['invocationId', 'attempt', 'maxAttempts'],
  'model.invocation_completed': ['invocationId', 'responseArtifact', 'finishReason'],
  'model.invocation_evidence_unavailable': ['invocationId', 'reasonCode'],
  'model.invocation_interrupted': ['invocationId', 'dispatchCertainty', 'reasonCode'],
  'model.invocation_prepared': [
    'invocationId',
    'purpose',
    'surfaceArtifact',
    'surfaceIntegrityIdentifier',
    'routeFingerprint',
    'admission',
    'budget',
    'limits',
    'preparedStateRevision',
    'parentInvocationId',
    'parentToolCallId',
  ],
  'model.reasoning_completed': ['segmentId', 'text'],
  'model.reasoning_delta': ['text'],
  'model.requested': ['requestId'],
  'model.responded': ['messageId'],
  'model.retry': ['attempt', 'maxAttempts', 'error', 'delayMs'],
  'model.text_delta': ['text'],
  'network.admission_decided': ['toolCallId', 'decision'],
  'plan.approved': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'executionMode',
  ],
  'plan.completed': [
    'toolCallId',
    'taskId',
    'plan',
    'planId',
    'version',
    'structuralDigest',
    'completionEvidence',
  ],
  'plan.drafted': [
    'toolCallId',
    'taskId',
    'plan',
    'structuralHash',
    'planId',
    'version',
    'planSchemaVersion',
    'artifact',
  ],
  'plan.progress_updated': [
    'toolCallId',
    'taskId',
    'plan',
    'planId',
    'version',
    'structuralDigest',
    'completionEvidence',
  ],
  'plan.replan_requested': ['toolCallId', 'reason', 'supersedesPlanVersion'],
  'plan.review_cancelled': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'reason',
  ],
  'plan.review_requested': [
    'interactionId',
    'toolCallId',
    'taskId',
    'plan',
    'planSummary',
    'planId',
    'version',
    'structuralDigest',
    'artifact',
  ],
  'plan.revision_requested': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'feedback',
  ],
  'planning.entered': ['taskId', 'source'],
  'planning.exited': ['taskId'],
  'provider.action_completed': ['interactionId', 'originatingToolCallId'],
  'provider.action_deferred': ['interactionId', 'originatingToolCallId'],
  'provider.action_failed': ['interactionId', 'originatingToolCallId', 'failureCode'],
  'provider.action_required': ['interactionId', 'providerId', 'action', 'originatingToolCallId'],
  'provider.action_started': ['interactionId'],
  'provider.admission_cancelled': ['interactionId', 'providerId'],
  'provider.admission_required': [
    'interactionId',
    'providerId',
    'source',
    'providerStatus',
    'retryable',
  ],
  'provider.admission_retry_failed': ['interactionId', 'providerStatus'],
  'provider.admission_retry_requested': ['interactionId'],
  'provider.admission_satisfied': ['interactionId', 'providerDirectoryRevision'],
  'provider.admission_waived': ['interactionId', 'providerId', 'source', 'reason', 'waivedAt'],
  'provider.data_policy_status': ['status', 'reason'],
  'provider.readiness_attempt_started': [
    'readinessKey',
    'lifecycleId',
    'attempt',
    'maxAttempts',
    'startedAt',
  ],
  'provider.readiness_failed': [
    'readinessKey',
    'lifecycleId',
    'failure',
    'dispatchCertainty',
    'failedAt',
  ],
  'provider.readiness_intent_recorded': [
    'readinessKey',
    'lifecycleId',
    'providerId',
    'routeRevision',
    'executionBoundaryDigest',
    'requestedAt',
    'expiresAt',
    'maxAttempts',
  ],
  'provider.readiness_succeeded': [
    'readinessKey',
    'lifecycleId',
    'providerDirectoryRevision',
    'readyAt',
    'expiresAt',
  ],
  'provider.readiness_waiter_registered': [
    'readinessKey',
    'lifecycleId',
    'waiterId',
    'toolCallId',
    'registeredAt',
  ],
  'resource_budget.configured': ['runId', 'startedAt', 'deadlineAt', 'budget'],
  'resource_budget.dispatch_started': ['reservationId'],
  'resource_budget.reconciled': ['reservationId', 'actual'],
  'resource_budget.released': ['reservationId'],
  'resource_budget.reserved': ['reservation'],
  'resource_budget.unknown': ['reservationId'],
  'resource_budget.waiter_cancelled': ['invocationId'],
  'resource_budget.waiter_enqueued': ['waiter'],
  'resource_budget.waiter_promoted': ['invocationId'],
  'resource_budget.waiter_timed_out': ['invocationId'],
  'run.completed': ['turnId', 'output'],
  'run.error': ['message', 'recoverable'],
  'runtime.action_ignored': ['reason'],
  'runtime.cancellation_diagnostic': ['toolCallId', 'failure', 'unconfirmedDescendantCount'],
  'skill.activation_started': ['activation'],
  'skill.catalog_refreshed': ['catalogRevision'],
  'skill.frame_closed': ['activationId', 'status', 'reason', 'closedAt'],
  'subagent.approval_deferred': ['toolCallId'],
  'subagent.cache_metrics': ['subagent'],
  'subagent.completed': ['subagent'],
  'subagent.failed': ['subagent'],
  'subagent.recovery_journal_merged': ['toolCallId', 'journal'],
  'subagent.started': ['subagent'],
  'subagent.step': ['subagent'],
  'subagent.suspended': ['toolCallId', 'snapshot'],
  'subagent.tool_result': ['subagent'],
  'task.cancelled': ['taskId', 'reason'],
  'task.completed': ['taskId', 'turnId'],
  'task.started': ['taskId', 'userGoal', 'turnId'],
  'tool.cancelled': ['toolCallId', 'reason'],
  'tool.failed': ['toolCallId', 'failure'],
  'tool.file_change': ['toolCallId', 'path', 'kind'],
  'tool.finished': ['toolCallId', 'name', 'result'],
  'tool.progress': ['toolCallId', 'chunk', 'stream'],
  'tool.queued': ['toolCallId', 'name', 'args'],
  'tool.rejected': ['toolCallId', 'reason'],
  'tool.retry_recorded': ['toolCallId', 'failure', 'outcomeV1', 'recoveryOf', 'retryAttempt'],
  'tool.started': ['toolCallId'],
  'turn.aborted': ['turnId', 'reason'],
  'turn.completed': ['turnId'],
  'turn.started': ['turnId'],
  'user.command_invoked': ['commandId', 'command'],
  'user.message_appended': ['messageId', 'content'],
  'user_input.answered': ['interactionId', 'toolCallId', 'answer'],
  'user_input.cancelled': ['interactionId', 'toolCallId', 'reason'],
  'user_input.requested': ['interactionId', 'toolCallId', 'request'],
  'verification.check_completed': ['verificationId', 'result'],
  'verification.compensation_completed': ['verificationId', 'outcome', 'summary', 'completedAt'],
  'verification.compensation_requested': ['verificationId', 'requestedAt'],
  'verification.completed': ['verificationId', 'outcome', 'completedAt'],
  'verification.repair_requested': [
    'verificationId',
    'repairAttempt',
    'instruction',
    'requestedAt',
  ],
  'verification.replan_requested': ['verificationId', 'instruction', 'requestedAt'],
  'verification.requested': ['verificationId', 'mode', 'spec', 'requestedAt'],
  'verification.started': ['verificationId', 'attempt', 'startedAt'],
  'verification.waived': ['verificationId', 'actor', 'reason', 'waivedAt'],
} as const satisfies RequiredFieldManifest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(event: Record<string, unknown>, field: string): void {
  if (typeof event[field] !== 'string' || event[field].length === 0) {
    throw new Error(`Runtime event ${String(event.type)} requires ${field}.`);
  }
}

/** Reject unknown and retired payload variants before reducer or UI replay. */
export function assertCurrentRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Runtime event must be an object with a string type.');
  }
  if (!Object.hasOwn(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, value.type)) {
    throw new Error(`Runtime event type ${value.type} is not part of the current format.`);
  }
  const eventType = value.type as RuntimeEvent['type'];
  for (const field of CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[eventType]) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`Runtime event ${eventType} requires ${String(field)}.`);
    }
  }

  switch (value.type) {
    case 'approval.granted':
    case 'approval.rejected':
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'toolCallId');
      break;
    case 'provider.action_completed':
    case 'provider.action_deferred':
    case 'provider.action_failed':
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'originatingToolCallId');
      break;
    case 'plan.approved':
    case 'plan.revision_requested':
    case 'plan.review_cancelled':
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'toolCallId');
      requireNonEmptyString(value, 'planId');
      requireNonEmptyString(value, 'structuralDigest');
      if (!Number.isInteger(value.version) || Number(value.version) < 1) {
        throw new Error(`Runtime event ${value.type} requires a positive version.`);
      }
      break;
    case 'plan.drafted':
    case 'plan.progress_updated':
    case 'plan.completed':
      requireNonEmptyString(value, 'toolCallId');
      requireNonEmptyString(value, 'taskId');
      requireNonEmptyString(value, 'planId');
      break;
    case 'tool.failed':
      requireNonEmptyString(value, 'toolCallId');
      if (!isRecord(value.failure)) {
        throw new Error('Runtime event tool.failed requires structured failure.');
      }
      break;
    default:
      break;
  }
}

export function decodeCurrentRuntimeEventJson(serialized: string): RuntimeEvent {
  const value = JSON.parse(serialized) as unknown;
  assertCurrentRuntimeEvent(value);
  return value;
}
