import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import { createCapabilitySnapshot } from '@kite-ai/builtin-runtime/skills';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { createRuntimeModuleRegistry, type ToolCallSnapshot } from '@kite-ai/runtime-spi';
import type { RootFollowupPolicyEvidence } from '#kite-service/bootstrap/runtime/agent-mailbox-port';
import {
  classifyCurrentFollowupCeiling,
  currentSourceFollowupPolicy,
} from '#kite-service/bootstrap/runtime/followup-policy-proof';
import { createAppToolPipelineComposition } from '#kite-service/bootstrap/runtime/tool-pipeline-composition';
import { createAppToolTurnContext } from '#kite-service/bootstrap/runtime/tool-turn-context';
import type { AgentConfig } from '#kite-service/config';

const config: AgentConfig = {
  apiKey: 'test',
  baseURL: 'http://localhost',
  modelName: 'manual',
  providerName: 'manual',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
  modelCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
  compaction: {},
};

function fixture() {
  const workspaceDigest = `sha256:${'a'.repeat(64)}`;
  const base = createRuntimeHostStateInitialState({
    threadId: 'source',
    userId: 'user',
    workspace: '/workspace',
    canonicalWorkspaceDigest: workspaceDigest,
    recoveryIdentityKey: '0'.repeat(64),
    interactionMode: 'full',
  });
  const catalog = createCapabilitySnapshot([]);
  const pipeline = createAppToolPipelineComposition(
    createBuiltinToolCatalogProjection(
      createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot(),
    ),
  );
  const context = createAppToolTurnContext({
    workspace: base.session.workspace,
    config,
    threadId: base.session.threadId,
    turnId: base.turn.turnId,
    modelMessageId: 'message',
    toolCallId: 'call',
    phase: 'building',
    interactionMode: 'full',
    hasTaskAdapter: true,
    agentMailboxAvailable: true,
  });
  const turn = pipeline.forTurn(context);
  const call: ToolCallSnapshot = {
    schema: 'kite.tool-pipeline-stage.v1',
    stage: 'snapshot',
    toolCallId: 'call',
    name: 'followup_task',
    rawArguments: { agent_id: 'child', message: 'continue' },
    argumentOrigin: 'model_public',
    createdAtTurnId: base.turn.turnId,
    modelMessageId: 'message',
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  };
  const resolved = turn.callbacks.resolve(call, {
    currentTurnId: base.turn.turnId,
    builtinProjectionRevision: turn.projection.revision,
    dynamicCatalogRevision: catalog.revision,
    availabilityContext: context,
    bindings: [],
    descriptors: [],
    disclosures: [],
  });
  if (!resolved.ok) throw new Error(`fixture resolve: ${resolved.failure.code}`);
  const validated = turn.callbacks.validate(resolved.value);
  if (!validated.ok) throw new Error(`fixture validate: ${validated.failure.code}`);
  const classified = turn.callbacks.classify(validated.value);
  if (!classified.ok) throw new Error(`fixture classify: ${classified.failure.code}`);
  const current = classified.value;
  const original: NonNullable<RootFollowupPolicyEvidence['preparedTool']> = {
    invocationId: 'invocation',
    operationId: current.governance.invocation.operationId,
    capabilityId: current.governance.invocation.capabilityId,
    capabilityRevision: current.governance.invocation.capabilityRevision,
    toolCallId: call.toolCallId,
    attemptId: 'invocation:attempt:1',
    modelMessageId: call.modelMessageId,
    turnId: call.createdAtTurnId,
    policyEffects: current.policyCompilation.effects ?? {},
    effectiveEffects: current.effectiveEffects,
    sandboxScope: current.policyCompilation.sandboxScope ?? null,
    authorizationKind: 'policy_allow',
    grantUsed: 'none',
    interactionMode: 'full',
    argumentsDigest: validated.value.request.argumentsDigest,
    schemaDigest: validated.value.request.schemaDigest,
    bindingId: null,
    effectiveEffectsDigest: current.effectiveEffectsDigest,
    authorizationDigest: 'auth',
    admissionDigest: 'admission',
    policyRevision: 'policy',
  };
  const admitted: RootFollowupPolicyEvidence = {
    phaseCeiling: 'building',
    authorizationDigest: 'auth',
    admissionDigest: 'admission',
    effectiveEffectsDigest: original.effectiveEffectsDigest,
    capabilityDigest: catalog.revision,
    policyRevision: 'policy',
    workspaceDigest,
    interactionModeRevision: base.interactionModeRevision,
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
    firstAttemptTimeoutMs: 1_000,
    boundedContext: true,
    preparedTool: original,
  };
  const state = {
    ...base,
    tools: {
      ...base.tools,
      calls: {
        [call.toolCallId]: {
          toolCallId: call.toolCallId,
          name: call.name,
          modelMessageId: call.modelMessageId,
          createdAtTurnId: call.createdAtTurnId,
          args: call.rawArguments,
          status: 'succeeded' as const,
        },
      },
    },
    capabilities: {
      ...base.capabilities,
      catalogRevision: catalog.revision,
      invocations: {
        invocation: {
          invocationId: 'invocation',
          toolCallId: call.toolCallId,
          capabilityId: original.capabilityId,
          capabilityRevision: original.capabilityRevision,
          argumentsDigest: original.argumentsDigest,
          authorizationDigest: 'auth',
          admissionDigest: 'admission',
          effectiveEffectsDigest: original.effectiveEffectsDigest,
          status: 'succeeded' as const,
          attemptsStarted: 1,
          recordedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  };
  return {
    state,
    settledCall: call,
    admitted,
    config,
    pipeline,
    mcpSnapshot: null,
    skillCatalog: null,
    agentMailboxPortAvailable: true,
    agentMailboxQueueOnlyAvailable: false,
    interactionModeOverride: null,
  };
}

describe('current source followup policy proof', () => {
  test('same frozen Builtin catalog and current policy classify the original settled call', () => {
    const input = fixture();
    expect(classifyCurrentFollowupCeiling(input).ok).toBe(true);
    expect(currentSourceFollowupPolicy(input).ok).toBe(true);
  });

  test('fails closed when current policy or availability tightens to deny the operation', () => {
    const input = fixture();
    expect(currentSourceFollowupPolicy({ ...input, agentMailboxPortAvailable: false })).toEqual({
      ok: false,
      code: 'current_tool_unavailable',
    });
  });

  test('matches the ordinary Router QueueOnly context and fails closed for followup_task', () => {
    const input = fixture();
    expect(currentSourceFollowupPolicy({ ...input, agentMailboxQueueOnlyAvailable: true })).toEqual(
      { ok: false, code: 'current_tool_unavailable' },
    );
    expect(currentSourceFollowupPolicy({ ...input, mcpSnapshot: undefined as never })).toEqual({
      ok: false,
      code: 'current_catalog_unavailable',
    });
  });

  test('rejects current catalog, mode and historical Tool drift', () => {
    const input = fixture();
    expect(
      currentSourceFollowupPolicy({
        ...input,
        state: {
          ...input.state,
          capabilities: { ...input.state.capabilities, catalogRevision: 'other' },
        },
      }),
    ).toEqual({ ok: false, code: 'current_catalog_mismatch' });
    expect(
      currentSourceFollowupPolicy({
        ...input,
        state: { ...input.state, interactionModeRevision: 1 },
      }),
    ).toEqual({ ok: false, code: 'current_mode_or_phase_mismatch' });
    expect(
      currentSourceFollowupPolicy({
        ...input,
        settledCall: {
          ...input.settledCall,
          rawArguments: { agent_id: 'child', message: 'changed' },
        },
      }),
    ).toEqual({ ok: false, code: 'original_identity_mismatch' });
  });

  test('rejects broader original ceiling, schema drift and original identity mismatch', () => {
    const input = fixture();
    const original = input.admitted.preparedTool!;
    const narrowerEffects = { ...original.effectiveEffects, network: 'none' as const };
    const narrowerDigest = digestCapabilityValue(narrowerEffects);
    expect(
      currentSourceFollowupPolicy({
        ...input,
        state: {
          ...input.state,
          capabilities: {
            ...input.state.capabilities,
            invocations: {
              invocation: {
                ...input.state.capabilities.invocations.invocation!,
                effectiveEffectsDigest: narrowerDigest,
              },
            },
          },
        },
        admitted: {
          ...input.admitted,
          effectiveEffectsDigest: narrowerDigest,
          preparedTool: {
            ...original,
            effectiveEffects: narrowerEffects,
            effectiveEffectsDigest: narrowerDigest,
          },
        },
      }),
    ).toEqual({ ok: false, code: 'current_policy_exceeds_admission' });
    expect(
      currentSourceFollowupPolicy({
        ...input,
        admitted: { ...input.admitted, preparedTool: { ...original, schemaDigest: 'old-schema' } },
      }),
    ).toEqual({ ok: false, code: 'current_schema_mismatch' });
    expect(
      currentSourceFollowupPolicy({
        ...input,
        admitted: { ...input.admitted, preparedTool: { ...original, modelMessageId: 'other' } },
      }),
    ).toEqual({ ok: false, code: 'original_identity_mismatch' });
  });
});
