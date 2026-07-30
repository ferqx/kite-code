import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import {
  computeProviderEndpointIdentityDigest,
  createProviderDataPolicyRegistryV1,
  evaluateProviderDataAdmissionV1,
} from '@/core/config';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
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
  test('blocks secret markers before the mocked Provider receives a request', async () => {
    const model = createMockModel([]);
    let state = createInitialRuntimeState({
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
      invokeRuntimeModel({
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

  test('fails closed before dispatch when the enabled gate is unavailable', async () => {
    const model = createMockModel([]);
    const state = createInitialRuntimeState({
      threadId: 'provider-missing',
      userId: 'u',
      workspace: '/workspace',
    });
    await expect(invokeRuntimeModel({ model, state, config })).rejects.toThrow(
      'mandatory_policy_unavailable',
    );
    expect(model.callCount.count).toBe(0);
  });
});
