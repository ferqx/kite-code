import { afterEach, describe, expect, test } from 'bun:test';
import {
  resolveOpenCodeGoConfig,
  runLiveProviderSmoke,
} from '../../scripts/evals/live-provider-smoke';
import { createTestModelInvocationHarnessV1 } from '../helpers/model-invocation';
import { createMockModelServer } from '../tui-system/harness/fixtures';

const servers: Array<ReturnType<typeof createMockModelServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe('low-cost live Provider smoke contract', () => {
  for (const provider of ['deepseek', 'opencode-go'] as const) {
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
        modelInvocationGateway: createTestModelInvocationHarnessV1({
          workspace: process.cwd(),
        }).gateway,
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
        max_tokens: provider === 'opencode-go' ? 128 : 16,
      });
      if (provider === 'opencode-go') {
        expect(server.getRequests()[0]?.body.thinking).toBeUndefined();
      }
    });
  }

  test('accepts the exact OpenCode Go route and refuses arbitrary compatible routes', () => {
    const original = {
      key: process.env.OPENCODE_API_KEY,
      endpoint: process.env.KITE_OPENCODE_GO_BASE_URL,
      model: process.env.KITE_OPENCODE_GO_MODEL,
    };
    try {
      process.env.OPENCODE_API_KEY = 'secret-test-key';
      delete process.env.KITE_OPENCODE_GO_BASE_URL;
      delete process.env.KITE_OPENCODE_GO_MODEL;
      expect(resolveOpenCodeGoConfig()).toMatchObject({
        credentialSource: 'environment',
        config: {
          baseURL: 'https://opencode.ai/zen/go/v1',
          modelName: 'deepseek-v4-flash',
        },
      });

      process.env.KITE_OPENCODE_GO_BASE_URL = 'https://example.com/zen/go/v1';
      process.env.KITE_OPENCODE_GO_MODEL = 'deepseek-v4-flash';
      expect(() => resolveOpenCodeGoConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_OPENCODE_GO_BASE_URL = 'https://opencode.ai.example.com/zen/go/v1';
      expect(() => resolveOpenCodeGoConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/v1';
      process.env.KITE_OPENCODE_GO_MODEL = 'deepseek-v4-flash';
      expect(() => resolveOpenCodeGoConfig()).toThrow('provider_endpoint_unsafe');

      process.env.KITE_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
      process.env.KITE_OPENCODE_GO_MODEL = 'qwen3-coder';
      expect(() => resolveOpenCodeGoConfig()).toThrow('opencode_go_model_mismatch');
    } finally {
      restoreEnvironment('OPENCODE_API_KEY', original.key);
      restoreEnvironment('KITE_OPENCODE_GO_BASE_URL', original.endpoint);
      restoreEnvironment('KITE_OPENCODE_GO_MODEL', original.model);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
