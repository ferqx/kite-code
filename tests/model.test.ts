import { describe, expect, test } from 'bun:test';
import { APICallError } from '@ai-sdk/provider';
import { generateText } from 'ai';
import type { AgentConfig } from '../src/core/config/index';
import { withTransientModelRetry } from '../src/core/model/deepseek';
import { createChatModel } from '../src/core/model/factory';

describe('model transient retry', () => {
  test('retries transient socket errors before succeeding', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error('FailedToOpenSocket'), {
            code: 'FailedToOpenSocket',
          });
        }
        return 'ok';
      },
      {
        initialDelayMs: 10,
        jitterMs: 0,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test('retries OpenAI connection errors with nested socket causes', async () => {
    let attempts = 0;

    const result = await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error('Connection error.'), {
            cause: {
              code: 'FailedToOpenSocket',
              message: 'Was there a typo in the url or port?',
            },
          });
        }
        return 'ok';
      },
      {
        initialDelayMs: 1,
        jitterMs: 0,
        sleep: async () => {},
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('retries 5xx server errors', async () => {
    let attempts = 0;

    const result = await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        }
        return 'ok';
      },
      {
        initialDelayMs: 1,
        jitterMs: 0,
        sleep: async () => {},
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('retries AI SDK HTTP 429 errors only within the bounded attempt budget', async () => {
    let attempts = 0;
    const errors = Array.from(
      { length: 3 },
      (_, index) =>
        new APICallError({
          message: `Rate limited ${index + 1}`,
          url: 'http://127.0.0.1/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 429,
          responseBody: '{"error":"rate limited"}',
        }),
    );

    await expect(
      withTransientModelRetry(
        async () => {
          throw errors[attempts++];
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1,
          jitterMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toBe(errors[2]);
    expect(attempts).toBe(3);
  });

  test('retries a real openai-compatible HTTP 429 through provider middleware', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        if (requests === 1) {
          return Response.json(
            { error: { message: 'rate limited', type: 'rate_limit' } },
            { status: 429 },
          );
        }
        return Response.json({
          id: 'chatcmpl-fault-soak',
          object: 'chat.completion',
          created: 1,
          model: 'fault-soak-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'recovered' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const binding = createChatModel({
        providerName: 'fault-soak',
        providerType: 'openai-compatible',
        apiKey: 'sk-local-test',
        baseURL: new URL('/v1', server.url).toString(),
        modelName: 'fault-soak-model',
        sandbox: { enabled: true },
      });
      const retries: number[] = [];
      binding.setRetryListener((attempt) => retries.push(attempt));

      const result = await generateText({
        model: binding.model,
        prompt: 'hello',
        maxRetries: 0,
      });

      expect(result.text).toBe('recovered');
      expect(requests).toBe(2);
      expect(retries).toEqual([1]);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test('does not retry non-transient API errors', async () => {
    let attempts = 0;
    const error = new APICallError({
      message: 'Unauthorized',
      url: 'http://127.0.0.1/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 401,
    });

    await expect(
      withTransientModelRetry(
        async () => {
          attempts++;
          throw error;
        },
        {
          sleep: async () => {
            throw new Error('sleep should not be called');
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test('rethrows the last transient error after max attempts', async () => {
    let attempts = 0;
    const errors = [
      Object.assign(new Error('first reset'), { code: 'ECONNRESET' }),
      Object.assign(new Error('second reset'), { code: 'ECONNRESET' }),
      Object.assign(new Error('final reset'), { code: 'ECONNRESET' }),
    ];

    await expect(
      withTransientModelRetry(
        async () => {
          throw errors[attempts++];
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1,
          jitterMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toBe(errors[2]);
    expect(attempts).toBe(3);
  });

  test('calls onRetry callback with attempt, maxAttempts, error, and delay on each retry', async () => {
    let attempts = 0;
    const retryCalls: Array<{
      attempt: number;
      maxAttempts: number;
      error: unknown;
      delayMs: number;
    }> = [];

    await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        }
        return 'ok';
      },
      {
        maxAttempts: 5,
        initialDelayMs: 10,
        jitterMs: 0,
        sleep: async () => {},
        onRetry: (attempt, maxAttempts, error, delayMs) => {
          retryCalls.push({ attempt, maxAttempts, error, delayMs });
        },
      },
    );

    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]).toEqual({
      attempt: 1,
      maxAttempts: 5,
      error: expect.any(Error),
      delayMs: 10,
    });
    expect(retryCalls[1]).toEqual({
      attempt: 2,
      maxAttempts: 5,
      error: expect.any(Error),
      delayMs: 20,
    });
    // onRetry is NOT called for the successful final attempt
    expect(attempts).toBe(3);
  });

  test('does not call onRetry when operation succeeds on first try', async () => {
    let onRetryCalled = false;

    await withTransientModelRetry(async () => 'ok', {
      onRetry: () => {
        onRetryCalled = true;
      },
    });

    expect(onRetryCalled).toBe(false);
  });
});

describe('model provider factory', () => {
  test('creates a SupportedChatModel with model and setRetryListener for deepseek providers', () => {
    const binding = createChatModel({
      providerName: 'deepseek',
      providerType: 'deepseek',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat',
      sandbox: { enabled: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanguageModel union type; V4 fields accessed via any
    const m = binding.model as any;
    expect(binding.model).toBeDefined();
    expect(m.specificationVersion).toBe('v4');
    expect(m.provider).toBeDefined();
    expect(m.modelId).toBe('deepseek-chat');
    expect(typeof binding.setRetryListener).toBe('function');
  });

  test('creates a SupportedChatModel for OpenAI-compatible providers', () => {
    const config: AgentConfig = {
      providerName: 'siliconflow',
      providerType: 'openai-compatible',
      apiKey: 'sk-compatible',
      baseURL: 'https://api.siliconflow.cn/v1',
      modelName: 'Qwen/Qwen3-Coder',
      sandbox: { enabled: true },
    };

    const binding = createChatModel(config);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanguageModel union type
    const m = binding.model as any;
    expect(binding.model).toBeDefined();
    expect(m.specificationVersion).toBe('v4');
    expect(m.provider).toBeDefined();
    expect(m.modelId).toBe('Qwen/Qwen3-Coder');
    expect(typeof binding.setRetryListener).toBe('function');
  });

  test('creates a SupportedChatModel for Ollama providers', () => {
    const config: AgentConfig = {
      providerName: 'ollama',
      providerType: 'ollama',
      apiKey: '',
      baseURL: 'http://localhost:11434',
      modelName: 'qwen2.5-coder:7b',
      sandbox: { enabled: true },
    };

    const binding = createChatModel(config);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanguageModel union type
    const m = binding.model as any;
    expect(binding.model).toBeDefined();
    expect(m.specificationVersion).toBe('v4');
    expect(m.provider).toBeDefined();
    expect(m.modelId).toBe('qwen2.5-coder:7b');
    expect(typeof binding.setRetryListener).toBe('function');
  });
});
