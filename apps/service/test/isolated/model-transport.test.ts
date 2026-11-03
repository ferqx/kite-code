import { expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { RunRecord } from '@kite-ai/agent/storage';
import { WebFetchError } from '@kite-ai/agent/web-fetch';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { resolveModelTransport } from '../../src/model-transport';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';
import { userConfigurationPath } from '../fixtures/user-configuration-fixture';

test('system proxy selection retains request identity, bypass patterns and binding snapshot without changing environment', async () => {
  const before = { ...process.env };
  const calls: { url: string; init?: RequestInit & { proxy?: string | false } }[] = [];
  const transportFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response('ok');
    },
    { preconnect: fetch.preconnect },
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
  expect(transport.fetch.preconnect).toBe(transportFetch.preconnect);
  proxy.https = 'http://later.test';
  await transport.fetch('https://model.test');
  expect(calls.at(-1)?.init?.proxy).toBe('http://secure.test:81');
  expect(transport.snapshot).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(transport.snapshot)).not.toContain('proxy.test');
  expect(process.env).toEqual(before);
});

test('explicit environment stays with Bun; NO_PROXY overrides system bypass and unsupported settings fail closed', async () => {
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
    expect(transport.fetch).toBe(fetch);
    expect(JSON.stringify(transport.snapshot)).not.toContain('secret');
  }
  expect(discoveries).toBe(0);
  const calls: unknown[] = [];
  const transport = await resolveModelTransport({
    env: { NO_PROXY: 'other.test' },
    systemProxy,
    fetch: Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        calls.push(init);
        return new Response('ok');
      },
      { preconnect: fetch.preconnect },
    ),
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
  const proxy = Bun.serve({
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
  const direct = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('direct ok'),
  });
  try {
    const transport = await resolveModelTransport({
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
    const rejected = await transport.fetch('http://unresolvable-model.invalid/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'rejected' }),
    });
    expect(rejected.status).toBe(407);
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
    await proxy.stop(true);
    await direct.stop(true);
  }
}, 15000);

test('default Service model binding uses system proxy without proxy environment or project network configuration', async () => {
  const proxyVariables = [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ];
  const previousProxyEnvironment = new Map(proxyVariables.map((key) => [key, process.env[key]]));
  for (const key of proxyVariables) delete process.env[key];
  try {
    const actual = await import('../../src/web-fetch-proxy');
    const requests: string[] = [];
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push(request.url);
        await request.json();
        return new Response(
          encodeFrames(
            responseFrames({ id: 'service-proxy', model: 'fixture', text: ['service proxy ok'] }),
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let selectedProxy = proxy.url.origin;
    mock.module('../../src/web-fetch-proxy', () => ({
      ...actual,
      systemWebProxy: async () => ({ http: selectedProxy }),
    }));
    const root = mkdtempSync(join(tmpdir(), 'kite-model-system-proxy-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    privateDirectory(profile.profilePath);
    privateDirectory(join(root, '.kite-code'));
    const file = userConfigurationPath(root);
    writeFileSync(
      file,
      JSON.stringify({
        modelId: 'fixture',
        models: [
          {
            id: 'fixture',
            provider: 'compatible',
            protocol: 'responses',
            model: 'fixture',
            baseURL: 'http://unresolvable-service-model.invalid/v1',
          },
        ],
        tools: [],
      }),
    );
    const { createDefaultProcessConfiguration } = await import('../../src/configuration');
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: file,
      permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const runtime = createRuntime({
      ...host,
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions: host.permissions!,
    });
    host.permissionManagement!(runtime);
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      const base = { expectedStoreId, sessionId: 's', subjectId: 'fixture' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'fixture',
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'fixture',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'proxy-run',
        request: { kind: 'run.start', content: 'hello' },
      });
      const deadline = Date.now() + 7000;
      let completed: RunRecord | undefined;
      do {
        const next = await runtime.getView('s');
        completed = next.runs.find((run) => run.originCommandId === 'proxy-run');
        if (completed && !completed.isActive) break;
        await Bun.sleep(5);
      } while (Date.now() < deadline);
      expect(completed?.status).toBe('completed');
      expect(requests).toEqual(['http://unresolvable-service-model.invalid/v1/responses']);
      expect(completed?.configuration).toMatchObject({
        snapshot: { modelTransport: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      });
      const recovery = {
        command: (await store.getCommand('proxy-run'))!,
        run: (await store.getRun(completed!.id))!,
        session: (await store.getSession('s'))!,
        workspace: (await store.getWorkspace('w'))!,
        signal: new AbortController().signal,
      };
      const reopened = await host.resolveRecoveryRunConfiguration!(recovery);
      await reopened.dispose?.();
      selectedProxy = 'http://127.0.0.1:1';
      await expect(host.resolveRecoveryRunConfiguration!(recovery)).rejects.toMatchObject({
        code: 'recovery_configuration_changed',
      });
      expect(requests).toHaveLength(1);
    } finally {
      await runtime.close();
      await proxy.stop(true);
      rmSync(root, { recursive: true, force: true });
      mock.restore();
    }
  } finally {
    for (const [key, value] of previousProxyEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 15000);
