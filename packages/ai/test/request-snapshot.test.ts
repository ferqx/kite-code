import { expect, test } from 'bun:test';
import type { ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';

const request: ModelRequest = {
  modelId: 'selected',
  requestId: 'original-attempt',
  messages: [{ role: 'user', content: 'actual request' }],
  tools: [],
};
test('pure SDK description is sealed from actual binding/preset and never exposes private transport data', async () => {
  const received: Record<string, unknown>[] = [];
  const transport = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      received.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'remote', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'remote', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const preset = { temperature: 0.2, topP: 0.7, maxOutputTokens: 123 };
  const model = createCompatibleModelBinding({
    baseURL: 'https://private.invalid/secret-route',
    modelId: 'remote',
    apiKey: 'credential-secret',
    headers: { 'x-private': 'header-secret' },
    fetch: transport,
  });
  const models = new Map([['selected', model]]),
    presets = new Map([['selected', preset]]);
  const adapter = createSdkModelAdapter({ models, presets });
  preset.temperature = 0.9;
  models.clear();
  presets.clear();
  const description = adapter.describeRequest!(request);
  expect(received).toHaveLength(0);
  expect(description).toEqual({
    adapterId: 'kite.sdk',
    adapterVersion: '1',
    provider: { availability: 'available', family: 'openai-compatible', modelId: 'remote' },
    settings: {
      temperature: 0.2,
      topP: 0.7,
      maxOutputTokens: 123,
      maxRetries: 0,
      maxSteps: 1,
      allowSystemInMessages: true,
      includeUsage: true,
    },
    transformation: { id: 'kite.sdk.messages', version: '1' },
  });
  for (const privateValue of [
    'private.invalid',
    'secret-route',
    'credential-secret',
    'header-secret',
    'x-private',
  ])
    expect(JSON.stringify(description)).not.toContain(privateValue);
  (description.settings as { temperature: number }).temperature = 0.99;
  expect(adapter.describeRequest!(request).settings.temperature).toBe(0.2);
  for await (const _event of adapter.stream(request, { signal: new AbortController().signal })) {
    /* Consume actual SDK mapping. */
  }
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    model: 'remote',
    temperature: 0.2,
    top_p: 0.7,
    max_tokens: 123,
  });
});

test('arbitrary SDK Model remains opaque instead of treating its identifier as trusted Provider metadata', () => {
  const adapter = createSdkModelAdapter({
    models: new Map([['selected', 'opaque/credential-secret']]),
  });
  const metadata = adapter.describeRequest!(request);
  expect(metadata.provider).toEqual({
    availability: 'unavailable',
    reason: 'provider_binding_opaque',
  });
  expect(metadata.settings).toEqual({ maxRetries: 0, maxSteps: 1, allowSystemInMessages: true });
  expect(JSON.stringify(metadata)).not.toContain('credential-secret');
});
