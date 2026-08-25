import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostToolPipelineAttemptCoordinator,
  type RuntimeHostToolInvocationOutcomeAuthority,
  type RuntimeHostToolPipelineAttemptCoordinator,
  RuntimeHostToolPipelineAttemptCoordinatorError,
} from '@kite-ai/runtime-host';
import type {
  CapabilityToolTerminalResult,
  NonDynamicOperationId,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineDispatch,
  ToolPipelineDispatchOutcome,
  ToolPipelineOutcomeDispatch,
  ToolPipelinePersistence,
  ToolPipelineRetryableCommit,
  ToolPipelineSkillForkSuspension,
  ToolPipelineSuspendedExecutionResult,
  ToolPipelineSuspension,
  ToolPipelineTaskSubagentSuspension,
} from '@kite-ai/runtime-spi';

const operationId = 'builtin:fixture' as NonDynamicOperationId;

function isRuntimeJsonObject(
  value: RuntimeJsonValue,
): value is Readonly<Record<string, RuntimeJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identity(): PreparedToolInvocationIdentity {
  return {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'fixture-provider',
    operationId,
    executionFamily: 'builtin',
    executionMechanism: 'filesystem',
    capabilityId: 'builtin:fixture',
    capabilityRevision: 'capability-1',
    descriptorRevision: 'descriptor-1',
    parserRevision: 'parser-1',
    executorRevision: 'executor-1',
    argumentsDigest: 'arguments-1',
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: 'binding-1',
    visibility: 'model',
    modelVisible: true,
    exposedToolName: 'fixture',
    builtinProjectionRevision: 'builtin-1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: 'computer',
  };
}

function skillIdentity(): PreparedToolInvocationIdentity {
  return {
    ...identity(),
    operationId: 'builtin:activate_skill' as NonDynamicOperationId,
  } as PreparedToolInvocationIdentity;
}

function taskIdentity(): PreparedToolInvocationIdentity {
  return {
    ...identity(),
    operationId: 'builtin:task' as NonDynamicOperationId,
  } as PreparedToolInvocationIdentity;
}

function dynamicIdentity(): PreparedToolInvocationIdentity {
  return {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'mcp-provider',
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    capabilityId: 'mcp:server:fixture',
    capabilityRevision: 'subject-capability-1',
    descriptorRevision: 'subject-descriptor-1',
    parserRevision: 'wrapper-parser-1',
    executorRevision: null,
    argumentsDigest: 'arguments-1',
    schemaDigest: 'subject-schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: 'binding-1',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'dynamic-catalog-1',
    isDynamicMcp: true,
    subject: {
      capabilityId: 'mcp:server:fixture',
      capabilityRevision: 'subject-capability-1',
      descriptorRevision: 'subject-descriptor-1',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__fixture',
      dynamicCatalogRevision: 'dynamic-catalog-1',
      bindingId: 'binding-1',
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
}

function result(
  overrides: Partial<CapabilityToolTerminalResult> = {},
): CapabilityToolTerminalResult {
  return { status: 'success', content: [{ ok: true }], ...overrides };
}

function planReviewSuspension(toolCallId = 'call-1'): ToolPipelineSuspension {
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    kind: 'plan_review',
    toolCallId,
    event: {
      type: 'plan.review_requested',
      interactionId: 'interaction-1',
      toolCallId,
      taskId: 'task-1',
      plan: { title: 'Fixture plan', steps: [{ id: 'step-1', title: 'Inspect' }] },
      planSummary: 'Fixture plan',
      planId: 'plan-1',
      version: 1,
      structuralDigest: 'plan-digest-1',
      artifact: { artifactId: 'artifact-1', kind: 'plan' },
    },
  };
}

function suspendedResult(): ToolPipelineSuspendedExecutionResult {
  return {
    status: 'success',
    content: [{ type: 'text', text: 'plan review requested' }],
    structuredContent: { ok: true, status: 'plan_review_requested' },
  };
}

function suspendedOutcome(
  toolCallId = 'call-1',
): Extract<ToolPipelineDispatchOutcome, { readonly kind: 'suspended' }> {
  return {
    kind: 'suspended',
    suspension: planReviewSuspension(toolCallId),
    result: suspendedResult(),
  };
}

function skillForkSuspension(
  eventKind: 'approval' | 'auto_review' = 'approval',
): ToolPipelineSkillForkSuspension {
  const approval = {
    scope: 'once',
    callId: 'child-call-1',
    cwd: '/workspace',
    threadId: 'thread-1',
    tool: 'shell_execute',
    command: 'echo child',
    risk: 'execute_code',
    approvalHash: 'approval-binding-1',
    summary: 'The child shell command requires approval.',
    reason: 'The child tool requires approval.',
    expectedEffects: ['child command execution'],
    grantOptions: ['approve_once'],
    recommendedGrant: 'approve_once',
  };
  const event =
    eventKind === 'approval'
      ? {
          type: 'approval.requested',
          interactionId: 'interaction-skill-1',
          toolCallId: 'call-1',
          approval,
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: true,
          approvalRoute: 'user',
          queueGeneration: 0,
          queueSequence: 0,
          parentToolCallId: 'call-1',
          childSubagentId: 'child-subagent-1',
          runtimeToolCallId: 'runtime-child-call-1',
          bindingDigest: 'approval-binding-1',
          createdAt: '2026-08-22T00:00:00.000Z',
        }
      : {
          type: 'auto_review.requested',
          reviewId: 'review-skill-1',
          toolCallId: 'call-1',
          toolName: 'shell_execute',
          reason: 'The child tool requires an auto review.',
          approval,
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: true,
          approvalRoute: 'auto',
          queueGeneration: 0,
          queueSequence: 0,
          parentToolCallId: 'call-1',
          childSubagentId: 'child-subagent-1',
          runtimeToolCallId: 'runtime-child-call-1',
          bindingDigest: 'approval-binding-1',
          requestFingerprint: 'request-fingerprint-1',
          createdAt: '2026-08-22T00:00:00.000Z',
        };
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    kind: 'skill_fork',
    operationId: 'builtin:activate_skill',
    toolCallId: 'call-1',
    parent: {
      toolCallId: 'call-1',
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      attempt: 1,
    },
    activation: {
      activationId: 'activation-1',
      skillId: 'skill:fixture',
      skillRevision: 'skill-revision-1',
      taskId: 'task-1',
      contextMode: 'fork',
    },
    subagent: {
      storage: 'private_artifact_v1',
      subagentId: 'child-subagent-1',
      role: 'code',
      continuationId: 'continuation-1',
      modelInvocationOrdinal: 3,
      continuationArtifact: {
        artifactId: 'artifact-continuation-1',
        kind: 'subagent_continuation',
        integrityIdentifier: 'sha256:continuation-1',
        byteLength: 512,
      },
      parentInvocationId: 'invocation-1',
      parentAttempt: 1,
      blockedTool: {
        reasonCode:
          eventKind === 'approval'
            ? 'SUBAGENT_TOOL_REQUIRES_APPROVAL'
            : 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
        toolCallId: 'child-call-1',
        runtimeToolCallId: 'runtime-child-call-1',
        toolName: 'shell_execute',
      },
    },
    blockedTool: {
      toolCallId: 'child-call-1',
      runtimeToolCallId: 'runtime-child-call-1',
      toolName: 'shell_execute',
      argumentsDigest: 'arguments-digest-1',
      commandDigest: 'command-digest-1',
    },
    event,
  } as ToolPipelineSkillForkSuspension;
}

function skillForkOutcome(
  suspension: ToolPipelineSkillForkSuspension = skillForkSuspension(),
): Extract<ToolPipelineDispatchOutcome, { readonly kind: 'suspended' }> {
  return {
    kind: 'suspended',
    suspension,
    result: suspendedResult(),
  };
}

function taskSubagentSuspension(
  executionMode: 'start' | 'resume' = 'start',
  eventKind: 'approval' | 'auto_review' = 'approval',
): ToolPipelineTaskSubagentSuspension {
  const approval = {
    scope: 'once',
    callId: 'runtime-task-child-call-1',
    cwd: '/workspace',
    threadId: 'thread-task-1',
    tool: 'write_file',
    command: 'write child file',
    risk: 'write_file',
    approvalHash: 'task-approval-binding-1',
    summary: 'The task child write requires approval.',
    reason: 'The task child write requires review.',
    expectedEffects: ['child file update'],
    grantOptions: ['approve_once'],
    recommendedGrant: 'approve_once',
  };
  const event =
    eventKind === 'approval'
      ? {
          type: 'approval.requested',
          interactionId: 'interaction-task-1',
          toolCallId: 'call-1',
          approval,
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: true,
          approvalRoute: 'user',
          queueGeneration: 0,
          queueSequence: 0,
          parentToolCallId: 'call-1',
          childSubagentId: 'task-subagent-1',
          runtimeToolCallId: 'runtime-task-child-call-1',
          bindingDigest: 'task-approval-binding-1',
          createdAt: '2026-08-22T00:00:00.000Z',
        }
      : {
          type: 'auto_review.requested',
          reviewId: 'review-task-1',
          toolCallId: 'call-1',
          toolName: 'write_file',
          reason: 'The task child write requires auto review.',
          approval,
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: true,
          approvalRoute: 'auto',
          queueGeneration: 0,
          queueSequence: 0,
          parentToolCallId: 'call-1',
          childSubagentId: 'task-subagent-1',
          runtimeToolCallId: 'runtime-task-child-call-1',
          bindingDigest: 'task-approval-binding-1',
          requestFingerprint: 'task-request-fingerprint-1',
          createdAt: '2026-08-22T00:00:00.000Z',
        };
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    kind: 'task_subagent',
    operationId: 'builtin:task',
    executionMode,
    toolCallId: 'call-1',
    parent: {
      toolCallId: 'call-1',
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      attempt: 1,
    },
    subagent: {
      storage: 'private_artifact_v1',
      subagentId: 'task-subagent-1',
      role: 'code',
      continuationId: 'task-continuation-1',
      modelInvocationOrdinal: 4,
      continuationArtifact: {
        artifactId: 'task-artifact-1',
        kind: 'subagent_continuation',
        integrityIdentifier: 'sha256:task-continuation-1',
        byteLength: 640,
      },
      parentInvocationId: 'invocation-1',
      parentAttempt: 1,
      blockedTool: {
        reasonCode:
          eventKind === 'approval'
            ? 'SUBAGENT_TOOL_REQUIRES_APPROVAL'
            : 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
        toolCallId: 'task-child-call-1',
        runtimeToolCallId: 'runtime-task-child-call-1',
        toolName: 'write_file',
      },
    },
    blockedTool: {
      toolCallId: 'task-child-call-1',
      runtimeToolCallId: 'runtime-task-child-call-1',
      toolName: 'write_file',
      argumentsDigest: 'task-arguments-digest-1',
      commandDigest: null,
    },
    event,
  } as ToolPipelineTaskSubagentSuspension;
}

function taskSubagentOutcome(
  suspension: ToolPipelineTaskSubagentSuspension = taskSubagentSuspension(),
): Extract<ToolPipelineDispatchOutcome, { readonly kind: 'suspended' }> {
  return {
    kind: 'suspended',
    suspension,
    result: suspendedResult(),
  };
}

function retryableOutcome(
  overrides: Partial<CapabilityToolTerminalResult> = {},
): Extract<ToolPipelineDispatchOutcome, { readonly kind: 'retryable' }> {
  return {
    kind: 'retryable',
    replaySafety: 'safe_read',
    result: {
      status: 'error',
      content: [{ type: 'text', text: 'provider unavailable' }],
      failure: {
        code: 'provider_unavailable',
        message: 'The provider is temporarily unavailable.',
        retryable: true,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: false,
      },
      ...overrides,
    },
  };
}

function acknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
  overrides: Record<string, unknown> = {},
): ToolPipelineAttemptAcknowledgement {
  const identity = prepared.identity;
  return {
    acknowledged: true,
    attempt: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      attempt: 1,
      toolCallId: identity.toolCallId,
      turnId: identity.turnId,
      modelMessageId: identity.modelMessageId,
      argumentOrigin: identity.argumentOrigin,
      providerId: identity.providerId,
      operationId: identity.operationId,
      capabilityId: identity.capabilityId,
      capabilityRevision: identity.capabilityRevision,
      descriptorRevision: identity.descriptorRevision,
      parserRevision: identity.parserRevision,
      executorRevision: identity.executorRevision,
      argumentsDigest: identity.argumentsDigest,
      schemaDigest: identity.schemaDigest,
      effectiveEffectsDigest: identity.effectiveEffectsDigest,
      builtinProjectionRevision: identity.builtinProjectionRevision,
      dynamicCatalogRevision: identity.dynamicCatalogRevision,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: identity.idempotencyKey,
      runtimeWrapperProviderId: identity.isDynamicMcp ? identity.runtimeWrapper.providerId : null,
      runtimeWrapperCapabilityRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.capabilityRevision
        : null,
      runtimeWrapperExecutorRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.executorRevision
        : null,
      runtimeWrapperSchemaDigest: identity.isDynamicMcp
        ? identity.runtimeWrapper.schemaDigest
        : null,
      runtimeWrapperBuiltinProjectionRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.builtinProjectionRevision
        : null,
      recordedAt: '2026-08-21T00:00:00.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
      ...overrides,
    },
  };
}

function fixture(
  options: {
    readonly identity?: PreparedToolInvocationIdentity;
    readonly arguments?: RuntimeJsonValue;
    readonly binding?: Readonly<{
      bindingId: string;
      capabilityId: string;
      capabilityRevision: string;
      exposedToolName: string;
      schemaDigest: string;
      issuedForTurnId: string;
    }>;
    readonly verify?: ToolPipelineDispatch['verifyPreparedIdentity'];
    readonly recordAttempt?: (
      input: Readonly<PreparedToolInvocation>,
    ) => Promise<unknown> | unknown;
    readonly recordUnknown?: (input: unknown) => Promise<void> | void;
    readonly commitTerminal?: (input: unknown) => Promise<void> | void;
    readonly commitSuspension?: (input: unknown) => Promise<void> | void;
    readonly commitRetryable?: (input: unknown) => Promise<void> | void;
    readonly dispatch?: (input: Readonly<PreparedToolInvocation>) => Promise<unknown> | unknown;
  } = {},
) {
  let persistenceCalls = 0;
  let dispatchCalls = 0;
  let unknownCalls = 0;
  let commitCalls = 0;
  let suspensionCommitCalls = 0;
  let retryableCommitCalls = 0;
  const unknownInputs: unknown[] = [];
  const recordedInputs: Readonly<PreparedToolInvocation>[] = [];
  const suspensionInputs: unknown[] = [];
  const retryableInputs: unknown[] = [];
  const selectedIdentity = options.identity ?? identity();

  const preparedInput = {
    invocationId: selectedIdentity.invocationId,
    attemptId: selectedIdentity.attemptId,
    toolCallId: selectedIdentity.toolCallId,
    arguments: options.arguments ?? { path: 'README.md', nested: { limit: 10 } },
    request: { privateRequest: ['opaque', 1] },
    facts: { privateFacts: { revision: 'facts-1' } },
    binding:
      options.binding ??
      (selectedIdentity.isDynamicMcp
        ? {
            bindingId: 'binding-1',
            capabilityId: 'mcp:server:fixture',
            capabilityRevision: 'subject-capability-1',
            exposedToolName: 'mcp__server__fixture',
            schemaDigest: 'subject-schema-1',
            issuedForTurnId: 'turn-1',
          }
        : {
            bindingId: 'binding-1',
            capabilityId: 'builtin:fixture',
            capabilityRevision: 'capability-1',
            exposedToolName: 'fixture',
            schemaDigest: 'schema-1',
            issuedForTurnId: 'turn-1',
          }),
  } as const;

  const persistence: ToolPipelinePersistence = {
    recordAttempt: async (received) => {
      persistenceCalls += 1;
      recordedInputs.push(received);
      if (options.recordAttempt) {
        return (await options.recordAttempt(received)) as ToolPipelineAttemptAcknowledgement;
      }
      return acknowledgement(received);
    },
    recordUnknown: async (input) => {
      unknownCalls += 1;
      unknownInputs.push(input);
      await options.recordUnknown?.(input);
    },
    commitTerminal: async (input) => {
      commitCalls += 1;
      await options.commitTerminal?.(input);
    },
    commitSuspension: async (input) => {
      suspensionCommitCalls += 1;
      suspensionInputs.push(input);
      await options.commitSuspension?.(input);
    },
    ...(options.commitRetryable
      ? {
          commitRetryable: async (input: Readonly<ToolPipelineRetryableCommit>) => {
            retryableCommitCalls += 1;
            retryableInputs.push(input);
            await options.commitRetryable?.(input);
          },
        }
      : {}),
  };
  const dispatch: ToolPipelineOutcomeDispatch = {
    verifyPreparedIdentity: options.verify ?? (() => true),
    dispatch: async (prepared) => {
      dispatchCalls += 1;
      const dispatched = await options.dispatch?.(prepared);
      if (
        dispatched &&
        typeof dispatched === 'object' &&
        'kind' in dispatched &&
        (dispatched.kind === 'committed' ||
          dispatched.kind === 'suspended' ||
          dispatched.kind === 'retryable')
      ) {
        return dispatched as ToolPipelineDispatchOutcome;
      }
      return {
        kind: 'committed',
        terminal: (dispatched ?? result()) as CapabilityToolTerminalResult,
      };
    },
  };
  const coordinator = createRuntimeHostToolPipelineAttemptCoordinator({
    persistence,
    dispatch,
  });
  const prepared = coordinator.prepare(selectedIdentity, preparedInput);
  return {
    coordinator,
    prepared,
    get persistenceCalls() {
      return persistenceCalls;
    },
    get dispatchCalls() {
      return dispatchCalls;
    },
    get unknownCalls() {
      return unknownCalls;
    },
    get commitCalls() {
      return commitCalls;
    },
    get suspensionCommitCalls() {
      return suspensionCommitCalls;
    },
    get retryableCommitCalls() {
      return retryableCommitCalls;
    },
    unknownInputs,
    recordedInputs,
    suspensionInputs,
    retryableInputs,
  };
}

describe('Runtime Host tool pipeline attempt coordinator', () => {
  test('creates an authentic, deeply frozen prepared authority', () => {
    const harness = fixture();
    expect(Object.isFrozen(harness.prepared)).toBe(true);
    expect(Object.isFrozen(harness.prepared.identity)).toBe(true);
    expect(Object.isFrozen(harness.prepared.input)).toBe(true);
    const argumentsValue = harness.prepared.input.arguments;
    if (!isRuntimeJsonObject(argumentsValue)) {
      throw new Error('fixture arguments unexpectedly non-object');
    }
    expect(Object.isFrozen(argumentsValue)).toBe(true);
    expect(Object.isFrozen(argumentsValue.nested)).toBe(true);
    expect(Object.isFrozen(harness.prepared.input.request)).toBe(true);
    expect(Object.isFrozen(harness.prepared.input.facts)).toBe(true);
    expect(Object.isFrozen(harness.prepared.input.binding)).toBe(true);
    expect(Reflect.set(argumentsValue, 'path', 'tampered')).toBe(false);
    expect(argumentsValue.path).toBe('README.md');
  });

  test('rejects forged or mismatched prepared packets before persistence and dispatch', async () => {
    const harness = fixture();
    const copied = structuredClone(harness.prepared);
    const forged = { ...harness.prepared };
    const mismatchedBinding = harness.coordinator.prepare(identity(), {
      ...harness.prepared.input,
      binding: null,
    });
    const staleTurnBinding = harness.coordinator.prepare(identity(), {
      ...harness.prepared.input,
      binding: {
        ...harness.prepared.input.binding!,
        issuedForTurnId: 'turn-stale',
      },
    });

    await expect(harness.coordinator.execute(copied)).rejects.toMatchObject({
      code: 'invalid_prepared_input',
    });
    await expect(harness.coordinator.execute(forged)).rejects.toMatchObject({
      code: 'invalid_prepared_input',
    });
    await expect(harness.coordinator.execute(mismatchedBinding)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    await expect(harness.coordinator.execute(staleTurnBinding)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    expect(harness.persistenceCalls).toBe(0);
    expect(harness.dispatchCalls).toBe(0);
  });

  test('fails closed for verifier false, typed-invalid, and thrown results', async () => {
    for (const verify of [
      () => false,
      () => ({ valid: false as const, code: 'identity_mismatch' as const, diagnostic: 'secret' }),
      () => {
        throw new Error('provider secret');
      },
    ]) {
      const harness = fixture({ verify });
      const error = await harness.coordinator
        .execute(harness.prepared)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeHostToolPipelineAttemptCoordinatorError);
      expect((error as Error).message).not.toContain('secret');
      expect(harness.persistenceCalls).toBe(0);
      expect(harness.dispatchCalls).toBe(0);
    }
  });

  test('records one authoritative acknowledgement, dispatches once, and commits once', async () => {
    const harness = fixture();
    const committed = await harness.coordinator.execute(harness.prepared);
    expect(committed.result).toEqual(result());
    expect(() => harness.coordinator.assertCommitted(committed)).not.toThrow();
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(1);
    expect(harness.unknownCalls).toBe(0);
    expect(harness.recordedInputs[0]).toBe(harness.prepared);

    const suspendedHarness = fixture({ dispatch: async () => suspendedOutcome() });
    const suspendedCoordinator: RuntimeHostToolPipelineAttemptCoordinator =
      suspendedHarness.coordinator;
    const suspended: Readonly<RuntimeHostToolInvocationOutcomeAuthority> =
      await suspendedCoordinator.execute(suspendedHarness.prepared);
    suspendedCoordinator.assertSuspended(suspended);
    if (suspended.kind !== 'suspended')
      throw new Error('fixture suspension unexpectedly committed');
    expect(suspended.kind).toBe('suspended');
    expect(Object.isFrozen(suspended)).toBe(true);
    expect(Object.isFrozen(suspended.acknowledgement)).toBe(true);
    expect(Object.isFrozen(suspended.suspension)).toBe(true);
    expect(Object.isFrozen(suspended.suspension.event)).toBe(true);
    expect(Object.isFrozen(suspended.result)).toBe(true);
    expect(suspendedHarness.persistenceCalls).toBe(1);
    expect(suspendedHarness.dispatchCalls).toBe(1);
    expect(suspendedHarness.commitCalls).toBe(0);
    expect(suspendedHarness.suspensionCommitCalls).toBe(1);
    expect(suspendedHarness.unknownCalls).toBe(0);
    expect(suspendedHarness.suspensionInputs[0]).toMatchObject({
      acknowledgement: { attempt: { toolCallId: 'call-1' } },
      suspension: { kind: 'plan_review', toolCallId: 'call-1' },
      result: { status: 'success' },
    });
  });

  test('commits a safe-read retry exactly once and returns frozen retry authority', async () => {
    const harness = fixture({
      dispatch: async () => retryableOutcome(),
      commitRetryable: async (input) => {
        expect(input).toMatchObject({
          replaySafety: 'safe_read',
          result: {
            status: 'error',
            failure: { code: 'provider_unavailable', retryable: true },
          },
        });
      },
    });
    const retryable = await harness.coordinator.execute(harness.prepared);
    if (retryable.kind !== 'retryable') {
      throw new Error('fixture retryable outcome unexpectedly committed');
    }

    expect(retryable.kind).toBe('retryable');
    expect(retryable.replaySafety).toBe('safe_read');
    expect(retryable.result.status).toBe('error');
    expect(Object.isFrozen(retryable)).toBe(true);
    expect(Object.isFrozen(retryable.acknowledgement)).toBe(true);
    expect(Object.isFrozen(retryable.result)).toBe(true);
    expect(Object.isFrozen(retryable.result.failure)).toBe(true);
    expect(() => harness.coordinator.assertRetryable(retryable)).not.toThrow();
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.retryableCommitCalls).toBe(1);
    expect(harness.commitCalls).toBe(0);
    expect(harness.unknownCalls).toBe(0);
    expect(harness.retryableInputs).toHaveLength(1);
  });

  test('fails closed when retryable persistence is missing or throws', async () => {
    const cases: readonly {
      readonly commitRetryable?: (input: unknown) => Promise<void> | void;
    }[] = [
      {},
      {
        commitRetryable: async () => {
          throw new Error('retry evidence must not escape');
        },
      },
    ];

    for (const candidate of cases) {
      const harness = fixture({
        ...candidate,
        dispatch: async () => retryableOutcome(),
      });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'unknown_outcome',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.retryableCommitCalls).toBe(candidate.commitRetryable ? 1 : 0);
      expect(harness.commitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(1);
      expect(harness.unknownInputs[0]).toMatchObject({ code: 'retryable_commit_failed' });
    }
  });

  test('rejects malformed retryable outcomes before retry persistence', async () => {
    const valid = retryableOutcome();
    const malformed: readonly unknown[] = [
      {
        ...valid,
        result: { ...valid.result, status: 'success' },
      },
      {
        ...valid,
        result: {
          ...valid.result,
          failure: { ...valid.result.failure!, retryable: false },
        },
      },
      { ...valid, extra: 'forged' },
    ];

    for (const dispatchResult of malformed) {
      const harness = fixture({
        dispatch: async () => dispatchResult,
        commitRetryable: async () => {
          throw new Error('malformed retry must not reach persistence');
        },
      });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'unknown_outcome',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.retryableCommitCalls).toBe(0);
      expect(harness.commitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(1);
      expect(harness.unknownInputs[0]).toMatchObject({ code: 'dispatch_result_invalid' });
    }
  });

  test("authenticates only this coordinator's retryable authority", async () => {
    const harness = fixture({
      dispatch: async () => retryableOutcome(),
      commitRetryable: async () => {},
    });
    const retryable = await harness.coordinator.execute(harness.prepared);
    if (retryable.kind !== 'retryable') {
      throw new Error('fixture retryable outcome unexpectedly committed');
    }
    expect(() => harness.coordinator.assertRetryable(retryable)).not.toThrow();

    for (const forged of [structuredClone(retryable), { ...retryable }]) {
      expect(() => harness.coordinator.assertRetryable(forged)).toThrow(
        RuntimeHostToolPipelineAttemptCoordinatorError,
      );
    }
    const other = fixture({
      dispatch: async () => retryableOutcome(),
      commitRetryable: async () => {},
    });
    expect(() => other.coordinator.assertRetryable(retryable)).toThrow(
      RuntimeHostToolPipelineAttemptCoordinatorError,
    );
  });

  test('accepts valid Skill fork approval and auto-review suspensions', async () => {
    for (const eventKind of ['approval', 'auto_review'] as const) {
      const harness = fixture({
        identity: skillIdentity(),
        dispatch: async () => skillForkOutcome(skillForkSuspension(eventKind)),
      });
      const suspended = await harness.coordinator.execute(harness.prepared);
      if (suspended.kind !== 'suspended') {
        throw new Error('fixture Skill fork unexpectedly committed');
      }
      if (suspended.suspension.kind !== 'skill_fork') {
        throw new Error('fixture suspension unexpectedly used another interaction');
      }
      expect(suspended.suspension.kind).toBe('skill_fork');
      expect(suspended.suspension.operationId).toBe('builtin:activate_skill');
      expect(() => harness.coordinator.assertSuspended(suspended)).not.toThrow();
      expect(Object.isFrozen(suspended)).toBe(true);
      expect(Object.isFrozen(suspended.suspension)).toBe(true);
      expect(Object.isFrozen(suspended.suspension.parent)).toBe(true);
      expect(Object.isFrozen(suspended.suspension.subagent)).toBe(true);
      expect(Object.isFrozen(suspended.suspension.blockedTool)).toBe(true);
      expect(Object.isFrozen(suspended.suspension.event)).toBe(true);
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.suspensionCommitCalls).toBe(1);
      expect(harness.commitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(0);

      for (const forged of [structuredClone(suspended), { ...suspended }]) {
        expect(() => harness.coordinator.assertSuspended(forged)).toThrow(
          RuntimeHostToolPipelineAttemptCoordinatorError,
        );
      }
    }
  });

  test('rejects invalid Skill fork suspension shapes before suspension commit', async () => {
    const valid = skillForkSuspension();
    const malformed: readonly unknown[] = [
      { ...valid, operationId: 'builtin:write_plan' },
      { ...valid, parent: { ...valid.parent, invocationId: 'other-invocation' } },
      { ...valid, activation: { ...valid.activation, contextMode: 'primary' } },
      {
        ...valid,
        subagent: { ...valid.subagent, parentAttempt: 2 },
      },
      {
        ...valid,
        subagent: {
          ...valid.subagent,
          blockedTool: { ...valid.subagent.blockedTool, toolName: 'write_file' },
        },
      },
      {
        ...valid,
        blockedTool: { ...valid.blockedTool, argumentsDigest: '' },
      },
      {
        ...valid,
        blockedTool: { ...valid.blockedTool, commandDigest: 42 },
      },
      {
        ...valid,
        event: { ...valid.event, toolCallId: 'other-parent' },
      },
      {
        ...valid,
        event: { ...valid.event, extra: 'forged' },
      },
      {
        ...valid,
        subagent: {
          ...valid.subagent,
          blockedTool: {
            ...valid.subagent.blockedTool,
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
          },
        },
      },
      {
        ...skillForkSuspension('auto_review'),
        event: {
          ...skillForkSuspension('auto_review').event,
          toolName: 'write_file',
        },
      },
      {
        ...valid,
        subagent: { ...valid.subagent, extra: 'forged' },
      },
    ];

    for (const suspension of malformed) {
      const harness = fixture({
        identity: skillIdentity(),
        dispatch: async () => skillForkOutcome(suspension as ToolPipelineSkillForkSuspension),
      });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'unknown_outcome',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.suspensionCommitCalls).toBe(0);
      expect(harness.commitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(1);
      expect(harness.unknownInputs[0]).toMatchObject({ code: 'dispatch_result_invalid' });
    }
  });

  test('rejects a Skill acknowledgement with the wrong operation before dispatch', async () => {
    const harness = fixture({
      identity: skillIdentity(),
      recordAttempt: (input) => acknowledgement(input, { operationId: 'builtin:fixture' }),
      dispatch: async () => skillForkOutcome(),
    });
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'acknowledgement_failed',
    });
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(0);
    expect(harness.suspensionCommitCalls).toBe(0);
    expect(harness.unknownCalls).toBe(0);
  });

  test('accepts distinct task start/resume approval and auto-review suspensions', async () => {
    for (const executionMode of ['start', 'resume'] as const) {
      for (const eventKind of ['approval', 'auto_review'] as const) {
        const harness = fixture({
          identity: taskIdentity(),
          dispatch: async () =>
            taskSubagentOutcome(taskSubagentSuspension(executionMode, eventKind)),
        });
        const suspended = await harness.coordinator.execute(harness.prepared);
        if (suspended.kind !== 'suspended') {
          throw new Error('fixture task subagent unexpectedly committed');
        }
        if (suspended.suspension.kind !== 'task_subagent') {
          throw new Error('fixture task suspension unexpectedly used another interaction');
        }
        expect(suspended.suspension.operationId).toBe('builtin:task');
        expect(suspended.suspension.executionMode).toBe(executionMode);
        expect(() => harness.coordinator.assertSuspended(suspended)).not.toThrow();
        expect(Object.isFrozen(suspended)).toBe(true);
        expect(Object.isFrozen(suspended.suspension)).toBe(true);
        expect(Object.isFrozen(suspended.suspension.parent)).toBe(true);
        expect(Object.isFrozen(suspended.suspension.subagent)).toBe(true);
        expect(Object.isFrozen(suspended.suspension.blockedTool)).toBe(true);
        expect(Object.isFrozen(suspended.suspension.event)).toBe(true);
        expect(harness.persistenceCalls).toBe(1);
        expect(harness.dispatchCalls).toBe(1);
        expect(harness.suspensionCommitCalls).toBe(1);
        expect(harness.commitCalls).toBe(0);
        expect(harness.unknownCalls).toBe(0);

        for (const forged of [structuredClone(suspended), { ...suspended }]) {
          expect(() => harness.coordinator.assertSuspended(forged)).toThrow(
            RuntimeHostToolPipelineAttemptCoordinatorError,
          );
        }
      }
    }
  });

  test('rejects malformed task subagent suspensions before suspension commit', async () => {
    const valid = taskSubagentSuspension();
    const malformed: readonly unknown[] = [
      { ...valid, kind: 'skill_fork' },
      { ...valid, operationId: 'builtin:activate_skill' },
      { ...valid, executionMode: 'restart' },
      { ...valid, parent: { ...valid.parent, attemptId: 'other-attempt' } },
      {
        ...valid,
        subagent: {
          ...valid.subagent,
          continuationArtifact: {
            ...valid.subagent.continuationArtifact,
            kind: 'subagent_task',
          },
        },
      },
      { ...valid, subagent: { ...valid.subagent, role: 'executor' } },
      { ...valid, subagent: { ...valid.subagent, modelInvocationOrdinal: -1 } },
      { ...valid, subagent: { ...valid.subagent, parentInvocationId: 'other-parent' } },
      {
        ...valid,
        subagent: {
          ...valid.subagent,
          blockedTool: {
            ...valid.subagent.blockedTool,
            runtimeToolCallId: 'other-runtime-child',
          },
        },
      },
      {
        ...valid,
        blockedTool: { ...valid.blockedTool, toolName: 'shell_execute' },
      },
      {
        ...valid,
        blockedTool: { ...valid.blockedTool, argumentsDigest: '' },
      },
      {
        ...valid,
        blockedTool: { ...valid.blockedTool, commandDigest: 42 },
      },
      {
        ...valid,
        event: { ...valid.event, toolCallId: 'other-parent' },
      },
      {
        ...valid,
        event: {
          ...valid.event,
          approval: { ...valid.event.approval, callId: 'other-child' },
        },
      },
      {
        ...valid,
        event: {
          ...valid.event,
          approval: { ...valid.event.approval, callId: 'task-child-call-1' },
        },
      },
      {
        ...valid,
        event: {
          ...valid.event,
          approval: { ...valid.event.approval, callId: 'other-runtime-child' },
        },
      },
      {
        ...valid,
        blockedTool: (() => {
          const { runtimeToolCallId: _runtimeToolCallId, ...withoutRuntime } = valid.blockedTool;
          return withoutRuntime;
        })(),
      },
      {
        ...valid,
        subagent: {
          ...valid.subagent,
          blockedTool: {
            ...valid.subagent.blockedTool,
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
          },
        },
      },
      { ...valid, event: { ...valid.event, extra: 'forged' } },
      { ...valid, activation: { contextMode: 'fork' } },
    ];

    for (const suspension of malformed) {
      const harness = fixture({
        identity: taskIdentity(),
        dispatch: async () => taskSubagentOutcome(suspension as ToolPipelineTaskSubagentSuspension),
      });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'unknown_outcome',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.suspensionCommitCalls).toBe(0);
      expect(harness.commitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(1);
      expect(harness.unknownInputs[0]).toMatchObject({ code: 'dispatch_result_invalid' });
    }
  });

  test('rejects a task acknowledgement with the wrong operation before dispatch', async () => {
    const harness = fixture({
      identity: taskIdentity(),
      recordAttempt: (input) => acknowledgement(input, { operationId: 'builtin:fixture' }),
      dispatch: async () => taskSubagentOutcome(),
    });
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'acknowledgement_failed',
    });
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(0);
    expect(harness.suspensionCommitCalls).toBe(0);
    expect(harness.unknownCalls).toBe(0);
  });

  test("authenticates only this coordinator's committed authority", async () => {
    const harness = fixture();
    const committed = await harness.coordinator.execute(harness.prepared);
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.acknowledgement)).toBe(true);
    expect(Object.isFrozen(committed.result)).toBe(true);
    expect(() => harness.coordinator.assertCommitted(committed)).not.toThrow();

    for (const forged of [structuredClone(committed), { ...committed }]) {
      expect(() => harness.coordinator.assertCommitted(forged)).toThrow(
        RuntimeHostToolPipelineAttemptCoordinatorError,
      );
    }
    const other = fixture();
    expect(() => other.coordinator.assertCommitted(committed)).toThrow(
      RuntimeHostToolPipelineAttemptCoordinatorError,
    );

    const suspendedHarness = fixture({ dispatch: async () => suspendedOutcome() });
    const suspendedCoordinator: RuntimeHostToolPipelineAttemptCoordinator =
      suspendedHarness.coordinator;
    const suspended: Readonly<RuntimeHostToolInvocationOutcomeAuthority> =
      await suspendedCoordinator.execute(suspendedHarness.prepared);
    suspendedCoordinator.assertSuspended(suspended);
    if (suspended.kind !== 'suspended')
      throw new Error('fixture suspension unexpectedly committed');
    for (const forged of [structuredClone(suspended), { ...suspended }]) {
      expect(() => suspendedHarness.coordinator.assertSuspended(forged)).toThrow(
        RuntimeHostToolPipelineAttemptCoordinatorError,
      );
    }
    expect(() => suspendedHarness.coordinator.assertCommitted(suspended)).toThrow(
      RuntimeHostToolPipelineAttemptCoordinatorError,
    );
    expect(() => other.coordinator.assertSuspended(suspended)).toThrow(
      RuntimeHostToolPipelineAttemptCoordinatorError,
    );
  });

  test('uses unambiguous tuple claims for identities containing NUL', async () => {
    const harness = fixture();
    const firstIdentity = {
      ...identity(),
      turnId: 'scope\u0000message',
      modelMessageId: 'tail',
    };
    const secondIdentity = {
      ...identity(),
      turnId: 'scope',
      modelMessageId: 'message\u0000tail',
    };
    const firstPrepared = harness.coordinator.prepare(firstIdentity, {
      ...harness.prepared.input,
      invocationId: firstIdentity.invocationId,
      attemptId: firstIdentity.attemptId,
      binding: {
        ...harness.prepared.input.binding!,
        issuedForTurnId: firstIdentity.turnId,
      },
    });
    const secondPrepared = harness.coordinator.prepare(secondIdentity, {
      ...harness.prepared.input,
      invocationId: secondIdentity.invocationId,
      attemptId: secondIdentity.attemptId,
      binding: {
        ...harness.prepared.input.binding!,
        issuedForTurnId: secondIdentity.turnId,
      },
    });

    const firstCommitted = await harness.coordinator.execute(firstPrepared);
    const secondCommitted = await harness.coordinator.execute(secondPrepared);
    expect(() => harness.coordinator.assertCommitted(firstCommitted)).not.toThrow();
    expect(() => harness.coordinator.assertCommitted(secondCommitted)).not.toThrow();
    expect(harness.persistenceCalls).toBe(2);
    expect(harness.dispatchCalls).toBe(2);
    expect(harness.commitCalls).toBe(2);
  });

  test('rejects empty and oversized identity fields before persistence or dispatch', async () => {
    const invalidIdentities: readonly PreparedToolInvocationIdentity[] = [
      { ...identity(), providerId: '' },
      { ...identity(), invocationId: 'x'.repeat(257) },
      { ...identity(), argumentsDigest: '' },
      { ...identity(), turnId: '' },
      { ...identity(), modelMessageId: 'm'.repeat(257) },
      { ...identity(), argumentOrigin: 'forged' } as unknown as PreparedToolInvocationIdentity,
    ];
    for (const invalidIdentity of invalidIdentities) {
      const harness = fixture({ identity: invalidIdentity });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'invalid_prepared_input',
      });
      expect(harness.persistenceCalls).toBe(0);
      expect(harness.dispatchCalls).toBe(0);
    }
  });

  test('rejects sparse, extended, and accessor arrays without executing accessors', async () => {
    const sparse: (string | null)[] = [];
    sparse.length = 2;
    sparse[1] = 'present';
    const sparseHarness = fixture({ arguments: sparse });
    await expect(sparseHarness.coordinator.execute(sparseHarness.prepared)).rejects.toMatchObject({
      code: 'invalid_prepared_input',
    });
    expect(sparseHarness.persistenceCalls).toBe(0);
    expect(sparseHarness.dispatchCalls).toBe(0);

    const extended = ['present'];
    Object.defineProperty(extended, 'extra', { value: 'drift', enumerable: true });
    const extendedHarness = fixture({ arguments: extended });
    await expect(
      extendedHarness.coordinator.execute(extendedHarness.prepared),
    ).rejects.toMatchObject({ code: 'invalid_prepared_input' });
    expect(extendedHarness.persistenceCalls).toBe(0);
    expect(extendedHarness.dispatchCalls).toBe(0);

    let accessorCalls = 0;
    const accessor: string[] = [];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'must-not-run';
      },
    });
    expect(() => fixture({ arguments: accessor })).toThrow(
      RuntimeHostToolPipelineAttemptCoordinatorError,
    );
    expect(accessorCalls).toBe(0);
  });

  test('keeps dynamic MCP subject and private wrapper identities separate', async () => {
    const harness = fixture({ identity: dynamicIdentity() });
    const committed = await harness.coordinator.execute(harness.prepared);
    expect(committed.result).toEqual(result());
    expect(() => harness.coordinator.assertCommitted(committed)).not.toThrow();
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(1);

    const forgedIdentity = dynamicIdentity();
    if (!forgedIdentity.isDynamicMcp) throw new Error('fixture identity unexpectedly non-dynamic');
    const forgedSubject = { ...forgedIdentity.subject, descriptorRevision: 'forged' };
    const forged = fixture({
      identity: { ...forgedIdentity, subject: forgedSubject },
    });
    await expect(forged.coordinator.execute(forged.prepared)).rejects.toMatchObject({
      code: 'invalid_prepared_input',
    });
    expect(forged.persistenceCalls).toBe(0);
    expect(forged.dispatchCalls).toBe(0);

    const wrapperBindingConfusion = fixture({
      identity: dynamicIdentity(),
      binding: {
        bindingId: 'binding-1',
        capabilityId: 'mcp:dynamic_tool',
        capabilityRevision: 'wrapper-capability-1',
        exposedToolName: 'mcp:dynamic_tool',
        schemaDigest: 'wrapper-schema-1',
        issuedForTurnId: 'turn-1',
      },
    });
    await expect(
      wrapperBindingConfusion.coordinator.execute(wrapperBindingConfusion.prepared),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(wrapperBindingConfusion.persistenceCalls).toBe(0);
    expect(wrapperBindingConfusion.dispatchCalls).toBe(0);

    const wrapperProviderDrift = fixture({
      identity: dynamicIdentity(),
      recordAttempt: (input) =>
        acknowledgement(input, { runtimeWrapperProviderId: 'forged-wrapper-provider' }),
    });
    await expect(
      wrapperProviderDrift.coordinator.execute(wrapperProviderDrift.prepared),
    ).rejects.toMatchObject({ code: 'acknowledgement_failed' });
    expect(wrapperProviderDrift.persistenceCalls).toBe(1);
    expect(wrapperProviderDrift.dispatchCalls).toBe(0);
  });

  test('rejects false, thrown, malformed, and identity-drifted acknowledgements before dispatch', async () => {
    const cases: readonly ((input: Readonly<PreparedToolInvocation>) => unknown)[] = [
      () => false,
      () => {
        throw new Error('private persistence diagnostic');
      },
      () => ({ acknowledged: false }),
      (input) => acknowledgement(input, { schemaDigest: 'drifted' }),
      (input) => acknowledgement(input, { turnId: 'forged-turn' }),
      (input) => acknowledgement(input, { modelMessageId: 'forged-message' }),
      (input) => acknowledgement(input, { argumentOrigin: 'runtime_private' }),
      (input) => acknowledgement(input, { runtimeWrapperProviderId: 'must-be-null' }),
    ];
    for (const recordAttempt of cases) {
      const harness = fixture({ recordAttempt });
      const error = await harness.coordinator
        .execute(harness.prepared)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeHostToolPipelineAttemptCoordinatorError);
      expect((error as RuntimeHostToolPipelineAttemptCoordinatorError).code).toMatch(
        /persistence_unavailable|acknowledgement_failed/,
      );
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(0);
      expect(harness.commitCalls).toBe(0);
    }
  });

  test('claims before await and rejects duplicate attempts without additional calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = fixture({
      dispatch: async () => {
        await gate;
        return result();
      },
    });
    const first = harness.coordinator.execute(harness.prepared);
    await Promise.resolve();
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'duplicate_attempt',
    });
    release();
    const committed = await first;
    expect(committed.result).toEqual(result());
    expect(() => harness.coordinator.assertCommitted(committed)).not.toThrow();
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(1);
    expect(harness.unknownCalls).toBe(0);
  });

  test('records unknown exactly once when dispatch throws and never replays', async () => {
    const harness = fixture({
      dispatch: async () => {
        throw new Error('provider arguments must not escape');
      },
    });
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'unknown_outcome',
    });
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'duplicate_attempt',
    });
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(0);
    expect(harness.unknownCalls).toBe(1);
    expect(harness.unknownInputs[0]).toMatchObject({ code: 'dispatch_failed' });
  });

  test('fails with a distinct bounded code when durable unknown recording fails', async () => {
    const cases = [
      {
        code: 'dispatch_failed' as const,
        dispatch: async () => {
          throw new Error('provider failure must not escape');
        },
      },
      {
        code: 'dispatch_result_invalid' as const,
        dispatch: async () => ({ status: 'success', content: [{ invalid: BigInt(1) }] }),
      },
      {
        code: 'terminal_commit_failed' as const,
        commitTerminal: async () => {
          throw new Error('terminal details must not escape');
        },
      },
    ];

    for (const candidate of cases) {
      const harness = fixture({
        ...(candidate.dispatch ? { dispatch: candidate.dispatch } : {}),
        ...(candidate.commitTerminal ? { commitTerminal: candidate.commitTerminal } : {}),
        recordUnknown: async (input) => {
          expect(input).toMatchObject({ code: candidate.code });
          throw new Error('unknown persistence failure must not escape');
        },
      });
      const error = await harness.coordinator
        .execute(harness.prepared)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeHostToolPipelineAttemptCoordinatorError);
      expect((error as RuntimeHostToolPipelineAttemptCoordinatorError).code).toBe(
        'unknown_persistence_failed',
      );
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.commitCalls).toBe(candidate.code === 'terminal_commit_failed' ? 1 : 0);
      expect(harness.unknownCalls).toBe(1);

      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'duplicate_attempt',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.commitCalls).toBe(candidate.code === 'terminal_commit_failed' ? 1 : 0);
      expect(harness.unknownCalls).toBe(1);
    }
  });

  test('records unknown for invalid terminal and suspended dispatch results', async () => {
    const invalidSuspensions: readonly (() => unknown)[] = [
      () => ({
        ...suspendedOutcome(),
        suspension: { ...planReviewSuspension(), toolCallId: 'other-call' },
      }),
      () => ({
        ...suspendedOutcome(),
        suspension: {
          ...planReviewSuspension(),
          event: { ...planReviewSuspension().event, toolCallId: 'other-call' },
        },
      }),
      () => ({
        ...suspendedOutcome(),
        suspension: {
          ...planReviewSuspension(),
          event: { ...planReviewSuspension().event, type: 'approval.requested' },
        },
      }),
      () => ({
        ...suspendedOutcome(),
        suspension: {
          ...planReviewSuspension(),
          event: { ...planReviewSuspension().event, extra: 'drift' },
        },
      }),
      () => ({
        ...suspendedOutcome(),
        suspension: { ...planReviewSuspension(), kind: 'sibling_cancelled' },
      }),
      () => ({
        ...suspendedOutcome(),
        result: { status: 'success', content: [] },
      }),
    ];

    for (const dispatchResult of [
      async () => ({ status: 'success', content: [{ bad: BigInt(1) }] }),
      ...invalidSuspensions.map((candidate) => async () => candidate()),
    ]) {
      const harness = fixture({ dispatch: dispatchResult });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'unknown_outcome',
      });
      await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
        code: 'duplicate_attempt',
      });
      expect(harness.persistenceCalls).toBe(1);
      expect(harness.dispatchCalls).toBe(1);
      expect(harness.commitCalls).toBe(0);
      expect(harness.suspensionCommitCalls).toBe(0);
      expect(harness.unknownCalls).toBe(1);
      expect(harness.unknownInputs[0]).toMatchObject({ code: 'dispatch_result_invalid' });
    }
  });

  test('rejects optional terminal accessors without executing them or issuing authority', async () => {
    let accessorCalls = 0;
    const terminal = { status: 'success', content: [{ ok: true }] };
    Object.defineProperty(terminal, 'structuredContent', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return { secret: true };
      },
    });
    const harness = fixture({ dispatch: async () => terminal });
    await expect(harness.coordinator.execute(harness.prepared)).rejects.toMatchObject({
      code: 'unknown_outcome',
    });
    expect(accessorCalls).toBe(0);
    expect(harness.commitCalls).toBe(0);
    expect(harness.unknownCalls).toBe(1);
  });

  test('records unknown when terminal commit fails and never returns success', async () => {
    const harness = fixture({
      commitTerminal: async () => {
        throw new Error('receipt details must not escape');
      },
    });
    const error = await harness.coordinator
      .execute(harness.prepared)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeHostToolPipelineAttemptCoordinatorError);
    expect((error as RuntimeHostToolPipelineAttemptCoordinatorError).code).toBe('unknown_outcome');
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(1);
    expect(harness.unknownCalls).toBe(1);
    expect(harness.unknownInputs[0]).toMatchObject({ code: 'terminal_commit_failed' });

    const suspendedHarness = fixture({
      dispatch: async () => suspendedOutcome(),
      commitSuspension: async () => {
        throw new Error('suspension details must not escape');
      },
    });
    await expect(
      suspendedHarness.coordinator.execute(suspendedHarness.prepared),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    await expect(
      suspendedHarness.coordinator.execute(suspendedHarness.prepared),
    ).rejects.toMatchObject({ code: 'duplicate_attempt' });
    expect(suspendedHarness.persistenceCalls).toBe(1);
    expect(suspendedHarness.dispatchCalls).toBe(1);
    expect(suspendedHarness.commitCalls).toBe(0);
    expect(suspendedHarness.suspensionCommitCalls).toBe(1);
    expect(suspendedHarness.unknownCalls).toBe(1);
    expect(suspendedHarness.unknownInputs[0]).toMatchObject({
      code: 'suspension_commit_failed',
    });
  });

  test('does not import Builtin, App, or Core owners', async () => {
    const source = await Bun.file(
      new URL('../src/execution/tool-pipeline-coordinator.ts', import.meta.url),
    ).text();
    for (const forbidden of ['@kite-ai/builtin-runtime', '#app', '@/core', 'src/core']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
