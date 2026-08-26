import { describe, expect, test } from 'bun:test';
import {
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  type NativeProviderCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import { createProviderCredentialOwner } from '../../src/app-control/owners/provider-credential-owner';

function request(
  values: Partial<NativeProviderCredentialRequest> = {},
): NativeProviderCredentialRequest {
  return {
    schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
    mutationId: 'first-run-test',
    operation: 'write_provider_api_key',
    providerId: 'openai',
    apiKey: 'sk-test-secret',
    ...values,
  };
}

describe('provider credential owner', () => {
  test('discovers models and saves only an owner-side config projection', async () => {
    let requestedURL = '';
    let authorization = '';
    let saved: Record<string, unknown> | undefined;
    const owner = createProviderCredentialOwner({
      fetch: async (input, init) => {
        requestedURL = String(input);
        authorization = String(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'gpt-next' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      saveProviderConfig: (input) => {
        saved = input as unknown as Record<string, unknown>;
        return true;
      },
    });

    const response = await owner.writeProviderCredential(request());

    expect(response).toMatchObject({
      outcome: 'applied',
      credentialPresent: true,
      operation: 'write_provider_api_key',
    });
    expect(requestedURL).toBe('https://api.openai.com/v1/models');
    expect(authorization).toBe('Bearer sk-test-secret');
    expect(saved).toMatchObject({
      name: 'openai',
      type: 'openai',
      apiKey: 'sk-test-secret',
      models: [
        { name: 'gpt-test', default: true },
        { name: 'gpt-next', default: false },
      ],
    });
    expect(JSON.stringify(response)).not.toContain('sk-test-secret');
  });

  test('supports an empty custom key and manual model without network discovery', async () => {
    let fetchCalls = 0;
    let saved: Record<string, unknown> | undefined;
    const owner = createProviderCredentialOwner({
      fetch: async () => {
        fetchCalls += 1;
        return new Response('{}');
      },
      saveProviderConfig: (input) => {
        saved = input as unknown as Record<string, unknown>;
        return true;
      },
    });

    const response = await owner.writeProviderCredential(
      request({
        mutationId: 'manual-model',
        providerId: 'openai-compatible',
        apiKey: '',
        baseURL: 'http://localhost:9000/v1',
        modelName: 'local-model',
      }),
    );

    expect(response.outcome).toBe('applied');
    expect(fetchCalls).toBe(0);
    expect(saved).toMatchObject({
      name: 'openai-compatible',
      type: 'openai-compatible',
      baseURL: 'http://localhost:9000/v1',
      models: [{ name: 'local-model', default: true }],
    });
    expect(saved).not.toHaveProperty('apiKey');
  });

  test('returns stable auth/model-required codes without exposing response bodies', async () => {
    let saves = 0;
    const unauthorized = createProviderCredentialOwner({
      fetch: async () =>
        new Response(JSON.stringify({ error: 'secret response detail' }), { status: 401 }),
      saveProviderConfig: () => {
        saves += 1;
        return true;
      },
    });
    const rejected = await unauthorized.writeProviderCredential(request());
    expect(rejected).toMatchObject({ outcome: 'rejected', errorCode: 'credential_unavailable' });
    expect(JSON.stringify(rejected)).not.toContain('secret response detail');
    expect(saves).toBe(0);

    const noModels = createProviderCredentialOwner({
      fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      saveProviderConfig: () => {
        saves += 1;
        return true;
      },
    });
    const modelRequired = await noModels.writeProviderCredential(
      request({ mutationId: 'no-models' }),
    );
    expect(modelRequired).toMatchObject({ outcome: 'rejected', errorCode: 'model_required' });
    expect(saves).toBe(0);
  });

  test('does not turn an uncertain write into an automatic retry', async () => {
    let saveCalls = 0;
    const owner = createProviderCredentialOwner({
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 }),
      saveProviderConfig: () => {
        saveCalls += 1;
        throw new Error('write result lost');
      },
    });

    const response = await owner.writeProviderCredential(request({ mutationId: 'unknown' }));
    expect(response).toMatchObject({ outcome: 'outcome_unknown' });
    expect(saveCalls).toBe(1);
  });

  test('forwards discovery cancellation and never persists after abort', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let saves = 0;
    const owner = createProviderCredentialOwner({
      fetch: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        controller.abort('first-run-exit');
        return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 });
      },
      saveProviderConfig: () => {
        saves += 1;
        return true;
      },
    });

    const response = await owner.writeProviderCredential(request(), {
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(response).toMatchObject({ outcome: 'rejected', errorCode: 'temporarily_unavailable' });
    expect(saves).toBe(0);
  });
});
