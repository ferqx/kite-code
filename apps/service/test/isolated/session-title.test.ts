import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

for (const policy of ['default', 'custom', 'custom-deny-title'] as const)
  test(
    policy === 'custom-deny-title'
      ? 'an injected title Job denial preserves the exact fallback and completed business without an AI title request'
      : `a new Session receives a readable AI title through the selected model and public directory: ${policy} permissions`,
    async () => {
      const root = temporaryDirectory('kite-service-title-');
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
      privateDirectory(profile.profilePath);
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: config,
        credentialBackend: {
          kind: 'temporary',
          put: async () => {},
          remove: async () => {},
          resolve: async () => null,
        },
        ...(policy !== 'default'
          ? {
              permissions: {
                authorize: async (request) => ({
                  allowed: !(
                    policy === 'custom-deny-title' &&
                    request.kind === 'job' &&
                    request.definitionId === 'builtin.session-title/generate'
                  ),
                  revision: 'title-fixture',
                }),
              },
            }
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
        if (policy === 'custom-deny-title') {
          expect(view.session.title).toBe('请帮我调整新会话的');
          expect(requests).toHaveLength(1);
          expect(requests[0]?.model).toBe('actual-selected');
          expect(requests[0]?.temperature).toBe(0.2);
          expect(requests[0]?.max_tokens).toBe(512);
          expect((await client.listMessages('s')).map((message) => message.content)).toEqual([
            original,
            '任务已完成。',
          ]);
          const denied = view.executions.find(
            (execution) => execution.definitionId === 'builtin.session-title/generate',
          );
          expect(denied).toMatchObject({
            kind: 'job',
            status: 'failed',
            result: { outcome: 'failed', content: 'permission_denied' },
          });
          expect(view.executions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
          expect(
            (await store.getChanges({ after: '0', limit: 200 })).events.filter(
              (event) => event.type === 'session.renamed',
            ),
          ).toHaveLength(1);
          await client.getView('s');
          await client.listSessionDirectory({ storeId: expectedStoreId, workspaceId: 'w' });
          expect(requests).toHaveLength(1);
          return;
        }
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
          (naming.messages as { content: string }[]).some(
            (message) => message.content === titleInput,
          ),
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
    },
  );

test.each([
  'unresolved',
  'unavailable',
] as const)('default HTTP host preserves the exact quoted first input title before business admission: %s', async (mode) => {
  const root = temporaryDirectory('kite-service-title-metadata-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const original = ` \r\n“请核对这段🙂原始引用正文，不能擅自修改任务关系。”\t `;
  const fallback = '“请核对这段🙂原始引';
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      return new Response(
        `data: ${JSON.stringify({ id: 'metadata-interpretation', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: '请核实原输入要关联哪项工作。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const config = join(root, 'user.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      tools: [],
      ...(mode === 'unresolved'
        ? {
            modelId: 'selected',
            models: [
              {
                id: 'selected',
                provider: 'compatible',
                model: 'actual-selected',
                baseURL: `${provider.url.href}v1`,
              },
            ],
          }
        : { models: [] }),
    }),
  );
  privateDirectory(profile.profilePath);
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: config,
    observerSubjectId: 'owner',
    credentialBackend: {
      kind: 'temporary',
      put: async () => {
        throw Error('metadata_must_not_write_credentials');
      },
      remove: async () => {
        throw Error('metadata_must_not_remove_credentials');
      },
      resolve: async () => {
        throw Error('metadata_must_not_resolve_credentials');
      },
    },
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
    buildId: 'title-metadata-fixture',
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
  const input = {
    expectedStoreId,
    commandId: 'quoted-first',
    kind: 'run.start' as const,
    content: original,
  };
  try {
    await client.connect();
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: '',
    });
    await client.startRun('s', input);
    const deadline = Date.now() + 2000;
    for (;;) {
      const command = await client.getCommand(input.commandId);
      const receipt = command.receipt as { outcome?: string; observation?: { runId?: string } };
      if (
        command.status === 'rejected' ||
        (receipt.outcome === 'human_input_unresolved' &&
          receipt.observation?.runId &&
          !(await client.getRun(receipt.observation.runId)).isActive)
      )
        break;
      if (Date.now() >= deadline) throw Error('quoted_first_input_did_not_settle');
      await Bun.sleep(5);
    }
    const command = await client.getCommand(input.commandId);
    const receipt = command.receipt as {
      humanInputCommandId: string;
      businessCommandId?: string | null;
    };
    const raw = (await store.getCommand(receipt.humanInputCommandId))!;
    expect(command.status).toBe(mode === 'unresolved' ? 'accepted' : 'rejected');
    const savedCommand = (await store.getCommand(command.id))!;
    expect(savedCommand.request).toEqual({ kind: 'run.start', content: original });
    expect(raw.request).toMatchObject({
      content: original,
      publicCommandId: command.id,
      originalRequest: savedCommand.request,
    });
    expect(receipt.businessCommandId ?? null).toBeNull();
    expect(
      (await store.readHumanWorkState({ expectedStoreId, sessionId: 's', subjectId: 'owner' }))
        .selectedWork,
    ).toBeNull();
    const view = await client.getView('s');
    expect(view.session.title).toBe(fallback);
    expect(view.runs).toHaveLength(mode === 'unresolved' ? 1 : 0);
    for (const run of view.runs) {
      expect(
        ((await store.getRun(run.id))!.configuration as { snapshot: unknown }).snapshot,
      ).toMatchObject({
        kind: 'human_input_processing',
      });
      expect(run.status).toBe('completed');
    }
    expect(view.executions.every((execution) => execution.kind === 'model')).toBe(true);
    expect(requests).toHaveLength(mode === 'unresolved' ? 1 : 0);
    for (const request of requests) {
      expect(request.tools ?? []).toEqual([]);
      expect(
        (request.messages as { role: string; content: string }[]).some(
          (message) =>
            message.role === 'system' && message.content.includes('readable conversation title'),
        ),
      ).toBe(false);
      expect(JSON.stringify(request.messages)).toContain('原始引用正文');
    }
    expect(
      (await client.listSessionDirectory({ storeId: expectedStoreId, workspaceId: 'w' })).items[0]
        ?.session.title,
    ).toBe(fallback);
    expect(
      (await store.getChanges({ after: '0', limit: 200 })).events.filter(
        (event) => event.type === 'session.renamed',
      ),
    ).toHaveLength(1);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await client.startRun('s', input);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(requests).toHaveLength(mode === 'unresolved' ? 1 : 0);
    client.disposeNetwork();
    await service.close();
    const cold = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    try {
      expect((await cold.getSession('s'))?.title).toBe(fallback);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect((await cold.getCommand(raw.id))?.request).toEqual(raw.request);
      expect(requests).toHaveLength(mode === 'unresolved' ? 1 : 0);
    } finally {
      await cold.close();
    }
  } finally {
    client.disposeNetwork();
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
