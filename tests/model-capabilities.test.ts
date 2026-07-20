import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../src/core/config';
import { resolveModelCapabilities, usableInputBudget } from '../src/core/model/model-capabilities';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: '',
    baseURL: 'http://localhost',
    modelName: 'custom-model',
    providerName: 'custom',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    ...overrides,
  };
}

describe('ResolvedModelCapabilities', () => {
  test('uses explicit model entry fields before catalog, adapter and compatibility values', () => {
    const result = resolveModelCapabilities({
      config: config({
        providerName: 'openai',
        modelName: 'gpt-4o',
        modelCapabilities: {
          contextWindowTokens: 64_000,
          maxOutputTokens: 2_000,
          supportsPromptCache: false,
        },
        modelKwargs: { contextWindowTokens: 32_000, maxOutputTokens: 1_000 },
      }),
      adapter: { contextWindowTokens: 48_000, maxOutputTokens: 1_500 },
    });
    expect(result).toMatchObject({
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_000,
      supportsPromptCache: false,
    });
  });

  test('uses the builtin catalog before adapter metadata', () => {
    const result = resolveModelCapabilities({
      config: config({ providerName: 'openai', modelName: 'gpt-4o' }),
      adapter: { contextWindowTokens: 32_000 },
    });
    expect(result.contextWindowTokens).toBe(128_000);
  });

  test('keeps unknown custom model windows unknown instead of assuming 128K', () => {
    const result = resolveModelCapabilities({ config: config() });
    expect(result.contextWindowTokens).toBeUndefined();
    expect(result.maxOutputTokens).toBeUndefined();
    expect(usableInputBudget(result).usableInputTokens).toBeUndefined();
  });

  test('computes usable input from output reservation and provider safety margin', () => {
    const result = usableInputBudget(
      resolveModelCapabilities({
        config: config({
          modelCapabilities: {
            contextWindowTokens: 100_000,
            maxOutputTokens: 10_000,
          },
        }),
      }),
    );
    expect(result).toEqual({
      usableInputTokens: 88_000,
      reservedOutputTokens: 10_000,
      providerSafetyMarginTokens: 2_000,
    });
  });
});
