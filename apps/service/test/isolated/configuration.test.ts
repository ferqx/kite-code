import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  type JsonObject,
} from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import {
  defaultConfiguration,
  ordinaryHostConfigurationDefaults,
} from '../../src/configuration-defaults';
import { launchPairedService } from '../../src/paired';
import { ownedUserConfiguration } from '../fixtures/user-configuration-fixture';

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
  privateDirectory(profile.profilePath);
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
  return {
    root,
    workspace,
    profile,
    file: userConfiguration.path,
    spawnChild: userConfiguration.spawnChild,
    projectFile: join(workspace, 'kite-agent.jsonc'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('ordinary host defaults select only available Shell and Task capabilities and preserve minimal embedding defaults', () => {
  expect(defaultConfiguration.tools).toEqual([{ id: 'ask_user' }]);
  const unavailable = ordinaryHostConfigurationDefaults(false, false).tools.map((tool) => tool.id);
  expect(unavailable).toContain('files.read');
  expect(unavailable.some((id) => id.startsWith('shell.'))).toBe(false);
  expect(unavailable.some((id) => id.startsWith('task.'))).toBe(false);
  const available = ordinaryHostConfigurationDefaults(true, true).tools.map((tool) => tool.id);
  expect(available.filter((id) => id.startsWith('shell.'))).toEqual([
    'shell.execute',
    'shell.launch',
    'shell.read',
    'shell.wait',
    'shell.stop',
  ]);
  expect(available.filter((id) => id.startsWith('task.'))).toEqual([
    'task.spawn',
    'task.message',
    'task.follow_up',
    'task.events',
    'task.list',
    'task.interrupt',
  ]);
  const taskOnly = ordinaryHostConfigurationDefaults(false, true).tools.map((tool) => tool.id);
  expect(taskOnly.some((id) => id.startsWith('shell.'))).toBe(false);
  expect(taskOnly.filter((id) => id.startsWith('task.'))).toHaveLength(6);
  const shellOnly = ordinaryHostConfigurationDefaults(true, false).tools.map((tool) => tool.id);
  expect(shellOnly.some((id) => id.startsWith('task.'))).toBe(false);
  expect(shellOnly.filter((id) => id.startsWith('shell.'))).toHaveLength(5);
});

test('ordinary paired host exposes public file schemas, edits with an exact baseline, preserves internal execution inputs, and respects explicit disable', async () => {
  const f = fixture();
  const marker = 'owned fresh-profile project source';
  writeFileSync(join(f.workspace, 'source.txt'), marker);
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      if (!Array.isArray(body.tools)) {
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'title', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk({ content: 'Project read' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      requests.push(body);
      const tools = body.tools as {
        function: { name: string; parameters: { properties: Record<string, unknown> } };
      }[];
      const history = body.messages as { tool_calls?: { function: { name: string } }[] }[];
      const names = [
        ...tools.map((tool) => tool.function.name),
        ...history.flatMap((message) =>
          (message.tool_calls ?? []).map((tool) => tool.function.name),
        ),
      ];
      if (names.some((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name)))
        return Response.json({ error: { message: 'invalid function name' } }, { status: 400 });
      const readTool = tools.find((tool) => tool.function.parameters.properties.start_line);
      const call = requests.length <= 2;
      const edit = requests.length === 2;
      const priorResult = edit
        ? (JSON.parse(
            String(
              (body.messages as { role: string; content: unknown }[]).find(
                (message) => message.role === 'tool',
              )!.content,
            ),
          ) as { baseline: unknown })
        : undefined;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'fresh-host', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'read-source',
                    type: 'function',
                    function: {
                      name: edit ? 'edit_file' : readTool!.function.name,
                      arguments: JSON.stringify(
                        edit
                          ? {
                              path: 'source.txt',
                              base: priorResult!.baseline,
                              old_text: 'owned',
                              new_text: 'verified',
                              expected_matches: 1,
                            }
                          : { path: 'source.txt', start_line: 1, max_lines: 200 },
                      ),
                    },
                  },
                ],
              }
            : { content: 'Project read completed' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const config = { modelId: 'local', models: [model('local', provider.url.href)] };
    writeFileSync(f.file, JSON.stringify(config));
    child = await launch(f);
    const trust = await child.handle.client.getWorkspaceTrust('workspace', {
      storeId: child.storeId,
    });
    await child.handle.client.setWorkspaceTrust('workspace', {
      expectedStoreId: child.storeId,
      commandId: 'trust-fresh-host',
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      trusted: true,
      ifRevision: trust.revision,
    });
    expect(await child.run('read-project')).toMatchObject({ status: 'applied' });
    const pending = await until(
      () =>
        child!.handle.client.listInteractions('session', {
          storeId: child!.storeId,
          state: 'pending',
        }),
      (page) => page.interactions.some((card) => card.definitionId === 'files.edit'),
    );
    const approval = pending.interactions.find((card) => card.definitionId === 'files.edit')!;
    expect(approval.request).toMatchObject({
      definitionId: 'files.edit',
      definitionVersion: '2',
      input: { path: 'source.txt', find: 'owned', replace: 'verified', occurrences: 1 },
    });
    await child.handle.client.answerInteraction('session', approval.id, {
      expectedStoreId: child.storeId,
      commandId: 'approve-file-edit',
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const view = await child.finished('read-project');
    expect(view.commandRun.status).toBe('completed');
    expect(requests).toHaveLength(3);
    reader = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    const executions = await reader.listExecutions('session');
    const read = executions.find((row) => row.definitionId === 'files.read')!;
    const edit = executions.find((row) => row.definitionId === 'files.edit')!;
    expect(read.input).toEqual({ path: 'source.txt', offset: 1, limit: 200 });
    expect(edit.status).toBe('succeeded');
    expect(readFileSync(join(f.workspace, 'source.txt'), 'utf8')).toBe(
      marker.replace('owned', 'verified'),
    );
    expect(edit.input).toMatchObject({
      path: 'source.txt',
      find: 'owned',
      replace: 'verified',
      occurrences: 1,
    });
    expect((edit.input as Record<string, unknown>).base).toEqual(
      JSON.parse(
        String(
          (requests[1]!.messages as { role: string; content: unknown }[]).find(
            (message) => message.role === 'tool',
          )!.content,
        ),
      ).baseline,
    );
    const history = requests[2]!.messages as {
      role: string;
      tool_calls?: { function: { name: string; arguments: string } }[];
    }[];
    const calls = history.flatMap((message) => message.tool_calls ?? []);
    expect(calls.map((call) => call.function.name)).toEqual(['read_file', 'edit_file']);
    expect(JSON.parse(calls[1]!.function.arguments)).toMatchObject({
      old_text: 'owned',
      new_text: 'verified',
      expected_matches: 1,
    });
    const names = (requests[0]!.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    expect(names).toHaveLength(14);
    expect(names).toEqual(
      expect.arrayContaining([
        'ask_user',
        'web_fetch',
        'spawn_agent',
        'send_agent_message',
        'follow_up_agent',
        'wait_agent_events',
        'list_agents',
        'interrupt_agent',
      ]),
    );
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(14);
    expect(JSON.stringify(requests[1]!.messages)).toContain(marker);
    expect(
      (
        await child.handle.client.listInteractions('session', {
          storeId: child.storeId,
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
    expect(existsSync(f.projectFile)).toBe(false);

    writeFileSync(
      f.file,
      JSON.stringify({
        ...config,
        tools: [
          { id: 'files.read', enabled: false },
          { id: 'web_fetch', remove: true },
          { id: 'task.spawn', enabled: false },
          { id: 'task.message', remove: true },
        ],
      }),
    );
    expect(await child.run('disabled-tools')).toMatchObject({ status: 'applied' });
    await child.finished('disabled-tools');
    const nextNames = (requests.at(-1)!.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    const nextTools = requests.at(-1)!.tools as {
      function: { parameters: { properties: Record<string, unknown> } };
    }[];
    expect(nextTools.some((tool) => tool.function.parameters.properties.start_line)).toBe(false);
    expect(nextNames).not.toContain('web_fetch');
    expect(nextNames).not.toContain('spawn_agent');
    expect(nextNames).not.toContain('send_agent_message');
    expect(nextNames).toEqual(
      expect.arrayContaining([
        'follow_up_agent',
        'wait_agent_events',
        'list_agents',
        'interrupt_agent',
      ]),
    );
    expect(nextTools.some((tool) => tool.function.parameters.properties.text)).toBe(true);
  } finally {
    await reader?.close();
    await child?.handle.close();
    provider.stop(true);
    f.close();
  }
}, 15000);
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
    spawnChild: f.spawnChild,
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
      rootUri: pathToFileURL(f.workspace).href,
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
        // Each configuration probe deliberately starts independent work.
        content: 'New task: Harmless test',
        ...(modelId ? { modelId } : {}),
      });
      return until(
        () => handle.client.getCommand(commandId),
        (command) => command.status === 'rejected' || command.status === 'applied',
      );
    },
    async finished(commandId: string) {
      const completed = await until(
        async () => ({
          command: await handle.client.getCommand(commandId),
          view: await handle.client.getView('session'),
        }),
        ({ command, view }) => {
          const receipt = command.receipt as { runId?: string } | null;
          return (
            command.status === 'applied' &&
            typeof receipt?.runId === 'string' &&
            view.runs.some((run) => run.id === receipt.runId && !run.isActive)
          );
        },
      );
      const receipt = completed.command.receipt as { runId: string; businessCommandId?: string };
      const commandRun = completed.view.runs.find((run) => run.id === receipt.runId)!;
      expect(commandRun.originCommandId).toBe(receipt.businessCommandId ?? commandId);
      return { ...completed.view, commandRun };
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
      content: 'New task: New configured request',
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

test('per-Run trusted explicit options override user models while project models are ignored in actual Provider input', async () => {
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
    // Both sides use the same explicit embedded host; ordinary process hosts
    // additionally select native tools and require their exact assets on recovery.
    child = await launch(f, true);
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
      userConfigurationPath: f.file,
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

test('user provider Responses protocol reaches the real runtime endpoint and never falls back on failure', async () => {
  const f = fixture();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  writeFileSync(join(f.workspace, 'responses-source.txt'), 'Responses tool result marker');
  const event = (type: string, value: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
      });
      if (fail) return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
      if (requests.length === 1) {
        const reasoning = {
          type: 'reasoning',
          id: 'rs_service',
          encrypted_content: 'owned-encrypted-reasoning',
        };
        const call = {
          type: 'function_call',
          id: 'fc_service',
          call_id: 'call_service',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'responses-source.txt' }),
          status: 'completed',
        };
        return new Response(
          event('response.created', {
            response: { id: 'resp_tool', created_at: 1, model: 'same-name' },
          }) +
            event('response.output_item.added', { output_index: 0, item: reasoning }) +
            event('response.reasoning_summary_text.delta', {
              item_id: reasoning.id,
              summary_index: 0,
              delta: 'Read file',
            }) +
            event('response.output_item.done', { output_index: 0, item: reasoning }) +
            event('response.output_item.added', {
              output_index: 1,
              item: { ...call, arguments: '' },
            }) +
            event('response.function_call_arguments.delta', {
              output_index: 1,
              item_id: call.id,
              delta: call.arguments,
            }) +
            event('response.output_item.done', { output_index: 1, item: call }) +
            event('response.completed', {
              response: { usage: { input_tokens: 5, output_tokens: 3 } },
            }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        event('response.created', {
          response: { id: 'resp_service', created_at: 1, model: 'same-name' },
        }) +
          event('response.output_item.added', {
            output_index: 0,
            item: { type: 'message', id: 'msg_service' },
          }) +
          event('response.output_text.delta', {
            item_id: 'msg_service',
            delta: 'Responses configured',
          }) +
          event('response.output_item.done', {
            output_index: 0,
            item: { type: 'message', id: 'msg_service' },
          }) +
          event('response.completed', {
            response: { usage: { input_tokens: 5, output_tokens: 3 } },
          }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        provider: {
          local: {
            type: 'openai-compatible',
            protocol: 'responses',
            baseURL: `${provider.url.href}v1`,
            models: ['same-name'],
          },
        },
        model: 'local:same-name',
      }),
    );
    child = await launch(f);
    const trust = await child.handle.client.getWorkspaceTrust('workspace', {
      storeId: child.storeId,
    });
    await child.handle.client.setWorkspaceTrust('workspace', {
      expectedStoreId: child.storeId,
      commandId: 'trust-responses-workspace',
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      trusted: true,
      ifRevision: trust.revision,
    });
    expect(await child.run('responses-success')).toMatchObject({ status: 'applied' });
    const view = await child.finished('responses-success');
    expect(view.commandRun.status).toBe('completed');
    expect(requests.map((request) => request.path)).toEqual(['/v1/responses', '/v1/responses']);
    expect(requests[1]!.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          id: 'rs_service',
          encrypted_content: 'owned-encrypted-reasoning',
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_service',
          name: 'read_file',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_service',
          output: expect.stringContaining('Responses tool result marker'),
        }),
      ]),
    );
    expect(requests[1]!.body.previous_response_id).toBeUndefined();
    expect(requests[0]!.body).toMatchObject({ model: 'same-name', store: false });
    expect(requests[0]!.body.input).toBeArray();
    const inputs = await child.handle.client.listModelInputs('session');
    expect(inputs.items).toHaveLength(2);
    // Exercise the real client schema + canonical body hash verifier after redaction.
    const inspected = await child.handle.client.getModelInput(
      'session',
      inputs.items.at(-1)!.executionId,
    );
    expect(inspected.request.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(JSON.stringify(inspected)).not.toContain('owned-encrypted-reasoning');
    fail = true;
    expect(await child.run('responses-failure')).toMatchObject({ status: 'applied' });
    const failed = await child.finished('responses-failure');
    expect(failed.commandRun.status).toBe('failed');
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/responses',
      '/v1/responses',
      '/v1/responses',
    ]);
  } finally {
    await child?.handle.close();
    provider.stop(true);
    f.close();
  }
}, 15000);
