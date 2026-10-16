import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { ModelAttemptError } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';

for (const window of [4096, undefined])
  test(`default SDK assembly compresses one task after an interrupted summary; declared window=${window ?? 'unknown'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-long-compression-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    for (let i = 1; i <= 3; i++)
      writeFileSync(
        join(workspace, `input-${i}.txt`),
        `Original tool evidence ${i}\n`.repeat(5500),
      );
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    let summaries = 0,
      decisions = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const summarizing = body.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith('Summarize the preceding recorded conversation'),
        );
        if (summarizing && ++summaries === 1)
          return Response.json(
            { error: { message: 'Temporary test-owned summary interruption' } },
            { status: 500 },
          );
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        let delta: unknown, reason: string;
        if (summarizing) {
          expect(body.tools?.length ?? 0).toBe(0);
          delta = {
            content: `Original task and exact evidence summarized at checkpoint ${summaries}`,
          };
          reason = 'stop';
        } else if (++decisions <= 3) {
          delta = {
            tool_calls: [
              {
                index: 0,
                id: `read-${decisions}`,
                type: 'function',
                function: {
                  name: 'files.read',
                  arguments: JSON.stringify({ path: `input-${decisions}.txt`, limit: 10000 }),
                },
              },
            ],
          };
          reason = 'tool_calls';
        } else {
          delta = { content: 'Original long task completed after repeated compression' };
          reason = 'stop';
        }
        return new Response(`${frame(delta, null)}${frame({}, reason)}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [{ id: 'files.read', definitionVersion: '3' }],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
            ...(window
              ? { modelCapabilities: { contextWindowTokens: window, maxOutputTokens: 512 } }
              : {}),
          },
        ],
      }),
    );
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
      credentialBackend: createTemporaryCredentialBackend(),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store }),
    });
    host.permissionManagement!(runtime);
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'create',
        subjectId: 'owner',
        title: 'long task',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: 'Complete all three evidence reads in this original task',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 15000 });
      const view = await store.getView('s');
      if (view.runs[0]!.status !== 'completed')
        throw Error(
          JSON.stringify({
            status: view.runs[0]!.status,
            reason: view.runs[0]!.reason,
            decisions,
            summaries,
            executions: view.executions.map((execution) => ({
              kind: execution.kind,
              definition: execution.definitionId,
              status: execution.status,
              code: (execution.result as Record<string, unknown> | null)?.code,
            })),
          }),
        );
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ status: 'completed', reason: null, deadlineAt: null });
      expect(decisions).toBe(4);
      expect(summaries).toBe(3);
      const context = await store.getSelectedContext({ expectedStoreId, sessionId: 's' });
      expect(context.compression).toMatchObject({ trigger: 'automatic', runId: view.runs[0]!.id });
      expect(context.compression!.previousCompressionId).not.toBeNull();
      const normalRequests = requests.filter((request) => request.tools?.length);
      expect(JSON.stringify(normalRequests[1]!.messages)).toContain('Original tool evidence 1');
      expect(JSON.stringify(normalRequests.at(-1)!.messages)).toContain(
        'summarized at checkpoint 3',
      );
      const failed = view.executions.filter(
        (execution) => execution.kind === 'model' && execution.status === 'failed',
      );
      expect(failed).toHaveLength(1);
      expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(3);
      expect(await store.listMessages('s')).toHaveLength(10);
    } finally {
      await runtime.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

test('public HTTP and generated Client retain retry attempt six with an unlimited maximum', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-public-long-retry-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let attempts = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    model: {
      async *stream() {
        if (++attempts <= 5) throw new ModelAttemptError('provider_unavailable');
        yield { type: 'text_delta', text: 'Recovered original public Run' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  const target = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: target,
    buildId: 'long-retry',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile: target, apiMajor: 1, requiredCapabilities: ['commands', 'sessions'] },
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'retry',
    });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Continue through temporary failure',
    });
    await runtime.waitForCommand('work');
    const view = await client.getView('s');
    expect(view.runs[0]!.status).toBe('completed');
    expect(attempts).toBe(6);
    expect(
      view.executions.find((execution) => execution.modelRetry?.attempt === 6)?.modelRetry,
    ).toMatchObject({ maxAttempts: null, reason: 'provider_unavailable' });
    expect(view.runs).toHaveLength(1);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
