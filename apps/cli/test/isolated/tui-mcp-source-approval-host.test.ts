import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type AgentClient, createClient, type QueryResponse } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type { TuiMcpSourceApprovalIntent, TuiMcpSourceSnapshot } from '@kite-ai/ui/tui';
import { mcpSha } from '../../host/mcp-selection-intents';
import { openMcpSourceApprovalJournal } from '../../host/mcp-source-approval-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';
import {
  createTuiMcpSourceApprovalPort,
  decodeMcpSourceApprovalFact,
  decodeMcpSourcePage,
} from '../../host/tui-mcp-source-approval';

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('source_host_deadline');
    await Bun.sleep(5);
  }
}
const intent = (
  snapshot: TuiMcpSourceSnapshot,
  commandId: string,
  serverId = snapshot.items.find((row) => row.name === 'target')!.id,
): TuiMcpSourceApprovalIntent => {
  if (!snapshot.readSet) throw Error('source_snapshot_unavailable');
  return {
    sessionId: snapshot.sessionId,
    workspaceId: snapshot.workspaceId,
    workspaceIdentity: snapshot.workspaceIdentity,
    request: {
      expectedStoreId: snapshot.storeId,
      commandId,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.approve',
      definitionVersion: '1',
      input: { serverId, expectedReadSet: snapshot.readSet },
    },
  };
};
async function fixture(many = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-source-host-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let access = acquireProfileAccess(profile),
    journal = openJournal();
  function openJournal() {
    return openMcpSourceApprovalJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  }
  let rpc = 0,
    models = 0,
    vault = 0;
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response(null, { status: 500 });
    },
  });
  const model = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      models++;
      return new Response(null, { status: 500 });
    },
  });
  const source = {
    type: 'http',
    url: peer.url.href,
    auth: { type: 'none' },
    private: 'PRIVATE_RAW_SOURCE_MARKER',
  };
  const declarations = Object.fromEntries(
    Array.from({ length: many ? 102 : 2 }, (_, i) => [
      i ? `source-${i}` : 'target',
      { ...source, ...(i === 1 ? { enabled: false } : {}) },
    ]),
  );
  if (many) declarations['invalid name 🙂'] = source;
  const sourcePath = join(workspace, '.kite-code/mcp.json');
  writeFileSync(sourcePath, JSON.stringify({ mcpServers: declarations }), { mode: 0o600 });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${model.url.href}v1` },
      ],
    }),
    { mode: 0o600 },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined,
    client: AgentClient | undefined;
  let reads = 0,
    posts = 0,
    commandGets = 0;
  const current = () => {
    if (!client) throw Error('owned_source_client_closed');
    return client;
  };
  const storeId = () => {
    const id = current().serverInfo?.storeId;
    if (!id) throw Error('owned_source_store_missing');
    return id;
  };
  const tracked = {
    get serverInfo() {
      return current().serverInfo;
    },
    async getView(...args: Parameters<AgentClient['getView']>) {
      reads++;
      return current().getView(...args);
    },
    async listAllWorkspaces(...args: Parameters<AgentClient['listAllWorkspaces']>) {
      reads++;
      return current().listAllWorkspaces(...args);
    },
    async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
      reads++;
      return current().queryExtension(...args);
    },
    async invokeExtension(...args: Parameters<AgentClient['invokeExtension']>) {
      posts++;
      return current().invokeExtension(...args);
    },
    async getCommand(...args: Parameters<AgentClient['getCommand']>) {
      reads++;
      commandGets++;
      return current().getCommand(...args);
    },
  };
  async function start() {
    const backend = createTemporaryCredentialBackend();
    const configuration = createDefaultProcessConfiguration({
      profile,
      observerSubjectId: 'owner',
      mcpSources: { http: { allowLoopbackForTests: true } },
      credentialBackend: {
        ...backend,
        async resolve(ref) {
          vault++;
          return backend.resolve(ref);
        },
      },
      permissionPolicy: {
        readPolicy: (request) => ({
          mode: 'full',
          workspaceTrust: true,
          revision: 'owned-source-policy',
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
      artifacts: createArtifactStore({ profile, store }),
      permissions: configuration.permissions!,
      extensions: configuration.extensions,
      supportsExtensionInputs: configuration.supportsExtensionInputs,
      resolveRunConfiguration: configuration.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: configuration.resolveRecoveryRunConfiguration,
    });
    configuration.permissionManagement?.(runtime);
    service = await startService({
      runtime,
      subjectId: 'owner',
      buildId: 'owned-source-host',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      configurationManagement: configuration.configurationManagement!(runtime),
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'extension_queries', 'extensions_actions'],
      },
    });
    await client.connect();
  }
  async function stop() {
    client?.disposeNetwork();
    client = undefined;
    if (service) {
      await service.close();
      service = undefined;
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
  const port = () => createTuiMcpSourceApprovalPort(tracked, storeId(), journal);
  try {
    await start();
    const id = storeId();
    if (many)
      for (let n = 0; n < 101; n++)
        await current().createWorkspace({
          expectedStoreId: id,
          id: `w-${String(n).padStart(3, '0')}`,
          name: 'unused',
          rootUri: pathToFileURL(workspace).href,
        });
    await current().createWorkspace({
      expectedStoreId: id,
      id: 'w-zz',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const s of ['s', 'another-s'])
      await current().createSession({
        expectedStoreId: id,
        commandId: `create-${s}`,
        sessionId: s,
        workspaceId: 'w-zz',
        title: 'owned',
      });
    return {
      root,
      workspace,
      sourcePath,
      profile,
      tracked,
      port,
      get client() {
        return current();
      },
      get journal() {
        return journal;
      },
      get store() {
        return store!;
      },
      get runtime() {
        return runtime!;
      },
      counts() {
        return { reads, posts, commandGets, rpc, models, vault };
      },
      async answer(commandId: string, decision: 'approved' | 'rejected' | 'cancel') {
        const card = await until(async () => {
          const list = await current().listInteractions('s', {
            storeId: storeId(),
            state: 'pending',
            limit: 20,
          });
          for (const candidate of list.interactions) {
            if (
              candidate.kind !== 'question' ||
              candidate.definitionId !== 'builtin.mcp.sources/mcp.source.approve'
            )
              continue;
            if ((await store!.getExecution(candidate.executionId))?.originCommandId === commandId)
              return candidate;
          }
          return undefined;
        });
        const actual = await runtime!.getInteraction({
          interactionId: card.id,
          expectedStoreId: storeId(),
          sessionId: 's',
        });
        expect(card.definitionVersion).toBe('1');
        expect(actual?.subjectId).toBe('owner');
        await current().answerInteraction('s', card.id, {
          expectedStoreId: storeId(),
          commandId: `answer-${commandId}`,
          expectedRevision: card.revision,
          answer: { kind: 'question', answers: { decision } },
        });
        return actual!;
      },
      async settle(row: TuiMcpSourceApprovalIntent, phase: 'pending' | 'saved' | 'cancelled') {
        return until(async () => {
          const value = await port().lookup(row, new AbortController().signal);
          return value.phase === phase ? value : undefined;
        });
      },
      async restart() {
        await stop();
        journal.close();
        journal = openJournal();
        await start();
      },
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
      async close() {
        await stop();
        journal.close();
        access.lock.release();
        peer.stop(true);
        model.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    journal.close();
    access.lock.release();
    peer.stop(true);
    model.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
test('Source Host uses complete public Workspace and safe Source pagination; invalid safe names retain original IDs', async () => {
  const f = await fixture(true);
  try {
    expect(await f.client.listWorkspaces()).toHaveLength(100);
    const snapshot = await f.port().read('s', new AbortController().signal);
    expect(snapshot.workspaceId).toBe('w-zz');
    expect(snapshot.items).toHaveLength(103);
    const invalid = snapshot.items.find((row) => row.name.startsWith('invalid-'))!;
    expect(invalid.id).toBe(`mcp-${mcpSha({ name: 'invalid name 🙂' })}`);
    expect(invalid.id).not.toBe(`mcp-${mcpSha({ name: invalid.name })}`);
    expect(invalid.transport).toBeNull();
    expect(JSON.stringify(snapshot.items)).not.toContain('PRIVATE_RAW_SOURCE_MARKER');
    expect(JSON.stringify(snapshot.items)).not.toContain('127.0.0.1');
    expect(snapshot.items.find((row) => row.name === 'source-1')?.enabled).toBe(false);
    const row = intent(snapshot, 'source-many');
    const outcome = await f.port().submit(row, snapshot);
    expect(outcome.intent).toEqual(row);
    expect(f.counts().posts).toBe(1);
    const pending = await until(async () => {
      const observed = await f.port().lookup(row, new AbortController().signal);
      return observed.phase === 'pending' ? observed : undefined;
    });
    expect(pending.phase).toBe('pending');
    expect(pending.fact?.serverId).toBe(row.request.input.serverId);
    expect(f.counts().posts).toBe(1);
    const question = await f.answer(row.request.commandId, 'approved');
    const saved = await f.settle(row, 'saved');
    expect(saved.fact?.proof?.requestDigest).toBe(mcpSha(question.request));
    expect(saved.fact?.decision).toBe('approved');
    expect(saved.fact?.mutation?.id).toBe(`mcp-source-${saved.fact?.execution?.id}`);
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
  } finally {
    await f.close();
  }
}, 20000);
test('Source Review records approved, rejected and explicit cancel, while cold removed-source history is GET-only', async () => {
  const f = await fixture();
  try {
    let first!: TuiMcpSourceApprovalIntent;
    for (const decision of ['approved', 'rejected', 'cancel'] as const) {
      const snapshot = await f.port().read('s', new AbortController().signal),
        row = intent(snapshot, `review-${decision}`);
      first ??= row;
      const posts = f.counts().posts,
        submitted = await f.port().submit(row, snapshot);
      expect(submitted.intent).toEqual(row);
      expect(['pending', 'outcome_unknown']).toContain(submitted.phase);
      expect(f.counts().posts).toBe(posts + 1);
      expect((await f.settle(row, 'pending')).phase).toBe('pending');
      expect(f.counts().posts).toBe(posts + 1);
      const question = await f.answer(row.request.commandId, decision),
        result = await f.settle(row, decision === 'cancel' ? 'cancelled' : 'saved');
      expect(result.fact?.decision).toBe(decision);
      expect(result.fact?.proof?.interactionId).toBe(question.id);
      expect(result.fact?.proof?.subjectId).toBe('owner');
      expect(result.fact?.proof?.requestDigest).toBe(mcpSha(question.request));
      const mutation = await f.runtime.getHostMutation({
        commandId: `mcp-source-${result.fact?.execution?.id}`,
        expectedStoreId: row.request.expectedStoreId,
        subjectId: 'owner',
      });
      if (decision === 'cancel') {
        expect(mutation).toBeNull();
        expect(result.fact?.mutation).toBeNull();
      } else {
        expect(mutation?.state).toBe('applied');
        expect(result.fact?.mutation?.requestDigest).toBe(mutation?.requestDigest);
      }
    }
    const before = f.counts();
    await f.restart();
    renameSync(f.workspace, `${f.workspace}-removed`);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const bytes = readFileSync(join(f.profile.profilePath, 'ui/mcp-source-approval-intents.json'));
    const listed = await f.port().list();
    expect(listed).toHaveLength(3);
    expect(f.counts()).toEqual(before);
    expect((await f.port().lookup(first, new AbortController().signal)).phase).toBe('saved');
    expect((await f.port().submit(first, {} as TuiMcpSourceSnapshot)).phase).toBe('saved');
    expect(f.counts().posts).toBe(3);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      readFileSync(join(f.profile.profilePath, 'ui/mcp-source-approval-intents.json')),
    ).toEqual(bytes);
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
  } finally {
    await f.close();
  }
}, 20000);
test('Source drift, wrong scope and cross Session unresolved decisions refuse every new POST', async () => {
  const f = await fixture();
  try {
    const port = f.port(),
      snapshot = await port.read('s', new AbortController().signal);
    const wrong = intent(snapshot, 'wrong-w');
    wrong.workspaceId = 'other-w';
    expect((await port.submit(wrong, snapshot)).phase).toBe('outcome_unknown');
    expect(f.counts().posts).toBe(0);
    expect(f.journal.list()).toHaveLength(0);
    const stale = intent(snapshot, 'stale');
    writeFileSync(
      f.sourcePath,
      JSON.stringify({
        mcpServers: {
          target: {
            type: 'http',
            url: 'https://controlled.invalid/changed',
            auth: { type: 'none' },
          },
        },
      }),
    );
    expect((await port.submit(stale, snapshot)).phase).toBe('outcome_unknown');
    expect(f.counts().posts).toBe(0);
    expect(f.journal.list()).toHaveLength(0);
    const fresh = await port.read('s', new AbortController().signal),
      original = intent(fresh, 'pending');
    const submitted = await port.submit(original, fresh);
    expect(submitted.intent).toEqual(original);
    expect(['pending', 'outcome_unknown']).toContain(submitted.phase);
    expect(f.counts().posts).toBe(1);
    expect((await f.settle(original, 'pending')).phase).toBe('pending');
    expect(f.counts().posts).toBe(1);
    const next = await port.read('another-s', new AbortController().signal),
      conflict = intent(next, 'different-session');
    expect((await port.submit(conflict, next)).phase).toBe('outcome_unknown');
    expect(f.counts().posts).toBe(1);
    expect(f.journal.list()).toHaveLength(1);
    const subject = f.tracked.serverInfo!.subjectId,
      currentReads = f.counts().reads;
    const changedSubject = {
      ...f.tracked,
      serverInfo: { ...f.tracked.serverInfo!, subjectId: `${subject}-other` },
    };
    expect(
      (
        await createTuiMcpSourceApprovalPort(
          changedSubject,
          original.request.expectedStoreId,
          f.journal,
        ).lookup(original, new AbortController().signal)
      ).phase,
    ).toBe('outcome_unknown');
    expect(f.counts().reads).toBe(currentReads);
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
  } finally {
    await f.close();
  }
}, 20000);
test('changed Source page versions and malformed finite envelopes never yield a partial complete snapshot', async () => {
  const f = await fixture(true);
  try {
    let pages = 0;
    const altered = {
      ...f.tracked,
      async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
        const result = await f.tracked.queryExtension(...args);
        if (args[2] === 'mcp.sources' && pages++ > 0)
          (result[0]!.payload as Record<string, unknown>).registryRevision = 'e'.repeat(64);
        return result;
      },
    };
    await expect(
      createTuiMcpSourceApprovalPort(altered, f.client.serverInfo!.storeId!, f.journal).read(
        's',
        new AbortController().signal,
      ),
    ).rejects.toThrow('mcp_source_approval_directory_changed');
    expect(pages).toBe(2);
    expect(f.counts().posts).toBe(0);
    expect(f.journal.list()).toHaveLength(0);
    const result = await f.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {
      limit: 25,
    });
    for (const mutate of [
      (r: QueryResponse) => {
        (r[0]!.payload as Record<string, unknown>).nextAfterId = `mcp-${'0'.repeat(64)}`;
      },
      (r: QueryResponse) => {
        r[0]!.actions.push({} as never);
      },
      (r: QueryResponse) => {
        (r[0]!.payload as Record<string, unknown>).raw = 'private';
      },
      (r: QueryResponse) => {
        (r[0]!.payload as Record<string, unknown>).errors = {
          'approval,binding': null,
          'user,workspace': null,
        };
      },
      (r: QueryResponse) => {
        const payload = r[0]!.payload as { readSet: TuiMcpSourceSnapshot['readSet'] };
        payload.readSet!.user.error = 'x'.repeat(64 * 1024);
      },
    ]) {
      const bad = structuredClone(result);
      mutate(bad);
      expect(() => decodeMcpSourcePage(bad)).toThrow();
    }
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
  } finally {
    await f.close();
  }
}, 20000);
test('finite Source pages preserve the 8192 caller budget and refuse one extra row without a partial snapshot or POST', async () => {
  const f = await fixture();
  try {
    const actual = await f.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {
      limit: 25,
    });
    const template = decodeMcpSourcePage(actual).items[0]!;
    // Real public scope/version and row shape; synthetic pages qualify only the caller budget.
    let count = 8192,
      pages = 0;
    const paged = {
      ...f.tracked,
      async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
        if (args[2] !== 'mcp.sources') return f.tracked.queryExtension(...args);
        pages++;
        const input = args[3] as { afterId?: string; limit: number },
          start = input.afterId ? Number.parseInt(input.afterId.slice(4), 16) + 1 : 0;
        expect(input.limit).toBe(25);
        const items = Array.from({ length: Math.min(25, count - start) }, (_, i) => ({
          ...template,
          id: `mcp-${(start + i).toString(16).padStart(64, '0')}`,
          name: `source-${start + i}`,
        }));
        const result = structuredClone(actual);
        Object.assign(result[0]!.payload as Record<string, unknown>, {
          items,
          nextAfterId: start + items.length < count ? items.at(-1)!.id : null,
        });
        return result;
      },
    };
    const port = createTuiMcpSourceApprovalPort(paged, f.client.serverInfo!.storeId!, f.journal);
    expect((await port.read('s', new AbortController().signal)).items).toHaveLength(8192);
    expect(pages).toBe(328);
    count = 8193;
    pages = 0;
    await expect(port.read('s', new AbortController().signal)).rejects.toThrow(
      'mcp_source_approval_directory_limit',
    );
    expect(pages).toBe(328);
    expect(f.journal.list()).toHaveLength(0);
    expect(f.counts()).toMatchObject({ posts: 0, rpc: 0, models: 0, vault: 0 });
  } finally {
    await f.close();
  }
}, 20000);
test('physical POST reply loss after actual Source publication keeps unknown; cold original GET loss never repeats POST', async () => {
  const f = await fixture();
  const actualFetch = globalThis.fetch,
    sockets = new Set<Socket>();
  let forwarding = '',
    drop: 'post' | 'get' | undefined,
    physicalDrops = 0,
    originalGets = 0,
    relayFailure: unknown;
  let original!: TuiMcpSourceApprovalIntent;
  let published!: ReturnType<typeof decodeMcpSourceApprovalFact>;
  const relay = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const bytes of request) body += bytes;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value && !['host', 'connection', 'content-length'].includes(key))
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const upstream = await actualFetch(forwarding, {
        method: request.method,
        headers,
        ...(request.method === 'POST' ? { body } : {}),
      });
      expect(upstream.ok).toBe(true);
      const command = await upstream.json();
      expect(command.id).toBe(original.request.commandId);
      if (request.method === 'POST') {
        await f.answer(original.request.commandId, 'approved');
        published = await until(async () => {
          const fact = decodeMcpSourceApprovalFact(
            await f.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.source.result', {
              commandId: original.request.commandId,
            }),
          );
          return fact.phase === 'saved' ? fact : undefined;
        });
        expect(published.mutation?.state).toBe('applied');
      }
      physicalDrops++;
      response.socket!.destroy();
    } catch (error) {
      relayFailure = error;
      response.destroy();
    }
  });
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    if (address === null || typeof address === 'string') throw Error('source_relay_unavailable');
    const relayOrigin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const url = new URL(String(args[0])),
        method = args[1]?.method ?? 'GET';
      const posted =
        method === 'POST' && typeof args[1]?.body === 'string'
          ? JSON.parse(args[1].body)
          : undefined;
      const isOriginalGet =
        method === 'GET' && url.pathname === `/v1/commands/${original?.request.commandId}`;
      if (isOriginalGet) originalGets++;
      if (
        (drop === 'post' && posted?.commandId === original?.request.commandId) ||
        (drop === 'get' && isOriginalGet)
      ) {
        drop = undefined;
        forwarding = url.href;
        return actualFetch(`${relayOrigin}${url.pathname}${url.search}`, args[1]);
      }
      return actualFetch(...args);
    }, actualFetch);
    const snapshot = await f.port().read('s', new AbortController().signal);
    original = intent(snapshot, 'published-original');
    drop = 'post';
    expect((await f.port().submit(original, snapshot)).phase).toBe('outcome_unknown');
    expect(relayFailure).toBeUndefined();
    expect(physicalDrops).toBe(1);
    expect(published.phase).toBe('saved');
    expect(f.journal.list()[0]?.phase).toBe('outcome_unknown');
    expect(f.counts().posts).toBe(1);
    const different = await f.port().read('another-s', new AbortController().signal);
    expect((await f.port().submit(intent(different, 'new-session-bypass'), different)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.counts().posts).toBe(1);
    const journalPath = join(f.profile.profilePath, 'ui/mcp-source-approval-intents.json'),
      unknownBytes = readFileSync(journalPath);
    await f.restart();
    renameSync(f.workspace, `${f.workspace}-removed`);
    const before = f.counts(),
      cursor = (await f.store.getMetadata()).lastChangeCursor,
      gets = originalGets;
    const cold = await f.port().list();
    expect(cold).toEqual([{ intent: original, phase: 'outcome_unknown' }]);
    expect(f.counts()).toEqual(before);
    expect(originalGets).toBe(gets);
    drop = 'get';
    expect((await f.port().lookup(original, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(physicalDrops).toBe(2);
    expect(originalGets).toBe(gets + 1);
    expect(readFileSync(journalPath)).toEqual(unknownBytes);
    const recovered = await f.port().submit(original, snapshot);
    expect(recovered.phase).toBe('saved');
    expect(recovered.intent).toEqual(original);
    expect(recovered.fact).toEqual(published);
    expect(originalGets).toBe(gets + 2);
    expect(f.counts().posts).toBe(1);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.journal.list()[0]?.phase).toBe('saved');
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
    const result = await f.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.source.result', {
      commandId: original.request.commandId,
    });
    for (const change of [
      (fact: Record<string, unknown>) => {
        fact.phase = 'pending';
      },
      (fact: Record<string, unknown>) => {
        fact.proof = null;
      },
      (fact: Record<string, unknown>) => {
        (fact.proof as Record<string, unknown>).recordedAt = 0;
      },
      (fact: Record<string, unknown>) => {
        fact.raw = 'x'.repeat(16 * 1024);
      },
    ]) {
      const bad = structuredClone(result);
      change(bad[0]!.payload as Record<string, unknown>);
      expect(() => decodeMcpSourceApprovalFact(bad)).toThrow();
    }
    expect(relayFailure).toBeUndefined();
  } finally {
    globalThis.fetch = actualFetch;
    const closed = new Promise<void>((resolve) => relay.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    await f.close();
  }
}, 20000);
test('public backup v10 A→B preserves original Source bytes and real current B Host rejects foreign intent before all HTTP', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.port().read('s', new AbortController().signal),
      row = intent(snapshot, 'source-a');
    const submitted = await f.port().submit(row, snapshot);
    expect(submitted.intent).toEqual(row);
    expect(['pending', 'outcome_unknown']).toContain(submitted.phase);
    expect(f.counts().posts).toBe(1);
    expect((await f.settle(row, 'pending')).phase).toBe('pending');
    expect(f.counts().posts).toBe(1);
    await f.answer(row.request.commandId, 'approved');
    const saved = await f.settle(row, 'saved');
    expect(saved.fact?.decision).toBe('approved');
    const path = join(f.profile.profilePath, 'ui/mcp-source-approval-intents.json'),
      bytes = readFileSync(path),
      rows = f.journal.list(),
      storeA = row.request.expectedStoreId;
    await f.offline();
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.version).toBe(10);
    expect(backup.manifest.assets.mcpSourceApprovalIntents?.proof?.sha256).toBe(
      mcpShaFromBytes(bytes),
    );
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(join(backup.directory, 'ui/mcp-source-approval-intents.json'))).toEqual(
      bytes,
    );
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: storeA,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(storeA);
    await f.reopen();
    expect(f.client.serverInfo?.storeId).toBe(restored.storeId);
    expect(f.journal.list()).toEqual(rows);
    expect(readFileSync(path)).toEqual(bytes);
    const current = f.port(),
      cursor = (await f.store.getMetadata()).lastChangeCursor,
      counts = f.counts();
    let http = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
      http++;
      return originalFetch(...args);
    }, originalFetch);
    try {
      expect((await current.list())[0]?.intent).toEqual(row);
      expect((await current.lookup(row, new AbortController().signal)).phase).toBe(
        'outcome_unknown',
      );
      expect((await current.submit(row, snapshot)).phase).toBe('outcome_unknown');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(http).toBe(0);
    expect(f.counts()).toEqual(counts);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(readFileSync(path)).toEqual(bytes);
    expect(f.journal.list()).toEqual(rows);
    expect(f.counts()).toMatchObject({ rpc: 0, models: 0, vault: 0 });
    expect(
      createTuiMcpPort(
        {
          ...f.tracked,
          listWorkspaces: f.client.listWorkspaces.bind(f.client),
          getExecution: f.client.getExecution.bind(f.client),
          getHostMutation: f.client.getHostMutation.bind(f.client),
        },
        restored.storeId,
        undefined,
        undefined,
        f.journal,
      ).source,
    ).toBeDefined();
  } finally {
    await f.close();
  }
}, 20000);

function mcpShaFromBytes(bytes: Uint8Array) {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}
