import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { CommandRequest } from '@kite-ai/agent/storage';
import {
  createClient,
  type FollowUpCommandRequest,
  type StartCommandRequest,
} from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const result = await read();
    if (ready(result)) return result;
    if (Date.now() >= deadline) throw new Error('run_model_selection_deadline');
    await Bun.sleep(5);
  }
}
async function rejectsCode(work: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}
async function fixture(delegateChild = false) {
  const root = mkdtempSync(join(tmpdir(), 'kite-run-model-selection-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path: new URL(request.url).pathname, body });
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const delegate = delegateChild && requests.length === 1;
      const delta = delegate
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'delegate',
                type: 'function',
                function: { name: 'fixture.delegate', arguments: '{}' },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
      return new Response(
        `${chunk(delta)}${chunk({}, delegate ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const models = ['compatible', 'openai', 'deepseek', 'ollama'].map((family) => ({
    id: family === 'compatible' ? 'a' : family,
    provider: family,
    model: `actual-${family}`,
    baseURL: `http://127.0.0.1:${provider.port}/${family}/v1`,
    ...(family === 'openai' ? { options: { reasoningEffort: 'low' } } : {}),
  }));
  const config = { modelId: 'a', models, tools: delegateChild ? [{ id: 'fixture.delegate' }] : [] };
  const file = join(profile.profilePath, 'config.jsonc');
  writeFileSync(file, JSON.stringify(config));
  let credentialReads = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    knownToolIds: ['fixture.delegate'],
    credentialBackend: {
      kind: 'temporary',
      put: async () => {},
      remove: async () => {},
      resolve: async () => {
        credentialReads++;
        return 'fixture';
      },
    },
    permissions: { authorize: async () => ({ allowed: true, revision: 'trusted-fixture' }) },
    child: [{ id: 'worker', version: '1', modelId: 'openai', toolIds: [] }],
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const delegate: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.delegate',
        version: '1',
        description: 'Trusted fixture delegation',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'child',
            request: { kind: 'agent', configurationId: 'worker', input: { content: 'child' } },
            cancellation: 'detached',
          });
          return { outcome: 'succeeded', content: JSON.stringify(ref) };
        },
      },
    ],
  };
  const runtime = createRuntime({
    ...host,
    store,
    permissions: host.permissions!,
    extensions: [...host.extensions!, ...(delegateChild ? [delegate] : [])],
  });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'fixture' });
  const service = await startService({
    runtime,
    subjectId: base.subjectId,
    buildId: 'run-model-selection',
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
  return {
    root,
    file,
    config,
    host,
    store,
    runtime,
    requests,
    base,
    get credentialReads() {
      return credentialReads;
    },
    async submit(
      commandId: string,
      request:
        | Omit<StartCommandRequest, 'expectedStoreId' | 'commandId'>
        | Omit<FollowUpCommandRequest, 'expectedStoreId' | 'commandId'>,
    ) {
      const identity = { expectedStoreId, commandId };
      if (request.kind === 'run.start')
        await client.startRun(base.sessionId, { ...request, ...identity });
      else await client.followUp(base.sessionId, { ...request, ...identity });
      return until(
        () => store.getView('s'),
        (view) => view.runs.some((run) => run.originCommandId === commandId && !run.isActive),
      );
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('explicit per-Run model chooses its actual provider route and name while default selection stays unchanged', async () => {
  const f = await fixture();
  try {
    for (const family of ['openai', 'deepseek', 'ollama']) {
      await f.submit(family, { kind: 'run.start', content: 'hello', modelId: family });
      const executions = await f.store.listExecutions('s');
      const execution = executions.at(-1)!;
      const input = await f.store.getModelInputSnapshot({ ...f.base, executionId: execution.id });
      expect(input.metadata).toMatchObject({
        adapter: { provider: { family, modelId: `actual-${family}` } },
      });
      expect(f.requests.at(-1)).toMatchObject({
        path: `/${family}/v1/chat/completions`,
        body: { model: `actual-${family}` },
      });
    }
    await f.submit('default', { kind: 'run.start', content: 'hello' });
    expect(f.requests.at(-1)).toMatchObject({
      path: '/compatible/v1/chat/completions',
      body: { model: 'actual-compatible' },
    });
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual(f.config);
  } finally {
    await f.close();
  }
}, 20000);

test('HTTP temporary effort is original command intent, frozen before digest, reproduced on recovery and absent from the next Run', async () => {
  const f = await fixture();
  let binding:
    | Awaited<ReturnType<NonNullable<typeof f.host.resolveRecoveryRunConfiguration>>>
    | undefined;
  try {
    const view = await f.submit('effort', {
      kind: 'run.start',
      content: 'hello',
      modelId: 'openai',
      reasoningEffort: 'high',
    });
    const run = view.runs[0]!;
    const command = (await f.store.getCommand('effort'))!;
    expect(command.request).toMatchObject({ reasoningEffort: 'high' });
    expect(f.requests[0]!.body).toMatchObject({ model: 'actual-openai', reasoning_effort: 'high' });
    const snapshot = run.configuration as {
      snapshot: { digest: string; configuration: { models: { id: string; options?: unknown }[] } };
    };
    expect(
      snapshot.snapshot.configuration.models.find((model) => model.id === 'openai')!.options,
    ).toEqual({ reasoningEffort: 'high' });
    const session = (await f.store.getSession('s'))!;
    const workspace = (await f.store.getWorkspace('w'))!;
    binding = await f.host.resolveRecoveryRunConfiguration!({
      command,
      run,
      session,
      workspace,
      signal: new AbortController().signal,
    });
    expect(binding.snapshot).toMatchObject({ digest: snapshot.snapshot.digest });
    await binding.dispose?.();
    binding = undefined;
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.config,
        models: f.config.models.map((model) =>
          model.id === 'openai' ? { ...model, options: { temperature: 0.5 } } : model,
        ),
      }),
    );
    await rejectsCode(
      f.host.resolveRecoveryRunConfiguration!({
        command,
        run,
        session,
        workspace,
        signal: new AbortController().signal,
      }),
      'recovery_configuration_changed',
    );
    expect(f.requests).toHaveLength(1);
    writeFileSync(f.file, JSON.stringify(f.config));
    const input = await f.store.getModelInputSnapshot({
      ...f.base,
      executionId: (await f.store.listExecutions('s'))[0]!.id,
    });
    expect(input.metadata).toMatchObject({ adapter: { settings: { reasoningEffort: 'high' } } });
    await f.submit('ordinary', { kind: 'run.start', content: 'hello', modelId: 'openai' });
    expect(f.requests[1]!.body.reasoning_effort).toBe('low');
    const current = await f.store.getSession('s');
    await f.submit('follow', {
      kind: 'input.follow_up',
      content: 'hello',
      modelId: 'openai',
      reasoningEffort: 'minimal',
      afterRunId: null,
      contextSelectionId: current!.contextSelectionId,
    });
    expect(f.requests[2]!.body.reasoning_effort).toBe('minimal');
    expect((await f.store.getCommand('follow'))!.request).toMatchObject({
      reasoningEffort: 'minimal',
    });
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual(f.config);
  } finally {
    await binding?.dispose?.();
    await f.close();
  }
}, 20000);

test('invalid intent and unsupported effort reject before credentials and network', async () => {
  const f = await fixture();
  try {
    await rejectsCode(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'invalid',
        request: {
          kind: 'run.start',
          content: 'hello',
          reasoningEffort: 'extreme',
        } as unknown as CommandRequest,
      }),
      'invalid_input_request',
    );
    await rejectsCode(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'steer',
        request: {
          kind: 'input.steer',
          content: 'hello',
          targetRunId: 'r',
          contextSelectionId: 'selection',
          reasoningEffort: 'high',
        } as unknown as CommandRequest,
      }),
      'invalid_input_request',
    );
    f.config.models.find((model) => model.id === 'deepseek')!.options = { reasoningEffort: 'low' };
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.config,
        models: f.config.models.map((model) => ({
          ...model,
          credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
        })),
      }),
    );
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'unsupported',
      request: {
        kind: 'run.start',
        content: 'hello',
        modelId: 'deepseek',
        reasoningEffort: 'high',
      },
    });
    const command = await until(
      () => f.store.getCommand('unsupported'),
      (value) => value?.status === 'rejected',
    );
    expect(command!.receipt).toMatchObject({ reason: 'model_reasoning_effort_unsupported' });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'configured-unsupported',
      request: { kind: 'run.start', content: 'hello', modelId: 'deepseek' },
    });
    const configured = await until(
      () => f.store.getCommand('configured-unsupported'),
      (value) => value?.status === 'rejected',
    );
    expect(configured!.receipt).toMatchObject({ reason: 'model_reasoning_effort_unsupported' });
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.config,
        models: f.config.models.map((model) =>
          model.id === 'openai'
            ? {
                ...model,
                reasoningSupported: false,
                credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
              }
            : model,
        ),
      }),
    );
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'model-disabled-effort',
      request: { kind: 'run.start', content: 'hello', modelId: 'openai', reasoningEffort: 'high' },
    });
    const disabled = await until(
      () => f.store.getCommand('model-disabled-effort'),
      (value) => value?.status === 'rejected',
    );
    expect(disabled!.receipt).toMatchObject({ reason: 'model_reasoning_effort_unsupported' });
    expect(f.credentialReads).toBe(0);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('new child selects its configured preset without inheriting the root temporary effort', async () => {
  const f = await fixture(true);
  try {
    await f.submit('root', {
      kind: 'run.start',
      content: 'delegate',
      modelId: 'openai',
      reasoningEffort: 'high',
    });
    const carrier = await until(
      () => f.store.listExecutions('s'),
      (rows) => rows.some((row) => row.childSessionId !== null),
    );
    const childSessionId = carrier.find((row) => row.childSessionId !== null)!.childSessionId!;
    const child = await until(
      () => f.store.getView(childSessionId),
      (view) => view.runs.some((run) => !run.isActive),
    );
    expect(child.runs[0]!.status).toBe('completed');
    const childExecution = (await f.store.listExecutions(childSessionId)).find(
      (row) => row.kind === 'model',
    )!;
    const input = await f.store.getModelInputSnapshot({
      ...f.base,
      sessionId: childSessionId,
      executionId: childExecution.id,
    });
    expect(input.metadata).toMatchObject({
      adapter: {
        provider: { family: 'openai', modelId: 'actual-openai' },
        settings: { reasoningEffort: 'low' },
      },
    });
    expect(f.requests[0]!.body.reasoning_effort).toBe('high');
    expect(f.requests.some((request) => request.body.reasoning_effort === 'low')).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);
