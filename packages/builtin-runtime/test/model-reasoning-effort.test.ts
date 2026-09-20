import { describe, expect, test } from 'bun:test';
import {
  compileModelSurface,
  createChatModel,
  humanMessage,
  invokeModelTransportSingleAttempt,
  type ModelRuntimeConfig,
  primaryModelProviderOptions,
} from '@kite-ai/builtin-runtime/model';

function config(overrides: Partial<ModelRuntimeConfig> = {}): ModelRuntimeConfig {
  return {
    apiKey: 'reasoning-effort-fixture-key',
    baseURL: 'https://reasoning-effort-fixture.invalid/v1',
    modelName: 'gpt-6-astra',
    providerName: 'openai',
    providerType: 'openai-compatible',
    reasoningEffort: 'xhigh',
    sandbox: { enabled: false },
    ...overrides,
  };
}

describe('primary model reasoning effort', () => {
  test('binds the provider-owned option into the frozen Surface and its digest', () => {
    const enabledConfig = config();
    const model = createChatModel(enabledConfig);
    const enabled = compileModelSurface({
      purpose: 'primary_agent',
      config: enabledConfig,
      model,
      messages: [humanMessage('Answer carefully.')],
      tools: {},
      providerOptions: primaryModelProviderOptions(enabledConfig),
    });
    const changedConfig = config({ reasoningEffort: 'low' });
    const changed = compileModelSurface({
      purpose: 'primary_agent',
      config: changedConfig,
      model: createChatModel(changedConfig),
      messages: [humanMessage('Answer carefully.')],
      tools: {},
      providerOptions: primaryModelProviderOptions(changedConfig),
    });

    expect(Object.isFrozen(enabled.surface)).toBe(true);
    expect(enabled.surface.request.providerOptions).toMatchObject({
      kind: 'inline',
      value: { openaiCompatible: { reasoningEffort: 'xhigh' } },
    });
    expect(enabled.surfaceDigest).not.toBe(changed.surfaceDigest);
  });

  test('does not compile reasoning effort when the provider explicitly disables reasoning', () => {
    expect(
      primaryModelProviderOptions(config({ reasoning: false, reasoningExplicitlyDisabled: true })),
    ).toBeUndefined();
  });

  test('uses the exact provider owner and leaves unsupported providers unchanged', () => {
    expect(primaryModelProviderOptions(config({ providerType: 'openai' }))).toEqual({
      openai: { reasoningEffort: 'xhigh' },
    });
    expect(primaryModelProviderOptions(config({ providerType: 'deepseek' }))).toBeUndefined();
    expect(primaryModelProviderOptions(config({ providerType: 'ollama' }))).toBeUndefined();
  });

  test('sends reasoning_effort in the OpenAI-compatible request body', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const runtimeConfig = config();
    const fetchSpy = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-reasoning-effort',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-6-astra',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'done' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const model = createChatModel(runtimeConfig, {
      fetch: fetchSpy,
    });
    const compiled = compileModelSurface({
      purpose: 'primary_agent',
      config: runtimeConfig,
      model,
      messages: [humanMessage('Answer carefully.')],
      tools: {},
      transport: 'generate',
      providerOptions: primaryModelProviderOptions(runtimeConfig),
    });

    await invokeModelTransportSingleAttempt({ model, surface: compiled.surface });

    expect(requestBody?.reasoning_effort).toBe('xhigh');
    expect(requestBody).not.toHaveProperty('reasoningEffort');
  });
});
