import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

test.each([
  'default',
  'custom',
] as const)('a new Session receives a readable AI title through the selected model and public directory: %s permissions', async (policy) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-title-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const requests: Record<string, unknown>[] = [];
  const title = '修复新会话名称可读性';
  const original = `${' \r\n'.repeat(3000)}请帮我调整新会话的   自动命名，\n\n让列表里的名称能概括任务内容。\t `;
  const titleInput = '请帮我调整新会话的 自动命名， 让列表里的名称能概括任务内容。';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string }[];
      const naming = messages[0]?.content.includes('readable conversation title');
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'title-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${chunk({ role: 'assistant', content: naming ? `“${title}”` : '任务已完成。' })}${chunk({}, 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  const config = join(root, 'user.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      modelId: 'default',
      tools: [],
      models: ['default', 'selected'].map((id) => ({
        id,
        provider: 'compatible',
        model: `actual-${id}`,
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        options: { temperature: 0.2, maxOutputTokens: 512 },
      })),
    }),
  );
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: config,
    credentialBackend: {
      kind: 'temporary',
      put: async () => {},
      remove: async () => {},
      resolve: async () => null,
    },
    ...(policy === 'custom'
      ? { permissions: { authorize: async () => ({ allowed: true, revision: 'title-fixture' }) } }
      : {}),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({ ...host, store, permissions: host.permissions! });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'Fixture',
  });
  const service = await startService({
    runtime,
    subjectId: 'owner',
    buildId: 'title-fixture',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'sessions'],
    },
  });
  try {
    await client.connect();
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: '',
    });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: original,
      modelId: 'selected',
    });
    await runtime.waitForCommand('work');
    const view = await client.getView('s');
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.session).toMatchObject({ title, controlRevision: '2' });
    expect(view.executions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
    const directory = await client.listSessionDirectory({
      storeId: expectedStoreId,
      workspaceId: 'w',
    });
    expect(directory.items[0]?.session.title).toBe(title);
    expect((await client.listMessages('s')).map((message) => message.content)).toEqual([
      original,
      '任务已完成。',
    ]);
    expect(requests).toHaveLength(2);
    for (const body of requests) {
      expect(body.model).toBe('actual-selected');
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(512);
    }
    const naming = requests[1]!;
    expect(naming.tools ?? []).toEqual([]);
    expect(
      (naming.messages as { content: string }[]).some((message) => message.content === titleInput),
    ).toBe(true);
    const events = await store.getChanges({ after: '0', limit: 200 });
    expect(events.events.filter((event) => event.type === 'session.renamed')).toHaveLength(2);
    await client.getView('s');
    await client.listSessionDirectory({ storeId: expectedStoreId, workspaceId: 'w' });
    expect(requests).toHaveLength(2);
  } finally {
    client.disposeNetwork();
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
