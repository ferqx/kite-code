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
  ToolPipelinePolicyContextV1,
  ToolPipelineResolutionContextV1,
  ValidatedInvocationV1,
} from '@/core/execution/tool-pipeline';
import {
  admitAuthorizedToolInvocationV1,
  authorizePolicyEvaluatedToolV1,
  classifyValidatedToolInvocationV1,
  commitNormalizedToolReceiptV1,
  confirmedToolDispatchFailureOutcomeV1,
  createToolCallSnapshotV1,
  dispatchAdmittedToolInvocationV1,
  evaluateClassifiedToolPolicyV1,
  evaluateToolPreResolutionPolicyV1,
  normalizeDispatchedToolOutcomeV1,
  planCommittedToolVerificationV1,
  recordNormalizedToolResultV1,
  resolveToolInvocationV1,
  ToolInvocationDispatchErrorV1,
  ToolInvocationPersistenceErrorV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
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

function policyContext(
  overrides: Partial<ToolPipelinePolicyContextV1> = {},
): ToolPipelinePolicyContextV1 {
  return {
    phase: 'building',
    workspace: '/workspace',
    threadId: 'thread-tool-pipeline',
    authorization: { mode: 'default', commandGrants: {} },
    interactionMode: 'accept_edits',
    planKind: 'building_without_plan',
    circuitBreakerTripped: false,
    callStatus: 'queued',
    gates: {
      recoveryAdmission: 'admitted',
      boundedCancellation: 'admitted',
      executionBoundary: 'admitted',
      skillCapabilityCeiling: 'admitted',
    },
    ...overrides,
  };
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

  test('rejects mixed raw/private task arguments before child Provider dispatch', () => {
    const mixedTask = snapshot({
      name: 'task',
      rawArguments: {
        subagent_type: 'review',
        task: 'Review the fixture implementation.',
        taskArtifact: {
          artifactId: `pa_${'a'.repeat(64)}`,
          kind: 'subagent_task_request',
          integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
          byteLength: 256,
        },
      },
    });
    const resolvedMixedTask = resolveToolInvocationV1(mixedTask, resolutionContext());
    expect(resolvedMixedTask.ok).toBe(true);
    if (!resolvedMixedTask.ok) return;

    const invalid = validateResolvedToolInvocationV1(resolvedMixedTask.value);
    expect(invalid).toMatchObject({
      ok: false,
      failure: { stage: 'validate', code: 'invalid_arguments', toolName: 'task' },
    });

    // A failed validation has no admissible invocation, so the child adapter
    // cannot be entered and no child Provider dispatch is possible.
    let childProviderDispatches = 0;
    if (invalid.ok) childProviderDispatches += 1;
    expect(childProviderDispatches).toBe(0);
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

  test('advances a policy-allowed read through authorization and local admission', () => {
    const invocation = classified(
      validated(resolved(snapshot({ name: 'read_file', rawArguments: { path: 'README.md' } }))),
    );
    const policy = evaluateClassifiedToolPolicyV1(invocation, policyContext());
    expect(policy.kind).toBe('continue');
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext());
    expect(authorization.kind).toBe('continue');
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
    const admission = admitAuthorizedToolInvocationV1(authorization.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    expect(admission).toMatchObject({
      kind: 'continue',
      value: { stage: 'admitted', reservationIds: [] },
    });
  });

  test('rejects sealed Provider paths before catalog resolution', () => {
    const providerCall = snapshot({ name: 'mcp__fixture__search', rawArguments: {} });
    expect(
      evaluateToolPreResolutionPolicyV1(providerCall, { providerAccess: 'blocked' }),
    ).toMatchObject({
      kind: 'reject',
      failureKind: 'mandatory_policy_unavailable',
    });
    expect(
      evaluateToolPreResolutionPolicyV1(providerCall, { providerAccess: 'admitted' }),
    ).toBeNull();
  });

  test('projects policy denial, approval, auto-review, and ask_user as explicit early terminals', () => {
    const shell = classified(
      validated(
        resolved(snapshot({ name: 'shell_execute', rawArguments: { command: 'bun test' } })),
      ),
    );
    expect(
      evaluateClassifiedToolPolicyV1(shell, policyContext({ phase: 'planning' })),
    ).toMatchObject({
      kind: 'terminal',
      terminal: { kind: 'reject', failureKind: 'phase_deferred' },
    });

    const networkRead = classified(
      validated(
        resolved(snapshot({ name: 'web_fetch', rawArguments: { url: 'https://example.com' } })),
      ),
    );
    const networkPolicy = evaluateClassifiedToolPolicyV1(networkRead, policyContext());
    if (networkPolicy.kind !== 'continue') throw new Error(networkPolicy.terminal.kind);
    expect(
      authorizePolicyEvaluatedToolV1(
        networkPolicy.value,
        policyContext({ interactionMode: 'auto' }),
      ),
    ).toMatchObject({ kind: 'terminal', terminal: { kind: 'request_auto_review' } });

    const skill = skillDescriptor();
    const disclosure: CapabilityDisclosure = {
      capabilityId: skill.capabilityId,
      capabilityRevision: skill.revision,
      issuedForTurnId: TURN_ID,
    };
    const activation = classified(
      validated(
        resolved(
          snapshot({
            name: 'activate_skill',
            rawArguments: { skill_id: skill.capabilityId, input: {} },
          }),
          resolutionContext({ descriptors: [skill], disclosures: [disclosure] }),
        ),
      ),
    );
    const activationPolicy = evaluateClassifiedToolPolicyV1(activation, policyContext());
    if (activationPolicy.kind !== 'continue') throw new Error(activationPolicy.terminal.kind);
    expect(authorizePolicyEvaluatedToolV1(activationPolicy.value, policyContext())).toMatchObject({
      kind: 'terminal',
      terminal: { kind: 'request_approval' },
    });

    const askUser = classified(
      validated(
        resolved(
          snapshot({
            name: 'ask_user',
            rawArguments: {
              questions: [
                {
                  question: 'Continue?',
                  options: [
                    { label: 'Continue', description: 'Proceed now.', recommended: true },
                    { label: 'Pause', description: 'Stop here.', recommended: false },
                  ],
                },
              ],
            },
          }),
        ),
      ),
    );
    const askPolicy = evaluateClassifiedToolPolicyV1(askUser, policyContext());
    if (askPolicy.kind !== 'continue') throw new Error(askPolicy.terminal.kind);
    expect(authorizePolicyEvaluatedToolV1(askPolicy.value, policyContext())).toEqual({
      kind: 'terminal',
      terminal: { kind: 'request_user_input' },
    });
  });

  test('fails admission closed for stale facts or a missing required reservation', () => {
    const invocation = classified(
      validated(resolved(snapshot({ name: 'read_file', rawArguments: { path: 'README.md' } }))),
    );
    const policy = evaluateClassifiedToolPolicyV1(invocation, policyContext());
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext());
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);

    expect(
      admitAuthorizedToolInvocationV1(authorization.value, {
        reservationRequired: true,
        reservationIds: [],
        freshness: 'current',
      }),
    ).toMatchObject({ kind: 'terminal', terminal: { kind: 'reject' } });
    expect(
      admitAuthorizedToolInvocationV1(authorization.value, {
        reservationRequired: false,
        reservationIds: [],
        freshness: 'stale',
      }),
    ).toMatchObject({ kind: 'terminal', terminal: { kind: 'reject' } });
  });

  test('keeps pure stages disconnected from persistence, provider, and dispatch', () => {
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

  test('requires durable intent and attempt acknowledgement before adapter dispatch', async () => {
    const invocation = classified(
      validated(resolved(snapshot({ name: 'read_file', rawArguments: { path: 'README.md' } }))),
    );
    const policy = evaluateClassifiedToolPolicyV1(invocation, policyContext());
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext());
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
    const admission = admitAuthorizedToolInvocationV1(authorization.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    if (admission.kind !== 'continue') throw new Error(admission.terminal.kind);

    let providerDispatches = 0;
    const dispatched = dispatchAdmittedToolInvocationV1(
      admission.value,
      {
        workspace: '/workspace',
        request: {
          source: 'builtin',
          id: 'call-read_file',
          name: 'read_file',
          args: { path: 'README.md' },
          reason: 'fixture',
          protectedCommand: '',
        },
      },
      {
        threadId: 'thread-tool-pipeline',
        toolCallId: 'call-read_file',
        persistence: {
          getState: () =>
            createInitialRuntimeState({
              threadId: 'thread-tool-pipeline',
              userId: 'test',
              workspace: '/workspace',
            }),
          persistEvents: async () => false,
        },
      },
      {
        dispatch: async (input) => {
          await input.beforeDispatch?.();
          providerDispatches += 1;
          return { ok: true, command: '', exitCode: 0, stdout: 'fixture', stderr: '' };
        },
      },
    );

    await expect(dispatched).rejects.toBeInstanceOf(ToolInvocationPersistenceErrorV1);
    expect(providerDispatches).toBe(0);
  });

  test('records every attempt before dispatch and reuses one stable idempotency key', async () => {
    const descriptor = mcpDescriptor({
      execution: { retry: 'idempotency_key', idempotencyKeyArgument: 'request_id' },
    });
    const binding = createBinding({
      descriptor,
      exposedToolName: 'mcp__fixture__search',
      turnId: TURN_ID,
    });
    const invocation = classified(
      validated(
        resolved(
          snapshot({
            name: binding.exposedToolName,
            rawArguments: { query: 'needle' },
            binding,
          }),
          resolutionContext({ bindings: [binding], descriptors: [descriptor] }),
        ),
      ),
    );
    const policy = evaluateClassifiedToolPolicyV1(invocation, policyContext());
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext());
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
    const admission = admitAuthorizedToolInvocationV1(authorization.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    if (admission.kind !== 'continue') throw new Error(admission.terminal.kind);

    let state = createInitialRuntimeState({
      threadId: 'thread-tool-pipeline',
      userId: 'test',
      workspace: '/workspace',
    });
    const persistedTypes: string[] = [];
    const attemptsObservedByAdapter: number[] = [];
    const idempotencyKeys: string[] = [];
    const context = {
      threadId: 'thread-tool-pipeline',
      toolCallId: `call-${binding.exposedToolName}`,
      persistence: {
        getState: () => state,
        persistEvents: async (events: import('@/core/runtime/events').RuntimeEvent[]) => {
          for (const event of events) {
            persistedTypes.push(event.type);
            state = reduceRuntimeState(state, event);
          }
          return true;
        },
      },
    };
    const adapter = {
      dispatch: async (input: import('@/core/harness/tool-runner').GovernedToolInvocationInput) => {
        await input.beforeDispatch?.();
        const record = Object.values(state.capabilities.invocations)[0];
        attemptsObservedByAdapter.push(record?.attemptsStarted ?? 0);
        idempotencyKeys.push(String((input.request.args as Record<string, unknown>).request_id));
        return { ok: true, command: '', exitCode: 0, stdout: 'fixture', stderr: '' };
      },
    };
    const input = {
      workspace: '/workspace',
      request: {
        source: 'mcp' as const,
        id: context.toolCallId,
        name: binding.exposedToolName as `mcp__${string}`,
        args: invocation.validated.request.arguments,
        reason: 'fixture',
        protectedCommand: '',
      },
    };

    await dispatchAdmittedToolInvocationV1(admission.value, input, context, adapter);
    await dispatchAdmittedToolInvocationV1(admission.value, input, context, adapter);

    expect(persistedTypes).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'capability.execution_started',
    ]);
    expect(attemptsObservedByAdapter).toEqual([1, 2]);
    expect(idempotencyKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  test('plans verification only from an authentic committed capability receipt', async () => {
    const descriptor = mcpDescriptor({
      effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
    });
    const binding = createBinding({
      descriptor,
      exposedToolName: 'mcp__fixture__search',
      turnId: TURN_ID,
    });
    const invocation = classified(
      validated(
        resolved(
          snapshot({
            name: binding.exposedToolName,
            rawArguments: { query: 'needle' },
            binding,
          }),
          resolutionContext({ bindings: [binding], descriptors: [descriptor] }),
        ),
      ),
    );
    const approvedContext = policyContext({ interactionMode: 'full', callStatus: 'approved' });
    const policy = evaluateClassifiedToolPolicyV1(invocation, approvedContext);
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, approvedContext);
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
    const admission = admitAuthorizedToolInvocationV1(authorization.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    if (admission.kind !== 'continue') throw new Error(admission.terminal.kind);

    let state = createInitialRuntimeState({
      threadId: 'thread-tool-pipeline',
      userId: 'test',
      workspace: '/workspace',
    });
    const dispatchInput = {
      workspace: '/workspace',
      request: {
        source: 'mcp' as const,
        id: `call-${binding.exposedToolName}`,
        name: binding.exposedToolName as `mcp__${string}`,
        args: invocation.validated.request.arguments,
        reason: 'fixture',
        protectedCommand: '',
      },
    };
    const dispatchContext = {
      threadId: 'thread-tool-pipeline',
      toolCallId: `call-${binding.exposedToolName}`,
      persistence: {
        getState: () => state,
        persistEvents: async (events: import('@/core/runtime/events').RuntimeEvent[]) => {
          for (const event of events) state = reduceRuntimeState(state, event);
          return true;
        },
      },
    };
    const dispatched = await dispatchAdmittedToolInvocationV1(
      admission.value,
      dispatchInput,
      dispatchContext,
      {
        dispatch: async (input) => {
          await input.beforeDispatch?.();
          return { ok: true, command: '', exitCode: 0, stdout: 'fixture', stderr: '' };
        },
      },
    );
    if (dispatched.kind !== 'dispatched') throw new Error(dispatched.kind);
    const reservedEvidence = await dispatchAdmittedToolInvocationV1(
      admission.value,
      dispatchInput,
      dispatchContext,
      {
        dispatch: async (input) => {
          await input.beforeDispatch?.();
          return {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: 'fixture',
            stderr: '',
            capabilityResult: {
              status: 'success',
              content: [],
              structuredContent: {
                filesystemObservation: {
                  actorIdentityDigest: 'a'.repeat(64),
                  lexicalTargetDigest: `sha256:${'b'.repeat(64)}`,
                  canonicalTargetDigest: `sha256:${'c'.repeat(64)}`,
                  targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
                  contentDigest: `sha256:${'e'.repeat(64)}`,
                },
              },
            },
          };
        },
      },
    );
    if (reservedEvidence.kind !== 'dispatched') throw new Error(reservedEvidence.kind);
    expect(() => normalizeDispatchedToolOutcomeV1(reservedEvidence.value)).toThrow(
      'reserved for the Workspace filesystem Pipeline dispatcher',
    );
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        result: {
          ...dispatched.value.result,
          filesystemObservation: {
            actorIdentityDigest: 'a'.repeat(64),
            lexicalTargetDigest: `sha256:${'b'.repeat(64)}`,
            canonicalTargetDigest: `sha256:${'c'.repeat(64)}`,
            targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
            contentDigest: `sha256:${'e'.repeat(64)}`,
          },
        },
      }),
    ).toThrow('authentic dispatched Pipeline outcome');

    let artifactWrites = 0;
    const artifactStore = {
      write: () => {
        artifactWrites += 1;
        return {
          artifactId: `pa_${'a'.repeat(64)}`,
          kind: 'capability_result',
          integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
          byteLength: 42,
        } as const;
      },
    };
    const forgedRecorded = { ...dispatched.value.recorded };
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        recorded: forgedRecorded,
      }),
    ).toThrow('authentic dispatched Pipeline outcome');
    expect(() => normalizeDispatchedToolOutcomeV1({ ...dispatched.value })).toThrow(
      'authentic dispatched Pipeline outcome',
    );
    expect(artifactWrites).toBe(0);

    const normalized = normalizeDispatchedToolOutcomeV1(dispatched.value);
    expect(() => recordNormalizedToolResultV1({ ...normalized }, artifactStore)).toThrow(
      'authentic normalized Pipeline outcome',
    );
    expect(() => commitNormalizedToolReceiptV1({ ...normalized }, artifactStore)).toThrow(
      'authentic normalized Pipeline outcome',
    );
    expect(artifactWrites).toBe(0);

    const receipt = commitNormalizedToolReceiptV1(
      normalized,
      artifactStore,
      '2026-08-16T00:00:01.000Z',
    );
    expect(artifactWrites).toBe(1);
    const planned = planCommittedToolVerificationV1(receipt, {
      enabled: true,
      taskId: 'task-1',
      requestedAt: '2026-08-16T00:00:02.000Z',
    });

    expect(planned).toMatchObject({
      kind: 'planned',
      value: {
        stage: 'verification_planned',
        verificationEvents: [
          {
            type: 'verification.requested',
            taskId: 'task-1',
            mode: 'required',
            requestedAt: '2026-08-16T00:00:02.000Z',
          },
        ],
      },
    });
    expect(
      (planned.kind === 'planned' && planned.value.verificationEvents[0]?.spec.checks[0]) || null,
    ).toMatchObject({
      invocationIds: [receipt.normalized.dispatched.recorded.invocationId],
    });
    expect(planCommittedToolVerificationV1(receipt, { enabled: false })).toEqual({
      kind: 'not_requested',
      reason: 'disabled',
    });
    expect(() => planCommittedToolVerificationV1({ ...receipt }, { enabled: true })).toThrow(
      'matching committed capability receipt',
    );

    let dispatchError: unknown;
    try {
      await dispatchAdmittedToolInvocationV1(admission.value, dispatchInput, dispatchContext, {
        dispatch: async (input) => {
          await input.beforeDispatch?.();
          throw new Error('confirmed adapter failure');
        },
      });
    } catch (error) {
      dispatchError = error;
    }
    expect(dispatchError).toBeInstanceOf(ToolInvocationDispatchErrorV1);
    const recordedFailure = (dispatchError as ToolInvocationDispatchErrorV1).recorded;
    if (!recordedFailure) throw new Error('acknowledged failure record missing');
    const failure = {
      kind: 'tool_runtime_error' as const,
      message: 'confirmed adapter failure',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
    expect(() =>
      confirmedToolDispatchFailureOutcomeV1(recordedFailure, {
        status: 'success',
        command: '',
        failure,
        runtimeEvents: [],
      } as never),
    ).toThrow('closed error-only envelope');
    const failureReceipt = commitNormalizedToolReceiptV1(
      normalizeDispatchedToolOutcomeV1(
        confirmedToolDispatchFailureOutcomeV1(recordedFailure, {
          status: 'error',
          command: '',
          failure,
        }),
      ),
      artifactStore,
    );
    expect(failureReceipt.terminalEvents).toMatchObject([
      { type: 'capability.execution_failed', invocationId: recordedFailure.invocationId },
    ]);
    expect(artifactWrites).toBe(2);
  });
});
