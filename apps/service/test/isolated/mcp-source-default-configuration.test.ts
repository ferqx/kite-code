import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { mcpSourceConnectionJobId } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';

type ToolCall = { name: string; input: Json } | null;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('default_mcp_source_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(options: { ask?: boolean; broken?: boolean; disabled?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-raw-mcp-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'owned.txt'), 'actual owned file');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const rpc: string[] = [];
  let effects = 0;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = (await request.json()) as { id?: number; method: string; params?: Json };
      if (body.id === undefined) return new Response(null, { status: 202 });
      rpc.push(body.method);
      let result: unknown;
      if (body.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        };
      else if (body.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'effect',
              description: 'Untrusted remote claim of safe read',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          ],
        };
      else {
        expect(body.method).toBe('tools/call');
        expect(body.params).toMatchObject({ name: 'effect', arguments: { value: 'exact' } });
        effects++;
        result = { content: [{ type: 'text', text: 'actual effect once' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  const source = {
    mcpServers: {
      owned: {
        type: 'http',
        url: remote.url.href,
        auth: { type: 'none' },
        unknown: { private: 'RAW_PRIVATE_TRANSPORT_VALUE' },
      },
    },
  };
  writeFileSync(sourcePath, options.broken ? '{ invalid' : JSON.stringify(source));
  const bodies: Record<string, unknown>[] = [];
  let step = 0;
  let workId = 'connect';
  let modelCredentialReads = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      const actualStep = step++;
      const tools = (body.tools ?? []) as { function: { name: string; parameters: unknown } }[];
      let call: ToolCall = null;
      if (options.broken || options.disabled) {
        if (actualStep === 0) call = { name: 'files.read', input: { path: 'owned.txt' } };
      } else if (actualStep === 0) call = { name: 'mcp.sources.list', input: {} };
      else if (actualStep === 1) {
        const safeId = JSON.stringify(body.messages).match(/mcp-[a-f0-9]{64}/)?.[0];
        expect(safeId).toBeDefined();
        call = { name: 'mcp.connect', input: { serverId: safeId!, key: `owned-${workId}` } };
      } else if (actualStep === 2) {
        const tool = tools.find((tool) => tool.function.name.startsWith('mcp.mcp-'));
        expect(tool).toBeDefined();
        call = { name: tool!.function.name, input: { value: 'exact' } };
      }
      const chunk = {
        id: `fixed-${bodies.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${bodies.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const credentialBackend = {
    kind: 'temporary' as const,
    put: async () => {},
    remove: async () => {},
    resolve: async () => {
      modelCredentialReads++;
      return 'owned-model-secret';
    },
  };
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [
        {
          id: 'local',
          provider: 'compatible',
          model: 'local',
          baseURL: `${provider.url.href}v1`,
          credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
        },
      ],
      tools: [{ id: 'files.read', definitionVersion: '3' }],
      ...(options.disabled ? { mcp: [] } : {}),
    }),
  );
  // No static server registration or programmatic transport substitutes for the default factory.
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend,
    mcpSources: { http: { allowLoopbackForTests: true } },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: options.ask ? 'ask' : 'full',
        workspaceTrust: true,
        revision: 'owned-host-policy',
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    extensions: host.extensions,
    supportsExtensionInputs: host.supportsExtensionInputs,
    resolveRunConfiguration: host.resolveRunConfiguration,
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'user',
    buildId: 'default-raw-mcp-source',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions', 'extension_queries'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'default raw source',
  });
  const f = {
    root,
    workspace,
    profile,
    client,
    runtime,
    store,
    host,
    credentialBackend,
    sourcePath,
    source,
    bodies,
    rpc,
    expectedStoreId,
    get effects() {
      return effects;
    },
    get credentialReads() {
      return modelCredentialReads;
    },
    async query() {
      return (await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!
        .payload;
    },
    async submit(id = 'connect') {
      workId = id;
      step = 0;
      return client.startRun('s', {
        expectedStoreId,
        commandId: id,
        kind: 'run.start',
        content: id,
      });
    },
    async pending() {
      return until(
        async () =>
          (
            await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
          ).interactions.find((card) => card.kind === 'approval') ?? null,
      );
    },
    async approve(card: { id: string; revision: string }) {
      return client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
    },
    async done() {
      await runtime.waitForCommand(workId, { timeoutMs: 8000 });
      return (await store.getView('s')).runs.find((run) => run.originCommandId === workId)!;
    },
    async close() {
      await service.close();
      provider.stop(true);
      remote.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}

test('default raw user MCP selection reaches actual Model and independently approves connect Tool, source Job and remote Tool', async () => {
  const f = await fixture({ ask: true });
  try {
    const safe = await f.query();
    expect(JSON.stringify(safe)).toContain('owned');
    expect(f.credentialReads).toBe(0);
    expect(f.rpc).toEqual([]);
    await f.submit();
    const connect = await f.pending();
    expect(connect.definitionId).toBe('mcp.connect');
    expect(f.bodies).toHaveLength(2);
    expect(f.rpc).toEqual([]);
    const directory = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'mcp.sources.list',
    )!;
    expect(directory.status).toBe('succeeded');
    await f.approve(connect);
    const job = await f.pending();
    expect(job.definitionId).toBe(mcpSourceConnectionJobId);
    expect(job.executionId).not.toBe(connect.executionId);
    expect(job.request).toMatchObject({ policy: { effects: ['unknown'] } });
    expect(f.rpc).toEqual([]);
    await f.approve(job);
    const remote = await f.pending();
    expect(remote.definitionId).not.toBe(connect.definitionId);
    expect(remote.request).toMatchObject({ policy: { effects: ['unknown'] } });
    expect(f.rpc).toEqual(['initialize', 'tools/list']);
    expect(f.effects).toBe(0);
    await f.approve(remote);
    const run = await f.done();
    expect(run.status).toBe('completed');
    expect(f.effects).toBe(1);
    expect(f.credentialReads).toBe(1);
    expect(f.bodies).toHaveLength(4);
    const sourceJob = await f.runtime.getExecution(job.executionId);
    expect(sourceJob).toMatchObject({
      kind: 'job',
      originStoreId: f.expectedStoreId,
      sessionId: 's',
      parentExecutionId: connect.executionId,
    });
    expect(Object.keys(sourceJob!.input as object).sort()).toEqual([
      'bootstrapId',
      'captureDigest',
      'configDigest',
      'key',
      'originStoreId',
      'parentExecutionId',
      'parentInputDigest',
      'serverId',
    ]);
    const modelAndJob = JSON.stringify({ bodies: f.bodies, input: sourceJob!.input });
    expect(modelAndJob).not.toContain('RAW_PRIVATE_TRANSPORT_VALUE');
    expect(modelAndJob).not.toContain(f.source.mcpServers.owned.url);
    expect(modelAndJob).not.toContain('owned-model-secret');
    expect(run.configuration).toMatchObject({
      snapshot: {
        mcp: {
          sources: {
            selection: { present: false },
            servers: [expect.objectContaining({ name: 'owned' })],
          },
        },
      },
    });
  } finally {
    await f.close();
  }
}, 25000);

test('default selected source recovery rejects changed raw source before Model credential lookup and does not retag the original binding', async () => {
  const f = await fixture();
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('completed');
    expect(f.effects).toBe(1);
    const originalProjection = JSON.stringify(run.configuration);
    const command = (await f.runtime.getCommand(run.originCommandId))!;
    const session = (await f.runtime.getSession('s'))!;
    const workspace = (await f.runtime.getWorkspace('w'))!;
    const before = f.credentialReads;
    writeFileSync(
      f.sourcePath,
      JSON.stringify({ ...f.source, unknown: 'changed exact raw source' }),
    );
    let rejected: unknown;
    try {
      const unexpected = await f.host.resolveRecoveryRunConfiguration!({
        command,
        run,
        session,
        workspace,
        signal: new AbortController().signal,
      });
      await unexpected.dispose?.();
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string })?.code).toBe('recovery_configuration_changed');
    expect(f.credentialReads).toBe(before);
    expect(f.bodies).toHaveLength(4);
    expect(JSON.stringify((await f.runtime.getRun(run.id))!.configuration)).toBe(
      originalProjection,
    );
    writeFileSync(f.sourcePath, JSON.stringify(f.source));
    const reopened = await f.host.resolveRecoveryRunConfiguration!({
      command,
      run,
      session,
      workspace,
      signal: new AbortController().signal,
    });
    expect(reopened.snapshot).toMatchObject({
      mcp: {
        sources: (run.configuration as { snapshot: { mcp: { sources: Json } } }).snapshot.mcp
          .sources,
      },
    });
    await reopened.dispose?.();
  } finally {
    await f.close();
  }
}, 25000);

test('bad optional raw source and explicit resolved empty MCP selection preserve actual ordinary file/model work', async () => {
  for (const options of [{ broken: true }, { disabled: true }]) {
    const f = await fixture(options);
    try {
      await f.submit();
      const run = await f.done();
      expect(run.status).toBe('completed');
      expect(f.rpc).toEqual([]);
      expect(f.effects).toBe(0);
      expect(f.bodies).toHaveLength(2);
      expect(f.bodies[0]!.tools).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'mcp.connect' }) }),
        ]),
      );
      expect(
        (await f.store.listExecutions('s')).find(
          (execution) => execution.definitionId === 'files.read',
        )?.status,
      ).toBe('succeeded');
      expect(run.configuration).toMatchObject({
        snapshot: {
          mcp: {
            sources: {
              readSet: null,
              servers: [],
              selection: { present: !!options.disabled, serverIds: [] },
            },
          },
        },
      });
    } finally {
      await f.close();
    }
  }
}, 25000);
