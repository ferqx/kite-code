import { expect, test } from 'bun:test';
import { createCompatibleModelBinding } from '@kite-ai/ai/sdk';
import { providerModelFetch } from '../../src/model-providers';

test('OpenCode Go sends a stable opaque conversation header only to the exact inference endpoints', async () => {
  const baseURL = 'https://opencode.ai/inference/go/openai/v1';
  const requests: Request[] = [];
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 307, headers: { location: 'https://other.invalid' } });
    },
    { preconnect: fetch.preconnect },
  );
  for (const [protocol, sessionId] of [
    ['chat-completions', 'private-conversation'],
    ['responses', 'private-conversation'],
    ['responses', 'different-conversation'],
  ] as const) {
    const binding = createCompatibleModelBinding({
      name: 'compatible',
      baseURL,
      protocol,
      modelId: 'fixture',
      apiKey: 'fixture',
      fetch: providerModelFetch(`${baseURL}/`, sessionId, transport),
    });
    if (typeof binding === 'string') throw Error('Expected a bound SDK model');
    await expect(binding.doStream({ prompt: [] })).rejects.toThrow();
  }
  expect(requests.map(({ url }) => url)).toEqual([
    `${baseURL}/chat/completions`,
    `${baseURL}/responses`,
    `${baseURL}/responses`,
  ]);
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe('Bearer fixture');
    expect(request.headers.get('user-agent')).toBe('Kite-Code');
    expect(request.redirect).toBe('manual');
  }
  const sessions = requests.map((request) => request.headers.get('x-opencode-session'));
  expect(sessions[0]).toMatch(/^ses_[a-f0-9]{64}$/);
  expect(sessions[1]).toBe(sessions[0]);
  expect(sessions[2]).not.toBe(sessions[0]);

  const bound = providerModelFetch(baseURL, 'private-conversation', transport);
  for (const url of [
    `${baseURL}/responses?forward=1`,
    'https://opencode.ai/inference/openai/v1/responses',
    'https://other.invalid/inference/go/openai/v1/responses',
  ])
    await expect(bound(url)).rejects.toMatchObject({ code: 'invalid_provider_endpoint' });
  expect(requests).toHaveLength(3);
  expect(
    providerModelFetch('https://opencode.ai/zen/go/v1', 'private-conversation', transport),
  ).toBe(transport);
});
