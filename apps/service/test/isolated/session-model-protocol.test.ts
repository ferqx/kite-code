import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createConfigurationSnapshot, type JsonObject } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { runModelProtocol } from '../../src/session-model-protocol';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw Error('session_protocol_deadline');
    await Bun.sleep(5);
  }
}

async function fixture(existingRoot?: string) {
  const root = existingRoot ?? temporaryDirectory('kite-session-model-protocol-');
  const workspace = join(root, 'workspace');
  const home = join(root, 'user');
  for (const directory of [workspace, home]) privateDirectory(directory);
  const file = join(home, 'kite-code.jsonc');
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let rejectNext = false;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path, body });
      if (rejectNext) {
        rejectNext = false;
        return Response.json({ error: { message: 'fixture model rejection' } }, { status: 400 });
      }
      if (path.endsWith('/responses'))
        return new Response(
          encodeFrames(
            responseFrames({
              id: `response-${requests.length}`,
              model: String(body.model),
              text: ['Responses reply'],
            }),
          ),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'chat', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${chunk({ content: 'Chat reply' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  const url = `http://127.0.0.1:${provider.port}`;
  const config = {
    modelId: 'chat-a',
    models: [
      { id: 'chat-a', provider: 'compatible', model: 'chat-first', baseURL: `${url}/a/v1` },
      {
        id: 'chat-b',
        provider: 'openai',
        model: 'chat-second',
        baseURL: `${url}/b/v1`,
        protocol: 'chat-completions',
      },
      {
        id: 'response-a',
        provider: 'openai',
        model: 'response-first',
        baseURL: `${url}/a/v1`,
        protocol: 'responses',
      },
      {
        id: 'response-b',
        provider: 'compatible',
        model: 'response-second',
        baseURL: `${url}/b/v1`,
        protocol: 'responses',
      },
    ],
    tools: [],
  };
  // Cold fixtures keep the first Run's model/protocol, but use the new local mock transport.
  if (existingRoot) {
    const previous = JSON.parse(readFileSync(file, 'utf8')) as typeof config;
    config.modelId = previous.modelId;
    config.models = previous.models.map((model) => ({
      ...model,
      baseURL: model.baseURL.replace(/http:\/\/127\.0\.0\.1:\d+/, url),
    }));
  }
  writeFileSync(file, JSON.stringify(config));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  let credentialReads = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: file,
    credentialBackend: {
      kind: 'temporary',
      put: async () => {},
      remove: async () => {},
      resolve: async () => {
        credentialReads++;
        return 'fixture-key';
      },
    },
    permissions: {
      authorize: async () => ({ allowed: true, revision: 'session-protocol-fixture' }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
  });
  host.permissionManagement!(runtime);
  const service = await startService({
    runtime,
    subjectId: 'owner',
    buildId: 'session-protocol-test',
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
      requiredCapabilities: ['commands'],
    },
  });
  await client.connect();
  const storeId = (await store.getMetadata()).storeId;
  const createSession = (sessionId: string) =>
    client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: sessionId,
    });
  if (!existingRoot) {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Protocol fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    await createSession('s');
  }
  return {
    root,
    file,
    config,
    host,
    runtime,
    store,
    requests,
    storeId,
    createSession,
    get credentialReads() {
      return credentialReads;
    },
    rejectNextRequest() {
      rejectNext = true;
    },
    async run(
      commandId: string,
      modelId?: string,
      options: { sessionId?: string; followUp?: boolean; reasoningEffort?: 'high' } = {},
    ) {
      const sessionId = options.sessionId ?? 's';
      const identity = {
        expectedStoreId: storeId,
        commandId,
        content: `New task ${commandId}`,
        ...(modelId ? { modelId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      };
      if (options.followUp) {
        const session = (await store.getSession(sessionId))!;
        await client.followUp(sessionId, {
          ...identity,
          kind: 'input.follow_up',
          afterRunId: null,
          contextSelectionId: session.contextSelectionId,
        });
      } else await client.startRun(sessionId, { ...identity, kind: 'run.start' });
      return until(
        async () => ({
          command: await client.getCommand(commandId),
          view: await client.getView(sessionId),
        }),
        ({ command, view }) => {
          if (command.status === 'rejected') return true;
          const receipt = command.receipt as { runId?: string } | null;
          return (
            command.status === 'applied' &&
            view.runs.some((run) => run.id === receipt?.runId && !run.isActive)
          );
        },
      );
    },
    async close(remove = true) {
      client.disposeNetwork();
      await service.close();
      provider.stop(true);
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the first actual Run fixes only the protocol: same-family model, connection, default and effort still change', async () => {
  const f = await fixture();
  try {
    expect((await f.run('chat-first', 'chat-a')).view.runs.at(-1)?.status).toBe('completed');
    expect(
      (await f.run('chat-other', 'chat-b', { reasoningEffort: 'high' })).view.runs.at(-1)?.status,
    ).toBe('completed');
    expect(f.requests.at(-1)).toMatchObject({
      path: '/b/v1/chat/completions',
      body: { model: 'chat-second', reasoning_effort: 'high' },
    });
    f.config.modelId = 'chat-b';
    writeFileSync(f.file, JSON.stringify(f.config));
    expect((await f.run('chat-default')).view.runs.at(-1)?.status).toBe('completed');
    expect(f.requests.at(-1)!.body.model).toBe('chat-second');
    const before = f.requests.length;
    for (const followUp of [false, true]) {
      const rejected = await f.run(`wrong-protocol-${followUp}`, 'response-a', { followUp });
      expect(rejected.command).toMatchObject({
        status: 'rejected',
        receipt: { reason: 'session_model_protocol_locked' },
      });
      expect(rejected.view.runs).toHaveLength(3);
      expect(f.requests).toHaveLength(before);
    }
    expect(f.credentialReads).toBe(0);
    await f.createSession('responses');
    expect(
      (await f.run('responses-first', 'response-a', { sessionId: 'responses' })).view.runs.at(-1)
        ?.status,
    ).toBe('completed');
    expect(
      (await f.run('responses-other', 'response-b', { sessionId: 'responses' })).view.runs.at(-1)
        ?.status,
    ).toBe('completed');
    expect(f.requests.at(-1)).toMatchObject({
      path: '/b/v1/responses',
      body: { model: 'response-second' },
    });
    expect(
      (await f.run('responses-wrong', 'chat-a', { sessionId: 'responses' })).command,
    ).toMatchObject({ status: 'rejected', receipt: { reason: 'session_model_protocol_locked' } });
  } finally {
    await f.close();
  }
});

test('preparation rejection creates no protocol lock and cold SQLite history prevents a protocol mutation or default fallback', async () => {
  let f = await fixture();
  try {
    const rejected = await f.run('before-first', 'missing');
    expect(rejected.command.status).toBe('rejected');
    expect(rejected.view.runs).toHaveLength(0);
    expect((await f.run('responses-first', 'response-a')).view.runs.at(-1)?.status).toBe(
      'completed',
    );
    const first = (await f.store.getView('s')).runs[0]!;
    const originalCommand = (await f.store.getCommand(first.originCommandId))!;
    const root = f.root;
    await f.close(false);
    f = await fixture(root);
    f.config.modelId = 'chat-a';
    writeFileSync(f.file, JSON.stringify(f.config));
    expect((await f.run('cold-default')).command).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'session_model_protocol_locked' },
    });
    expect(
      (await f.run('cold-responses', 'response-b', { followUp: true })).view.runs.at(-1)?.status,
    ).toBe('completed');
    expect(f.requests).toHaveLength(1);
    const selected = f.config.models.find((model) => model.id === 'response-a')!;
    selected.protocol = 'chat-completions';
    writeFileSync(f.file, JSON.stringify(f.config));
    expect((await f.run('same-id-new-protocol', 'response-a')).command).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'session_model_protocol_locked' },
    });
    const currentSession = (await f.store.getSession('s'))!;
    const currentWorkspace = (await f.store.getWorkspace('w'))!;
    let recoveryError: unknown;
    try {
      await f.host.resolveRecoveryRunConfiguration!({
        command: originalCommand,
        run: first,
        session: currentSession,
        workspace: currentWorkspace,
        signal: new AbortController().signal,
      });
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toMatchObject({ code: 'session_model_protocol_locked' });
    expect(f.requests).toHaveLength(1);
    expect((await f.store.getView('s')).runs[0]!.configuration).toEqual(first.configuration);
  } finally {
    await f.close();
  }
}, 15000);

test('sealed protocol extraction handles processing wrappers and Codex defaults, and never completes invalid history from current settings', () => {
  const manifest = (provider: string, protocol?: 'responses' | 'chat-completions') => ({
    modelId: 'original',
    snapshot: createConfigurationSnapshot({
      modelId: 'original',
      models: [
        {
          id: 'original',
          provider,
          model: 'first',
          baseURL: 'https://fixture.invalid/v1',
          ...(protocol ? { protocol } : {}),
        },
      ],
    }) as unknown as JsonObject,
  });
  expect(runModelProtocol({ configuration: manifest('codex') })).toBe('responses');
  expect(runModelProtocol({ configuration: manifest('compatible') })).toBe('chat-completions');
  const original = manifest('openai', 'responses');
  expect(
    runModelProtocol({
      configuration: {
        modelId: original.modelId,
        snapshot: { kind: 'human_input_processing', originalConfiguration: original.snapshot },
      },
    }),
  ).toBe('responses');
  for (const configuration of [
    null,
    {},
    { ...original, modelId: 'missing' },
    { ...original, snapshot: { ...original.snapshot, digest: 'changed' } },
  ])
    expect(() => runModelProtocol({ configuration })).toThrow('session_model_protocol_unavailable');
});

test('a failed Provider attempt still belongs to the first actual Run and keeps its protocol', async () => {
  const f = await fixture();
  try {
    f.rejectNextRequest();
    const failed = await f.run('first-model-rejected', 'chat-a');
    expect(failed.view.runs).toHaveLength(1);
    expect(failed.view.runs[0]?.status).toBe('failed');
    const blocked = await f.run('other-protocol-after-failure', 'response-a');
    expect(blocked.command).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'session_model_protocol_locked' },
    });
    expect(blocked.view.runs).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
