import { createServer } from 'node:http';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { WebFetchError } from '@kite-ai/agent/web-fetch';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import undici from 'undici/index.js';
import { expect, spyOn, test } from '#kite-test';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import { resolveModelTransport } from '../../src/model-transport';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';

test('owned model pools reuse connections, keep other bindings alive and close idempotently', async () => {
  const sockets = new Map<import('node:net').Socket, number>();
  const closed = new Set<number>();
  const requests: number[] = [];
  const server = createServer((request, response) => {
    requests.push(sockets.get(request.socket)!);
    response.end('ok');
  });
  server.on('connection', (socket) => {
    const id = sockets.size + 1;
    sockets.set(socket, id);
    socket.once('close', () => closed.add(id));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const first = await resolveModelTransport({ env: {}, systemProxy: async () => ({}) });
  const second = await resolveModelTransport({ env: {}, systemProxy: async () => ({}) });
  try {
    for (let index = 0; index < 3; index++)
      expect(await (await first.fetch(url)).text()).toBe('ok');
    expect(await (await second.fetch(url)).text()).toBe('ok');
    expect(await (await fetch(url, { proxy: false } as RequestInit)).text()).toBe('ok');
    const firstSockets = new Set(requests.slice(0, 3));
    const secondSocket = requests[3]!;
    const globalSocket = requests[4]!;
    expect(firstSockets.size).toBeLessThan(3);
    expect(firstSockets.has(secondSocket)).toBe(false);
    expect(firstSockets.has(globalSocket)).toBe(false);
    expect(globalSocket).not.toBe(secondSocket);
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await closing;
    const deadline = Date.now() + 2000;
    while ([...firstSockets].some((id) => !closed.has(id)) && Date.now() < deadline)
      await sleepTimer(5);
    expect([...firstSockets].every((id) => closed.has(id))).toBe(true);
    expect(closed.has(secondSocket)).toBe(false);
    await expect(first.fetch(url)).rejects.toMatchObject({ code: 'model_transport_closed' });
    expect(await (await second.fetch(url)).text()).toBe('ok');
    expect(requests.at(-1)).toBe(secondSocket);
  } finally {
    await Promise.all([first.close(), second.close()]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);

test('a failed native close is retained without retrying cleanup or accepting new requests', async () => {
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('ok'),
  });
  const transport = await resolveModelTransport({ env: {}, systemProxy: async () => ({}) });
  const failure = new Error('fixture_session_close_failed');
  let session: InstanceType<typeof undici.Agent> | undefined;
  const close = spyOn(undici.Agent.prototype, 'close').mockImplementation(function (
    this: InstanceType<typeof undici.Agent>,
  ) {
    session = this;
    throw failure;
  });
  try {
    expect(await (await transport.fetch(server.url)).text()).toBe('ok');
    const closing = transport.close();
    await expect(closing).rejects.toBe(failure);
    expect(transport.close()).toBe(closing);
    await expect(transport.close()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(transport.fetch(server.url)).rejects.toMatchObject({
      code: 'model_transport_closed',
    });
  } finally {
    close.mockRestore();
    await session?.close();
    await server.stop(true);
  }
});

test('session transport preserves caller abort identity and never retries an interrupted body', async () => {
  let calls = 0;
  const server = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('pending'));
          },
        }),
      );
    },
  });
  const transport = await resolveModelTransport({ env: {}, systemProxy: async () => ({}) });
  try {
    const controller = new AbortController();
    const response = await transport.fetch(server.url, { signal: controller.signal });
    const reading = response.text();
    const reason = new Error('fixture_model_cancelled');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    await transport.close();
    expect(calls).toBe(1);
    await expect(transport.fetch(server.url)).rejects.toMatchObject({
      code: 'model_transport_closed',
    });
    expect(calls).toBe(1);
  } finally {
    await transport.close();
    await server.stop(true);
  }
});

test('system proxy selection retains request identity, bypass patterns and binding snapshot without changing environment', async () => {
  const before = { ...process.env };
  const calls: { url: string; init?: RequestInit & { proxy?: string | false } }[] = [];
  const transportFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response('ok');
    },
    {},
  );
  const proxy = {
    http: 'http://proxy.test:80',
    https: 'http://secure.test:81',
    noProxy: '<local>;127.*;*.internal.test;[::1];exact.test:8443',
  };
  const transport = await resolveModelTransport({
    env: {},
    systemProxy: async () => proxy,
    fetch: transportFetch,
  });
  const controller = new AbortController();
  const init = {
    method: 'POST',
    body: 'private-body',
    headers: { authorization: 'fixture' },
    signal: controller.signal,
  };
  await transport.fetch('https://model.test/responses', init);
  await transport.fetch(new Request('http://model.test/chat/completions', init));
  for (const url of [
    'http://localhost',
    'http://127.0.0.1',
    'http://host.internal.test',
    'http://[::1]',
    'https://exact.test:8443',
  ])
    await transport.fetch(url);
  await transport.fetch('https://exact.test');
  expect(calls.map((call) => call.init?.proxy)).toEqual([
    'http://secure.test:81',
    'http://proxy.test:80',
    false,
    false,
    false,
    false,
    false,
    'http://secure.test:81',
  ]);
  expect(calls[0]?.init).toMatchObject(init);
  expect(calls[0]?.init?.signal).toBe(controller.signal);
  proxy.https = 'http://later.test';
  await transport.fetch('https://model.test');
  expect(calls.at(-1)?.init?.proxy).toBe('http://secure.test:81');
  expect(transport.snapshot).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(transport.snapshot)).not.toContain('proxy.test');
  expect(process.env).toEqual(before);
});

test('explicit environment bypasses system discovery; NO_PROXY overrides system bypass and unsupported settings fail closed', async () => {
  let discoveries = 0;
  const systemProxy = async () => {
    discoveries++;
    return { https: 'http://system.test', noProxy: '*' };
  };
  for (const env of [
    { HTTPS_PROXY: 'http://user:secret@explicit.test' },
    { http_proxy: 'http://explicit.test' },
    { ALL_PROXY: 'http://explicit.test' },
  ]) {
    const transport = await resolveModelTransport({ env, systemProxy });
    expect(transport.fetch).not.toBe(fetch);
    await transport.close();
    expect(JSON.stringify(transport.snapshot)).not.toContain('secret');
  }
  expect(discoveries).toBe(0);
  const calls: unknown[] = [];
  const transport = await resolveModelTransport({
    env: { NO_PROXY: 'other.test' },
    systemProxy,
    fetch: Object.assign(async (_input: unknown, init?: RequestInit) => {
      calls.push(init);
      return new Response('ok');
    }, {}),
  });
  await transport.fetch('https://model.test');
  await transport.fetch('https://other.test');
  expect(calls).toEqual([{ proxy: 'http://system.test' }, { proxy: false }]);
  const changed = await resolveModelTransport({ env: { NO_PROXY: '*' }, systemProxy });
  expect(changed.snapshot.digest).not.toBe(transport.snapshot.digest);
  await expect(
    resolveModelTransport({
      env: {},
      systemProxy: async () => {
        throw new WebFetchError('web_proxy_pac_unsupported');
      },
    }),
  ).rejects.toMatchObject({ code: 'model_proxy_pac_unsupported' });
});

test('real SDK Chat and Responses requests use the selected proxy; bypass, cancellation and proxy rejection keep their original outcomes', async () => {
  const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] =
    [];
  const proxy = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body,
      });
      if (body.model === 'rejected') return new Response('denied', { status: 407 });
      if (body.model === 'pending')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': waiting\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      const content = new URL(request.url).pathname.endsWith('/responses')
        ? encodeFrames(
            responseFrames({ id: 'proxy-response', model: 'fixture', text: ['proxy ok'] }),
          )
        : `data: ${JSON.stringify({ id: 'proxy-chat', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'proxy ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'proxy-chat', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      return new Response(content, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const direct = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('direct ok'),
  });
  let transport: Awaited<ReturnType<typeof resolveModelTransport>> | undefined;
  try {
    transport = await resolveModelTransport({
      env: {},
      systemProxy: async () => ({ http: proxy.url.origin, noProxy: '127.*' }),
    });
    for (const protocol of ['chat-completions', 'responses'] as const) {
      const binding = createCompatibleModelBinding({
        baseURL: 'http://unresolvable-model.invalid/v1',
        modelId: 'fixture',
        protocol,
        apiKey: 'synthetic-key',
        fetch: transport.fetch,
      });
      const adapter = createSdkModelAdapter({ models: new Map([['fixture', binding]]) });
      const events = [];
      for await (const event of adapter.stream(
        {
          modelId: 'fixture',
          requestId: protocol,
          messages: [{ role: 'user', content: 'hello' }],
          tools: [],
        },
        { signal: new AbortController().signal },
      ))
        events.push(event);
      expect(
        events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.text)
          .join(''),
      ).toBe('proxy ok');
      expect(events.at(-1)?.type).toBe('finish');
    }
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          request.url.startsWith('http://unresolvable-model.invalid/') &&
          request.authorization === 'Bearer synthetic-key',
      ),
    ).toBe(true);
    expect(await (await transport.fetch(direct.url)).text()).toBe('direct ok');
    expect(requests).toHaveLength(2);
    await expect(
      transport.fetch('http://unresolvable-model.invalid/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'rejected' }),
      }),
    ).rejects.toThrow('fetch failed');
    expect(requests).toHaveLength(3);
    const controller = new AbortController();
    const pending = await transport.fetch('http://unresolvable-model.invalid/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'pending' }),
      signal: controller.signal,
    });
    const reading = pending.text();
    controller.abort();
    await expect(reading).rejects.toBeDefined();
    expect(requests).toHaveLength(4);
  } finally {
    await transport?.close();
    await proxy.stop(true);
    await direct.stop(true);
  }
}, 15000);
