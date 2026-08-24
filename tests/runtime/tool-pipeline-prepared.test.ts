import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinRuntimeToolPipelineCallbacks,
  createBuiltinToolCatalogProjection,
  createCapabilityBinding,
  digestCapabilityBindingValue,
} from '@kite/builtin-runtime';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import {
  createRuntimeHostStateToolGovernance,
  runtimeHostStateCreateApprovalBindingDigest,
} from '@kite/runtime-host/kernel-adapter';
import type {
  CapabilityEffects,
  CapabilityPolicyEffects,
  ClassifiedInvocation,
  DynamicMcpSubjectIdentity,
  DynamicMcpToolTarget,
  NonDynamicOperationId,
  NonDynamicToolTarget,
  ToolCallSnapshot,
  ToolPipelineCapabilityBinding,
  ToolPipelineGovernanceProjection,
  ToolPipelineResolutionContext,
} from '@kite/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
  type AppPreparedToolInvocationBuild,
  type AppPreparedToolInvocationBuilderInput,
  type AppToolPipelineGovernanceDecision,
  type AppToolPipelineGovernanceFacts,
  createAppPreparedToolInvocation,
} from '#app/bootstrap/runtime/tool-pipeline-prepared';

const EFFECTS: CapabilityEffects = Object.freeze({
  filesystem: 'write',
  network: 'none',
  externalState: 'none',
});
const EFFECTS_DIGEST = digestCapabilityValue(EFFECTS);
const CAPABILITY_REVISION = 'capability-revision-1';
const DESCRIPTOR_REVISION = 'descriptor-revision-1';
const PARSER_REVISION = 'parser-revision-1';
const EXECUTOR_REVISION = 'executor-revision-1';
const SCHEMA_DIGEST = 'schema-digest-1';
const BUILTIN_REVISION = 'builtin-projection-revision-1';
const DYNAMIC_REVISION = 'dynamic-catalog-revision-1';

type Arguments = Record<string, string>;
type Fixture = {
  readonly input: AppPreparedToolInvocationBuilderInput<Arguments>;
  readonly originalArguments: Arguments;
  readonly target: Readonly<DynamicMcpToolTarget | NonDynamicToolTarget>;
};

function fixture(
  options: {
    readonly dynamic?: boolean;
    readonly idempotency?: boolean;
    readonly policyEffects?: Readonly<CapabilityPolicyEffects>;
  } = {},
): Fixture {
  const dynamic = options.dynamic === true;
  const idempotency = options.idempotency === true;
  const policyEffects = options.policyEffects ?? {};
  const operationId = 'builtin:write_file' as NonDynamicOperationId;
  const capabilityId = dynamic ? 'mcp:server/write_file' : 'builtin:write_file';
  const exposedToolName = dynamic ? 'mcp__server__write_file' : 'write_file';
  const originalArguments: Arguments = dynamic ? { query: 'hello' } : { path: 'README.md' };
  const binding: ToolPipelineCapabilityBinding | null = dynamic
    ? {
        bindingId: 'subject-binding-1',
        capabilityId,
        capabilityRevision: CAPABILITY_REVISION,
        exposedToolName,
        schemaDigest: SCHEMA_DIGEST,
        issuedForTurnId: 'turn-1',
      }
    : null;
  const subject: DynamicMcpSubjectIdentity = {
    capabilityId,
    capabilityRevision: CAPABILITY_REVISION,
    descriptorRevision: DESCRIPTOR_REVISION,
    providerId: 'mcp-provider',
    exposedToolName: 'mcp__server__write_file',
    dynamicCatalogRevision: DYNAMIC_REVISION,
    bindingId: binding?.bindingId ?? null,
  };
  const runtimeWrapper = {
    operationId: 'mcp:dynamic_tool' as const,
    capabilityId: 'mcp:dynamic_tool',
    providerId: 'builtin-runtime',
    capabilityRevision: 'wrapper-capability-revision-1',
    executorRevision: 'wrapper-executor-revision-1',
    schemaDigest: 'wrapper-schema-digest-1',
    builtinProjectionRevision: BUILTIN_REVISION,
  } as const;
  const descriptor = {
    capabilityId,
    revision: DESCRIPTOR_REVISION,
    kind: dynamic ? 'mcp_tool' : 'builtin_tool',
    displayName: exposedToolName,
    description: 'fixture',
    provider: {
      type: dynamic ? 'mcp' : 'builtin',
      id: dynamic ? 'mcp-provider' : 'builtin-runtime',
      provenance: dynamic ? 'remote' : 'builtin',
    },
    declaredEffects: EFFECTS,
    effectiveEffects: EFFECTS,
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    availability: 'available',
    diagnostics: [],
  } as const;
  const target = (dynamic
    ? {
        executionFamily: 'mcp' as const,
        executionMechanism: 'mcp' as const,
        operationId: 'mcp:dynamic_tool' as const,
        visibility: 'internal' as const,
        modelVisible: false as const,
        exposedToolName: null,
        isDynamicMcp: true as const,
        builtinProjectionRevision: null,
        dynamicCatalogRevision: DYNAMIC_REVISION,
        capabilityId,
        capabilityRevision: CAPABILITY_REVISION,
        descriptorRevision: DESCRIPTOR_REVISION,
        providerId: 'mcp-provider',
        executorRevision: null,
        toolKind: 'computer' as const,
        binding,
        descriptor,
        subject,
        runtimeWrapper,
      }
    : {
        executionFamily: 'builtin' as const,
        executionMechanism: 'filesystem' as const,
        operationId,
        visibility: 'model' as const,
        modelVisible: true as const,
        exposedToolName,
        isDynamicMcp: false as const,
        builtinProjectionRevision: BUILTIN_REVISION,
        dynamicCatalogRevision: null,
        capabilityId,
        capabilityRevision: CAPABILITY_REVISION,
        descriptorRevision: DESCRIPTOR_REVISION,
        providerId: 'builtin-runtime',
        executorRevision: EXECUTOR_REVISION,
        toolKind: 'computer' as const,
        binding,
        descriptor,
      }) as unknown as DynamicMcpToolTarget | NonDynamicToolTarget;
  const call = {
    schema: 'kite.tool-pipeline-stage.v1' as const,
    stage: 'snapshot' as const,
    toolCallId: 'call-1',
    name: exposedToolName,
    rawArguments: originalArguments,
    argumentOrigin: 'model_public' as const,
    createdAtTurnId: 'turn-1',
    modelMessageId: 'message-1',
    bindingId: binding?.bindingId ?? null,
    capabilityId,
    capabilityRevision: CAPABILITY_REVISION,
  };
  const availabilityContext = {
    workspace: '/workspace',
    threadId: 'thread-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    toolCallId: 'call-1',
    phase: 'building' as const,
    interactionMode: 'accept_edits' as const,
  };
  const validatedRequest = {
    source: dynamic ? ('mcp' as const) : ('builtin' as const),
    operationId: target.operationId,
    name: exposedToolName,
    arguments: originalArguments,
    argumentsDigest: digestCapabilityValue(originalArguments),
    schemaDigest: SCHEMA_DIGEST,
    approvalSummary: 'fixture request',
  };
  const validated = {
    schema: 'kite.tool-pipeline-stage.v1' as const,
    stage: 'validated' as const,
    resolved: {
      schema: 'kite.tool-pipeline-stage.v1' as const,
      stage: 'resolved' as const,
      call,
      target,
      availabilityContext,
      builtinProjectionRevision: target.builtinProjectionRevision,
      dynamicCatalogRevision: target.dynamicCatalogRevision,
      disclosedCapabilities: [],
      disclosures: [],
    },
    request: validatedRequest,
    nestedCapability: null,
    domainData: { source: 'classified-domain-facts', dynamic },
  };
  const policyCompilation = {
    schema: 'kite.capability-policy-compilation.v1' as const,
    operationId: target.operationId,
    capabilityRevision: CAPABILITY_REVISION,
    parserRevision: PARSER_REVISION,
    decision: 'allow' as const,
    allowed: true,
    requiresApproval: false,
    risk: dynamic ? ('mcp' as const) : ('write_file' as const),
    reason: 'fixture policy',
    userVisibleSummary: 'fixture policy',
    expectedEffects: ['write'],
    ...(Object.keys(policyEffects).length > 0 ? { effects: policyEffects } : {}),
    effectiveEffects: EFFECTS,
    minimumApproval: 'none' as const,
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  };
  const governanceInvocation = dynamic
    ? {
        turnId: 'turn-1',
        modelMessageId: 'message-1',
        toolCallId: 'call-1',
        argumentOrigin: 'model_public' as const,
        executionFamily: 'mcp' as const,
        executionMechanism: 'mcp' as const,
        exposedToolName: subject.exposedToolName,
        operationId: 'mcp:dynamic_tool' as const,
        capabilityId,
        providerId: 'mcp-provider',
        capabilityRevision: CAPABILITY_REVISION,
        executorRevision: null,
        descriptorRevision: DESCRIPTOR_REVISION,
        parserRevision: PARSER_REVISION,
        schemaDigest: SCHEMA_DIGEST,
        argumentsDigest: validatedRequest.argumentsDigest,
        effectiveEffectsDigest: EFFECTS_DIGEST,
        bindingId: binding?.bindingId ?? null,
        nestedCapabilityId: null,
        nestedCapabilityRevision: null,
        nestedCatalogRevision: null,
        commandDigest: null,
        isDynamicMcp: true as const,
        visibility: 'internal' as const,
        modelVisible: false as const,
        builtinProjectionRevision: null,
        dynamicCatalogRevision: DYNAMIC_REVISION,
        subject,
        runtimeWrapper,
      }
    : {
        turnId: 'turn-1',
        modelMessageId: 'message-1',
        toolCallId: 'call-1',
        argumentOrigin: 'model_public' as const,
        executionFamily: 'builtin' as const,
        executionMechanism: 'filesystem' as const,
        exposedToolName,
        operationId,
        capabilityId,
        providerId: 'builtin-runtime',
        capabilityRevision: CAPABILITY_REVISION,
        executorRevision: EXECUTOR_REVISION,
        descriptorRevision: DESCRIPTOR_REVISION,
        parserRevision: PARSER_REVISION,
        schemaDigest: SCHEMA_DIGEST,
        argumentsDigest: validatedRequest.argumentsDigest,
        effectiveEffectsDigest: EFFECTS_DIGEST,
        bindingId: null,
        nestedCapabilityId: null,
        nestedCapabilityRevision: null,
        nestedCatalogRevision: null,
        commandDigest: null,
        isDynamicMcp: false as const,
        visibility: 'model' as const,
        modelVisible: true as const,
        builtinProjectionRevision: BUILTIN_REVISION,
        dynamicCatalogRevision: null,
      };
  const governanceProjection: ToolPipelineGovernanceProjection = {
    invocation: governanceInvocation,
    policy: policyCompilation,
    effectiveEffects: EFFECTS,
    effectiveEffectsDigest: EFFECTS_DIGEST,
    dynamicMcp: dynamic
      ? {
          isDynamicMcp: true,
          subject,
          runtimeWrapper,
          minimumApproval: 'none',
          readOnly: true,
        }
      : null,
    nestedSkill: null,
  } as ToolPipelineGovernanceProjection;
  const classified = {
    schema: 'kite.tool-pipeline-stage.v1' as const,
    stage: 'classified' as const,
    validated,
    descriptor,
    policyCompilation,
    governance: governanceProjection,
    effectClass: 'workspace_write' as const,
    effectiveEffects: EFFECTS,
    effectiveEffectsDigest: EFFECTS_DIGEST,
    risk: dynamic ? ('network' as const) : ('workspace_write' as const),
    sideEffect: true,
    minimumApproval: 'none' as const,
    executionTraits: null,
    requirements: {
      intent: 'required_before_dispatch' as const,
      receipt: 'effect_receipt' as const,
      retry: idempotency ? ('idempotency_key_candidate' as const) : ('none' as const),
      idempotencyKeyArgument: idempotency ? 'request_id' : null,
      verification: 'after_committed_receipt' as const,
    },
  } as unknown as ClassifiedInvocation<Arguments>;
  const governance: AppToolPipelineGovernanceFacts = {
    schema: 'kite.tool-governance-facts.v1',
    invocation: {
      workspace: '/workspace',
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelMessageId: 'message-1',
      toolCallId: 'call-1',
      exposedToolName: governanceInvocation.exposedToolName,
      operationId: governanceInvocation.operationId,
      capabilityId,
      capabilityRevision: CAPABILITY_REVISION,
      executorRevision: governanceInvocation.executorRevision,
      descriptorRevision: DESCRIPTOR_REVISION,
      parserRevision: PARSER_REVISION,
      schemaDigest: SCHEMA_DIGEST,
      argumentsDigest: validatedRequest.argumentsDigest,
      effectiveEffectsDigest: EFFECTS_DIGEST,
      bindingId: binding?.bindingId ?? null,
      builtinCatalogRevision: governanceInvocation.builtinProjectionRevision,
      dynamicCatalogRevision: governanceInvocation.dynamicCatalogRevision,
      nestedCapabilityId: null,
      nestedCapabilityRevision: null,
      nestedCatalogRevision: null,
      commandDigest: null,
    },
    policy: {
      operationId: policyCompilation.operationId,
      capabilityRevision: policyCompilation.capabilityRevision,
      parserRevision: policyCompilation.parserRevision,
      effectiveEffectsDigest: EFFECTS_DIGEST,
      minimumApproval: policyCompilation.minimumApproval,
      fullAccessMayBypassApproval: policyCompilation.fullAccessMayBypassApproval,
      sameCommandMayBypassApproval: policyCompilation.sameCommandMayBypassApproval,
      decision: policyCompilation.decision,
      allowed: policyCompilation.allowed,
      requiresApproval: policyCompilation.requiresApproval,
      risk: policyCompilation.risk,
      reason: policyCompilation.reason,
      expectedEffects: policyCompilation.expectedEffects,
      ...(policyCompilation.effects ? { effects: policyCompilation.effects } : {}),
    },
    context: {
      phase: 'building',
      interactionMode: 'accept_edits',
      authorizationMode: 'default',
      sandboxAvailable: true,
      circuitBreakerTripped: false,
      executionMechanism: 'other',
      gates: {
        recoveryAdmission: 'admitted',
        boundedCancellation: 'admitted',
        executionBoundary: 'admitted',
        skillCapabilityCeiling: 'admitted',
      },
    },
    admission: { freshness: 'current', reservationRequired: false, reservationIds: [] },
    approval: {
      status: 'queued',
      grant: 'none',
      approvedToolCallId: null,
      approvalBindingDigest: null,
    },
    ...(dynamic ? { dynamicMcp: { minimumApproval: 'none' as const, readOnly: true } } : {}),
  };
  const decision: Extract<AppToolPipelineGovernanceDecision, { readonly kind: 'allow' }> = {
    kind: 'allow',
    authorizationKind: 'policy_allow',
    grantUsed: 'none',
    reservationIds: [],
  };
  const request = {
    schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
    authorizationKind: 'policy_allow' as const,
    grantUsed: 'none' as const,
    policyEffects,
    effectiveEffects: EFFECTS,
    receiptRequirement: 'effect_receipt' as const,
    retryEligibility: idempotency ? ('idempotency_key_candidate' as const) : ('none' as const),
    taskId: 'task-1',
    planId: 'plan-1',
    planStepId: 'step-1',
    capabilityRequestFacts: { source: 'fixture' },
  };
  const preparedArguments = idempotency
    ? { ...originalArguments, request_id: 'explicit-idempotency-key' }
    : originalArguments;
  return {
    originalArguments,
    target,
    input: {
      classified,
      governance,
      decision,
      threadId: 'thread-1',
      attempt: 2,
      preparedArguments,
      request,
      binding,
    },
  };
}

function build(fixtureValue: Fixture): Readonly<AppPreparedToolInvocationBuild<Arguments>> {
  return createAppPreparedToolInvocation(fixtureValue.input);
}

function approveOnceFixture(): Fixture {
  const base = fixture();
  const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigest(
    base.input.governance.invocation,
    base.input.governance.policy,
  );
  const governance: AppToolPipelineGovernanceFacts = {
    ...base.input.governance,
    approval: {
      status: 'approved',
      grant: 'approve_once',
      approvedToolCallId: base.input.governance.invocation.toolCallId,
      approvalBindingDigest,
    },
  };
  const decision: AppToolPipelineGovernanceDecision = {
    kind: 'allow',
    authorizationKind: 'approved_call',
    grantUsed: 'approve_once',
    reservationIds: [],
  };
  const request = {
    ...base.input.request,
    authorizationKind: 'approved_call' as const,
    grantUsed: 'approve_once' as const,
  };
  return {
    ...base,
    input: { ...base.input, governance, decision, request },
  };
}

function fullAccessFixture(): Fixture {
  const base = fixture();
  const policyCompilation = {
    ...base.input.classified.policyCompilation,
    fullAccessMayBypassApproval: true,
  };
  const classified = {
    ...base.input.classified,
    policyCompilation,
    governance: {
      ...base.input.classified.governance,
      policy: policyCompilation,
    },
  } as unknown as ClassifiedInvocation<Arguments>;
  const governance: AppToolPipelineGovernanceFacts = {
    ...base.input.governance,
    policy: { ...base.input.governance.policy, fullAccessMayBypassApproval: true },
    context: { ...base.input.governance.context, authorizationMode: 'full_access' },
  };
  const decision: AppToolPipelineGovernanceDecision = {
    kind: 'allow',
    authorizationKind: 'approved_call',
    grantUsed: 'full_access',
    reservationIds: [],
  };
  const request = {
    ...base.input.request,
    authorizationKind: 'approved_call' as const,
    grantUsed: 'full_access' as const,
  };
  return {
    ...base,
    input: { ...base.input, classified, governance, decision, request },
  };
}

describe('RM-16 App prepared tool invocation builder', () => {
  test('binds ordinary identity to the original legacy digest and freezes request facts', () => {
    const value = build(fixture());
    const identity = value.prepared.identity;
    const facts = fixture().input.governance;
    const policyDigest = runtimeHostStateCreateApprovalBindingDigest(
      facts.invocation,
      facts.policy,
    );
    const authorizationDigest = digestCapabilityValue({
      policyDigest,
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
      authorizationMode: 'default',
    });
    const admissionDigest = digestCapabilityValue({
      authorizationDigest,
      reservationIds: [],
      freshness: 'current',
    });
    expect(identity.invocationId).toBe(
      digestCapabilityValue({
        schema: 'kite.tool-invocation-identity.v1',
        threadId: 'thread-1',
        toolCallId: 'call-1',
        capabilityId: 'builtin:write_file',
        capabilityRevision: CAPABILITY_REVISION,
        argumentsDigest: digestCapabilityValue(fixture().originalArguments),
        authorizationDigest,
        admissionDigest,
      }),
    );
    expect(identity.argumentsDigest).toBe(digestCapabilityValue(fixture().originalArguments));
    expect(identity.attemptId).toBe(`${identity.invocationId}:attempt:2`);
    expect(value.prepared.input.request.schema).toBe(APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_);
    expect(value.prepared.input.request.authorizationKind).toBe('policy_allow');
    expect(value.prepared.input.request.grantUsed).toBe('none');
    expect(value.prepared.input.request.policyEffects).toEqual({});
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.prepared)).toBe(true);
    expect(Object.isFrozen(value.prepared.identity)).toBe(true);
    expect(Object.isFrozen(value.prepared.input)).toBe(true);
    expect(Object.isFrozen(value.prepared.input.arguments)).toBe(true);
    expect(Object.isFrozen(value.prepared.input.facts)).toBe(true);
    expect(Object.isFrozen(value.prepared.input.request)).toBe(true);
    expect(Object.isFrozen(value.prepared.input.request.policyEffects)).toBe(true);
    expect(Object.isFrozen(value.prepared.input.request?.effectiveEffects)).toBe(true);
  });

  test('accepts only a Kernel-bound transient approve_once grant and binds its digest', () => {
    const approved = approveOnceFixture();
    const value = build(approved);
    const approvalBindingDigest = approved.input.governance.approval.approvalBindingDigest;
    expect(approvalBindingDigest).not.toBeNull();
    expect(value.prepared.input.request.authorizationKind).toBe('approved_call');
    expect(value.prepared.input.request.grantUsed).toBe('approve_once');
    expect(value.prepared.identity.policyDigest).toBe(approvalBindingDigest);
    expect(value.prepared.identity.authorizationDigest).toBe(
      digestCapabilityValue({
        policyDigest: approvalBindingDigest,
        authorizationKind: 'approved_call',
        grantUsed: 'approve_once',
        authorizationMode: 'default',
      }),
    );

    expect(() =>
      build({
        ...approved,
        input: {
          ...approved.input,
          request: { ...approved.input.request, authorizationKind: 'policy_allow' },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...approved,
        input: {
          ...approved.input,
          decision: {
            kind: 'allow',
            authorizationKind: 'policy_allow',
            grantUsed: 'approve_once',
            reservationIds: [],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...approved,
        input: {
          ...approved.input,
          governance: {
            ...approved.input.governance,
            approval: {
              ...approved.input.governance.approval,
              approvalBindingDigest: '0'.repeat(64),
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...approved,
        input: {
          ...approved.input,
          governance: {
            ...approved.input.governance,
            approval: {
              ...approved.input.governance.approval,
              approvedToolCallId: 'other-call',
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...approved,
        input: {
          ...approved.input,
          governance: {
            ...approved.input.governance,
            approval: {
              ...approved.input.governance.approval,
              grant: 'same_command',
            },
          },
        },
      }),
    ).toThrow();
  });

  test('accepts a Kernel-proven full-access bypass without inventing an approval envelope', () => {
    const granted = fullAccessFixture();
    expect(build(granted).prepared.input.request).toMatchObject({
      authorizationKind: 'approved_call',
      grantUsed: 'full_access',
    });
    expect(() =>
      build({
        ...granted,
        input: {
          ...granted.input,
          governance: {
            ...granted.input.governance,
            context: { ...granted.input.governance.context, authorizationMode: 'default' },
          },
        },
      }),
    ).toThrow();
  });

  test('keeps dynamic subject, private wrapper, and catalog revisions separate', () => {
    const value = build(fixture({ dynamic: true }));
    const identity = value.prepared.identity;
    expect(identity.isDynamicMcp).toBe(true);
    if (!identity.isDynamicMcp) throw new Error('Expected dynamic identity.');
    expect(identity.operationId).toBe('mcp:dynamic_tool');
    expect(identity.visibility).toBe('internal');
    expect(identity.modelVisible).toBe(false);
    expect(identity.exposedToolName).toBeNull();
    expect(identity.capabilityId).toBe('mcp:server/write_file');
    expect(identity.capabilityRevision).toBe(CAPABILITY_REVISION);
    expect(identity.dynamicCatalogRevision).toBe(DYNAMIC_REVISION);
    expect(identity.builtinProjectionRevision).toBeNull();
    expect(identity.subject.exposedToolName).toBe('mcp__server__write_file');
    expect(identity.runtimeWrapper.operationId).toBe('mcp:dynamic_tool');
    expect(identity.runtimeWrapper.builtinProjectionRevision).toBe(BUILTIN_REVISION);
    expect(value.prepared.input.binding?.capabilityId).toBe('mcp:server/write_file');
  });

  test('rejects cross-turn, stale revision/effects, binding, reservation, and request drift', () => {
    const base = fixture();
    expect(() => build({ ...base, input: { ...base.input, threadId: 'other-thread' } })).toThrow();
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          binding: {
            bindingId: 'wrong-binding',
            capabilityId: 'builtin:write_file',
            capabilityRevision: CAPABILITY_REVISION,
            exposedToolName: 'write_file',
            schemaDigest: SCHEMA_DIGEST,
            issuedForTurnId: 'turn-1',
          },
        },
      }),
    ).toThrow();
    const staleGovernance = {
      ...base.input.governance,
      invocation: {
        ...base.input.governance.invocation,
        capabilityRevision: 'stale-revision',
      },
    } as AppToolPipelineGovernanceFacts;
    expect(() =>
      build({
        ...base,
        input: { ...base.input, governance: staleGovernance },
      }),
    ).toThrow();
    const staleDecision = {
      ...base.input.decision,
      reservationIds: ['reservation-1'],
    } as const;
    expect(() => build({ ...base, input: { ...base.input, decision: staleDecision } })).toThrow();
    const request = base.input.request;
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          request: {
            ...request,
            receiptRequirement: 'observation_receipt',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          request: { ...request, authorizationKind: 'approved_call' },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          request: { ...request, grantUsed: 'full_access' },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          request: { ...request, policyEffects: { network: true } },
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...base,
        input: {
          ...base.input,
          request: { ...request, unexpected: true } as never,
        },
      }),
    ).toThrow();
    expect(() =>
      build({
        ...base,
        input: { ...base.input, preparedArguments: { path: 'different.md' } },
      }),
    ).toThrow();
  });

  test('uses only an explicit idempotency field and hashes the exact prepared arguments', () => {
    const value = build(fixture({ idempotency: true }));
    const identity = value.prepared.identity;
    expect(identity.idempotencyKeyArgument).toBe('request_id');
    expect(identity.idempotencyKey).toBe('explicit-idempotency-key');
    expect(identity.argumentsDigest).toBe(
      digestCapabilityValue({ path: 'README.md', request_id: 'explicit-idempotency-key' }),
    );
    expect(identity.invocationId).toBe(
      digestCapabilityValue({
        schema: 'kite.tool-invocation-identity.v1',
        threadId: 'thread-1',
        toolCallId: 'call-1',
        capabilityId: 'builtin:write_file',
        capabilityRevision: CAPABILITY_REVISION,
        argumentsDigest: digestCapabilityValue(fixture({ idempotency: true }).originalArguments),
        authorizationDigest: identity.authorizationDigest,
        admissionDigest: identity.admissionDigest,
      }),
    );
    const missing = fixture({ idempotency: true });
    expect(() =>
      build({ ...missing, input: { ...missing.input, preparedArguments: { path: 'x' } } }),
    ).toThrow();
    expect(() =>
      build({
        ...missing,
        input: { ...missing.input, preparedArguments: { query: 'hello', request_id: 7 } as never },
      }),
    ).toThrow();
  });

  test('copies classified policy effects into the frozen JSON request envelope', () => {
    const value = build(
      fixture({
        policyEffects: { externalRead: true, network: true },
      }),
    );
    expect(value.prepared.input.request.policyEffects).toEqual({
      externalRead: true,
      network: true,
    });
    expect(Object.isFrozen(value.prepared.input.request.policyEffects)).toBe(true);
  });

  test('rejects a missing typed request envelope before producing a packet', () => {
    const base = fixture();
    expect(() =>
      createAppPreparedToolInvocation({
        ...base.input,
        request: undefined as never,
      }),
    ).toThrow();
  });

  test('completes the real frozen-registry ordinary chain and rejects prepared tampering', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const registrySnapshot = registry.snapshot();
    const projection = createBuiltinToolCatalogProjection(registrySnapshot);
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const turnId = 'turn-real-prepared';
    const threadId = 'thread-real-prepared';
    const call: ToolCallSnapshot = Object.freeze({
      schema: 'kite.tool-pipeline-stage.v1',
      stage: 'snapshot',
      toolCallId: 'call-real-prepared',
      name: 'list_mcp_tools',
      rawArguments: {},
      argumentOrigin: 'model_public',
      createdAtTurnId: turnId,
      modelMessageId: 'message-real-prepared',
      bindingId: null,
      capabilityId: null,
      capabilityRevision: null,
    });
    const resolutionContext: ToolPipelineResolutionContext = Object.freeze({
      currentTurnId: turnId,
      availabilityContext: Object.freeze({
        workspace: '/workspace',
        threadId,
        turnId,
        modelMessageId: call.modelMessageId,
        toolCallId: call.toolCallId,
        phase: 'building',
      }),
      bindings: Object.freeze([]),
      descriptors: Object.freeze([]),
      disclosures: Object.freeze([]),
      builtinProjectionRevision: projection.revision,
      dynamicCatalogRevision: 'd'.repeat(64),
    });
    const resolved = callbacks.resolve(call, resolutionContext);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.failure.code);
    const classified = callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) throw new Error(classified.failure.code);

    const governance = createRuntimeHostStateToolGovernance({
      verifyClassifiedIdentity: callbacks.verifyClassifiedIdentity,
    });
    const governanceInput = Object.freeze({
      classified: classified.value,
      workspace: '/workspace',
      threadId,
      context: Object.freeze({
        phase: 'building' as const,
        interactionMode: 'accept_edits' as const,
        authorizationMode: 'default' as const,
        sandboxAvailable: true,
        circuitBreakerTripped: false,
        gates: Object.freeze({
          recoveryAdmission: 'admitted' as const,
          boundedCancellation: 'admitted' as const,
          executionBoundary: 'admitted' as const,
          skillCapabilityCeiling: 'admitted' as const,
        }),
      }),
      approval: Object.freeze({
        status: 'queued' as const,
        grant: 'none' as const,
        approvedToolCallId: null,
        approvalBindingDigest: null,
      }),
    });
    const admission = Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: Object.freeze([]),
    });
    const projected = governance.project(governanceInput, admission);
    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error(projected.failure.diagnostic);
    const decided = governance.decide(governanceInput, admission);
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error(decided.failure.diagnostic);
    expect(decided.value.kind).toBe('allow');
    if (decided.value.kind !== 'allow') throw new Error('Expected allow decision.');

    const prepared = createAppPreparedToolInvocation({
      classified: classified.value,
      governance: projected.value,
      decision: decided.value,
      threadId,
      attempt: 1,
      preparedArguments: validated.value.request.arguments,
      request: {
        schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
        authorizationKind: 'policy_allow',
        grantUsed: 'none',
        policyEffects: {},
        effectiveEffects: classified.value.effectiveEffects,
        receiptRequirement: classified.value.requirements.receipt,
        retryEligibility: classified.value.requirements.retry,
        taskId: null,
        planId: null,
        planStepId: null,
        capabilityRequestFacts: null,
      },
      binding: validated.value.resolved.target.binding,
    });
    expect(prepared.prepared.input.facts).toEqual(validated.value.domainData);
    expect(callbacks.verifyPreparedIdentity(prepared.prepared)).toMatchObject({ valid: true });

    const turnTampered = structuredClone(prepared.prepared) as unknown as {
      input: { facts: Record<string, unknown> };
    };
    turnTampered.input.facts = {
      ...turnTampered.input.facts,
      callCreatedAtTurnId: 'turn-tampered',
    };
    expect(callbacks.verifyPreparedIdentity(turnTampered as never)).toMatchObject({
      valid: false,
    });

    const argumentsTampered = structuredClone(prepared.prepared) as unknown as {
      input: { arguments: unknown };
    };
    argumentsTampered.input.arguments = null;
    expect(callbacks.verifyPreparedIdentity(argumentsTampered as never)).toMatchObject({
      valid: false,
    });

    const effectsTampered = structuredClone(prepared.prepared) as unknown as {
      identity: { effectiveEffectsDigest: string };
    };
    effectsTampered.identity.effectiveEffectsDigest = '0'.repeat(64);
    expect(callbacks.verifyPreparedIdentity(effectsTampered as never)).toMatchObject({
      valid: false,
    });

    const dynamicDescriptorBase: Omit<CapabilityDescriptor, 'revision'> = {
      capabilityId: 'mcp:fixture/search',
      kind: 'mcp_tool',
      displayName: 'Fixture Search',
      description: 'Real dynamic MCP prepared-packet fixture.',
      provider: { type: 'mcp', id: 'fixture-provider', provenance: 'remote' },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'safe_read' },
      availability: 'available',
      diagnostics: [],
    };
    const dynamicDescriptor: CapabilityDescriptor = {
      ...dynamicDescriptorBase,
      revision: digestCapabilityBindingValue(dynamicDescriptorBase),
    };
    const dynamicBinding = createCapabilityBinding({
      capabilityId: dynamicDescriptor.capabilityId,
      capabilityRevision: dynamicDescriptor.revision,
      exposedToolName: 'mcp__fixture__search',
      inputSchema: dynamicDescriptor.inputSchema,
      turnId,
    });
    const dynamicCall: ToolCallSnapshot = Object.freeze({
      schema: 'kite.tool-pipeline-stage.v1',
      stage: 'snapshot',
      toolCallId: 'call-real-dynamic-prepared',
      name: dynamicBinding.exposedToolName,
      rawArguments: { query: 'kite' },
      argumentOrigin: 'model_public',
      createdAtTurnId: turnId,
      modelMessageId: 'message-real-dynamic-prepared',
      bindingId: dynamicBinding.bindingId,
      capabilityId: dynamicBinding.capabilityId,
      capabilityRevision: dynamicBinding.capabilityRevision,
    });
    const dynamicContext: ToolPipelineResolutionContext = Object.freeze({
      ...resolutionContext,
      availabilityContext: Object.freeze({
        ...resolutionContext.availabilityContext,
        modelMessageId: dynamicCall.modelMessageId,
        toolCallId: dynamicCall.toolCallId,
      }),
      bindings: Object.freeze([dynamicBinding]),
      descriptors: Object.freeze([dynamicDescriptor]),
      dynamicCatalogRevision: 'd'.repeat(64),
    });
    const dynamicResolved = callbacks.resolve(dynamicCall, dynamicContext);
    expect(dynamicResolved.ok).toBe(true);
    if (!dynamicResolved.ok) throw new Error(dynamicResolved.failure.code);
    const dynamicValidated = callbacks.validate(dynamicResolved.value);
    expect(dynamicValidated.ok).toBe(true);
    if (!dynamicValidated.ok) throw new Error(dynamicValidated.failure.code);
    const dynamicClassified = callbacks.classify(dynamicValidated.value);
    expect(dynamicClassified.ok).toBe(true);
    if (!dynamicClassified.ok) throw new Error(dynamicClassified.failure.code);
    const dynamicGovernanceInput = Object.freeze({
      ...governanceInput,
      classified: dynamicClassified.value,
    });
    const dynamicProjected = governance.project(dynamicGovernanceInput, admission);
    expect(dynamicProjected.ok).toBe(true);
    if (!dynamicProjected.ok) throw new Error(dynamicProjected.failure.diagnostic);
    const dynamicDecided = governance.decide(dynamicGovernanceInput, admission);
    expect(dynamicDecided.ok).toBe(true);
    if (!dynamicDecided.ok) throw new Error(dynamicDecided.failure.diagnostic);
    if (dynamicDecided.value.kind !== 'allow') {
      throw new Error('Expected dynamic MCP allow decision.');
    }
    const dynamicPrepared = createAppPreparedToolInvocation({
      classified: dynamicClassified.value,
      governance: dynamicProjected.value,
      decision: dynamicDecided.value,
      threadId,
      attempt: 1,
      preparedArguments: dynamicValidated.value.request.arguments,
      request: {
        schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
        authorizationKind: 'policy_allow',
        grantUsed: 'none',
        policyEffects: {},
        effectiveEffects: dynamicClassified.value.effectiveEffects,
        receiptRequirement: dynamicClassified.value.requirements.receipt,
        retryEligibility: dynamicClassified.value.requirements.retry,
        taskId: null,
        planId: null,
        planStepId: null,
        capabilityRequestFacts: null,
      },
      binding: dynamicValidated.value.resolved.target.binding,
    });
    expect(callbacks.verifyPreparedIdentity(dynamicPrepared.prepared)).toMatchObject({
      valid: true,
    });
    expect(dynamicPrepared.prepared.identity).toMatchObject({
      isDynamicMcp: true,
      operationId: 'mcp:dynamic_tool',
      exposedToolName: null,
      builtinProjectionRevision: null,
      dynamicCatalogRevision: 'd'.repeat(64),
    });
  });
});
