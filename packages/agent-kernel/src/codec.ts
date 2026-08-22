import {
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  CURRENT_RUNTIME_EVENT_TYPE_COUNT,
  type KernelEvent,
  type RuntimeEventType,
} from './events';
import {
  isValidFilesystemIntentV1,
  isValidFilesystemObservationV1,
  isValidFilesystemReadyV1,
  isValidSandboxIntentV1,
  isValidSandboxReadyV1,
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
    /^hmac-sha256:[0-9a-f]{64}$/u.test(value.integrityIdentifier) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) > 0
  );
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function exactRecordKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validModelDataOrigin(value: unknown): boolean {
  if (
    !exactRecordKeys(value, [
      'originId',
      'kind',
      'classification',
      'ownerProjectId',
      'parentOriginIds',
      'observationId',
    ])
  ) {
    return false;
  }
  return (
    typeof value.originId === 'string' &&
    ['runtime', 'project', 'user', 'external', 'credential'].includes(String(value.kind)) &&
    ['public', 'internal', 'confidential', 'secret'].includes(String(value.classification)) &&
    (value.ownerProjectId === null || typeof value.ownerProjectId === 'string') &&
    Array.isArray(value.parentOriginIds) &&
    value.parentOriginIds.every((parent) => typeof parent === 'string') &&
    typeof value.observationId === 'string'
  );
}

function validEgressAuthority(value: unknown, expectedKind: 'model' | 'mcp'): boolean {
  if (
    !exactRecordKeys(value, [
      'egressId',
      'destination',
      'allowedClassifications',
      'allowedOriginKinds',
      'invocationId',
      'expiresAt',
    ]) ||
    !exactRecordKeys(value.destination, [
      'destinationId',
      'kind',
      'routeIdentity',
      'nonceNamespace',
    ])
  ) {
    return false;
  }
  return (
    typeof value.egressId === 'string' &&
    typeof value.destination.destinationId === 'string' &&
    value.destination.kind === expectedKind &&
    typeof value.destination.routeIdentity === 'string' &&
    typeof value.destination.nonceNamespace === 'string' &&
    Array.isArray(value.allowedClassifications) &&
    value.allowedClassifications.every((entry) =>
      ['public', 'internal', 'confidential', 'secret'].includes(String(entry)),
    ) &&
    Array.isArray(value.allowedOriginKinds) &&
    value.allowedOriginKinds.every((entry) =>
      ['runtime', 'project', 'user', 'external', 'credential'].includes(String(entry)),
    ) &&
    typeof value.invocationId === 'string' &&
    validTimestamp(value.expiresAt)
  );
}

const MCP_EGRESS_DECISION_REASONS = new Set([
  'content_free',
  'permit_consumed',
  'feature_disabled',
  'route_unavailable',
  'secret_detected',
  'content_inspection_unknown',
  'permit_missing',
  'permit_invalid',
  'invocation_mismatch',
  'server_identity_mismatch',
  'endpoint_revision_mismatch',
  'tool_revision_mismatch',
  'argument_digest_mismatch',
  'origin_digest_mismatch',
  'classification_mismatch',
  'payload_kind_mismatch',
  'permit_not_yet_valid',
  'permit_ttl_exceeded',
  'permit_expired',
  'permit_replayed',
  'receipt_persistence_failed',
]);

function validMcpEgressDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    'version',
    'invocationId',
    'toolCallId',
    'serverIdentity',
    'endpointRevision',
    'toolRevision',
    'argumentDigest',
    'originDigest',
    'dataClassifications',
    'payloadKinds',
    'admitted',
    'reason',
    'decidedAt',
    'receiptDigest',
  ];
  const optional = [
    'nonceDigest',
    'permitExpiresAt',
    'dataOrigins',
    'sourceOriginIds',
    'egressAuthority',
  ];
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return false;
  }
  const strings = [
    value.invocationId,
    value.toolCallId,
    value.serverIdentity,
    value.endpointRevision,
    value.toolRevision,
    value.argumentDigest,
    value.originDigest,
    value.receiptDigest,
  ];
  if (
    value.version !== 1 ||
    strings.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    typeof value.admitted !== 'boolean' ||
    !MCP_EGRESS_DECISION_REASONS.has(String(value.reason)) ||
    !validTimestamp(value.decidedAt) ||
    !Array.isArray(value.dataClassifications) ||
    value.dataClassifications.some(
      (entry) => !['public', 'internal', 'confidential'].includes(String(entry)),
    ) ||
    !Array.isArray(value.payloadKinds) ||
    value.payloadKinds.some(
      (entry) => !['user_prompt', 'file_snippet', 'tool_result'].includes(String(entry)),
    )
  ) {
    return false;
  }
  if (value.admitted && value.reason === 'permit_consumed') {
    if (
      typeof value.nonceDigest !== 'string' ||
      typeof value.permitExpiresAt !== 'string' ||
      !validTimestamp(value.permitExpiresAt) ||
      !Array.isArray(value.dataOrigins) ||
      value.dataOrigins.length === 0 ||
      value.dataOrigins.some(
        (origin) =>
          !validModelDataOrigin(origin) ||
          !isRecord(origin) ||
          typeof origin.ownerProjectId !== 'string' ||
          origin.ownerProjectId.length === 0,
      ) ||
      !Array.isArray(value.sourceOriginIds) ||
      value.sourceOriginIds.length === 0 ||
      value.sourceOriginIds.some((originId) => typeof originId !== 'string' || !originId) ||
      !validEgressAuthority(value.egressAuthority, 'mcp') ||
      !isRecord(value.egressAuthority) ||
      !isRecord(value.egressAuthority.destination) ||
      value.egressAuthority.destination.kind !== 'mcp'
    ) {
      return false;
    }
  }
  return true;
}

function assertPositiveAttempt(event: Record<string, unknown>): void {
  if (!Number.isSafeInteger(event.attempt) || Number(event.attempt) < 1)
    throw new Error(`Runtime event ${String(event.type)} requires a positive attempt.`);
}

/**
 * Validate the exact State 25 event discriminant and required-field contract.
 * The deeper provider evidence schemas remain private to their Builtin
 * producer; the Kernel applies the same State26 admission checks as the
 * current root codec and leaves JSON conversion to the JSON codec boundary.
 */
export function assertCurrentRuntimeEvent(value: unknown): asserts value is KernelEvent {
  // Match the State26 root codec's admission boundary exactly: event payloads
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
  switch (value.type) {
    case 'approval.granted':
    case 'approval.rejected':
      requireNonEmptyString(value, 'interactionId');
      requireNonEmptyString(value, 'toolCallId');
      break;
    case 'capability.execution_succeeded':
      if (
        value.filesystemObservation !== undefined &&
        !isValidFilesystemObservationV1(value.filesystemObservation)
      )
        throw new Error('Filesystem observation evidence is invalid.');
      break;
    case 'model.invocation_prepared':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      requireNonEmptyString(value, 'routeFingerprint');
      if (
        !Array.isArray(value.dataOrigins) ||
        value.dataOrigins.length === 0 ||
        !Array.isArray(value.egressOriginIds) ||
        value.egressOriginIds.length === 0 ||
        value.dataOrigins.some((origin) => !validModelDataOrigin(origin)) ||
        value.egressOriginIds.some((originId) => typeof originId !== 'string') ||
        !validEgressAuthority(value.egressAuthority, 'model')
      ) {
        throw new Error('Model invocation provenance authority is invalid.');
      }
      break;
    case 'mcp.egress_decided':
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'toolCallId');
      if (!validMcpEgressDecision(value.decision)) {
        throw new Error('MCP egress receipt authority is invalid.');
      }
      break;
    case 'capability.filesystem_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      if (!isValidFilesystemIntentV1(intent)) {
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
      if (!isValidFilesystemReadyV1(ready)) throw new Error('Invalid ready intentDigest.');
      break;
    }
    case 'capability.sandbox_preparation_intent_recorded': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...intent } = value;
      if (!isValidSandboxIntentV1(intent))
        throw new Error('Sandbox preparation intent is invalid.');
      break;
    }
    case 'capability.sandbox_preparation_ready': {
      exactEventKeys(value, CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[value.type]);
      requireNonEmptyString(value, 'invocationId');
      const { type: _type, invocationId: _invocationId, ...ready } = value;
      if (!isValidSandboxReadyV1(ready))
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
        !/^hmac-sha256:[0-9a-f]{64}$/u.test(String(value.handleIntegrityIdentifier)) ||
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
