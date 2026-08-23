import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinRuntimeToolPipelineCallbacks,
  createBuiltinToolCatalogProjection,
  createCapabilityBinding,
  digestCapabilityBindingValue,
  pendingToolRequestFromValidatedInvocation,
} from '@kite/builtin-runtime';
import type { CapabilityDescriptor, CapabilityDisclosure } from '@kite/runtime-contract';
import { createRuntimeHostStateToolGovernance } from '@kite/runtime-host/kernel-adapter';
import {
  type ClassifiedInvocation,
  createRuntimeModuleRegistry,
  type ToolCallSnapshot,
  type ToolPipelineResolutionContext,
} from '@kite/runtime-spi';

const STAGE_SCHEMA_ = 'kite.tool-pipeline-stage.v1' as const;
const TURN_ID = 'turn-governance-integration';
const MODEL_MESSAGE_ID = 'message-governance-integration';
const DYNAMIC_CATALOG_REVISION = 'd'.repeat(64);
const DYNAMIC_TOOL_NAME = 'mcp__fixture__search' as const;

function capabilityDescriptor(value: Omit<CapabilityDescriptor, 'revision'>): CapabilityDescriptor {
  return { ...value, revision: digestCapabilityBindingValue(value) };
}

function snapshot(
  name: string,
  rawArguments: ToolCallSnapshot['rawArguments'],
  binding: {
    readonly bindingId: string;
    readonly capabilityId: string;
    readonly capabilityRevision: string;
  } | null = null,
): ToolCallSnapshot {
  return Object.freeze({
    schema: STAGE_SCHEMA_,
    stage: 'snapshot' as const,
    toolCallId: `call-${name}`,
    name,
    rawArguments,
    argumentOrigin: 'model_public' as const,
    createdAtTurnId: TURN_ID,
    modelMessageId: MODEL_MESSAGE_ID,
    bindingId: binding?.bindingId ?? null,
    capabilityId: binding?.capabilityId ?? null,
    capabilityRevision: binding?.capabilityRevision ?? null,
  });
}

function classify(
  callbacks: ReturnType<typeof createBuiltinRuntimeToolPipelineCallbacks>,
  call: ToolCallSnapshot,
  context: ToolPipelineResolutionContext,
): Readonly<ClassifiedInvocation> {
  const resolved = callbacks.resolve(call, context);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = callbacks.validate(resolved.value);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = callbacks.classify(validated.value);
  expect(classified.ok).toBe(true);
  if (!classified.ok) throw new Error(classified.failure.code);
  return classified.value;
}

describe('RM-16 Builtin to Host governance bridge', () => {
  test('uses one frozen projection for ordinary MCP, nested Skill, and dynamic MCP facts', () => {
    const skill = capabilityDescriptor({
      capabilityId: 'skill:fixture',
      kind: 'skill',
      displayName: 'Fixture Skill',
      description: 'A fixture Skill for the cross-package governance seam.',
      provider: { type: 'skill', id: 'fixture', provenance: 'project' },
      inputSchema: { type: 'object', additionalProperties: true },
      declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      policy: { workspaceTrustRequired: true, minimumApproval: 'user' },
      execution: { retry: 'never' },
      availability: 'available',
      diagnostics: [],
    });
    const dynamic = capabilityDescriptor({
      capabilityId: 'mcp:fixture.search',
      kind: 'mcp_tool',
      displayName: 'Fixture Search',
      description: 'A fixture dynamic MCP capability.',
      provider: { type: 'mcp', id: 'fixture-server', provenance: 'remote' },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'safe_read' },
      availability: 'available',
      diagnostics: [],
    });
    if (!dynamic.inputSchema) throw new Error('dynamic schema missing');
    const dynamicBinding = createCapabilityBinding({
      capabilityId: dynamic.capabilityId,
      capabilityRevision: dynamic.revision,
      exposedToolName: DYNAMIC_TOOL_NAME,
      inputSchema: dynamic.inputSchema,
      turnId: TURN_ID,
    });
    const skillDisclosure: CapabilityDisclosure = Object.freeze({
      capabilityId: skill.capabilityId,
      capabilityRevision: skill.revision,
      issuedForTurnId: TURN_ID,
    });
    const turnContext = Object.freeze({
      workspace: '/workspace',
      phase: 'building' as const,
      featureFlags: Object.freeze({
        skillWorkflow: true as const,
        skillActivation: true as const,
      }),
      availableSkillIds: Object.freeze([skill.capabilityId]),
    });
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const registrySnapshot = registry.snapshot();
    const projection = createBuiltinToolCatalogProjection(registrySnapshot, { turnContext });
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const context: ToolPipelineResolutionContext = Object.freeze({
      currentTurnId: TURN_ID,
      availabilityContext: turnContext,
      bindings: Object.freeze([dynamicBinding]),
      descriptors: Object.freeze([skill, dynamic]),
      disclosures: Object.freeze([skillDisclosure]),
      builtinProjectionRevision: projection.revision,
      dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
    });
    const host = createRuntimeHostStateToolGovernance({
      verifyClassifiedIdentity: callbacks.verifyClassifiedIdentity,
    });
    const admission = Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: Object.freeze([]),
    });
    const project = (classified: Readonly<ClassifiedInvocation>) =>
      host.project(
        Object.freeze({
          classified,
          workspace: '/workspace',
          threadId: 'thread-governance-integration',
          context: Object.freeze({
            phase: 'building' as const,
            interactionMode: 'accept_edits' as const,
            authorizationMode: 'default' as const,
            sandboxAvailable: true,
            circuitBreakerTripped: false,
            gates: Object.freeze({
              recoveryAdmission: 'admitted' as const,
              boundedCancellation: 'admitted' as const,
              executionBoundary: 'admitted' as const,
              skillCapabilityCeiling: 'admitted' as const,
            }),
            observedAt: 1_000,
          }),
          approval: Object.freeze({
            status: 'queued' as const,
            grant: 'none' as const,
            approvedToolCallId: null,
            approvalBindingDigest: null,
          }),
        }),
        admission,
      );

    const ordinary = classify(callbacks, snapshot('list_mcp_tools', {}), context);
    const ordinaryFacts = project(ordinary);
    expect(ordinaryFacts.ok).toBe(true);
    if (!ordinaryFacts.ok) return;
    expect(ordinaryFacts.value).toMatchObject({
      invocation: {
        operationId: 'builtin:list_mcp_tools',
        capabilityId: 'builtin:list_mcp_tools',
        builtinCatalogRevision: projection.revision,
        dynamicCatalogRevision: null,
      },
      context: { executionMechanism: 'other' },
    });
    expect(pendingToolRequestFromValidatedInvocation(ordinary.validated, projection)).toMatchObject(
      {
        source: 'builtin',
        id: 'call-list_mcp_tools',
        name: 'list_mcp_tools',
        operationId: 'builtin:list_mcp_tools',
        catalogRevision: projection.revision,
      },
    );

    const nested = classify(
      callbacks,
      snapshot('activate_skill', { skill_id: skill.capabilityId, input: {} }),
      context,
    );
    const nestedFacts = project(nested);
    expect(nestedFacts.ok).toBe(true);
    if (!nestedFacts.ok) return;
    expect(nestedFacts.value).toMatchObject({
      invocation: {
        operationId: 'builtin:activate_skill',
        builtinCatalogRevision: projection.revision,
        dynamicCatalogRevision: null,
        nestedCapabilityId: skill.capabilityId,
        nestedCapabilityRevision: skill.revision,
        nestedCatalogRevision: DYNAMIC_CATALOG_REVISION,
      },
      nestedSkill: { decision: 'ask', minimumApproval: 'user' },
    });

    const dynamicClassified = classify(
      callbacks,
      snapshot(DYNAMIC_TOOL_NAME, { query: 'kite' }, dynamicBinding),
      context,
    );
    const dynamicFacts = project(dynamicClassified);
    expect(dynamicFacts.ok).toBe(true);
    if (!dynamicFacts.ok) return;
    expect(dynamicFacts.value).toMatchObject({
      invocation: {
        exposedToolName: DYNAMIC_TOOL_NAME,
        operationId: 'mcp:dynamic_tool',
        capabilityId: dynamic.capabilityId,
        builtinCatalogRevision: null,
        dynamicCatalogRevision: DYNAMIC_CATALOG_REVISION,
      },
      dynamicMcp: { minimumApproval: 'none', readOnly: true },
    });

    expect(project(structuredClone(dynamicClassified))).toMatchObject({
      ok: false,
      failure: { code: 'classified_identity_invalid' },
    });
  });
});
