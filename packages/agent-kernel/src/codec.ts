import {
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  CURRENT_RUNTIME_EVENT_TYPE_COUNT,
  type KernelEvent,
  type RuntimeEventType,
} from './events';
import {
  isValidFilesystemIntent,
  isValidFilesystemObservation,
  isValidFilesystemReady,
  isValidSandboxIntent,
  isValidSandboxReady,
} from './invariants';

export { CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, CURRENT_RUNTIME_EVENT_TYPE_COUNT };

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
    /^sha256:[0-9a-f]{64}$/u.test(value.integrityIdentifier) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) > 0
  );
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validApprovalCommandIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    'sessionId',
    'threadId',
    'workspace',
    'canonicalWorkspaceIdentity',
    'cwd',
    'executor',
    'environment',
    'scope',
    'effects',
    'parserRevision',
    'commandDigest',
  ];
  const optional = ['executorRevision'];
  const keys = Object.keys(value);
  if (
    !required.every((field) => typeof value[field] === 'string' && value[field].length > 0) ||
    keys.some((field) => !required.includes(field) && !optional.includes(field))
  )
    return false;
  return (
    value.executorRevision === undefined ||
    (typeof value.executorRevision === 'string' && value.executorRevision.length > 0)
  );
}

function validInteractionOwner(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'root_tool') {
    return (
      Object.keys(value).length === 2 &&
      Object.keys(value).every((key) => key === 'kind' || key === 'toolCallId') &&
      typeof value.toolCallId === 'string' &&
      value.toolCallId.length > 0
    );
  }
  return (
    value.kind === 'subagent_tool' &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every(
      (key) =>
        key === 'kind' ||
        key === 'toolCallId' ||
        key === 'subagentId' ||
        key === 'parentToolCallId',
    ) &&
    typeof value.toolCallId === 'string' &&
    value.toolCallId.length > 0 &&
    typeof value.subagentId === 'string' &&
    value.subagentId.length > 0 &&
    typeof value.parentToolCallId === 'string' &&
    value.parentToolCallId.length > 0
  );
}

function validToolPresentation(value: unknown): boolean {
  return value === 'exploration' || value === 'standalone' || value === 'hidden';
}

function validToolDisplayLabel(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function validSubagentStepPayload(value: unknown, allowLegacyIdentity: boolean): boolean {
  if (!isRecord(value)) return false;
  const hasStableIdentity =
    typeof value.stepId === 'string' &&
    value.stepId.length > 0 &&
    typeof value.toolCallId === 'string' &&
    value.toolCallId.length > 0;
  if (!allowLegacyIdentity && !hasStableIdentity) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.toolName === 'string' &&
    value.toolName.length > 0 &&
    isRecord(value.toolArgs) &&
    (value.modelInvocationId === undefined ||
      (typeof value.modelInvocationId === 'string' && value.modelInvocationId.length > 0)) &&
    (value.durationMs === undefined ||
      (Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0))
  );
}

function validSubagentToolResultPayload(value: unknown, allowLegacyIdentity: boolean): boolean {
  if (!isRecord(value)) return false;
  const hasStableIdentity =
    typeof value.stepId === 'string' &&
    value.stepId.length > 0 &&
    typeof value.toolCallId === 'string' &&
    value.toolCallId.length > 0;
  return (
    (allowLegacyIdentity || hasStableIdentity) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.toolName === 'string' &&
    value.toolName.length > 0 &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled') &&
    !Object.hasOwn(value, 'ok') &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.totalLines === undefined ||
      (Number.isSafeInteger(value.totalLines) && Number(value.totalLines) >= 0)) &&
    (value.toolTokenCount === undefined ||
      (Number.isSafeInteger(value.toolTokenCount) && Number(value.toolTokenCount) >= 0)) &&
    (value.durationMs === undefined ||
      (Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0)) &&
    (value.failureReason === undefined || typeof value.failureReason === 'string')
  );
}

function assertPositiveAttempt(event: Record<string, unknown>): void {
  if (!Number.isSafeInteger(event.attempt) || Number(event.attempt) < 1)
    throw new Error(`Runtime event ${String(event.type)} requires a positive attempt.`);
}

/**
 * Validate the exact State 27 event discriminant and required-field contract.
 * The deeper provider evidence schemas remain private to their Builtin
 * producer; the Kernel applies the same State admission checks as the
 * current root codec and leaves JSON conversion to the JSON codec boundary.
 */
export function assertCurrentRuntimeEvent(value: unknown): asserts value is KernelEvent {
  // Match the State root codec's admission boundary exactly: event payloads
  // are checked for an object/type discriminant and required fields here.  JSON
  // serializability is intentionally left to encode/decode; JSON.stringify
  // converts values such as Uint8Array in the same way as the root store.
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Runtime event must be an object with a string type.');
  }
  if (!Object.hasOwn(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, value.type)) {
    throw new Error(`Runtime event type ${value.type} is not part of the current format.`);
  }
  const eventType = value.type as RuntimeEventType;
  for (const field of CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[eventType]) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`Runtime event ${eventType} requires ${String(field)}.`);
    }
  }
  if (
    value.type === 'tool.queued' ||
    value.type === 'tool.finished' ||
    value.type === 'tool.failed' ||
    value.type === 'tool.rejected' ||
    value.type === 'tool.cancelled'
  ) {
    if (value.presentation !== undefined && !validToolPresentation(value.presentation)) {
      throw new Error(`${value.type} presentation classification is invalid.`);
    }
    if (value.displayLabel !== undefined && !validToolDisplayLabel(value.displayLabel)) {
      throw new Error(`${value.type} display label is invalid.`);
    }
  }
  switch (value.type) {
    case 'session.rewind_requested':
    case 'session.rewind_completed':
    case 'session.rewind_failed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      for (const field of [
        'rewindId',
        'commandId',
        'sourceSessionId',
        'targetSessionId',
        'checkpointId',
      ]) {
        requireNonEmptyString(value, field);
      }
      if (
        value.scope !== 'conversation_only' &&
        value.scope !== 'conversation_and_workspace' &&
        value.scope !== 'code_only'
      ) {
        throw new Error(`${value.type} scope is invalid.`);
      }
      if (
        value.type === 'session.rewind_failed' &&
        value.failureCode !== 'checkpoint_unavailable' &&
        value.failureCode !== 'execution_failed'
      ) {
        throw new Error('session.rewind_failed failureCode is invalid.');
      }
      break;
    }
    case 'model.text_delta':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'requestId');
      requireNonEmptyString(value, 'text');
      break;
    case 'model.reasoning_delta':
      exactEventKeys(value, [
        ...CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type],
        ...(value.segmentId === undefined ? [] : ['segmentId']),
      ]);
      requireNonEmptyString(value, 'requestId');
      requireNonEmptyString(value, 'text');
      if (value.segmentId !== undefined) requireNonEmptyString(value, 'segmentId');
      break;
    case 'model.reasoning_completed':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'requestId');
      requireNonEmptyString(value, 'segmentId');
      requireNonEmptyString(value, 'text');
      break;
    case 'provider.admission_status':
      exactEventKeys(value, [
        ...CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type],
        ...(value.admissionRevision === undefined ? [] : ['admissionRevision']),
      ]);
      requireNonEmptyString(value, 'status');
      requireNonEmptyString(value, 'reason');
      if (value.admissionRevision !== undefined) {
        requireNonEmptyString(value, 'admissionRevision');
      }
      break;
    case 'approval.granted':
    case 'approval.rejected':
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'toolCallId');
      if (!validInteractionOwner(value.owner)) {
        throw new Error(`${value.type} owner binding is invalid.`);
      }
      if (value.type === 'approval.granted' && value.grant !== 'approve_once') {
        throw new Error('approval.granted may only issue approve_once.');
      }
      if (
        !Number.isSafeInteger(value.generation) ||
        Number(value.generation) < 0 ||
        (value.type === 'approval.granted' &&
          (typeof value.receiptId !== 'string' || value.receiptId.length === 0))
      ) {
        throw new Error(`${value.type} receipt/generation is invalid.`);
      }
      break;
    case 'approval.batch_released': {
      exactEventKeys(value, [
        ...CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type],
        ...(value.cancelledReviewIds === undefined ? [] : ['cancelledReviewIds']),
      ]);
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'toolCallId');
      requireNonEmptyString(value, 'grantKey');
      if (!validInteractionOwner(value.owner))
        throw new Error('approval.batch_released owner binding is invalid.');
      if (value.grant !== 'same_command')
        throw new Error('approval.batch_released requires same_command.');
      if (!validApprovalCommandIdentity(value.commandIdentity))
        throw new Error('approval.batch_released command identity is invalid.');
      if (!Number.isSafeInteger(value.sessionRevision) || Number(value.sessionRevision) < 0)
        throw new Error('approval.batch_released sessionRevision is invalid.');
      if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
        throw new Error('approval.batch_released generation is invalid.');
      if (!Array.isArray(value.matches) || value.matches.length === 0)
        throw new Error('approval.batch_released matches are required.');
      const receiptIds = new Set<string>();
      for (const match of value.matches) {
        if (
          !isRecord(match) ||
          (() => {
            const expected = new Set([
              'interactionId',
              'toolCallId',
              'receiptId',
              'generation',
              'owner',
              ...(match.bindingDigest === undefined ? [] : ['bindingDigest']),
            ]);
            const keys = Object.keys(match);
            return keys.length !== expected.size || keys.some((key) => !expected.has(key));
          })() ||
          typeof match.interactionId !== 'string' ||
          match.interactionId.length === 0 ||
          typeof match.toolCallId !== 'string' ||
          match.toolCallId.length === 0 ||
          typeof match.receiptId !== 'string' ||
          match.receiptId.length === 0 ||
          receiptIds.has(match.receiptId) ||
          !Number.isSafeInteger(match.generation) ||
          Number(match.generation) < 0 ||
          !validInteractionOwner(match.owner) ||
          (match.bindingDigest !== undefined &&
            (typeof match.bindingDigest !== 'string' || match.bindingDigest.length === 0))
        ) {
          throw new Error('approval.batch_released match is invalid.');
        }
        receiptIds.add(match.receiptId);
      }
      if (value.cancelledReviewIds !== undefined) {
        if (
          !Array.isArray(value.cancelledReviewIds) ||
          value.cancelledReviewIds.some(
            (reviewId) => typeof reviewId !== 'string' || reviewId.length === 0,
          ) ||
          new Set(value.cancelledReviewIds).size !== value.cancelledReviewIds.length
        ) {
          throw new Error('approval.batch_released cancelled review identities are invalid.');
        }
      }
      if (!validTimestamp(value.createdAt))
        throw new Error('approval.batch_released createdAt is invalid.');
      break;
    }
    case 'approval.requested':
    case 'auto_review.requested':
      if (
        value.commandIdentity !== undefined &&
        !validApprovalCommandIdentity(value.commandIdentity)
      )
        throw new Error(`${value.type} command identity is invalid.`);
      if (
        typeof value.fullModeBypassEligible !== 'boolean' ||
        typeof value.fullModePolicyBypassAllowed !== 'boolean'
      )
        throw new Error(`${value.type} Full-mode eligibility is invalid.`);
      if (!validInteractionOwner(value.owner))
        throw new Error(`${value.type} owner binding is invalid.`);
      break;
    case 'approval.session_grants_cleared':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'sessionId');
      if (!Number.isSafeInteger(value.sessionRevision) || Number(value.sessionRevision) < 0)
        throw new Error('approval.session_grants_cleared sessionRevision is invalid.');
      if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
        throw new Error('approval.session_grants_cleared generation is invalid.');
      if (!validTimestamp(value.clearedAt))
        throw new Error('approval.session_grants_cleared clearedAt is invalid.');
      break;
    case 'auto_review.completed':
      if (!validInteractionOwner(value.owner))
        throw new Error('auto_review.completed owner binding is invalid.');
      if (!isRecord(value.result)) throw new Error('auto_review.completed result is invalid.');
      if (value.result.escalatedToUser !== undefined && value.result.escalatedToUser !== true) {
        throw new Error('auto_review.completed escalation disposition is invalid.');
      }
      break;
    case 'subagent.step':
      if (!validSubagentStepPayload(value.subagent, true)) {
        throw new Error('subagent.step payload is invalid.');
      }
      break;
    case 'subagent.tool_result':
      if (!validSubagentToolResultPayload(value.subagent, true)) {
        throw new Error('subagent.tool_result payload is invalid.');
      }
      break;
    case 'subagent.approval_deferred':
      exactEventKeys(value, [
        ...CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type],
        ...(value.interactionId === undefined ? [] : ['interactionId']),
        ...(value.approvalState === undefined ? [] : ['approvalState']),
      ]);
      requireNonEmptyString(value, 'toolCallId');
      requireNonEmptyString(value, 'subagentId');
      requireNonEmptyString(value, 'parentToolCallId');
      if (value.interactionId !== undefined) requireNonEmptyString(value, 'interactionId');
      if (
        value.approvalState !== undefined &&
        ![
          'queued_auto_review',
          'auto_reviewing',
          'queued_user_approval',
          'awaiting_user',
          'authorized_queued',
        ].includes(String(value.approvalState))
      ) {
        throw new Error('subagent.approval_deferred approval state is invalid.');
      }
      break;
    case 'capability.execution_succeeded':
      if (
        value.filesystemObservation !== undefined &&
        !isValidFilesystemObservation(value.filesystemObservation)
      )
        throw new Error('Filesystem observation evidence is invalid.');
      break;
    case 'model.invocation_prepared':
      exactEventKeys(value, [
        ...CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type],
        ...(value.admission === undefined ? [] : ['admission']),
      ]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'routeFingerprint');
      if (value.admission !== undefined) {
        const admission = value.admission;
        if (
          !isRecord(admission) ||
          Object.keys(admission).sort().join(',') !==
            'admitted,payloadClassificationDigest,providerAdmissionRevision,routeIdentityDigest' ||
          (admission.providerAdmissionRevision !== null &&
            typeof admission.providerAdmissionRevision !== 'string') ||
          !/^sha256:[0-9a-f]{64}$/u.test(String(admission.routeIdentityDigest)) ||
          !/^sha256:[0-9a-f]{64}$/u.test(String(admission.payloadClassificationDigest)) ||
          typeof admission.admitted !== 'boolean'
        ) {
          throw new Error('Legacy model invocation admission evidence is invalid.');
        }
      }
      break;
    case 'capability.filesystem_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      if (!isValidFilesystemIntent(intent)) {
        throw new Error('Filesystem intent evidence digest mismatch or identity invalid.');
      }
      break;
    }
    case 'capability.filesystem_mutation_ready': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...ready } = value;
      const artifact = isRecord(ready.preimageArtifact) ? ready.preimageArtifact : undefined;
      if (
        artifact &&
        (!Number.isSafeInteger(artifact.byteLength) || Number(artifact.byteLength) < 0)
      ) {
        throw new Error('Invalid Artifact byteLength.');
      }
      if (!validTimestamp(ready.readyAt)) throw new Error('Invalid readyAt.');
      if (!isValidFilesystemReady(ready)) throw new Error('Invalid ready intentDigest.');
      break;
    }
    case 'capability.sandbox_preparation_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      if (!isValidSandboxIntent(intent)) throw new Error('Sandbox preparation intent is invalid.');
      break;
    }
    case 'capability.sandbox_preparation_ready': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...ready } = value;
      if (!isValidSandboxReady(ready))
        throw new Error('Sandbox preparation ready record is invalid.');
      break;
    }
    case 'capability.sandbox_execution_dispatch_intent_recorded':
    case 'capability.sandbox_execution_supervisor_started':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'dispatchId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      assertPositiveAttempt(value);
      if (value.type === 'capability.sandbox_execution_dispatch_intent_recorded') {
        requireNonEmptyString(value, 'readyDigest');
        requireNonEmptyString(value, 'planDigest');
        requireNonEmptyString(value, 'supervisorNonce');
        requireNonEmptyString(value, 'recordedAt');
        if (!validTimestamp(value.recordedAt))
          throw new Error('Sandbox dispatch intent requires a valid timestamp.');
      } else {
        requireNonEmptyString(value, 'processStartIdentity');
        requireNonEmptyString(value, 'startedAt');
        if (
          !Number.isSafeInteger(value.supervisorPid) ||
          Number(value.supervisorPid) < 1 ||
          value.processGroupId !== value.supervisorPid ||
          !validTimestamp(value.startedAt)
        )
          throw new Error('Sandbox supervisor start evidence is invalid.');
      }
      break;
    case 'capability.sandbox_disposal_started':
    case 'capability.sandbox_disposal_completed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'readyDigest');
      requireNonEmptyString(value, 'lifecycleIntentDigest');
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1)
        throw new Error(`Runtime event ${value.type} requires a positive attempt.`);
      const timestampField =
        value.type === 'capability.sandbox_disposal_started' ? 'startedAt' : 'disposedAt';
      requireNonEmptyString(value, timestampField);
      if (!validTimestamp(value[timestampField]))
        throw new Error(`Runtime event ${value.type} requires a valid timestamp.`);
      if (
        value.type === 'capability.sandbox_disposal_completed' &&
        (typeof value.disposed !== 'boolean' ||
          !Number.isSafeInteger(value.cleanupAttempt) ||
          Number(value.cleanupAttempt) < 1)
      )
        throw new Error('Sandbox disposal completion requires a boolean disposed receipt.');
      break;
    }
    case 'capability.sandbox_preparation_abandonment_started':
    case 'capability.sandbox_preparation_abandonment_completed': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'intentDigest');
      requireNonEmptyString(value, 'lifecycleIntentDigest');
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1)
        throw new Error(`Runtime event ${value.type} requires a positive attempt.`);
      const timestampField =
        value.type === 'capability.sandbox_preparation_abandonment_started'
          ? 'startedAt'
          : 'disposedAt';
      requireNonEmptyString(value, timestampField);
      if (!validTimestamp(value[timestampField]))
        throw new Error(`Runtime event ${value.type} requires a valid timestamp.`);
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
    case 'capability.subagent_dispatch_intent_recorded':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      assertPositiveAttempt(value);
      requireNonEmptyString(value, 'childInvocationId');
      requireNonEmptyString(value, 'dispatchIntentDigest');
      requireNonEmptyString(value, 'recordedAt');
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !['start', 'resume'].includes(String(value.purpose)) ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !validPrivateRef(value.taskArtifact, 'subagent_task') ||
        !validTimestamp(value.recordedAt)
      )
        throw new Error('Subagent dispatch intent evidence is invalid.');
      break;
    case 'capability.subagent_handle_recorded':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      assertPositiveAttempt(value);
      for (const field of ['dispatchIntentDigest', 'handleIntegrityIdentifier', 'recordedAt'])
        requireNonEmptyString(value, field);
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !validPrivateRef(value.handleArtifact, 'subagent_handle') ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.handleIntegrityIdentifier)) ||
        !validTimestamp(value.recordedAt)
      )
        throw new Error('Subagent handle-ready evidence is invalid.');
      break;
    case 'capability.subagent_observation_recorded':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      assertPositiveAttempt(value);
      for (const field of ['dispatchIntentDigest', 'observedAt'])
        requireNonEmptyString(value, field);
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !['completed', 'failed', 'cancelled', 'exhausted', 'blocked'].includes(
          String(value.status),
        ) ||
        !validTimestamp(value.observedAt)
      )
        throw new Error('Subagent observation evidence is invalid.');
      break;
    case 'capability.subagent_cleanup_started':
    case 'capability.subagent_cleanup_completed':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      assertPositiveAttempt(value);
      for (const field of ['dispatchIntentDigest', 'cleanupKind'])
        requireNonEmptyString(value, field);
      requireNonEmptyString(value, value.type.endsWith('started') ? 'startedAt' : 'completedAt');
      if (
        !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(value.dispatchIntentDigest)) ||
        !Number.isSafeInteger(value.cleanupAttempt) ||
        Number(value.cleanupAttempt) < 1 ||
        !['undispatched', 'handle_reconcile'].includes(String(value.cleanupKind)) ||
        !validTimestamp(value.type.endsWith('started') ? value.startedAt : value.completedAt) ||
        (value.type.endsWith('completed') && typeof value.cleanupConfirmed !== 'boolean')
      )
        throw new Error('Subagent cleanup evidence is invalid.');
      break;
    case 'subagent.suspended': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'toolCallId');
      const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
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
      if (
        !snapshot ||
        Object.keys(snapshot).length !== expected.length ||
        Object.keys(snapshot)
          .sort()
          .some((key, index) => key !== expected.sort()[index]) ||
        snapshot.storage !== 'private_artifact_v1' ||
        typeof snapshot.subagentId !== 'string' ||
        snapshot.subagentId.length < 1 ||
        !validPrivateRef(snapshot.continuationArtifact, 'subagent_continuation') ||
        !/^continuation-[0-9a-f]{64}$/u.test(String(snapshot.continuationId)) ||
        !['explore', 'plan', 'code', 'review'].includes(String(snapshot.role)) ||
        !Number.isSafeInteger(snapshot.modelInvocationOrdinal) ||
        Number(snapshot.modelInvocationOrdinal) < 0 ||
        typeof snapshot.parentInvocationId !== 'string' ||
        snapshot.parentInvocationId.length < 1 ||
        !Number.isSafeInteger(snapshot.parentAttempt) ||
        Number(snapshot.parentAttempt) < 1 ||
        !isRecord(snapshot.blockedTool)
      )
        throw new Error('Private Subagent suspension evidence is invalid.');
      const blockedTool = snapshot.blockedTool;
      const blockedExpected = [
        'reasonCode',
        ...(blockedTool.runtimeToolCallId === undefined ? [] : ['runtimeToolCallId']),
        'toolCallId',
        'toolName',
      ].sort();
      if (
        Object.keys(blockedTool).sort().join(',') !== blockedExpected.join(',') ||
        !['SUBAGENT_TOOL_REQUIRES_APPROVAL', 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW'].includes(
          String(blockedTool.reasonCode),
        ) ||
        !validNonEmptyString(blockedTool.toolCallId) ||
        !validNonEmptyString(blockedTool.toolName)
      )
        throw new Error('Private Subagent blocked-tool evidence is invalid.');
      break;
    }
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
      for (const field of ['planId', 'structuralDigest']) requireNonEmptyString(value, field);
      if (!Number.isInteger(value.version) || Number(value.version) < 1)
        throw new Error(`Runtime event ${value.type} requires a positive version.`);
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
      if (!isRecord(value.failure))
        throw new Error('Runtime event tool.failed requires structured failure.');
      break;
    default:
      break;
  }
}

/**
 * Admit a newly produced event. Retired shapes remain readable so existing
 * sessions can replay and fork, but no current producer may append them.
 */
export function assertCurrentRuntimeEventForWrite(value: unknown): asserts value is KernelEvent {
  assertCurrentRuntimeEvent(value);
  const event = value as Readonly<Record<string, unknown>>;
  if (event.type === 'provider.admission_status') {
    throw new Error('Retired provider admission status is read-only compatibility data.');
  }
  if (
    event.type === 'model.invocation_prepared' &&
    (Object.hasOwn(event, 'admission') || event.purpose === 'verification_review')
  ) {
    throw new Error('Retired model invocation evidence is read-only compatibility data.');
  }
  if (event.type === 'verification.requested') {
    const spec = isRecord(event.spec) ? event.spec : undefined;
    const checks = Array.isArray(spec?.checks) ? spec.checks : [];
    if (checks.some((check) => isRecord(check) && check.type === 'reviewer')) {
      throw new Error('Retired verification reviewer checks are read-only compatibility data.');
    }
  }
  if (event.type === 'approval.requested') {
    const approval = isRecord(event.approval) ? event.approval : undefined;
    const grantOptions = Array.isArray(approval?.grantOptions) ? approval.grantOptions : [];
    if (
      approval?.recommendedGrant === 'full_access' ||
      grantOptions.some((grant) => grant === 'full_access')
    ) {
      throw new Error('Legacy full_access approval data is read-only compatibility data.');
    }
  }
  if (event.type === 'approval.rejected' && Object.hasOwn(event, 'outcomeV1')) {
    throw new Error('Legacy approval rejection data is read-only compatibility data.');
  }
  if (event.type === 'auto_review.requested') {
    const approval = isRecord(event.approval) ? event.approval : undefined;
    const grantOptions = Array.isArray(approval?.grantOptions) ? approval.grantOptions : [];
    if (
      approval?.recommendedGrant === 'full_access' ||
      grantOptions.some((grant) => grant === 'full_access')
    ) {
      throw new Error('Legacy full_access review data is read-only compatibility data.');
    }
  }
  if (event.type === 'auto_review.completed') {
    const result = isRecord(event.result) ? event.result : undefined;
    if (
      Object.hasOwn(event, 'outcomeV1') ||
      (result?.grant !== undefined && result.grant !== 'approve_once')
    ) {
      throw new Error('Legacy auto-review data is read-only compatibility data.');
    }
  }
  if (event.type === 'subagent.started') {
    const subagent = isRecord(event.subagent) ? event.subagent : undefined;
    if (
      !subagent ||
      typeof subagent.name !== 'string' ||
      subagent.name.length === 0 ||
      Object.hasOwn(subagent, 'task')
    ) {
      throw new Error('Retired subagent task titles are read-only compatibility data.');
    }
  }
  if (event.type === 'subagent.step' && !validSubagentStepPayload(event.subagent, false)) {
    throw new Error('Legacy Subagent step identity is read-only compatibility data.');
  }
  if (
    event.type === 'subagent.tool_result' &&
    !validSubagentToolResultPayload(event.subagent, false)
  ) {
    throw new Error('Legacy Subagent tool-result identity is read-only compatibility data.');
  }
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodeCurrentRuntimeEventJson(serialized: string): KernelEvent {
  const value = JSON.parse(serialized) as unknown;
  assertCurrentRuntimeEvent(value);
  return value;
}

export function encodeCurrentRuntimeEventJson(event: KernelEvent): string {
  assertCurrentRuntimeEvent(event);
  const encoded = JSON.stringify(event);
  if (encoded === undefined) throw new Error('Runtime event could not be encoded.');
  return encoded;
}
