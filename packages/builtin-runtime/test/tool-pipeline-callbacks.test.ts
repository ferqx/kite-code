import { describe, expect, test } from 'bun:test';
import type { CapabilityDescriptor, CapabilityDisclosure } from '@kite-ai/runtime-contract';
import type {
  CapabilityToolKind,
  NonDynamicOperationId,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolArgumentOrigin,
  ToolCallSnapshot,
  ToolPipelineResolutionContext,
} from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../src/capability-binding';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '../src/index';
import { createBuiltinToolPipelineCallbacks } from '../src/tool-pipeline-callbacks';

const STAGE_SCHEMA = 'kite.tool-pipeline-stage.v1' as const;
const DYNAMIC_CATALOG_REVISION = 'c'.repeat(64);

function fixture() {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjection(registry.snapshot(), {
    turnContext: { workspace: '/workspace' },
  });
  const callbacks = createBuiltinToolPipelineCallbacks(projection);
  const context: ToolPipelineResolutionContext = {
    currentTurnId: 'turn-1',
    availabilityContext: { workspace: '/workspace' },
    bindings: [],
    descriptors: [],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
  };
  return { projection, callbacks, context };
}

function call(
  name: string,
  rawArguments: unknown,
  createdAtTurnId = 'turn-1',
  argumentOrigin: ToolArgumentOrigin = 'model_public',
): ToolCallSnapshot {
  return {
    schema: STAGE_SCHEMA,
    stage: 'snapshot',
    toolCallId: 'call-1',
    name,
    rawArguments: rawArguments as ToolCallSnapshot['rawArguments'],
    argumentOrigin,
    createdAtTurnId,
    modelMessageId: 'message-1',
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  };
}

function resolveReadFile() {
  const value = fixture();
  const resolved = value.callbacks.resolve(call('read_file', { path: 'README.md' }), value.context);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('read_file did not resolve');
  return { ...value, resolved: resolved.value };
}

function turnFixture(
  input: {
    readonly hasTaskAdapter?: boolean;
    readonly featureFlags?: Readonly<{
      readonly skillWorkflow: true;
      readonly skillActivation: true;
    }>;
    readonly availableSkillIds?: readonly string[];
    readonly descriptors?: readonly CapabilityDescriptor[];
    readonly disclosures?: readonly CapabilityDisclosure[];
    readonly turnId?: string;
  } = {},
) {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const turnContext = {
    workspace: '/workspace',
    phase: 'building' as const,
    hasTaskAdapter: input.hasTaskAdapter ?? false,
    availableSkillIds: input.availableSkillIds ?? [],
    ...(input.featureFlags ? { featureFlags: input.featureFlags } : {}),
  };
  const projection = createBuiltinToolCatalogProjection(registry.snapshot(), { turnContext });
  const callbacks = createBuiltinToolPipelineCallbacks(projection);
  const currentTurnId = input.turnId ?? 'turn-specialized';
  const context: ToolPipelineResolutionContext = {
    currentTurnId,
    availabilityContext: turnContext,
    bindings: [],
    descriptors: input.descriptors ?? [],
    disclosures: input.disclosures ?? [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
  };
  return { projection, callbacks, context };
}

function skillDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const base: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: 'skill:fixture',
    kind: 'skill',
    displayName: 'Fixture Skill',
    description: 'A fixture skill.',
    provider: { type: 'skill', id: 'fixture', provenance: 'project' },
    inputSchema: { type: 'object', additionalProperties: true },
    declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    policy: { workspaceTrustRequired: true, minimumApproval: 'user' },
    execution: { retry: 'never' },
    availability: 'available',
    diagnostics: [],
    ...overrides,
  };
  return { ...base, revision: digestCapabilityBindingValue(base) };
}

function skillFixture(
  overrides: {
    readonly descriptor?: CapabilityDescriptor;
    readonly disclosure?: CapabilityDisclosure;
    readonly omitDescriptor?: boolean;
    readonly omitDisclosure?: boolean;
  } = {},
) {
  const descriptor = overrides.descriptor ?? skillDescriptor();
  const disclosure = overrides.disclosure ?? {
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    issuedForTurnId: 'turn-specialized',
  };
  return turnFixture({
    featureFlags: { skillWorkflow: true, skillActivation: true },
    availableSkillIds: [descriptor.capabilityId],
    descriptors: overrides.omitDescriptor ? [] : [descriptor],
    disclosures: overrides.omitDisclosure ? [] : [disclosure],
  });
}

function preparedReadFile() {
  const value = resolveReadFile();
  const validated = value.callbacks.validate(value.resolved);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error('read_file did not validate');
  const classified = value.callbacks.classify(validated.value);
  expect(classified.ok).toBe(true);
  if (!classified.ok) throw new Error('read_file did not classify');
  const entry = value.projection.entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'read_file',
  );
  if (entry?.visibility !== 'model') throw new Error('read_file entry missing');
  const identity = {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: value.resolved.call.createdAtTurnId,
    modelMessageId: value.resolved.call.modelMessageId,
    argumentOrigin: value.resolved.call.argumentOrigin,
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: 'builtin' as const,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: entry.parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    policyDigest: null,
    authorizationDigest: null,
    admissionDigest: null,
    executionMechanism: entry.executionMechanism,
    toolKind: entry.kind as CapabilityToolKind,
    bindingId: null,
    visibility: 'model' as const,
    modelVisible: true as const,
    exposedToolName: entry.name,
    builtinProjectionRevision: value.projection.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false as const,
  };
  const prepared = {
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { path: 'README.md' },
      facts: validated.value.domainData,
      binding: null,
    },
  } as const satisfies PreparedToolInvocation;
  return { ...value, validated: validated.value, classified: classified.value, prepared };
}

function preparedFromTurnFixture(
  value: ReturnType<typeof turnFixture>,
  name: string,
  argumentsValue: Record<string, unknown>,
  argumentOrigin: ToolArgumentOrigin = 'model_public',
) {
  const resolved = value.callbacks.resolve(
    call(name, argumentsValue, value.context.currentTurnId, argumentOrigin),
    value.context,
  );
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = value.callbacks.validate(resolved.value);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = value.callbacks.classify(validated.value);
  if (!classified.ok) throw new Error(classified.failure.code);
  const entry = value.projection.entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === name,
  );
  if (entry?.visibility !== 'model') throw new Error(`${name} entry missing`);
  const privateTaskProjection =
    entry.executionMechanism === 'subagent' && 'taskArtifact' in argumentsValue;
  const parser = privateTaskProjection ? entry.parser : (entry.modelParser ?? entry.parser);
  const identity = {
    invocationId: `${name}-invocation`,
    attemptId: `${name}-attempt`,
    toolCallId: resolved.value.call.toolCallId,
    turnId: resolved.value.call.createdAtTurnId,
    modelMessageId: resolved.value.call.modelMessageId,
    argumentOrigin: resolved.value.call.argumentOrigin,
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: resolved.value.target.executionFamily as 'builtin' | 'skill' | 'subagent',
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
    policyDigest: null,
    authorizationDigest: null,
    admissionDigest: null,
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    executionMechanism: entry.executionMechanism,
    bindingId: null,
    visibility: 'model' as const,
    modelVisible: true as const,
    exposedToolName: entry.name,
    builtinProjectionRevision: value.projection.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false as const,
    toolKind: entry.kind as CapabilityToolKind,
  };
  return {
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: validated.value.request.arguments,
      facts: validated.value.domainData,
      binding: null,
    },
  } as const satisfies PreparedToolInvocation;
}

function verificationValid(
  result: ReturnType<
    ReturnType<typeof createBuiltinToolPipelineCallbacks>['verifyPreparedIdentity']
  >,
): boolean {
  return typeof result === 'boolean' ? result : result.valid;
}

describe('Builtin Tool Pipeline callbacks', () => {
  test('projects the frozen 28/20/8 catalog and preserves read_file identity', () => {
    const value = resolveReadFile();
    expect(value.projection.entries).toHaveLength(28);
    expect(value.projection.entries.filter((entry) => entry.visibility === 'model')).toHaveLength(
      20,
    );
    expect(
      value.projection.entries.filter((entry) => entry.visibility === 'internal'),
    ).toHaveLength(8);
    expect(Object.isFrozen(value.projection)).toBe(true);
    expect(Object.isFrozen(value.projection.entries)).toBe(true);
    expect(Object.isFrozen(value.resolved)).toBe(true);
    expect(value.resolved.target).toMatchObject({
      operationId: 'builtin:read_file',
      executionFamily: 'builtin',
      executionMechanism: 'filesystem',
      visibility: 'model',
      modelVisible: true,
      exposedToolName: 'read_file',
      isDynamicMcp: false,
      builtinProjectionRevision: value.projection.revision,
      dynamicCatalogRevision: null,
    });
    expect(value.resolved.dynamicCatalogRevision).toBe(DYNAMIC_CATALOG_REVISION);
  });

  test('uses the entry parser/schema/effects/policy/traits for all stages', () => {
    const value = preparedReadFile();
    expect(value.validated.request).toMatchObject({
      source: 'builtin',
      operationId: 'builtin:read_file',
      name: 'read_file',
      arguments: { path: 'README.md' },
      schemaDigest: value.projection.entries.find(
        (entry) => entry.visibility === 'model' && entry.name === 'read_file',
      )?.parser.schemaDigest,
    });
    expect(value.classified).toMatchObject({
      effectClass: 'read_only',
      risk: 'read',
      minimumApproval: 'none',
      effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
      requirements: {
        intent: 'required_before_dispatch',
        receipt: 'observation_receipt',
        retry: 'safe_read_candidate',
        idempotencyKeyArgument: null,
        verification: 'not_required_by_classification',
      },
    });
    expect(value.classified.policyCompilation?.operationId).toBe('builtin:read_file');
    expect(value.classified.executionTraits?.access).toBe('read');
    expect(value.classified.governance).toMatchObject({
      invocation: {
        turnId: 'turn-1',
        modelMessageId: 'message-1',
        toolCallId: 'call-1',
        argumentOrigin: 'model_public',
        operationId: 'builtin:read_file',
        exposedToolName: 'read_file',
        dynamicCatalogRevision: null,
        nestedCatalogRevision: null,
        commandDigest: null,
      },
      dynamicMcp: null,
      nestedSkill: null,
    });
    expect(value.classified.governance.policy).toBe(value.classified.policyCompilation);
    expect(value.classified.governance.effectiveEffects).toBe(value.classified.effectiveEffects);
    expect(value.callbacks.verifyClassifiedIdentity(value.classified)).toEqual({ valid: true });
    expect(
      value.callbacks.verifyClassifiedIdentity(structuredClone(value.classified)),
    ).toMatchObject({ valid: false, code: 'governance_missing' });
  });

  test('projects commandDigest only from the canonical shell command', () => {
    const value = fixture();
    const resolved = value.callbacks.resolve(
      call('shell_execute', { command: '  printf   hello  ', timeout_ms: 1000 }),
      value.context,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const validated = value.callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const classified = value.callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const commandDigest = digestCapabilityBindingValue('printf   hello');
    expect(classified.value.governance.invocation.commandDigest).toBe(commandDigest);
    expect(classified.value.governance.invocation.dynamicCatalogRevision).toBeNull();
    expect(value.callbacks.verifyClassifiedIdentity(classified.value)).toEqual({ valid: true });

    const differentlySpaced = value.callbacks.resolve(
      call('shell_execute', { command: 'printf hello', timeout_ms: 1000 }),
      value.context,
    );
    expect(differentlySpaced.ok).toBe(true);
    if (!differentlySpaced.ok) return;
    const differentlyValidated = value.callbacks.validate(differentlySpaced.value);
    expect(differentlyValidated.ok).toBe(true);
    if (!differentlyValidated.ok) return;
    const differentlyClassified = value.callbacks.classify(differentlyValidated.value);
    expect(differentlyClassified.ok).toBe(true);
    if (!differentlyClassified.ok) return;
    expect(differentlyClassified.value.governance.invocation.commandDigest).not.toBe(commandDigest);
  });

  test('returns bounded parse diagnostics without argument values', () => {
    const value = fixture();
    const resolved = value.callbacks.resolve(
      call('read_file', { path: 'secret-value', offset: 'not-a-number' }),
      value.context,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const result = value.callbacks.validate(resolved.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('invalid_arguments');
    expect(result.failure.diagnostic?.length ?? 0).toBeLessThanOrEqual(256);
    expect(result.failure.diagnostic).not.toContain('secret-value');
  });

  test('projects ask_user for Kernel governance while keeping it outside prepared dispatch', () => {
    const value = fixture();
    const resolved = value.callbacks.resolve(
      call('ask_user', {
        questions: [
          {
            question: 'Continue?',
            options: [
              { label: 'Yes', description: 'Continue the task.', recommended: true },
              { label: 'No', description: 'Stop the task.', recommended: false },
            ],
          },
        ],
      }),
      value.context,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.target).toMatchObject({
      operationId: 'builtin:ask_user',
      toolKind: 'interrupt',
      executionMechanism: 'user_input',
    });
    const validated = value.callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const classified = value.callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.governance.invocation.executionMechanism).toBe('user_input');
    expect(value.callbacks.verifyClassifiedIdentity(classified.value)).toEqual({ valid: true });

    for (const name of ['mcp__server__tool', 'mcp:dynamic_tool']) {
      const result = value.callbacks.resolve(call(name, {}), value.context);
      expect(result.ok).toBe(false);
    }
    const internal = value.projection.entries.find((entry) => entry.visibility === 'internal');
    expect(internal?.name).toBeUndefined();
  });

  test('maps skill/subagent mechanisms and preserves public/private Task parser seams', () => {
    const value = turnFixture({ hasTaskAdapter: true });
    const publicTaskArguments = {
      name: 'Inspect fixture task',
      subagent_type: 'explore',
      task: 'Inspect the fixture task.',
    };
    const publicResolved = value.callbacks.resolve(
      call('task', publicTaskArguments, 'turn-specialized'),
      value.context,
    );
    expect(publicResolved.ok).toBe(true);
    if (!publicResolved.ok) return;
    expect(publicResolved.value.target.executionFamily).toBe('subagent');
    const publicValidated = value.callbacks.validate(publicResolved.value);
    expect(publicValidated.ok).toBe(true);
    if (!publicValidated.ok) return;
    expect(publicValidated.value.domainData).toMatchObject({
      argumentOrigin: 'model_public',
      privateTaskProjection: false,
      subagentRole: 'explore',
    });
    const taskEntry = value.projection.entries.find(
      (candidate) => candidate.visibility === 'model' && candidate.name === 'task',
    );
    if (taskEntry?.visibility !== 'model' || !taskEntry.modelInputSchema) {
      throw new Error('task entry/parser projection missing');
    }
    expect(publicValidated.value.request.schemaDigest).toBe(
      digestCapabilityBindingValue(taskEntry.modelInputSchema),
    );
    expect(publicValidated.value.request.schemaDigest).not.toBe(
      digestCapabilityBindingValue(taskEntry.inputSchema ?? {}),
    );
    expect(taskEntry.modelParser?.parserRevision).not.toBe(taskEntry.parser.parserRevision);
    const publicPrepared = preparedFromTurnFixture(value, 'task', publicTaskArguments);
    expect(value.callbacks.verifyPreparedIdentity(publicPrepared)).toEqual({ valid: true });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...publicPrepared,
        identity: { ...publicPrepared.identity, parserRevision: taskEntry.parser.parserRevision },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...publicPrepared,
        identity: { ...publicPrepared.identity, schemaDigest: 'runtime-schema' },
      }),
    ).toMatchObject({ valid: false });

    const privateArguments = {
      name: 'Implement fixture task',
      subagent_type: 'code',
      taskArtifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'subagent_task_request',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 32,
      },
    };
    const privateResolved = value.callbacks.resolve(
      call('task', privateArguments, 'turn-specialized', 'runtime_private'),
      value.context,
    );
    expect(privateResolved.ok).toBe(true);
    if (!privateResolved.ok) return;
    const privateValidated = value.callbacks.validate(privateResolved.value);
    expect(privateValidated.ok).toBe(true);
    if (!privateValidated.ok) return;
    expect(privateValidated.value.domainData).toMatchObject({
      argumentOrigin: 'runtime_private',
      privateTaskProjection: true,
      subagentRole: 'code',
    });
    expect(privateValidated.value.request.schemaDigest).toBe(
      digestCapabilityBindingValue(taskEntry.inputSchema ?? {}),
    );
    expect(privateValidated.value.request.schemaDigest).not.toBe(
      publicValidated.value.request.schemaDigest,
    );
    const privatePrepared = preparedFromTurnFixture(
      value,
      'task',
      privateArguments,
      'runtime_private',
    );
    expect(value.callbacks.verifyPreparedIdentity(privatePrepared)).toEqual({ valid: true });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...privatePrepared,
        identity: {
          ...privatePrepared.identity,
          parserRevision: taskEntry.modelParser?.parserRevision ?? 'model-parser',
        },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...privatePrepared,
        identity: { ...privatePrepared.identity, schemaDigest: 'model-schema' },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...publicPrepared,
        identity: { ...publicPrepared.identity, argumentOrigin: 'runtime_private' },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...privatePrepared,
        identity: { ...privatePrepared.identity, argumentOrigin: 'model_public' },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...privatePrepared,
        input: {
          ...privatePrepared.input,
          facts: {
            ...(privatePrepared.input.facts as Readonly<Record<string, RuntimeJsonValue>>),
            argumentOrigin: 'model_public',
          },
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });

    // A valid private envelope remains model input when the origin is public.
    const publicArtifactResolved = value.callbacks.resolve(
      call('task', privateArguments, 'turn-specialized', 'model_public'),
      value.context,
    );
    expect(publicArtifactResolved.ok).toBe(true);
    if (!publicArtifactResolved.ok) return;
    expect(value.callbacks.validate(publicArtifactResolved.value).ok).toBe(false);

    const privatePublicShapeResolved = value.callbacks.resolve(
      call('task', publicTaskArguments, 'turn-specialized', 'runtime_private'),
      value.context,
    );
    expect(privatePublicShapeResolved.ok).toBe(true);
    if (!privatePublicShapeResolved.ok) return;
    expect(value.callbacks.validate(privatePublicShapeResolved.value).ok).toBe(false);

    const privateNonTaskResolved = value.callbacks.resolve(
      call('read_file', { path: 'README.md' }, 'turn-specialized', 'runtime_private'),
      value.context,
    );
    expect(privateNonTaskResolved.ok).toBe(true);
    if (!privateNonTaskResolved.ok) return;
    expect(value.callbacks.validate(privateNonTaskResolved.value).ok).toBe(false);

    const invalidPrivateResolved = value.callbacks.resolve(
      call(
        'task',
        { subagent_type: 'code', taskArtifact: { kind: 'forged' } },
        'turn-specialized',
        'runtime_private',
      ),
      value.context,
    );
    expect(invalidPrivateResolved.ok).toBe(true);
    if (!invalidPrivateResolved.ok) return;
    const invalidPrivate = value.callbacks.validate(invalidPrivateResolved.value);
    expect(invalidPrivate.ok).toBe(false);
  });

  test('keeps the frozen planning projection as the only Task parser context authority', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const projection = createBuiltinToolCatalogProjection(registry.snapshot(), {
      turnContext: {
        workspace: '/workspace',
        phase: 'planning',
        hasTaskAdapter: true,
      },
    });
    const callbacks = createBuiltinToolPipelineCallbacks(projection);
    // This transported context is deliberately wider than the context that
    // created the projection. It remains a transport fact only.
    const context: ToolPipelineResolutionContext = {
      currentTurnId: 'turn-planning',
      availabilityContext: {
        workspace: '/workspace',
        phase: 'building',
        hasTaskAdapter: true,
      },
      bindings: [],
      descriptors: [],
      disclosures: [],
      builtinProjectionRevision: projection.revision,
      dynamicCatalogRevision: null,
    };
    const validateTask = (argumentsValue: Record<string, unknown>) => {
      const resolved = callbacks.resolve(call('task', argumentsValue, 'turn-planning'), context);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.failure.code);
      return callbacks.validate(resolved.value);
    };

    for (const subagent_type of ['code', 'review']) {
      const stablePublic = validateTask({
        name: 'Review planning decision',
        subagent_type,
        task: 'Policy, rather than the parser, owns this planning role decision.',
      });
      expect(stablePublic.ok).toBe(true);
    }
    const widenedPrivate = validateTask({
      name: 'Inspect planning surface',
      subagent_type: 'explore',
      taskArtifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'subagent_task_request',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 32,
      },
    });
    expect(widenedPrivate.ok).toBe(false);

    const planningArguments = {
      name: 'Inspect planning projection',
      subagent_type: 'plan',
      task: 'Inspect the exact planning projection without widening its parser.',
    };
    const exact = validateTask(planningArguments);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    const taskEntry = projection.entries.find(
      (candidate) => candidate.visibility === 'model' && candidate.name === 'task',
    );
    if (taskEntry?.visibility !== 'model' || !taskEntry.modelInputSchema) {
      throw new Error('planning task entry missing');
    }
    expect(exact.value.request.schemaDigest).toBe(
      digestCapabilityBindingValue(taskEntry.modelInputSchema),
    );
    expect(exact.value.domainData).not.toHaveProperty('parserContext');

    const prepared = preparedFromTurnFixture(
      { projection, callbacks, context },
      'task',
      planningArguments,
    );
    expect(callbacks.verifyPreparedIdentity(prepared)).toEqual({ valid: true });
    expect(
      callbacks.verifyPreparedIdentity({
        ...prepared,
        input: {
          ...prepared.input,
          facts: {
            ...(prepared.input.facts as Readonly<Record<string, RuntimeJsonValue>>),
            parserContext: {
              workspace: '/workspace',
              phase: 'building',
            },
          },
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
  });

  test('maps activate_skill to skill family and validates nested descriptor/disclosure freshness', () => {
    const valid = skillFixture();
    const resolved = valid.callbacks.resolve(
      call(
        'activate_skill',
        { skill_id: 'skill:fixture', input: { target: 'README.md' } },
        'turn-specialized',
      ),
      valid.context,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.target.executionFamily).toBe('skill');
    const validated = valid.callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.nestedCapability?.descriptor.capabilityId).toBe('skill:fixture');
    expect(validated.value.domainData).toMatchObject({
      nestedCapabilityId: 'skill:fixture',
      nestedCapabilityRevision: valid.context.descriptors[0]?.revision,
    });
    const classified = valid.callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value).toMatchObject({
      descriptor: { capabilityId: 'skill:fixture', kind: 'skill' },
      effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      effectClass: 'external_side_effect',
      risk: 'workspace_write',
      minimumApproval: 'user',
      requirements: { receipt: 'effect_receipt', retry: 'none' },
    });
    // Builtin activation policy remains an identity check; nested Skill
    // effects are the governing classification facts.
    expect(classified.value.policyCompilation?.effectiveEffects).not.toEqual(
      classified.value.effectiveEffects,
    );
    expect(classified.value.governance).toMatchObject({
      invocation: {
        operationId: 'builtin:activate_skill',
        nestedCapabilityId: 'skill:fixture',
        nestedCapabilityRevision: valid.context.descriptors[0]?.revision,
        nestedCatalogRevision: DYNAMIC_CATALOG_REVISION,
        dynamicCatalogRevision: null,
        commandDigest: null,
      },
      nestedSkill: {
        operationId: 'builtin:activate_skill',
        capabilityId: 'skill:fixture',
        nestedCatalogRevision: DYNAMIC_CATALOG_REVISION,
      },
      dynamicMcp: null,
    });
    expect(valid.callbacks.verifyClassifiedIdentity(classified.value)).toEqual({ valid: true });

    const activateEntry = valid.projection.entries.find(
      (candidate) => candidate.visibility === 'model' && candidate.name === 'activate_skill',
    );
    if (activateEntry?.visibility !== 'model') throw new Error('activate entry missing');
    const validatedDomainData = validated.value.domainData as Readonly<
      Record<string, RuntimeJsonValue>
    >;
    const nestedIdentity = {
      invocationId: 'skill-invocation',
      attemptId: 'skill-attempt',
      toolCallId: 'call-1',
      turnId: resolved.value.call.createdAtTurnId,
      modelMessageId: resolved.value.call.modelMessageId,
      argumentOrigin: resolved.value.call.argumentOrigin,
      providerId: activateEntry.providerId,
      operationId: activateEntry.operationId as NonDynamicOperationId,
      executionFamily: 'skill' as const,
      capabilityId: activateEntry.capabilityId,
      capabilityRevision: activateEntry.revision,
      descriptorRevision: activateEntry.descriptor.revision,
      parserRevision: activateEntry.parser.parserRevision,
      executorRevision: activateEntry.executorRevision,
      argumentsDigest: validated.value.request.argumentsDigest,
      schemaDigest: validated.value.request.schemaDigest,
      effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
      policyDigest: null,
      authorizationDigest: null,
      admissionDigest: null,
      idempotencyKeyArgument: null,
      idempotencyKey: null,
      executionMechanism: activateEntry.executionMechanism,
      bindingId: null,
      visibility: 'model' as const,
      modelVisible: true as const,
      exposedToolName: activateEntry.name,
      builtinProjectionRevision: valid.projection.revision,
      dynamicCatalogRevision: null,
      nestedCapabilityId: 'skill:fixture',
      nestedCapabilityRevision: valid.context.descriptors[0]?.revision ?? null,
      nestedCatalogRevision: resolved.value.dynamicCatalogRevision,
      isDynamicMcp: false as const,
      toolKind: activateEntry.kind as CapabilityToolKind,
    };
    const outerPrepared = {
      identity: nestedIdentity,
      input: {
        invocationId: nestedIdentity.invocationId,
        attemptId: nestedIdentity.attemptId,
        toolCallId: nestedIdentity.toolCallId,
        arguments: validated.value.request.arguments,
        facts: validatedDomainData,
        binding: null,
      },
    } as const satisfies PreparedToolInvocation;
    const nestedFacts = validatedDomainData.nestedSkill as Record<string, unknown>;
    expect(valid.callbacks.verifyPreparedIdentity(outerPrepared)).toEqual({ valid: true });
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        input: { ...outerPrepared.input, facts: nestedFacts },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        input: {
          ...outerPrepared.input,
          facts: {
            ...validatedDomainData,
            nestedSkill: {
              ...nestedFacts,
              nestedCatalogRevision: 'd'.repeat(64),
            },
          },
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
    for (const patch of [
      { dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION },
      { nestedCapabilityId: 'skill:other' },
      { nestedCapabilityRevision: 'stale-skill-revision' },
      { nestedCatalogRevision: 'd'.repeat(64) },
    ]) {
      expect(
        valid.callbacks.verifyPreparedIdentity({
          ...outerPrepared,
          identity: { ...nestedIdentity, ...patch },
        } as unknown as PreparedToolInvocation),
      ).toMatchObject({ valid: false });
    }
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        identity: {
          ...nestedIdentity,
          effectiveEffectsDigest: digestCapabilityBindingValue(
            activateEntry.classifyEffects(validated.value.request.arguments).effectiveEffects,
          ),
        },
      }),
    ).toMatchObject({ valid: false });
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        input: {
          ...outerPrepared.input,
          facts: {
            ...validatedDomainData,
            nestedSkill: { ...nestedFacts, descriptor: { skillId: 'only-id' } },
          },
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        input: {
          ...outerPrepared.input,
          facts: {
            ...validatedDomainData,
            nestedSkill: {
              ...nestedFacts,
              disclosure: {
                ...(nestedFacts.disclosure as Record<string, unknown>),
                issuedForTurnId: 'stale-turn',
              },
            },
          },
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
    expect(
      valid.callbacks.verifyPreparedIdentity({
        ...outerPrepared,
        input: { ...outerPrepared.input, facts: undefined },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });

    const missingDisclosure = skillFixture({ omitDisclosure: true });
    const missingResolved = missingDisclosure.callbacks.resolve(
      call('activate_skill', { skill_id: 'skill:fixture', input: {} }, 'turn-specialized'),
      missingDisclosure.context,
    );
    expect(missingResolved.ok).toBe(true);
    if (!missingResolved.ok) return;
    const missing = missingDisclosure.callbacks.validate(missingResolved.value);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe('disclosure_missing');

    const staleDisclosure = skillFixture({
      disclosure: {
        capabilityId: 'skill:fixture',
        capabilityRevision: skillDescriptor().revision,
        issuedForTurnId: 'old-turn',
      },
    });
    const staleResolved = staleDisclosure.callbacks.resolve(
      call('activate_skill', { skill_id: 'skill:fixture', input: {} }, 'turn-specialized'),
      staleDisclosure.context,
    );
    expect(staleResolved.ok).toBe(true);
    if (!staleResolved.ok) return;
    const stale = staleDisclosure.callbacks.validate(staleResolved.value);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure.code).toBe('disclosure_stale');

    const unavailable = skillFixture({ descriptor: skillDescriptor({ availability: 'degraded' }) });
    const unavailableResolved = unavailable.callbacks.resolve(
      call('activate_skill', { skill_id: 'skill:fixture', input: {} }, 'turn-specialized'),
      unavailable.context,
    );
    expect(unavailableResolved.ok).toBe(true);
    if (!unavailableResolved.ok) return;
    const invalidNested = unavailable.callbacks.validate(unavailableResolved.value);
    expect(invalidNested.ok).toBe(false);
    if (!invalidNested.ok) expect(invalidNested.failure.code).toBe('nested_capability_invalid');
  });

  test('accepts the exact prepared identity and rejects every identity seam tamper', () => {
    const value = preparedReadFile();
    expect(value.callbacks.verifyPreparedIdentity(value.prepared)).toEqual({ valid: true });
    const tamper = (patch: Record<string, unknown>) =>
      value.callbacks.verifyPreparedIdentity({
        ...value.prepared,
        identity: { ...value.prepared.identity, ...patch },
      } as unknown as PreparedToolInvocation);
    for (const patch of [
      { operationId: 'builtin:write_file' },
      { executionFamily: 'skill' },
      { toolKind: 'coordination' },
      { providerId: 'forged-provider' },
      { executorRevision: 'forged-executor' },
      { capabilityId: 'builtin:write_file' },
      { descriptorRevision: 'forged-descriptor' },
      { parserRevision: 'forged-parser' },
      { schemaDigest: 'forged-schema' },
      { effectiveEffectsDigest: 'forged-effects' },
      { exposedToolName: 'write_file' },
      { builtinProjectionRevision: 'stale-projection' },
      { dynamicCatalogRevision: 'stale-dynamic-catalog' },
      { nestedCapabilityId: 'skill:forged' },
      { nestedCapabilityRevision: 'forged-skill-revision' },
      { nestedCatalogRevision: 'd'.repeat(64) },
      { argumentsDigest: 'forged-arguments' },
      { turnId: 'cross-turn' },
      { modelMessageId: 'cross-message' },
      { argumentOrigin: 'runtime_private' },
      { bindingId: 'forged-binding' },
      { idempotencyKeyArgument: 'request_id' },
      { idempotencyKey: 'request-id' },
    ]) {
      expect(verificationValid(tamper(patch))).toBe(false);
    }
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...value.prepared,
        input: { ...value.prepared.input, arguments: { path: 'other.md' } },
      }),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...value.prepared,
        input: { ...value.prepared.input, binding: { bindingId: 'forged' } },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...value.prepared,
        identity: {
          ...value.prepared.identity,
          isDynamicMcp: true,
          operationId: 'mcp:dynamic_tool',
          executionFamily: 'mcp',
          visibility: 'internal',
          modelVisible: false,
          exposedToolName: null,
          builtinProjectionRevision: null,
          dynamicCatalogRevision: 'mcp-catalog-1',
        },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
  });

  test('authenticates the bounded approval summary from the exact entry and canonical arguments', () => {
    const value = turnFixture();
    const readPrepared = preparedFromTurnFixture(value, 'read_file', { path: 'README.md' });
    const writePrepared = preparedFromTurnFixture(value, 'write_file', {
      path: 'README.md',
      content: 'replacement',
    });
    const readFacts = readPrepared.input.facts as Readonly<Record<string, RuntimeJsonValue>>;
    const writeFacts = writePrepared.input.facts as Readonly<Record<string, RuntimeJsonValue>>;
    const readApprovalSummary = readFacts.approvalSummary;
    const writeApprovalSummary = writeFacts.approvalSummary;
    if (typeof readApprovalSummary !== 'string' || typeof writeApprovalSummary !== 'string') {
      throw new Error('prepared approval summary missing');
    }
    const readEntry = value.projection.entries.find(
      (entry) => entry.visibility === 'model' && entry.name === 'read_file',
    );
    const writeEntry = value.projection.entries.find(
      (entry) => entry.visibility === 'model' && entry.name === 'write_file',
    );
    if (readEntry?.visibility !== 'model' || writeEntry?.visibility !== 'model') {
      throw new Error('filesystem catalog entry missing');
    }

    expect(value.callbacks.verifyPreparedIdentity(readPrepared)).toEqual({ valid: true });
    expect(value.callbacks.verifyPreparedIdentity(writePrepared)).toEqual({ valid: true });
    expect(readApprovalSummary).toBe(
      readEntry.projectApprovalSummary(readPrepared.input.arguments),
    );
    expect(writeApprovalSummary).toBe(
      writeEntry.projectApprovalSummary(writePrepared.input.arguments),
    );
    expect(readFacts).toMatchObject({
      toolCallId: 'call-1',
      callCreatedAtTurnId: 'turn-specialized',
      modelMessageId: 'message-1',
      argumentOrigin: 'model_public',
      dynamicCatalogRevision: null,
    });
    expect(readApprovalSummary.length).toBeLessThanOrEqual(1024);
    expect(readApprovalSummary).not.toBe(writeApprovalSummary);

    expect(
      value.callbacks.verifyPreparedIdentity({
        ...readPrepared,
        input: {
          ...readPrepared.input,
          facts: { ...readFacts, approvalSummary: `${readApprovalSummary} tampered` },
        },
      }),
    ).toMatchObject({ valid: false, code: 'identity_mismatch' });

    const missingSummaryFacts = Object.fromEntries(
      Object.entries(readFacts).filter(([key]) => key !== 'approvalSummary'),
    ) as Record<string, RuntimeJsonValue>;
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...readPrepared,
        input: { ...readPrepared.input, facts: missingSummaryFacts },
      }),
    ).toMatchObject({ valid: false, code: 'identity_mismatch' });

    expect(
      value.callbacks.verifyPreparedIdentity({
        ...readPrepared,
        input: {
          ...readPrepared.input,
          facts: { ...readFacts, approvalSummary: writeApprovalSummary },
        },
      }),
    ).toMatchObject({ valid: false, code: 'identity_mismatch' });
  });

  test('does not import forbidden owners or dispatch/name-switch authorities', async () => {
    const source = await Bun.file(
      new URL('../src/tool-pipeline-callbacks.ts', import.meta.url),
    ).text();
    for (const forbidden of ['@kite-ai/runtime-host', '@kite-ai/agent-kernel', '#app', '@/core']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain('switch (call.name)');
    expect(source).not.toContain('switch (entry.name)');
    expect(source).not.toContain('dispatch(');
  });

  test('keeps identity digest construction stable for binding checks', () => {
    const value = preparedReadFile();
    const entry = value.projection.entries.find(
      (candidate) => candidate.visibility === 'model' && candidate.name === 'read_file',
    );
    expect(entry).toBeDefined();
    expect(
      digestCapabilityBindingValue({ schema: 'identity', operation: 'read_file' }),
    ).toHaveLength(64);
  });
});
