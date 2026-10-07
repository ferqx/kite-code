import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type AgentClient, createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type {
  TuiMcpConnectionIntent,
  TuiMcpConnectionOutcome,
  TuiMcpConnectionPort,
  TuiMcpSnapshot,
} from '@kite-ai/ui/tui';
import { openMcpConnectionJournal } from '../../host/mcp-connection-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';
import { createTuiMcpConnectionPort } from '../../host/tui-mcp-connection';

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('actual_connection_host_deadline');
    await Bun.sleep(5);
  }
}
const original = (facts: TuiMcpSnapshot, commandId: string): TuiMcpConnectionIntent => ({
  sessionId: facts.sessionId,
  workspaceId: facts.workspaceId,
  workspaceIdentity: facts.workspaceIdentity,
  request: {
    expectedStoreId: facts.storeId,
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: facts.items[0]!.id, key: `key-${commandId}` },
  },
});
async function fixture(ask = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-mcp-connection-host-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let access = acquireProfileAccess(profile);
  const openJournal = () =>
    openMcpConnectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  let journal = openJournal(),
    rpc: string[] = [],
    models = 0,
    credentials = 0;
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = (await request.json()) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      rpc.push(body.method);
      if (!['initialize', 'tools/list'].includes(body.method))
        throw Error('owned_no_remote_tool_effect');
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned', version: '1' },
              capabilities: { tools: {} },
            }
          : {
              tools: [
                {
                  name: 'full_original',
                  description: 'Original tail 🙂',
                  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
                },
              ],
            };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      models++;
      throw Error('connection_must_not_call_model');
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  const source = JSON.stringify({
    mcpServers: {
      owned: {
        type: 'http',
        url: peer.url.href,
        auth: { type: 'none' },
        private: 'RAW_PRIVATE_CONNECTION_MARKER',
      },
    },
  });
  writeFileSync(sourcePath, source, { mode: 0o600 });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
    }),
    { mode: 0o600 },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let server: Awaited<ReturnType<typeof startService>> | undefined;
  let client: AgentClient | undefined;
  let mutationPosts = 0,
    commandGets = 0,
    queries = 0;
  const current = () => {
    if (!client) throw Error('owned_client_closed');
    return client;
  };
  const currentStore = () => {
    const value = current().serverInfo?.storeId;
    if (!value) throw Error('actual_server_identity_missing');
    return value;
  };
  const tracked = {
    get serverInfo() {
      return current().serverInfo;
    },
    getView: (...args: Parameters<AgentClient['getView']>) => current().getView(...args),
    listWorkspaces: (...args: Parameters<AgentClient['listWorkspaces']>) =>
      current().listWorkspaces(...args),
    listAllWorkspaces: (...args: Parameters<AgentClient['listAllWorkspaces']>) =>
      current().listAllWorkspaces(...args),
    getExecution: (...args: Parameters<AgentClient['getExecution']>) =>
      current().getExecution(...args),
    getHostMutation: (...args: Parameters<AgentClient['getHostMutation']>) =>
      current().getHostMutation(...args),
    async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
      queries++;
      return current().queryExtension(...args);
    },
    async getCommand(...args: Parameters<AgentClient['getCommand']>) {
      commandGets++;
      return current().getCommand(...args);
    },
    async invokeExtension(...args: Parameters<AgentClient['invokeExtension']>) {
      mutationPosts++;
      return current().invokeExtension(...args);
    },
  };
  async function stop() {
    client?.disposeNetwork();
    client = undefined;
    if (server) {
      await server.close();
      server = undefined;
    }
    if (runtime) {
      await runtime.close();
      runtime = undefined;
    }
    if (store) {
      await store.close();
      store = undefined;
    }
  }
  async function start() {
    const backend = createTemporaryCredentialBackend();
    const host = createDefaultProcessConfiguration({
      profile,
      mcpSources: { http: { allowLoopbackForTests: true } },
      credentialBackend: {
        ...backend,
        async resolve(ref) {
          credentials++;
          return backend.resolve(ref);
        },
      },
      permissionPolicy: {
        readPolicy: (request) => ({
          mode: ask ? 'ask' : 'full',
          workspaceTrust: true,
          revision: 'owned-policy',
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
    store = await openSqliteStore(profile);
    runtime = createRuntime({
      store,
      permissions: host.permissions!,
      extensions: host.extensions,
      supportsExtensionInputs: host.supportsExtensionInputs,
      resolveRunConfiguration: host.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    });
    host.permissionManagement?.(runtime);
    server = await startService({
      runtime,
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      subjectId: 'owned-subject',
      buildId: 'owned-connection',
      configurationManagement: host.configurationManagement!(runtime),
    });
    client = createClient({
      endpoint: server.endpoint,
      token: server.bootstrap.token,
      bootstrap: server.bootstrap,
      expected: {
        profile: server.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'extension_queries', 'extensions_actions'],
      },
    });
    await client.connect();
  }
  try {
    await start();
    const storeId = (await store!.getMetadata()).storeId;
    await current().createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await current().createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'create-s',
      workspaceId: 'w',
      title: 'owned',
    });
    const directory = await createTuiMcpPort(tracked, storeId).read(
      's',
      new AbortController().signal,
    );
    const configPath = join(profile.profilePath, 'config.jsonc');
    const configured = JSON.parse(readFileSync(configPath, 'utf8'));
    configured.mcp = [{ id: directory.items[0]!.id, enabled: true }];
    writeFileSync(configPath, JSON.stringify(configured), { mode: 0o600 });
    return {
      root,
      profile,
      sourcePath,
      source,
      workspace,
      storeId,
      tracked,
      get client() {
        return current();
      },
      get store() {
        return store!;
      },
      get journal() {
        return journal;
      },
      get rpc() {
        return [...rpc];
      },
      get models() {
        return models;
      },
      get credentials() {
        return credentials;
      },
      get posts() {
        return mutationPosts;
      },
      get gets() {
        return commandGets;
      },
      get queries() {
        return queries;
      },
      read: () => createTuiMcpPort(tracked, storeId).read('s', new AbortController().signal),
      port: () => createTuiMcpConnectionPort(tracked, storeId, journal),
      async offline() {
        await stop();
        journal.close();
        access.lock.release();
      },
      async reopen() {
        access = acquireProfileAccess(profile);
        journal = openJournal();
        await start();
      },
      currentPort() {
        return createTuiMcpConnectionPort(tracked, currentStore(), journal);
      },
      currentRead() {
        return createTuiMcpPort(tracked, currentStore()).read('s', new AbortController().signal);
      },
      async restart(removeSource = false) {
        await stop();
        journal.close();
        journal = openJournal();
        if (removeSource) writeFileSync(sourcePath, '{"mcpServers":{}}');
        await start();
      },
      async approve(commandId: string, definitionId: string) {
        const interaction = await until(async () =>
          (
            await current().listInteractions('s', { storeId, state: 'pending', limit: 20 })
          ).interactions.find(
            (row) => row.state === 'pending' && row.definitionId === definitionId,
          ),
        );
        expect(interaction.originStoreId).toBe(storeId);
        const execution = await store!.getExecution(interaction.executionId);
        if (!execution) throw Error('owned_approval_execution_unavailable');
        expect(execution.originStoreId).toBe(storeId);
        if (definitionId === 'builtin.mcp/mcp.connect')
          expect(execution.originCommandId).toBe(commandId);
        expect(interaction.kind).toBe('approval');
        if (requiresInteractionAttachment(interaction))
          await current().readInteractionAttachment(interaction);
        await current().answerInteraction('s', interaction.id, {
          expectedStoreId: storeId,
          commandId: `answer-${interaction.id}`,
          expectedRevision: interaction.revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
        return interaction;
      },
      async ready(intent: TuiMcpConnectionIntent, port?: TuiMcpConnectionPort) {
        const selected = port ?? createTuiMcpConnectionPort(tracked, storeId, journal);
        return until<TuiMcpConnectionOutcome>(async () => {
          const outcome = await selected.lookup(intent, new AbortController().signal);
          return outcome.phase === 'ready' ? outcome : undefined;
        });
      },
      async close(remove = true) {
        await stop();
        journal.close();
        access.lock.release();
        peer.stop(true);
        provider.stop(true);
        if (remove) rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    journal.close();
    access.lock.release();
    peer.stop(true);
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('public backup v16 and restore A→B retain original source and connection journal; current B Host foreign intent admission precedes all HTTP', async () => {
  const f = await fixture();
  let passed = false;
  try {
    const facts = await f.read();
    const intent = original(facts, 'original-a');
    const portA = f.port();
    await portA.submit(intent, facts);
    const ready = await f.ready(intent, portA);
    expect(ready.phase).toBe('ready');
    expect(ready.fact!.execution.originStoreId).toBe(f.storeId);
    expect(ready.fact!.connection!.originStoreId).toBe(f.storeId);
    expect(f.rpc).toEqual(['initialize', 'tools/list']);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
    const path = join(f.profile.profilePath, 'ui/mcp-connection-intents.json');
    const bytes = readFileSync(path);
    const originalRows = f.journal.list();
    expect(originalRows).toHaveLength(1);
    expect(originalRows[0]!.phase).toBe('ready');
    const storeA = f.client.serverInfo!.storeId;
    const subjectA = f.client.serverInfo!.subjectId;
    if (!storeA || !subjectA) throw Error('actual_server_identity_missing');
    await f.offline();
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.version).toBe(16);
    expect(backup.manifest.assets.mcpConfiguration).toMatchObject({
      path: 'mcp.json',
      present: true,
      proof: {
        byteLength: String(Buffer.byteLength(f.source)),
        sha256: createHash('sha256').update(f.source).digest('hex'),
      },
    });
    expect(readFileSync(join(backup.directory, 'mcp.json'), 'utf8')).toBe(f.source);
    expect(backup.manifest.assets.mcpConnectionIntents).toMatchObject({
      path: 'ui/mcp-connection-intents.json',
      present: true,
      format: { version: 1 },
      proof: {
        byteLength: String(bytes.length),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(join(backup.directory, 'ui/mcp-connection-intents.json'))).toEqual(bytes);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: storeA,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(storeA);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.source);
    await f.reopen();
    const storeB = f.client.serverInfo!.storeId;
    if (!storeB) throw Error('actual_restored_server_identity_missing');
    expect(storeB).toBe(restored.storeId);
    expect(f.client.serverInfo!.subjectId).toBe(subjectA);
    expect(f.journal.list()).toEqual(originalRows);
    expect(f.journal.list()[0]!.intent.request.expectedStoreId).toBe(storeA);
    const factsB = await f.currentRead();
    expect(factsB.storeId).toBe(storeB);
    const portB = f.currentPort();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const rpc = f.rpc;
    const models = f.models;
    const posts = f.posts;
    const gets = f.gets;
    const queries = f.queries;
    const originalFetch = globalThis.fetch;
    let httpGets = 0,
      httpPosts = 0,
      otherHttp = 0;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const method = String(
          args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET'),
        ).toUpperCase();
        if (method === 'GET') httpGets++;
        else if (method === 'POST') httpPosts++;
        else otherHttp++;
        return originalFetch(...args);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const listed = await portB.list();
      expect(listed.map((row) => row.intent)).toEqual([intent]);
      const selected = listed[0]!.intent;
      expect(selected.request.commandId).toBe(intent.request.commandId);
      expect((await portB.lookup(selected, new AbortController().signal)).phase).toBe(
        'outcome_unknown',
      );
      expect((await portB.submit(selected, factsB)).phase).toBe('outcome_unknown');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(httpGets).toBe(0);
    expect(httpPosts).toBe(0);
    expect(otherHttp).toBe(0);
    expect(f.gets).toBe(gets);
    expect(f.posts).toBe(posts);
    expect(f.queries).toBe(queries);
    expect(f.rpc).toEqual(rpc);
    expect(f.models).toBe(models);
    expect(models).toBe(0);
    expect(f.credentials).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
    expect(f.journal.list()).toEqual(originalRows);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'model')).toHaveLength(0);
    console.log(
      JSON.stringify({
        case: 'connection_intent_restore_foreign_before_http',
        storeA,
        storeB,
        subjectId: subjectA,
        commandId: intent.request.commandId,
        actionExecutionId: ready.fact!.execution.id,
        connectionExecutionId: ready.fact!.connection!.id,
        phase: originalRows[0]!.phase,
        manifestVersion: backup.manifest.version,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        httpGets,
        httpPosts,
        otherHttp,
        rpcBefore: rpc.length,
        rpcAfter: f.rpc.length,
        models,
        cursor,
        leasesReleasedForOffline: true,
      }),
    );
    passed = true;
  } finally {
    await f.close(passed);
  }
}, 30000);
