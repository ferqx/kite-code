import { expect, test } from 'bun:test';
import { ModelAttemptError, ModelRequestLimitError } from '../src';
import { createCompatibleModelBinding, createSdkModelAdapter } from '../src/sdk';

for (const protocol of ['responses', 'chat-completions'] as const)
  for (const status of [413, 429, 500, 400, 401])
    test(`explicit limit classification ${protocol} ${status}`, async () => {
      let calls = 0;
      const transport = Object.assign(
        async () => {
          calls++;
          return new Response(
            JSON.stringify({
              error: { message: 'secret: 413 payload', type: 'invalid_request_error' },
            }),
            { status, headers: { 'content-type': 'application/json' } },
          );
        },
        { preconnect: () => {} },
      ) as typeof fetch;
      const binding = createCompatibleModelBinding({
        baseURL: 'https://fixture.invalid/v1',
        modelId: 'fixture',
        protocol,
        fetch: transport,
        apiKey: 'fixture',
      });
      const adapter = createSdkModelAdapter({ models: new Map([['test', binding]]) });
      let error: unknown;
      try {
        for await (const _ of adapter.stream(
          {
            requestId: 'r',
            modelId: 'test',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [],
          },
          { signal: new AbortController().signal },
        )) {
        }
      } catch (e) {
        error = e;
      }
      expect(calls).toBe(1);
      expect(ModelRequestLimitError.isInstance(error)).toBe(status === 413);
      if (status === 413) {
        expect(ModelAttemptError.isInstance(error)).toBe(false);
        expect((error as Error).cause).toBeUndefined();
        expect(String(error)).not.toContain('secret');
      }
    });
test('words in connection errors are not HTTP evidence', async () => {
  const binding = createCompatibleModelBinding({
    baseURL: 'https://fixture.invalid/v1',
    modelId: 'fixture',
    fetch: Object.assign(
      async () => {
        throw Error('413 payload_too_large');
      },
      { preconnect: () => {} },
    ) as typeof fetch,
  });
  const adapter = createSdkModelAdapter({ models: new Map([['test', binding]]) });
  let error: unknown;
  try {
    for await (const _ of adapter.stream(
      { requestId: 'r', modelId: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [] },
      { signal: new AbortController().signal },
    )) {
    }
  } catch (e) {
    error = e;
  }
  expect(ModelRequestLimitError.isInstance(error)).toBe(false);
  expect(ModelAttemptError.isInstance(error)).toBe(true);
});
