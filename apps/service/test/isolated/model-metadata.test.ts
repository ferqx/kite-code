import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startDevelopmentWeb } from '../../src/development-web';
import { launchPairedService } from '../../src/paired';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error('model_metadata_fixture_deadline');
    await Bun.sleep(5);
  }
}

test('production paired Service freezes actual SDK settings and dispatch controls through Native, Cookie and later configuration changes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-metadata-http-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const config = join(profile.profilePath, 'config.jsonc');
  const entered = barrier(),
    release = barrier();
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const first = requests.length === 1;
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            send(chunk({ role: 'assistant', content: `actual ${body.model}` }));
            entered.resolve();
            if (first) await release.promise;
            send(chunk({}, 'stop'));
            send('data: [DONE]\n\n');
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const baseURL = `http://127.0.0.1:${provider.port}/private-provider/v1`;
  const save = (id: string, temperature: number) =>
    writeFileSync(
      config,
      JSON.stringify({
        modelId: id,
        models: [
          {
            id,
            provider: 'compatible',
            model: `remote-${id}`,
            baseURL,
            options: { temperature, topP: 0.8, maxOutputTokens: 17 },
          },
        ],
        tools: [],
      }),
    );
  save('a', 0.1);
  let host: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let browser: ReturnType<typeof createBrowserClient> | undefined;
  try {
    host = await launchPairedService({
      entrypoint: join(import.meta.dir, '../../src/main.ts'),
      profile,
      instanceId: 'metadata-host',
      buildId: 'metadata-http',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'model_inputs', 'permission_controls'],
    });
    expect(host.bootstrap.dataAvailability).toBe('available');
    const client = host.client,
      storeId = host.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${workspace}`,
      name: 'Metadata',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Metadata',
    });
    const initial = await client.getPermissionMode('s', { storeId });
    await client.setPermissionMode('s', {
      expectedStoreId: storeId,
      commandId: 'mode-before',
      mode: 'full',
      ifRevision: initial.revision,
      makeDefault: false,
      ifDefaultRevision: initial.defaultRevision,
    });
    const scope = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      canonicalIdentity: scope.canonicalIdentity,
      externalReadScopeDigest: scope.externalReadScopeDigest,
      trusted: true,
      ifRevision: scope.revision,
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'first',
      kind: 'run.start',
      content: 'Local deterministic request',
    });
    await entered.promise;
    const first = (await client.listModelInputs('s')).items[0]!;
    const dispatched = await client.getModelInput('s', first.executionId);
    expect(dispatched.confirmation).toBe('unconfirmed');
    expect(dispatched.metadata).toMatchObject({
      version: 1,
      adapter: {
        availability: 'available',
        provider: { availability: 'available', family: 'openai-compatible', modelId: 'remote-a' },
        settings: { temperature: 0.1, topP: 0.8, maxOutputTokens: 17, maxRetries: 0, maxSteps: 1 },
      },
      authorization: {
        availability: 'available',
        allowed: true,
        policy: {
          namespace: 'builtin.permissions',
          version: '1',
          data: { mode: 'full', workspaceTrust: true },
        },
      },
    });
    expect(requests[0]).toMatchObject({
      model: 'remote-a',
      temperature: 0.1,
      top_p: 0.8,
      max_tokens: 17,
    });
    save('b', 0.75);
    const current = await client.getPermissionMode('s', { storeId });
    await client.setPermissionMode('s', {
      expectedStoreId: storeId,
      commandId: 'mode-after',
      mode: 'ask',
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: current.defaultRevision,
    });
    release.resolve();
    await until(
      () => client.getView('s'),
      (view) => view.runs.some((run) => run.originCommandId === 'first' && !run.isActive),
    );
    const saved = await client.getModelInput('s', first.executionId);
    expect(saved.confirmation).toBe('succeeded');
    expect(saved.metadata).toEqual(dispatched.metadata);
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'second',
      kind: 'run.start',
      content: 'New explicit request',
    });
    await until(
      () => client.getView('s'),
      (view) => view.runs.some((run) => run.originCommandId === 'second' && !run.isActive),
    );
    const second = (await client.listModelInputs('s')).items.at(-1)!;
    const next = await client.getModelInput('s', second.executionId);
    expect(next.metadata).toMatchObject({
      adapter: { provider: { modelId: 'remote-b' }, settings: { temperature: 0.75 } },
      authorization: { policy: { data: { mode: 'ask', workspaceTrust: true } } },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ model: 'remote-b', temperature: 0.75 });
    gateway = startDevelopmentWeb({ admittedClient: client });
    const document = await fetch(gateway.endpoint);
    await document.body?.cancel();
    const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
    browser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              cookie,
              origin: gateway!.endpoint,
            },
          }),
        { preconnect: fetch.preconnect },
      ),
    });
    await browser.connect();
    const historical = await browser.getModelInput('s', first.executionId);
    expect(historical.metadata).toEqual(saved.metadata);
    expect(historical.request).toEqual(saved.request);
    expect(historical.bodyHash).toBe(saved.bodyHash);
    expect(await client.getModelInput('s', first.executionId)).toMatchObject({
      metadata: saved.metadata,
    });
    for (const privateValue of [baseURL, root, profile.profileAccessKey, host.bootstrap.token])
      expect(JSON.stringify(historical.metadata)).not.toContain(privateValue);
    expect(requests).toHaveLength(2);
  } finally {
    release.resolve();
    browser?.disposeNetwork();
    await gateway?.close();
    await host?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
