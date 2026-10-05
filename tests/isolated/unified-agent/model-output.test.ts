import { expect, test } from 'bun:test';
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

test('actual segmented Model output reaches next Model, Native and Cookie intact; public previews hide private heads and cold history does no work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-output-http-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const content = `Original α\0\n${'x'.repeat(17 * 1024 * 1024)}\nEXACT OUTPUT TAIL`;
  const events: ModelEvent[] = [];
  for (let offset = 0; offset < content.length; offset += 32768)
    events.push({ type: 'text_delta', text: content.slice(offset, offset + 32768) });
  events.push(
    { type: 'reasoning_delta', text: 'Original reasoning α' },
    { type: 'tool_call', id: 'check', name: 'fixture.check', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  );
  const model = createFixedModel([
    events,
    [{ type: 'text_delta', text: 'Complete small response' }, finish],
  ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.check',
            version: '1',
            description: 'Owned local ledger',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'checked' };
            },
          },
        ],
      },
    ],
  });
  const host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'model-output',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['model_outputs'] },
  });
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let browser: ReturnType<typeof createBrowserClient> | undefined;
  let coldRuntime: ReturnType<typeof createRuntime> | undefined;
  let closed = false;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned',
    });
    for (const sessionId of ['s', 'other'])
      await client.createSession({
        expectedStoreId,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'w',
        title: sessionId,
      });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'start',
      kind: 'run.start',
      content: 'Local output fixture',
    });
    await runtime.waitForCommand('start', { timeoutMs: 10000 });
    const inputs = await client.listModelInputs('s');
    expect(inputs.items).toHaveLength(2);
    expect(effects).toBe(1);
    const executionId = inputs.items[0]!.executionId;
    expect(
      model.requests[1]!.messages.some(
        (message) => message.content === content && message.sourceIds?.[0] === executionId,
      ),
    ).toBe(true);
    const saved = await client.getModelOutput('s', executionId);
    expect(saved.output).toEqual({
      content,
      reasoning: 'Original reasoning α',
      toolCalls: [{ id: 'check', name: 'fixture.check', arguments: '{}' }],
      complete: true,
    });
    expect(saved.contentBytes).toBe(String(Buffer.byteLength(content)));
    expect((await client.getModelOutput('s', inputs.items[1]!.executionId)).output.content).toBe(
      'Complete small response',
    );
    const messages = await client.listMessages('s');
    const preview = messages.find((message) => message.outputBody?.executionId === executionId)!;
    expect(preview.content.length).toBeLessThan(5000);
    expect(preview.outputBody).toMatchObject({
      kind: 'model_output',
      complete: true,
      contentBytes: saved.contentBytes,
      toolCallCount: 1,
    });
    expect(preview.toolCalls).toEqual([]);
    const selected = await client.getContext('s', { storeId: expectedStoreId });
    expect(selected.messages.find((message) => message.id === preview.id)?.outputBody).toEqual(
      preview.outputBody,
    );
    const view = await client.getView('s');
    const execution = await client.getExecution(executionId);
    for (const value of [messages, view, execution, selected, saved]) {
      expect(JSON.stringify(value)).not.toContain('model-output-');
      expect(JSON.stringify(value)).not.toContain('"subjectId"');
      expect(JSON.stringify(value)).not.toContain(root);
    }
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
    const cursor = (await store.getMetadata()).lastChangeCursor;
    expect((await browser.getModelOutput('s', executionId)).output).toEqual(saved.output);
    expect(
      (await browser.listMessages('s')).find((message) => message.id === preview.id)?.outputBody,
    ).toEqual(preview.outputBody);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(model.requests).toHaveLength(2);
    const nativeGet = (sessionId: string, query: string) =>
      fetch(
        `${service.endpoint}/v1/sessions/${sessionId}/executions/${executionId}/model-output?${query}`,
        {
          headers: { authorization: `Bearer ${service.bootstrap.token}` },
        },
      );
    expect((await nativeGet('other', `storeId=${expectedStoreId}`)).status).toBe(403);
    expect((await nativeGet('s', 'storeId=foreign')).status).toBe(409);
    expect(
      (await nativeGet('s', `storeId=${expectedStoreId}&refId=forged&subjectId=owner`)).status,
    ).toBe(400);
    const denied = await fetch(
      `${gateway.endpoint}/browser/v1/sessions/other/executions/${executionId}/model-output`,
      {
        headers: { cookie, origin: gateway.endpoint, 'x-kite-web-identity': gateway.pageIdentity },
      },
    );
    expect(denied.status).toBe(403);
    await client.rewind('s', {
      expectedStoreId,
      commandId: 'rewind',
      expectedContextSelectionId: selected.selection.id,
      boundary: null,
    });
    expect((await browser.getModelOutput('s', executionId)).bodyHash).toBe(saved.bodyHash);
    expect(model.requests).toHaveLength(2);
    await gateway.close();
    gateway = undefined;
    await service.close();
    closed = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    coldRuntime = createRuntime({
      store: cold,
      artifacts: createArtifactStore({ profile, store: cold }),
      permissions: {
        async authorize() {
          throw Error('cold_read_must_not_authorize');
        },
      },
      sources: {
        async capture() {
          throw Error('cold_read_must_not_capture');
        },
      },
    });
    const before = (await cold.getMetadata()).lastChangeCursor;
    const historical = await coldRuntime.readModelOutput({
      expectedStoreId,
      sessionId: 's',
      executionId,
      subjectId: 'owner',
    });
    expect(historical.output).toEqual(saved.output);
    expect(historical.bodyHash).toBe(saved.bodyHash);
    expect((await cold.getMetadata()).lastChangeCursor).toBe(before);
    expect(model.requests).toHaveLength(2);
  } finally {
    browser?.disposeNetwork();
    client.disposeNetwork();
    await gateway?.close();
    if (!closed) await service.close();
    await coldRuntime?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
