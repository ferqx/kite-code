import { describe, expect, test } from 'bun:test';
import type { ToolApprovalPayload } from '@kite/runtime-contract';
import {
  type CapabilityToolTerminalResult,
  type DynamicMcpPreparedToolInvocationIdentity,
  type DynamicMcpToolTarget,
  type NonDynamicOperationId,
  type NonDynamicPreparedToolInvocationIdentity,
  type PreparedToolInvocationIdentity,
  type PrivateSuspendedSubagentRecord,
  type ResolvedToolTarget,
  type RuntimeJsonValue,
  TOOL_PIPELINE_STAGE_SCHEMA_,
  type ToolPipelineAttemptAcknowledgement,
  type ToolPipelineDispatch,
  type ToolPipelineDispatchOutcome,
  type ToolPipelineGovernanceDynamicMcpProjection,
  type ToolPipelineGovernanceInvocationProjection,
  type ToolPipelineGovernanceNestedSkillProjection,
  type ToolPipelineGovernanceOrdinaryInvocationProjection,
  type ToolPipelineGovernancePolicyProjection,
  type ToolPipelineGovernanceProjection,
  type ToolPipelineOutcomeDispatch,
  type ToolPipelinePersistence,
  type ToolPipelinePlanReviewRequestedEvent,
  type ToolPipelineResolutionContext,
  type ToolPipelineSkillForkApprovalRequestedEvent,
  type ToolPipelineSkillForkAutoReviewRequestedEvent,
  type ToolPipelineSkillForkSuspension,
  type ToolPipelineSkillForkSuspensionEvent,
  type ToolPipelineSuspension,
  type ToolPipelineSuspensionCommit,
  type ToolPipelineSuspensionCommitCallback,
  type ToolPipelineTaskSubagentApprovalRequestedEvent,
  type ToolPipelineTaskSubagentAutoReviewRequestedEvent,
  type ToolPipelineTaskSubagentSuspension,
  type ToolPipelineTaskSubagentSuspensionEvent,
  type ToolRecordedAttemptIdentity,
} from '@kite/runtime-spi';

function dynamicResolvedTarget(): DynamicMcpToolTarget {
  return {
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    operationId: 'mcp:dynamic_tool',
    capabilityId: 'mcp:server:tool',
    capabilityRevision: 'capability-mcp-1',
    descriptorRevision: 'descriptor-mcp-1',
    providerId: 'mcp-provider',
    executorRevision: null,
    toolKind: 'computer',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    isDynamicMcp: true,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'mcp-catalog-8',
    subject: {
      capabilityId: 'mcp:server:tool',
      capabilityRevision: 'capability-mcp-1',
      descriptorRevision: 'descriptor-mcp-1',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__tool',
      dynamicCatalogRevision: 'mcp-catalog-8',
      bindingId: 'binding-mcp-1',
    },
    runtimeWrapper: {
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime-rmv1-11',
      capabilityRevision: 'rmv1-11.mcp.dynamic-tool.v1',
      executorRevision: 'rmv1-11.mcp.dynamic-tool.executor.v1',
      schemaDigest: 'wrapper-schema-mcp-1',
      builtinProjectionRevision: 'builtin-projection-1',
    },
    binding: {
      bindingId: 'binding-mcp-1',
      capabilityId: 'mcp:server:tool',
      capabilityRevision: 'capability-mcp-1',
      exposedToolName: 'mcp__server__tool',
      schemaDigest: 'schema-mcp-1',
      issuedForTurnId: 'turn-1',
    },
    descriptor: {
      capabilityId: 'mcp:server:tool',
      revision: 'capability-mcp-1',
      kind: 'mcp_tool',
      displayName: 'MCP tool',
      description: 'MCP tool',
      provider: { type: 'mcp', id: 'mcp-provider', provenance: 'remote' },
      declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
      effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      availability: 'available',
      diagnostics: [],
    },
  };
}

describe('runtime SPI tool pipeline contract', () => {
  test('keeps the exact stage schema and separate catalog identities', () => {
    expect(TOOL_PIPELINE_STAGE_SCHEMA_).toBe('kite.tool-pipeline-stage.v1');

    const context: ToolPipelineResolutionContext = {
      currentTurnId: 'turn-1',
      availabilityContext: { workspace: '/tmp/workspace' },
      bindings: [],
      descriptors: [],
      builtinProjectionRevision: 'builtin-projection-1',
      dynamicCatalogRevision: 'mcp-catalog-7',
    };
    expect(context.builtinProjectionRevision).not.toBe(context.dynamicCatalogRevision);
    expect(Object.keys(context)).not.toContain('builtinToolCatalog');
    expect(Object.keys(context)).not.toContain('catalog');
  });

  test('projects Kernel governance facts with disjoint dynamic, builtin, and nested identities', () => {
    const builtinRevision = 'b'.repeat(64);
    const dynamicRevision = 'd'.repeat(64);
    const policy: ToolPipelineGovernancePolicyProjection = {
      schema: 'kite.capability-policy-compilation.v1',
      operationId: 'builtin:read_file',
      capabilityRevision: builtinRevision,
      parserRevision: 'p'.repeat(64),
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      risk: 'read',
      reason: 'read is permitted',
      userVisibleSummary: 'Read a file',
      expectedEffects: ['read workspace'],
      effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
      minimumApproval: 'none',
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
      requiresSandbox: true,
    };
    const ordinary: ToolPipelineGovernanceOrdinaryInvocationProjection = {
      turnId: 'turn-1',
      modelMessageId: 'message-1',
      toolCallId: 'call-1',
      argumentOrigin: 'model_public',
      executionFamily: 'builtin',
      executionMechanism: 'filesystem',
      exposedToolName: 'read_file',
      operationId: 'builtin:read_file' as NonDynamicOperationId,
      capabilityId: 'builtin:read_file',
      providerId: 'builtin-runtime',
      capabilityRevision: builtinRevision,
      executorRevision: 'e'.repeat(64),
      descriptorRevision: 'r'.repeat(64),
      parserRevision: policy.parserRevision,
      schemaDigest: 's'.repeat(64),
      argumentsDigest: 'a'.repeat(64),
      effectiveEffectsDigest: 'f'.repeat(64),
      bindingId: null,
      builtinProjectionRevision: builtinRevision,
      dynamicCatalogRevision: null,
      nestedCapabilityId: null,
      nestedCapabilityRevision: null,
      nestedCatalogRevision: null,
      commandDigest: null,
      isDynamicMcp: false,
      visibility: 'model',
      modelVisible: true,
    };
    const dynamic: ToolPipelineGovernanceInvocationProjection = {
      ...ordinary,
      executionFamily: 'mcp',
      executionMechanism: 'mcp',
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:server:tool',
      providerId: 'mcp-provider',
      capabilityRevision: 'c'.repeat(64),
      executorRevision: null,
      descriptorRevision: 'q'.repeat(64),
      exposedToolName: 'mcp__server__tool',
      builtinProjectionRevision: null,
      dynamicCatalogRevision: dynamicRevision,
      isDynamicMcp: true,
      visibility: 'internal',
      modelVisible: false,
      subject: {
        capabilityId: 'mcp:server:tool',
        capabilityRevision: 'c'.repeat(64),
        descriptorRevision: 'q'.repeat(64),
        providerId: 'mcp-provider',
        exposedToolName: 'mcp__server__tool',
        dynamicCatalogRevision: dynamicRevision,
        bindingId: 'binding-mcp-1',
      },
      runtimeWrapper: {
        operationId: 'mcp:dynamic_tool',
        capabilityId: 'mcp:dynamic_tool',
        providerId: 'builtin-runtime-rmv1-11',
        capabilityRevision: 'w'.repeat(64),
        executorRevision: 'x'.repeat(64),
        schemaDigest: 'y'.repeat(64),
        builtinProjectionRevision: builtinRevision,
      },
    };
    const dynamicProjection: ToolPipelineGovernanceDynamicMcpProjection = {
      isDynamicMcp: true,
      subject: dynamic.subject,
      runtimeWrapper: dynamic.runtimeWrapper,
      minimumApproval: 'none',
      readOnly: true,
    };
    const nested: ToolPipelineGovernanceNestedSkillProjection = {
      operationId: 'builtin:activate_skill',
      capabilityId: 'skill:workflow',
      capabilityRevision: 'k'.repeat(64),
      nestedCatalogRevision: dynamicRevision,
      decision: 'ask',
      minimumApproval: 'user',
    };
    const projection: ToolPipelineGovernanceProjection = {
      invocation: ordinary,
      policy,
      effectiveEffects: policy.effectiveEffects,
      effectiveEffectsDigest: ordinary.effectiveEffectsDigest,
      dynamicMcp: null,
      nestedSkill: nested,
    };

    expect(projection.policy.requiresSandbox).toBe(true);
    expect(projection.invocation.builtinProjectionRevision).toBe(builtinRevision);
    expect(projection.invocation.dynamicCatalogRevision).toBeNull();
    expect(projection.invocation.nestedCatalogRevision).toBeNull();
    expect(projection.invocation.commandDigest).toBeNull();
    expect(projection.dynamicMcp).toBeNull();
    expect(projection.nestedSkill?.nestedCatalogRevision).toBe(dynamicRevision);
    expect(dynamic.dynamicCatalogRevision).toBe(dynamic.subject.dynamicCatalogRevision);
    expect(dynamic.operationId).toBe(dynamic.runtimeWrapper.operationId);
    expect(dynamic.capabilityId).toBe(dynamic.subject.capabilityId);
    expect(dynamic.capabilityId).not.toBe(dynamic.runtimeWrapper.capabilityId);
    expect(dynamicProjection.subject).toBe(dynamic.subject);

    // Dynamic MCP cannot be assigned to the ordinary governance branch.
    // @ts-expect-error the dynamic wrapper is not a NonDynamicOperationId.
    const invalidOrdinary: ToolPipelineGovernanceOrdinaryInvocationProjection = dynamic;
    void invalidOrdinary;
  });

  test('expresses internal dynamic MCP identity as non-model-visible', () => {
    const dynamicTarget = dynamicResolvedTarget();
    const target: ResolvedToolTarget = dynamicTarget;
    expect(target.operationId).toBe('mcp:dynamic_tool');
    expect(target.modelVisible).toBe(false);
    expect(target.exposedToolName).toBeNull();
    expect(target.builtinProjectionRevision).toBeNull();
    expect(target.dynamicCatalogRevision).toBe('mcp-catalog-8');
    expect(target.capabilityId).toBe(target.subject.capabilityId);
    expect(target.capabilityRevision).toBe(target.subject.capabilityRevision);
    expect(target.descriptorRevision).toBe(target.subject.descriptorRevision);
    expect(target.providerId).toBe(target.subject.providerId);
    expect(target.dynamicCatalogRevision).toBe(target.subject.dynamicCatalogRevision);
    expect(target.runtimeWrapper.capabilityId).toBe('mcp:dynamic_tool');
    expect(target.runtimeWrapper.builtinProjectionRevision).toBe('builtin-projection-1');

    // @ts-expect-error dynamic MCP must remain internal and non-model-visible.
    const invalidVisibility: ResolvedToolTarget = {
      ...target,
      visibility: 'model',
      modelVisible: true,
      exposedToolName: 'dynamic_tool',
    };
    void invalidVisibility;
    // @ts-expect-error the dynamic wrapper cannot use the non-dynamic branch.
    const invalidOperation: ResolvedToolTarget = {
      ...target,
      operationId: 'mcp:dynamic_tool',
      isDynamicMcp: false,
    };
    void invalidOperation;
    const invalidWrapperCapability = {
      ...dynamicTarget,
      runtimeWrapper: {
        ...dynamicTarget.runtimeWrapper,
        // @ts-expect-error the wrapper cannot impersonate the real MCP subject.
        capabilityId: dynamicTarget.subject.capabilityId,
      },
    } satisfies DynamicMcpToolTarget;
    void invalidWrapperCapability;
    const invalidWrapperProjection = {
      ...dynamicTarget,
      runtimeWrapper: {
        ...dynamicTarget.runtimeWrapper,
        // @ts-expect-error the frozen Builtin wrapper always carries its projection revision.
        builtinProjectionRevision: null,
      },
    } satisfies DynamicMcpToolTarget;
    void invalidWrapperProjection;
  });

  test('keeps terminal result JSON-safe and cloneable', () => {
    const result: CapabilityToolTerminalResult = {
      status: 'error',
      content: [{ type: 'text', text: 'denied' }],
      providerMeta: { provider: 'mcp', retryAfterMs: 1000 },
      failure: {
        code: 'policy_denied',
        message: 'The operation was denied.',
        retryable: false,
        modelFixable: true,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
        details: { reason: 'phase' },
      },
    };
    expect(structuredClone(result)).toEqual(result);
  });

  test('closes suspended dispatch to the exact plan-review interaction event', async () => {
    const event = {
      type: 'plan.review_requested',
      interactionId: 'interaction-plan-1',
      toolCallId: 'call-plan-1',
      taskId: 'task-1',
      plan: {
        kind: 'plan',
        steps: [{ id: 'step-1', title: 'Inspect' }],
      },
      planSummary: 'Inspect the workspace before editing.',
      planId: 'plan-1',
      version: 2,
      structuralDigest: 'plan-digest-1',
      artifact: { kind: 'plan', ref: 'artifact-1' },
    } satisfies ToolPipelinePlanReviewRequestedEvent;
    const suspension: ToolPipelineSuspension = {
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      kind: 'plan_review',
      toolCallId: event.toolCallId,
      event,
    };
    const committed: ToolPipelineDispatchOutcome = {
      kind: 'committed',
      terminal: { status: 'success', content: [] },
    };
    const suspended = {
      kind: 'suspended',
      suspension,
      result: {
        status: 'success',
        content: [],
        structuredContent: {
          schema: 'kite.builtin-operation-result.v1',
          ok: true,
          runtimeEvents: [event],
        },
      },
    } satisfies ToolPipelineDispatchOutcome;
    const acknowledgement: ToolPipelineAttemptAcknowledgement = {
      acknowledged: true,
      attempt: {} as ToolRecordedAttemptIdentity,
    };
    const commit: ToolPipelineSuspensionCommit = {
      acknowledgement,
      suspension,
      result: suspended.result,
    };
    const received: { current: ToolPipelineSuspensionCommit | null } = { current: null };
    const commitSuspension: ToolPipelineSuspensionCommitCallback = async (input) => {
      received.current = input;
    };
    await commitSuspension(commit);

    expect(suspended.kind).toBe('suspended');
    expect(suspended.suspension.toolCallId).toBe(event.toolCallId);
    expect(suspended.suspension.event.type).toBe('plan.review_requested');
    expect(suspended.result.structuredContent).toEqual({
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      runtimeEvents: [event],
    });
    expect(Object.keys(suspended.suspension)).toEqual(['schema', 'kind', 'toolCallId', 'event']);
    expect(Object.keys(suspended.suspension.event)).toEqual([
      'type',
      'interactionId',
      'toolCallId',
      'taskId',
      'plan',
      'planSummary',
      'planId',
      'version',
      'structuralDigest',
      'artifact',
    ]);
    expect(Object.keys(suspended.suspension.event)).not.toContain('state');
    expect(Object.keys(suspended.suspension.event)).not.toContain('store');
    expect(Object.keys(suspended.suspension.event)).not.toContain('terminal');
    expect(Object.keys(suspended.suspension.event)).not.toContain('cancelled');
    expect(structuredClone(suspended)).toEqual(suspended);
    expect(received.current).toBe(commit);
    expect(committed.kind).toBe('committed');

    // A terminal result is not a suspension payload.
    // @ts-expect-error capability terminal results cannot be assigned as suspension.
    const terminalAsSuspension: ToolPipelineSuspension = committed.terminal;
    void terminalAsSuspension;
    const approvalSuspension: ToolPipelineSuspension = {
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      // @ts-expect-error approval is not an admitted suspension kind.
      kind: 'approval',
      toolCallId: 'call-approval-1',
      event,
    };
    void approvalSuspension;
    const userInputSuspension: ToolPipelineSuspension = {
      ...suspension,
      // @ts-expect-error user-input events cannot enter the plan-review suspension.
      event: { ...event, type: 'user_input.answered' },
    };
    void userInputSuspension;
    const cancelledSuspension: ToolPipelineDispatchOutcome = {
      kind: 'suspended',
      suspension: {
        ...suspension,
        // @ts-expect-error sibling cancellation is not a dispatch suspension result.
        kind: 'sibling_cancelled',
      },
      result: suspended.result,
    };
    void cancelledSuspension;

    const failedSuspension: ToolPipelineDispatchOutcome = {
      kind: 'suspended',
      suspension,
      result: {
        // @ts-expect-error suspended execution evidence must be confirmed success.
        status: 'error',
        content: [],
        structuredContent: {},
      },
    };
    void failedSuspension;
  });

  test('closes Skill fork suspension to artifact and exact approval/auto-review facts', async () => {
    const subagent: PrivateSuspendedSubagentRecord = {
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
      parentInvocationId: 'invocation-skill-1',
      parentAttempt: 1,
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'child-call-1',
        runtimeToolCallId: 'runtime-child-call-1',
        toolName: 'shell_execute',
      },
    };
    const approval: ToolApprovalPayload = {
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
    const approvalEvent: ToolPipelineSkillForkApprovalRequestedEvent<'skill-call-1'> = {
      type: 'approval.requested',
      interactionId: 'interaction-skill-1',
      toolCallId: 'skill-call-1',
      approval,
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    const autoReviewEvent: ToolPipelineSkillForkAutoReviewRequestedEvent<'skill-call-1'> = {
      type: 'auto_review.requested',
      reviewId: 'review-skill-1',
      toolCallId: 'skill-call-1',
      toolName: 'shell_execute',
      reason: 'The child tool requires an auto review.',
      approval,
      requestFingerprint: 'request-fingerprint-1',
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    const suspension: ToolPipelineSkillForkSuspension<'skill-call-1'> = {
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      kind: 'skill_fork',
      operationId: 'builtin:activate_skill',
      toolCallId: 'skill-call-1',
      parent: {
        toolCallId: 'skill-call-1',
        invocationId: 'invocation-skill-1',
        attemptId: 'invocation-skill-1:attempt:1',
        attempt: 1,
      },
      activation: {
        activationId: 'activation-1',
        skillId: 'skill:fixture',
        skillRevision: 'skill-revision-1',
        taskId: 'task-1',
        contextMode: 'fork',
      },
      subagent,
      blockedTool: {
        toolCallId: 'child-call-1',
        runtimeToolCallId: 'runtime-child-call-1',
        toolName: 'shell_execute',
        argumentsDigest: 'arguments-digest-1',
        commandDigest: 'command-digest-1',
      },
      event: approvalEvent,
    };
    const suspended = {
      kind: 'suspended',
      suspension,
      result: {
        status: 'success',
        content: [],
        structuredContent: {
          schema: 'kite.builtin-operation-result.v1',
          ok: true,
          runtimeEvents: [approvalEvent as unknown as RuntimeJsonValue],
        },
      },
    } satisfies ToolPipelineDispatchOutcome;
    const acknowledgement: ToolPipelineAttemptAcknowledgement = {
      acknowledged: true,
      attempt: {} as ToolRecordedAttemptIdentity,
    };
    const commit: ToolPipelineSuspensionCommit = {
      acknowledgement,
      suspension,
      result: suspended.result,
    };
    const received: { current: ToolPipelineSuspensionCommit | null } = { current: null };
    const commitSuspension: ToolPipelineSuspensionCommitCallback = async (input) => {
      received.current = input;
    };
    await commitSuspension(commit);

    expect(suspended.kind).toBe('suspended');
    expect(suspended.suspension.operationId).toBe('builtin:activate_skill');
    expect(suspended.suspension.parent.toolCallId).toBe(suspended.suspension.toolCallId);
    expect(suspended.suspension.subagent.continuationArtifact.kind).toBe('subagent_continuation');
    expect(suspended.suspension.event.type).toBe('approval.requested');
    expect(suspended.suspension.event.approval.approvalHash).toBe(approval.approvalHash);
    expect(suspended.suspension.event.approval.callId).toBe(
      suspended.suspension.blockedTool.toolCallId,
    );
    expect(autoReviewEvent.type).toBe('auto_review.requested');
    expect(autoReviewEvent.approval.approvalHash).toBe(approval.approvalHash);
    expect(autoReviewEvent.toolName).toBe(suspended.suspension.blockedTool.toolName);
    expect(Object.keys(approvalEvent)).toEqual([
      'type',
      'interactionId',
      'toolCallId',
      'approval',
      'createdAt',
    ]);
    expect(Object.keys(autoReviewEvent)).toEqual([
      'type',
      'reviewId',
      'toolCallId',
      'toolName',
      'reason',
      'approval',
      'requestFingerprint',
      'createdAt',
    ]);
    expect(suspended.suspension.blockedTool.toolCallId).toBe(
      suspended.suspension.subagent.blockedTool.toolCallId,
    );
    expect(suspended.suspension.blockedTool.runtimeToolCallId ?? null).toBe(
      suspended.suspension.subagent.blockedTool.runtimeToolCallId ?? null,
    );
    expect(suspended.suspension.blockedTool.toolName).toBe(
      suspended.suspension.subagent.blockedTool.toolName,
    );
    expect(suspended.suspension.subagent.blockedTool.reasonCode).toBe(
      'SUBAGENT_TOOL_REQUIRES_APPROVAL',
    );
    expect(suspended.suspension.blockedTool.argumentsDigest).toBe('arguments-digest-1');
    expect(suspended.suspension.blockedTool.commandDigest).toBe('command-digest-1');
    expect(Object.keys(suspended.suspension)).toEqual([
      'schema',
      'kind',
      'operationId',
      'toolCallId',
      'parent',
      'activation',
      'subagent',
      'blockedTool',
      'event',
    ]);
    expect(Object.keys(suspended.suspension.subagent)).not.toContain('continuation');
    expect(Object.keys(suspended.suspension.subagent)).not.toContain('state');
    expect(Object.keys(suspended.suspension.subagent)).not.toContain('store');
    expect(Object.keys(suspended.suspension.subagent)).not.toContain('callback');
    expect(Object.keys(suspended.suspension.subagent)).not.toContain('registry');
    expect(structuredClone(suspended)).toEqual(suspended);
    expect(received.current).toBe(commit);

    const wrongParentEvent: ToolPipelineSkillForkApprovalRequestedEvent<'skill-call-1'> = {
      ...approvalEvent,
      // @ts-expect-error the event parent identity is branded by the suspension toolCallId.
      toolCallId: 'different-parent',
    };
    void wrongParentEvent;
    const missingApproval: ToolPipelineSkillForkApprovalRequestedEvent<'skill-call-1'> = {
      ...approvalEvent,
      // @ts-expect-error State approval.requested always carries its approval payload.
      approval: undefined,
    };
    void missingApproval;
    const malformedApprovalEvent: ToolPipelineSkillForkApprovalRequestedEvent<'skill-call-1'> = {
      ...approvalEvent,
      // @ts-expect-error non-State blockedToolCallId must not replace approval.approvalHash.
      blockedToolCallId: 'child-call-1',
    };
    void malformedApprovalEvent;
    const missingAutoReviewApproval: ToolPipelineSkillForkSuspensionEvent<'skill-call-1'> = {
      type: 'auto_review.requested',
      reviewId: 'review-skill-2',
      toolCallId: 'skill-call-1',
      toolName: 'shell_execute',
      reason: 'The child tool requires an auto review.',
      // @ts-expect-error State auto_review.requested always carries its approval payload.
      approval: undefined,
    };
    void missingAutoReviewApproval;
    const wrongOperation: ToolPipelineSkillForkSuspension<'skill-call-1'> = {
      ...suspension,
      // @ts-expect-error Skill suspension cannot impersonate plan or another operation.
      operationId: 'builtin:write_plan',
    };
    void wrongOperation;
    const planAsSkill: ToolPipelineSkillForkSuspensionEvent<'skill-call-1'> = {
      // @ts-expect-error plan review is a separate closed suspension branch.
      type: 'plan.review_requested',
    };
    void planAsSkill;
    const missingArtifact: PrivateSuspendedSubagentRecord = {
      ...subagent,
      // @ts-expect-error a skill suspension must retain an opaque continuation artifact reference.
      continuationArtifact: undefined,
    };
    void missingArtifact;
    const liveArtifactHandle: PrivateSuspendedSubagentRecord = {
      ...subagent,
      continuationArtifact: {
        ...subagent.continuationArtifact,
        // @ts-expect-error SPI artifact references cannot carry a live callback.
        read: () => structuredClone(subagent),
      },
    };
    void liveArtifactHandle;
    const liveContinuation: ToolPipelineSkillForkSuspension<'skill-call-1'> = {
      ...suspension,
      // @ts-expect-error continuation bytes/content are not part of the neutral suspension.
      continuation: {},
    };
    void liveContinuation;
  });

  test('keeps task subagent suspension distinct from Skill fork', () => {
    const subagent: PrivateSuspendedSubagentRecord = {
      storage: 'private_artifact_v1',
      subagentId: 'task-child-1',
      role: 'code',
      continuationId: 'task-continuation-1',
      modelInvocationOrdinal: 4,
      continuationArtifact: {
        artifactId: 'task-artifact-1',
        kind: 'subagent_continuation',
        integrityIdentifier: 'sha256:task-continuation-1',
        byteLength: 640,
      },
      parentInvocationId: 'invocation-task-1',
      parentAttempt: 2,
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
        toolCallId: 'task-child-call-1',
        runtimeToolCallId: 'runtime-task-child-call-1',
        toolName: 'write_file',
      },
    };
    const approval: ToolApprovalPayload = {
      scope: 'once',
      callId: 'task-child-call-1',
      cwd: '/workspace',
      threadId: 'thread-task-1',
      tool: 'write_file',
      command: 'write child file',
      risk: 'write_file',
      approvalHash: 'task-approval-binding-1',
      summary: 'The task child write requires approval.',
      reason: 'The task child write requires auto review.',
      expectedEffects: ['child file update'],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    };
    const approvalEvent: ToolPipelineTaskSubagentApprovalRequestedEvent<'task-call-1'> = {
      type: 'approval.requested',
      interactionId: 'interaction-task-1',
      toolCallId: 'task-call-1',
      approval,
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    const autoReviewEvent: ToolPipelineTaskSubagentAutoReviewRequestedEvent<'task-call-1'> = {
      type: 'auto_review.requested',
      reviewId: 'review-task-1',
      toolCallId: 'task-call-1',
      toolName: 'write_file',
      reason: 'The task child write requires auto review.',
      approval,
      requestFingerprint: 'task-request-fingerprint-1',
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    const suspension: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      kind: 'task_subagent',
      operationId: 'builtin:task',
      executionMode: 'resume',
      toolCallId: 'task-call-1',
      parent: {
        toolCallId: 'task-call-1',
        invocationId: 'invocation-task-1',
        attemptId: 'invocation-task-1:attempt:2',
        attempt: 2,
      },
      subagent,
      blockedTool: {
        toolCallId: 'task-child-call-1',
        runtimeToolCallId: 'runtime-task-child-call-1',
        toolName: 'write_file',
        argumentsDigest: 'task-arguments-digest-1',
        commandDigest: null,
      },
      event: autoReviewEvent,
    };
    const suspended = {
      kind: 'suspended',
      suspension,
      result: {
        status: 'success',
        content: [],
        structuredContent: {
          schema: 'kite.builtin-operation-result.v1',
          ok: true,
          runtimeEvents: [autoReviewEvent as unknown as RuntimeJsonValue],
        },
      },
    } satisfies ToolPipelineDispatchOutcome;
    const union: ToolPipelineSuspension = suspension;

    expect(union.kind).toBe('task_subagent');
    expect(suspension.operationId).toBe('builtin:task');
    expect(suspension.executionMode).toBe('resume');
    expect(suspension.parent.toolCallId).toBe(suspension.toolCallId);
    expect(suspension.parent.attemptId).toBe('invocation-task-1:attempt:2');
    expect(suspension.subagent.parentInvocationId).toBe(suspension.parent.invocationId);
    expect(suspension.subagent.parentAttempt).toBe(suspension.parent.attempt);
    expect(suspension.blockedTool.runtimeToolCallId).toBe(
      suspension.subagent.blockedTool.runtimeToolCallId ?? null,
    );
    expect(suspension.event.type).toBe('auto_review.requested');
    expect(suspension.event.approval.approvalHash).toBe(approval.approvalHash);
    expect(Object.keys(suspension)).toEqual([
      'schema',
      'kind',
      'operationId',
      'executionMode',
      'toolCallId',
      'parent',
      'subagent',
      'blockedTool',
      'event',
    ]);
    expect(Object.keys(suspension.subagent)).not.toContain('continuation');
    expect(Object.keys(suspension.subagent)).not.toContain('state');
    expect(Object.keys(suspension.subagent)).not.toContain('store');
    expect(Object.keys(suspension.subagent)).not.toContain('callback');
    expect(Object.keys(suspension.subagent)).not.toContain('registry');
    expect(structuredClone(suspended)).toEqual(suspended);

    const approvalSuspension: ToolPipelineTaskSubagentSuspensionEvent<'task-call-1'> =
      approvalEvent;
    expect(approvalSuspension.type).toBe('approval.requested');

    const wrongTaskKind: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      // @ts-expect-error task suspension cannot impersonate the Skill fork branch.
      kind: 'skill_fork',
    };
    void wrongTaskKind;
    const wrongTaskOperation: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      // @ts-expect-error task suspension is fixed to builtin:task.
      operationId: 'builtin:activate_skill',
    };
    void wrongTaskOperation;
    const wrongExecutionMode: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      // @ts-expect-error task execution mode is the closed start/resume set.
      executionMode: 'restart',
    };
    void wrongExecutionMode;
    const missingParent: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      // @ts-expect-error parent identity is required for every task suspension.
      parent: undefined,
    };
    void missingParent;
    const missingPrivateRecord: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      // @ts-expect-error private suspended record is required for task resume.
      subagent: undefined,
    };
    void missingPrivateRecord;
    const missingBlockedParentIdentity: ToolPipelineTaskSubagentSuspension<'task-call-1'> = {
      ...suspension,
      parent: {
        ...suspension.parent,
        // @ts-expect-error parent toolCallId cannot be omitted.
        toolCallId: undefined,
      },
    };
    void missingBlockedParentIdentity;
    const skillAsTask: ToolPipelineSkillForkSuspension<'skill-call-1'> = {
      ...({} as ToolPipelineSkillForkSuspension<'skill-call-1'>),
      // @ts-expect-error Skill fork cannot use the task suspension kind.
      kind: 'task_subagent',
    };
    void skillAsTask;
    const taskAsSkillOperation: ToolPipelineSkillForkSuspension<'skill-call-1'> = {
      ...({} as ToolPipelineSkillForkSuspension<'skill-call-1'>),
      // @ts-expect-error Skill fork operation remains builtin:activate_skill.
      operationId: 'builtin:task',
    };
    void taskAsSkillOperation;
  });

  test('keeps prepared identity/input and callback ports neutral', async () => {
    const identity: NonDynamicPreparedToolInvocationIdentity = {
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      toolCallId: 'call-1',
      turnId: 'turn-1',
      modelMessageId: 'message-1',
      argumentOrigin: 'model_public',
      providerId: 'builtin-provider',
      operationId: 'builtin:read_file' as NonDynamicOperationId,
      executionFamily: 'builtin',
      capabilityId: 'builtin:read_file',
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
      executionMechanism: 'filesystem',
      bindingId: null,
      visibility: 'model',
      modelVisible: true,
      exposedToolName: 'read_file',
      builtinProjectionRevision: 'builtin-projection-1',
      dynamicCatalogRevision: null,
      nestedCapabilityId: null,
      nestedCapabilityRevision: null,
      nestedCatalogRevision: null,
      isDynamicMcp: false,
      toolKind: 'computer',
    };
    // @ts-expect-error prepared identity cannot mark the dynamic wrapper as non-dynamic.
    const invalidPreparedIdentity: PreparedToolInvocationIdentity = {
      ...identity,
      operationId: 'mcp:dynamic_tool',
      isDynamicMcp: false,
    };
    void invalidPreparedIdentity;
    // `mcp` is a legal mechanism for a model-visible Builtin operation; the
    // ordinary branch is separated by visibility and operation identity.
    const builtinMcpIdentity: NonDynamicPreparedToolInvocationIdentity = {
      ...identity,
      executionMechanism: 'mcp',
    };
    expect(builtinMcpIdentity.executionMechanism).toBe('mcp');
    const invalidInternalIdentity: NonDynamicPreparedToolInvocationIdentity = {
      ...identity,
      // @ts-expect-error an internal/non-model identity cannot enter the ordinary branch.
      visibility: 'internal',
      // @ts-expect-error an internal/non-model identity cannot enter the ordinary branch.
      modelVisible: false,
      // @ts-expect-error an internal/non-model identity cannot enter the ordinary branch.
      exposedToolName: null,
    };
    void invalidInternalIdentity;
    const runtimePrivateIdentity: NonDynamicPreparedToolInvocationIdentity = {
      ...identity,
      argumentOrigin: 'runtime_private',
    };
    expect(runtimePrivateIdentity.argumentOrigin).toBe('runtime_private');
    const attempt: ToolRecordedAttemptIdentity = {
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      attempt: 1,
      toolCallId: 'call-1',
      turnId: 'turn-1',
      modelMessageId: 'message-1',
      argumentOrigin: 'model_public',
      providerId: 'builtin-provider',
      operationId: 'builtin:read_file',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'capability-1',
      descriptorRevision: 'descriptor-1',
      parserRevision: 'parser-1',
      executorRevision: 'executor-1',
      argumentsDigest: 'arguments-1',
      schemaDigest: 'schema-1',
      effectiveEffectsDigest: 'effects-1',
      builtinProjectionRevision: 'builtin-projection-1',
      dynamicCatalogRevision: null,
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      policyDigest: 'policy-1',
      authorizationDigest: 'authorization-1',
      admissionDigest: 'admission-1',
      idempotencyKey: null,
      recordedAt: '2026-08-21T00:00:00.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
    };
    const prepared = {
      identity,
      input: {
        invocationId: identity.invocationId,
        attemptId: identity.attemptId,
        toolCallId: identity.toolCallId,
        arguments: { path: 'README.md' },
        binding: null,
      },
    } as const;
    const acknowledgement: ToolPipelineAttemptAcknowledgement = {
      acknowledged: true,
      attempt,
    };
    const unknownCodes: string[] = [];
    const persistence: ToolPipelinePersistence = {
      recordAttempt: async (received) => {
        expect(received).toBe(prepared);
        return acknowledgement;
      },
      recordUnknown: async (received) => {
        expect(received.acknowledgement).toBe(acknowledgement);
        unknownCodes.push(received.code);
      },
      commitTerminal: async (received) => {
        expect(received.acknowledgement).toBe(acknowledgement);
        expect(received.result.status).toBe('success');
      },
      commitRetryable: async (received) => {
        expect(received.acknowledgement).toBe(acknowledgement);
        expect(received.replaySafety).toBe('safe_read');
        expect(received.result).toMatchObject({
          status: 'error',
          failure: { code: 'provider_unavailable', retryable: true },
        });
      },
      commitSuspension: async () => {},
    };
    const dispatch: ToolPipelineDispatch = {
      verifyPreparedIdentity: (prepared) => {
        expect(prepared.identity).toBe(identity);
        return true;
      },
      dispatch: async (input) => {
        expect(input.input.toolCallId).toBe('call-1');
        return { status: 'success', content: [] };
      },
    };
    const outcomeDispatch: ToolPipelineOutcomeDispatch = {
      verifyPreparedIdentity: dispatch.verifyPreparedIdentity,
      dispatch: async (input) => ({
        kind: 'committed',
        terminal: await dispatch.dispatch(input),
      }),
    };
    expect(identity.dynamicCatalogRevision).toBeNull();
    await expect(persistence.recordAttempt(prepared)).resolves.toBe(acknowledgement);
    expect(dispatch.verifyPreparedIdentity(prepared)).toBe(true);
    await dispatch.dispatch(prepared);
    await expect(outcomeDispatch.dispatch(prepared)).resolves.toMatchObject({
      kind: 'committed',
      terminal: { status: 'success' },
    });
    await persistence.recordUnknown({
      acknowledgement,
      code: 'dispatch_failed',
    });
    await persistence.recordUnknown({
      acknowledgement,
      code: 'retryable_commit_failed',
    });
    await persistence.recordUnknown({
      acknowledgement,
      code: 'terminal_commit_failed',
    });
    expect(unknownCodes).toEqual([
      'dispatch_failed',
      'retryable_commit_failed',
      'terminal_commit_failed',
    ]);
    await persistence.commitRetryable?.({
      acknowledgement,
      replaySafety: 'safe_read',
      result: {
        status: 'error',
        content: [],
        failure: {
          code: 'provider_unavailable',
          message: 'provider unavailable',
          retryable: true,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
      },
    });
    await persistence.commitTerminal({
      acknowledgement,
      result: { status: 'success', content: [] },
    });
  });

  test('keeps the MCP subject and internal wrapper identities disjoint', () => {
    const dynamicIdentity: DynamicMcpPreparedToolInvocationIdentity = {
      invocationId: 'invocation-mcp-1',
      attemptId: 'attempt-mcp-1',
      toolCallId: 'call-mcp-1',
      turnId: 'turn-mcp-1',
      modelMessageId: 'message-mcp-1',
      argumentOrigin: 'model_public',
      providerId: 'mcp-provider',
      operationId: 'mcp:dynamic_tool',
      executionFamily: 'mcp',
      capabilityId: 'mcp:server:tool',
      capabilityRevision: 'capability-mcp-1',
      descriptorRevision: 'descriptor-mcp-1',
      parserRevision: 'parser-mcp-1',
      executorRevision: null,
      argumentsDigest: 'arguments-mcp-1',
      schemaDigest: 'schema-mcp-1',
      effectiveEffectsDigest: 'effects-mcp-1',
      policyDigest: null,
      authorizationDigest: null,
      admissionDigest: null,
      idempotencyKeyArgument: null,
      idempotencyKey: null,
      bindingId: 'binding-mcp-1',
      executionMechanism: 'mcp',
      visibility: 'internal',
      modelVisible: false,
      exposedToolName: null,
      isDynamicMcp: true,
      builtinProjectionRevision: null,
      dynamicCatalogRevision: 'mcp-catalog-8',
      subject: {
        capabilityId: 'mcp:server:tool',
        capabilityRevision: 'capability-mcp-1',
        descriptorRevision: 'descriptor-mcp-1',
        providerId: 'mcp-provider',
        exposedToolName: 'mcp__server__tool',
        dynamicCatalogRevision: 'mcp-catalog-8',
        bindingId: 'binding-mcp-1',
      },
      runtimeWrapper: {
        operationId: 'mcp:dynamic_tool',
        capabilityId: 'mcp:dynamic_tool',
        providerId: 'builtin-runtime-rmv1-11',
        capabilityRevision: 'rmv1-11.mcp.dynamic-tool.v1',
        executorRevision: 'rmv1-11.mcp.dynamic-tool.executor.v1',
        schemaDigest: 'wrapper-schema-mcp-1',
        builtinProjectionRevision: 'builtin-projection-1',
      },
    };
    const resolved = dynamicResolvedTarget();
    expect(dynamicIdentity.exposedToolName).toBeNull();
    expect(dynamicIdentity.subject.exposedToolName).toBe('mcp__server__tool');
    expect(dynamicIdentity.subject.dynamicCatalogRevision).toBe('mcp-catalog-8');
    expect(dynamicIdentity.runtimeWrapper.operationId).toBe('mcp:dynamic_tool');
    expect(dynamicIdentity.executorRevision).toBeNull();
    expect(dynamicIdentity.capabilityId).toBe(resolved.subject.capabilityId);
    expect(dynamicIdentity.capabilityRevision).toBe(resolved.subject.capabilityRevision);
    expect(dynamicIdentity.descriptorRevision).toBe(resolved.subject.descriptorRevision);
    expect(dynamicIdentity.providerId).toBe(resolved.subject.providerId);
    expect(dynamicIdentity.subject).toEqual(resolved.subject);
    expect(dynamicIdentity.runtimeWrapper).toEqual(resolved.runtimeWrapper);
    expect(structuredClone(dynamicIdentity)).toEqual(dynamicIdentity);
    const invalidDynamicOrigin = {
      ...dynamicIdentity,
      // @ts-expect-error dynamic MCP can only originate from a model-visible call.
      argumentOrigin: 'runtime_private',
    } satisfies DynamicMcpPreparedToolInvocationIdentity;
    void invalidDynamicOrigin;

    const dynamicAttempt: ToolRecordedAttemptIdentity = {
      invocationId: dynamicIdentity.invocationId,
      attemptId: dynamicIdentity.attemptId,
      attempt: 1,
      toolCallId: dynamicIdentity.toolCallId,
      turnId: dynamicIdentity.turnId,
      modelMessageId: dynamicIdentity.modelMessageId,
      argumentOrigin: dynamicIdentity.argumentOrigin,
      providerId: dynamicIdentity.providerId,
      operationId: dynamicIdentity.operationId,
      capabilityId: dynamicIdentity.capabilityId,
      capabilityRevision: dynamicIdentity.capabilityRevision,
      descriptorRevision: dynamicIdentity.descriptorRevision,
      parserRevision: dynamicIdentity.parserRevision,
      executorRevision: dynamicIdentity.executorRevision,
      argumentsDigest: dynamicIdentity.argumentsDigest,
      schemaDigest: dynamicIdentity.schemaDigest,
      effectiveEffectsDigest: dynamicIdentity.effectiveEffectsDigest,
      builtinProjectionRevision: dynamicIdentity.builtinProjectionRevision,
      dynamicCatalogRevision: dynamicIdentity.dynamicCatalogRevision,
      runtimeWrapperProviderId: dynamicIdentity.runtimeWrapper.providerId,
      runtimeWrapperCapabilityRevision: dynamicIdentity.runtimeWrapper.capabilityRevision,
      runtimeWrapperExecutorRevision: dynamicIdentity.runtimeWrapper.executorRevision,
      runtimeWrapperSchemaDigest: dynamicIdentity.runtimeWrapper.schemaDigest,
      runtimeWrapperBuiltinProjectionRevision:
        dynamicIdentity.runtimeWrapper.builtinProjectionRevision,
      policyDigest: dynamicIdentity.policyDigest,
      authorizationDigest: dynamicIdentity.authorizationDigest,
      admissionDigest: dynamicIdentity.admissionDigest,
      idempotencyKey: dynamicIdentity.idempotencyKey,
      recordedAt: '2026-08-21T00:00:00.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
    };
    expect(dynamicAttempt.executorRevision).toBeNull();
    expect(dynamicAttempt.runtimeWrapperProviderId).toBe(dynamicIdentity.runtimeWrapper.providerId);
    expect(dynamicAttempt.runtimeWrapperProviderId).not.toBe(dynamicIdentity.subject.providerId);
    expect(dynamicAttempt.runtimeWrapperExecutorRevision).toBe(
      dynamicIdentity.runtimeWrapper.executorRevision,
    );
    expect(dynamicAttempt.runtimeWrapperBuiltinProjectionRevision).toBe(
      dynamicIdentity.runtimeWrapper.builtinProjectionRevision,
    );

    const mixedWrapper = {
      ...dynamicIdentity,
      runtimeWrapper: {
        ...dynamicIdentity.runtimeWrapper,
        // @ts-expect-error the wrapper operation is an exact internal literal.
        operationId: 'mcp__server__tool',
      },
    } satisfies DynamicMcpPreparedToolInvocationIdentity;
    void mixedWrapper;
    const mixedSubject = {
      ...dynamicIdentity,
      subject: {
        ...dynamicIdentity.subject,
        // @ts-expect-error the subject must carry a model-facing mcp__ name, not the wrapper literal.
        exposedToolName: 'mcp:dynamic_tool',
      },
    } satisfies DynamicMcpPreparedToolInvocationIdentity;
    void mixedSubject;
  });

  test('requires authoritative acknowledgement, unknown, and terminal ports', () => {
    const acknowledgement: ToolPipelineAttemptAcknowledgement = {
      acknowledged: true,
      attempt: {} as ToolRecordedAttemptIdentity,
    };
    // @ts-expect-error persistence cannot omit the required post-ack ports.
    const incompletePersistence: ToolPipelinePersistence = {
      recordAttempt: async () => acknowledgement,
    };
    void incompletePersistence;
  });

  test('does not import package authorities or app aliases', async () => {
    const source = await Bun.file(new URL('../src/tool-pipeline.ts', import.meta.url)).text();
    for (const forbidden of [
      '@kite/runtime-host',
      '@kite/agent-kernel',
      '@kite/builtin-runtime',
      '#app',
      '@/core',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
