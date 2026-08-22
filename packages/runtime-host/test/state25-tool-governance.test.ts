import { describe, expect, test } from 'bun:test';
import {
  type AgentAuthorizationState,
  applyApprovalGrantV1,
  createToolApprovalBindingDigestV1,
  createToolGovernanceCommandDigestV1,
} from '@kite/agent-kernel';
import {
  createRuntimeHostState25ToolGovernanceV1,
  type RuntimeHostState25ToolGovernanceAuthorizationInputV1,
} from '@kite/runtime-host';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_V1,
  type CapabilityEffectsV1,
  type ClassifiedInvocationV1,
  type ToolPipelineGovernanceProjectionV1,
} from '@kite/runtime-spi';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const F = 'f'.repeat(64);
const COMMAND_DIGEST = createToolGovernanceCommandDigestV1('echo hello')!;

const effects: CapabilityEffectsV1 = Object.freeze({
  filesystem: 'write',
  network: 'none',
  externalState: 'none',
});

function ordinaryClassified(): ClassifiedInvocationV1 {
  const policy = Object.freeze({
    schema: CAPABILITY_POLICY_COMPILATION_SCHEMA_V1,
    operationId: 'builtin:shell_execute',
    capabilityRevision: A,
    parserRevision: B,
    decision: 'ask' as const,
    allowed: true,
    requiresApproval: true,
    risk: 'execute_code' as const,
    effects: Object.freeze({ externalWrite: true as const }),
    reason: 'Shell requires approval.',
    userVisibleSummary: 'Run a shell command.',
    expectedEffects: Object.freeze(['Runs a shell command.']),
    phaseConstraint: undefined,
    effectiveEffects: effects,
    minimumApproval: 'none' as const,
    fullAccessMayBypassApproval: true,
    sameCommandMayBypassApproval: true,
  });
  const invocation = Object.freeze({
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    toolCallId: 'call-1',
    argumentOrigin: 'model_public' as const,
    executionFamily: 'builtin' as const,
    executionMechanism: 'shell' as const,
    exposedToolName: 'shell_execute',
    operationId: 'builtin:shell_execute',
    capabilityId: 'builtin:shell_execute',
    providerId: 'builtin-runtime',
    capabilityRevision: A,
    executorRevision: C,
    descriptorRevision: D,
    parserRevision: B,
    schemaDigest: E,
    argumentsDigest: F,
    effectiveEffectsDigest: C,
    bindingId: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    commandDigest: COMMAND_DIGEST,
    isDynamicMcp: false as const,
    visibility: 'model' as const,
    modelVisible: true as const,
    builtinProjectionRevision: E,
    dynamicCatalogRevision: null,
  });
  const governance: ToolPipelineGovernanceProjectionV1 = Object.freeze({
    invocation: invocation as ToolPipelineGovernanceProjectionV1['invocation'],
    policy,
    effectiveEffects: effects,
    effectiveEffectsDigest: C,
    dynamicMcp: null,
    nestedSkill: null,
  });
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    stage: 'classified',
    policyCompilation: policy,
    governance,
    effectiveEffects: effects,
    effectiveEffectsDigest: C,
  } as unknown as ClassifiedInvocationV1;
}

function dynamicClassified(): ClassifiedInvocationV1 {
  const subject = Object.freeze({
    capabilityId: 'mcp:server/tool',
    capabilityRevision: A,
    descriptorRevision: B,
    providerId: 'mcp-provider',
    exposedToolName: 'mcp__server__tool' as const,
    dynamicCatalogRevision: D,
    bindingId: A,
  });
  const runtimeWrapper = Object.freeze({
    operationId: 'mcp:dynamic_tool' as const,
    capabilityId: 'mcp:dynamic_tool',
    providerId: 'builtin-runtime',
    capabilityRevision: C,
    executorRevision: E,
    schemaDigest: F,
    builtinProjectionRevision: E,
  });
  const policy = Object.freeze({
    schema: CAPABILITY_POLICY_COMPILATION_SCHEMA_V1,
    operationId: 'mcp:dynamic_tool',
    capabilityRevision: A,
    parserRevision: B,
    decision: 'ask' as const,
    allowed: true,
    requiresApproval: true,
    risk: 'mcp' as const,
    effects: Object.freeze({ network: true as const }),
    reason: 'MCP requires approval.',
    userVisibleSummary: 'Call an MCP capability.',
    expectedEffects: Object.freeze(['Calls a remote MCP capability.']),
    effectiveEffects: effects,
    minimumApproval: 'user' as const,
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
  });
  const invocation = Object.freeze({
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    toolCallId: 'call-1',
    argumentOrigin: 'model_public' as const,
    executionFamily: 'mcp' as const,
    executionMechanism: 'mcp' as const,
    exposedToolName: subject.exposedToolName,
    operationId: 'mcp:dynamic_tool' as const,
    capabilityId: subject.capabilityId,
    providerId: subject.providerId,
    capabilityRevision: subject.capabilityRevision,
    executorRevision: null,
    descriptorRevision: subject.descriptorRevision,
    parserRevision: B,
    schemaDigest: F,
    argumentsDigest: E,
    effectiveEffectsDigest: C,
    bindingId: subject.bindingId,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    commandDigest: null,
    isDynamicMcp: true as const,
    visibility: 'internal' as const,
    modelVisible: false as const,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: subject.dynamicCatalogRevision,
    subject,
    runtimeWrapper,
  });
  const governance: ToolPipelineGovernanceProjectionV1 = Object.freeze({
    invocation,
    policy,
    effectiveEffects: effects,
    effectiveEffectsDigest: C,
    dynamicMcp: Object.freeze({
      isDynamicMcp: true as const,
      subject,
      runtimeWrapper,
      minimumApproval: 'user' as const,
      readOnly: false,
    }),
    nestedSkill: null,
  });
  return {
    schema: 'kite.tool-pipeline-stage.v1',
    stage: 'classified',
    policyCompilation: policy,
    governance,
    effectiveEffects: effects,
    effectiveEffectsDigest: C,
  } as unknown as ClassifiedInvocationV1;
}

function ordinaryMcpClassified(): ClassifiedInvocationV1 {
  const base = ordinaryClassified();
  const governance = base.governance as ToolPipelineGovernanceProjectionV1;
  const policy = Object.freeze({
    ...governance.policy,
    operationId: 'builtin:list_mcp_resources',
    risk: 'mcp' as const,
    decision: 'allow' as const,
    requiresApproval: false,
    sameCommandMayBypassApproval: false,
  });
  const invocation = Object.freeze({
    ...governance.invocation,
    executionMechanism: 'mcp' as const,
    exposedToolName: 'list_mcp_resources',
    operationId: 'builtin:list_mcp_resources',
    capabilityId: 'builtin:list_mcp_resources',
    commandDigest: null,
  });
  const projected = Object.freeze({
    ...governance,
    invocation: invocation as ToolPipelineGovernanceProjectionV1['invocation'],
    policy,
  }) as ToolPipelineGovernanceProjectionV1;
  return {
    ...base,
    policyCompilation: policy,
    governance: projected,
  } as unknown as ClassifiedInvocationV1;
}

function nestedSkillClassified(): ClassifiedInvocationV1 {
  const base = ordinaryClassified();
  const governance = base.governance as ToolPipelineGovernanceProjectionV1;
  const policy = Object.freeze({
    ...governance.policy,
    operationId: 'builtin:activate_skill',
    risk: 'mcp' as const,
    decision: 'ask' as const,
    requiresApproval: true,
    minimumApproval: 'user' as const,
    sameCommandMayBypassApproval: false,
  });
  const invocation = Object.freeze({
    ...governance.invocation,
    executionFamily: 'skill' as const,
    executionMechanism: 'skill' as const,
    exposedToolName: 'activate_skill',
    operationId: 'builtin:activate_skill',
    capabilityId: 'builtin:activate_skill',
    commandDigest: null,
    nestedCapabilityId: 'skill:fixture',
    nestedCapabilityRevision: A,
    nestedCatalogRevision: D,
  });
  const nestedSkill = Object.freeze({
    operationId: 'builtin:activate_skill' as const,
    capabilityId: 'skill:fixture',
    capabilityRevision: A,
    nestedCatalogRevision: D,
    decision: 'ask' as const,
    minimumApproval: 'user' as const,
  });
  const projected = Object.freeze({
    ...governance,
    invocation: invocation as ToolPipelineGovernanceProjectionV1['invocation'],
    policy,
    nestedSkill,
  }) as ToolPipelineGovernanceProjectionV1;
  return {
    ...base,
    policyCompilation: policy,
    governance: projected,
  } as unknown as ClassifiedInvocationV1;
}

function context(): RuntimeHostState25ToolGovernanceAuthorizationInputV1['context'] {
  return {
    phase: 'building',
    interactionMode: 'accept_edits',
    authorizationMode: 'default',
    sandboxAvailable: true,
    circuitBreakerTripped: false,
    gates: {
      recoveryAdmission: 'admitted',
      boundedCancellation: 'admitted',
      executionBoundary: 'admitted',
      skillCapabilityCeiling: 'admitted',
    },
    observedAt: 1_000,
  };
}

function authorization(): AgentAuthorizationState {
  return { mode: 'default', commandGrants: {} };
}

function input(
  classified: ClassifiedInvocationV1 = ordinaryClassified(),
  overrides: Partial<RuntimeHostState25ToolGovernanceAuthorizationInputV1> = {},
): RuntimeHostState25ToolGovernanceAuthorizationInputV1 {
  return {
    classified,
    workspace: '/workspace',
    threadId: 'thread-1',
    context: context(),
    approval: {
      status: 'queued',
      grant: 'none',
      approvedToolCallId: null,
      approvalBindingDigest: null,
    },
    ...overrides,
  };
}

function admission(): { freshness: 'current'; reservationRequired: false; reservationIds: [] } {
  return { freshness: 'current', reservationRequired: false, reservationIds: [] };
}

function reservedAdmission(): {
  freshness: 'current';
  reservationRequired: true;
  reservationIds: ['reservation-1'];
} {
  return { freshness: 'current', reservationRequired: true, reservationIds: ['reservation-1'] };
}

function bridge(verifier: (value: ClassifiedInvocationV1) => boolean = () => true) {
  return createRuntimeHostState25ToolGovernanceV1({
    verifyClassifiedIdentity: verifier,
  });
}

describe('Runtime Host State25 tool governance bridge', () => {
  test('maps ordinary Builtin facts and derives execution mechanism in Host', () => {
    const result = bridge().project(input(), admission());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invocation).toMatchObject({
      workspace: '/workspace',
      threadId: 'thread-1',
      operationId: 'builtin:shell_execute',
      capabilityId: 'builtin:shell_execute',
      builtinCatalogRevision: E,
      dynamicCatalogRevision: null,
      commandDigest: COMMAND_DIGEST,
    });
    expect(result.value.context.executionMechanism).toBe('shell');
    expect(result.value.policy).toMatchObject({
      operationId: 'builtin:shell_execute',
      effectiveEffectsDigest: C,
      requiresApproval: true,
      sameCommandMayBypassApproval: true,
    });
    expect(result.value.dynamicMcp).toBeUndefined();
  });

  test('preserves the dynamic subject/wrapper split and independent revisions', () => {
    const result = bridge().project(input(dynamicClassified()), admission());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invocation).toMatchObject({
      exposedToolName: 'mcp__server__tool',
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:server/tool',
      builtinCatalogRevision: null,
      dynamicCatalogRevision: D,
    });
    expect(result.value.context.executionMechanism).toBe('other');
    expect(result.value.dynamicMcp).toEqual({ minimumApproval: 'user', readOnly: false });
  });

  test('accepts ordinary MCP mechanisms and preserves nested Skill identity', () => {
    const mcp = bridge().project(input(ordinaryMcpClassified()), admission());
    expect(mcp.ok).toBe(true);
    if (mcp.ok) expect(mcp.value.context.executionMechanism).toBe('other');

    const nested = bridge().project(input(nestedSkillClassified()), admission());
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.value.nestedSkill).toEqual({ decision: 'ask', minimumApproval: 'user' });
    expect(nested.value.invocation).toMatchObject({
      operationId: 'builtin:activate_skill',
      nestedCapabilityId: 'skill:fixture',
      nestedCapabilityRevision: A,
      nestedCatalogRevision: D,
      dynamicCatalogRevision: null,
      builtinCatalogRevision: E,
    });
  });

  test('projects a verified user-input interrupt to the pure Kernel decision', () => {
    const base = ordinaryClassified();
    const governance = base.governance as ToolPipelineGovernanceProjectionV1;
    const forged = Object.freeze({
      ...governance,
      invocation: Object.freeze({
        ...governance.invocation,
        executionMechanism: 'user_input' as const,
      }) as ToolPipelineGovernanceProjectionV1['invocation'],
    }) as ToolPipelineGovernanceProjectionV1;
    const classified = { ...base, governance: forged } as ClassifiedInvocationV1;
    const projected = bridge().project(input(classified), admission());
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.context.executionMechanism).toBe('user_input');
    expect(bridge().decide(input(classified), admission())).toEqual({
      ok: true,
      value: { kind: 'request_user_input' },
    });
  });

  test('checks the injected classified verifier before projecting or calling Kernel', () => {
    let calls = 0;
    const port = bridge(() => {
      calls += 1;
      return false;
    });
    const result = port.decide(input(), admission());
    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'classified_identity_invalid',
        diagnostic: 'Builtin classified identity was rejected.',
      },
    });
  });

  test('rejects a forged clone or cross-branch governance projection', () => {
    const forged = ordinaryClassified();
    const governance = forged.governance as ToolPipelineGovernanceProjectionV1;
    const forgedGovernance = {
      ...governance,
      invocation: { ...governance.invocation, dynamicCatalogRevision: D },
    } as ToolPipelineGovernanceProjectionV1;
    const result = bridge().project(
      input({ ...forged, governance: forgedGovernance } as ClassifiedInvocationV1),
      admission(),
    );
    expect(result).toMatchObject({ ok: false, failure: { code: 'governance_projection_invalid' } });
  });

  test('rejects nested identity drift before Kernel facts are admitted', () => {
    const forged = ordinaryClassified();
    const governance = forged.governance as ToolPipelineGovernanceProjectionV1;
    const nested = {
      operationId: 'builtin:activate_skill' as const,
      capabilityId: 'skill:fixture',
      capabilityRevision: A,
      nestedCatalogRevision: B,
      decision: 'ask' as const,
      minimumApproval: 'user' as const,
    };
    const forgedGovernance = {
      ...governance,
      nestedSkill: nested,
    } as ToolPipelineGovernanceProjectionV1;
    const result = bridge().project(
      input({ ...forged, governance: forgedGovernance } as ClassifiedInvocationV1),
      admission(),
    );
    expect(result).toMatchObject({ ok: false, failure: { code: 'governance_projection_invalid' } });
  });

  test('uses only an exact persisted State25 same-command grant', () => {
    const granted = applyApprovalGrantV1({
      authorization: authorization(),
      grant: 'same_command',
      workspace: '/workspace',
      threadId: 'thread-1',
      command: 'echo hello',
      source: 'user',
      grantedAt: '1970-01-01T00:00:00.100Z',
    });
    const projected = bridge().project(
      input(ordinaryClassified(), {
        sameCommandGrant: { authorization: granted, command: '  echo hello  ' },
      }),
      admission(),
    );
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.sameCommandGrant).toMatchObject({
      workspace: '/workspace',
      threadId: 'thread-1',
      commandDigest: COMMAND_DIGEST,
      source: 'user',
      grantedAt: 100,
    });

    const mismatch = bridge().project(
      input(ordinaryClassified(), {
        sameCommandGrant: { authorization: granted, command: 'echo other' },
      }),
      admission(),
    );
    expect(mismatch.ok).toBe(true);
    if (mismatch.ok) expect(mismatch.value.sameCommandGrant).toBeUndefined();

    const whitespaceMismatch = bridge().project(
      input(ordinaryClassified(), {
        sameCommandGrant: { authorization: granted, command: 'echo  hello' },
      }),
      admission(),
    );
    expect(whitespaceMismatch.ok).toBe(true);
    if (whitespaceMismatch.ok) expect(whitespaceMismatch.value.sameCommandGrant).toBeUndefined();
  });

  test('keeps Kernel gates, approval, and admission decisions authoritative', () => {
    const port = bridge();
    const denied = port.decide(
      input(ordinaryClassified(), {
        context: { ...context(), gates: { ...context().gates, executionBoundary: 'blocked' } },
      }),
      admission(),
    );
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.value).toMatchObject({
      kind: 'reject',
      failureKind: 'mandatory_policy_unavailable',
    });

    const projected = port.project(input(), admission());
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const approvedInput = input(ordinaryClassified(), {
      approval: {
        status: 'approved',
        grant: 'approve_once',
        approvedToolCallId: projected.value.invocation.toolCallId,
        approvalBindingDigest: createToolApprovalBindingDigestV1(
          projected.value.invocation,
          projected.value.policy,
        ),
      },
    });
    const authorized = port.authorize(approvedInput);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.value).toMatchObject({ kind: 'authorized', grantUsed: 'approve_once' });
    const admitted = port.admit(approvedInput, authorized.value, reservedAdmission());
    expect(admitted).toMatchObject({ ok: true, value: { kind: 'allow' } });

    expect(
      port.admit(approvedInput, authorized.value, {
        freshness: 'stale',
        reservationRequired: true,
        reservationIds: ['reservation-1'],
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'reject', code: 'admission_stale' },
    });
    expect(
      port.admit(approvedInput, authorized.value, {
        freshness: 'current',
        reservationRequired: true,
        reservationIds: [],
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'reject', code: 'reservation_invalid' },
    });

    const clonedAuthorization = structuredClone(authorized.value);
    expect(port.admit(approvedInput, clonedAuthorization, reservedAdmission())).toMatchObject({
      ok: false,
      failure: { code: 'authorization_identity_invalid' },
    });
    expect(port.admit(input(), authorized.value, reservedAdmission())).toMatchObject({
      ok: false,
      failure: { code: 'authorization_identity_invalid' },
    });
    expect(
      port.admit(
        { ...approvedInput, context: { ...approvedInput.context, phase: 'planning' } },
        authorized.value,
        reservedAdmission(),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'authorization_identity_invalid' } });
    expect(
      port.admit(
        {
          ...approvedInput,
          approval: { ...approvedInput.approval, approvedToolCallId: 'changed-call' },
        },
        authorized.value,
        reservedAdmission(),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'authorization_identity_invalid' } });
    expect(
      port.admit(
        { ...approvedInput, classified: ordinaryClassified() },
        authorized.value,
        reservedAdmission(),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'authorization_identity_invalid' } });
    expect(bridge().admit(approvedInput, authorized.value, reservedAdmission())).toMatchObject({
      ok: false,
      failure: { code: 'authorization_identity_invalid' },
    });
  });

  test('does not touch raw arguments or domainData', () => {
    const classified = ordinaryClassified();
    Object.defineProperty(classified, 'validated', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('raw arguments were accessed');
      },
    });
    expect(bridge().project(input(classified), admission())).toMatchObject({ ok: true });
  });
});
