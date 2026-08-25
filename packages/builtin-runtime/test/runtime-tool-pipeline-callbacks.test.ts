import { describe, expect, test } from 'bun:test';
import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import type {
  CapabilityToolKind,
  ClassifiedInvocation,
  DynamicMcpPreparedToolInvocationIdentity,
  DynamicMcpToolTarget,
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  ResolvedInvocation,
  ToolCallSnapshot,
  ToolPipelineResolutionContext,
  ValidatedInvocation,
} from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { createCapabilityBinding, digestCapabilityBindingValue } from '../src/capability-binding';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '../src/index';
import { createBuiltinRuntimeToolPipelineCallbacks } from '../src/runtime-tool-pipeline-callbacks';

const STAGE_SCHEMA = 'kite.tool-pipeline-stage.v1' as const;
const ORDINARY_TURN_ID = 'turn-bundle-ordinary';
const DYNAMIC_TURN_ID = 'turn-bundle-dynamic';
const DYNAMIC_TOOL_NAME = 'mcp__fixture__search' as const;
const DYNAMIC_CATALOG_REVISION = 'd'.repeat(64);

function projectionFixture() {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  return createBuiltinToolCatalogProjection(registry.snapshot(), {
    turnContext: { workspace: '/workspace', phase: 'building' },
  });
}

function ordinaryFixture(
  projection = projectionFixture(),
  callbacksOverride?: ReturnType<typeof createBuiltinRuntimeToolPipelineCallbacks>,
) {
  const callbacks = callbacksOverride ?? createBuiltinRuntimeToolPipelineCallbacks(projection);
  const context: ToolPipelineResolutionContext = {
    currentTurnId: ORDINARY_TURN_ID,
    availabilityContext: { workspace: '/workspace', phase: 'building' },
    bindings: [],
    descriptors: [],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
  };
  const call: ToolCallSnapshot = {
    schema: STAGE_SCHEMA,
    stage: 'snapshot',
    toolCallId: 'ordinary-call',
    name: 'read_file',
    rawArguments: { path: 'README.md' },
    argumentOrigin: 'model_public',
    createdAtTurnId: ORDINARY_TURN_ID,
    modelMessageId: 'ordinary-message',
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  };
  return { projection, callbacks, context, call };
}

function dynamicDescriptor(): CapabilityDescriptor {
  const inputSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  };
  const base: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: 'mcp:fixture.search',
    kind: 'mcp_tool',
    displayName: 'Fixture Search',
    description: 'A dynamic MCP fixture search.',
    provider: { type: 'mcp', id: 'fixture-server', provenance: 'remote' },
    inputSchema,
    declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    execution: { retry: 'safe_read' },
    availability: 'available',
    diagnostics: [],
  };
  return { ...base, revision: digestCapabilityBindingValue(base) };
}

function dynamicFixture(
  projection = projectionFixture(),
  callbacksOverride?: ReturnType<typeof createBuiltinRuntimeToolPipelineCallbacks>,
) {
  const subject = dynamicDescriptor();
  if (!subject.inputSchema) throw new Error('dynamic subject schema missing');
  const binding = createCapabilityBinding({
    capabilityId: subject.capabilityId,
    capabilityRevision: subject.revision,
    exposedToolName: DYNAMIC_TOOL_NAME,
    inputSchema: subject.inputSchema,
    turnId: DYNAMIC_TURN_ID,
  });
  const context: ToolPipelineResolutionContext = {
    currentTurnId: DYNAMIC_TURN_ID,
    availabilityContext: { workspace: '/workspace', phase: 'building' },
    bindings: [binding],
    descriptors: [subject],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
  };
  const callbacks = callbacksOverride ?? createBuiltinRuntimeToolPipelineCallbacks(projection);
  const call: ToolCallSnapshot = {
    schema: STAGE_SCHEMA,
    stage: 'snapshot',
    toolCallId: 'dynamic-call',
    name: DYNAMIC_TOOL_NAME,
    rawArguments: { query: 'kite' },
    argumentOrigin: 'model_public',
    createdAtTurnId: DYNAMIC_TURN_ID,
    modelMessageId: 'dynamic-message',
    bindingId: binding.bindingId,
    capabilityId: binding.capabilityId,
    capabilityRevision: binding.capabilityRevision,
  };
  return { projection, callbacks, context, call, subject, binding };
}

function prepareOrdinary(value: ReturnType<typeof ordinaryFixture>): {
  readonly prepared: PreparedToolInvocation;
  readonly resolved: Readonly<ResolvedInvocation>;
  readonly validated: Readonly<ValidatedInvocation>;
  readonly classified: Readonly<ClassifiedInvocation>;
} {
  const resolved = value.callbacks.resolve(value.call, value.context);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = value.callbacks.validate(resolved.value);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = value.callbacks.classify(validated.value);
  expect(classified.ok).toBe(true);
  if (!classified.ok) throw new Error(classified.failure.code);
  const entry = value.projection.entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'read_file',
  );
  if (entry?.visibility !== 'model') throw new Error('ordinary entry missing');
  const identity: NonDynamicPreparedToolInvocationIdentity = {
    invocationId: 'ordinary-invocation',
    attemptId: 'ordinary-attempt',
    toolCallId: value.call.toolCallId,
    turnId: value.call.createdAtTurnId,
    modelMessageId: value.call.modelMessageId,
    argumentOrigin: value.call.argumentOrigin,
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: 'builtin',
    executionMechanism: entry.executionMechanism,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: entry.parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
    policyDigest: null,
    authorizationDigest: null,
    admissionDigest: null,
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: entry.name,
    builtinProjectionRevision: value.projection.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: entry.kind as CapabilityToolKind,
  };
  const prepared: PreparedToolInvocation = {
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: validated.value.request.arguments,
      facts: validated.value.domainData,
      binding: null,
    },
  };
  return {
    prepared,
    resolved: resolved.value,
    validated: validated.value,
    classified: classified.value,
  };
}

function prepareDynamic(value: ReturnType<typeof dynamicFixture>): {
  readonly prepared: PreparedToolInvocation;
  readonly resolved: Readonly<ResolvedInvocation>;
  readonly validated: Readonly<ValidatedInvocation>;
  readonly classified: Readonly<ClassifiedInvocation>;
} {
  const resolved = value.callbacks.resolve(value.call, value.context);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = value.callbacks.validate(resolved.value);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = value.callbacks.classify(validated.value);
  expect(classified.ok).toBe(true);
  if (!classified.ok) throw new Error(classified.failure.code);
  const target = resolved.value.target as DynamicMcpToolTarget;
  if (!target.isDynamicMcp) throw new Error('dynamic target missing');
  const identity: DynamicMcpPreparedToolInvocationIdentity = {
    invocationId: 'dynamic-invocation',
    attemptId: 'dynamic-attempt',
    toolCallId: value.call.toolCallId,
    turnId: value.call.createdAtTurnId,
    modelMessageId: value.call.modelMessageId,
    argumentOrigin: 'model_public',
    providerId: target.providerId,
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    capabilityId: target.capabilityId,
    capabilityRevision: target.capabilityRevision,
    descriptorRevision: target.descriptorRevision,
    parserRevision: validated.value.request.schemaDigest,
    executorRevision: null,
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    effectiveEffectsDigest: classified.value.effectiveEffectsDigest,
    policyDigest: null,
    authorizationDigest: null,
    admissionDigest: null,
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: target.subject.bindingId,
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    isDynamicMcp: true,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: target.dynamicCatalogRevision,
    subject: target.subject,
    runtimeWrapper: target.runtimeWrapper,
  };
  const prepared: PreparedToolInvocation = {
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: validated.value.request.arguments,
      facts: validated.value.domainData,
      binding: value.binding,
    },
  };
  return {
    prepared,
    resolved: resolved.value,
    validated: validated.value,
    classified: classified.value,
  };
}

function validVerification(
  result: ReturnType<
    ReturnType<typeof createBuiltinRuntimeToolPipelineCallbacks>['verifyPreparedIdentity']
  >,
): boolean {
  return typeof result === 'boolean' ? result : result.valid;
}

describe('Builtin unified Tool Pipeline callbacks', () => {
  test('routes ordinary and dynamic operations through one frozen projection', () => {
    const projection = projectionFixture();
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const ordinary = prepareOrdinary(ordinaryFixture(projection, callbacks));
    const dynamic = prepareDynamic(dynamicFixture(projection, callbacks));

    expect(projection.entries).toHaveLength(28);
    expect(projection.entries.filter((entry) => entry.visibility === 'model')).toHaveLength(20);
    expect(projection.entries.filter((entry) => entry.visibility === 'internal')).toHaveLength(8);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(callbacks)).toBe(true);
    expect(validVerification(callbacks.verifyPreparedIdentity(ordinary.prepared))).toBe(true);
    expect(validVerification(callbacks.verifyPreparedIdentity(dynamic.prepared))).toBe(true);
    expect(callbacks.verifyClassifiedIdentity(ordinary.classified)).toEqual({ valid: true });
    expect(callbacks.verifyClassifiedIdentity(dynamic.classified)).toEqual({ valid: true });

    const ordinaryResolved = callbacks.resolve(
      ordinaryFixture(projection).call,
      ordinaryFixture(projection).context,
    );
    expect(ordinaryResolved.ok).toBe(true);
    if (ordinaryResolved.ok) {
      expect(ordinaryResolved.value.target).toMatchObject({
        executionFamily: 'builtin',
        isDynamicMcp: false,
        visibility: 'model',
        modelVisible: true,
        dynamicCatalogRevision: null,
      });
      expect(ordinaryResolved.value.dynamicCatalogRevision).toBe(DYNAMIC_CATALOG_REVISION);
    }

    const dynamicValue = dynamicFixture(projection);
    const dynamicResolved = callbacks.resolve(dynamicValue.call, dynamicValue.context);
    expect(dynamicResolved.ok).toBe(true);
    if (dynamicResolved.ok) {
      expect(dynamicResolved.value.target).toMatchObject({
        executionFamily: 'mcp',
        executionMechanism: 'mcp',
        operationId: 'mcp:dynamic_tool',
        isDynamicMcp: true,
        visibility: 'internal',
        modelVisible: false,
        exposedToolName: null,
      });
    }
  });

  test('rejects every partial binding identity before either owner is called', () => {
    const value = ordinaryFixture();
    const partials: readonly Partial<ToolCallSnapshot>[] = [
      { bindingId: 'binding-only' },
      { capabilityId: 'capability-only' },
      { capabilityRevision: 'revision-only' },
      { bindingId: 'binding', capabilityId: 'capability' },
      { capabilityId: 'capability', capabilityRevision: 'revision' },
    ];
    for (const partial of partials) {
      const result = value.callbacks.resolve({ ...value.call, ...partial }, value.context);
      expect(result).toEqual({
        ok: false,
        failure: {
          stage: 'resolve',
          code: 'binding_identity_mismatch',
          toolCallId: 'ordinary-call',
          toolName: 'read_file',
        },
      });
    }
  });

  test('routes validation and classification strictly by target discriminant', () => {
    const projection = projectionFixture();
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const ordinaryValue = ordinaryFixture(projection, callbacks);
    const ordinary = prepareOrdinary(ordinaryValue);
    const dynamicValue = dynamicFixture(projection, callbacks);
    const dynamic = prepareDynamic(dynamicValue);

    expect(callbacks.validate(ordinary.resolved).ok).toBe(true);
    expect(callbacks.classify(ordinary.validated).ok).toBe(true);
    expect(callbacks.validate(dynamic.resolved).ok).toBe(true);
    expect(callbacks.classify(dynamic.validated).ok).toBe(true);

    const ordinaryAsDynamic = {
      ...ordinary.resolved,
      target: { ...ordinary.resolved.target, isDynamicMcp: true },
    } as unknown as ResolvedInvocation;
    expect(callbacks.validate(ordinaryAsDynamic)).toMatchObject({ ok: false });

    const dynamicAsOrdinary = {
      ...dynamic.resolved,
      target: { ...dynamic.resolved.target, isDynamicMcp: false },
    } as unknown as ResolvedInvocation;
    expect(callbacks.validate(dynamicAsOrdinary)).toMatchObject({ ok: false });

    const ordinaryValidatedAsDynamic = {
      ...ordinary.validated,
      resolved: ordinaryAsDynamic,
    } as unknown as ValidatedInvocation;
    expect(callbacks.classify(ordinaryValidatedAsDynamic)).toMatchObject({ ok: false });

    const dynamicValidatedAsOrdinary = {
      ...dynamic.validated,
      resolved: dynamicAsOrdinary,
    } as unknown as ValidatedInvocation;
    expect(callbacks.classify(dynamicValidatedAsOrdinary)).toMatchObject({ ok: false });
  });

  test('routes prepared identity verification by identity discriminant and fails cross-branch drift', () => {
    const projection = projectionFixture();
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const ordinary = prepareOrdinary(ordinaryFixture(projection, callbacks));
    const dynamic = prepareDynamic(dynamicFixture(projection, callbacks));

    const ordinaryAsDynamic = {
      ...ordinary.prepared,
      identity: { ...ordinary.prepared.identity, isDynamicMcp: true },
    } as unknown as PreparedToolInvocation;
    expect(validVerification(callbacks.verifyPreparedIdentity(ordinaryAsDynamic))).toBe(false);

    const dynamicAsOrdinary = {
      ...dynamic.prepared,
      identity: {
        ...dynamic.prepared.identity,
        isDynamicMcp: false,
        visibility: 'model',
        modelVisible: true,
        exposedToolName: DYNAMIC_TOOL_NAME,
      },
    } as unknown as PreparedToolInvocation;
    expect(validVerification(callbacks.verifyPreparedIdentity(dynamicAsOrdinary))).toBe(false);

    const malformed = {
      ...ordinary.prepared,
      identity: { ...ordinary.prepared.identity, isDynamicMcp: 'false' },
    } as unknown as PreparedToolInvocation;
    expect(callbacks.verifyPreparedIdentity(malformed)).toEqual({
      valid: false,
      code: 'identity_mismatch',
    });

    const foreign = createBuiltinRuntimeToolPipelineCallbacks(projection);
    expect(foreign.verifyClassifiedIdentity(ordinary.classified)).toMatchObject({
      valid: false,
      code: 'governance_missing',
    });
    expect(foreign.verifyClassifiedIdentity(dynamic.classified)).toMatchObject({
      valid: false,
      code: 'governance_missing',
    });
    expect(callbacks.verifyClassifiedIdentity(structuredClone(ordinary.classified))).toMatchObject({
      valid: false,
      code: 'governance_missing',
    });

    const tamperedGovernance = {
      ...ordinary.classified,
      governance: {
        ...ordinary.classified.governance,
        invocation: {
          ...ordinary.classified.governance.invocation,
          modelMessageId: 'forged-message',
        },
      },
    } as unknown as ClassifiedInvocation;
    expect(callbacks.verifyClassifiedIdentity(tamperedGovernance)).toMatchObject({
      valid: false,
      code: 'governance_missing',
    });
  });

  test('preserves ordinary argument-origin and visibility boundaries', () => {
    const ordinary = ordinaryFixture();
    const runtimePrivate = ordinary.callbacks.resolve(
      { ...ordinary.call, argumentOrigin: 'runtime_private' },
      ordinary.context,
    );
    expect(runtimePrivate.ok).toBe(true);
    if (runtimePrivate.ok) {
      expect(ordinary.callbacks.validate(runtimePrivate.value)).toMatchObject({ ok: false });
    }

    const askUser = ordinary.callbacks.resolve(
      { ...ordinary.call, name: 'ask_user', rawArguments: {} },
      ordinary.context,
    );
    expect(askUser).toMatchObject({
      ok: true,
      value: { target: { operationId: 'builtin:ask_user', executionMechanism: 'user_input' } },
    });
    if (askUser.ok) {
      expect(ordinary.callbacks.validate(askUser.value)).toMatchObject({ ok: false });
    }

    const dynamic = dynamicFixture();
    expect(
      dynamic.callbacks.resolve(
        { ...dynamic.call, argumentOrigin: 'runtime_private' },
        dynamic.context,
      ),
    ).toMatchObject({ ok: false, failure: { code: 'unknown_tool' } });
  });

  test('contains only the neutral router and does not create a second authority', async () => {
    const source = await Bun.file(
      new URL('../src/runtime-tool-pipeline-callbacks.ts', import.meta.url),
    ).text();
    expect(source).not.toContain('@kite-ai/runtime-host');
    expect(source).not.toContain('#runtime-host');
    expect(source).not.toContain('@kite-ai/agent-kernel');
    expect(source).not.toContain('#agent-kernel');
    expect(source).not.toContain('#app/');
    expect(source).not.toContain('src/core/');
    expect(source).not.toContain('createRuntimeModuleRegistry');
    expect(source).not.toContain('.snapshot(');
    expect(source).not.toContain('try {');
    expect(source).not.toContain('catch');
  });
});
