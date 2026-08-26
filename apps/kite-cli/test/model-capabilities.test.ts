import { describe, expect, test } from 'bun:test';
import { resolveModelCapabilities, usableInputBudget } from '@kite-ai/builtin-runtime/model';
import type { AgentConfig } from '#kite-cli/config';

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
          streaming: true,
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
      streaming: true,
      streamingSource: 'explicit_config',
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

  test('resolves streaming by explicit, adapter, then compatibility precedence', () => {
    expect(
      resolveModelCapabilities({
        config: config({
          modelCapabilities: { streaming: false },
          modelKwargs: { streaming: true },
        }),
        adapter: { streaming: true },
      }),
    ).toMatchObject({ streaming: false, streamingSource: 'explicit_config' });
    expect(
      resolveModelCapabilities({
        config: config({ modelKwargs: { streaming: false } }),
        adapter: { streaming: true },
      }),
    ).toMatchObject({ streaming: true, streamingSource: 'adapter_runtime' });
  });

  test('keeps known and custom model capabilities tri-state unknown without trusted metadata', () => {
    const result = resolveModelCapabilities({
      config: config({ providerName: 'openai', modelName: 'gpt-4o' }),
    });
    expect(result.contextWindowTokens).toBeUndefined();
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.supportsUsageMetadata).toBeUndefined();
    expect(result.supportsPromptCache).toBeUndefined();
    expect(result.streaming).toBe(true);
    expect(result.streamingSource).toBeUndefined();
    expect(usableInputBudget(result).usableInputTokens).toBeUndefined();
    expect(usableInputBudget(result).reservedOutputTokens).toBeUndefined();
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
