import { describe, expect, test } from 'bun:test';
import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import type {
  DynamicMcpPreparedToolInvocationIdentity,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolCallSnapshot,
  ToolPipelineResolutionContext,
} from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { createCapabilityBinding, digestCapabilityBindingValue } from '../src/capability-binding';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '../src/index';
import {
  BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_,
  createBuiltinDynamicMcpSubjectFacts,
  createBuiltinDynamicMcpToolPipelineCallbacks,
} from '../src/mcp/tool-pipeline-callbacks';

const STAGE_SCHEMA = 'kite.tool-pipeline-stage.v1' as const;
const TURN_ID = 'turn-mcp-1';
const MCP_NAME = 'mcp__fixture__search' as const;

function descriptor(
  overrides: Partial<Omit<CapabilityDescriptor, 'revision'>> = {},
): CapabilityDescriptor {
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
  const candidate = { ...base, ...overrides };
  return { ...candidate, revision: digestCapabilityBindingValue(candidate) };
}

function fixture(subject = descriptor()) {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjection(registry.snapshot(), {
    turnContext: { workspace: '/workspace', phase: 'building' },
  });
  if (!subject.inputSchema) throw new Error('subject schema missing');
  const binding = createCapabilityBinding({
    capabilityId: subject.capabilityId,
    capabilityRevision: subject.revision,
    exposedToolName: MCP_NAME,
    inputSchema: subject.inputSchema,
    turnId: TURN_ID,
  });
  const context: ToolPipelineResolutionContext = {
    currentTurnId: TURN_ID,
    availabilityContext: { workspace: '/workspace', phase: 'building' },
    bindings: [binding],
    descriptors: [subject],
    disclosures: [],
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: 'd'.repeat(64),
  };
  const callbacks = createBuiltinDynamicMcpToolPipelineCallbacks(projection);
  const call: ToolCallSnapshot = {
    schema: STAGE_SCHEMA,
    stage: 'snapshot',
    toolCallId: 'tool-call-1',
    name: MCP_NAME,
    rawArguments: { query: 'kite' },
    argumentOrigin: 'model_public',
    createdAtTurnId: TURN_ID,
    modelMessageId: 'message-1',
    bindingId: binding.bindingId,
    capabilityId: binding.capabilityId,
    capabilityRevision: binding.capabilityRevision,
  };
  return { projection, subject, binding, context, callbacks, call };
}

function prepareDynamic(value: ReturnType<typeof fixture>): PreparedToolInvocation {
  const resolved = value.callbacks.resolve(value.call, value.context);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = value.callbacks.validate(resolved.value);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = value.callbacks.classify(validated.value);
  expect(classified.ok).toBe(true);
  if (!classified.ok) throw new Error(classified.failure.code);
  const wrapperEntry = value.projection.entries.find(
    (entry) => entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
  );
  if (wrapperEntry?.visibility !== 'internal') throw new Error('wrapper missing');
  const target = resolved.value.target as import('@kite-ai/runtime-spi').DynamicMcpToolTarget;
  if (!target.isDynamicMcp) throw new Error('dynamic target missing');
  const identity: DynamicMcpPreparedToolInvocationIdentity = {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: value.call.toolCallId,
    turnId: TURN_ID,
    modelMessageId: 'message-1',
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
  return {
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: validated.value.request.arguments,
      binding: value.binding,
      facts: validated.value.domainData,
    },
  };
}

describe('Builtin dynamic MCP Tool Pipeline callbacks', () => {
  test('resolves the subject and retains an independent internal wrapper identity', () => {
    const value = fixture();
    const result = value.callbacks.resolve(value.call, value.context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toMatchObject({
      executionFamily: 'mcp',
      executionMechanism: 'mcp',
      operationId: 'mcp:dynamic_tool',
      visibility: 'internal',
      modelVisible: false,
      exposedToolName: null,
      isDynamicMcp: true,
      capabilityId: value.subject.capabilityId,
      providerId: value.subject.provider.id,
    });
    const target = result.value.target as import('@kite-ai/runtime-spi').DynamicMcpToolTarget;
    expect(target.subject.exposedToolName).toBe(MCP_NAME);
    expect(target.runtimeWrapper.capabilityId).toBe('mcp:dynamic_tool');
    expect(target.runtimeWrapper.builtinProjectionRevision).toBe(value.projection.revision);
    expect(target.runtimeWrapper.capabilityRevision).not.toBe(value.subject.revision);
    expect(
      value.callbacks.resolve(value.call, {
        ...value.context,
        dynamicCatalogRevision: value.projection.revision,
      }).ok,
    ).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
  });

  test('canonicalizes with the existing MCP schema owner and classifies subject effects', () => {
    const value = fixture();
    const resolved = value.callbacks.resolve(value.call, value.context);
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = value.callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.request).toMatchObject({
      source: 'mcp',
      operationId: 'mcp:dynamic_tool',
      name: MCP_NAME,
      schemaDigest: digestCapabilityBindingValue(value.subject.inputSchema),
    });
    const classified = value.callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.policyCompilation).toMatchObject({
      operationId: 'mcp:dynamic_tool',
      capabilityRevision: value.subject.revision,
      parserRevision: validated.value.request.schemaDigest,
    });
    expect(classified.value.effectiveEffects).toEqual(value.subject.effectiveEffects);
    expect(classified.value.executionTraits).toBeNull();
    expect(classified.value.requirements.receipt).toBe('observation_receipt');
    expect(classified.value.governance).toMatchObject({
      invocation: {
        isDynamicMcp: true,
        executionFamily: 'mcp',
        executionMechanism: 'mcp',
        operationId: 'mcp:dynamic_tool',
        visibility: 'internal',
        modelVisible: false,
        exposedToolName: MCP_NAME,
        builtinProjectionRevision: null,
        dynamicCatalogRevision: value.context.dynamicCatalogRevision,
        nestedCatalogRevision: null,
        commandDigest: null,
      },
      dynamicMcp: {
        isDynamicMcp: true,
        minimumApproval: value.subject.policy.minimumApproval,
        readOnly: true,
      },
      nestedSkill: null,
    });
    const governanceInvocation = classified.value.governance.invocation;
    if (!governanceInvocation.isDynamicMcp) throw new Error('dynamic governance missing');
    const target = classified.value.validated.resolved.target;
    if (!target.isDynamicMcp) throw new Error('dynamic target missing');
    expect(governanceInvocation.subject).toBe(target.subject);
    expect(classified.value.governance.policy).toBe(classified.value.policyCompilation);
    expect(classified.value.governance.effectiveEffects).toBe(classified.value.effectiveEffects);
    expect(value.callbacks.verifyClassifiedIdentity(classified.value)).toEqual({ valid: true });
    expect(
      value.callbacks.verifyClassifiedIdentity(structuredClone(classified.value)),
    ).toMatchObject({ valid: false, code: 'governance_missing' });
  });

  test('projects minimumApproval and readOnly from the exact dynamic subject effects', () => {
    const value = fixture(
      descriptor({
        declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
      }),
    );
    const resolved = value.callbacks.resolve(value.call, value.context);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const validated = value.callbacks.validate(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const classified = value.callbacks.classify(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.governance.dynamicMcp).toMatchObject({
      minimumApproval: 'user',
      readOnly: false,
    });
    expect(classified.value.effectiveEffects).toEqual({
      filesystem: 'none',
      network: 'read',
      externalState: 'none',
    });
    expect(value.callbacks.verifyClassifiedIdentity(classified.value)).toEqual({ valid: true });

    const autoReview = fixture(
      descriptor({
        declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        policy: { workspaceTrustRequired: false, minimumApproval: 'auto_review' },
      }),
    );
    const autoReviewResolved = autoReview.callbacks.resolve(autoReview.call, autoReview.context);
    expect(autoReviewResolved.ok).toBe(true);
    if (!autoReviewResolved.ok) return;
    const autoReviewValidated = autoReview.callbacks.validate(autoReviewResolved.value);
    expect(autoReviewValidated.ok).toBe(true);
    if (!autoReviewValidated.ok) return;
    const autoReviewClassified = autoReview.callbacks.classify(autoReviewValidated.value);
    expect(autoReviewClassified.ok).toBe(true);
    if (!autoReviewClassified.ok) return;
    expect(autoReviewClassified.value.governance.dynamicMcp?.readOnly).toBe(false);
  });

  test('verifies a prepared packet only when facts, subject binding, and wrapper all match', () => {
    const value = fixture();
    const prepared = prepareDynamic(value);
    const result = value.callbacks.verifyPreparedIdentity(prepared);
    expect(result).toEqual({ valid: true });
    expect(Object.isFrozen(result)).toBe(true);

    const tamperedFacts = {
      ...(prepared.input.facts as Record<string, RuntimeJsonValue>),
      providerId: 'forged-provider',
    };
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        input: { ...prepared.input, facts: tamperedFacts },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });

    const dynamicIdentity = prepared.identity as DynamicMcpPreparedToolInvocationIdentity;
    const tamperedWrapper = {
      ...dynamicIdentity.runtimeWrapper,
      executorRevision: 'forged-executor',
    };
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        identity: { ...dynamicIdentity, runtimeWrapper: tamperedWrapper },
      }),
    ).toMatchObject({ valid: false, code: 'runtime_wrapper_mismatch' });

    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        identity: { ...dynamicIdentity, turnId: 'stale-turn' },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        identity: { ...dynamicIdentity, modelMessageId: 'stale-message' },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });
    const factsWithStaleCatalog = {
      ...(prepared.input.facts as Record<string, RuntimeJsonValue>),
      dynamicCatalogRevision: 'stale-catalog',
    };
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        input: { ...prepared.input, facts: factsWithStaleCatalog },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });
    const factsWithStaleTurn = {
      ...(prepared.input.facts as Record<string, RuntimeJsonValue>),
      issuedForTurnId: 'stale-turn',
    };
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        input: { ...prepared.input, facts: factsWithStaleTurn },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        identity: { ...dynamicIdentity, argumentOrigin: 'runtime_private' },
      } as unknown as PreparedToolInvocation),
    ).toMatchObject({ valid: false, code: 'visibility_mismatch' });
    const factsWithPrivateOrigin = {
      ...(prepared.input.facts as Record<string, RuntimeJsonValue>),
      argumentOrigin: 'runtime_private',
    };
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepared,
        input: { ...prepared.input, facts: factsWithPrivateOrigin },
      }),
    ).toMatchObject({ valid: false, code: 'subject_mismatch' });
  });

  test('fails closed for binding, turn, schema, descriptor, availability, and visibility confusion', () => {
    const value = fixture();
    expect(
      value.callbacks.resolve({ ...value.call, name: 'mcp__fixture__wrong' }, value.context),
    ).toMatchObject({ ok: false, failure: { code: 'binding_name_mismatch' } });
    expect(
      value.callbacks.resolve(value.call, {
        ...value.context,
        currentTurnId: 'stale-turn',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'call_turn_mismatch' } });
    expect(
      value.callbacks.resolve(value.call, {
        ...value.context,
        builtinProjectionRevision: 'forged-projection',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'resolution_context_invalid' } });
    expect(
      value.callbacks.resolve({ ...value.call, argumentOrigin: 'runtime_private' }, value.context),
    ).toMatchObject({ ok: false, failure: { code: 'unknown_tool' } });
    const unavailableBase = { ...value.subject, availability: 'unavailable' as const };
    expect(
      value.callbacks.resolve(value.call, {
        ...value.context,
        descriptors: [
          {
            ...unavailableBase,
            revision: digestCapabilityBindingValue(
              unavailableBase as Omit<CapabilityDescriptor, 'revision'>,
            ),
          },
        ],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'descriptor_revision_mismatch' } });
    const ordinaryIdentity = {
      ...prepareDynamic(value).identity,
      isDynamicMcp: false,
      visibility: 'model',
      modelVisible: true,
      exposedToolName: MCP_NAME,
    } as unknown as NonDynamicPreparedToolInvocationIdentity;
    expect(
      value.callbacks.verifyPreparedIdentity({
        ...prepareDynamic(value),
        identity: ordinaryIdentity,
      } as PreparedToolInvocation),
    ).toMatchObject({ valid: false });
  });

  test('facts use a stable JSON-safe schema and never expose executor or dispatch handles', () => {
    const value = fixture();
    const facts = createBuiltinDynamicMcpSubjectFacts(value.subject, MCP_NAME, {
      dynamicCatalogRevision: value.context.dynamicCatalogRevision!,
      bindingId: value.binding.bindingId,
      issuedForTurnId: value.binding.issuedForTurnId,
      callCreatedAtTurnId: TURN_ID,
      modelMessageId: 'message-1',
      argumentOrigin: 'model_public',
    });
    expect(facts.schema).toBe(BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_);
    expect(facts.kind).toBe('mcp_tool');
    expect(facts.providerType).toBe('mcp');
    expect(facts.exposedToolName).toBe(MCP_NAME);
    expect(facts.descriptorDigest).toBe(digestCapabilityBindingValue(value.subject));
    expect(Object.isFrozen(facts)).toBe(true);
    expect('executor' in facts).toBe(false);
    expect('dispatch' in facts).toBe(false);
  });
});
