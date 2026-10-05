import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('actual Core original Model input reaches Native and Browser intact, remains historical after Rewind, and cold reads do not replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-input-http-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const original = `SOURCE START α\n${'x'.repeat(17 * 1024 * 1024)}\nSOURCE END`;
  let captures = 0;
  let source = original;
  const model = createFixedModel([[finish], [finish]]);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    sources: {
      async capture() {
        captures++;
        return [
          {
            id: 'original-source',
            kind: 'instruction',
            scope: 'session',
            digest: createHash('sha256').update(source).digest('hex'),
            content: source,
            role: 'user',
          },
        ];
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: 'old',
        apiMajor: 1,
        tools: [
          {
            id: 'original-tool',
            version: 'old',
            description: 'Original schema and description',
            inputSchema: {
              type: 'object',
              properties: { input: { type: 'string', description: 'Original input' } },
            },
            async execute() {
              throw new Error('must_not_execute');
            },
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'local-fixture' };
      },
    },
  });
  const host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'temporary' };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'model-input',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['model_inputs'] },
  });
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let coldRuntime: ReturnType<typeof createRuntime> | undefined;
  let serviceClosed = false;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      rootUri: `file://${root}`,
      name: 'temporary',
    });
    for (const sessionId of ['session', 'other'])
      await client.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'workspace',
        commandId: `create-${sessionId}`,
        title: sessionId,
      });
    await client.startRun('session', {
      expectedStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: 'Original user request',
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    const calls = await client.listModelInputs('session');
    expect(calls.items).toHaveLength(1);
    const executionId = calls.items[0]!.executionId;
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const count = captures;
    const snapshot = await client.getModelInput('session', executionId);
    expect(model.requests[0]!).toEqual(snapshot.request);
    expect(snapshot.request.messages.some((message) => message.content === original)).toBe(true);
    expect(snapshot.request.tools[0]!.definitionVersion).toBe('old');
    expect(snapshot.confirmation).toBe('succeeded');
    expect(snapshot.metadata).toMatchObject({
      version: 1,
      adapter: { availability: 'unavailable', reason: 'adapter_opaque' },
      assembly: {
        tools: [{ id: 'original-tool', definitionVersion: 'old', extensionId: 'fixture' }],
      },
      context: {
        sources: [
          { id: 'original-source', digest: createHash('sha256').update(original).digest('hex') },
        ],
      },
      authorization: { availability: 'available', revision: 'local-fixture', policy: null },
    });
    expect(BigInt(snapshot.bodyBytes) > 17n * 1024n * 1024n).toBe(true);
    gateway = startDevelopmentWeb({ admittedClient: client });
    const document = await fetch(gateway.endpoint);
    await document.body?.cancel();
    const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
    const browser = createBrowserClient({
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
    expect(await browser.listModelInputs('session')).toEqual(calls);
    expect(model.requests[0]!).toEqual(
      (await browser.getModelInput('session', executionId)).request,
    );
    expect((await browser.getModelInput('session', executionId)).metadata).toEqual(
      snapshot.metadata,
    );
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(captures).toBe(count);
    expect(model.requests).toHaveLength(1);
    const selected = await client.getContext('session', { storeId: expectedStoreId });
    await client.rewind('session', {
      expectedStoreId,
      commandId: 'rewind',
      expectedContextSelectionId: selected.selection.id,
      boundary: null,
    });
    source = 'New source must not replace the original request';
    await client.startRun('session', {
      expectedStoreId,
      commandId: 'new-run',
      kind: 'run.start',
      content: 'New selected input',
    });
    await runtime.waitForCommand('new-run', { timeoutMs: 5000 });
    const historical = await browser.getModelInput('session', executionId);
    expect(historical.request).toEqual(snapshot.request);
    expect(historical.bodyHash).toBe(snapshot.bodyHash);
    expect(historical.metadata).toEqual(snapshot.metadata);
    expect(model.requests).toHaveLength(2);
    const get = (path: string) =>
      fetch(`${service.endpoint}${path}`, {
        headers: { authorization: `Bearer ${service.bootstrap.token}` },
      });
    expect(
      (
        await get(
          `/v1/sessions/other/executions/${executionId}/model-input?storeId=${expectedStoreId}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await get(`/v1/sessions/session/executions/${executionId}/model-input?storeId=foreign`))
        .status,
    ).toBe(409);
    expect(
      (
        await get(
          `/v1/sessions/session/executions/${executionId}/model-input?storeId=${expectedStoreId}&path=/private&subjectId=owner`,
        )
      ).status,
    ).toBe(400);
    const browserScope = await fetch(
      `${gateway.endpoint}/browser/v1/sessions/other/executions/${executionId}/model-input`,
      {
        headers: { cookie, origin: gateway.endpoint, 'x-kite-web-identity': gateway.pageIdentity },
      },
    );
    expect(browserScope.status).toBe(403);
    expect(client.lastAppliedCursor).toBeUndefined();
    await gateway.close();
    gateway = undefined;
    await service.close();
    serviceClosed = true;
    cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    coldRuntime = createRuntime({
      store: cold,
      artifacts: createArtifactStore({ profile, store: cold }),
      permissions: {
        async authorize() {
          throw new Error('read_must_not_authorize');
        },
      },
      sources: {
        async capture() {
          throw new Error('read_must_not_capture');
        },
      },
    });
    const after = (await cold.getMetadata()).lastChangeCursor;
    const saved = await coldRuntime.readModelInput({
      expectedStoreId,
      sessionId: 'session',
      executionId,
      subjectId: 'owner',
    });
    expect(saved.request).toEqual(model.requests[0]!);
    expect(saved.bodyHash).toBe(snapshot.bodyHash);
    expect(saved.metadata).toEqual(snapshot.metadata);
    expect((await cold.getMetadata()).lastChangeCursor).toBe(after);
    expect(model.requests).toHaveLength(2);
  } finally {
    client.disposeNetwork();
    await gateway?.close();
    if (!serviceClosed) await service.close();
    if (coldRuntime) await coldRuntime.close();
    else await cold?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
