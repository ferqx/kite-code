import { describe, expect, test } from 'bun:test';
import {
  type BuiltinOperationExecutionValue,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import {
  createCapabilitySnapshot,
  descriptorRevision,
  type SkillCatalogSnapshot,
  type SkillWorkflowContract,
} from '@kite/builtin-runtime/skills';
import type { CapabilityDescriptor, CapabilityDisclosure } from '@kite/runtime-contract';
import {
  createRuntimeHostCapabilityExecutionPortFromSnapshot,
  createRuntimeHostToolCallSnapshot,
} from '@kite/runtime-host';
import { runtimeHostStateCreateApprovalBindingDigest } from '@kite/runtime-host/kernel-adapter';
import type {
  CapabilityExecutionInvocation,
  CapabilityExecutionPort,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelinePersistence,
  ToolPipelineReceiptCommit,
  ToolPipelineSuspensionCommit,
  WorkspaceFilesystemEditObservationQuery,
} from '@kite/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';
import { createAppToolPipelineComposition } from '#app/bootstrap/runtime/tool-pipeline-composition';
import {
  createAppOrdinaryToolPipelineAttemptRuntime,
  createAppToolPipelineAttemptScope,
} from '#app/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import { getFeatureFlags } from '#app/config/features';
import type { AppStateToolPipelinePersistence } from '#app/runtime/tool-persistence';

const TOOL_CALL_ID = 'call-activate-skill';
const TURN_ID = 'turn-skill-dispatch';
const THREAD_ID = 'thread-skill-dispatch';

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function skillDescriptor(
  skillId: string,
  effects: CapabilityDescriptor['effectiveEffects'],
): CapabilityDescriptor {
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: skillId,
    kind: 'skill',
    displayName: 'Fixture Skill',
    description: 'Run the fixture workflow.',
    provider: { type: 'skill', id: 'fixture', provenance: 'project' },
    inputSchema: { type: 'object', additionalProperties: true },
    declaredEffects: effects,
    effectiveEffects: effects,
    policy: {
      workspaceTrustRequired: true,
      minimumApproval: effects.filesystem === 'read' ? 'none' : 'user',
    },
    execution: { retry: 'never' },
    availability: 'available',
    diagnostics: [],
  };
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function skillContract(
  skillId: string,
  contextMode: 'inline' | 'fork',
  effects: CapabilityDescriptor['effectiveEffects'],
): SkillWorkflowContract {
  return {
    schemaVersion: 1,
    name: skillId.replace('skill:', ''),
    version: '1.0.0',
    description: `Fixture ${contextMode} Skill.`,
    instructions: `Run ${skillId}.`,
    invocation: { allowImplicit: true, allowManual: true },
    context: { mode: contextMode, agent: 'code' },
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    capabilityCeiling: ['builtin:read_file'],
    deniedCapabilities: [],
    effectiveCapabilityCeiling: ['builtin:read_file'],
    effects,
    effectiveEffects: effects,
    minimumApproval: effects.filesystem === 'read' ? 'none' : 'user',
    effectiveMinimumApproval: effects.filesystem === 'read' ? 'none' : 'user',
    execution: { timeoutMs: 1_000, maxAttempts: 1 },
    verification: { mode: 'not_required' },
    recovery: { retry: 'never' },
    files: ['SKILL.md'],
    dependencyRevisions: {},
  };
}

function skillCatalog(
  descriptor: CapabilityDescriptor,
  contextMode: 'inline' | 'fork',
): SkillCatalogSnapshot {
  const otherMode: 'inline' | 'fork' = contextMode === 'inline' ? 'fork' : 'inline';
  const otherId = otherMode === 'inline' ? 'skill:inline-fixture' : 'skill:fork-fixture';
  const otherDescriptor = skillDescriptor(
    otherId,
    otherMode === 'inline'
      ? { filesystem: 'read', network: 'none', externalState: 'none' }
      : { filesystem: 'write', network: 'none', externalState: 'none' },
  );
  const entries = [
    { descriptor, contextMode },
    { descriptor: otherDescriptor, contextMode: otherMode },
  ];
  const capabilities = createCapabilitySnapshot(entries.map((entry) => entry.descriptor));
  return deepFreeze({
    revision: 'skill-catalog',
    capabilities,
    entries: entries.map(({ descriptor: entryDescriptor, contextMode: entryMode }) => ({
      sourcePath: `/workspace/.kite-code/skills/${entryDescriptor.capabilityId}`,
      source: 'project' as const,
      origin: '.kite-code' as const,
      diagnostics: [],
      descriptor: entryDescriptor,
      contract: skillContract(
        entryDescriptor.capabilityId,
        entryMode,
        entryDescriptor.effectiveEffects,
      ),
    })),
  });
}

function acknowledgement(
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<ToolPipelineAttemptAcknowledgement> {
  const identity = prepared.identity;
  return Object.freeze({
    acknowledged: true,
    attempt: Object.freeze({
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
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: identity.idempotencyKey,
      recordedAt: '2026-08-22T00:00:00.000Z',
      startedAt: '2026-08-22T00:00:00.000Z',
    }),
  });
}

function persistence(
  calls: {
    record: number;
    host: number;
    commit: number;
    suspend: number;
    unknown: number;
  },
  options: { readonly rejectAttempt?: boolean; readonly events?: string[] } = {},
) {
  const pipeline: ToolPipelinePersistence<BuiltinOperationExecutionValue> = Object.freeze({
    recordAttempt: async (prepared: Readonly<PreparedToolInvocation>) => {
      calls.record += 1;
      options.events?.push('ack');
      if (options.rejectAttempt) throw new Error('acknowledgement unavailable');
      return acknowledgement(prepared);
    },
    recordUnknown: async () => {
      calls.unknown += 1;
    },
    commitTerminal: async (_commit: Readonly<ToolPipelineReceiptCommit>) => {
      calls.commit += 1;
      options.events?.push('commit');
    },
    commitSuspension: async (_commit: Readonly<ToolPipelineSuspensionCommit>) => {
      calls.suspend += 1;
    },
  });
  return Object.freeze({
    ...pipeline,
    createSandboxLifecycle: () => {
      throw new Error('sandbox lifecycle is outside this Skill dispatch fixture');
    },
    workspaceFilesystemEvidence: Object.freeze({
      persistIntent: async () => {
        throw new Error('filesystem evidence is outside this Skill dispatch fixture');
      },
      verifyPersistedIntent: () =>
        Object.freeze({ valid: false as const, code: 'intent_not_issued' as const }),
    }),
    workspaceFilesystemMutationEvidence: Object.freeze({
      persistIntent: async () => {
        throw new Error('filesystem evidence is outside this Skill dispatch fixture');
      },
      verifyPersistedIntent: () =>
        Object.freeze({ valid: false as const, code: 'intent_not_issued' as const }),
      persistMutationReady: async () => {
        throw new Error('filesystem evidence is outside this Skill dispatch fixture');
      },
      verifyPersistedMutationReady: () =>
        Object.freeze({ valid: false as const, code: 'ready_not_issued' as const }),
    }),
    workspaceFilesystemEditObservation: Object.freeze({
      findLatestAuthenticRead: async (query: Readonly<WorkspaceFilesystemEditObservationQuery>) =>
        Object.freeze({ status: 'missing' as const, code: 'read_required' as const, query }),
      verifyLatestAuthenticRead: () =>
        Object.freeze({ valid: false as const, code: 'query_result_not_issued' as const }),
    }),
  }) as AppStateToolPipelinePersistence;
}

function skillMechanism(catalog: SkillCatalogSnapshot, runFork: () => void) {
  return Object.freeze({
    catalog,
    state: Object.freeze({
      activeTaskId: 'task',
      session: Object.freeze({ workspace: '/workspace' }),
      skills: Object.freeze({
        catalogRevision: catalog.revision,
        frames: Object.freeze({}),
      }),
    }),
    flags: Object.freeze({ skillActivation: true, skillWorkflow: true }),
    verificationEnabled: false,
    runFork: async () => {
      runFork();
      return { ok: true, summary: '{}' };
    },
  });
}

function fixture(
  contextMode: 'inline' | 'fork' = 'inline',
  options: { readonly rejectAttempt?: boolean } = {},
) {
  const descriptor = skillDescriptor(
    contextMode === 'inline' ? 'skill:inline-fixture' : 'skill:fork-fixture',
    contextMode === 'inline'
      ? { filesystem: 'read', network: 'none', externalState: 'none' }
      : { filesystem: 'write', network: 'none', externalState: 'none' },
  );
  const catalog = skillCatalog(descriptor, contextMode);
  const disclosure: CapabilityDisclosure = {
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    issuedForTurnId: TURN_ID,
  };
  const featureFlags = getFeatureFlags({
    features: { skillWorkflow: true, skillActivation: true },
  });
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const baseProjection = createBuiltinToolCatalogProjection(registry.snapshot());
  const composition = createAppToolPipelineComposition(baseProjection);
  const turn = composition.forTurn({
    workspace: '/workspace',
    phase: 'building',
    hasTaskAdapter: true,
    toolSearchEnabled: true,
    availableSkillIds: [descriptor.capabilityId],
    featureFlags,
  });
  const calls = { record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 };
  const events: string[] = [];
  const appPersistence = persistence(calls, { ...options, events });
  const scope = createAppToolPipelineAttemptScope({ persistence: appPersistence });
  const runtime = createAppOrdinaryToolPipelineAttemptRuntime({
    persistence: appPersistence,
    scope,
  });
  const host = createRuntimeHostCapabilityExecutionPortFromSnapshot(registry.snapshot());
  const capabilityExecution: CapabilityExecutionPort = Object.freeze({
    invoke: (input: CapabilityExecutionInvocation) => {
      calls.host += 1;
      events.push('host');
      return host.invoke(input);
    },
  });
  const snapshot = createRuntimeHostToolCallSnapshot({
    toolCallId: TOOL_CALL_ID,
    name: 'activate_skill',
    rawArguments: { skill_id: descriptor.capabilityId, input: {} },
    argumentOrigin: 'model_public',
    createdAtTurnId: TURN_ID,
    modelMessageId: 'model-message',
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  });
  if (!snapshot.ok) throw new Error(snapshot.failure.code);
  const resolution = Object.freeze({
    currentTurnId: TURN_ID,
    builtinProjectionRevision: turn.projection.revision,
    dynamicCatalogRevision: 'c'.repeat(64),
    availabilityContext: Object.freeze({
      workspace: '/workspace',
      phase: 'building' as const,
      hasTaskAdapter: true,
      toolSearchEnabled: true,
      availableSkillIds: [descriptor.capabilityId],
      featureFlags,
    }),
    bindings: Object.freeze([]),
    descriptors: Object.freeze([descriptor]),
    disclosures: Object.freeze([disclosure]),
  });
  const baseGovernance = Object.freeze({
    sessionId: THREAD_ID,
    workspace: '/workspace',
    canonicalWorkspaceIdentity: '/workspace',
    threadId: THREAD_ID,
    context: Object.freeze({
      phase: 'building' as const,
      interactionMode: 'accept_edits' as const,
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
  const resolved = turn.callbacks.resolve(snapshot.value, resolution);
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = turn.callbacks.validate(resolved.value);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = turn.callbacks.classify(validated.value);
  if (!classified.ok) throw new Error(classified.failure.code);
  const governanceInput = Object.freeze({ ...baseGovernance, classified: classified.value });
  const projected = turn.governance.project(
    governanceInput,
    Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: [],
    }),
  );
  if (!projected.ok) throw new Error(projected.failure.code);
  const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigest(
    projected.value.invocation,
    projected.value.policy,
  );
  const governance = Object.freeze({
    ...baseGovernance,
    approval: Object.freeze({
      status: 'approved' as const,
      grant: 'approve_once' as const,
      approvedToolCallId: TOOL_CALL_ID,
      approvalBindingDigest,
    }),
  });
  return {
    descriptor,
    catalog,
    disclosure,
    turn,
    runtime,
    capabilityExecution,
    calls,
    events,
    snapshot: snapshot.value,
    resolution,
    governance,
  };
}

function executeInput(
  value: ReturnType<typeof fixture>,
  mechanismResources: Readonly<Record<string, unknown>>,
) {
  const { builtinProjectionRevision, ...mechanisms } = mechanismResources;
  return value.runtime.execute({
    turn: value.turn,
    snapshot: value.snapshot,
    resolution:
      typeof builtinProjectionRevision === 'string'
        ? Object.freeze({
            ...value.resolution,
            builtinProjectionRevision,
          })
        : value.resolution,
    governance: value.governance,
    admission: Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: Object.freeze([]),
    }),
    threadId: THREAD_ID,
    attempt: 1,
    taskId: null,
    planId: null,
    planStepId: null,
    capabilityRequestFacts: null as RuntimeJsonValue | null,
    capabilityExecution: value.capabilityExecution,
    signal: new AbortController().signal,
    mechanismResources: Object.freeze({ workspace: '/workspace', ...mechanisms }),
  });
}

describe('Skill prepared dispatch cutover', () => {
  test('rejects a missing prepared Skill mechanism before acknowledgement or fork', async () => {
    const value = fixture();
    const result = await executeInput(value, Object.freeze({}));
    expect(result.kind).toBe('governance_failure');
    expect(result).toMatchObject({ code: 'mechanism_unavailable' });
    expect(value.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });
  });

  test('runs an inline Skill after one acknowledgement without fork issuance', async () => {
    const value = fixture();
    let forkFactories = 0;
    const result = await executeInput(
      value,
      Object.freeze({
        preassembledMechanism: Object.freeze({
          skill: skillMechanism(value.catalog, () => {
            value.events.push('fork');
            forkFactories += 1;
          }),
        }),
      }),
    );
    expect(result.kind).toBe('committed');
    expect(value.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
    expect(value.events).toEqual(['ack', 'host', 'commit']);
    expect(forkFactories).toBe(0);
  });

  test('runs a fork Skill exactly once after acknowledgement and commits completion', async () => {
    const value = fixture('fork');
    let forkFactories = 0;
    const result = await executeInput(
      value,
      Object.freeze({
        preassembledMechanism: Object.freeze({
          skill: skillMechanism(value.catalog, () => {
            value.events.push('fork');
            forkFactories += 1;
          }),
        }),
      }),
    );
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.committed.result.structuredContent).toMatchObject({
      ok: true,
      runtimeEvents: [{ type: 'skill.activation_started' }, { type: 'skill.frame_closed' }],
    });
    expect(value.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
    expect(value.events).toEqual(['ack', 'host', 'fork', 'commit']);
    expect(forkFactories).toBe(1);
  });

  test('does not fork when acknowledgement persistence fails', async () => {
    const value = fixture('fork', { rejectAttempt: true });
    let forkFactories = 0;
    await expect(
      executeInput(
        value,
        Object.freeze({
          preassembledMechanism: Object.freeze({
            skill: skillMechanism(value.catalog, () => {
              value.events.push('fork');
              forkFactories += 1;
            }),
          }),
        }),
      ),
    ).rejects.toThrow();
    expect(value.calls).toEqual({ record: 1, host: 0, commit: 0, suspend: 0, unknown: 0 });
    expect(value.events).toEqual(['ack']);
    expect(forkFactories).toBe(0);
  });

  test('rejects projection identity drift before Host or fork', async () => {
    const value = fixture('fork');
    let forkFactories = 0;
    const result = await executeInput(
      value,
      Object.freeze({
        preassembledMechanism: Object.freeze({
          skill: skillMechanism(value.catalog, () => {
            value.events.push('fork');
            forkFactories += 1;
          }),
        }),
        builtinProjectionRevision: 'stale-projection',
      }),
    );
    expect(result).toMatchObject({ kind: 'stage_failure', failure: { stage: 'resolve' } });
    expect(value.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });
    expect(forkFactories).toBe(0);
  });
});
