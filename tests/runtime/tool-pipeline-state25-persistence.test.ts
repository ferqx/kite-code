import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { BuiltinWorkspaceFilesystemTerminalVerifierV1 } from '@kite/builtin-runtime';
import { digestCapabilityValueV1, isBuiltinOperationExecutionValueV1 } from '@kite/builtin-runtime';
import {
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemStringDigestV1,
} from '@kite/builtin-runtime/filesystem';
import { computePlanStructuralDigest } from '@kite/builtin-runtime/planning';
import {
  createDeterministicRuntimeIdSourceV1,
  createRuntimeHostState26InitialStateV1,
  createRuntimeHostState26SessionV1,
  createRuntimeHostToolPipelineAttemptCoordinatorV1,
  type RuntimeHostExecutionServices,
  type State26RuntimeSessionInputV1,
  type State26RuntimeStateV1,
} from '@kite/runtime-host';
import type {
  CapabilityToolTerminalResultV1,
  DynamicMcpPreparedToolInvocationIdentityV1,
  NonDynamicOperationIdV1,
  NonDynamicPreparedToolInvocationIdentityV1,
  PreparedToolInvocationV1,
  PrivateSuspendedSubagentRecordV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineSuspendedExecutionResultV1,
  ToolPipelineTaskSubagentSuspensionV1,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 } from '@kite/runtime-spi';
import {
  createAppState26ToolPipelinePersistenceV1,
  type State26BuiltinOperationStructuredContentV1,
} from '#app/bootstrap/runtime/tool-pipeline-state26-persistence';

const NOW = '2026-08-22T00:00:00.000Z';
const NEXT = '2026-08-22T00:00:01.000Z';
const RECOVERY_KEY = 'a'.repeat(64);
const OPERATION_ID = 'builtin:read_file' as NonDynamicOperationIdV1;
const EFFECTS = Object.freeze({
  filesystem: 'read' as const,
  network: 'none' as const,
  externalState: 'none' as const,
});
const EFFECTS_DIGEST = digestCapabilityValueV1(EFFECTS);
const TASK_EFFECTS = Object.freeze({
  filesystem: 'unknown' as const,
  network: 'unknown' as const,
  externalState: 'none' as const,
});
const TASK_EFFECTS_DIGEST = digestCapabilityValueV1(TASK_EFFECTS);
const TASK_BLOCKED_ARGUMENTS = Object.freeze({ path: 'README.md' });
const TASK_BLOCKED_COMMAND = 'write child file';
const TASK_BLOCKED_ARGUMENTS_DIGEST = digestCapabilityValueV1(TASK_BLOCKED_ARGUMENTS);
const TASK_BLOCKED_COMMAND_DIGEST = digestCapabilityValueV1(TASK_BLOCKED_COMMAND);
const AUTHENTIC_FILESYSTEM_OBSERVATION = Object.freeze({
  actorIdentityDigest: 'a'.repeat(64),
  lexicalTargetDigest: workspaceFilesystemStringDigestV1('README.md'),
  canonicalTargetDigest: `sha256:${'c'.repeat(64)}`,
  targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
  contentDigest: `sha256:${'e'.repeat(64)}`,
});
const REJECT_FILESYSTEM_TERMINAL: BuiltinWorkspaceFilesystemTerminalVerifierV1 = () => ({
  valid: false,
  code: 'terminal_not_issued',
});

function initialState(): State26RuntimeStateV1 {
  return createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey: RECOVERY_KEY,
    threadId: 'state26-persistence-test',
    userId: 'user-1',
    workspace: '/workspace',
    runtimeIdSource: createDeterministicRuntimeIdSourceV1({
      seed: 'state26-persistence',
      epochMs: Date.parse(NOW),
    }),
  });
}

function services(): RuntimeHostExecutionServices<RuntimeEvent, State26RuntimeStateV1> {
  return {
    sessions: {
      appendEvents: () => undefined,
      loadEventsStrict: () => [],
      saveSnapshot: () => undefined,
      loadSnapshot: () => null,
      loadSnapshotRecord: () => null,
      getLastEventPosition: () => 0,
      listSessions: () => [],
      setSessionName: () => undefined,
      getSessionModelRoute: () => null,
      setSessionModelRoute: () => undefined,
      deleteSession: () => undefined,
    },
    transactions: { commit: () => undefined },
    leases: {
      tryAcquire: () => true,
      renew: () => true,
      release: () => undefined,
      hasClaim: () => true,
    },
    checkpoints: {
      saveNamedSnapshot: () => undefined,
      loadNamedSnapshot: () => null,
      listNamedSnapshots: () => [],
      getNamedSnapshotEntry: () => null,
      restoreNamedSnapshot: () => false,
      forkSession: () => false,
      forkCurrentSession: () => false,
      recordFilePreimage: () => undefined,
      recordFilePostimage: () => undefined,
      fileRestorePlan: () => [],
    },
    recoveryIdentities: {
      read: () => RECOVERY_KEY,
      getOrCreate: (_sessionId, allocate) => allocate(),
      remove: () => undefined,
    },
  };
}

function createSession(state = initialState()) {
  return createRuntimeHostState26SessionV1({
    state,
    services: services(),
    clock: () => NOW,
    id: (kind) => `${kind}-1`,
    sandboxAvailable: true,
  } satisfies State26RuntimeSessionInputV1);
}

function prepared(attempt = 1): Readonly<PreparedToolInvocationV1> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>;
} {
  const argumentsValue = { path: 'README.md' } as const;
  const argumentsDigest = digestCapabilityValueV1(argumentsValue);
  const identity: NonDynamicPreparedToolInvocationIdentityV1 = {
    invocationId: 'invocation-1',
    attemptId: `invocation-1:attempt:${attempt}`,
    toolCallId: 'call-1',
    turnId: initialState().turn.turnId,
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'builtin-provider',
    operationId: OPERATION_ID,
    executionFamily: 'builtin',
    executionMechanism: 'filesystem',
    capabilityId: OPERATION_ID,
    capabilityRevision: digestCapabilityValueV1({ capability: 'read_file', revision: 1 }),
    descriptorRevision: 'descriptor-1',
    parserRevision: 'parser-1',
    executorRevision: 'executor-1',
    argumentsDigest,
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: EFFECTS_DIGEST,
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: digestCapabilityValueV1({ admission: 'policy_allow', revision: 1 }),
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: 'read_file',
    builtinProjectionRevision: 'builtin-1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: 'computer',
  };
  return Object.freeze({
    identity: Object.freeze(identity),
    input: Object.freeze({
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: argumentsValue,
      request: {
        schema: 'kite.tool-pipeline-prepared-request.v1',
        authorizationKind: 'policy_allow',
        grantUsed: 'none',
        policyEffects: {},
        effectiveEffects: EFFECTS,
        receiptRequirement: 'observation_receipt',
        retryEligibility: 'none',
        taskId: null,
        planId: null,
        planStepId: null,
        capabilityRequestFacts: null,
      },
      binding: null,
      facts: {},
    }),
  });
}

function taskPrepared(
  attempt = 1,
  argumentOrigin: 'model_public' | 'runtime_private' = 'runtime_private',
): Readonly<PreparedToolInvocationV1> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>;
} {
  const base = prepared(attempt);
  const baseRequest = base.input.request;
  if (!baseRequest || typeof baseRequest !== 'object' || Array.isArray(baseRequest)) {
    throw new Error('invalid task prepared request fixture');
  }
  const argumentsValue = Object.freeze({
    subagent_type: 'code' as const,
    ...(argumentOrigin === 'model_public'
      ? { task: 'Implement the bounded task suspension fixture.' }
      : {
          taskArtifact: {
            artifactId: `pa_${'4'.repeat(64)}`,
            kind: 'subagent_task_request' as const,
            integrityIdentifier: `hmac-sha256:${'5'.repeat(64)}`,
            byteLength: 128,
          },
        }),
  });
  const identity: NonDynamicPreparedToolInvocationIdentityV1 = {
    ...base.identity,
    argumentOrigin,
    invocationId: 'invocation-task-1',
    attemptId: `invocation-task-1:attempt:${attempt}`,
    operationId: 'builtin:task' as NonDynamicOperationIdV1,
    executionFamily: 'subagent',
    executionMechanism: 'subagent',
    capabilityId: 'builtin:task',
    capabilityRevision: 'task-capability-1',
    descriptorRevision: 'task-descriptor-1',
    parserRevision: 'task-parser-1',
    executorRevision: 'task-executor-1',
    argumentsDigest: digestCapabilityValueV1(argumentsValue),
    effectiveEffectsDigest: TASK_EFFECTS_DIGEST,
    exposedToolName: 'task',
    toolKind: 'coordination',
  };
  return Object.freeze({
    identity: Object.freeze(identity),
    input: Object.freeze({
      ...base.input,
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      arguments: argumentsValue,
      request: Object.freeze({
        ...baseRequest,
        effectiveEffects: TASK_EFFECTS,
        receiptRequirement: 'control_receipt' as const,
      }),
    }),
  });
}

function artifactRef(invocationId: string) {
  return {
    artifactId: `artifact-${invocationId}`,
    kind: 'capability_result' as const,
    integrityIdentifier: 'b'.repeat(64),
    byteLength: 10,
  };
}

function readOperation() {
  return Object.freeze({
    operationId: 'builtin:read_file' as const,
    kind: 'read_file' as const,
    path: 'README.md',
    pathScope: 'workspace_only' as const,
  });
}

function readIntentRecord(acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>) {
  const operation = readOperation();
  const { operationId: _operationId, ...providerOperation } = operation;
  const unsigned = Object.freeze({
    attempt: acknowledgement.attempt.attempt,
    capabilityRevision: acknowledgement.attempt.capabilityRevision,
    argumentsDigest: acknowledgement.attempt.argumentsDigest,
    admissionDigest: acknowledgement.attempt.admissionDigest!,
    operationDigest: workspaceFilesystemOperationDigestV1(providerOperation),
    searchBoundaryDigest: workspaceFilesystemStringDigestV1('protected-boundary-1'),
    lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
    canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1('/workspace'),
    protectedPathRevision: 'protected-path-revision-1',
    approvalSummaryDigest: workspaceFilesystemStringDigestV1('read_file README.md'),
    effectiveEffectsDigest: acknowledgement.attempt.effectiveEffectsDigest,
    recordedAt: NEXT,
  });
  return Object.freeze({
    ...unsigned,
    intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
  });
}

function dynamicPrepared(): Readonly<PreparedToolInvocationV1> {
  const base = prepared(1);
  const identity: DynamicMcpPreparedToolInvocationIdentityV1 = {
    ...base.identity,
    capabilityId: 'mcp:server:fixture',
    capabilityRevision: 'subject-capability-1',
    descriptorRevision: 'subject-descriptor-1',
    parserRevision: 'wrapper-parser-1',
    executorRevision: null,
    argumentOrigin: 'model_public',
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    isDynamicMcp: true,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'dynamic-1',
    subject: {
      capabilityId: 'mcp:server:fixture',
      capabilityRevision: 'subject-capability-1',
      descriptorRevision: 'subject-descriptor-1',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__fixture',
      dynamicCatalogRevision: 'dynamic-1',
      bindingId: null,
    },
    runtimeWrapper: {
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime',
      capabilityRevision: 'wrapper-capability-1',
      executorRevision: 'wrapper-executor-1',
      schemaDigest: 'wrapper-schema-1',
      builtinProjectionRevision: 'builtin-1',
    },
  };
  return Object.freeze({ ...base, identity: Object.freeze(identity) });
}

function dynamicRetryPrepared(attempt = 1): Readonly<PreparedToolInvocationV1> {
  const base = prepared(attempt);
  const baseRequest = base.input.request;
  if (!baseRequest || typeof baseRequest !== 'object' || Array.isArray(baseRequest)) {
    throw new Error('invalid prepared request fixture');
  }
  const bindingId = 'dynamic-binding-1';
  const identity: DynamicMcpPreparedToolInvocationIdentityV1 = {
    ...base.identity,
    bindingId,
    providerId: 'mcp-provider',
    capabilityId: 'mcp:server:fixture',
    capabilityRevision: 'subject-capability-1',
    descriptorRevision: 'subject-descriptor-1',
    parserRevision: 'wrapper-parser-1',
    executorRevision: null,
    argumentOrigin: 'model_public',
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    isDynamicMcp: true,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'dynamic-1',
    subject: Object.freeze({
      capabilityId: 'mcp:server:fixture',
      capabilityRevision: 'subject-capability-1',
      descriptorRevision: 'subject-descriptor-1',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__fixture',
      dynamicCatalogRevision: 'dynamic-1',
      bindingId,
    }),
    runtimeWrapper: Object.freeze({
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime',
      capabilityRevision: 'wrapper-capability-1',
      executorRevision: 'wrapper-executor-1',
      schemaDigest: 'wrapper-schema-1',
      builtinProjectionRevision: 'builtin-1',
    }),
  };
  return Object.freeze({
    identity: Object.freeze(identity),
    input: Object.freeze({
      ...base.input,
      binding: Object.freeze({
        bindingId,
        capabilityId: identity.subject.capabilityId,
        capabilityRevision: identity.subject.capabilityRevision,
        exposedToolName: identity.subject.exposedToolName,
        schemaDigest: identity.schemaDigest,
        issuedForTurnId: identity.turnId,
      }),
      request: Object.freeze({
        ...baseRequest,
        retryEligibility: 'safe_read_candidate' as const,
      }),
    }),
  });
}

function retryableProviderFailureResult(): CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1> {
  const retryableValue: RuntimeJsonValueV1 = {
    schema: 'kite.builtin-operation-result.v1',
    ok: false,
    stdout: '',
    stderr: 'provider unavailable',
    resultMeta: {
      providerFailure: { code: 'provider_unavailable', retryable: true },
    },
  };
  if (!isBuiltinOperationExecutionValueV1(retryableValue)) {
    throw new Error('invalid retryable provider failure fixture');
  }
  return Object.freeze({
    status: 'error' as const,
    content: Object.freeze([{ type: 'text', text: 'provider unavailable' }]),
    structuredContent: retryableValue,
    failure: Object.freeze({
      code: 'provider_unavailable',
      message: 'provider unavailable',
      retryable: true,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    }),
  });
}

function structuredContent(
  overrides: Readonly<Record<string, RuntimeJsonValueV1>> = {},
): State26BuiltinOperationStructuredContentV1 {
  const value: RuntimeJsonValueV1 = {
    schema: 'kite.builtin-operation-result.v1',
    ok: true,
    stdout: 'read ok',
    stderr: '',
    resultMeta: { command: 'read_file', rawResultDigest: 'raw-1' },
    path: 'README.md',
    totalLines: 1,
    ...overrides,
  };
  if (!isBuiltinOperationExecutionValueV1(value)) throw new Error('invalid test result fixture');
  return value;
}

function structuredContentWithObservation(
  overrides: Readonly<Record<string, RuntimeJsonValueV1>> = {},
): State26BuiltinOperationStructuredContentV1 {
  return structuredContent({
    filesystemObservation: AUTHENTIC_FILESYSTEM_OBSERVATION,
    ...overrides,
  });
}

function structuredContentWithoutObservation(
  overrides: Readonly<Record<string, RuntimeJsonValueV1>> = {},
): State26BuiltinOperationStructuredContentV1 {
  const { filesystemObservation: _filesystemObservation, ...withoutObservation } = overrides;
  return structuredContent({ ...withoutObservation, ok: overrides.ok ?? true });
}

function result(
  overrides: Partial<
    CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1>
  > = {},
): CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1> {
  const status = overrides.status ?? 'success';
  return {
    status,
    content: [{ type: 'text', text: 'read ok' }],
    structuredContent:
      status === 'success' ? structuredContent() : structuredContentWithoutObservation(),
    ...overrides,
  };
}

function taskSuspension(
  executionMode: 'start' | 'resume' = 'start',
  eventKind: 'approval' | 'auto_review' = 'approval',
): ToolPipelineTaskSubagentSuspensionV1 {
  const approval = {
    scope: 'once' as const,
    callId: 'runtime-task-child-call-1',
    cwd: '/workspace',
    threadId: 'state26-persistence-test',
    tool: 'write_file',
    command: 'write child file',
    risk: 'write_file' as const,
    approvalHash: 'task-approval-binding-1',
    summary: 'The task child write requires approval.',
    reason: 'The task child write requires review.',
    expectedEffects: ['child file update'],
    grantOptions: ['approve_once' as const],
    recommendedGrant: 'approve_once' as const,
  };
  const event =
    eventKind === 'approval'
      ? {
          type: 'approval.requested' as const,
          interactionId: executionMode === 'resume' ? 'interaction-task-2' : 'interaction-task-1',
          toolCallId: 'call-1',
          approval,
          createdAt: NEXT,
        }
      : {
          type: 'auto_review.requested' as const,
          reviewId: executionMode === 'resume' ? 'review-task-2' : 'review-task-1',
          toolCallId: 'call-1',
          toolName: 'write_file',
          reason: 'The task child write requires auto review.',
          approval,
          requestFingerprint: 'task-request-fingerprint-1',
          createdAt: NEXT,
        };
  const continuationId = `continuation-${'1'.repeat(64)}`;
  const subagent: PrivateSuspendedSubagentRecordV1 = {
    storage: 'private_artifact_v1',
    subagentId: 'task-subagent-1',
    role: 'code',
    continuationId,
    modelInvocationOrdinal: 4,
    continuationArtifact: {
      artifactId: `pa_${'2'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `hmac-sha256:${'3'.repeat(64)}`,
      byteLength: 640,
    },
    parentInvocationId: 'invocation-task-1',
    parentAttempt: executionMode === 'resume' ? 2 : 1,
    blockedTool: {
      reasonCode:
        eventKind === 'approval'
          ? 'SUBAGENT_TOOL_REQUIRES_APPROVAL'
          : 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
      toolCallId: 'task-child-call-1',
      runtimeToolCallId: 'runtime-task-child-call-1',
      toolName: 'write_file',
    },
  };
  const attempt = executionMode === 'resume' ? 2 : 1;
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    kind: 'task_subagent',
    operationId: 'builtin:task',
    executionMode,
    toolCallId: 'call-1',
    parent: {
      toolCallId: 'call-1',
      invocationId: 'invocation-task-1',
      attemptId: `invocation-task-1:attempt:${attempt}`,
      attempt,
    },
    subagent,
    blockedTool: {
      toolCallId: 'task-child-call-1',
      runtimeToolCallId: 'runtime-task-child-call-1',
      toolName: 'write_file',
      argumentsDigest: TASK_BLOCKED_ARGUMENTS_DIGEST,
      commandDigest: TASK_BLOCKED_COMMAND_DIGEST,
    },
    event,
  };
}

function taskSuspendedResult(
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
  options: Readonly<{ readonly toolRecovery?: RuntimeJsonValueV1 }> = {},
): ToolPipelineSuspendedExecutionResultV1<State26BuiltinOperationStructuredContentV1> {
  const continuation = {
    id: suspension.subagent.subagentId,
    role: suspension.subagent.role,
    modelInvocationOrdinal: suspension.subagent.modelInvocationOrdinal,
    blockedTool: {
      reasonCode: suspension.subagent.blockedTool.reasonCode,
      toolCallId: suspension.blockedTool.toolCallId,
      runtimeToolCallId: suspension.blockedTool.runtimeToolCallId,
      toolName: suspension.blockedTool.toolName,
      args: TASK_BLOCKED_ARGUMENTS,
      command: TASK_BLOCKED_COMMAND,
    },
  };
  const blocked = {
    reasonCode: suspension.subagent.blockedTool.reasonCode,
    toolCallId: suspension.blockedTool.toolCallId,
    runtimeToolCallId: suspension.blockedTool.runtimeToolCallId,
    toolName: suspension.blockedTool.toolName,
    args: TASK_BLOCKED_ARGUMENTS,
    command: TASK_BLOCKED_COMMAND,
    continuation,
  };
  return {
    status: 'success',
    content: [{ type: 'text', text: 'task suspended' }],
    structuredContent: structuredContent({
      ok: false,
      stdout: '',
      stderr: 'task suspended',
      resultMeta: { command: 'task', attempt: suspension.parent.attempt },
      terminalStatus: 'suspended',
      subagentResult: {
        ok: false,
        terminalStatus: 'suspended',
        blocked,
        ...(options.toolRecovery === undefined ? {} : { toolRecovery: options.toolRecovery }),
      },
      runtimeEvents: [],
    }),
  };
}

function tamperedTaskSuspendedResult(
  suspension: Readonly<ToolPipelineTaskSubagentSuspensionV1>,
  blockedPatch: Readonly<Record<string, RuntimeJsonValueV1>>,
): ToolPipelineSuspendedExecutionResultV1<State26BuiltinOperationStructuredContentV1> {
  const result = taskSuspendedResult(suspension);
  const structuredContent = structuredClone(
    result.structuredContent,
  ) as State26BuiltinOperationStructuredContentV1;
  const subagentResult = structuredContent.subagentResult;
  if (
    subagentResult === undefined ||
    subagentResult === null ||
    typeof subagentResult !== 'object' ||
    Array.isArray(subagentResult)
  ) {
    throw new Error('invalid task result fixture');
  }
  const subagentRecord = subagentResult as Readonly<Record<string, RuntimeJsonValueV1>>;
  const blocked = subagentRecord.blocked;
  if (
    blocked === undefined ||
    blocked === null ||
    typeof blocked !== 'object' ||
    Array.isArray(blocked)
  ) {
    throw new Error('invalid blocked task result fixture');
  }
  const blockedRecord = blocked as Readonly<Record<string, RuntimeJsonValueV1>>;
  const structuredRecord = structuredContent as unknown as Readonly<
    Record<string, RuntimeJsonValueV1>
  >;
  const nextStructuredContent = {
    ...structuredRecord,
    subagentResult: {
      ...subagentRecord,
      blocked: { ...blockedRecord, ...blockedPatch },
    },
  };
  return {
    ...result,
    structuredContent:
      nextStructuredContent as unknown as State26BuiltinOperationStructuredContentV1,
  };
}

function taskCompletedResult(
  attempt: number,
  toolRecovery?: RuntimeJsonValueV1,
  runtimeEvents: readonly RuntimeJsonValueV1[] = [],
): CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1> {
  return {
    status: 'success',
    content: [{ type: 'text', text: 'task complete' }],
    structuredContent: structuredContent({
      ok: true,
      stdout: 'task complete',
      stderr: '',
      resultMeta: { command: 'task', attempt },
      subagentResult: {
        ok: true,
        terminalStatus: 'completed',
        ...(toolRecovery === undefined ? {} : { toolRecovery }),
      },
      runtimeEvents,
    }),
  };
}

function taskResourceAdmissionFailureResult(
  failure: Readonly<{
    readonly parentInvocationId: string;
    readonly parentToolCallId: string;
  }>,
): CapabilityToolTerminalResultV1<State26BuiltinOperationStructuredContentV1> {
  return {
    status: 'error',
    content: [{ type: 'text', text: 'child resource admission failed' }],
    failure: {
      code: 'resource_saturated',
      message: 'child resource admission failed',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: true,
      journal: true,
    },
    structuredContent: structuredContentWithoutObservation({
      ok: false,
      stdout: '',
      stderr: 'child resource admission failed',
      resultMeta: { command: 'task', attempt: 1 },
      subagentResult: {
        ok: false,
        summary: 'child resource admission failed',
        toolCallCount: 0,
        durationMs: 0,
        terminalStatus: 'failed',
        resourceAdmissionFailure: {
          reason: 'tool_concurrency_saturated',
          message: 'child resource admission failed',
          parentInvocationId: failure.parentInvocationId,
          parentToolCallId: failure.parentToolCallId,
          childInvocationId: 'child-invocation-1',
        },
      },
      runtimeEvents: [],
    }),
  };
}

function writePlanPrepared(
  args: Readonly<Record<string, RuntimeJsonValueV1>>,
): Readonly<PreparedToolInvocationV1> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>;
} {
  const base = prepared(1);
  const baseRequest = base.input.request;
  if (!baseRequest || typeof baseRequest !== 'object' || Array.isArray(baseRequest)) {
    throw new Error('invalid prepared request fixture');
  }
  const effects = Object.freeze({
    filesystem: 'none' as const,
    network: 'none' as const,
    externalState: 'none' as const,
  });
  const identity = Object.freeze({
    ...base.identity,
    operationId: 'builtin:write_plan' as NonDynamicOperationIdV1,
    executionMechanism: 'planning' as const,
    capabilityId: 'builtin:write_plan',
    capabilityRevision: 'write-plan-capability-1',
    descriptorRevision: 'write-plan-descriptor-1',
    parserRevision: 'write-plan-parser-1',
    executorRevision: 'write-plan-executor-1',
    argumentsDigest: digestCapabilityValueV1(args),
    effectiveEffectsDigest: digestCapabilityValueV1(effects),
    exposedToolName: 'write_plan',
  });
  return Object.freeze({
    identity,
    input: Object.freeze({
      ...base.input,
      arguments: Object.freeze({ ...args }),
      request: Object.freeze({
        ...baseRequest,
        effectiveEffects: effects,
      }),
    }),
  });
}

function searchPrepared(): Readonly<PreparedToolInvocationV1> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>;
} {
  const base = prepared(1);
  const argumentsValue = { path: 'src', pattern: '*.ts' } as const;
  const identity = Object.freeze({
    ...base.identity,
    operationId: 'builtin:search_files' as NonDynamicOperationIdV1,
    capabilityId: 'builtin:search_files',
    exposedToolName: 'search_files',
    argumentsDigest: digestCapabilityValueV1(argumentsValue),
  });
  return Object.freeze({
    ...base,
    identity,
    input: Object.freeze({
      ...base.input,
      arguments: argumentsValue,
    }),
  });
}

function mutationPrepared(
  kind: 'write_file' | 'edit_file' = 'write_file',
): Readonly<PreparedToolInvocationV1> & {
  readonly identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>;
} {
  const base = prepared(1);
  const baseRequest = base.input.request;
  if (!baseRequest || typeof baseRequest !== 'object' || Array.isArray(baseRequest)) {
    throw new Error('invalid prepared request fixture');
  }
  const argumentsValue =
    kind === 'write_file'
      ? Object.freeze({ path: 'README.md', content: 'changed\n' })
      : Object.freeze({
          path: 'README.md',
          old_string: 'before',
          new_string: 'after',
          replace_all: false,
        });
  const effects = Object.freeze({
    filesystem: 'write' as const,
    network: 'none' as const,
    externalState: 'none' as const,
  });
  const operationId = `builtin:${kind}` as NonDynamicOperationIdV1;
  const identity = Object.freeze({
    ...base.identity,
    operationId,
    capabilityId: operationId,
    capabilityRevision: digestCapabilityValueV1({ capability: kind, revision: 1 }),
    descriptorRevision: `${kind}-descriptor-1`,
    parserRevision: `${kind}-parser-1`,
    executorRevision: `${kind}-executor-1`,
    argumentsDigest: digestCapabilityValueV1(argumentsValue),
    effectiveEffectsDigest: digestCapabilityValueV1(effects),
    exposedToolName: kind,
  });
  return Object.freeze({
    identity,
    input: Object.freeze({
      ...base.input,
      arguments: argumentsValue,
      request: Object.freeze({
        ...baseRequest,
        effectiveEffects: effects,
        receiptRequirement: 'effect_receipt' as const,
      }),
      facts: Object.freeze({ approvalSummary: `${kind} README.md` }),
    }),
  });
}

function mutationOperation(kind: 'write_file' | 'edit_file' = 'write_file') {
  return kind === 'write_file'
    ? Object.freeze({
        operationId: 'builtin:write_file' as const,
        kind: 'write_file' as const,
        path: 'README.md',
        content: 'changed\n',
        pathScope: 'workspace_only' as const,
      })
    : Object.freeze({
        operationId: 'builtin:edit_file' as const,
        kind: 'edit_file' as const,
        path: 'README.md',
        oldString: 'before',
        newString: 'after',
        replaceAll: false,
        pathScope: 'workspace_only' as const,
      });
}

function mutationIntentRecord(
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  kind: 'write_file' | 'edit_file' = 'write_file',
) {
  const operation = mutationOperation(kind);
  const { operationId: _operationId, ...providerOperation } = operation;
  const unsigned = Object.freeze({
    attempt: acknowledgement.attempt.attempt,
    capabilityRevision: acknowledgement.attempt.capabilityRevision,
    argumentsDigest: acknowledgement.attempt.argumentsDigest,
    admissionDigest: acknowledgement.attempt.admissionDigest!,
    operationDigest: workspaceFilesystemOperationDigestV1(providerOperation),
    searchBoundaryDigest: workspaceFilesystemStringDigestV1('protected-boundary-1'),
    lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
    canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1('/workspace'),
    protectedPathRevision: 'protected-path-revision-1',
    approvalSummaryDigest: workspaceFilesystemStringDigestV1(`${kind} README.md`),
    effectiveEffectsDigest: acknowledgement.attempt.effectiveEffectsDigest,
    recordedAt: NEXT,
  });
  return Object.freeze({
    ...unsigned,
    intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
  });
}

const PREIMAGE_ARTIFACT = Object.freeze({
  artifactId: `pa_${'1'.repeat(64)}`,
  kind: 'filesystem_preimage' as const,
  integrityIdentifier: `hmac-sha256:${'2'.repeat(64)}`,
  byteLength: 64,
});

function mutationPreparedEvidence(
  operationDigest: string,
  kind: 'write_file' | 'edit_file' = 'write_file',
) {
  return Object.freeze({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
    operationKind: kind,
    operationDigest,
    lexicalTargetDigest: AUTHENTIC_FILESYSTEM_OBSERVATION.lexicalTargetDigest,
    canonicalTargetDigest: AUTHENTIC_FILESYSTEM_OBSERVATION.canonicalTargetDigest,
    targetIdentityDigest: AUTHENTIC_FILESYSTEM_OBSERVATION.targetIdentityDigest,
    preimageDigest: `sha256:${'3'.repeat(64)}`,
    preimageExisted: true,
    preimageByteLength: 16,
  });
}

function mutationReadyRecord(
  intent: ReturnType<typeof mutationIntentRecord>,
  evidence: ReturnType<typeof mutationPreparedEvidence>,
) {
  const unsigned = Object.freeze({
    attempt: intent.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: evidence.operationDigest,
    targetIdentityDigest: evidence.targetIdentityDigest,
    preimageDigest: evidence.preimageDigest,
    preimageArtifact: PREIMAGE_ARTIFACT,
    readyAt: NEXT,
  });
  return Object.freeze({
    ...unsigned,
    readyDigest: workspaceFilesystemMutationReadyDigestV1(unsigned),
  });
}

function persistenceHarness(
  options: {
    readonly state?: State26RuntimeStateV1;
    readonly toolName?: string;
    readonly toolArgs?: Record<string, RuntimeJsonValueV1>;
    readonly artifactWrite?: (
      invocationId: string,
      value: unknown,
    ) => ReturnType<typeof artifactRef>;
    readonly attemptResult?: boolean;
    readonly attemptThrow?: boolean;
    readonly interleaveAttemptProgress?: boolean;
    readonly recoveryResult?: boolean;
    readonly recoveryThrow?: boolean;
    readonly receiptResult?: boolean;
    readonly receiptThrow?: boolean;
    readonly receiptFalseAt?: number;
    readonly receiptThrowAt?: number;
    readonly terminalVerifier?: BuiltinWorkspaceFilesystemTerminalVerifierV1;
    readonly withoutTerminalVerifier?: boolean;
    readonly providerActionEnabled?: boolean;
  } = {},
) {
  const session = createSession(options.state);
  session.processEvent({
    type: 'tool.queued',
    toolCallId: 'call-1',
    name: options.toolName ?? 'read_file',
    args: options.toolArgs ?? { path: 'README.md' },
    modelMessageId: 'message-1',
  });
  const calls = {
    attempt: 0,
    recovery: 0,
    receipt: 0,
    writes: 0,
    verifier: 0,
    artifactResults: [] as unknown[],
    receiptEvents: [] as RuntimeEvent[][],
    recoveryEvents: [] as RuntimeEvent[][],
  };
  const issuedAcknowledgements = new WeakSet<object>();
  const terminalVerifier: BuiltinWorkspaceFilesystemTerminalVerifierV1 =
    options.terminalVerifier ??
    ((commit) => {
      calls.verifier += 1;
      const structured = commit.result.structuredContent;
      const candidate =
        structured && typeof structured === 'object' && 'filesystemObservation' in structured
          ? structured.filesystemObservation
          : undefined;
      if (
        !issuedAcknowledgements.has(commit.acknowledgement) ||
        candidate !== AUTHENTIC_FILESYSTEM_OBSERVATION
      ) {
        return { valid: false, code: 'terminal_identity_mismatch' };
      }
      return { valid: true, observation: AUTHENTIC_FILESYSTEM_OBSERVATION };
    });
  let lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['call-1'] });
  const rawPersistence = createAppState26ToolPipelinePersistenceV1({
    getState: () => session.getState(),
    persistAttemptStartEvents: async (events) => {
      calls.attempt += 1;
      if (options.attemptThrow) throw new Error('attempt persistence failed');
      if (options.attemptResult === false) return false;
      const applied = session.applyEffectEvents(lease, events, 'attempt_start');
      if (applied && options.interleaveAttemptProgress) {
        expect(
          session.applyEffectEvent(lease, {
            type: 'tool.progress',
            toolCallId: 'call-1',
            stream: 'stdout',
            chunk: 'interleaved sibling progress',
          }),
        ).toBe(true);
      }
      return applied;
    },
    persistTerminalRecoveryEvents: async (events) => {
      calls.recovery += 1;
      calls.recoveryEvents.push([...events]);
      if (options.recoveryThrow) throw new Error('recovery persistence failed');
      if (options.recoveryResult === false) return false;
      return session.applyEffectEvents(lease, events, 'terminal_recovery');
    },
    persistReceiptEvents: async (events) => {
      calls.receipt += 1;
      calls.receiptEvents.push([...events]);
      if (options.receiptThrow || calls.receipt === options.receiptThrowAt) {
        throw new Error('receipt persistence failed');
      }
      if (options.receiptResult === false || calls.receipt === options.receiptFalseAt) return false;
      return session.applyEffectEvents(lease, events, 'receipt_evidence');
    },
    now: () => (calls.attempt === 0 ? NOW : NEXT),
    capabilityArtifactWriter: {
      write: (invocationId, value) => {
        calls.writes += 1;
        calls.artifactResults.push(value);
        if (options.artifactWrite) return options.artifactWrite(invocationId, value);
        return artifactRef(invocationId);
      },
    },
    ...(options.withoutTerminalVerifier
      ? {}
      : { verifyBuiltinWorkspaceFilesystemTerminal: terminalVerifier }),
    ...(options.providerActionEnabled === undefined
      ? {}
      : {
          providerAction: Object.freeze({
            enabled: options.providerActionEnabled,
            createInteractionId: () => 'provider-action-interaction-1',
          }),
        }),
  });
  const persistence = Object.freeze({
    ...rawPersistence,
    recordAttempt: async (candidate: Readonly<PreparedToolInvocationV1>) => {
      const acknowledgement = await rawPersistence.recordAttempt(candidate);
      issuedAcknowledgements.add(acknowledgement);
      return acknowledgement;
    },
  });
  return {
    persistence,
    session,
    calls,
    get lease() {
      return lease;
    },
    replaceLease: () => {
      lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['call-1'] });
    },
    staleLease: () => {
      session.releaseEffect(lease);
    },
  };
}

function taskPersistenceHarness(options: Parameters<typeof persistenceHarness>[0] = {}) {
  return persistenceHarness({
    ...options,
    toolName: 'task',
    toolArgs: {
      subagent_type: 'code',
      taskArtifact: {
        artifactId: `pa_${'4'.repeat(64)}`,
        kind: 'subagent_task_request',
        integrityIdentifier: `hmac-sha256:${'5'.repeat(64)}`,
        byteLength: 128,
      },
    },
  });
}

async function prepareMutationAttemptV1(
  harness: ReturnType<typeof persistenceHarness>,
  kind: 'write_file' | 'edit_file' = 'write_file',
) {
  const candidate = mutationPrepared(kind);
  const acknowledgement = await harness.persistence.recordAttempt(candidate);
  const operation = mutationOperation(kind);
  const record = mutationIntentRecord(acknowledgement, kind);
  const intent = await harness.persistence.workspaceFilesystemMutationEvidence.persistIntent(
    Object.freeze({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      prepared: candidate,
      operation,
      record,
    }),
  );
  const evidence = mutationPreparedEvidence(record.operationDigest, kind);
  const ready = await harness.persistence.workspaceFilesystemMutationEvidence.persistMutationReady(
    Object.freeze({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      intent,
      preparedEvidence: evidence,
      preimageArtifact: PREIMAGE_ARTIFACT,
      record: mutationReadyRecord(record, evidence),
    }),
  );
  return Object.freeze({ candidate, acknowledgement, operation, record, intent, evidence, ready });
}

describe('App State26 Tool Pipeline persistence', () => {
  test('binds durable filesystem intent to the exact prepared acknowledgement and current State26 record', async () => {
    const harness = persistenceHarness();
    const candidate = prepared(1);
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    const operation = Object.freeze({
      operationId: 'builtin:read_file' as const,
      kind: 'read_file' as const,
      path: 'README.md',
      pathScope: 'workspace_only' as const,
    });
    const { operationId: _operationId, ...providerOperation } = operation;
    const unsigned = Object.freeze({
      attempt: acknowledgement.attempt.attempt,
      capabilityRevision: acknowledgement.attempt.capabilityRevision,
      argumentsDigest: acknowledgement.attempt.argumentsDigest,
      admissionDigest: acknowledgement.attempt.admissionDigest!,
      operationDigest: workspaceFilesystemOperationDigestV1(providerOperation),
      searchBoundaryDigest: workspaceFilesystemStringDigestV1('protected-boundary-1'),
      lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
      canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1('/workspace'),
      protectedPathRevision: 'protected-path-revision-1',
      approvalSummaryDigest: workspaceFilesystemStringDigestV1('read_file README.md'),
      effectiveEffectsDigest: acknowledgement.attempt.effectiveEffectsDigest,
      recordedAt: NEXT,
    });
    const record = Object.freeze({
      ...unsigned,
      intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
    });
    const persisted = await harness.persistence.workspaceFilesystemEvidence.persistIntent(
      Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        prepared: candidate,
        operation,
        record,
      }),
    );

    expect(persisted.prepared).toBe(candidate);
    expect(persisted.acknowledgement).toBe(acknowledgement);
    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.filesystem_intent_recorded',
    ]);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      attemptsStarted: 1,
      filesystemIntent: record,
    });
    expect(
      harness.persistence.workspaceFilesystemEvidence.verifyPersistedIntent(persisted),
    ).toEqual({ valid: true });
    expect(
      harness.persistence.workspaceFilesystemEvidence.verifyPersistedIntent(
        structuredClone(persisted),
      ),
    ).toEqual({ valid: false, code: 'intent_not_issued' });

    const foreign = persistenceHarness();
    expect(
      foreign.persistence.workspaceFilesystemEvidence.verifyPersistedIntent(persisted),
    ).toEqual({ valid: false, code: 'intent_not_issued' });
  });

  test('turns a false filesystem intent acknowledgement into a throwing post-ack failure', async () => {
    const harness = persistenceHarness({ receiptResult: false });
    const candidate = prepared(1);
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    const operation = Object.freeze({
      operationId: 'builtin:read_file' as const,
      kind: 'read_file' as const,
      path: 'README.md',
      pathScope: 'workspace_only' as const,
    });
    const { operationId: _operationId, ...providerOperation } = operation;
    const unsigned = Object.freeze({
      attempt: 1,
      capabilityRevision: acknowledgement.attempt.capabilityRevision,
      argumentsDigest: acknowledgement.attempt.argumentsDigest,
      admissionDigest: acknowledgement.attempt.admissionDigest!,
      operationDigest: workspaceFilesystemOperationDigestV1(providerOperation),
      searchBoundaryDigest: workspaceFilesystemStringDigestV1('protected-boundary-1'),
      lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
      canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1('/workspace'),
      protectedPathRevision: 'protected-path-revision-1',
      approvalSummaryDigest: workspaceFilesystemStringDigestV1('read_file README.md'),
      effectiveEffectsDigest: acknowledgement.attempt.effectiveEffectsDigest,
      recordedAt: NEXT,
    });
    await expect(
      harness.persistence.workspaceFilesystemEvidence.persistIntent({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        prepared: candidate,
        operation,
        record: Object.freeze({
          ...unsigned,
          intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
        }),
      }),
    ).rejects.toMatchObject({ code: 'filesystem_intent_commit_failed' });
    expect(harness.calls.receipt).toBe(1);
  });

  test('binds filesystem mutation intent and ready evidence to one exact acknowledged attempt', async () => {
    const harness = persistenceHarness({ toolName: 'write_file' });
    const candidate = mutationPrepared();
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    const operation = mutationOperation();
    const record = mutationIntentRecord(acknowledgement);
    const intent = await harness.persistence.workspaceFilesystemMutationEvidence.persistIntent(
      Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        prepared: candidate,
        operation,
        record,
      }),
    );
    const evidence = mutationPreparedEvidence(record.operationDigest);
    const readyRecord = mutationReadyRecord(record, evidence);
    const ready =
      await harness.persistence.workspaceFilesystemMutationEvidence.persistMutationReady(
        Object.freeze({
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
          intent,
          preparedEvidence: evidence,
          preimageArtifact: PREIMAGE_ARTIFACT,
          record: readyRecord,
        }),
      );

    expect(intent.prepared).toBe(candidate);
    expect(intent.acknowledgement).toBe(acknowledgement);
    expect(ready.intent).toBe(intent);
    expect(ready.preimageArtifact).toBe(PREIMAGE_ARTIFACT);
    expect(harness.calls.receiptEvents.slice(0, 2).map((events) => events[0]?.type)).toEqual([
      'capability.filesystem_intent_recorded',
      'capability.filesystem_mutation_ready',
    ]);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      filesystemIntent: record,
      filesystemMutationReady: readyRecord,
    });
    expect(
      harness.persistence.workspaceFilesystemMutationEvidence.verifyPersistedIntent(intent),
    ).toEqual({ valid: true });
    expect(
      harness.persistence.workspaceFilesystemMutationEvidence.verifyPersistedMutationReady(ready),
    ).toEqual({ valid: true });
    expect(
      harness.persistence.workspaceFilesystemMutationEvidence.verifyPersistedMutationReady(
        structuredClone(ready),
      ),
    ).toEqual({ valid: false, code: 'ready_not_issued' });
  });

  test('fails closed on cloned, false, or throwing filesystem mutation-ready evidence', async () => {
    const cloned = persistenceHarness({ toolName: 'write_file' });
    const candidate = mutationPrepared();
    const acknowledgement = await cloned.persistence.recordAttempt(candidate);
    const operation = mutationOperation();
    const record = mutationIntentRecord(acknowledgement);
    const intent = await cloned.persistence.workspaceFilesystemMutationEvidence.persistIntent(
      Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        prepared: candidate,
        operation,
        record,
      }),
    );
    const evidence = mutationPreparedEvidence(record.operationDigest);
    const readyRecord = mutationReadyRecord(record, evidence);
    await expect(
      cloned.persistence.workspaceFilesystemMutationEvidence.persistMutationReady(
        Object.freeze({
          schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
          intent: structuredClone(intent),
          preparedEvidence: evidence,
          preimageArtifact: PREIMAGE_ARTIFACT,
          record: readyRecord,
        }),
      ),
    ).rejects.toMatchObject({ code: 'filesystem_mutation_ready_invalid' });
    expect(cloned.calls.receipt).toBe(1);

    for (const [option, expected] of [
      [{ receiptFalseAt: 2 }, 'filesystem_mutation_ready_commit_failed'],
      [{ receiptThrowAt: 2 }, 'filesystem_mutation_ready_commit_failed'],
    ] as const) {
      const harness = persistenceHarness({ toolName: 'write_file', ...option });
      const preparedMutation = mutationPrepared();
      const ack = await harness.persistence.recordAttempt(preparedMutation);
      const mutation = mutationOperation();
      const intentRecord = mutationIntentRecord(ack);
      const persistedIntent =
        await harness.persistence.workspaceFilesystemMutationEvidence.persistIntent(
          Object.freeze({
            schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
            prepared: preparedMutation,
            operation: mutation,
            record: intentRecord,
          }),
        );
      const preparedEvidence = mutationPreparedEvidence(intentRecord.operationDigest);
      await expect(
        harness.persistence.workspaceFilesystemMutationEvidence.persistMutationReady(
          Object.freeze({
            schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
            intent: persistedIntent,
            preparedEvidence,
            preimageArtifact: PREIMAGE_ARTIFACT,
            record: mutationReadyRecord(intentRecord, preparedEvidence),
          }),
        ),
      ).rejects.toMatchObject({ code: expected });
      expect(harness.calls.receipt).toBe(2);
      expect(
        harness.session.getState().capabilities.invocations['invocation-1']
          ?.filesystemMutationReady,
      ).toBeUndefined();
    }
  });

  test('issues and verifies only the latest authentic State26 read observation query result', async () => {
    const harness = persistenceHarness();
    const candidate = prepared(1);
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    await harness.persistence.workspaceFilesystemEvidence.persistIntent({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      prepared: candidate,
      operation: readOperation(),
      record: readIntentRecord(acknowledgement),
    });
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: result({ structuredContent: structuredContentWithObservation() }),
    });
    const query = Object.freeze({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      actorIdentityDigest: AUTHENTIC_FILESYSTEM_OBSERVATION.actorIdentityDigest,
      lexicalTargetDigest: AUTHENTIC_FILESYSTEM_OBSERVATION.lexicalTargetDigest,
    });
    const found =
      await harness.persistence.workspaceFilesystemEditObservation.findLatestAuthenticRead(query);
    expect(found).toMatchObject({
      status: 'found',
      query,
      invocationId: 'invocation-1',
      attempt: 1,
      observation: AUTHENTIC_FILESYSTEM_OBSERVATION,
    });
    expect(
      harness.persistence.workspaceFilesystemEditObservation.verifyLatestAuthenticRead(found),
    ).toEqual({ valid: true });
    expect(
      harness.persistence.workspaceFilesystemEditObservation.verifyLatestAuthenticRead(
        structuredClone(found),
      ),
    ).toEqual({ valid: false, code: 'query_result_not_issued' });

    const missingHarness = persistenceHarness();
    const missing =
      await missingHarness.persistence.workspaceFilesystemEditObservation.findLatestAuthenticRead(
        query,
      );
    expect(missing).toEqual({ status: 'missing', code: 'read_required', query });
    expect(
      missingHarness.persistence.workspaceFilesystemEditObservation.verifyLatestAuthenticRead(
        missing,
      ),
    ).toEqual({ valid: true });
  });

  test('commits an authentic filesystem mutation observation and one App-owned file-change event', async () => {
    const harness = persistenceHarness({ toolName: 'write_file' });
    const candidate = mutationPrepared();
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    const operation = mutationOperation();
    const record = mutationIntentRecord(acknowledgement);
    const intent = await harness.persistence.workspaceFilesystemMutationEvidence.persistIntent(
      Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        prepared: candidate,
        operation,
        record,
      }),
    );
    const evidence = mutationPreparedEvidence(record.operationDigest);
    await harness.persistence.workspaceFilesystemMutationEvidence.persistMutationReady(
      Object.freeze({
        schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
        intent,
        preparedEvidence: evidence,
        preimageArtifact: PREIMAGE_ARTIFACT,
        record: mutationReadyRecord(record, evidence),
      }),
    );
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: result({
        structuredContent: structuredContentWithObservation({
          stdout: 'updated README.md',
          resultMeta: { command: 'write_file' },
        }),
      }),
    });

    expect(harness.calls.receiptEvents[2]?.map((event) => event.type)).toEqual([
      'capability.execution_succeeded',
      'tool.file_change',
      'tool.finished',
    ]);
    expect(harness.calls.receiptEvents[2]?.[1]).toEqual({
      type: 'tool.file_change',
      toolCallId: 'call-1',
      path: 'README.md',
      kind: 'add',
      preview: 'updated README.md',
    });
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'succeeded',
      filesystemObservation: AUTHENTIC_FILESYSTEM_OBSERVATION,
    });
  });

  test('rejects missing, forged, or path-mismatched mutation terminals before Artifact write', async () => {
    const missing = persistenceHarness({ toolName: 'write_file' });
    const missingAttempt = await prepareMutationAttemptV1(missing);
    await expect(
      missing.persistence.commitTerminal({
        acknowledgement: missingAttempt.acknowledgement,
        result: result({ structuredContent: structuredContentWithoutObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(missing.calls.writes).toBe(0);
    expect(missing.calls.receipt).toBe(2);

    const forged = persistenceHarness({
      toolName: 'write_file',
      terminalVerifier: () => ({
        valid: true,
        observation: structuredClone(AUTHENTIC_FILESYSTEM_OBSERVATION),
      }),
    });
    const forgedAttempt = await prepareMutationAttemptV1(forged);
    await expect(
      forged.persistence.commitTerminal({
        acknowledgement: forgedAttempt.acknowledgement,
        result: result({ structuredContent: structuredContentWithObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(forged.calls.writes).toBe(0);
    expect(forged.calls.receipt).toBe(2);

    const wrongPath = persistenceHarness({ toolName: 'write_file' });
    const wrongPathAttempt = await prepareMutationAttemptV1(wrongPath);
    await expect(
      wrongPath.persistence.commitTerminal({
        acknowledgement: wrongPathAttempt.acknowledgement,
        result: result({
          structuredContent: structuredContentWithObservation({ path: 'OTHER.md' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(wrongPath.calls.writes).toBe(0);
    expect(wrongPath.calls.receipt).toBe(2);
  });

  test('commits the authentic read observation into the capability receipt, artifact, and State26', async () => {
    const harness = persistenceHarness();
    const candidate = prepared(1);
    const acknowledgement = await harness.persistence.recordAttempt(candidate);
    const operation = readOperation();
    const record = readIntentRecord(acknowledgement);
    await harness.persistence.workspaceFilesystemEvidence.persistIntent({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      prepared: candidate,
      operation,
      record,
    });

    const terminal = result({ structuredContent: structuredContentWithObservation() });
    await harness.persistence.commitTerminal({ acknowledgement, result: terminal });

    expect(harness.calls.verifier).toBe(1);
    expect(harness.calls.receiptEvents[1]?.[0]).toMatchObject({
      type: 'capability.execution_succeeded',
      filesystemObservation: AUTHENTIC_FILESYSTEM_OBSERVATION,
    });
    const succeeded = harness.calls.receiptEvents[1]?.[0];
    expect(
      succeeded?.type === 'capability.execution_succeeded' &&
        Object.is(
          succeeded.filesystemObservation,
          terminal.structuredContent?.filesystemObservation,
        ),
    ).toBe(true);
    const artifactResult = harness.calls.artifactResults[0] as {
      readonly structuredContent?: unknown;
    };
    expect(artifactResult.structuredContent).toBe(terminal.structuredContent);
    expect(harness.calls.artifactResults[0]).toMatchObject({
      structuredContent: {
        filesystemObservation: AUTHENTIC_FILESYSTEM_OBSERVATION,
      },
    });
    expect(
      harness.session.getState().capabilities.invocations['invocation-1']?.filesystemObservation,
    ).toEqual(AUTHENTIC_FILESYSTEM_OBSERVATION);
  });

  test('uses exact attempt_start then receipt_evidence channels with atomic terminal batch', async () => {
    const harness = persistenceHarness();
    const candidate = prepared(1);
    const first = await harness.persistence.recordAttempt(candidate);
    expect(first.attempt.attempt).toBe(1);
    expect(harness.calls.attempt).toBe(1);
    expect(harness.session.getState().tools.calls['call-1']?.status).toBe('running');
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      attemptsStarted: 1,
    });
    await harness.persistence.workspaceFilesystemEvidence.persistIntent({
      schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
      prepared: candidate,
      operation: readOperation(),
      record: readIntentRecord(first),
    });

    await harness.persistence.commitTerminal({
      acknowledgement: first,
      result: result({
        structuredContent: structuredContentWithObservation({
          runtimeEvents: [{ type: 'model.text_delta', text: 'runtime fact' }],
          classifierAdviceV1: {
            detailCode: 'read_complete',
            disposition: 'never',
            safeAutomaticRetry: false,
          },
        }),
      }),
    });
    expect(harness.calls.receipt).toBe(2);
    expect(harness.calls.recovery).toBe(0);
    expect(harness.calls.receiptEvents[1]?.map((event) => event.type)).toEqual([
      'capability.execution_succeeded',
      'model.text_delta',
      'tool.finished',
    ]);
    expect(harness.calls.receiptEvents[1]?.[2]).toMatchObject({
      type: 'tool.finished',
      result: {
        totalLines: 1,
        resultMeta: { command: 'read_file', path: 'README.md' },
      },
      classifierAdviceV1: { detailCode: 'read_complete', disposition: 'never' },
    });
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'succeeded',
      attemptsStarted: 1,
    });
    await expect(
      harness.persistence.commitTerminal({ acknowledgement: first, result: result() }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
    expect(harness.calls.receipt).toBe(2);
  });

  test('accepts an exact attempt acknowledgement when a sibling fact advances the shared effect revision', async () => {
    const harness = persistenceHarness({ interleaveAttemptProgress: true });
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));

    expect(acknowledgement.attempt.attempt).toBe(1);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      attemptsStarted: 1,
    });
    expect(harness.session.getState().tools.calls['call-1']?.status).toBe('running');
  });

  test('commits plan review result evidence and Kernel sibling cancellations without a terminal', async () => {
    const session = createSession();
    const plan = Object.freeze({
      name: 'Review suspension',
      description: 'Validate the suspended Tool Pipeline receipt.',
      status: 'pending' as const,
      steps: Object.freeze([
        Object.freeze({ id: 'review', step: 'Review the receipt', status: 'pending' as const }),
      ]),
    });
    const structuralDigest = computePlanStructuralDigest({
      title: plan.name,
      bodyMarkdown: plan.description,
      steps: [{ id: 'review', title: 'Review the receipt', status: 'pending' }],
    });
    const planArtifact = Object.freeze({
      artifactId: 'plan-1:v1',
      taskId: 'task-1',
      planId: 'plan-1',
      version: 1,
      fileName: 'v1.md',
      relativePath: 'plans/task-1/plan-1/v1.md',
      displayPath: '/plans/task-1/plan-1/v1.md',
      structuralDigest,
      byteLength: 128,
    });
    session.processEvent({
      type: 'task.started',
      taskId: 'task-1',
      userGoal: 'Review the Tool Pipeline',
      turnId: session.getState().turn.turnId,
    });
    session.processEvent({ type: 'planning.entered', taskId: 'task-1', source: 'user_command' });
    session.processEvent({
      type: 'tool.queued',
      toolCallId: 'draft-call',
      name: 'write_plan',
      args: {},
      modelMessageId: 'draft-message',
      ordinal: 0,
    });
    session.processEvent({
      type: 'plan.drafted',
      toolCallId: 'draft-call',
      taskId: 'task-1',
      plan,
      planId: 'plan-1',
      version: 1,
      planSchemaVersion: 2,
      structuralHash: structuralDigest,
      artifact: planArtifact,
    });
    const args = Object.freeze({
      action: 'submit',
      plan_id: 'plan-1',
      version: 1,
      structural_digest: structuralDigest,
    });
    session.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'write_plan',
      args,
      modelMessageId: 'message-1',
      ordinal: 0,
    });
    session.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-2',
      name: 'read_plan',
      args: { plan_id: 'plan-1' },
      modelMessageId: 'message-1',
      ordinal: 1,
    });
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['call-1', 'call-2'] });
    const receiptEvents: RuntimeEvent[][] = [];
    const persistence = createAppState26ToolPipelinePersistenceV1({
      getState: () => session.getState(),
      persistAttemptStartEvents: async (events) =>
        session.applyEffectEvents(lease, events, 'attempt_start'),
      persistTerminalRecoveryEvents: async (events) =>
        session.applyEffectEvents(lease, events, 'terminal_recovery'),
      persistReceiptEvents: async (events) => {
        receiptEvents.push([...events]);
        return session.applyEffectEvents(lease, events, 'receipt_evidence');
      },
      now: () => NEXT,
      capabilityArtifactWriter: { write: (invocationId) => artifactRef(invocationId) },
      verifyBuiltinWorkspaceFilesystemTerminal: REJECT_FILESYSTEM_TERMINAL,
    });
    const candidate = writePlanPrepared(args);
    const acknowledgement = await persistence.recordAttempt(candidate);
    const reviewEvent = Object.freeze({
      type: 'plan.review_requested' as const,
      interactionId: 'review-1',
      toolCallId: 'call-1',
      taskId: 'task-1',
      plan,
      planSummary: 'Review suspension\n\n1. Review the receipt',
      planId: 'plan-1',
      version: 1,
      structuralDigest,
      artifact: planArtifact,
    });
    const suspendedResult = result({
      structuredContent: structuredContentWithoutObservation({
        stdout: '',
        resultMeta: {},
        runtimeEvents: [reviewEvent],
      }),
    });
    if (suspendedResult.status !== 'success' || !suspendedResult.structuredContent) {
      throw new Error('invalid suspended result fixture');
    }
    await persistence.commitSuspension({
      acknowledgement,
      suspension: {
        schema: 'kite.tool-pipeline-stage.v1',
        kind: 'plan_review',
        toolCallId: 'call-1',
        event: reviewEvent,
      },
      result: {
        status: 'success',
        content: suspendedResult.content,
        structuredContent: suspendedResult.structuredContent,
      },
    });

    expect(receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_result_recorded',
      'plan.review_requested',
      'tool.cancelled',
    ]);
    expect(receiptEvents[0]?.[2]).toMatchObject({ type: 'tool.cancelled', toolCallId: 'call-2' });
    expect(session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      attemptsStarted: 1,
      artifact: artifactRef('invocation-1'),
    });
    expect(session.getState().tools.calls['call-1']?.status).toBe('awaiting_review');
    expect(session.getState().tools.calls['call-2']?.status).toBe('cancelled');
    expect(receiptEvents[0]).not.toContainEqual(
      expect.objectContaining({ type: 'capability.execution_succeeded' }),
    );
    expect(receiptEvents[0]).not.toContainEqual(expect.objectContaining({ type: 'tool.finished' }));
    await expect(
      persistence.commitTerminal({ acknowledgement, result: suspendedResult }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
  });

  test('commits task start approval and auto-review suspensions as one State26 batch', async () => {
    for (const eventKind of ['approval', 'auto_review'] as const) {
      const harness = taskPersistenceHarness();
      const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
      const suspension = taskSuspension('start', eventKind);
      await harness.persistence.commitSuspension({
        acknowledgement,
        suspension,
        result: taskSuspendedResult(suspension),
      });

      expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
        'capability.execution_result_recorded',
        'subagent.suspended',
        eventKind === 'approval' ? 'approval.requested' : 'auto_review.requested',
      ]);
      expect(harness.calls.receiptEvents[0]).not.toContainEqual(
        expect.objectContaining({ type: 'capability.execution_succeeded' }),
      );
      expect(harness.calls.receiptEvents[0]).not.toContainEqual(
        expect.objectContaining({ type: 'tool.finished' }),
      );
      expect(harness.calls.writes).toBe(1);
      expect(harness.calls.receipt).toBe(1);
      expect(
        harness.session.getState().capabilities.invocations['invocation-task-1'],
      ).toMatchObject({
        status: 'running',
        attemptsStarted: 1,
        artifact: artifactRef('invocation-task-1'),
      });
      expect(harness.session.getState().suspendedSubagents['call-1']).toEqual(suspension.subagent);
      expect(harness.session.getState().tools.calls['call-1']?.status).toBe(
        eventKind === 'approval' ? 'awaiting_approval' : 'awaiting_auto_review',
      );
      expect(harness.session.getState().interactions.kind).toBe(
        eventKind === 'approval' ? 'awaiting_tool_approval' : 'awaiting_auto_review',
      );

      await expect(
        harness.persistence.commitSuspension({
          acknowledgement,
          suspension,
          result: taskSuspendedResult(suspension),
        }),
      ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
      expect(harness.calls.receipt).toBe(1);
    }
  });

  test('defers a sibling task approval in the same suspension batch when the interaction slot is occupied', async () => {
    const seeded = createSession();
    seeded.processEvent({
      type: 'tool.queued',
      toolCallId: 'occupied-call',
      name: 'shell_execute',
      args: { command: 'pwd' },
      modelMessageId: 'occupied-message',
    });
    const occupiedApproval = taskSuspension('start', 'approval').event;
    if (occupiedApproval.type !== 'approval.requested') {
      throw new Error('invalid occupied interaction fixture');
    }
    seeded.processEvent({
      ...occupiedApproval,
      interactionId: 'occupied-interaction',
      toolCallId: 'occupied-call',
      approval: { ...occupiedApproval.approval, callId: 'occupied-call', tool: 'shell_execute' },
    });
    const beforeInteraction = seeded.getState().interactions;
    const harness = taskPersistenceHarness({ state: seeded.getState() });
    const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
    const suspension = taskSuspension('start', 'approval');

    await harness.persistence.commitSuspension({
      acknowledgement,
      suspension,
      result: taskSuspendedResult(suspension),
    });

    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_result_recorded',
      'subagent.suspended',
      'subagent.approval_deferred',
    ]);
    expect(harness.calls.receiptEvents[0]?.[2]).toEqual({
      type: 'subagent.approval_deferred',
      toolCallId: 'call-1',
    });
    expect(harness.session.getState().interactions).toEqual(beforeInteraction);
    expect(harness.session.getState().suspendedSubagents['call-1']).toEqual(suspension.subagent);
    expect(harness.session.getState().tools.calls['call-1']?.status).toBe('queued');
  });

  test('projects nested Builtin recovery journal after result recording and before task suspension', async () => {
    const harness = taskPersistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
    const suspension = taskSuspension('start', 'approval');
    const childRecoveryJournal = harness.session.getState().toolRecovery;
    await harness.persistence.commitSuspension({
      acknowledgement,
      suspension,
      result: taskSuspendedResult(suspension, {
        toolRecovery: childRecoveryJournal as unknown as RuntimeJsonValueV1,
      }),
    });

    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_result_recorded',
      'subagent.recovery_journal_merged',
      'subagent.suspended',
      'approval.requested',
    ]);
    expect(harness.calls.receiptEvents[0]?.[1]).toMatchObject({
      type: 'subagent.recovery_journal_merged',
      toolCallId: 'call-1',
      journal: childRecoveryJournal,
    });
    expect(harness.session.getState().suspendedSubagents['call-1']).toEqual(suspension.subagent);
  });

  test('preserves nested Builtin recovery journal on ordinary task terminal commit', async () => {
    const harness = taskPersistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
    const childRecoveryJournal = harness.session.getState().toolRecovery;
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: taskCompletedResult(1, childRecoveryJournal as unknown as RuntimeJsonValueV1),
    });

    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_succeeded',
      'subagent.recovery_journal_merged',
      'tool.finished',
    ]);
    expect(harness.session.getState().capabilities.invocations['invocation-task-1']).toMatchObject({
      status: 'succeeded',
      attemptsStarted: 1,
    });
    expect(harness.session.getState().tools.calls['call-1']?.status).toBe('succeeded');
  });

  test('rejects a task resource terminal whose parent identity is tampered before Artifact/Store4', async () => {
    for (const failure of [
      {
        parentInvocationId: 'invocation-task-cross-parent',
        parentToolCallId: 'call-1',
      },
      {
        parentInvocationId: 'invocation-task-1',
        parentToolCallId: 'call-cross-parent',
      },
    ] as const) {
      const harness = taskPersistenceHarness();
      const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));

      await expect(
        harness.persistence.commitTerminal({
          acknowledgement,
          result: taskResourceAdmissionFailureResult(failure),
        }),
      ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
      expect(harness.calls.writes).toBe(0);
      expect(harness.calls.receipt).toBe(0);
    }
  });

  test('rejects task terminal recovery that is top-level-only or nested-tampered before Artifact/Store4', async () => {
    const topLevelOnly = taskPersistenceHarness();
    const topLevelAcknowledgement = await topLevelOnly.persistence.recordAttempt(taskPrepared(1));
    const topLevelJournal = topLevelOnly.session.getState().toolRecovery;
    await expect(
      topLevelOnly.persistence.commitTerminal({
        acknowledgement: topLevelAcknowledgement,
        result: taskCompletedResult(1, undefined, [
          {
            type: 'subagent.recovery_journal_merged',
            toolCallId: 'call-1',
            journal: topLevelJournal as unknown as RuntimeJsonValueV1,
          },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(topLevelOnly.calls.writes).toBe(0);
    expect(topLevelOnly.calls.receipt).toBe(0);

    const nestedTampered = taskPersistenceHarness();
    const nestedAcknowledgement = await nestedTampered.persistence.recordAttempt(taskPrepared(1));
    const nestedJournal = nestedTampered.session.getState().toolRecovery;
    await expect(
      nestedTampered.persistence.commitTerminal({
        acknowledgement: nestedAcknowledgement,
        result: taskCompletedResult(1, {
          ...nestedJournal,
          identityKey: 'f'.repeat(64),
        } as unknown as RuntimeJsonValueV1),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(nestedTampered.calls.writes).toBe(0);
    expect(nestedTampered.calls.receipt).toBe(0);
  });

  test('commits task resume approval and auto-review suspensions only after exact prior suspension state', async () => {
    for (const eventKind of ['approval', 'auto_review'] as const) {
      const harness = taskPersistenceHarness();
      const startAcknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
      const startSuspension = taskSuspension('start', eventKind);
      await harness.persistence.commitSuspension({
        acknowledgement: startAcknowledgement,
        suspension: startSuspension,
        result: taskSuspendedResult(startSuspension),
      });

      if (eventKind === 'approval') {
        harness.session.processEvent({
          type: 'approval.granted',
          interactionId: 'interaction-task-1',
          toolCallId: 'call-1',
          grant: 'approve_once',
        });
      } else {
        harness.session.processEvent({
          type: 'auto_review.completed',
          reviewId: 'review-task-1',
          toolCallId: 'call-1',
          result: {
            ok: true,
            approved: true,
            reviewerModelName: 'fixture-reviewer',
            durationMs: 1,
          },
        });
      }
      expect(harness.session.getState().tools.calls['call-1']?.status).toBe('approved');
      harness.replaceLease();

      const resumeAcknowledgement = await harness.persistence.recordAttempt(
        taskPrepared(2, 'runtime_private'),
      );
      const resumeSuspension = taskSuspension('resume', eventKind);
      await harness.persistence.commitSuspension({
        acknowledgement: resumeAcknowledgement,
        suspension: resumeSuspension,
        result: taskSuspendedResult(resumeSuspension),
      });

      expect(harness.calls.receiptEvents[1]?.map((event) => event.type)).toEqual([
        'capability.execution_result_recorded',
        'subagent.suspended',
        eventKind === 'approval' ? 'approval.requested' : 'auto_review.requested',
      ]);
      expect(
        harness.session.getState().capabilities.invocations['invocation-task-1'],
      ).toMatchObject({
        status: 'running',
        attemptsStarted: 2,
        artifact: artifactRef('invocation-task-1'),
      });
      expect(harness.session.getState().suspendedSubagents['call-1']).toEqual(
        resumeSuspension.subagent,
      );
      expect(harness.session.getState().tools.calls['call-1']?.status).toBe(
        eventKind === 'approval' ? 'awaiting_approval' : 'awaiting_auto_review',
      );
    }
  });

  test('rejects stale, skipped, and cross-parent task resume suspension state before Store4', async () => {
    const harness = taskPersistenceHarness();
    const startAcknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
    const startSuspension = taskSuspension('start', 'approval');
    await harness.persistence.commitSuspension({
      acknowledgement: startAcknowledgement,
      suspension: startSuspension,
      result: taskSuspendedResult(startSuspension),
    });
    harness.session.processEvent({
      type: 'approval.granted',
      interactionId: 'interaction-task-1',
      toolCallId: 'call-1',
      grant: 'approve_once',
    });
    harness.replaceLease();
    const resumeAcknowledgement = await harness.persistence.recordAttempt(
      taskPrepared(2, 'runtime_private'),
    );
    const validResume = taskSuspension('resume', 'approval');
    const malformed = [
      {
        ...validResume,
        parent: { ...validResume.parent, invocationId: 'other-parent' },
      },
      {
        ...validResume,
        parent: { ...validResume.parent, attempt: 3, attemptId: 'invocation-task-1:attempt:3' },
      },
      { ...validResume, executionMode: 'start' as const },
    ];
    for (const suspension of malformed) {
      await expect(
        harness.persistence.commitSuspension({
          acknowledgement: resumeAcknowledgement,
          suspension,
          result: taskSuspendedResult(validResume),
        }),
      ).rejects.toMatchObject({ code: 'invalid_suspension_result' });
      expect(harness.calls.writes).toBe(1);
      expect(harness.calls.receipt).toBe(1);
      expect(harness.session.getState().tools.calls['call-1']?.status).toBe('running');
    }
  });

  test('rejects task parent, private record, event, and Builtin result tampering before any write', async () => {
    const publicStart = taskPersistenceHarness();
    const publicStartAcknowledgement = await publicStart.persistence.recordAttempt(
      taskPrepared(1, 'model_public'),
    );
    const publicStartSuspension = taskSuspension('start', 'approval');
    await expect(
      publicStart.persistence.commitSuspension({
        acknowledgement: publicStartAcknowledgement,
        suspension: publicStartSuspension,
        result: taskSuspendedResult(publicStartSuspension),
      }),
    ).rejects.toMatchObject({ code: 'invalid_suspension_result' });
    expect(publicStart.calls.writes).toBe(0);
    expect(publicStart.calls.receipt).toBe(0);

    const missingArtifact = taskPersistenceHarness();
    const missingArtifactPrepared = taskPrepared(1, 'runtime_private');
    const missingArtifactArguments = Object.freeze({ subagent_type: 'code' as const });
    const missingArtifactPreparedWithoutRef = Object.freeze({
      ...missingArtifactPrepared,
      identity: Object.freeze({
        ...missingArtifactPrepared.identity,
        argumentsDigest: digestCapabilityValueV1(missingArtifactArguments),
      }),
      input: Object.freeze({
        ...missingArtifactPrepared.input,
        arguments: missingArtifactArguments,
      }),
    });
    const missingArtifactAcknowledgement = await missingArtifact.persistence.recordAttempt(
      missingArtifactPreparedWithoutRef,
    );
    const missingArtifactSuspension = taskSuspension('start', 'approval');
    await expect(
      missingArtifact.persistence.commitSuspension({
        acknowledgement: missingArtifactAcknowledgement,
        suspension: missingArtifactSuspension,
        result: taskSuspendedResult(missingArtifactSuspension),
      }),
    ).rejects.toMatchObject({ code: 'invalid_suspension_result' });
    expect(missingArtifact.calls.writes).toBe(0);
    expect(missingArtifact.calls.receipt).toBe(0);

    const harness = taskPersistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(taskPrepared(1));
    const suspension = taskSuspension('start', 'approval');
    const validResult = taskSuspendedResult(suspension);
    const malformed = [
      {
        suspension: { ...suspension, parent: { ...suspension.parent, attempt: 2 } },
        result: validResult,
      },
      {
        suspension: { ...suspension, toolCallId: 'other-call' },
        result: validResult,
      },
      {
        suspension: {
          ...suspension,
          subagent: {
            ...suspension.subagent,
            blockedTool: { ...suspension.subagent.blockedTool, toolName: 'shell_execute' },
          },
        },
        result: validResult,
      },
      {
        suspension: {
          ...suspension,
          event: { ...suspension.event, toolCallId: 'other-call' },
        },
        result: validResult,
      },
      {
        suspension: {
          ...suspension,
          event: {
            ...suspension.event,
            approval: { ...suspension.event.approval, callId: 'task-child-call-1' },
          },
        },
        result: validResult,
      },
      {
        suspension: {
          ...suspension,
          event: {
            ...suspension.event,
            approval: { ...suspension.event.approval, callId: 'other-runtime-child' },
          },
        },
        result: validResult,
      },
      {
        suspension: {
          ...suspension,
          blockedTool: (() => {
            const { runtimeToolCallId: _runtimeToolCallId, ...withoutRuntime } =
              suspension.blockedTool;
            return withoutRuntime;
          })(),
        },
        result: validResult,
      },
      {
        suspension,
        result: tamperedTaskSuspendedResult(suspension, { toolName: 'shell_execute' }),
      },
      {
        suspension,
        result: tamperedTaskSuspendedResult(suspension, {
          args: { path: 'tampered.md' },
        }),
      },
      {
        suspension,
        result: tamperedTaskSuspendedResult(suspension, {
          command: 'tampered child command',
        }),
      },
      {
        suspension,
        result: taskSuspendedResult(suspension, {
          toolRecovery: {
            ...harness.session.getState().toolRecovery,
            identityKey: 'f'.repeat(64),
          } as unknown as RuntimeJsonValueV1,
        }),
      },
    ] as const;

    for (const candidate of malformed) {
      await expect(
        harness.persistence.commitSuspension({
          acknowledgement,
          suspension: candidate.suspension as ToolPipelineTaskSubagentSuspensionV1,
          result: candidate.result,
        }),
      ).rejects.toMatchObject({ code: 'invalid_suspension_result' });
      expect(harness.calls.writes).toBe(0);
      expect(harness.calls.receipt).toBe(0);
      expect(harness.session.getState().tools.calls['call-1']?.status).toBe('running');
    }
  });

  test('fails closed on task artifact and Store4 suspension persistence failures', async () => {
    const artifactFailure = taskPersistenceHarness({
      artifactWrite: () => {
        throw new Error('artifact unavailable');
      },
    });
    const artifactAck = await artifactFailure.persistence.recordAttempt(taskPrepared(1));
    const artifactSuspension = taskSuspension('start', 'approval');
    await expect(
      artifactFailure.persistence.commitSuspension({
        acknowledgement: artifactAck,
        suspension: artifactSuspension,
        result: taskSuspendedResult(artifactSuspension),
      }),
    ).rejects.toMatchObject({ code: 'artifact_write_failed' });
    expect(artifactFailure.calls.writes).toBe(1);
    expect(artifactFailure.calls.receipt).toBe(0);
    expect(artifactFailure.session.getState().suspendedSubagents['call-1']).toBeUndefined();

    for (const options of [{ receiptResult: false }, { receiptThrow: true }] as const) {
      const failed = taskPersistenceHarness(options);
      const acknowledgement = await failed.persistence.recordAttempt(taskPrepared(1));
      const suspension = taskSuspension('start', 'auto_review');
      await expect(
        failed.persistence.commitSuspension({
          acknowledgement,
          suspension,
          result: taskSuspendedResult(suspension),
        }),
      ).rejects.toMatchObject({ code: 'suspension_commit_failed' });
      expect(failed.calls.writes).toBe(1);
      expect(failed.calls.receipt).toBe(1);
      expect(failed.session.getState().capabilities.invocations['invocation-task-1']).toMatchObject(
        { status: 'running', attemptsStarted: 1 },
      );
      expect(failed.session.getState().suspendedSubagents['call-1']).toBeUndefined();
      expect(failed.session.getState().tools.calls['call-1']?.status).toBe('running');
    }
  });

  test('preserves failed terminal, termination, path, metadata, and classifier facts', async () => {
    const harness = persistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: {
        status: 'error',
        content: [{ type: 'text', text: 'timed out' }],
        failure: {
          code: 'unknown',
          message: 'timed out',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        structuredContent: structuredContent({
          ok: false,
          stdout: '',
          stderr: 'timed out',
          terminationReason: 'timed_out',
          classifierAdviceV1: { detailCode: 'timeout', disposition: 'never' },
        }),
      },
    });
    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_failed',
      'tool.failed',
    ]);
    expect(harness.calls.receiptEvents[0]?.[1]).toMatchObject({
      type: 'tool.failed',
      failure: { kind: 'unknown', message: 'timed out' },
    });
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'failed',
    });
  });

  test('keeps a confirmed Builtin domain failure as a finished tool result', async () => {
    const harness = persistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: {
        status: 'error',
        content: [{ type: 'text', text: 'git inspection failed' }],
        failure: {
          code: 'builtin_operation_failed',
          message: 'git inspection failed',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        structuredContent: structuredContent({
          ok: false,
          stdout: '',
          stderr: 'git inspection failed',
          resultMeta: { command: 'git_inspect', exitCode: 1 },
          classifierAdviceV1: { detailCode: 'git_failed', disposition: 'never' },
        }),
      },
    });
    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_failed',
      'tool.finished',
    ]);
    expect(harness.calls.receiptEvents[0]?.[1]).toMatchObject({
      type: 'tool.finished',
      name: 'read_file',
      result: {
        ok: false,
        command: 'git_inspect',
        exitCode: 1,
        status: 'error',
        resultMeta: {
          contentDigest: expect.any(String),
          digestScope: 'raw',
          modelContentDigest: expect.any(String),
          rawResultDigest: expect.any(String),
        },
      },
      classifierAdviceV1: { detailCode: 'git_failed', disposition: 'never' },
    });
  });

  test('durably admits exactly one Dynamic MCP safe-read retry without a terminal receipt', async () => {
    const harness = persistenceHarness({ toolName: 'mcp__server__fixture' });
    const first = await harness.persistence.recordAttempt(dynamicRetryPrepared(1));
    await harness.persistence.commitRetryable?.({
      acknowledgement: first,
      replaySafety: 'safe_read',
      result: retryableProviderFailureResult(),
    });

    expect(harness.calls.receiptEvents[0]?.map((event) => event.type)).toEqual([
      'tool.retry_recorded',
    ]);
    expect(harness.calls.writes).toBe(0);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'running',
      attemptsStarted: 1,
    });
    expect(harness.session.getState().tools.calls['call-1']).toMatchObject({
      status: 'running',
      recoveryMode: 'automatic_retry',
    });

    const second = await harness.persistence.recordAttempt(dynamicRetryPrepared(2));
    expect(second.attempt.attempt).toBe(2);
    await expect(
      harness.persistence.commitTerminal({ acknowledgement: first, result: result() }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
  });

  test('projects a confirmed Dynamic MCP authentication failure into one provider action', async () => {
    const harness = persistenceHarness({
      toolName: 'mcp__server__fixture',
      providerActionEnabled: true,
    });
    const acknowledgement = await harness.persistence.recordAttempt(dynamicRetryPrepared(1));
    await harness.persistence.commitTerminal({
      acknowledgement,
      result: result({
        status: 'error',
        content: [],
        structuredContent: structuredContent({
          ok: false,
          stdout: '',
          stderr: 'Login required.',
          resultMeta: {
            providerFailure: { code: 'provider_auth_required', retryable: false },
          },
        }),
        failure: {
          code: 'provider_auth_required',
          message: 'Login required.',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
      }),
    });

    expect(harness.calls.receiptEvents).toHaveLength(1);
    expect(
      harness.calls.receiptEvents[0]?.filter((event) => event.type === 'provider.action_required'),
    ).toEqual([
      {
        type: 'provider.action_required',
        interactionId: 'provider-action-interaction-1',
        providerId: 'mcp-provider',
        action: 'login',
        originatingToolCallId: 'call-1',
      },
    ]);
    expect(harness.session.getState().interactions).toMatchObject({
      kind: 'awaiting_provider_action',
      providerId: 'mcp-provider',
      action: 'login',
    });
  });

  test('rejects forged or non-safe retry evidence before another State26 attempt is authorized', async () => {
    const wrongFailure = persistenceHarness({ toolName: 'mcp__server__fixture' });
    const wrongFailureAck = await wrongFailure.persistence.recordAttempt(dynamicRetryPrepared(1));
    await expect(
      wrongFailure.persistence.commitRetryable?.({
        acknowledgement: wrongFailureAck,
        replaySafety: 'safe_read',
        result: Object.freeze({
          ...retryableProviderFailureResult(),
          failure: Object.freeze({
            ...retryableProviderFailureResult().failure!,
            code: 'provider_auth_required',
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'retryable_commit_failed' });
    expect(wrongFailure.calls.receipt).toBe(0);

    const nonDynamic = persistenceHarness();
    const nonDynamicAck = await nonDynamic.persistence.recordAttempt(prepared(1));
    await expect(
      nonDynamic.persistence.commitRetryable?.({
        acknowledgement: nonDynamicAck,
        replaySafety: 'safe_read',
        result: retryableProviderFailureResult(),
      }),
    ).rejects.toMatchObject({ code: 'retryable_commit_failed' });
    expect(nonDynamic.calls.receipt).toBe(0);
  });

  test('turns a failed safe-read retry acknowledgement into one non-replayable unknown', async () => {
    const harness = persistenceHarness({
      toolName: 'mcp__server__fixture',
      receiptResult: false,
    });
    const candidate = dynamicRetryPrepared(1);
    const coordinator = createRuntimeHostToolPipelineAttemptCoordinatorV1<
      RuntimeJsonValueV1,
      RuntimeJsonValueV1,
      State26BuiltinOperationStructuredContentV1
    >({
      persistence: harness.persistence,
      dispatch: {
        verifyPreparedIdentity: () => true,
        dispatch: async () => ({
          kind: 'retryable',
          replaySafety: 'safe_read',
          result: retryableProviderFailureResult(),
        }),
      },
    });
    const authority = coordinator.prepare(candidate.identity, candidate.input);
    await expect(coordinator.execute(authority)).rejects.toMatchObject({
      code: 'unknown_outcome',
    });
    expect(harness.calls.receipt).toBe(1);
    expect(harness.calls.recovery).toBe(1);
    expect(harness.calls.recoveryEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_unknown',
      'tool.failed',
    ]);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'unknown',
      attemptsStarted: 1,
    });
  });

  test('records unknown only through terminal_recovery and rejects late terminal commit', async () => {
    const harness = persistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));
    await harness.persistence.recordUnknown({
      acknowledgement,
      code: 'dispatch_failed',
    });
    expect(harness.calls.recovery).toBe(1);
    expect(harness.calls.receipt).toBe(0);
    expect(harness.calls.recoveryEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_unknown',
      'tool.failed',
    ]);
    await expect(
      harness.persistence.commitTerminal({ acknowledgement, result: result() }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
    expect(harness.calls.receipt).toBe(0);
  });

  test('artifact failure through Host coordinator becomes one unknown recovery without success', async () => {
    const harness = persistenceHarness({
      artifactWrite: () => {
        throw new Error('artifact unavailable');
      },
    });
    const candidate = prepared(1);
    const coordinator = createRuntimeHostToolPipelineAttemptCoordinatorV1<
      RuntimeJsonValueV1,
      RuntimeJsonValueV1,
      State26BuiltinOperationStructuredContentV1
    >({
      persistence: harness.persistence,
      dispatch: {
        verifyPreparedIdentity: () => true,
        dispatch: async () => ({
          kind: 'committed',
          terminal: result({ structuredContent: structuredContentWithObservation() }),
        }),
      },
    });
    const authority = coordinator.prepare(candidate.identity, candidate.input);
    await expect(coordinator.execute(authority)).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(harness.calls.writes).toBe(1);
    expect(harness.calls.receipt).toBe(0);
    expect(harness.calls.recovery).toBe(1);
    expect(harness.calls.recoveryEvents[0]?.map((event) => event.type)).toEqual([
      'capability.execution_unknown',
      'tool.failed',
    ]);
    expect(harness.session.getState().capabilities.invocations['invocation-1']).toMatchObject({
      status: 'unknown',
    });
  });

  test('fails closed on false/throw/stale and forged or unsupported authority', async () => {
    const stale = persistenceHarness({ attemptResult: false });
    await expect(stale.persistence.recordAttempt(prepared(1))).rejects.toMatchObject({
      code: 'persistence_stale',
    });
    expect(stale.calls.attempt).toBe(1);

    const staleLease = persistenceHarness();
    staleLease.staleLease();
    await expect(staleLease.persistence.recordAttempt(prepared(1))).rejects.toMatchObject({
      code: 'persistence_stale',
    });
    expect(staleLease.calls.attempt).toBe(1);

    const throwingAttempt = persistenceHarness({ attemptThrow: true });
    await expect(throwingAttempt.persistence.recordAttempt(prepared(1))).rejects.toMatchObject({
      code: 'persistence_unavailable',
    });
    expect(throwingAttempt.calls.attempt).toBe(1);

    const failedRecovery = persistenceHarness({ recoveryResult: false });
    const failedRecoveryAck = await failedRecovery.persistence.recordAttempt(prepared(1));
    await expect(
      failedRecovery.persistence.recordUnknown({
        acknowledgement: failedRecoveryAck,
        code: 'dispatch_failed',
      }),
    ).rejects.toMatchObject({ code: 'persistence_stale' });
    expect(failedRecovery.calls.recovery).toBe(1);

    const throwingRecovery = persistenceHarness({ recoveryThrow: true });
    const throwingRecoveryAck = await throwingRecovery.persistence.recordAttempt(prepared(1));
    await expect(
      throwingRecovery.persistence.recordUnknown({
        acknowledgement: throwingRecoveryAck,
        code: 'dispatch_failed',
      }),
    ).rejects.toMatchObject({ code: 'persistence_unavailable' });
    expect(throwingRecovery.calls.recovery).toBe(1);

    const failedReceipt = persistenceHarness({ receiptResult: false });
    const failedReceiptAck = await failedReceipt.persistence.recordAttempt(prepared(1));
    await expect(
      failedReceipt.persistence.commitTerminal({
        acknowledgement: failedReceiptAck,
        result: result({
          status: 'error',
          content: [{ type: 'text', text: 'receipt failed' }],
          failure: {
            code: 'unknown',
            message: 'receipt failed',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: true,
          },
          structuredContent: structuredContentWithoutObservation({
            ok: false,
            stderr: 'receipt failed',
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'terminal_commit_failed' });
    expect(failedReceipt.calls.receipt).toBe(1);

    const throwing = persistenceHarness();
    throwing.replaceLease();
    const acknowledgement = await throwing.persistence.recordAttempt(prepared(1));
    await expect(
      throwing.persistence.recordUnknown({
        acknowledgement: {
          ...acknowledgement,
          attempt: { ...acknowledgement.attempt, attemptId: 'forged' },
        },
        code: 'dispatch_failed',
      }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
    expect(throwing.calls.recovery).toBe(0);

    const malformedRequest = prepared(1);
    const request = malformedRequest.input.request;
    if (
      request === undefined ||
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request)
    ) {
      throw new Error('invalid prepared request fixture');
    }
    await expect(
      persistenceHarness().persistence.recordAttempt({
        ...malformedRequest,
        input: {
          ...malformedRequest.input,
          request: { ...request, unexpectedAuthority: true },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_prepared_request' });

    await expect(
      persistenceHarness().persistence.recordAttempt(dynamicPrepared()),
    ).rejects.toMatchObject({ code: 'unsupported_operation' });

    const askUser = prepared(1);
    await expect(
      persistenceHarness().persistence.recordAttempt({
        ...askUser,
        identity: {
          ...askUser.identity,
          operationId: 'builtin:ask_user' as NonDynamicOperationIdV1,
          executionMechanism: 'user_input',
          exposedToolName: 'ask_user',
        },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_operation' });

    const subagent = taskPrepared(1);
    await expect(
      persistenceHarness().persistence.recordAttempt({
        ...subagent,
        identity: {
          ...subagent.identity,
          executionFamily: 'builtin',
        },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_operation' });
  });

  test('rejects runtime terminal events and unverified filesystem observations', async () => {
    const harness = persistenceHarness();
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));
    await expect(
      harness.persistence.commitTerminal({
        acknowledgement,
        result: result({
          structuredContent: structuredContent({
            runtimeEvents: [
              {
                type: 'tool.finished',
                toolCallId: 'call-1',
                name: 'read_file',
                result: { ok: true, command: 'read_file', exitCode: 0, stdout: '', stderr: '' },
              },
            ],
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(harness.calls.writes).toBe(0);
    expect(harness.calls.receipt).toBe(0);

    await expect(
      harness.persistence.commitTerminal({
        acknowledgement,
        result: result({
          structuredContent: structuredContent({
            filesystemObservation: {
              actorIdentityDigest: 'a',
              lexicalTargetDigest: 'b',
              canonicalTargetDigest: 'c',
              targetIdentityDigest: 'd',
              contentDigest: 'e',
            },
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(harness.calls.writes).toBe(0);
  });

  test('fails closed before artifact or receipt persistence for missing, forged, or cloned filesystem authority', async () => {
    const missingSuccess = persistenceHarness();
    const missingSuccessAcknowledgement = await missingSuccess.persistence.recordAttempt(
      prepared(1),
    );
    await expect(
      missingSuccess.persistence.commitTerminal({
        acknowledgement: missingSuccessAcknowledgement,
        result: result(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(missingSuccess.calls.writes).toBe(0);
    expect(missingSuccess.calls.receipt).toBe(0);

    const missing = persistenceHarness({
      terminalVerifier: () => ({ valid: false, code: 'terminal_not_issued' }),
    });
    const missingAcknowledgement = await missing.persistence.recordAttempt(prepared(1));
    await expect(
      missing.persistence.commitTerminal({
        acknowledgement: missingAcknowledgement,
        result: result({ structuredContent: structuredContentWithObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(missing.calls.writes).toBe(0);
    expect(missing.calls.receipt).toBe(0);

    const forged = persistenceHarness({
      terminalVerifier: () => ({
        valid: true,
        observation: structuredClone(AUTHENTIC_FILESYSTEM_OBSERVATION),
      }),
    });
    const forgedAcknowledgement = await forged.persistence.recordAttempt(prepared(1));
    await expect(
      forged.persistence.commitTerminal({
        acknowledgement: forgedAcknowledgement,
        result: result({ structuredContent: structuredContentWithObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(forged.calls.writes).toBe(0);
    expect(forged.calls.receipt).toBe(0);

    const clonedAcknowledgement = persistenceHarness();
    const originalAcknowledgement = await clonedAcknowledgement.persistence.recordAttempt(
      prepared(1),
    );
    await expect(
      clonedAcknowledgement.persistence.commitTerminal({
        acknowledgement: structuredClone(originalAcknowledgement),
        result: result(),
      }),
    ).rejects.toMatchObject({ code: 'acknowledgement_mismatch' });
    expect(clonedAcknowledgement.calls.writes).toBe(0);
    expect(clonedAcknowledgement.calls.receipt).toBe(0);

    const clonedTerminal = persistenceHarness();
    const clonedTerminalAcknowledgement = await clonedTerminal.persistence.recordAttempt(
      prepared(1),
    );
    await expect(
      clonedTerminal.persistence.commitTerminal({
        acknowledgement: clonedTerminalAcknowledgement,
        result: structuredClone(result({ structuredContent: structuredContentWithObservation() })),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(clonedTerminal.calls.writes).toBe(0);
    expect(clonedTerminal.calls.receipt).toBe(0);

    const search = persistenceHarness({ toolName: 'search_files' });
    const searchAcknowledgement = await search.persistence.recordAttempt(searchPrepared());
    await expect(
      search.persistence.commitTerminal({
        acknowledgement: searchAcknowledgement,
        result: result({ structuredContent: structuredContentWithObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(search.calls.writes).toBe(0);
    expect(search.calls.receipt).toBe(0);

    const failedRead = persistenceHarness();
    const failedReadAcknowledgement = await failedRead.persistence.recordAttempt(prepared(1));
    await expect(
      failedRead.persistence.commitTerminal({
        acknowledgement: failedReadAcknowledgement,
        result: result({
          status: 'error',
          content: [{ type: 'text', text: 'failed read' }],
          failure: {
            code: 'unknown',
            message: 'failed read',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: true,
          },
          structuredContent: structuredContentWithObservation({
            ok: false,
            stderr: 'failed read',
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(failedRead.calls.writes).toBe(0);
    expect(failedRead.calls.receipt).toBe(0);
  });

  test('fails closed when a read observation is supplied without the injected verifier', async () => {
    const harness = persistenceHarness({ withoutTerminalVerifier: true });
    const acknowledgement = await harness.persistence.recordAttempt(prepared(1));
    await expect(
      harness.persistence.commitTerminal({
        acknowledgement,
        result: result({ structuredContent: structuredContentWithObservation() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_terminal_result' });
    expect(harness.calls.writes).toBe(0);
    expect(harness.calls.receipt).toBe(0);
  });
});
