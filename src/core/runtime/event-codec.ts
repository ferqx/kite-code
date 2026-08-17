import {
  validateSandboxPreparationIntentRecordV1,
  validateSandboxPreparationReadyRecordV1,
} from '@/core/capabilities/sandbox-preparation-evidence';
import {
  validateWorkspaceFilesystemIntentRecordV1,
  validateWorkspaceFilesystemMutationReadyRecordV1,
  validateWorkspaceFilesystemObservationRecordV1,
} from '@/core/capabilities/workspace-filesystem-evidence';
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
  'capability.execution_result_recorded': [
    'invocationId',
    'resultDigest',
    'evidenceDigest',
    'recordedAt',
    'artifact',
  ],
  'capability.execution_succeeded': [
    'invocationId',
    'resultDigest',
    'evidenceDigest',
    'finishedAt',
  ],
  'capability.execution_unknown': ['invocationId', 'reason', 'finishedAt'],
  'capability.filesystem_mutation_ready': [
    'invocationId',
    'attempt',
    'intentDigest',
    'operationDigest',
    'targetIdentityDigest',
    'preimageDigest',
    'preimageArtifact',
    'readyDigest',
    'readyAt',
  ],
  'capability.filesystem_intent_recorded': [
    'invocationId',
    'attempt',
    'capabilityRevision',
    'argumentsDigest',
    'admissionDigest',
    'operationDigest',
    'searchBoundaryDigest',
    'lexicalTargetDigest',
    'canonicalWorkspaceDigest',
    'protectedPathRevision',
    'approvalSummaryDigest',
    'effectiveEffectsDigest',
    'intentDigest',
    'recordedAt',
  ],
  'capability.sandbox_preparation_intent_recorded': [
    'invocationId',
    'attempt',
    'toolCallId',
    'capabilityId',
    'capabilityRevision',
    'canonicalWorkspace',
    'effectiveEffectsDigest',
    'admissionDigest',
    'preparationDigest',
    'commandDigest',
    'executionBoundaryDigest',
    'resourceSemantics',
    'intentDigest',
    'recordedAt',
  ],
  'capability.sandbox_preparation_ready': [
    'invocationId',
    'attempt',
    'intentDigest',
    'preparationDigest',
    'commandDigest',
    'planDigest',
    'backend',
    'backendCapabilitiesDigest',
    'enforcement',
    'resourceSemantics',
    'cleanupDigest',
    'preparationArtifact',
    'readyDigest',
    'readyAt',
  ],
  'capability.sandbox_execution_dispatch_intent_recorded': [
    'invocationId',
    'attempt',
    'readyDigest',
    'planDigest',
    'dispatchId',
    'supervisorNonce',
    'dispatchIntentDigest',
    'recordedAt',
  ],
  'capability.sandbox_execution_supervisor_started': [
    'invocationId',
    'attempt',
    'dispatchId',
    'dispatchIntentDigest',
    'supervisorPid',
    'processGroupId',
    'processStartIdentity',
    'startedAt',
  ],
  'capability.sandbox_disposal_started': [
    'invocationId',
    'attempt',
    'readyDigest',
    'lifecycleIntentDigest',
    'startedAt',
  ],
  'capability.sandbox_disposal_completed': [
    'invocationId',
    'attempt',
    'readyDigest',
    'lifecycleIntentDigest',
    'cleanupAttempt',
    'disposed',
    'disposedAt',
  ],
  'capability.sandbox_preparation_abandonment_started': [
    'invocationId',
    'attempt',
    'intentDigest',
    'lifecycleIntentDigest',
    'startedAt',
  ],
  'capability.sandbox_preparation_abandonment_completed': [
    'invocationId',
    'attempt',
    'intentDigest',
    'lifecycleIntentDigest',
    'cleanupAttempt',
    'disposed',
    'disposedAt',
  ],
  'capability.subagent_dispatch_intent_recorded': [
    'invocationId',
    'attempt',
    'purpose',
    'childInvocationId',
    'taskArtifact',
    'dispatchIntentDigest',
    'recordedAt',
  ],
  'capability.subagent_handle_recorded': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'handleArtifact',
    'handleIntegrityIdentifier',
    'recordedAt',
  ],
  'capability.subagent_observation_recorded': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'status',
    'observedAt',
  ],
  'capability.subagent_cleanup_started': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'cleanupAttempt',
    'cleanupKind',
    'startedAt',
  ],
  'capability.subagent_cleanup_completed': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'cleanupAttempt',
    'cleanupKind',
    'cleanupConfirmed',
    'completedAt',
  ],
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

function exactEventKeys(event: Record<string, unknown>, fields: readonly string[]): void {
  const expected = new Set(['type', ...fields]);
  const keys = Object.keys(event);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`Runtime event ${String(event.type)} has an invalid shape.`);
  }
}

function validPrivateRef(value: unknown, kind: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ['artifactId', 'byteLength', 'integrityIdentifier', 'kind'];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    value.kind === kind &&
    typeof value.artifactId === 'string' &&
    /^pa_[0-9a-f]{64}$/u.test(value.artifactId) &&
    typeof value.integrityIdentifier === 'string' &&
    /^hmac-sha256:[0-9a-f]{64}$/u.test(value.integrityIdentifier) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) > 0
  );
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
    case 'capability.execution_succeeded':
      if (value.filesystemObservation !== undefined) {
        validateWorkspaceFilesystemObservationRecordV1(value.filesystemObservation);
      }
      break;
    case 'capability.filesystem_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      validateWorkspaceFilesystemIntentRecordV1(intent);
      break;
    }
    case 'capability.filesystem_mutation_ready': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...ready } = value;
      validateWorkspaceFilesystemMutationReadyRecordV1(ready);
      break;
    }
    case 'capability.sandbox_preparation_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      validateSandboxPreparationIntentRecordV1(
        intent as unknown as import('@/protocol/capabilities').SandboxPreparationIntentRecordV1,
      );
      break;
    }
    case 'capability.sandbox_preparation_ready': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...ready } = value;
      validateSandboxPreparationReadyRecordV1(
        ready as unknown as import('@/protocol/capabilities').SandboxPreparationReadyRecordV1,
      );
      break;
    }
    case 'capability.sandbox_execution_dispatch_intent_recorded':
    case 'capability.sandbox_execution_supervisor_started': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'dispatchId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) {
        throw new Error(`Runtime event ${value.type} requires a positive attempt.`);
      }
      if (value.type === 'capability.sandbox_execution_dispatch_intent_recorded') {
        requireNonEmptyString(value, 'readyDigest');
        requireNonEmptyString(value, 'planDigest');
        requireNonEmptyString(value, 'supervisorNonce');
        requireNonEmptyString(value, 'recordedAt');
        if (!Number.isFinite(Date.parse(String(value.recordedAt)))) {
          throw new Error('Sandbox dispatch intent requires a valid timestamp.');
        }
      } else {
        requireNonEmptyString(value, 'processStartIdentity');
        requireNonEmptyString(value, 'startedAt');
        if (
          !Number.isSafeInteger(value.supervisorPid) ||
          Number(value.supervisorPid) < 1 ||
          value.processGroupId !== value.supervisorPid ||
          !Number.isFinite(Date.parse(String(value.startedAt)))
        ) {
          throw new Error('Sandbox supervisor start evidence is invalid.');
        }
      }
      break;
    }
    case 'capability.sandbox_disposal_started':
    case 'capability.sandbox_disposal_completed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'readyDigest');
      requireNonEmptyString(value, 'lifecycleIntentDigest');
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) {
        throw new Error(`Runtime event ${value.type} requires a positive attempt.`);
      }
      const timestampField =
        value.type === 'capability.sandbox_disposal_started' ? 'startedAt' : 'disposedAt';
      requireNonEmptyString(value, timestampField);
      if (!Number.isFinite(Date.parse(String(value[timestampField])))) {
        throw new Error(`Runtime event ${value.type} requires a valid timestamp.`);
      }
      if (
        value.type === 'capability.sandbox_disposal_completed' &&
        (typeof value.disposed !== 'boolean' ||
          !Number.isSafeInteger(value.cleanupAttempt) ||
          Number(value.cleanupAttempt) < 1)
      ) {
        throw new Error('Sandbox disposal completion requires a boolean disposed receipt.');
      }
      break;
    }
    case 'capability.sandbox_preparation_abandonment_started':
    case 'capability.sandbox_preparation_abandonment_completed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'intentDigest');
      requireNonEmptyString(value, 'lifecycleIntentDigest');
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) {
        throw new Error(`Runtime event ${value.type} requires a positive attempt.`);
      }
      const timestampField =
        value.type === 'capability.sandbox_preparation_abandonment_started'
          ? 'startedAt'
          : 'disposedAt';
      requireNonEmptyString(value, timestampField);
      if (!Number.isFinite(Date.parse(String(value[timestampField])))) {
        throw new Error(`Runtime event ${value.type} requires a valid timestamp.`);
      }
      if (
        value.type === 'capability.sandbox_preparation_abandonment_completed' &&
        (typeof value.disposed !== 'boolean' ||
          !Number.isSafeInteger(value.cleanupAttempt) ||
          Number(value.cleanupAttempt) < 1)
      ) {
        throw new Error('Sandbox preparation abandonment requires a boolean disposed receipt.');
      }
      break;
    }
    case 'capability.subagent_dispatch_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'childInvocationId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      requireNonEmptyString(value, 'recordedAt');
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !['start', 'resume'].includes(String(value.purpose)) ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !validPrivateRef(value.taskArtifact, 'subagent_task') ||
        !Number.isFinite(Date.parse(String(value.recordedAt)))
      ) {
        throw new Error('Subagent dispatch intent evidence is invalid.');
      }
      break;
    }
    case 'capability.subagent_handle_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      for (const field of [
        'invocationId',
        'dispatchIntentDigest',
        'handleIntegrityIdentifier',
        'recordedAt',
      ]) {
        requireNonEmptyString(value, field);
      }
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !validPrivateRef(value.handleArtifact, 'subagent_handle') ||
        !/^hmac-sha256:[0-9a-f]{64}$/u.test(String(value.handleIntegrityIdentifier)) ||
        !Number.isFinite(Date.parse(String(value.recordedAt)))
      ) {
        throw new Error('Subagent handle-ready evidence is invalid.');
      }
      break;
    }
    case 'capability.subagent_observation_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      requireNonEmptyString(value, 'observedAt');
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !['completed', 'failed', 'cancelled', 'exhausted', 'blocked'].includes(
          String(value.status),
        ) ||
        !Number.isFinite(Date.parse(String(value.observedAt)))
      ) {
        throw new Error('Subagent observation evidence is invalid.');
      }
      break;
    }
    case 'capability.subagent_cleanup_started':
    case 'capability.subagent_cleanup_completed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      const timestamp =
        value.type === 'capability.subagent_cleanup_started' ? 'startedAt' : 'completedAt';
      requireNonEmptyString(value, timestamp);
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !Number.isSafeInteger(value.cleanupAttempt) ||
        Number(value.cleanupAttempt) < 1 ||
        !['undispatched', 'handle_reconcile'].includes(String(value.cleanupKind)) ||
        !Number.isFinite(Date.parse(String(value[timestamp]))) ||
        (value.type === 'capability.subagent_cleanup_completed' &&
          typeof value.cleanupConfirmed !== 'boolean')
      ) {
        throw new Error('Subagent cleanup evidence is invalid.');
      }
      break;
    }
    case 'subagent.suspended': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'toolCallId');
      if (!isRecord(value.snapshot)) throw new Error('Subagent suspension snapshot is invalid.');
      if (value.snapshot.storage === 'private_artifact_v1') {
        const snapshot = value.snapshot;
        const expected = [
          'blockedTool',
          'continuationArtifact',
          'continuationId',
          'modelInvocationOrdinal',
          'parentAttempt',
          'parentInvocationId',
          'role',
          'storage',
          'subagentId',
        ];
        const keys = Object.keys(snapshot).sort();
        if (
          keys.length !== expected.length ||
          keys.some((key, index) => key !== expected[index]) ||
          typeof snapshot.subagentId !== 'string' ||
          snapshot.subagentId.length < 1 ||
          !['explore', 'plan', 'code', 'review'].includes(String(snapshot.role)) ||
          typeof snapshot.continuationId !== 'string' ||
          !/^continuation-[0-9a-f]{64}$/u.test(snapshot.continuationId) ||
          !Number.isSafeInteger(snapshot.modelInvocationOrdinal) ||
          Number(snapshot.modelInvocationOrdinal) < 0 ||
          !validPrivateRef(snapshot.continuationArtifact, 'subagent_continuation') ||
          typeof snapshot.parentInvocationId !== 'string' ||
          snapshot.parentInvocationId.length < 1 ||
          !Number.isSafeInteger(snapshot.parentAttempt) ||
          Number(snapshot.parentAttempt) < 1 ||
          !isRecord(snapshot.blockedTool)
        ) {
          throw new Error('Private Subagent suspension evidence is invalid.');
        }
        const blockedExpected = [
          'reasonCode',
          ...(snapshot.blockedTool.runtimeToolCallId === undefined ? [] : ['runtimeToolCallId']),
          'toolCallId',
          'toolName',
        ].sort();
        const blockedKeys = Object.keys(snapshot.blockedTool).sort();
        if (
          blockedKeys.length !== blockedExpected.length ||
          blockedKeys.some((key, index) => key !== blockedExpected[index]) ||
          !['SUBAGENT_TOOL_REQUIRES_APPROVAL', 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW'].includes(
            String(snapshot.blockedTool.reasonCode),
          ) ||
          typeof snapshot.blockedTool.toolCallId !== 'string' ||
          snapshot.blockedTool.toolCallId.length < 1 ||
          typeof snapshot.blockedTool.toolName !== 'string' ||
          snapshot.blockedTool.toolName.length < 1 ||
          (snapshot.blockedTool.runtimeToolCallId !== undefined &&
            (typeof snapshot.blockedTool.runtimeToolCallId !== 'string' ||
              snapshot.blockedTool.runtimeToolCallId.length < 1))
        ) {
          throw new Error('Private Subagent blocked-tool evidence is invalid.');
        }
      }
      break;
    }
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
