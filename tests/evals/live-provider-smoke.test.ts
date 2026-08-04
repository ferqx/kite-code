import { afterEach, describe, expect, test } from 'bun:test';
import { resolveQwenConfig, runLiveProviderSmoke } from '../../scripts/evals/live-provider-smoke';
import { createMockModelServer } from '../tui-system/harness/fixtures';

const servers: Array<ReturnType<typeof createMockModelServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe('low-cost live Provider smoke contract', () => {
  for (const provider of ['deepseek', 'qwen-openai-compatible'] as const) {
    test(`reports metadata only for ${provider}`, async () => {
      const server = createMockModelServer();
      const modelName = provider === 'deepseek' ? 'deepseek-v4-flash' : 'mock-model';
      servers.push(server);
      server.setResponses([
        {
          message: { content: 'secret-response-body-must-not-be-reported' },
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ]);
      const report = await runLiveProviderSmoke({
        provider,
        credentialSource: 'environment',
        config: {
          providerName: provider,
          providerType: provider === 'deepseek' ? 'deepseek' : 'openai-compatible',
          apiKey: 'secret-test-key',
          baseURL: server.baseURL,
          modelName,
          sandbox: { enabled: true },
        },
      });
      expect(report).toMatchObject({
        status: 'passed',
        provider,
        model: modelName,
        responseNonEmpty: true,
        contentLogged: false,
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('secret-test-key');
      expect(serialized).not.toContain('secret-response-body');
      expect(serialized).not.toContain(server.baseURL);
      expect(server.getRequests()[0]?.body).toMatchObject({
        ...(provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        max_tokens: 16,
      });
      if (provider === 'qwen-openai-compatible') {
        expect(server.getRequests()[0]?.body.thinking).toBeUndefined();
      }
    });
  }

  test('accepts the Aliyun Token Plan route and refuses arbitrary compatible routes', () => {
    const original = {
      key: process.env.DASHSCOPE_API_KEY,
      endpoint: process.env.KITE_QWEN_BASE_URL,
      model: process.env.KITE_QWEN_MODEL,
    };
    try {
      process.env.DASHSCOPE_API_KEY = 'secret-test-key';
      delete process.env.KITE_QWEN_BASE_URL;
      delete process.env.KITE_QWEN_MODEL;
      expect(resolveQwenConfig()).toMatchObject({
        credentialSource: 'environment',
        config: {
          baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          modelName: 'qwen3.6-flash',
        },
      });

      process.env.KITE_QWEN_BASE_URL = 'https://example.com/compatible-mode/v1';
      process.env.KITE_QWEN_MODEL = 'qwen3.6-flash';
      expect(() => resolveQwenConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_QWEN_BASE_URL =
        'https://token-plan.cn-beijing.maas.aliyuncs.com.example.com/compatible-mode/v1';
      expect(() => resolveQwenConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      process.env.KITE_QWEN_MODEL = 'qwen3.6-flash';
      expect(() => resolveQwenConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_QWEN_BASE_URL =
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
      process.env.KITE_QWEN_MODEL = 'not-a-qwen-model';
      expect(() => resolveQwenConfig()).toThrow('qwen_model_mismatch');
    } finally {
      restoreEnvironment('DASHSCOPE_API_KEY', original.key);
      restoreEnvironment('KITE_QWEN_BASE_URL', original.endpoint);
      restoreEnvironment('KITE_QWEN_MODEL', original.model);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
