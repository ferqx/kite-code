import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
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
import { createMcpConnectionRecord } from '../../host/mcp-connection-intents';
import { openMcpConnectionJournal } from '../../host/mcp-connection-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';
import { createTuiMcpConnectionPort, decodeMcpConnectionFact } from '../../host/tui-mcp-connection';

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
  const access = acquireProfileAccess(profile);
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
      async close() {
        await stop();
        journal.close();
        access.lock.release();
        peer.stop(true);
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
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

test('actual default Action and connection Job need two original approvals, preserve original ready and warm reuse, and cold lookup only reads', async () => {
  const f = await fixture(true);
  try {
    const facts = await f.read(),
      intent = original(facts, 'connect-a'),
      port = f.port();
    expect(facts.items[0]).toMatchObject({ admitted: true, selected: true, available: true });
    expect(f.rpc).toEqual([]);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
    const pending = await port.submit(intent, facts);
    expect(pending.phase).toBe('pending');
    expect(f.posts).toBe(1);
    expect(f.rpc).toEqual([]);
    await f.approve(intent.request.commandId, 'builtin.mcp/mcp.connect');
    const jobApproval = await until(async () =>
      (
        await f.client.listInteractions('s', { storeId: f.storeId, state: 'pending', limit: 20 })
      ).interactions.find(
        (row) => row.state === 'pending' && row.definitionId === 'mcp.source.connection',
      ),
    );
    expect(f.rpc).toEqual([]);
    await f.approve(intent.request.commandId, 'mcp.source.connection');
    const ready = await f.ready(intent, port);
    expect(ready.fact).toMatchObject({
      phase: 'ready',
      live: true,
      created: true,
      currentGeneration: 1,
      ready: { serverId: intent.request.input.serverId, toolCount: 1, generation: 1 },
    });
    expect(ready.fact?.connection?.id).toBe(jobApproval.executionId);
    expect(ready.fact?.connection?.parentExecutionId).toBe(ready.fact?.execution.id);
    expect(ready.fact?.connection?.status).toBe('running');
    expect(f.rpc).toEqual(['initialize', 'tools/list']);
    const rpc = f.rpc,
      warm = original(await f.read(), 'connect-b');
    expect((await port.submit(warm, await f.read())).phase).toBe('pending');
    await f.approve(warm.request.commandId, 'builtin.mcp/mcp.connect');
    const reused = await f.ready(warm, port);
    expect(reused.fact).toMatchObject({ created: false, live: true });
    expect(reused.fact?.connection?.id).toBe(ready.fact?.connection?.id);
    expect(reused.fact?.operationRef?.key).toBe(ready.fact?.operationRef?.key);
    expect(f.rpc).toEqual(rpc);
    const originals = f.journal.list().map((row) => row.intent);
    await f.restart(true);
    const cold = f.port(),
      posts = f.posts,
      gets = f.gets;
    expect((await f.read()).items).toEqual([]);
    expect((await cold.list()).map((row) => row.intent)).toEqual(originals);
    expect(f.gets).toBe(gets);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const historical = await cold.lookup(intent, new AbortController().signal);
    expect(historical.fact).toMatchObject({
      phase: 'ready',
      live: false,
      currentGeneration: null,
      created: true,
    });
    expect(historical.fact?.execution.id).toBe(ready.fact?.execution.id);
    expect(historical.fact?.operationRef).toEqual(ready.fact?.operationRef);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.posts).toBe(posts);
    expect(f.rpc).toEqual(rpc);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
    expect((await f.store.getView('s')).runs).toHaveLength(0);
    expect(JSON.stringify(historical)).not.toContain('RAW_PRIVATE_CONNECTION_MARKER');
    expect(JSON.stringify(historical)).not.toContain(
      new URL(
        f.source.includes('http') ? JSON.parse(f.source).mcpServers.owned.url : 'http://127.0.0.1',
      ).href,
    );
    console.log(
      JSON.stringify({
        case: 'connection_original_new_warm_cold',
        storeId: f.storeId,
        original: {
          commandId: intent.request.commandId,
          actionId: ready.fact!.execution.id,
          jobId: ready.fact!.connection!.id,
          operationRef: ready.fact!.operationRef,
        },
        warm: {
          commandId: warm.request.commandId,
          actionId: reused.fact!.execution.id,
          jobId: reused.fact!.connection!.id,
          created: reused.fact!.created,
        },
        cold: {
          actionId: historical.fact!.execution.id,
          live: historical.fact!.live,
          currentGeneration: historical.fact!.currentGeneration,
          cursor,
        },
        connectionPosts: f.posts,
        rpc: f.rpc,
        models: f.models,
        credentials: f.credentials,
      }),
    );
  } finally {
    await f.close();
  }
}, 30000);

test('actual current Workspace beyond the legacy first hundred remains eligible through the complete public directory', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 101; n++)
      await f.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: `a${String(n).padStart(3, '0')}`,
        name: `Owned ${n}`,
        rootUri: pathToFileURL(f.workspace).href,
      });
    const legacy = await f.client.listWorkspaces();
    expect(legacy).toHaveLength(100);
    expect(legacy.some((row) => row.id === 'w')).toBe(false);
    let completeReads = 0,
      legacyReads = 0;
    const observedClient = {
      ...f.tracked,
      async listWorkspaces(...args: Parameters<AgentClient['listWorkspaces']>) {
        legacyReads++;
        return f.tracked.listWorkspaces(...args);
      },
      async listAllWorkspaces(...args: Parameters<AgentClient['listAllWorkspaces']>) {
        completeReads++;
        return f.tracked.listAllWorkspaces(...args);
      },
    };
    const port = createTuiMcpConnectionPort(observedClient, f.storeId, f.journal);
    const facts = await f.read(),
      intent = original(facts, 'after-page-one');
    expect(facts.workspaceId).toBe('w');
    await port.submit(intent, facts);
    const ready = await f.ready(intent, port);
    expect(ready.phase).toBe('ready');
    expect(ready.fact!.created).toBe(true);
    expect(completeReads).toBe(1);
    expect(legacyReads).toBe(0);
    expect(f.posts).toBe(1);
    expect(f.rpc).toEqual(['initialize', 'tools/list']);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
    console.log(
      JSON.stringify({
        case: 'connection_workspace_after_100',
        storeId: f.storeId,
        workspaceId: facts.workspaceId,
        legacyRows: legacy.length,
        completeReads,
        actionId: ready.fact!.execution.id,
        jobId: ready.fact!.connection!.id,
        connectionPosts: f.posts,
      }),
    );
  } finally {
    await f.close();
  }
}, 30000);

test('actual lost acceptance reply preserves original ID, blocks a new key, cold duplicate submits are GET-only and explicit fresh cold intent creates a new Job', async () => {
  const f = await fixture();
  try {
    const facts = await f.read(),
      intent = original(facts, 'lost');
    const losing = createTuiMcpConnectionPort(
      {
        ...f.tracked,
        async invokeExtension(...args) {
          await f.tracked.invokeExtension(...args);
          throw Error('owned_reply_lost');
        },
      },
      f.storeId,
      f.journal,
    );
    expect((await losing.submit(intent, facts)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(1);
    const port = f.port(),
      next = original(facts, 'blocked-new');
    expect((await port.submit(next, facts)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(1);
    const ready = await f.ready(intent, port);
    const oldJob = ready.fact!.connection!.id,
      oldAction = ready.fact!.execution.id;
    await f.restart();
    const cold = f.port(),
      originalBytes = readFileSync(join(f.profile.profilePath, 'ui/mcp-connection-intents.json'));
    expect((await cold.submit(intent, await f.read())).phase).toBe('ready');
    expect(f.posts).toBe(1);
    expect(f.rpc).toHaveLength(2);
    expect(readFileSync(join(f.profile.profilePath, 'ui/mcp-connection-intents.json'))).toEqual(
      originalBytes,
    );
    const freshFacts = await f.read(),
      fresh = original(freshFacts, 'fresh-cold');
    await cold.submit(fresh, freshFacts);
    const freshReady = await f.ready(fresh, cold);
    expect(freshReady.fact).toMatchObject({ live: true, created: true });
    expect(freshReady.fact!.execution.id).not.toBe(oldAction);
    expect(freshReady.fact!.connection!.id).not.toBe(oldJob);
    expect(f.posts).toBe(2);
    expect(f.rpc).toEqual(['initialize', 'tools/list', 'initialize', 'tools/list']);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

test('actual fresh source drift and unknown phantom refuse a new POST, foreign subject/Store and malformed original proof do not relabel ready', async () => {
  const f = await fixture();
  try {
    const facts = await f.read(),
      drift = original(facts, 'drift');
    writeFileSync(
      f.sourcePath,
      f.source.replace('RAW_PRIVATE_CONNECTION_MARKER', 'CHANGED_PRIVATE_CONNECTION_MARKER'),
    );
    expect((await f.port().submit(drift, facts)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(0);
    expect(f.rpc).toEqual([]);
    expect(f.journal.list()).toHaveLength(0);
    writeFileSync(f.sourcePath, f.source);
    const freshFacts = await f.read(),
      intent = original(freshFacts, 'actual-ready'),
      port = f.port();
    await port.submit(intent, freshFacts);
    const ready = await f.ready(intent, port),
      calls = f.gets,
      posts = f.posts;
    const foreign = { ...intent, request: { ...intent.request, expectedStoreId: 'foreign-store' } };
    expect((await port.lookup(foreign, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.gets).toBe(calls);
    expect(f.posts).toBe(posts);
    const alien = createTuiMcpConnectionPort(
      {
        ...f.tracked,
        get serverInfo() {
          return { ...f.tracked.serverInfo!, subjectId: 'foreign-subject' };
        },
      },
      f.storeId,
      f.journal,
    );
    expect((await alien.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.gets).toBe(calls);
    const forged = createTuiMcpConnectionPort(
      {
        ...f.tracked,
        async queryExtension(...args) {
          const result = await f.tracked.queryExtension(...args);
          if (args[2] === 'mcp.connection') {
            const copy = structuredClone(result);
            const payload = copy[0]!.payload as Record<string, unknown>;
            payload.created = false;
            return copy;
          }
          return result;
        },
      },
      f.storeId,
      f.journal,
    );
    expect((await forged.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.journal.list()[0]!.phase).toBe('ready');
    const projection = await f.client.queryExtension('s', 'builtin.mcp', 'mcp.connection', {
      executionId: ready.fact!.execution.id,
      ...intent.request.input,
    });
    expect(decodeMcpConnectionFact(projection).phase).toBe('ready');
    for (const mutate of [
      (row: Record<string, unknown>) => {
        row.phase = ['ready'];
      },
      (row: Record<string, unknown>) => {
        row.extra = 'untrusted';
      },
      (row: Record<string, unknown>) => {
        row.ready = { ...(row.ready as object), definitions: ['unbounded'] };
      },
    ]) {
      const copy = structuredClone(projection);
      mutate(copy[0]!.payload as Record<string, unknown>);
      expect(() => decodeMcpConnectionFact(copy)).toThrow();
    }
    const huge = structuredClone(projection);
    huge[0]!.summary = 'x'.repeat(16384);
    expect(() => decodeMcpConnectionFact(huge)).toThrow();
    const phantom = original(await f.read(), 'phantom');
    phantom.request.input.serverId = 'different-server';
    const saved = createMcpConnectionRecord(phantom, 'owned-subject');
    f.journal.prepare(saved);
    const before = readFileSync(join(f.profile.profilePath, 'ui/mcp-connection-intents.json'));
    expect((await port.lookup(phantom, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(readFileSync(join(f.profile.profilePath, 'ui/mcp-connection-intents.json'))).toEqual(
      before,
    );
    expect(f.posts).toBe(posts);
    expect(f.models).toBe(0);
    expect(f.credentials).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);
