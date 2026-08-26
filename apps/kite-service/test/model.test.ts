import { describe, expect, test } from 'bun:test';
import { createChatModel } from '@kite-ai/builtin-runtime/model';
import type { AgentConfig } from '#kite-service/config/index';

describe('model provider factory', () => {
  test('creates a governed transport binding for DeepSeek providers', () => {
    const binding = createChatModel({
      providerName: 'deepseek',
      providerType: 'deepseek',
      apiKey: 'synthetic-test-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat',
      sandbox: { enabled: true },
    });

    const model = binding.model as unknown as {
      specificationVersion: string;
      provider: string;
      modelId: string;
    };
    expect(binding.model).toBeDefined();
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBeDefined();
    expect(model.modelId).toBe('deepseek-chat');
  });

  test('disables DeepSeek V4 thinking only for bounded compaction summary calls', () => {
    const binding = createChatModel({
      providerName: 'deepseek',
      providerType: 'deepseek',
      apiKey: 'synthetic-test-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-v4-flash',
      sandbox: { enabled: true },
    });

    expect(binding.compactionProviderOptions).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
  });

  test('creates a governed transport binding for OpenAI-compatible providers', () => {
    const config: AgentConfig = {
      providerName: 'siliconflow',
      providerType: 'openai-compatible',
      apiKey: 'synthetic-compatible-key',
      baseURL: 'https://api.siliconflow.cn/v1',
      modelName: 'Qwen/Qwen3-Coder',
      sandbox: { enabled: true },
    };

    const binding = createChatModel(config);
    const model = binding.model as unknown as {
      specificationVersion: string;
      provider: string;
      modelId: string;
    };
    expect(binding.model).toBeDefined();
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBeDefined();
    expect(model.modelId).toBe('Qwen/Qwen3-Coder');
  });

  test('creates a governed transport binding for Ollama providers', () => {
    const config: AgentConfig = {
      providerName: 'ollama',
      providerType: 'ollama',
      apiKey: '',
      baseURL: 'http://localhost:11434',
      modelName: 'qwen2.5-coder:7b',
      sandbox: { enabled: true },
    };

    const binding = createChatModel(config);
    const model = binding.model as unknown as {
      specificationVersion: string;
      provider: string;
      modelId: string;
    };
    expect(binding.model).toBeDefined();
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBeDefined();
    expect(model.modelId).toBe('qwen2.5-coder:7b');
  });
});
