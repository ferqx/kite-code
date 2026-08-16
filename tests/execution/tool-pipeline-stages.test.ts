import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createBinding,
  createSnapshot,
  descriptorRevision,
  digestCapability,
} from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import type {
  ClassifiedInvocationV1,
  ResolvedInvocationV1,
  ToolCallSnapshotV1,
  ToolPipelineResolutionContextV1,
  ValidatedInvocationV1,
} from '@/core/execution/tool-pipeline';
import {
  classifyValidatedToolInvocationV1,
  createToolCallSnapshotV1,
  resolveToolInvocationV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  CapabilityDisclosure,
} from '@/protocol/capabilities';

const TURN_ID = 'turn-tool-pipeline-1';

function resolutionContext(
  overrides: Partial<ToolPipelineResolutionContextV1> = {},
): ToolPipelineResolutionContextV1 {
  const descriptors = overrides.descriptors ?? [];
  return {
    currentTurnId: TURN_ID,
    catalogRevision: createSnapshot([...descriptors]).revision,
    availabilityContext: {
      workspace: '/workspace',
      phase: 'building',
      hasTaskAdapter: true,
      availableSkillIds: ['skill:fixture'],
      featureFlags: getFeatureFlags({
        features: { skillWorkflowV1: true, skillActivationV2: true },
      }),
    },
    bindings: [],
    descriptors,
    disclosures: [],
    ...overrides,
  };
}

function snapshot(input: {
  name: string;
  rawArguments: unknown;
  binding?: CapabilityBinding;
  turnId?: string;
}): Readonly<ToolCallSnapshotV1> {
  const result = createToolCallSnapshotV1({
    toolCallId: `call-${input.name}`,
    name: input.name,
    rawArguments: input.rawArguments,
    createdAtTurnId: input.turnId ?? TURN_ID,
    bindingId: input.binding?.bindingId,
    capabilityId: input.binding?.capabilityId,
    capabilityRevision: input.binding?.capabilityRevision,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

function resolved(
  call: Readonly<ToolCallSnapshotV1>,
  context = resolutionContext(),
): Readonly<ResolvedInvocationV1> {
  const result = resolveToolInvocationV1(call, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

function validated(invocation: Readonly<ResolvedInvocationV1>): Readonly<ValidatedInvocationV1> {
  const result = validateResolvedToolInvocationV1(invocation);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

function classified(invocation: Readonly<ValidatedInvocationV1>): Readonly<ClassifiedInvocationV1> {
  const result = classifyValidatedToolInvocationV1(invocation);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

function mcpDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: 'mcp:fixture/search',
    kind: 'mcp_tool',
    displayName: 'Fixture search',
    description: 'Search the fixture provider.',
    provider: { type: 'mcp', id: 'fixture', version: '1', provenance: 'user' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
      },
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
  const merged = { ...withoutRevision, ...overrides };
  return {
    ...merged,
    revision: overrides.revision ?? descriptorRevision(merged),
  };
}

function skillDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: 'skill:fixture',
    kind: 'skill',
    displayName: 'Fixture Skill',
    description: 'Run the fixture workflow.',
    provider: { type: 'skill', id: 'fixture', provenance: 'project' },
    inputSchema: { type: 'object', additionalProperties: true },
    declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    policy: { workspaceTrustRequired: true, minimumApproval: 'user' },
    execution: { retry: 'never' },
    availability: 'available',
    diagnostics: [],
  };
  const merged = { ...withoutRevision, ...overrides };
  return {
    ...merged,
    revision: overrides.revision ?? descriptorRevision(merged),
  };
}

describe('Tool Pipeline V1 pure stages', () => {
  test('captures canonical JSON arguments as an immutable snapshot', () => {
    const rawArguments = { path: 'src/index.ts', options: { offset: 1 }, order: ['a', 'b'] };
    const call = snapshot({ name: 'read_file', rawArguments });

    rawArguments.path = 'changed.ts';
    rawArguments.options.offset = 99;
    rawArguments.order.reverse();

    expect(call.rawArguments).toEqual({
      path: 'src/index.ts',
      options: { offset: 1 },
      order: ['a', 'b'],
    });
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.rawArguments)).toBe(true);
  });

  test('rejects non-canonical JSON before resolution', () => {
    const invalidValues: unknown[] = [
      { value: undefined },
      { value: Number.NaN },
      { value: () => 'closure' },
      Object.assign(Object.create({ inherited: true }), { value: 'x' }),
      Object.defineProperty({}, 'value', { enumerable: true, get: () => 'x' }),
    ];
    const sparse: unknown[] = [];
    sparse[1] = 'x';
    const symbolKey = { value: 'x' };
    Object.defineProperty(symbolKey, Symbol('hidden'), { value: 'x' });
    const nonEnumerable = { value: 'x' };
    Object.defineProperty(nonEnumerable, 'hidden', { value: 'x' });
    invalidValues.push(sparse, symbolKey, nonEnumerable, { value: '\ud800' });

    for (const rawArguments of invalidValues) {
      const result = createToolCallSnapshotV1({
        toolCallId: 'call-invalid',
        name: 'read_file',
        rawArguments,
        createdAtTurnId: TURN_ID,
      });
      expect(result).toEqual({
        ok: false,
        failure: {
          stage: 'snapshot',
          code: 'arguments_not_canonical_json',
          toolCallId: 'call-invalid',
          toolName: 'read_file',
        },
      });
    }
  });

  test('resolves, validates, and classifies a builtin read without dispatching it', () => {
    const result = classified(
      validated(resolved(snapshot({ name: 'read_file', rawArguments: { path: 'src/index.ts' } }))),
    );

    expect(result.validated.resolved.target).toMatchObject({
      executionFamily: 'builtin',
      toolKind: 'computer',
      exposedToolName: 'read_file',
      binding: null,
    });
    expect(result.validated.request).toMatchObject({
      source: 'builtin',
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
    });
    expect(result).toMatchObject({
      effectClass: 'read_only',
      risk: 'read',
      sideEffect: false,
      requirements: {
        intent: 'required_before_dispatch',
        receipt: 'observation_receipt',
        retry: 'safe_read_candidate',
        verification: 'not_required_by_classification',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.validated.request.arguments)).toBe(true);
  });

  test('classifies a workspace mutation and a role-scoped subagent from validated facts', () => {
    const write = classified(
      validated(
        resolved(
          snapshot({
            name: 'write_file',
            rawArguments: { path: 'notes.txt', content: 'fixture' },
          }),
        ),
      ),
    );
    expect(write).toMatchObject({
      effectClass: 'workspace_write',
      risk: 'workspace_write',
      sideEffect: true,
      requirements: {
        intent: 'required_before_dispatch',
        receipt: 'effect_receipt',
        retry: 'none',
        verification: 'after_committed_receipt',
      },
    });

    const review = classified(
      validated(
        resolved(
          snapshot({
            name: 'task',
            rawArguments: {
              subagent_type: 'review',
              task: 'Review the fixture implementation.',
            },
          }),
        ),
      ),
    );
    expect(review.validated.resolved.target.executionFamily).toBe('subagent');
    expect(review.validated.subagentRole).toBe('review');
    expect(review).toMatchObject({
      effectClass: 'read_only',
      sideEffect: false,
      requirements: { receipt: 'observation_receipt' },
    });

    const code = classified(
      validated(
        resolved(
          snapshot({
            name: 'task',
            rawArguments: {
              subagent_type: 'code',
              task: 'Implement the fixture change safely.',
            },
          }),
        ),
      ),
    );
    expect(code.validated.subagentRole).toBe('code');
    expect(code.capability.effectClass).toBe('workspace_write');
  });

  test('fails closed for unknown, unavailable, stale-turn, and invalid builtin calls', () => {
    const unknown = resolveToolInvocationV1(
      snapshot({ name: 'not_a_tool', rawArguments: {} }),
      resolutionContext(),
    );
    expect(unknown).toMatchObject({ ok: false, failure: { code: 'unknown_tool' } });

    const unavailable = resolveToolInvocationV1(
      snapshot({
        name: 'task',
        rawArguments: { subagent_type: 'review', task: 'Review the fixture change.' },
      }),
      resolutionContext({
        availabilityContext: { workspace: '/workspace', hasTaskAdapter: false },
      }),
    );
    expect(unavailable).toMatchObject({ ok: false, failure: { code: 'tool_unavailable' } });

    const staleTurn = resolveToolInvocationV1(
      snapshot({ name: 'read_file', rawArguments: { path: 'x' }, turnId: 'turn-old' }),
      resolutionContext(),
    );
    expect(staleTurn).toMatchObject({ ok: false, failure: { code: 'call_turn_mismatch' } });

    const invalid = validateResolvedToolInvocationV1(
      resolved(snapshot({ name: 'read_file', rawArguments: { path: 42 } })),
    );
    expect(invalid).toMatchObject({ ok: false, failure: { code: 'invalid_arguments' } });
  });

  test('validates an MCP binding and applies schema defaults before classification', () => {
    const descriptor = mcpDescriptor();
    const binding = createBinding({
      descriptor,
      exposedToolName: 'mcp__fixture__search',
      turnId: TURN_ID,
    });
    const context = resolutionContext({ bindings: [binding], descriptors: [descriptor] });
    const result = classified(
      validated(
        resolved(
          snapshot({
            name: binding.exposedToolName,
            rawArguments: { query: 'needle' },
            binding,
          }),
          context,
        ),
      ),
    );

    expect(result.validated.resolved.target.executionFamily).toBe('mcp');
    expect(result.validated.request).toMatchObject({
      source: 'mcp',
      arguments: { query: 'needle', limit: 10 },
      schemaDigest: binding.schemaDigest,
    });
    expect(result).toMatchObject({
      effectClass: 'read_only',
      risk: 'network',
      minimumApproval: 'none',
      requirements: {
        intent: 'required_before_dispatch',
        receipt: 'observation_receipt',
        retry: 'safe_read_candidate',
      },
    });
  });

  test('rejects stale or inconsistent MCP identity and schema facts', () => {
    const descriptor = mcpDescriptor();
    const binding = createBinding({
      descriptor,
      exposedToolName: 'mcp__fixture__search',
      turnId: TURN_ID,
    });
    const call = snapshot({
      name: binding.exposedToolName,
      rawArguments: { query: 'needle' },
      binding,
    });

    const staleBinding = resolveToolInvocationV1(
      call,
      resolutionContext({
        bindings: [{ ...binding, issuedForTurnId: 'turn-old' }],
        descriptors: [descriptor],
      }),
    );
    expect(staleBinding).toMatchObject({
      ok: false,
      failure: { code: 'binding_turn_mismatch' },
    });

    const renamedBinding = resolveToolInvocationV1(
      call,
      resolutionContext({
        bindings: [{ ...binding, exposedToolName: 'mcp__fixture__other' }],
        descriptors: [descriptor],
      }),
    );
    expect(renamedBinding).toMatchObject({
      ok: false,
      failure: { code: 'binding_name_mismatch' },
    });

    const staleSchemaDigest = digestCapability({ changed: true });
    const staleSchemaBinding = {
      ...binding,
      schemaDigest: staleSchemaDigest,
      bindingId: digestCapability({
        capabilityId: binding.capabilityId,
        revision: binding.capabilityRevision,
        exposedToolName: binding.exposedToolName,
        schemaDigest: staleSchemaDigest,
        turnId: binding.issuedForTurnId,
      }),
    };
    const schemaDrift = validateResolvedToolInvocationV1(
      resolved(
        snapshot({
          name: binding.exposedToolName,
          rawArguments: { query: 'needle' },
          binding: staleSchemaBinding,
        }),
        resolutionContext({
          bindings: [staleSchemaBinding],
          descriptors: [descriptor],
        }),
      ),
    );
    expect(schemaDrift).toMatchObject({
      ok: false,
      failure: { code: 'schema_digest_mismatch' },
    });

    const effectDrift = resolveToolInvocationV1(
      call,
      resolutionContext({
        bindings: [binding],
        descriptors: [
          {
            ...descriptor,
            effectiveEffects: {
              filesystem: 'write',
              network: 'write',
              externalState: 'write',
            },
          },
        ],
      }),
    );
    expect(effectDrift).toMatchObject({
      ok: false,
      failure: { code: 'descriptor_revision_mismatch' },
    });
  });

  test('requires a same-turn Skill disclosure before nested capability classification', () => {
    const descriptor = skillDescriptor();
    const disclosure: CapabilityDisclosure = {
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      issuedForTurnId: TURN_ID,
    };
    const invocation = resolved(
      snapshot({
        name: 'activate_skill',
        rawArguments: { skill_id: descriptor.capabilityId, input: {} },
      }),
      resolutionContext({ descriptors: [descriptor], disclosures: [disclosure] }),
    );
    const result = classified(validated(invocation));

    expect(result.validated.resolved.target.executionFamily).toBe('skill');
    expect(result.validated.nestedCapability?.descriptor.capabilityId).toBe('skill:fixture');
    expect(result).toMatchObject({
      effectClass: 'external_side_effect',
      risk: 'workspace_write',
      sideEffect: true,
      minimumApproval: 'user',
      requirements: {
        intent: 'required_before_dispatch',
        receipt: 'effect_receipt',
        retry: 'none',
        verification: 'after_committed_receipt',
      },
    });

    const stale = validateResolvedToolInvocationV1(
      resolved(
        snapshot({
          name: 'activate_skill',
          rawArguments: { skill_id: descriptor.capabilityId, input: {} },
        }),
        resolutionContext({
          descriptors: [descriptor],
          disclosures: [{ ...disclosure, issuedForTurnId: 'turn-old' }],
        }),
      ),
    );
    expect(stale).toMatchObject({ ok: false, failure: { code: 'disclosure_stale' } });
  });

  test('keeps TP-01 stages disconnected from policy, persistence, provider, and dispatch', () => {
    const source = readFileSync(
      new URL('../../src/core/execution/tool-pipeline/stages.ts', import.meta.url),
      'utf8',
    );

    for (const forbidden of [
      'tool-controller',
      'tool-runner',
      '/mcp/manager',
      'invokeGovernedTool',
      'dispatchRegisteredTool',
      'executeRuntimeTools',
      'ensureProviderReady',
      'callCapability',
      'persistEvent',
      'RuntimeStore',
      'PolicyDecision',
      '@/core/approval',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
