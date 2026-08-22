import { describe, expect, test } from 'bun:test';
import { getRoleConfig } from '@kite/builtin-runtime';
import {
  BuiltinModelEffectCoordinatorV1,
  createModelContextSummaryGenerator,
} from '@kite/builtin-runtime/model';
import { createRuntimeHostState25InitialStateV1 } from '@kite/runtime-host';
import { executeContextCompaction } from '#app/bootstrap/runtime/context-compaction-effect';
import { executeSubagentStartWithCoreToolAdapterV1 } from '#app/bootstrap/runtime/subagent/tool-adapter';
import type { AgentConfig } from '#app/config';
import {
  APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1,
  APPROVED_PROVIDER_DATA_POLICY_REVISION_V1,
  computeProviderEndpointIdentityDigest,
  createApprovedProviderDataAdmissionV1,
  createProviderDataPolicyRegistryV1,
  evaluateProviderDataAdmissionV1,
} from '#app/config';
import { ProviderDataAdmissionError } from '#app/config/provider-data-admission';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';
import { openState25Store4ForTestV1 } from '../scripts/support/runtime-storage';
import { createTestModelInvocationHarnessV1 } from './helpers/model-invocation';
import {
  projectTestPrimaryModelEffectV1,
  runTestRuntimeAgentV1,
  testBuiltinToolCatalogV1,
} from './helpers/runtime-model';
import { createMockModel } from './mock-model';

const route = {
  providerType: 'openai-compatible',
  operatorId: 'operator.example',
  endpointOrigin: 'https://api.example.test/v1',
  endpointClass: 'managed',
  deploymentId: 'primary',
  region: 'us-east',
};

function registry() {
  return createProviderDataPolicyRegistryV1({
    version: 1,
    decisionId: 'D-14',
    revision: 'registry-1',
    policies: [
      {
        version: 1,
        policyId: 'policy-1',
        revision: '2026-07-30.1',
        decisionId: 'D-14',
        approvedRevision: 'review-1',
        effectiveFrom: '2026-07-30T00:00:00Z',
        expiresAt: '2027-07-30T00:00:00Z',
        routeId: 'primary',
        ...route,
        endpointIdentityDigest: computeProviderEndpointIdentityDigest(route),
        credentialOwner: 'user_os_identity',
        maxWorkspaceDataClassification: 'confidential',
        allowedPayloadKinds: {
          userPrompt: true,
          fileSnippet: true,
          toolResult: true,
          summary: true,
        },
        contentRetention: 'contract-30-days',
        trainingUse: 'prohibited',
        abuseMonitoring: 'metadata_only',
        deletionBoundary: 'provider-contract',
        subprocessors: [],
        dpaOrAdminApproval: 'required_and_verified',
        userDisclosureId: 'provider-disclosure-v1',
        requestLogging: 'metadata',
        errorLogging: 'metadata',
        productDeletionScope: 'local-records-only',
        allowRemoteMcpContentEgress: false,
        allowProductionContentEvaluation: false,
      },
    ],
  });
}

const config: AgentConfig = {
  apiKey: 'unused',
  baseURL: route.endpointOrigin,
  modelName: 'same-model-name',
  providerName: 'example',
  providerType: 'openai-compatible',
  features: { providerDataPolicyV1: true },
  sandbox: { enabled: false },
};

describe('model Provider data admission', () => {
  const deny = () =>
    ({
      admitted: false,
      reason: 'mandatory_policy_unavailable',
      routeAlias: 'test:denied',
    }) as const;

  test('real CLI/TUI runtime composition loads the release-pinned gate', async () => {
    const model = createMockModel([]);
    const events = [];
    const governedConfig: AgentConfig = {
      ...config,
      features: {
        providerDataPolicyV1: true,
        resourceBudgetV1: true,
        boundedCancellationV1: true,
      },
    };
    for await (const event of runTestRuntimeAgentV1(
      {
        task: 'hello',
        userId: 'u',
        threadId: `provider-composition-${crypto.randomUUID()}`,
        workspace: '/workspace',
        openState25SessionStorage: () => openState25Store4ForTestV1(':memory:'),
        config: governedConfig,
        model,
        sandboxBackend: 'unknown',
      },
      {
        requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
      },
    )) {
      events.push(event);
    }

    expect(model.callCount.count).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'provider.data_policy_status',
        status: 'blocked',
        reason: 'provider_policy_missing',
        registryDigest: APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1,
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'resource_budget.unknown' ||
          event.type === 'resource_budget.dispatch_started',
      ),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        failure: expect.objectContaining({ kind: 'mandatory_policy_unavailable' }),
      }),
    );
    expect(APPROVED_PROVIDER_DATA_POLICY_REVISION_V1).toBe(
      'd14-deepseek-owner-accepted-2026-08-02.3',
    );
    expect(APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createApprovedProviderDataAdmissionV1(config)([], 'primary_model')).toMatchObject({
      admitted: false,
      reason: 'provider_policy_missing',
      registryDigest: APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1,
    });
  });

  test('blocks secret markers before the mocked Provider receives a request', async () => {
    const model = createMockModel([]);
    let state = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider-secret',
      userId: 'u',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'secret-message',
      content: 'api_key=super-secret-provider-value',
    });

    await expect(
      projectTestPrimaryModelEffectV1({
        model,
        state,
        config,
        providerDataAdmission: (payload) =>
          evaluateProviderDataAdmissionV1({
            featureEnabled: true,
            profile: 'limited',
            registry: registry(),
            route,
            now: new Date('2026-08-01T00:00:00Z'),
            payload,
          }),
      }),
    ).rejects.toThrow('provider_secret_denied');
    expect(model.callCount.count).toBe(0);
  });

  test('reuses the Runtime secret inspector so opaque known secrets never reach DeepSeek', async () => {
    const model = createMockModel([]);
    const opaqueSecret = 'opaque-credential-without-a-known-shape';
    const deepseekConfig: AgentConfig = {
      apiKey: 'configured-provider-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-v4-flash',
      providerName: 'deepseek',
      providerType: 'deepseek',
      features: { providerDataPolicyV1: true },
      sandbox: { enabled: false },
    };
    const events = [];

    for await (const event of runTestRuntimeAgentV1(
      {
        task: `analyze ${opaqueSecret}`,
        userId: 'u',
        threadId: `provider-known-secret-${crypto.randomUUID()}`,
        workspace: '/workspace',
        openState25SessionStorage: () => openState25Store4ForTestV1(':memory:'),
        config: deepseekConfig,
        model,
        sandboxBackend: 'unknown',
        sessionLoggingContentInspector: ({ text }) => ({
          schemaVersion: 1,
          detector: 'runtime_secret_detector',
          verdict: text.includes(opaqueSecret) ? 'secret' : 'clear',
        }),
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(model.callCount.count).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        message: expect.stringContaining('provider_secret_denied'),
        failure: expect.objectContaining({ kind: 'policy_denied' }),
      }),
    );
  });

  test('fails closed before dispatch when the enabled gate is unavailable', async () => {
    const model = createMockModel([]);
    const state = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider-missing',
      userId: 'u',
      workspace: '/workspace',
    });
    await expect(projectTestPrimaryModelEffectV1({ model, state, config })).rejects.toThrow(
      'mandatory_policy_unavailable',
    );
    expect(model.callCount.count).toBe(0);
  });

  test('compaction, Sub-agent, and verification reviewer cannot bypass final dispatch admission', async () => {
    const compactionModel = createMockModel([]);
    const compactionState = reduceRuntimeState(
      createRuntimeHostState25InitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'provider-compaction',
        userId: 'u',
        workspace: '/workspace',
      }),
      {
        type: 'context.compaction_requested',
        compactionId: 'provider-compaction',
        reason: 'auto',
        requestedAtRevision: 0,
        requestedAtTurnId: 'turn-0',
        force: false,
        estimate: {
          systemTokens: 10,
          toolSchemaTokens: 10,
          transcriptTokens: 1_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 10,
          framingTokens: 10,
          totalInputTokens: 1_040,
        },
      },
    );
    const evidence = createTestModelInvocationHarnessV1({
      workspace: '/workspace',
      state: compactionState,
    });
    const generateSummary = createModelContextSummaryGenerator({
      config,
      model: compactionModel,
      gateway: evidence.gateway,
      persistence: evidence.persistence,
      state: compactionState,
      projectionEnvironmentDigest: 'provider-policy-fixture',
      providerDataAdmission: deny,
      providerDataPolicyRequired: true,
    });
    await expect(
      generateSummary({
        systemPrompt: 'summarize',
        input: 'workspace content',
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow('mandatory_policy_unavailable');
    expect(compactionModel.callCount.count).toBe(0);

    await expect(
      executeContextCompaction({
        state: compactionState,
        compactionId: 'provider-compaction',
        compact: async () => {
          throw new ProviderDataAdmissionError(deny());
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'context.compaction_failed',
        errorKind: 'provider_admission_denied',
        retryable: false,
      }),
    ]);

    const subagentModel = createMockModel([]);
    const descendantTransitions: string[] = [];
    const subagent = await executeSubagentStartWithCoreToolAdapterV1({
      builtinToolCatalog: testBuiltinToolCatalogV1(),
      config,
      workspace: '/workspace',
      recoveryIdentityKey: '7'.repeat(64),
      role: getRoleConfig('explore'),
      task: 'inspect workspace content',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      eventSink: () => {},
      model: subagentModel,
      modelEffectCoordinator: new BuiltinModelEffectCoordinatorV1(evidence.gateway),
      modelInvocationPersistence: evidence.persistence,
      providerDataAdmission: deny,
      descendantResourceAdmission: {
        reserveModel: async () => {
          descendantTransitions.push('reserved');
          return { reservationId: 'subagent-model-reservation', maxOutputTokens: 64 };
        },
        reconcileModel: async () => {
          descendantTransitions.push('reconciled');
        },
        reserveTool: async () => ({ reservationId: 'unused-tool-reservation' }),
        reconcileTool: async () => {},
        markUnknown: async (reservationId) => {
          descendantTransitions.push(`unknown:${reservationId}`);
        },
        markLocalProviderAdmissionDenied: async (reservationId) => {
          descendantTransitions.push(`released:${reservationId}`);
        },
      },
    });
    expect(subagent.ok).toBe(false);
    expect(subagentModel.callCount.count).toBe(0);
    expect(descendantTransitions).toEqual([]);

    const reviewerModel = createMockModel([]);
    await expect(
      new BuiltinModelEffectCoordinatorV1(evidence.gateway).reviewVerificationEvidence({
        config,
        model: reviewerModel,
        persistence: evidence.persistence,
        evidence: { instructions: 'review', receipts: [], artifacts: [], skillOutputs: [] },
        providerDataAdmission: deny,
        providerDataPolicyRequired: true,
      }),
    ).rejects.toThrow('mandatory_policy_unavailable');
    expect(reviewerModel.callCount.count).toBe(0);
  });
});
