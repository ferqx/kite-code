import { describe, expect, test } from 'bun:test';
import { shellBuiltinPolicyRule } from '@kite-ai/builtin-runtime';
import type {
  CapabilityEffects,
  CapabilityPolicyCompilation,
  CapabilityPolicyContext,
} from '@kite-ai/runtime-spi';
import {
  authorizeToolGovernance,
  createToolApprovalBindingDigest,
  isValidToolGovernanceFacts,
  TOOL_GOVERNANCE_FACTS_SCHEMA_,
  type ToolGovernanceAdmissionFacts,
  type ToolGovernanceApprovalFact,
  type ToolGovernanceContextFacts,
  type ToolGovernanceFacts,
  type ToolGovernanceGateFacts,
  type ToolGovernanceInvocationFact,
  type ToolGovernancePolicyFact,
} from '../src/tool-governance';

const D = 'a'.repeat(64);
const E = 'b'.repeat(64);
const F = 'c'.repeat(64);
const WORKSPACE = '/workspace';

const DECLARED_SHELL_EFFECTS: CapabilityEffects = Object.freeze({
  filesystem: 'unknown',
  network: 'unknown',
  externalState: 'unknown',
});

const BASE_INVOCATION: ToolGovernanceInvocationFact = {
  workspace: WORKSPACE,
  threadId: 'thread-1',
  turnId: 'turn-1',
  modelMessageId: 'message-1',
  toolCallId: 'call-1',
  exposedToolName: 'shell_execute',
  operationId: 'builtin:shell_execute',
  capabilityId: 'builtin:shell_execute',
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
  commandDigest: D,
};

const BASE_POLICY: ToolGovernancePolicyFact = {
  operationId: 'builtin:shell_execute',
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
  reason: 'Workspace baseline shell operation.',
  expectedEffects: ['Reads the workspace baseline.'],
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
  sandboxAvailable: true,
  circuitBreakerTripped: false,
  executionMechanism: 'shell',
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
  };
}

function approvedFacts(grant: 'approve_once' | 'same_command'): ToolGovernanceFacts {
  const pending = facts({
    policy: {
      requiresApproval: true,
      decision: 'ask',
      risk: 'execute_code',
      sameCommandMayBypassApproval: grant === 'same_command',
    },
  });
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

function compileShell(
  command: string,
  phase: CapabilityPolicyContext['phase'],
): CapabilityPolicyCompilation {
  return shellBuiltinPolicyRule(
    { command },
    { workspace: WORKSPACE, phase },
    DECLARED_SHELL_EFFECTS,
    'user',
  ) as CapabilityPolicyCompilation;
}

describe('SAQ shell policy phase/mode matrix', () => {
  test.each([
    'ls -la',
    'git status',
    'ls -la && echo "---" && git log --oneline -15 && git status --short && git branch -a --no-color | head -20',
    'git status --short | head -60 && git branch --show-current && git remote -v | head -4',
  ])('Building Accept workspace baseline is direct without a command-name allowlist: %s', (command) => {
    const compiled = compileShell(command, 'building');
    expect(compiled).toMatchObject({
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      requiresSandbox: true,
      sandboxScope: {
        kind: 'baseline',
        filesystem: 'workspace_write',
        network: 'disabled',
      },
    });
    expect(compiled.reason).not.toMatch(/fixed command grammar|exact invocation/i);
  });

  test('Building Accept requests exact approval for an unproven project script', () => {
    expect(compileShell('bun test', 'building')).toMatchObject({
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      effects: { uncertainEffects: true },
      sandboxScope: {
        kind: 'baseline',
        filesystem: 'workspace_write',
        network: 'disabled',
      },
    });
  });

  test.each([
    'ls -la .git',
    'git status --short',
  ])('Planning Accept/Auto workspace baseline remains direct: %s', (command) => {
    const compiled = compileShell(command, 'planning');
    expect(compiled).toMatchObject({
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      requiresSandbox: true,
      sandboxScope: {
        kind: 'baseline',
        filesystem: 'read_only',
        network: 'disabled',
      },
    });
    expect(compiled.phaseConstraint).toBeUndefined();
  });

  test.each([
    'cat /tmp/known-outside.txt',
    'printf x > /tmp/known-outside.txt',
  ])('Planning known expanded scope is separately reviewable rather than globally denied: %s', (command) => {
    const compiled = compileShell(command, 'planning');
    expect(compiled.decision).toBe('ask');
    expect(compiled.allowed).toBe(true);
    expect(compiled.requiresApproval).toBe(true);
    expect(compiled.requiresSandbox).toBe(true);
    expect(compiled.phaseConstraint).toBeUndefined();
    expect(compiled.effects).toBeDefined();
    expect(compiled.sandboxScope).toMatchObject({ kind: 'expanded', filesystem: 'full_access' });
  });

  test('Planning known workspace mutation requests the minimal workspace_write expansion', () => {
    const compiled = compileShell('touch plan-output.txt', 'planning');
    expect(compiled).toMatchObject({
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      requiresSandbox: true,
      risk: 'write_file',
      sandboxScope: {
        kind: 'expanded',
        filesystem: 'workspace_write',
        network: 'disabled',
      },
    });
  });

  test('network expansion does not implicitly widen the filesystem scope', () => {
    expect(compileShell('git push origin main', 'building')).toMatchObject({
      decision: 'ask',
      sandboxScope: {
        kind: 'expanded',
        filesystem: 'workspace_write',
        network: 'allow_all',
      },
    });
    expect(compileShell('git push origin main', 'planning')).toMatchObject({
      decision: 'ask',
      sandboxScope: {
        kind: 'expanded',
        filesystem: 'read_only',
        network: 'allow_all',
      },
    });
  });

  test('Building Full is direct from interactionMode=full without authorizationMode elevation', () => {
    const compiled = shellBuiltinPolicyRule(
      { command: 'cat /tmp/full-mode.txt' },
      { workspace: WORKSPACE, phase: 'building', interactionMode: 'full' },
      DECLARED_SHELL_EFFECTS,
      'user',
    ) as CapabilityPolicyCompilation;
    expect(compiled).toMatchObject({
      requiresSandbox: false,
      sandboxScope: { kind: 'unrestricted', filesystem: 'full_access', network: 'allow_all' },
    });
    const decision = authorizeToolGovernance(
      facts({
        context: {
          interactionMode: 'full',
          phase: 'building',
        },
        policy: {
          decision: 'ask',
          allowed: true,
          requiresApproval: true,
          fullAccessMayBypassApproval: true,
          risk: 'execute_code',
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: 'authorized',
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
    });
  });

  test('restricted Shell requires a sandbox while Full remains the sole unrestricted authority', () => {
    expect(
      authorizeToolGovernance(
        facts({
          context: { sandboxAvailable: false, interactionMode: 'accept_edits' },
          policy: { requiresSandbox: true },
        }),
      ),
    ).toMatchObject({
      kind: 'reject',
      failureKind: 'mandatory_policy_unavailable',
      code: 'authorization_elevation_denied',
    });
    expect(
      authorizeToolGovernance(
        facts({
          context: { sandboxAvailable: false, interactionMode: 'full' },
          policy: { requiresSandbox: false },
        }),
      ),
    ).toMatchObject({ kind: 'authorized', authorizationKind: 'policy_allow' });
  });

  test('Planning Full keeps the planning phase while using interactionMode as the sole mode authority', () => {
    const decision = authorizeToolGovernance(
      facts({
        context: {
          phase: 'planning',
          interactionMode: 'full',
        },
        policy: {
          decision: 'allow',
          allowed: true,
          requiresApproval: false,
          risk: 'read',
          reason: 'Read-only planning inspection.',
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'authorized', authorizationKind: 'policy_allow' });
  });

  test('known expanded scope separates user approval and Auto review', () => {
    const policy: Partial<ToolGovernancePolicyFact> = {
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      risk: 'unknown',
      effects: { externalRead: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    };
    expect(
      authorizeToolGovernance(facts({ context: { interactionMode: 'accept_edits' }, policy })),
    ).toMatchObject({ kind: 'request_approval' });
    expect(
      authorizeToolGovernance(facts({ context: { interactionMode: 'auto' }, policy })),
    ).toMatchObject({ kind: 'request_auto_review' });
  });

  test('uncertain effects never become an implicit allow', () => {
    const decision = authorizeToolGovernance(
      facts({
        context: { interactionMode: 'accept_edits' },
        policy: {
          decision: 'allow',
          allowed: true,
          requiresApproval: false,
          risk: 'unknown',
          effects: { uncertainEffects: true },
          fullAccessMayBypassApproval: false,
        },
      }),
    );
    expect(decision.kind).not.toBe('authorized');
  });
});

describe('SAQ approval grant contract', () => {
  test.each(['approve_once', 'same_command'] as const)('%s remains a valid grant', (grant) => {
    expect(authorizeToolGovernance(approvedFacts(grant))).toMatchObject({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: grant,
    });
  });

  test('legacy full_access is not a valid approval grant', () => {
    const pending = facts({
      policy: {
        decision: 'ask',
        allowed: true,
        requiresApproval: true,
        risk: 'execute_code',
      },
    });
    const legacy = {
      ...pending,
      approval: {
        status: 'approved' as const,
        grant: 'full_access' as never,
        approvedToolCallId: pending.invocation.toolCallId,
        approvalBindingDigest: createToolApprovalBindingDigest(pending.invocation, pending.policy),
      },
    };
    expect(isValidToolGovernanceFacts(legacy)).toBe(false);
    expect(authorizeToolGovernance(legacy)).not.toMatchObject({ kind: 'authorized' });
  });

  test('same-command grants require the expanded session/scope identity, not only a digest', () => {
    const pending = facts({
      policy: {
        decision: 'ask',
        allowed: true,
        requiresApproval: true,
        risk: 'execute_code',
        sameCommandMayBypassApproval: true,
      },
    });
    const legacyMinimalGrant = {
      ...pending,
      sameCommandGrant: {
        workspace: WORKSPACE,
        threadId: 'thread-1',
        commandDigest: D,
        source: 'user',
        grantedAt: 0,
      } as never,
    };
    expect(authorizeToolGovernance(legacyMinimalGrant)).not.toMatchObject({ kind: 'authorized' });
  });
});
