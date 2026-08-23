import { describe, expect, test } from 'bun:test';
import {
  authorizeToolGovernanceV1,
  createToolApprovalBindingDigestV1,
  createToolGovernanceCommandDigestV1,
  decideToolGovernanceV1,
  isValidToolGovernanceFactsV1,
  TOOL_GOVERNANCE_FACTS_SCHEMA_V1,
  type ToolGovernanceAdmissionFactsV1,
  type ToolGovernanceApprovalFactV1,
  type ToolGovernanceContextFactsV1,
  type ToolGovernanceFactsV1,
  type ToolGovernanceGateFactsV1,
  type ToolGovernanceInvocationFactV1,
  type ToolGovernancePolicyFactV1,
} from '../src/tool-governance';

const D = 'a'.repeat(64);
const E = 'b'.repeat(64);
const F = 'c'.repeat(64);

const BASE_INVOCATION: ToolGovernanceInvocationFactV1 = {
  workspace: '/workspace',
  threadId: 'thread-1',
  turnId: 'turn-1',
  modelMessageId: 'message-1',
  toolCallId: 'call-1',
  exposedToolName: 'test_tool',
  operationId: 'builtin:test_tool',
  capabilityId: 'builtin:test_tool',
  capabilityRevision: D,
  executorRevision: D,
  descriptorRevision: D,
  parserRevision: D,
  schemaDigest: D,
  argumentsDigest: E,
  effectiveEffectsDigest: F,
  bindingId: D,
  builtinCatalogRevision: D,
  dynamicCatalogRevision: null,
  nestedCapabilityId: null,
  nestedCapabilityRevision: null,
  nestedCatalogRevision: null,
  commandDigest: null,
};

const BASE_POLICY: ToolGovernancePolicyFactV1 = {
  operationId: 'builtin:test_tool',
  capabilityRevision: D,
  parserRevision: D,
  effectiveEffectsDigest: F,
  minimumApproval: 'none',
  fullAccessMayBypassApproval: false,
  sameCommandMayBypassApproval: false,
  decision: 'allow',
  allowed: true,
  requiresApproval: false,
  risk: 'read',
  reason: 'Read-only policy fact.',
  userVisibleSummary: 'Read fixture.',
  expectedEffects: ['Reads fixture data'],
};

const BASE_GATES: ToolGovernanceGateFactsV1 = {
  recoveryAdmission: 'admitted',
  boundedCancellation: 'admitted',
  executionBoundary: 'admitted',
  skillCapabilityCeiling: 'admitted',
};

const BASE_CONTEXT: ToolGovernanceContextFactsV1 = {
  phase: 'building',
  interactionMode: 'accept_edits',
  authorizationMode: 'default',
  sandboxAvailable: true,
  circuitBreakerTripped: false,
  executionMechanism: 'other',
  gates: BASE_GATES,
  observedAt: 100,
};

const BASE_ADMISSION: ToolGovernanceAdmissionFactsV1 = {
  freshness: 'current',
  reservationRequired: false,
  reservationIds: [],
};

const QUEUED_APPROVAL: ToolGovernanceApprovalFactV1 = {
  status: 'queued',
  grant: 'none',
  approvedToolCallId: null,
  approvalBindingDigest: null,
};

type FactOverrides = {
  readonly invocation?: Partial<ToolGovernanceInvocationFactV1>;
  readonly policy?: Partial<ToolGovernancePolicyFactV1>;
  readonly context?: Partial<Omit<ToolGovernanceContextFactsV1, 'gates'>> & {
    readonly gates?: Partial<ToolGovernanceGateFactsV1>;
  };
  readonly admission?: Partial<ToolGovernanceAdmissionFactsV1>;
  readonly approval?: Partial<ToolGovernanceApprovalFactV1>;
  readonly sameCommandGrant?: ToolGovernanceFactsV1['sameCommandGrant'];
  readonly dynamicMcp?: ToolGovernanceFactsV1['dynamicMcp'];
  readonly nestedSkill?: ToolGovernanceFactsV1['nestedSkill'];
};

function facts(overrides: FactOverrides = {}): ToolGovernanceFactsV1 {
  const invocation = { ...BASE_INVOCATION, ...overrides.invocation };
  const context = {
    ...BASE_CONTEXT,
    ...overrides.context,
    gates: { ...BASE_GATES, ...overrides.context?.gates },
  };
  return {
    schema: TOOL_GOVERNANCE_FACTS_SCHEMA_V1,
    invocation,
    policy: { ...BASE_POLICY, ...overrides.policy },
    context,
    admission: { ...BASE_ADMISSION, ...overrides.admission },
    approval: { ...QUEUED_APPROVAL, ...overrides.approval },
    ...(overrides.sameCommandGrant === undefined
      ? {}
      : { sameCommandGrant: overrides.sameCommandGrant }),
    ...(overrides.dynamicMcp === undefined ? {} : { dynamicMcp: overrides.dynamicMcp }),
    ...(overrides.nestedSkill === undefined ? {} : { nestedSkill: overrides.nestedSkill }),
  };
}

function approvedFacts(
  grant: 'approve_once' | 'same_command' | 'full_access' = 'approve_once',
  overrides: FactOverrides = {},
): ToolGovernanceFactsV1 {
  const pending = facts(overrides);
  return {
    ...pending,
    approval: {
      status: 'approved',
      grant,
      approvedToolCallId: pending.invocation.toolCallId,
      approvalBindingDigest: createToolApprovalBindingDigestV1(pending.invocation, pending.policy),
    },
  };
}

function shellFacts(overrides: FactOverrides = {}): ToolGovernanceFactsV1 {
  return facts({
    ...overrides,
    invocation: {
      exposedToolName: 'shell_execute',
      operationId: 'builtin:shell_execute',
      capabilityId: 'builtin:shell_execute',
      commandDigest: D,
      ...overrides.invocation,
    },
    policy: {
      operationId: 'builtin:shell_execute',
      capabilityRevision: D,
      parserRevision: D,
      risk: 'execute_code',
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      sameCommandMayBypassApproval: true,
      fullAccessMayBypassApproval: true,
      ...overrides.policy,
    },
    context: {
      executionMechanism: 'shell',
      ...overrides.context,
    },
  });
}

function activationFacts(overrides: FactOverrides = {}): ToolGovernanceFactsV1 {
  return facts({
    ...overrides,
    invocation: {
      exposedToolName: 'activate_skill',
      operationId: 'builtin:activate_skill',
      capabilityId: 'builtin:activate_skill',
      nestedCapabilityId: 'skill:fixture',
      nestedCapabilityRevision: D,
      nestedCatalogRevision: D,
      ...overrides.invocation,
    },
    policy: {
      operationId: 'builtin:activate_skill',
      capabilityRevision: D,
      parserRevision: D,
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      risk: 'mcp',
      minimumApproval: 'user',
      ...overrides.policy,
    },
  });
}

function dynamicMcpFacts(overrides: FactOverrides = {}): ToolGovernanceFactsV1 {
  return facts({
    ...overrides,
    invocation: {
      exposedToolName: 'mcp__server__tool',
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:server/tool',
      builtinCatalogRevision: null,
      dynamicCatalogRevision: D,
      ...overrides.invocation,
    },
    policy: {
      operationId: 'mcp:dynamic_tool',
      capabilityRevision: D,
      parserRevision: D,
      risk: 'mcp',
      ...overrides.policy,
    },
    dynamicMcp: {
      minimumApproval: 'user',
      readOnly: false,
      ...overrides.dynamicMcp,
    },
  });
}

describe('State tool governance authorization facts', () => {
  test('binds same-command grants to trimmed text without collapsing internal whitespace', () => {
    expect(createToolGovernanceCommandDigestV1('  echo hello  ')).toBe(
      '40a497646523116499ac8d2aeb78ce0c3c6643ce6f09805c21db3909fc614d3e',
    );
    expect(createToolGovernanceCommandDigestV1('echo  hello')).toBe(
      '37b2f209ba15e46cc8f5ad68fb665df968549d78c7983ba307a7ae34c7d3a949',
    );
    expect(createToolGovernanceCommandDigestV1('   ')).toBeNull();
  });

  test('requires complete invocation/policy identity and rejects legacy authority fields', () => {
    expect(isValidToolGovernanceFactsV1(facts())).toBe(true);
    expect(
      isValidToolGovernanceFactsV1({
        ...facts(),
        context: { ...facts().context, callStatus: 'queued' },
      }),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1({
        ...facts(),
        policy: { ...facts().policy, grantUsed: 'full_access' },
      }),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(facts({ invocation: { capabilityRevision: 'A'.repeat(64) } })),
    ).toBe(false);
    expect(isValidToolGovernanceFactsV1(facts({ invocation: { toolCallId: '' } }))).toBe(false);
    expect(isValidToolGovernanceFactsV1(facts({ policy: { parserRevision: E } }))).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(
        facts({
          invocation: { builtinCatalogRevision: null, dynamicCatalogRevision: D },
        }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(
        facts({
          invocation: { builtinCatalogRevision: D, dynamicCatalogRevision: D },
        }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(facts({ invocation: { exposedToolName: 'mcp__server__tool' } })),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(
        dynamicMcpFacts({ invocation: { exposedToolName: 'ordinary_tool' } }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(
        dynamicMcpFacts({ invocation: { capabilityId: 'mcp:dynamic_tool' } }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1({
        ...dynamicMcpFacts(),
        dynamicMcp: undefined,
      }),
    ).toBe(false);
    expect(
      isValidToolGovernanceFactsV1(
        facts({
          dynamicMcp: { minimumApproval: 'none', readOnly: true },
        }),
      ),
    ).toBe(false);
  });

  test('binds deterministic approval digest to every identity and policy field', () => {
    const first = createToolApprovalBindingDigestV1(BASE_INVOCATION, BASE_POLICY);
    const second = createToolApprovalBindingDigestV1(BASE_INVOCATION, BASE_POLICY);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(second);
    expect(
      createToolApprovalBindingDigestV1({ ...BASE_INVOCATION, toolCallId: 'call-2' }, BASE_POLICY),
    ).not.toBe(first);
    expect(
      createToolApprovalBindingDigestV1(BASE_INVOCATION, {
        ...BASE_POLICY,
        reason: 'Different policy fact.',
      }),
    ).not.toBe(first);
    expect(
      createToolApprovalBindingDigestV1(
        { ...BASE_INVOCATION, nestedCapabilityRevision: E },
        BASE_POLICY,
      ),
    ).not.toBe(first);
  });

  test('authorizes only an exact approved call and carries Kernel grantUsed', () => {
    expect(authorizeToolGovernanceV1(approvedFacts())).toEqual({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: 'approve_once',
    });
    const approved = approvedFacts();
    for (const [index, override] of (
      [
        { approval: { approvedToolCallId: 'other-call' } },
        { invocation: { capabilityRevision: E }, policy: { capabilityRevision: E } },
        { invocation: { schemaDigest: E } },
        { invocation: { argumentsDigest: D } },
        { invocation: { bindingId: E } },
        { invocation: { builtinCatalogRevision: E } },
        { invocation: { effectiveEffectsDigest: E }, policy: { effectiveEffectsDigest: E } },
      ] as FactOverrides[]
    ).entries()) {
      const forged: ToolGovernanceFactsV1 = {
        ...approved,
        invocation: { ...approved.invocation, ...override.invocation },
        policy: { ...approved.policy, ...override.policy },
        approval: { ...approved.approval, ...override.approval },
      };
      const result = authorizeToolGovernanceV1(forged);
      expect(result, `forged approval case ${index}`).toMatchObject({
        kind: 'reject',
        code: 'approval_identity_mismatch',
      });
      expect(result.kind).not.toBe('request_approval');
    }
    expect(
      authorizeToolGovernanceV1(
        facts({
          approval: {
            status: 'approved',
            grant: 'none',
            approvedToolCallId: 'call-1',
            approvalBindingDigest: D,
          },
        }),
      ),
    ).toMatchObject({ kind: 'reject', code: 'invalid_facts' });
  });

  test('returns deep-frozen policy copies for approval and auto-review', () => {
    const manual = authorizeToolGovernanceV1(
      facts({
        policy: {
          decision: 'ask',
          allowed: true,
          requiresApproval: true,
          risk: 'write_file',
          effects: { externalWrite: true },
        },
      }),
    );
    expect(manual).toMatchObject({ kind: 'request_approval' });
    if (manual.kind !== 'request_approval') throw new Error('expected manual approval');
    expect(Object.isFrozen(manual.decision)).toBe(true);
    expect(Object.isFrozen(manual.decision.effects)).toBe(true);
    expect(Object.isFrozen(manual.decision.expectedEffects)).toBe(true);
    const auto = authorizeToolGovernanceV1(
      facts({
        policy: {
          decision: 'ask',
          allowed: true,
          requiresApproval: true,
          risk: 'execute_code',
        },
        context: { interactionMode: 'auto' },
      }),
    );
    expect(auto).toMatchObject({ kind: 'request_auto_review' });
  });

  test('keeps deny and planning phase denial ahead of full_access', () => {
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'deny',
            allowed: false,
            requiresApproval: false,
            risk: 'destructive',
            phaseConstraint: 'planning',
          },
          context: { phase: 'planning', authorizationMode: 'full_access' },
        }),
      ),
    ).toMatchObject({ kind: 'reject', failureKind: 'phase_deferred' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'deny',
            allowed: false,
            requiresApproval: false,
            risk: 'destructive',
          },
          context: { authorizationMode: 'full_access' },
        }),
      ),
    ).toMatchObject({ kind: 'reject', failureKind: 'policy_denied' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({ context: { authorizationMode: 'full_access', sandboxAvailable: false } }),
      ),
    ).toMatchObject({ code: 'authorization_elevation_denied' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          context: {
            authorizationMode: 'full_access',
            authorizationSource: 'system',
            autoReview: true,
          },
        }),
      ),
    ).toMatchObject({ code: 'authorization_elevation_denied' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          context: {
            authorizationMode: 'full_access',
            authorizationSource: 'system',
            loopMode: true,
          },
        }),
      ),
    ).toMatchObject({ code: 'authorization_elevation_denied' });
  });

  test('full_access and interaction full are separate, and static minimum user does not re-upgrade safe facts', () => {
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            risk: 'read',
            minimumApproval: 'user',
          },
          context: { authorizationMode: 'default' },
        }),
      ),
    ).toEqual({ kind: 'authorized', authorizationKind: 'policy_allow', grantUsed: 'none' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'write_file',
            minimumApproval: 'user',
          },
          context: { interactionMode: 'accept_edits', authorizationMode: 'default' },
        }),
      ),
    ).toEqual({ kind: 'authorized', authorizationKind: 'policy_allow', grantUsed: 'none' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            risk: 'execute_code',
            fullAccessMayBypassApproval: true,
          },
          context: { authorizationMode: 'full_access' },
        }),
      ),
    ).toEqual({ kind: 'authorized', authorizationKind: 'approved_call', grantUsed: 'full_access' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'execute_code',
            fullAccessMayBypassApproval: false,
          },
          context: { authorizationMode: 'full_access' },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'execute_code',
          },
          context: { interactionMode: 'full', authorizationMode: 'default' },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
  });

  test('requires a sandbox whenever the compiled policy requires one', () => {
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            requiresSandbox: true,
          },
          context: { sandboxAvailable: false },
        }),
      ),
    ).toMatchObject({
      kind: 'reject',
      code: 'authorization_elevation_denied',
    });
  });

  test('enforces exact, non-expired same-command grants without Host booleans', () => {
    const grant = {
      workspace: '/workspace',
      threadId: 'thread-1',
      commandDigest: D,
      source: 'user' as const,
      grantedAt: 10,
      expiresAt: 200,
    };
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          sameCommandGrant: grant,
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toEqual({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: 'same_command',
    });
    for (const change of [
      { workspace: '/other' },
      { threadId: 'other-thread' },
      { commandDigest: E },
      { expiresAt: 100 },
    ] as const) {
      expect(
        authorizeToolGovernanceV1(
          shellFacts({
            sameCommandGrant: { ...grant, ...change },
            policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
          }),
        ),
      ).toMatchObject({ kind: 'request_approval' });
    }
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          sameCommandGrant: grant,
          policy: { requiresApproval: true, sameCommandMayBypassApproval: false },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          sameCommandGrant: { ...grant, expiresAt: 200 },
          context: { observedAt: undefined },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          sameCommandGrant: { ...grant, grantedAt: 150 },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        shellFacts({
          sameCommandGrant: { ...grant, expiresAt: undefined },
          context: { observedAt: undefined },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      isValidToolGovernanceFactsV1(
        shellFacts({ sameCommandGrant: { ...grant, expiresAt: grant.grantedAt } }),
      ),
    ).toBe(false);
  });

  test('dynamic MCP minimum user remains manual under full_access, while read-only stays fast', () => {
    expect(
      authorizeToolGovernanceV1(dynamicMcpFacts({ context: { authorizationMode: 'full_access' } })),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        dynamicMcpFacts({
          dynamicMcp: { minimumApproval: 'none', readOnly: true },
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            fullAccessMayBypassApproval: true,
          },
        }),
      ),
    ).toEqual({ kind: 'authorized', authorizationKind: 'policy_allow', grantUsed: 'none' });
    expect(
      authorizeToolGovernanceV1(
        dynamicMcpFacts({
          dynamicMcp: { minimumApproval: 'auto_review', readOnly: true },
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            fullAccessMayBypassApproval: true,
          },
          context: { authorizationMode: 'full_access' },
        }),
      ),
    ).toMatchObject({ kind: 'request_auto_review' });
    expect(
      isValidToolGovernanceFactsV1(dynamicMcpFacts({ invocation: { builtinCatalogRevision: D } })),
    ).toBe(false);
  });

  test('nested Skill facts can only tighten activation and never lower it', () => {
    expect(
      authorizeToolGovernanceV1(
        activationFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            minimumApproval: 'user',
            fullAccessMayBypassApproval: true,
          },
          nestedSkill: { decision: 'allow', minimumApproval: 'none' },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        activationFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            minimumApproval: 'none',
            fullAccessMayBypassApproval: true,
          },
          nestedSkill: { decision: 'ask', minimumApproval: 'user' },
          context: { authorizationMode: 'full_access' },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernanceV1(
        activationFacts({ nestedSkill: { decision: 'deny', minimumApproval: 'none' } }),
      ),
    ).toMatchObject({ kind: 'reject', failureKind: 'policy_denied' });
    expect(
      authorizeToolGovernanceV1(
        activationFacts({
          policy: {
            decision: 'allow',
            allowed: true,
            requiresApproval: false,
            minimumApproval: 'none',
          },
          nestedSkill: { decision: 'allow', minimumApproval: 'auto_review' },
        }),
      ),
    ).toMatchObject({ kind: 'request_auto_review' });
    expect(
      isValidToolGovernanceFactsV1(
        facts({ nestedSkill: { decision: 'ask', minimumApproval: 'user' } }),
      ),
    ).toBe(false);
  });

  test('user input stays terminal and admission remains a separate State gate', () => {
    const input = facts({
      invocation: {
        exposedToolName: 'ask_user',
        operationId: 'builtin:ask_user',
        capabilityId: 'builtin:ask_user',
      },
      policy: {
        operationId: 'builtin:ask_user',
        decision: 'allow',
        allowed: true,
        requiresApproval: false,
        risk: 'plan',
      },
      context: { executionMechanism: 'user_input' },
      admission: { freshness: 'stale', reservationRequired: true },
    });
    expect(decideToolGovernanceV1(input)).toEqual({ kind: 'request_user_input' });
    const authorization = authorizeToolGovernanceV1(facts());
    expect(decideToolGovernanceV1(facts({ admission: { freshness: 'stale' } }))).toMatchObject({
      kind: 'reject',
      code: 'admission_stale',
    });
    expect(authorization).toEqual({
      kind: 'authorized',
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
    });
  });

  test('keeps deterministic immutable decisions and rejects malformed facts fail-closed', () => {
    const input = facts({
      policy: {
        decision: 'ask',
        allowed: true,
        requiresApproval: true,
        risk: 'network',
        effects: { network: true },
      },
      context: { interactionMode: 'auto' },
    });
    const before = JSON.stringify(input);
    const first = decideToolGovernanceV1(input);
    const second = decideToolGovernanceV1(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(decideToolGovernanceV1({})).toMatchObject({ code: 'invalid_facts' });
    expect(
      isValidToolGovernanceFactsV1(
        facts({ context: { gates: { recoveryAdmission: 'bad' as never } } }),
      ),
    ).toBe(false);
  });
});
