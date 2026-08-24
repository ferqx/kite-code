import { describe, expect, test } from 'bun:test';
import {
  authorizeToolGovernance,
  createToolApprovalBindingDigest,
  createToolGovernanceCommandDigest,
  decideToolGovernance,
  isValidToolGovernanceFacts,
  TOOL_GOVERNANCE_FACTS_SCHEMA_,
  type ToolGovernanceAdmissionFacts,
  type ToolGovernanceApprovalFact,
  type ToolGovernanceContextFacts,
  type ToolGovernanceFacts,
  type ToolGovernanceGateFacts,
  type ToolGovernanceInvocationFact,
  type ToolGovernancePolicyFact,
  toolGovernanceFactsInvalidReason,
} from '../src/tool-governance';

const D = 'a'.repeat(64);
const E = 'b'.repeat(64);
const F = 'c'.repeat(64);

const BASE_INVOCATION: ToolGovernanceInvocationFact = {
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

const BASE_POLICY: ToolGovernancePolicyFact = {
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
  expectedEffects: ['Reads fixture data'],
};

const BASE_GATES: ToolGovernanceGateFacts = {
  recoveryAdmission: 'admitted',
  boundedCancellation: 'admitted',
  executionBoundary: 'admitted',
  skillCapabilityCeiling: 'admitted',
};

const BASE_CONTEXT: ToolGovernanceContextFacts = {
  phase: 'building',
  interactionMode: 'accept_edits',
  authorizationMode: 'default',
  sandboxAvailable: true,
  circuitBreakerTripped: false,
  executionMechanism: 'other',
  gates: BASE_GATES,
  observedAt: 100,
};

const BASE_ADMISSION: ToolGovernanceAdmissionFacts = {
  freshness: 'current',
  reservationRequired: false,
  reservationIds: [],
};

const QUEUED_APPROVAL: ToolGovernanceApprovalFact = {
  status: 'queued',
  grant: 'none',
  approvedToolCallId: null,
  approvalBindingDigest: null,
};

type FactOverrides = {
  readonly invocation?: Partial<ToolGovernanceInvocationFact>;
  readonly policy?: Partial<ToolGovernancePolicyFact>;
  readonly context?: Partial<Omit<ToolGovernanceContextFacts, 'gates'>> & {
    readonly gates?: Partial<ToolGovernanceGateFacts>;
  };
  readonly admission?: Partial<ToolGovernanceAdmissionFacts>;
  readonly approval?: Partial<ToolGovernanceApprovalFact>;
  readonly sameCommandGrant?: ToolGovernanceFacts['sameCommandGrant'];
  readonly dynamicMcp?: ToolGovernanceFacts['dynamicMcp'];
  readonly nestedSkill?: ToolGovernanceFacts['nestedSkill'];
};

function facts(overrides: FactOverrides = {}): ToolGovernanceFacts {
  const invocation = { ...BASE_INVOCATION, ...overrides.invocation };
  const context = {
    ...BASE_CONTEXT,
    ...overrides.context,
    gates: { ...BASE_GATES, ...overrides.context?.gates },
  };
  return {
    schema: TOOL_GOVERNANCE_FACTS_SCHEMA_,
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
): ToolGovernanceFacts {
  const pending = facts(overrides);
  return {
    ...pending,
    approval: {
      status: 'approved',
      grant,
      approvedToolCallId: pending.invocation.toolCallId,
      approvalBindingDigest: createToolApprovalBindingDigest(pending.invocation, pending.policy),
    },
  };
}

function shellFacts(overrides: FactOverrides = {}): ToolGovernanceFacts {
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

function activationFacts(overrides: FactOverrides = {}): ToolGovernanceFacts {
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

function dynamicMcpFacts(overrides: FactOverrides = {}): ToolGovernanceFacts {
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
    expect(createToolGovernanceCommandDigest('  echo hello  ')).toBe(
      '40a497646523116499ac8d2aeb78ce0c3c6643ce6f09805c21db3909fc614d3e',
    );
    expect(createToolGovernanceCommandDigest('echo  hello')).toBe(
      '37b2f209ba15e46cc8f5ad68fb665df968549d78c7983ba307a7ae34c7d3a949',
    );
    expect(createToolGovernanceCommandDigest('   ')).toBeNull();
  });

  test('requires complete invocation/policy identity and rejects legacy authority fields', () => {
    expect(isValidToolGovernanceFacts(facts())).toBe(true);
    expect(
      isValidToolGovernanceFacts({
        ...facts(),
        context: { ...facts().context, callStatus: 'queued' },
      }),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts({
        ...facts(),
        policy: { ...facts().policy, grantUsed: 'full_access' },
      }),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts(facts({ invocation: { capabilityRevision: 'A'.repeat(64) } })),
    ).toBe(false);
    expect(isValidToolGovernanceFacts(facts({ invocation: { toolCallId: '' } }))).toBe(false);
    expect(isValidToolGovernanceFacts(facts({ policy: { parserRevision: E } }))).toBe(false);
    expect(
      isValidToolGovernanceFacts(
        facts({
          invocation: { builtinCatalogRevision: null, dynamicCatalogRevision: D },
        }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts(
        facts({
          invocation: { builtinCatalogRevision: D, dynamicCatalogRevision: D },
        }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts(facts({ invocation: { exposedToolName: 'mcp__server__tool' } })),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts(
        dynamicMcpFacts({ invocation: { exposedToolName: 'ordinary_tool' } }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts(
        dynamicMcpFacts({ invocation: { capabilityId: 'mcp:dynamic_tool' } }),
      ),
    ).toBe(false);
    expect(
      isValidToolGovernanceFacts({
        ...dynamicMcpFacts(),
        dynamicMcp: undefined,
      }),
    ).toBe(false);
    expect(
      toolGovernanceFactsInvalidReason({
        ...facts(),
        context: { ...facts().context, callStatus: 'queued' },
      }),
    ).toBe('context');
    expect(toolGovernanceFactsInvalidReason(facts({ invocation: { toolCallId: '' } }))).toBe(
      'invocation',
    );
    expect(
      toolGovernanceFactsInvalidReason(
        facts({ invocation: { builtinCatalogRevision: null, dynamicCatalogRevision: D } }),
      ),
    ).toBe('identity');
    expect(
      isValidToolGovernanceFacts(
        facts({
          dynamicMcp: { minimumApproval: 'none', readOnly: true },
        }),
      ),
    ).toBe(false);
  });

  test('binds deterministic approval digest to every identity and policy field', () => {
    const first = createToolApprovalBindingDigest(BASE_INVOCATION, BASE_POLICY);
    const second = createToolApprovalBindingDigest(BASE_INVOCATION, BASE_POLICY);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(second);
    expect(
      createToolApprovalBindingDigest({ ...BASE_INVOCATION, toolCallId: 'call-2' }, BASE_POLICY),
    ).not.toBe(first);
    expect(
      createToolApprovalBindingDigest(BASE_INVOCATION, {
        ...BASE_POLICY,
        reason: 'Different policy fact.',
      }),
    ).not.toBe(first);
    expect(
      createToolApprovalBindingDigest(
        { ...BASE_INVOCATION, nestedCapabilityRevision: E },
        BASE_POLICY,
      ),
    ).not.toBe(first);
  });

  test('authorizes only an exact approved call and carries Kernel grantUsed', () => {
    expect(authorizeToolGovernance(approvedFacts())).toEqual({
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
      const forged: ToolGovernanceFacts = {
        ...approved,
        invocation: { ...approved.invocation, ...override.invocation },
        policy: { ...approved.policy, ...override.policy },
        approval: { ...approved.approval, ...override.approval },
      };
      const result = authorizeToolGovernance(forged);
      expect(result, `forged approval case ${index}`).toMatchObject({
        kind: 'reject',
        code: 'approval_identity_mismatch',
      });
      expect(result.kind).not.toBe('request_approval');
    }
    expect(
      authorizeToolGovernance(
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
    const manual = authorizeToolGovernance(
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
    const auto = authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
        shellFacts({ context: { authorizationMode: 'full_access', sandboxAvailable: false } }),
      ),
    ).toMatchObject({ code: 'authorization_elevation_denied' });
    expect(
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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

  test('routes sensitive external access by interaction mode without overriding full access', () => {
    expect(
      authorizeToolGovernance(
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
      authorizeToolGovernance(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'write_file',
            effects: { externalWrite: true },
            fullAccessMayBypassApproval: true,
          },
          context: { interactionMode: 'accept_edits', authorizationMode: 'default' },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'read',
            minimumApproval: 'user',
            effects: { externalRead: true, sensitiveExternalAccess: true },
            fullAccessMayBypassApproval: true,
          },
          context: { interactionMode: 'full', authorizationMode: 'full_access' },
        }),
      ),
    ).toEqual({ kind: 'authorized', authorizationKind: 'approved_call', grantUsed: 'full_access' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'read',
            minimumApproval: 'user',
            effects: { externalRead: true, sensitiveExternalAccess: true },
            fullAccessMayBypassApproval: true,
          },
          context: { interactionMode: 'auto', authorizationMode: 'default' },
        }),
      ),
    ).toMatchObject({ kind: 'request_auto_review' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          policy: {
            decision: 'ask',
            allowed: true,
            requiresApproval: true,
            risk: 'read',
            minimumApproval: 'user',
            effects: { externalRead: true, sensitiveExternalAccess: true },
            fullAccessMayBypassApproval: true,
          },
          context: {
            interactionMode: 'auto',
            authorizationMode: 'default',
            circuitBreakerTripped: true,
          },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
        authorizeToolGovernance(
          shellFacts({
            sameCommandGrant: { ...grant, ...change },
            policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
          }),
        ),
      ).toMatchObject({ kind: 'request_approval' });
    }
    expect(
      authorizeToolGovernance(
        shellFacts({
          sameCommandGrant: grant,
          policy: { requiresApproval: true, sameCommandMayBypassApproval: false },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          sameCommandGrant: { ...grant, expiresAt: 200 },
          context: { observedAt: undefined },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          sameCommandGrant: { ...grant, grantedAt: 150 },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
        shellFacts({
          sameCommandGrant: { ...grant, expiresAt: undefined },
          context: { observedAt: undefined },
          policy: { requiresApproval: true, sameCommandMayBypassApproval: true },
        }),
      ),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      isValidToolGovernanceFacts(
        shellFacts({ sameCommandGrant: { ...grant, expiresAt: grant.grantedAt } }),
      ),
    ).toBe(false);
  });

  test('dynamic MCP minimum user remains manual under full_access, while read-only stays fast', () => {
    expect(
      authorizeToolGovernance(dynamicMcpFacts({ context: { authorizationMode: 'full_access' } })),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      isValidToolGovernanceFacts(dynamicMcpFacts({ invocation: { builtinCatalogRevision: D } })),
    ).toBe(false);
  });

  test('nested Skill facts can only tighten activation and never lower it', () => {
    expect(
      authorizeToolGovernance(
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
      authorizeToolGovernance(
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
      authorizeToolGovernance(
        activationFacts({ nestedSkill: { decision: 'deny', minimumApproval: 'none' } }),
      ),
    ).toMatchObject({ kind: 'reject', failureKind: 'policy_denied' });
    expect(
      authorizeToolGovernance(
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
      isValidToolGovernanceFacts(
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
    expect(decideToolGovernance(input)).toEqual({ kind: 'request_user_input' });
    const authorization = authorizeToolGovernance(facts());
    expect(decideToolGovernance(facts({ admission: { freshness: 'stale' } }))).toMatchObject({
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
    const first = decideToolGovernance(input);
    const second = decideToolGovernance(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(decideToolGovernance({})).toMatchObject({ code: 'invalid_facts' });
    expect(
      isValidToolGovernanceFacts(
        facts({ context: { gates: { recoveryAdmission: 'bad' as never } } }),
      ),
    ).toBe(false);
  });
});
