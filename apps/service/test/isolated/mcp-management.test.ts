import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  type JsonObject,
  type McpRegistry,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import {
  createMcpCredentialBroker,
  createMcpLifecycle,
  createMcpStdioTransportPort,
} from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createConfigurationManagement } from '../../src/configuration-management';
import { startService } from '../../src/index';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';
import { createMcpManagement } from '../../src/mcp-management';

const obj = (value: unknown) => value as Record<string, Json>;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('mcp_management_fixture_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(transport: 'http' | 'stdio' = 'http', defaultMode?: 'registered' | 'empty') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-management-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'private' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
    expectedStoreId = (await store.getMetadata()).storeId;
  const configPath = join(profile.profilePath, 'config.jsonc'),
    workspacePath = join(workspace, 'kite-agent.jsonc');
  writeFileSync(
    configPath,
    '{\n// ORIGINAL COMMENT\n"unknown": {"preserve": true},\n"mcp":[{"id":"local","enabled":true}]\n}\n',
  );
  writeFileSync(workspacePath, '{// WORKSPACE COMMENT\n"unknown":42}\n');
  const cataloguePath = join(root, 'catalogue.json'),
    ledger = join(root, 'wire.jsonl');
  const oldDescriptor = {
    name: 'effect',
    description: 'old schema',
    inputSchema: {
      type: 'object',
      properties: { old: { type: 'string' } },
      additionalProperties: false,
    },
  };
  const newDescriptor = {
    name: 'effect',
    description: 'new schema',
    inputSchema: {
      type: 'object',
      properties: { new: { type: 'number' } },
      additionalProperties: false,
    },
  };
  writeFileSync(cataloguePath, JSON.stringify([oldDescriptor]));
  const wire: { method: string; params?: unknown }[] = [];
  let hold: { entered: () => void; wait: Promise<void> } | undefined;
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await req.json()) as { method: string; id?: number | string; params?: unknown };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push({ method: rpc.method, params: rpc.params });
      if (rpc.method === 'tools/list' && hold) {
        hold.entered();
        await hold.wait;
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'local', version: '1' },
              capabilities: { tools: {} },
            }
          : rpc.method === 'tools/list'
            ? { tools: JSON.parse(readFileSync(cataloguePath, 'utf8')) }
            : { content: [{ type: 'text', text: 'actual remote result' }] };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const providerBodies: Record<string, unknown>[] = [];
  let modelRefresh = false;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      providerBodies.push((await req.json()) as Record<string, unknown>);
      const requested = modelRefresh;
      modelRefresh = false;
      const call = requested ? { name: 'mcp.catalogue.refresh', input: await binding() } : null;
      const chunk = {
        id: 'fixed',
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
                      id: 'actual-refresh',
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
  let lookups = 0,
    opens = 0;
  const backend = createTemporaryCredentialBackend(),
    vault = createCredentialVault({
      backend: {
        ...backend,
        async resolve(id) {
          lookups++;
          return backend.resolve(id);
        },
      },
    });
  const credential = await vault.put('owned-temporary-bearer'),
    broker = createMcpCredentialBroker({ vault });
  const configuration =
    transport === 'http'
      ? { type: 'http' as const, url: network.url.href }
      : {
          type: 'stdio' as const,
          command: process.execPath,
          args: [
            join(import.meta.dir, '../../../../tests/fixtures/mcp-leaf/catalogue-refresh.ts'),
            cataloguePath,
            ledger,
          ],
          cwd: root,
          env: {},
        };
  const admit = async (binding: { executionId: string; originalStoreId: string }) => {
    opens++;
    expect(await store.getExecution(binding.executionId)).toMatchObject({
      status: 'dispatching',
      originStoreId: expectedStoreId,
    });
  };
  const built =
    transport === 'stdio'
      ? await Bun.build({
          entrypoints: [
            join(import.meta.dir, '../../../../packages/agent/src/mcp/stdio-guardian.ts'),
          ],
          outdir: root,
          naming: 'guardian.js',
          target: 'bun',
        })
      : undefined;
  const port =
    configuration.type === 'http'
      ? createMcpHttpTransportPort({
          servers: [
            {
              id: 'local',
              url: configuration.url,
              credential: {
                broker,
                async bind(binding) {
                  const identity = {
                    profileId: profile.profileAccessKey,
                    originalStoreId: expectedStoreId,
                    workspaceId: 'w',
                    workspaceIdentity: workspace,
                    sessionId: binding.sessionId,
                    connectionExecutionId: binding.executionId,
                    source: { kind: 'programmatic' as const, id: 'owned', revision: '1' },
                    serverId: 'local',
                    configDigest: binding.configDigest,
                    authProfileId: 'owned',
                    policyRevision: 'fixed',
                  };
                  return {
                    identity,
                    revocationRevision: 0,
                    ref: broker.issue({
                      identity,
                      credentialRef: credential.id,
                      purpose: 'mcp.http',
                      expiresAt: Date.now() + 60000,
                      revocationRevision: 0,
                    }),
                  };
                },
              },
            },
          ],
          allowLoopbackForTests: true,
          admit,
        })
      : createMcpStdioTransportPort({
          servers: [{ id: 'local', configuration }],
          guardianPath: built!.outputs[0]!.path,
          bunExecutable: process.execPath,
          allowedEnvNames: [],
          admit,
        });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport: configuration }],
    transportPort: port,
  });
  const registry: McpRegistry = {
    revision: 'original',
    servers: [
      {
        id: 'local',
        configDigest: lifecycle.extension.jobs![0]!.version,
        transport,
        source: { kind: 'programmatic', id: 'owned', revision: '1' },
        admitted: true,
      },
    ],
  };
  let explicit: JsonObject = {},
    ask = false,
    deny = false;
  let runtime!: ReturnType<typeof createRuntime>;
  let receiptFault = false;
  const management = createMcpManagement({
    runtime: () => ({
      getMetadata: () => runtime.getMetadata(),
      getSession: (id) => runtime.getSession(id),
      getWorkspace: (id) => runtime.getWorkspace(id),
      getExecution: (id) => runtime.getExecution(id),
      getCommand: (id) => runtime.getCommand(id),
      beginHostMutation: (input) => runtime.beginHostMutation(input),
      finishHostMutation: (input) => {
        if (receiptFault && input.state === 'applied') {
          receiptFault = false;
          throw Error('fixture_sql_receipt_unavailable');
        }
        return runtime.finishHostMutation(input);
      },
    }),
    profile,
    explicit: () => explicit,
    registry: () => registry,
  });
  const model = createSdkModelAdapter({
    models: new Map([
      [
        'local',
        createCompatibleModelBinding({ baseURL: `${provider.url.href}v1`, modelId: 'local' }),
      ],
    ]),
  });
  const defaults = defaultMode
    ? createDefaultProcessConfiguration({
        profile,
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'trusted-default-host' };
          },
        },
        ...(defaultMode === 'registered'
          ? { mcp: { servers: [{ id: 'local', transport: configuration }], transportPort: port } }
          : {}),
      })
    : undefined;
  runtime = createRuntime({
    store,
    model,
    modelId: 'local',
    extensions: defaults?.extensions ?? [lifecycle.extension, management.extension],
    permissions: defaults?.permissions ?? {
      async authorize(request) {
        return deny
          ? { allowed: false, revision: 'deny', reason: 'fixture_denied' }
          : ask && request.kind !== 'model'
            ? {
                allowed: false,
                revision: 'ask',
                approval: { request: { effects: ['external'] }, grants: ['approve_once'] },
              }
            : { allowed: true, revision: 'trusted-external-allowed' };
      },
    },
    resolveRunConfiguration:
      defaults?.resolveRunConfiguration ??
      (async () => ({
        model,
        modelId: 'local',
        toolIds: ['mcp.connect', 'mcp.catalogue.refresh'],
        snapshot: {},
        readStepCapabilities: async (input) => {
          const current = JSON.parse(readFileSync(configPath, 'utf8').replace(/\/\/[^\n]*/g, ''));
          const cached = await lifecycle.readStepCapabilities(input);
          return current.mcp[0].enabled
            ? { ...cached, toolIds: ['mcp.connect', 'mcp.catalogue.refresh', ...cached.toolIds] }
            : { extensions: [], toolIds: [], snapshot: {} };
        },
      })),
  });
  defaults?.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  for (const sessionId of ['a', 'b'])
    await runtime.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      subjectId: 'user',
      title: sessionId,
    });
  const service = await startService({
      runtime,
      configurationManagement: createConfigurationManagement({
        runtime,
        profile,
        vault,
        persistence: 'temporary',
        explicit: () => explicit,
      }),
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      buildId: 'mcp-management-owned',
      subjectId: 'user',
    }),
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['extension_queries', 'extensions_actions'],
      },
    });
  await client.connect();
  let serial = 0;
  async function invoke(id: string, input: Json, sessionId = 'a', managementAction = false) {
    const commandId = `invoke-${++serial}`;
    await client.invokeExtension(sessionId, {
      kind: 'extension.invoke',
      commandId,
      expectedStoreId,
      extensionId: managementAction ? 'builtin.mcp.management' : 'builtin.mcp',
      actionId: id,
      definitionVersion: '1',
      input,
    });
    await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    return (await store.listExecutions(sessionId)).find((e) => e.originCommandId === commandId)!;
  }
  async function query(sessionId = 'a') {
    return client.queryExtension(sessionId, 'builtin.mcp.management', 'mcp.servers', {});
  }
  async function readSet(sessionId = 'a') {
    const result = await query(sessionId);
    return obj(result[0]!.payload).readSet!;
  }
  async function binding(sessionId = 'a') {
    const record = (await store.getExtensionRecord({
      sessionId,
      extensionId: 'builtin.mcp',

      key: 'connection/local/first',
    }))!;
    const saved = obj(record.value);
    const facts = await lifecycle.readStepCapabilities({
      command: { originStoreId: expectedStoreId },
      session: { id: sessionId },
    });
    return {
      serverId: 'local',
      connectionKey: 'first',
      connectionExecutionId: obj(saved.operationRef).executionId,
      configDigest: saved.configDigest,
      generation: obj((obj(facts.snapshot).mcp as Json[])[0]).generation,
    };
  }
  return {
    root,
    profile,
    configuration,
    store,
    runtime,
    client,
    management,
    lifecycle,
    configPath,
    workspacePath,
    registry,
    providerBodies,
    newDescriptor,
    oldDescriptor,
    query,
    readSet,
    binding,
    invoke,
    get wire() {
      return transport === 'http'
        ? wire
        : existsSync(ledger)
          ? (readFileSync(ledger, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line)) as typeof wire)
          : [];
    },
    get opens() {
      return opens;
    },
    get lookups() {
      return lookups;
    },
    get lastCommand() {
      return `invoke-${serial}`;
    },
    set ask(value: boolean) {
      ask = value;
    },
    set deny(value: boolean) {
      deny = value;
    },
    set explicit(value: JsonObject) {
      explicit = value;
    },
    set hold(value: typeof hold) {
      hold = value;
    },
    set receiptFault(value: boolean) {
      receiptFault = value;
    },
    set modelRefresh(value: boolean) {
      modelRefresh = value;
    },
    change(descriptor = newDescriptor) {
      writeFileSync(cataloguePath, JSON.stringify([descriptor]));
    },
    async run(sessionId = 'a') {
      const commandId = `run-${++serial}`;
      await runtime.submitCommand({
        expectedStoreId,
        sessionId,
        subjectId: 'user',
        commandId,
        request: {
          kind: 'run.start',
          content: 'Inspect the current schema; fixed local model only',
        },
      });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      return commandId;
    },
    async close() {
      await service.close();
      network.stop(true);
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
    expectedStoreId,
  };
}
async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  const card = await until(
    async () =>
      (
        await f.store.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions[0] ?? null,
  );
  await f.runtime.answerInteraction({
    expectedStoreId: f.expectedStoreId,
    subjectId: 'user',
    commandId: `approve-${card.id}`,
    presentationSessionId: card.presentationSessionId,
    interactionId: card.id,
    expectedRevision: card.revision,
    answer: { kind: 'approval', decision: 'approve' },
  });
}
test('actual Client directory is cold; selection CAS preserves JSONC/unknown fields and one original mutation receipt', async () => {
  const f = await fixture();
  try {
    const directory = await f.query();
    expect(directory[0]!.payload).toMatchObject({
      storeId: f.expectedStoreId,
      sessionId: 'a',
      workspaceId: 'w',
      registryRevision: 'original',
      items: [{ id: 'local', admitted: true, selected: true }],
    });
    expect(f.opens).toBe(0);
    expect(f.lookups).toBe(0);
    expect(f.wire).toHaveLength(0);
    expect(f.providerBodies).toHaveLength(0);
    const input = {
      serverId: 'local',
      enabled: false,
      scope: 'user',
      expectedReadSet: await f.readSet(),
    } as Json;
    const execution = await f.invoke('mcp.server.select', input, 'a', true);
    expect(execution.result).toMatchObject({ outcome: 'succeeded' });
    expect(execution.status).toBe('succeeded');
    expect(execution.runId).toBeNull();
    const mutation = await f.runtime.getHostMutation({
      expectedStoreId: f.expectedStoreId,
      commandId: `mcp-select-${execution.id}`,
      subjectId: 'user',
    });
    expect(mutation).toMatchObject({
      id: `mcp-select-${execution.id}`,
      kind: 'config.user.write',
      state: 'applied',
      receipt: { status: 'applied' },
    });
    expect(readFileSync(f.configPath, 'utf8')).toContain('// ORIGINAL COMMENT');
    expect(readFileSync(f.configPath, 'utf8')).toContain('"preserve": true');
    expect(f.providerBodies).toHaveLength(0);
    expect(f.lookups).toBe(0);
    const stale = await f.invoke('mcp.server.select', input, 'a', true);
    expect(stale.status).toBe('failed');
    expect(stale.result).toMatchObject({ content: 'configuration_read_set_conflict' });
    expect(
      await f.runtime.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: `mcp-select-${stale.id}`,
        subjectId: 'user',
      }),
    ).toBeNull();
    const wrong = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: true,
        scope: 'user',
        expectedReadSet: await f.readSet(),
      } as Json,
      'b',
      true,
    );
    expect(wrong.status).toBe('failed');
    expect(wrong.result).toMatchObject({ content: 'configuration_read_set_conflict' });
    f.registry.servers[0]!.admitted = false;
    const deniedSource = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: true,
        scope: 'user',
        expectedReadSet: await f.readSet(),
      } as Json,
      'a',
      true,
    );
    expect(deniedSource.result).toMatchObject({
      outcome: 'failed',
      content: 'mcp_server_not_admitted',
    });
    expect(f.opens).toBe(0);
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
});
test('selection independent deny/Ask and every exact source drift reject before effect under trusted broad policy', async () => {
  const f = await fixture();
  try {
    f.deny = true;
    const before = readFileSync(f.configPath, 'utf8');
    const denied = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: false,
        scope: 'user',
        expectedReadSet: await f.readSet(),
      } as Json,
      'a',
      true,
    );
    expect(denied.status).toBe('failed');
    expect(readFileSync(f.configPath, 'utf8')).toBe(before);
    f.deny = false;
    for (const drift of ['user', 'workspace', 'registry', 'explicit'] as const) {
      f.ask = true;
      const input = {
        serverId: 'local',
        enabled: false,
        scope: 'user',
        expectedReadSet: await f.readSet(),
      } as Json;
      const action = f.invoke('mcp.server.select', input, 'a', true);
      await until(
        async () =>
          (
            await f.store.listInteractions({
              expectedStoreId: f.expectedStoreId,
              sessionId: 'a',
              state: 'pending',
            })
          ).interactions[0] ?? null,
      );
      expect(readFileSync(f.configPath, 'utf8')).toBe(before);
      if (drift === 'user') writeFileSync(f.configPath, `${before}// USER DRIFT\n`);
      if (drift === 'workspace')
        writeFileSync(
          f.workspacePath,
          `${readFileSync(f.workspacePath, 'utf8')}// WORKSPACE DRIFT\n`,
        );
      if (drift === 'registry') f.registry.revision = 'new';
      if (drift === 'explicit') f.explicit = { mcp: [{ id: 'local', enabled: true }] };
      const after = readFileSync(f.configPath, 'utf8');
      await approve(f);
      const execution = await action;
      expect(execution.status).toBe('failed');
      expect(execution.result).toMatchObject({ content: 'configuration_read_set_conflict' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(after);
      expect(
        await f.runtime.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          commandId: `mcp-select-${execution.id}`,
          subjectId: 'user',
        }),
      ).toBeNull();
      f.ask = false;
      writeFileSync(f.configPath, before);
    }
    expect(f.opens).toBe(0);
    expect(f.lookups).toBe(0);
    expect(f.providerBodies).toHaveLength(0);
  } finally {
    await f.close();
  }
});
for (const transport of ['http', 'stdio'] as const)
  (transport === 'stdio' && process.platform !== 'darwin' ? test.skip : test)(
    `actual ${transport} refresh is ordinary live-only and next fixed SDK Step sees new schema; other Session stays live`,
    async () => {
      const f = await fixture(transport);
      try {
        const cold = await f.invoke('mcp.catalogue.refresh', {
          serverId: 'local',
          connectionKey: 'first',
          connectionExecutionId: 'not-live',
          configDigest: f.registry.servers[0]!.configDigest,
          generation: 1,
        });
        expect(cold.result).toMatchObject({
          outcome: 'failed',
          details: { adapterAttempted: false },
        });
        expect(f.opens).toBe(0);
        expect((await f.invoke('mcp.connect', { serverId: 'local', key: 'first' })).status).toBe(
          'succeeded',
        );
        expect(
          (await f.invoke('mcp.connect', { serverId: 'local', key: 'first' }, 'b')).status,
        ).toBe('succeeded');
        const original = await f.binding(),
          other = await f.binding('b');
        await f.run();
        expect(JSON.stringify(f.providerBodies.at(-1)!.tools)).toContain('old schema');
        const oldProjection = (await f.store.getExtensionRecord({
          sessionId: 'a',
          extensionId: 'builtin.mcp',

          key: 'connection/local/first',
        }))!;
        const before = f.wire.length;
        f.change();
        const refreshed = await f.invoke('mcp.catalogue.refresh', original as Json);
        expect(refreshed.status).toBe('succeeded');
        expect(f.wire.slice(before).map((item) => item.method)).toEqual(['tools/list']);
        expect(f.opens).toBe(2);
        expect(Number((await f.binding()).generation)).toBeGreaterThan(Number(original.generation));
        expect(await f.binding('b')).toEqual(other);
        expect(
          (await f.store.getExtensionRecord({
            sessionId: 'a',
            extensionId: 'builtin.mcp',

            key: 'connection/local/first',
          }))!.value,
        ).toEqual(oldProjection.value);
        const saved = await f.store.getExtensionRecord({
          sessionId: 'a',
          extensionId: 'builtin.mcp',

          key: `refresh/${refreshed.id}`,
        });
        expect(saved!.value).toMatchObject({
          executionId: refreshed.id,
          previousGeneration: original.generation,
          operationRef: obj(oldProjection.value).operationRef,
        });
        const count = f.wire.length;
        const otherId = (await f.binding('b')).connectionExecutionId;
        expect(
          (
            await f.invoke('mcp.catalogue.refresh', {
              ...(await f.binding()),
              connectionExecutionId: otherId,
            } as Json)
          ).status,
        ).toBe('failed');
        expect(f.wire).toHaveLength(count);
        expect((await f.invoke('mcp.catalogue.refresh', original as Json)).status).toBe('failed');
        expect(f.wire).toHaveLength(count);
        await f.run();
        expect(JSON.stringify(f.providerBodies.at(-1)!.tools)).toContain('new schema');
        expect(JSON.stringify(f.providerBodies.at(-1)!.tools)).not.toContain('old schema');
        await f.run('b');
        expect(JSON.stringify(f.providerBodies.at(-1)!.tools)).toContain('old schema');
        f.change({ ...f.newDescriptor, description: 'model refreshed schema' });
        f.modelRefresh = true;
        const commandId = await f.run();
        const tool = (await f.store.listExecutions('a')).find(
          (e) => e.originCommandId === commandId && e.definitionId === 'mcp.catalogue.refresh',
        );
        expect(tool).toMatchObject({ kind: 'tool', status: 'succeeded' });
        expect(JSON.stringify(f.providerBodies.at(-1)!.tools)).toContain('model refreshed schema');
      } finally {
        await f.close();
      }
    },
  );
test('refresh deny/Ask cancellation before wire is known; cancellation after actual RPC retains original unknown and no successful publication', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.invoke('mcp.connect', { serverId: 'local', key: 'first' });
    const original = await f.binding(),
      before = f.wire.length;
    f.deny = true;
    expect((await f.invoke('mcp.catalogue.refresh', original as Json)).status).toBe('failed');
    expect(f.wire).toHaveLength(before);
    f.deny = false;
    f.ask = true;
    const waiting = f.invoke('mcp.catalogue.refresh', original as Json);
    await until(
      async () =>
        (
          await f.store.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'a',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'cancel-before',
      targetCommandId: f.lastCommand,
    });
    expect((await waiting).status).toBe('cancelled');
    expect(f.wire).toHaveLength(before);
    f.ask = false;
    f.change();
    let entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.hold = {
      entered,
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const active = f.invoke('mcp.catalogue.refresh', original as Json);
    await seen;
    const originalCommand = f.lastCommand;
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'cancel-after',
      targetCommandId: originalCommand,
    });
    const execution = await active;
    expect(execution.status).toBe('outcome_unknown');
    expect(execution.originCommandId).toBe(originalCommand);
    expect(f.wire.slice(before).map((item) => item.method)).toEqual(['tools/list']);
    expect(await f.binding()).toEqual(original);
    expect(
      await f.store.getExtensionRecord({
        sessionId: 'a',
        extensionId: 'builtin.mcp',

        key: `refresh/${execution.id}`,
      }),
    ).toBeNull();
    release();
    await Bun.sleep(20);
    expect(await f.binding()).toEqual(original);
  } finally {
    release?.();
    await f.close();
  }
});
test('workspace selection preserves its own source; SQLite receipt failure after publication keeps original pending mutation and unknown Execution', async () => {
  const f = await fixture();
  try {
    const user = readFileSync(f.configPath, 'utf8');
    const selected = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: false,
        scope: 'workspace',
        expectedReadSet: await f.readSet(),
      } as Json,
      'a',
      true,
    );
    expect(selected.status).toBe('succeeded');
    expect(readFileSync(f.configPath, 'utf8')).toBe(user);
    expect(readFileSync(f.workspacePath, 'utf8')).toContain('// WORKSPACE COMMENT');
    expect(readFileSync(f.workspacePath, 'utf8')).toMatch(/"unknown"\s*:\s*42/);
    expect(
      (
        await f.invoke(
          'mcp.server.select',
          {
            serverId: 'local',
            enabled: false,
            scope: 'user',
            expectedReadSet: await f.readSet(),
          } as Json,
          'a',
          true,
        )
      ).result,
    ).toMatchObject({ outcome: 'failed', content: 'mcp_selection_overridden' });
    f.receiptFault = true;
    const uncertain = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: true,
        scope: 'workspace',
        expectedReadSet: await f.readSet(),
      } as Json,
      'a',
      true,
    );
    expect(uncertain.status).toBe('outcome_unknown');
    expect(uncertain.result).toMatchObject({
      content: 'mutation_outcome_unknown',
      details: { mutationId: `mcp-select-${uncertain.id}` },
    });
    const original = await f.runtime.getHostMutation({
      expectedStoreId: f.expectedStoreId,
      commandId: `mcp-select-${uncertain.id}`,
      subjectId: 'user',
    });
    expect(original).toMatchObject({
      state: 'pending',
      originStoreId: f.expectedStoreId,
      subjectId: 'user',
      kind: 'config.workspace.write',
      scope: 'w',
    });
    expect(
      await f.client.getHostMutation(original!.id, { storeId: f.expectedStoreId }),
    ).toMatchObject({
      commandId: original!.id,
      originStoreId: f.expectedStoreId,
      state: 'pending',
      kind: 'config.patch',
      scope: 'workspace',
      workspaceId: 'w',
    });
    expect(readFileSync(f.workspacePath, 'utf8')).toContain('"enabled": true');
    const command = await f.runtime.getCommand(uncertain.originCommandId);
    expect(await f.client.getCommand(uncertain.originCommandId)).toMatchObject({
      id: command!.id,
      status: command!.status,
    });
    expect(
      await f.runtime.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: original!.id,
        subjectId: 'user',
      }),
    ).toEqual(original);
    expect(f.wire).toHaveLength(0);
    expect(f.lookups).toBe(0);
    expect(f.providerBodies).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('cold SQLite management/catalogue Queries preserve historical facts with zero reconnection; cold refresh rejects original ID', async () => {
  const f = await fixture();
  let cold: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.invoke('mcp.connect', { serverId: 'local', key: 'first' });
    const original = await f.binding();
    f.change();
    await f.invoke('mcp.catalogue.refresh', original as Json);
    const current = await f.binding();
    const before = f.wire.length,
      lookups = f.lookups,
      models = f.providerBodies.length;
    await f.runtime.close();
    const coldStore = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
    });
    const coldLifecycle = createMcpLifecycle({
      servers: [{ id: 'local', transport: f.configuration }],
    });
    const coldManagement = createMcpManagement({
      runtime: () => cold!,
      profile: f.profile,
      explicit: () => ({}),
      registry: () => f.registry,
    });
    cold = createRuntime({
      store: coldStore,
      extensions: [coldLifecycle.extension, coldManagement.extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'trusted-cold' };
        },
      },
    });
    const directory = await cold.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: 'builtin.mcp.management',
      queryId: 'mcp.servers',
      input: {},
    });
    expect(directory[0]!.payload).toMatchObject({
      storeId: f.expectedStoreId,
      sessionId: 'a',
      registryRevision: 'original',
    });
    const catalogue = await cold.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.catalogue',
      input: {},
    });
    expect(obj(catalogue[0]!.payload).items).toMatchObject([
      { live: false, currentCatalogue: null, record: { generation: original.generation } },
    ]);
    await cold.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'cold-refresh',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId: 'mcp.catalogue.refresh',
        definitionVersion: '1',
        input: current as Json,
      },
    });
    await cold.waitForCommand('cold-refresh', { timeoutMs: 5000 });
    expect(
      (await coldStore.listExecutions('a')).find((e) => e.originCommandId === 'cold-refresh')!
        .result,
    ).toMatchObject({ outcome: 'failed', details: { adapterAttempted: false } });
    expect(f.wire).toHaveLength(before);
    expect(f.lookups).toBe(lookups);
    expect(f.providerBodies).toHaveLength(models);
  } finally {
    await cold?.close();
    await f.close();
  }
});
for (const mode of ['registered', 'empty'] as const)
  test(`default Service ${mode} registry Query/selection Action is actually wired with zero Model/socket/credential IO`, async () => {
    const f = await fixture('http', mode);
    try {
      const view = await f.query();
      const payload = obj(view[0]!.payload);
      expect(payload).toMatchObject({
        storeId: f.expectedStoreId,
        sessionId: 'a',
        workspaceId: 'w',
      });
      expect(payload.registryRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.items).toMatchObject(
        mode === 'registered'
          ? [
              {
                id: 'local',
                configDigest: f.registry.servers[0]!.configDigest,
                source: {
                  kind: 'programmatic',
                  id: 'host:local',
                  revision: f.registry.servers[0]!.configDigest,
                },
                admitted: true,
                selected: true,
              },
            ]
          : [],
      );
      const before = readFileSync(f.configPath, 'utf8');
      const execution = await f.invoke(
        'mcp.server.select',
        {
          serverId: 'local',
          enabled: false,
          scope: 'user',
          expectedReadSet: await f.readSet(),
        } as Json,
        'a',
        true,
      );
      expect(execution.status).toBe(mode === 'registered' ? 'succeeded' : 'failed');
      if (mode === 'empty') {
        expect(execution.result).toMatchObject({ content: 'mcp_server_not_admitted' });
        expect(readFileSync(f.configPath, 'utf8')).toBe(before);
      } else {
        expect((await f.query())[0]!.payload).toMatchObject({
          items: [{ id: 'local', selected: false }],
        });
        expect(readFileSync(f.configPath, 'utf8')).toContain('// ORIGINAL COMMENT');
      }
      expect(f.opens).toBe(0);
      expect(f.wire).toHaveLength(0);
      expect(f.lookups).toBe(0);
      expect(f.providerBodies).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
test('directory distinguishes selected from available and exact original definition mismatch cannot be enabled by broad external permission', async () => {
  const f = await fixture();
  try {
    const original = `{// ORIGINAL DEFINITION\n"mcp":[{"id":"local","enabled":true,"configDigest":"${'0'.repeat(64)}"}]}`;
    writeFileSync(f.configPath, original);
    expect((await f.query())[0]!.payload).toMatchObject({
      items: [
        {
          id: 'local',
          selected: true,
          available: false,
          reason: 'mcp_definition_version_unavailable',
        },
      ],
    });
    const execution = await f.invoke(
      'mcp.server.select',
      {
        serverId: 'local',
        enabled: true,
        scope: 'user',
        expectedReadSet: await f.readSet(),
      } as Json,
      'a',
      true,
    );
    expect(execution.result).toMatchObject({
      outcome: 'failed',
      content: 'mcp_definition_version_unavailable',
    });
    expect(readFileSync(f.configPath, 'utf8')).toBe(original);
    expect(f.opens).toBe(0);
    expect(f.lookups).toBe(0);
    expect(f.providerBodies).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('default host current selection is technical admission even under broad external policy; deselected refresh has zero credential/RPC', async () => {
  const f = await fixture('http', 'registered');
  try {
    expect((await f.invoke('mcp.connect', { serverId: 'local', key: 'first' })).status).toBe(
      'succeeded',
    );
    const connection = (await f.store.getExtensionRecord({
        sessionId: 'a',
        extensionId: 'builtin.mcp',
        key: 'connection/local/first',
      }))!,
      saved = obj(connection.value);
    const input = {
      serverId: 'local',
      connectionKey: 'first',
      connectionExecutionId: obj(saved.operationRef).executionId,
      configDigest: saved.configDigest,
      generation: saved.generation,
    } as Json;
    expect(
      (
        await f.invoke(
          'mcp.server.select',
          {
            serverId: 'local',
            enabled: false,
            scope: 'user',
            expectedReadSet: await f.readSet(),
          } as Json,
          'a',
          true,
        )
      ).status,
    ).toBe('succeeded');
    const wire = f.wire.length,
      lookups = f.lookups,
      opens = f.opens;
    expect((await f.invoke('mcp.catalogue.refresh', input)).status).toBe('failed');
    expect(f.wire).toHaveLength(wire);
    expect(f.lookups).toBe(lookups);
    expect(f.opens).toBe(opens);
    expect(f.providerBodies).toHaveLength(0);
    expect(
      (
        await f.invoke(
          'mcp.server.select',
          {
            serverId: 'local',
            enabled: true,
            scope: 'user',
            expectedReadSet: await f.readSet(),
          } as Json,
          'a',
          true,
        )
      ).status,
    ).toBe('succeeded');
    expect((await f.invoke('mcp.catalogue.refresh', input)).status).toBe('succeeded');
    expect(f.wire.slice(wire).map((call) => call.method)).toEqual(['tools/list']);
    expect(f.lookups).toBeGreaterThan(lookups);
    expect(f.opens).toBe(opens);
  } finally {
    await f.close();
  }
});
test('catalogue Query does not attach a replacement same-Session connection to the original immutable record', async () => {
  const f = await fixture();
  try {
    await f.invoke('mcp.connect', { serverId: 'local', key: 'first' });
    const original = (await f.store.getExtensionRecord({
        sessionId: 'a',
        extensionId: 'builtin.mcp',
        key: 'connection/local/first',
      }))!,
      ref = obj(obj(original.value).operationRef);
    await f.runtime.cancelExecution({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      commandId: 'stop-original-connection',
      executionId: String(ref.executionId),
    });
    await until(async () =>
      (await f.store.getExecution(String(ref.executionId)))!.status === 'cancelled' ? true : null,
    );
    f.change();
    expect((await f.invoke('mcp.connect', { serverId: 'local', key: 'replacement' })).status).toBe(
      'succeeded',
    );
    const query = await f.client.queryExtension('a', 'builtin.mcp', 'mcp.catalogue', {});
    const items = obj(query[0]!.payload).items as Record<string, Json>[];
    expect(items.find((item) => item.key === 'connection/local/first')).toMatchObject({
      record: original.value,
      live: false,
      currentCatalogue: null,
    });
    const replacement = items.find((item) => item.key === 'connection/local/replacement')!;
    expect(replacement).toMatchObject({ live: true, currentCatalogue: { available: true } });
    expect(obj(obj(replacement.record).operationRef).executionId).not.toBe(ref.executionId);
    expect(f.opens).toBe(2);
    expect((await f.store.getExecution(String(ref.executionId)))!.status).toBe('cancelled');
  } finally {
    await f.close();
  }
});
