import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '#app/config';
import { createApprovedProviderDataAdmissionV1 } from '#app/config';
import { denyMissingProviderDataAdmissionV1 } from '#app/config/provider-data-admission';

const config: AgentConfig = {
  apiKey: 'configured-provider-secret',
  baseURL: 'https://api.example.test/v1',
  modelName: 'example-model',
  providerName: 'example',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};

const providerPrompt = (
  text: string,
  classification: 'confidential' | 'secret' = 'confidential',
) => [
  {
    kind: 'user_prompt' as const,
    text,
    label: {
      classification,
      source: 'artifact' as const,
      provenance: 'user_prompt' as const,
    },
  },
];

describe('model Provider data admission', () => {
  test('admits the provider selected by resolved user configuration', () => {
    expect(
      createApprovedProviderDataAdmissionV1(config)(providerPrompt('hello'), 'primary_model'),
    ).toEqual({
      admitted: true,
      reason: 'admitted',
      routeAlias: 'openai-compatible:example:example-model',
      admissionRevision: 'configured-provider',
    });
  });

  test('blocks explicit and detected credentials', () => {
    const admit = createApprovedProviderDataAdmissionV1(config);
    expect(admit(providerPrompt('hello', 'secret'))).toMatchObject({
      admitted: false,
      reason: 'provider_secret_denied',
    });
    expect(admit(providerPrompt('configured-provider-secret'))).toMatchObject({
      admitted: false,
      reason: 'provider_secret_denied',
    });
  });

  test('fails closed when production composition omits the admission boundary', () => {
    expect(denyMissingProviderDataAdmissionV1([])).toEqual({
      admitted: false,
      reason: 'mandatory_policy_unavailable',
      routeAlias: 'unresolved',
    });
  });
});
