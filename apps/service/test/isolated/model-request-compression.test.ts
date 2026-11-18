import { expect, test } from 'bun:test';
import { zstdDecompressSync } from 'node:zlib';
import { modelRequestCompression } from '../../src/model-request-compression';

const body = JSON.stringify({
  input: [{ image_url: 'data:image/png;base64,' + 'a'.repeat(300000) }],
});
for (const provider of ['openai', 'compatible', 'codex'])
  for (const protocol of ['responses', 'chat-completions'])
    test(`compression route ${provider}/${protocol}`, async () => {
      let calls = 0;
      const signal = new AbortController().signal;
      const transport = Object.assign(
        async (_: unknown, init?: RequestInit) => {
          calls++;
          expect(init?.signal).toBe(signal);
          const compressed = provider === 'openai' && protocol === 'responses';
          expect(new Headers(init?.headers).get('content-encoding')).toBe(
            compressed ? 'zstd' : null,
          );
          if (compressed)
            expect(zstdDecompressSync(init!.body as Uint8Array).toString()).toBe(body);
          else expect(init?.body).toBe(body);
          return new Response('', { status: 413 });
        },
        { preconnect: () => {} },
      ) as typeof fetch;
      const wrapped = modelRequestCompression(
        { provider, protocol, baseURL: 'https://api.openai.com/v1' },
        transport,
      );
      expect(
        (await wrapped('https://api.openai.com/v1/responses', { method: 'POST', body, signal }))
          .status,
      ).toBe(413);
      expect(calls).toBe(1);
    });
test('official-looking foreign host and changed path remain identity', async () => {
  let calls = 0;
  const f = Object.assign(
    async (_: unknown, init?: RequestInit) => {
      calls++;
      expect(init?.body).toBe(body);
      return new Response('');
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  for (const baseURL of [
    'https://api.openai.com.evil/v1',
    'http://api.openai.com/v1',
    'https://api.openai.com/v1',
  ]) {
    const wrapped = modelRequestCompression(
      { provider: 'openai', protocol: 'responses', baseURL },
      f,
    );
    await wrapped('https://api.openai.com/v1/other', { method: 'POST', body });
  }
  expect(calls).toBe(3);
});
test('cancellation during async compression never reaches transport', async () => {
  let calls = 0;
  const control = new AbortController();
  const transport = Object.assign(
    async () => {
      calls++;
      return new Response('');
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  const wrapped = modelRequestCompression(
    { provider: 'openai', protocol: 'responses', baseURL: 'https://api.openai.com/v1' },
    transport,
  );
  const promise = wrapped('https://api.openai.com/v1/responses', {
    method: 'POST',
    body,
    signal: control.signal,
  });
  control.abort();
  await expect(promise).rejects.toThrow();
  expect(calls).toBe(0);
});
