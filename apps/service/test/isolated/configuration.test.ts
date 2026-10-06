import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  type JsonObject,
} from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { launchPairedService } from '../../src/paired';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T>, condition: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (condition(value)) return value;
    if (Date.now() >= deadline) throw new Error('configuration_test_deadline');
    await Bun.sleep(5);
  }
}
function fakeEndpoint(gated = false, emitToolCall = false) {
  const entered = gate();
  const release = gate();
  const requests: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const chunk = (model: string, delta: unknown, reason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ body, authorization: request.headers.get('authorization') });
      const model = String(body.model);
      const pause = gated && requests.length === 1;
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
            try {
              const call = emitToolCall && requests.length === 1;
              send(
                chunk(
                  model,
                  call
                    ? {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: 0,
                            id: 'same-name',
                            type: 'function',
                            function: { name: 'a', arguments: '{}' },
                          },
                        ],
                      }
                    : { role: 'assistant', content: `selected:${model}` },
                ),
              );
              entered.resolve();
              if (pause) await release.promise;
              send(chunk(model, {}, call ? 'tool_calls' : 'stop'));
              send('data: [DONE]\n\n');
              controller.close();
            } catch {
              /* The client can cancel the concrete network request. */
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    entered,
    release,
    close() {
      release.resolve();
      server.stop(true);
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-default-config-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  return {
    root,
    workspace,
    profile,
    file: join(profile.profilePath, 'config.jsonc'),
    projectFile: join(workspace, 'kite-agent.jsonc'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const model = (id: string, baseURL: string, extras: JsonObject = {}) => ({
  id,
  provider: 'compatible',
  model: `remote-${id}`,
  baseURL,
  ...extras,
});
async function launch(
  f: ReturnType<typeof fixture>,
  injected = false,
  hostConfiguration?: JsonObject,
) {
  const handle = await launchPairedService({
    entrypoint: join(
      import.meta.dir,
      injected ? '../fixtures/configured-child.ts' : '../../src/main.ts',
    ),
    profile: f.profile,
    instanceId: 'configured',
    buildId: 'configuration-test',
    apiMajor: 1,
    requiredCapabilities: ['commands', 'history'],
    hostConfiguration,
  });
  const storeId = handle.client.serverInfo!.storeId!;
  try {
    await handle.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: `file://${f.workspace}`,
      name: 'Configured',
    });
    await handle.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Configured',
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    handle,
    storeId,
    async run(commandId: string, modelId?: string) {
      await handle.client.startRun('session', {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content: 'Harmless test',
        ...(modelId ? { modelId } : {}),
      });
      return until(
        () => handle.client.getCommand(commandId),
        (command) => command.status === 'rejected' || command.status === 'applied',
      );
    },
    async finished(commandId: string) {
      return until(
        () => handle.client.getView('session'),
        (view) => view.runs.some((run) => run.originCommandId === commandId && !run.isActive),
      );
    },
  };
}

test('actual paired production Service binds per-Run route/options and immutable persisted snapshots while an old stream continues', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint(true);
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [
          model('a', endpoint.baseURL, {
            options: { temperature: 0.1, topP: 0.8, maxOutputTokens: 17, reasoningEffort: 'low' },
          }),
          model('b', endpoint.baseURL, { options: { temperature: 0.5 } }),
        ],
      }),
    );
    child = await launch(f);
    reader = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    expect(await child.run('old')).toMatchObject({ status: 'applied' });
    await until(
      () => Promise.resolve(endpoint.requests.length),
      (count) => count === 1,
    );
    await endpoint.entered.promise;
    const oldRun = (await reader.getView('session')).runs[0]!;
    const snapshotBefore = JSON.stringify(oldRun.configuration);
    expect(endpoint.requests[0]!.body).toMatchObject({
      model: 'remote-a',
      temperature: 0.1,
      top_p: 0.8,
      max_tokens: 17,
      reasoning_effort: 'low',
    });
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'b',
        models: [
          model('b', endpoint.baseURL, {
            options: { temperature: 0.75, topP: 0.4, maxOutputTokens: 23, reasoningEffort: 'high' },
          }),
        ],
      }),
    );
    await child.handle.client.startRun('session', {
      expectedStoreId: child.storeId,
      commandId: 'new',
      kind: 'run.start',
      content: 'New configured request',
    });
    expect(endpoint.requests).toHaveLength(1);
    endpoint.release.resolve();
    await child.finished('old');
    await child.finished('new');
    expect(endpoint.requests.map((request) => request.body.model)).toEqual([
      'remote-a',
      'remote-b',
    ]);
    expect(endpoint.requests[1]!.body).toMatchObject({
      temperature: 0.75,
      top_p: 0.4,
      max_tokens: 23,
      reasoning_effort: 'high',
    });
    expect(JSON.stringify((await reader.getRun(oldRun.id))!.configuration)).toBe(snapshotBefore);
    const runs = (await reader.getView('session')).runs;
    expect(runs[0]!.configuration).toMatchObject({
      modelId: 'a',
      snapshot: {
        configuration: {
          models: expect.arrayContaining([
            expect.objectContaining({
              id: 'a',
              provider: 'compatible',
              model: 'remote-a',
              options: { temperature: 0.1, topP: 0.8, maxOutputTokens: 17, reasoningEffort: 'low' },
            }),
          ]),
        },
      },
    });
    expect(runs[1]!.configuration).toMatchObject({ modelId: 'b' });
    expect(JSON.stringify(runs[1]!.configuration)).not.toBe(snapshotBefore);
    const calls = await child.handle.client.listModelInputs('session');
    expect(calls.items).toHaveLength(2);
    for (const call of calls.items) {
      const recorded = await child.handle.client.getModelInput('session', call.executionId);
      expect(recorded.confirmation).toBe('succeeded');
      expect(recorded.metadata).toMatchObject({
        adapter: {
          availability: 'available',
          settings: {
            reasoningEffort: recorded.request.modelId === 'a' ? 'low' : 'high',
          },
        },
      });
    }
    expect(endpoint.requests).toHaveLength(2);
  } finally {
    endpoint.close();
    await reader?.close();
    await child?.handle.close();
    f.close();
  }
}, 20000);

test('per-Run user/project/explicit precedence is actual Provider input rather than a recorded-only option', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint();
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [
          model('a', endpoint.baseURL, { options: { temperature: 0.1, maxOutputTokens: 11 } }),
        ],
      }),
    );
    writeFileSync(
      f.projectFile,
      JSON.stringify({ models: [{ id: 'a', options: { temperature: 0.2, topP: 0.3 } }] }),
    );
    child = await launch(f, false, {
      configuration: {
        models: [{ id: 'a', options: { temperature: 0.4, topP: 0.6, maxOutputTokens: 19 } }],
      },
    });
    await child.run('layers');
    await child.finished('layers');
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]!.body).toMatchObject({
      model: 'remote-a',
      temperature: 0.4,
      top_p: 0.6,
      max_tokens: 19,
    });
  } finally {
    endpoint.close();
    await child?.handle.close();
    f.close();
  }
}, 15000);

test('missing/bad/disabled/unknown/unsupported model configuration rejects only that Run without bootstrap/history/cancel fallback', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint();
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    child = await launch(f);
    expect(child.handle.bootstrap.dataAvailability).toBe('available');
    expect(await child.run('absent')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'model_unavailable' },
    });
    writeFileSync(f.file, '{ malformed');
    expect(await child.run('broken')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'invalid_jsonc' },
    });
    expect((await child.handle.client.getView('session')).runs).toHaveLength(0);
    writeFileSync(
      f.file,
      JSON.stringify({ modelId: 'a', models: [model('a', endpoint.baseURL, { enabled: false })] }),
    );
    expect(await child.run('disabled')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'model_unavailable' },
    });
    writeFileSync(f.file, JSON.stringify({ modelId: 'a', models: [model('a', endpoint.baseURL)] }));
    expect(await child.run('unknown', 'not-registered')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'model_unavailable' },
    });
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [model('a', endpoint.baseURL, { options: { arbitraryProviderOption: true } })],
      }),
    );
    expect(await child.run('unsupported')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'unsupported_model_options' },
    });
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [
          model('a', endpoint.baseURL, {
            options: { reasoningEffort: 'unrecognized' },
          }),
        ],
      }),
    );
    expect(await child.run('invalid-effort')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'invalid_model_options' },
    });
    expect(endpoint.requests).toHaveLength(0);
    expect((await child.handle.client.getView('session')).executions).toHaveLength(0);
    const cancelled = await child.handle.client.cancelCommand('session', {
      expectedStoreId: child.storeId,
      commandId: 'cancel-broken',
      kind: 'command.cancel',
      targetCommandId: 'broken',
    });
    expect(cancelled.status).toBe('applied');
    writeFileSync(f.file, JSON.stringify({ modelId: 'a', models: [model('a', endpoint.baseURL)] }));
    await child.run('repaired');
    await child.finished('repaired');
    expect(endpoint.requests).toHaveLength(1);
  } finally {
    endpoint.close();
    await child?.handle.close();
    f.close();
  }
}, 20000);

test('explicit temporary credentials remain private and a lost reference refuses a new Run while history and cancellation stay available', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint(true);
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const ref = 'credential:11111111-1111-4111-8111-111111111111';
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [model('a', endpoint.baseURL, { credentialRef: ref })],
      }),
    );
    child = await launch(f, true);
    await child.run('credential-ok');
    await endpoint.entered.promise;
    expect(endpoint.requests[0]!.authorization).toBe('Bearer local-fixture-secret');
    expect(JSON.stringify(await child.handle.client.getView('session'))).not.toContain(
      'local-fixture-secret',
    );
    const lost = await createCredentialVault({ backend: createTemporaryCredentialBackend() }).put(
      'parent-only-credential',
    );
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [model('a', endpoint.baseURL, { credentialRef: lost.id })],
      }),
    );
    await child.handle.client.cancelCommand('session', {
      expectedStoreId: child.storeId,
      commandId: 'cancel-live-with-lost-config',
      kind: 'command.cancel',
      targetCommandId: 'credential-ok',
    });
    const stopped = await child.finished('credential-ok');
    expect(stopped.runs[0]!.status).toBe('cancelled');
    expect(await child.run('lost')).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'credential_unavailable' },
    });
    expect((await child.handle.client.getView('session')).runs).toHaveLength(1);
    expect(endpoint.requests).toHaveLength(1);
    expect(JSON.stringify(child.handle.diagnostics)).not.toContain('local-fixture-secret');
    await child.handle.client.cancelCommand('session', {
      expectedStoreId: child.storeId,
      commandId: 'cancel-lost',
      kind: 'command.cancel',
      targetCommandId: 'lost',
    });
  } finally {
    endpoint.close();
    await child?.handle.close();
    f.close();
  }
}, 20000);

test('default permissions admit Model kind and deny an actual registered Tool with the same model id spelling', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint(false, true);
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        modelId: 'a',
        models: [model('a', endpoint.baseURL)],
        tools: [{ id: 'a', enabled: true }],
      }),
    );
    child = await launch(f, true);
    await child.run('typed-auth');
    await child.finished('typed-auth');
    reader = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    const view = await reader.getView('session');
    expect(endpoint.requests).toHaveLength(2);
    expect(view.runs[0]!.status).toBe('completed');
    expect(view.executions.find((execution) => execution.kind === 'tool')).toMatchObject({
      definitionId: 'a',
      status: 'failed',
      result: { details: { code: 'permission_denied', adapterAttempted: false } },
    });
    expect(existsSync(join(f.profile.profilePath, 'tool-ledger'))).toBe(false);
  } finally {
    endpoint.close();
    await reader?.close();
    await child?.handle.close();
    f.close();
  }
}, 15000);

test('explicit recovery resolver preserves the persisted model selection and refuses changed configuration before credentials or Provider', async () => {
  const f = fixture();
  const endpoint = fakeEndpoint();
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let recoveryRuntime: ReturnType<typeof createRuntime> | undefined;
  let binding:
    | Awaited<
        ReturnType<
          NonNullable<
            ReturnType<typeof createDefaultProcessConfiguration>['resolveRecoveryRunConfiguration']
          >
        >
      >
    | undefined;
  let credentialReads = 0;
  const original = {
    modelId: 'a',
    models: [model('a', endpoint.baseURL), model('b', endpoint.baseURL)],
  };
  try {
    writeFileSync(f.file, JSON.stringify(original));
    child = await launch(f);
    await child.run('original-recovery-source');
    await child.finished('original-recovery-source');
    await child.handle.close();
    child = undefined;
    reader = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    const run = (await reader.getView('session')).runs[0]!;
    const command = (await reader.getCommand(run.originCommandId))!;
    const session = (await reader.getSession(run.sessionId))!;
    const workspace = (await reader.getWorkspace(session.workspaceId))!;
    expect(run.status).toBe('completed');
    expect(endpoint.requests).toHaveLength(1);
    const host = createDefaultProcessConfiguration({
      profile: f.profile,
      credentialBackend: {
        kind: 'temporary',
        put: async () => {},
        remove: async () => {},
        resolve: async () => {
          credentialReads++;
          return 'fixture-secret';
        },
      },
    });
    // Reproduce source provenance against the actual cold Store, as the process assembler does.
    recoveryRuntime = createRuntime({ store: reader, permissions: host.permissions! });
    host.permissionManagement?.(recoveryRuntime);
    const input = { run, command, session, workspace, signal: new AbortController().signal };
    writeFileSync(f.file, JSON.stringify({ ...original, modelId: 'b' }));
    binding = await host.resolveRecoveryRunConfiguration!(input);
    expect(binding.modelId).toBe('a');
    const saved = run.configuration as { snapshot: { digest: string; skillSelection: unknown } };
    expect(binding.snapshot).toMatchObject({
      digest: saved.snapshot.digest,
      skillSelection: saved.snapshot.skillSelection,
      planning: {
        binding: {
          readOnlyDefinitions: expect.arrayContaining([
            { kind: 'tool', definitionId: 'ask_user', definitionVersion: '1' },
          ]),
          tools: expect.arrayContaining([
            {
              extensionId: 'builtin.ask-user',
              extensionVersion: '1',
              definitionId: 'ask_user',
              definitionVersion: '1',
            },
          ]),
        },
      },
    });
    expect(endpoint.requests).toHaveLength(1);
    expect(credentialReads).toBe(0);
    await binding.dispose?.();
    binding = undefined;
    writeFileSync(
      f.file,
      JSON.stringify({
        ...original,
        models: [
          model('a', endpoint.baseURL, {
            credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
            options: { reasoningEffort: 'high' },
          }),
          model('b', endpoint.baseURL),
        ],
      }),
    );
    await expect(host.resolveRecoveryRunConfiguration!(input)).rejects.toMatchObject({
      code: 'recovery_configuration_changed',
    });
    expect(credentialReads).toBe(0);
    expect(endpoint.requests).toHaveLength(1);
    writeFileSync(f.file, JSON.stringify(original));
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      host.resolveRecoveryRunConfiguration!({ ...input, signal: aborted.signal }),
    ).rejects.toBeDefined();
    expect(endpoint.requests).toHaveLength(1);
    expect(credentialReads).toBe(0);
  } finally {
    await binding?.dispose?.();
    if (recoveryRuntime) await recoveryRuntime.close();
    else await reader?.close();
    await child?.handle.close();
    endpoint.close();
    f.close();
  }
}, 15000);
