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
  test('resolves each explicit field with its source', () => {
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
      contextWindowSource: 'explicit_config',
      maxOutputTokens: 2_000,
      maxOutputTokensSource: 'explicit_config',
      supportsPromptCache: false,
      supportsPromptCacheSource: 'explicit_config',
    });
  });

  test('uses adapter runtime metadata without consulting the model name', () => {
    const result = resolveModelCapabilities({
      config: config({ providerName: 'openai', modelName: 'gpt-4o' }),
      adapter: { contextWindowTokens: 32_000 },
    });
    expect(result.contextWindowTokens).toBe(32_000);
    expect(result.contextWindowSource).toBe('adapter_runtime');
  });

  test('keeps known and custom model capabilities tri-state unknown without trusted metadata', () => {
    const result = resolveModelCapabilities({
      config: config({ providerName: 'openai', modelName: 'gpt-4o' }),
    });
    expect(result.contextWindowTokens).toBeUndefined();
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.supportsUsageMetadata).toBeUndefined();
    expect(result.supportsPromptCache).toBeUndefined();
    expect(usableInputBudget(result).usableInputTokens).toBeUndefined();
    expect(usableInputBudget(result).reservedOutputTokens).toBeUndefined();
  });

  test('compatibility fields retain compatibility_config source', () => {
    const result = resolveModelCapabilities({
      config: config({
        modelKwargs: {
          contextWindowTokens: 12_000,
          maxTokens: 1_000,
          tokenizerFamily: 'compatible-tokenizer',
          supportsUsageMetadata: false,
        },
      }),
    });
    expect(result).toMatchObject({
      contextWindowTokens: 12_000,
      contextWindowSource: 'compatibility_config',
      maxOutputTokens: 1_000,
      maxOutputTokensSource: 'compatibility_config',
      tokenizerSource: 'compatibility_config',
      supportsUsageMetadata: false,
      supportsUsageMetadataSource: 'compatibility_config',
    });
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
