import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type AgentClient, createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type { TuiMcpSourceMutationIntent } from '@kite-ai/ui/tui';
import { openMcpSourceApprovalJournal } from '../../host/mcp-source-approval-journal';
import { openMcpSourceMutationJournal } from '../../host/mcp-source-mutation-journal';
import { createTuiMcpSourceApprovalPort } from '../../host/tui-mcp-source-approval';
import { createTuiMcpSourceMutationPort } from '../../host/tui-mcp-source-mutation';

const signal = () => new AbortController().signal;
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('owned_source_mutation_recovery_deadline');
    await Bun.sleep(5);
  }
}

async function fixture(many: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-mutation-recovery-')));
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const servers: Record<string, { type: string; url: string }> = {};
  for (let i = 0; i < (many ? 52 : 1); i++)
    servers[`source-${String(i).padStart(3, '0')}`] = {
      type: 'http',
      url: 'https://controlled.invalid/mcp',
    };
  const userPath = join(profile.profilePath, 'mcp.json');
  const projectPath = join(workspace, '.kite-code', 'mcp.json');
  writeFileSync(userPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  writeFileSync(projectPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  let access = acquireProfileAccess(profile);
  const journalOptions = () => ({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  let journal = openMcpSourceMutationJournal(journalOptions());
  let approvalJournal = openMcpSourceApprovalJournal(journalOptions());
  let callerOpen = true;
  let vault = 0;
  const backend = createTemporaryCredentialBackend();
  const host = createDefaultProcessConfiguration({
    profile,
    observerSubjectId: 'owner',
    credentialBackend: {
      kind: backend.kind,
      async put(id, secret) {
        vault++;
        await backend.put(id, secret);
      },
      async resolve(id) {
        vault++;
        return backend.resolve(id);
      },
      async remove(id) {
        vault++;
        await backend.remove(id);
      },
    },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: 'ask',
        workspaceTrust: true,
        revision: 'owned-mutation',
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
  const storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    extensions: host.extensions,
    conditions: host.conditions,
    resolveRunConfiguration: host.resolveRunConfiguration,
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    supportsExtensionInputs: host.supportsExtensionInputs,
  });
  host.permissionManagement?.(runtime);
  if (many)
    for (let i = 0; i < 100; i++)
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: `a-${String(i).padStart(3, '0')}`,
        name: 'owned earlier directory item',
        rootUri: `file://${workspace}/`,
      });
  const workspaceId = 'zz-target';
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: workspaceId,
    name: 'owned target',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create-session',
    sessionId: 's',
    subjectId: 'owner',
    workspaceId,
    title: 'owned',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    subjectId: 'owner',
    buildId: 'source-mutation-recovery',
  });
  const makeClient = async () => {
    const next = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['extensions_actions', 'extension_queries', 'interactions'],
      },
    });
    await next.connect();
    return next;
  };
  let client = await makeClient();
  const wire: { method: string; operation: string; commandId?: string }[] = [];
  const tracked = {
    get serverInfo() {
      return client.serverInfo;
    },
    async getView(...args: Parameters<AgentClient['getView']>) {
      wire.push({ method: 'GET', operation: 'view' });
      return client.getView(...args);
    },
    async listAllWorkspaces(...args: Parameters<AgentClient['listAllWorkspaces']>) {
      wire.push({ method: 'GET', operation: 'workspaces' });
      return client.listAllWorkspaces(...args);
    },
    async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
      wire.push({ method: 'GET', operation: `query:${args[2]}` });
      return client.queryExtension(...args);
    },
    async getCommand(...args: Parameters<AgentClient['getCommand']>) {
      wire.push({ method: 'GET', operation: 'command', commandId: args[0] });
      return client.getCommand(...args);
    },
    async invokeExtension(...args: Parameters<AgentClient['invokeExtension']>) {
      wire.push({ method: 'POST', operation: args[1].actionId, commandId: args[1].commandId });
      return client.invokeExtension(...args);
    },
  };
  const sourcePort = () => createTuiMcpSourceApprovalPort(tracked, storeId, approvalJournal);
  const port = () => createTuiMcpSourceMutationPort(tracked, storeId, journal, sourcePort().read);
  async function approve(commandId: string) {
    const interaction = await until(async () => {
      const items = (
        await store.listInteractions({ expectedStoreId: storeId, sessionId: 's', state: 'pending' })
      ).interactions;
      for (const item of items)
        if ((await store.getExecution(item.executionId))?.originCommandId === commandId)
          return item;
      return undefined;
    });
    expect(interaction.kind).toBe('approval');
    await client.answerInteraction('s', interaction.id, {
      commandId: `answer-${interaction.id}`,
      expectedStoreId: storeId,
      expectedRevision: interaction.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
  }
  async function succeeded(commandId: string) {
    return until(async () => {
      const command = await runtime.getCommand(commandId);
      const receipt = command?.receipt;
      const id =
        receipt && typeof receipt === 'object' && !Array.isArray(receipt)
          ? receipt.executionId
          : null;
      if (typeof id !== 'string') return undefined;
      const execution = await runtime.getExecution(id);
      return execution?.status === 'succeeded' ? execution : undefined;
    });
  }
  function offline() {
    client.disposeNetwork();
    journal.close();
    approvalJournal.close();
    access.lock.release();
    callerOpen = false;
  }
  async function reopen() {
    access = acquireProfileAccess(profile);
    journal = openMcpSourceMutationJournal(journalOptions());
    approvalJournal = openMcpSourceApprovalJournal(journalOptions());
    callerOpen = true;
    client = await makeClient();
  }
  return {
    root,
    profile,
    store,
    storeId,
    runtime,
    userPath,
    projectPath,
    workspaceId,
    wire,
    port,
    sourcePort,
    approve,
    succeeded,
    offline,
    reopen,
    get client() {
      return client;
    },
    get journal() {
      return journal;
    },
    get vault() {
      return vault;
    },
    async close() {
      if (callerOpen) offline();
      await service.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** All dropped replies are actual forwarded Service responses, never fabricated DTOs. */
async function relay(f: Awaited<ReturnType<typeof fixture>>) {
  const actualFetch = globalThis.fetch;
  const sockets = new Set<Socket>();
  let forwarding = '',
    originalId = '',
    drop: 'POST' | 'GET' | undefined;
  let posts = 0,
    gets = 0,
    physicalDrops = 0;
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const bytes of request) chunks.push(Buffer.from(bytes));
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value && !['host', 'connection', 'content-length'].includes(key))
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const upstream = await actualFetch(forwarding, {
        method: request.method,
        headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      if (!upstream.ok) throw Error('owned_mutation_relay_upstream_rejected');
      const command = (await upstream.json()) as { id?: string };
      if (command.id !== originalId) throw Error('owned_mutation_relay_original_identity');
      if (request.method === 'POST') await f.succeeded(originalId);
      physicalDrops++;
      response.socket!.destroy();
    } catch (error) {
      failure = error;
      response.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('owned_mutation_relay_address');
  const intercepted = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
    const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
    const body =
      method === 'POST' && typeof args[1]?.body === 'string'
        ? (JSON.parse(args[1].body) as { commandId?: string })
        : undefined;
    const post = method === 'POST' && originalId !== '' && body?.commandId === originalId;
    const get = method === 'GET' && url.pathname === `/v1/commands/${originalId}`;
    if (post) posts++;
    if (get) gets++;
    if (drop && ((drop === 'POST' && post) || (drop === 'GET' && get))) {
      drop = undefined;
      forwarding = url.href;
      return actualFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, args[1]);
    }
    return actualFetch(...args);
  }, actualFetch);
  globalThis.fetch = intercepted;
  return {
    lose(id: string, method: 'POST' | 'GET') {
      originalId = id;
      drop = method;
    },
    counts: () => ({ posts, gets, physicalDrops, relayFailed: failure !== undefined }),
    async close() {
      let cleanup: unknown;
      if (globalThis.fetch === intercepted) globalThis.fetch = actualFetch;
      else cleanup = Error('owned_mutation_relay_fetch_cleanup_unconfirmed');
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      try {
        await f.close();
      } catch (error) {
        cleanup ??= error;
      }
      if (cleanup) throw cleanup;
    },
  };
}

for (const operation of ['add', 'remove'] as const)
  test(`real ${operation} POST reply loss then cold GET loss retains one original publication and no replay`, async () => {
    const f = await fixture(operation === 'remove');
    const r = await relay(f);
    try {
      const observed = await f.sourcePort().read('s', signal());
      expect(observed.storeId).toBe(f.storeId);
      expect(observed.workspaceId).toBe(f.workspaceId);
      expect(observed.readSet).not.toBeNull();
      expect(observed.items).toHaveLength(operation === 'remove' ? 52 : 1);
      if (operation === 'remove') {
        expect((await f.client.listWorkspaces()).some((item) => item.id === f.workspaceId)).toBe(
          false,
        );
        expect(
          (await f.client.listAllWorkspaces()).find((item) => item.id === f.workspaceId)?.rootUri,
        ).toBe(`file://${join(f.root, 'workspace')}/`);
        expect(f.wire.filter((row) => row.operation === 'query:mcp.sources').length).toBe(3);
      }
      const item = observed.items.at(-1)!;
      const intent: TuiMcpSourceMutationIntent = {
        sessionId: 's',
        workspaceId: f.workspaceId,
        workspaceIdentity: observed.workspaceIdentity,
        request: {
          kind: 'extension.invoke',
          expectedStoreId: f.storeId,
          commandId: `original-${operation}`,
          extensionId: 'builtin.mcp.sources',
          actionId: operation === 'add' ? 'mcp.source.add' : 'mcp.source.remove',
          definitionVersion: '1',
          input:
            operation === 'add'
              ? {
                  scope: 'workspace',
                  name: 'new-source',
                  entry: { type: 'http', url: 'https://controlled.invalid/new' },
                  expectedReadSet: observed.readSet!,
                }
              : {
                  scope: 'user',
                  serverId: item.id,
                  expectedRawEntryDigest: item.rawEntryDigest,
                  expectedReadSet: observed.readSet!,
                },
        },
      };
      r.lose(intent.request.commandId, 'POST');
      const submitting = f.port().submit(intent, observed);
      await f.approve(intent.request.commandId);
      expect((await submitting).phase).toBe('outcome_unknown');
      const execution = await f.succeeded(intent.request.commandId);
      expect(execution.kind).toBe('job');
      expect(execution.runId).toBeNull();
      expect(r.counts()).toMatchObject({ posts: 1, physicalDrops: 1, relayFailed: false });
      expect(f.journal.list()[0]?.phase).toBe('outcome_unknown');
      const path = join(f.profile.profilePath, 'ui/mcp-source-mutation-intents.json');
      const bytes = readFileSync(path);
      const sourceBytes = readFileSync(operation === 'add' ? f.projectPath : f.userPath);
      if (operation === 'add')
        expect(
          JSON.parse(sourceBytes.toString()).mcpServers['new-source']._kiteSourceCreation,
        ).toEqual({ version: 1, operationId: execution.id });
      else expect(Object.keys(JSON.parse(sourceBytes.toString()).mcpServers)).toHaveLength(51);
      f.offline();
      await f.reopen();
      expect(f.client.serverInfo?.storeId).toBe(f.storeId);
      expect(f.client.serverInfo?.subjectId).toBe('owner');
      const before = f.wire.length;
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      const rows = await f.port().list();
      expect(rows).toEqual([{ intent, phase: 'outcome_unknown' }]);
      // Selecting the exact durable row is a local list operation, not a network lookup.
      expect(
        rows.find((row) => row.intent.request.commandId === intent.request.commandId)?.intent,
      ).toEqual(intent);
      expect(f.wire).toHaveLength(before);
      expect(readFileSync(path)).toEqual(bytes);
      r.lose(intent.request.commandId, 'GET');
      expect((await f.port().lookup(intent, signal())).phase).toBe('outcome_unknown');
      expect(r.counts()).toMatchObject({ posts: 1, physicalDrops: 2, relayFailed: false });
      expect(readFileSync(path)).toEqual(bytes);
      const recovered = await f.port().lookup(intent, signal());
      expect(recovered.phase).toBe('saved');
      expect(recovered.fact?.receipt?.operationId).toBe(execution.id);
      expect(recovered.fact?.execution?.originCommandId).toBe(intent.request.commandId);
      expect((await f.port().submit(intent, observed)).phase).toBe('saved');
      expect(r.counts().posts).toBe(1);
      expect(
        f.wire
          .slice(before)
          .every(
            (row) =>
              row.method === 'GET' &&
              ['command', 'query:mcp.source.mutation.result'].includes(row.operation),
          ),
      ).toBe(true);
      expect(
        f.wire
          .slice(before)
          .filter((row) => row.operation === 'command')
          .every((row) => row.commandId === intent.request.commandId),
      ).toBe(true);
      expect(readFileSync(operation === 'add' ? f.projectPath : f.userPath)).toEqual(sourceBytes);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(f.vault).toBe(0);
      const db = new Database(f.profile.databasePath, { readonly: true });
      try {
        expect(db.query('SELECT COUNT(*) AS n FROM run').get()).toEqual({ n: 0 });
        expect(
          db
            .query(
              "SELECT COUNT(*) AS n FROM execution WHERE kind='model' OR adapter_id='mcp.source.connection' OR adapter_id LIKE 'mcp.connection.%'",
            )
            .get(),
        ).toEqual({ n: 0 });
        expect(
          db.query("SELECT COUNT(*) AS n FROM host_mutation WHERE id LIKE 'mcp-entry-%'").get(),
        ).toEqual({ n: 1 });
      } finally {
        db.close();
      }
      expect(
        (
          await f.store.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' })
        ).interactions.filter((item) => item.kind === 'question'),
      ).toEqual([]);
      console.log(
        JSON.stringify({
          stage: 'source_mutation_original_recovery',
          operation,
          storeId: f.storeId,
          sessionId: intent.sessionId,
          workspaceId: intent.workspaceId,
          subjectId: f.client.serverInfo!.subjectId,
          commandId: intent.request.commandId,
          executionId: execution.id,
          mutationId: recovered.fact!.mutation!.id,
          cursorBeforeRead: cursor,
          cursorAfterRead: (await f.store.getMetadata()).lastChangeCursor,
          ...r.counts(),
        }),
      );
    } finally {
      await r.close();
    }
  }, 20000);
