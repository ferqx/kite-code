import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  type AgentClient,
  type Command,
  createClient,
  type Execution,
  requiresInteractionAttachment,
} from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { createMcpHttpTransportPort } from '@kite-ai/service/mcp-http-port';
import type { TuiMcpIntent, TuiMcpSnapshot } from '@kite-ai/ui/tui';
import { createMcpSelectionRecord, mcpCanonical } from '../../host/mcp-selection-intents';
import { openMcpSelectionJournal } from '../../host/mcp-selection-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  function sorted(part: unknown): unknown {
    if (Array.isArray(part)) return part.map(sorted);
    if (!part || typeof part !== 'object') return part;
    const row = part as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, sorted(row[key])]),
    );
  }
  return JSON.stringify(sorted(value));
};
function intent(
  facts: TuiMcpSnapshot,
  id: string,
  scope: 'user' | 'workspace' = 'user',
): TuiMcpIntent {
  return {
    sessionId: facts.sessionId,
    workspaceId: facts.workspaceId,
    workspaceIdentity: facts.workspaceIdentity,
    request: {
      expectedStoreId: facts.storeId,
      commandId: id,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.management',
      actionId: 'mcp.server.select',
      definitionVersion: '1',
      input: {
        serverId: facts.items[0]!.id,
        enabled: false,
        scope,
        expectedReadSet: facts.readSet,
      },
    },
  };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw Error('actual_tui_mcp_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(source = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-mcp-host-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  const journal = openMcpSelectionJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  const configPath = join(profile.profilePath, 'config.jsonc'),
    workspacePath = join(workspace, 'kite-agent.jsonc');
  writeFileSync(
    configPath,
    '{\n// USER COMMENT\n"unknown":{"keep":true},"mcp":[{"id":"refresh","enabled":true}]}\n',
    { mode: 0o600 },
  );
  writeFileSync(workspacePath, '{\n// PROJECT COMMENT\n"unknown":42}\n', { mode: 0o600 });
  let rpc = 0,
    credentialReads = 0,
    ask = false;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      throw Error('query_must_not_connect');
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  if (source)
    writeFileSync(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          'owned-source': { type: 'http', url: remote.url.href, auth: { type: 'none' } },
        },
      }),
      { mode: 0o600 },
    );
  const backend = createTemporaryCredentialBackend();
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      ...backend,
      async resolve(ref) {
        credentialReads++;
        return backend.resolve(ref);
      },
    },
    ...(source ? { mcpSources: { http: { allowLoopbackForTests: true } } } : {}),
    permissions: {
      async authorize(request) {
        return ask && request.kind === 'job'
          ? {
              allowed: false,
              revision: 'owned-ask',
              approval: { request: { effects: ['workspace_write'] }, grants: ['approve_once'] },
            }
          : { allowed: true, revision: 'owned-host-allow' };
      },
    },
    mcp: {
      servers: [{ id: 'refresh', transport: { type: 'http', url: remote.url.href } }],
      transportPort: createMcpHttpTransportPort({
        servers: [{ id: 'refresh', url: remote.url.href }],
        allowLoopbackForTests: true,
        async admit() {
          throw Error('selection_must_not_connect');
        },
      }),
    },
  });
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  const server = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'actual-tui-mcp',
    subjectId: 'owned-subject',
    configurationManagement: host.configurationManagement!(runtime),
  });
  const client = createClient({
    endpoint: server.endpoint,
    token: server.bootstrap.token,
    bootstrap: server.bootstrap,
    expected: {
      profile: server.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: [
        'commands',
        'extension_queries',
        'extensions_actions',
        'configuration_management',
      ],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${workspace}`,
    name: 'owned',
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create-a',
    sessionId: 'a',
    workspaceId: 'w',
    title: 'mcp',
  });
  let posts = 0;
  const tracked = {
    get serverInfo() {
      return client.serverInfo;
    },
    getView: client.getView.bind(client),
    listWorkspaces: client.listWorkspaces.bind(client),
    queryExtension: client.queryExtension.bind(client),
    getCommand: client.getCommand.bind(client),
    getExecution: client.getExecution.bind(client),
    getHostMutation: client.getHostMutation.bind(client),
    async invokeExtension(...args: Parameters<AgentClient['invokeExtension']>) {
      posts++;
      return client.invokeExtension(...args);
    },
  };
  return {
    root,
    journal,
    journalPath: join(access.profilePath, 'ui/mcp-selection-intents.json'),
    store,
    storeId,
    runtime,
    client,
    tracked,
    configPath,
    workspacePath,
    workspace,
    sourcePath,
    get posts() {
      return posts;
    },
    get rpc() {
      return rpc;
    },
    get credentialReads() {
      return credentialReads;
    },
    set ask(value: boolean) {
      ask = value;
    },
    async close() {
      client.disposeNetwork();
      await server.close();
      await runtime.close();
      await store.close();
      remote.stop(true);
      journal.close();
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual default MCP Query/selection keeps full source scope, saved receipt and zero Model/transport/credential IO; lost reply only GETs original', async () => {
  const f = await fixture();
  try {
    const port = createTuiMcpPort(
      {
        ...f.tracked,
        async invokeExtension(...args) {
          await f.tracked.invokeExtension(...args);
          throw Error('owned_reply_lost_after_actual_acceptance');
        },
      },
      f.storeId,
      f.journal,
    );
    const signal = new AbortController().signal,
      facts = await port.read('a', signal);
    expect(facts.items).toMatchObject([{ id: 'refresh', selected: true, admitted: true }]);
    expect([f.rpc, f.credentialReads, f.posts]).toEqual([0, 0, 0]);
    const saved = intent(facts, 'original-lost');
    expect((await port.submit(saved)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(1);
    const found = await until(async () => {
      const result = await port.lookup(saved, signal);
      return result.phase === 'applied' ? result : undefined;
    });
    expect(found.intent).toEqual(saved);
    expect((await port.submit(saved)).phase).toBe('applied');
    const drift = createTuiMcpPort(
      { ...f.tracked, serverInfo: { ...f.client.serverInfo!, subjectId: 'other-subject' } },
      f.storeId,
      f.journal,
    );
    expect((await drift.lookup(saved, signal)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(1);
    expect(found.command).toMatchObject({
      id: saved.request.commandId,
      sessionId: 'a',
      originStoreId: f.storeId,
      kind: 'extension.invoke',
      status: 'applied',
      subjectId: 'owned-subject',
    });
    expect(found.execution).toMatchObject({ kind: 'job', runId: null, status: 'succeeded' });
    expect((await port.read('a', signal)).items[0]!.selected).toBe(false);
    expect(readFileSync(f.configPath, 'utf8')).toContain('// USER COMMENT');
    expect(readFileSync(f.configPath, 'utf8')).toContain('"keep":true');
    expect(readFileSync(f.workspacePath, 'utf8')).toContain('// PROJECT COMMENT');
    expect([f.rpc, f.credentialReads, f.posts]).toEqual([0, 0, 1]);
    expect((await f.client.getView('a')).runs).toHaveLength(0);
    expect(
      (await f.store.listExecutions('a')).filter(
        (e) => e.originCommandId === saved.request.commandId,
      ),
    ).toHaveLength(1);
    console.log(
      JSON.stringify({
        case: 'actual_tui_mcp_original',
        storeId: f.storeId,
        sessionId: 'a',
        commandId: found.command!.id,
        executionId: found.execution!.id,
        commandDigest: found.command!.requestDigest,
        selected: false,
        posts: f.posts,
        rpc: f.rpc,
        credentialReads: f.credentialReads,
      }),
    );
  } finally {
    await f.close();
  }
}, 15000);

test('actual source CAS drift fails before effect and explicit approval waits with unchanged configuration', async () => {
  const f = await fixture();
  try {
    const port = createTuiMcpPort(f.tracked, f.storeId, f.journal),
      signal = new AbortController().signal;
    const stale = intent(await port.read('a', signal), 'stale');
    writeFileSync(f.configPath, '{"unknown":"new","mcp":[{"id":"refresh","enabled":true}]}', {
      mode: 0o600,
    });
    const unchanged = readFileSync(f.configPath, 'utf8');
    await port.submit(stale);
    const failed = await until(async () => {
      const o = await port.lookup(stale, signal);
      return o.phase === 'failed' ? o : undefined;
    });
    expect(failed.execution?.status).toBe('failed');
    expect(readFileSync(f.configPath, 'utf8')).toBe(unchanged);
    f.ask = true;
    const saved = intent(await port.read('a', signal), 'approved-project', 'workspace');
    await port.submit(saved);
    const pending = await until(async () => {
      const cards = await f.client.listInteractions('a', {
        storeId: f.storeId,
        state: 'pending',
        limit: 20,
      });
      return cards.interactions.find((card) => card.kind === 'approval');
    });
    expect((await port.lookup(saved, signal)).phase).toBe('pending');
    expect(readFileSync(f.workspacePath, 'utf8')).toContain('"unknown":42');
    expect(readFileSync(f.workspacePath, 'utf8')).not.toContain('"mcp"');
    if (requiresInteractionAttachment(pending)) await f.client.readInteractionAttachment(pending);
    await f.client.answerInteraction('a', pending.id, {
      expectedStoreId: f.storeId,
      commandId: 'approve-original',
      expectedRevision: pending.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const applied = await until(async () => {
      const o = await port.lookup(saved, signal);
      return o.phase === 'applied' ? o : undefined;
    });
    expect(applied.intent.request.input.scope).toBe('workspace');
    expect(readFileSync(f.workspacePath, 'utf8')).toContain('// PROJECT COMMENT');
    expect(
      JSON.parse(readFileSync(f.workspacePath, 'utf8').replace(/^\/\/.*$/gm, '')),
    ).toMatchObject({ unknown: 42 });
    expect((await port.read('a', signal)).items[0]!.selected).toBe(false);
    expect([f.rpc, f.credentialReads, f.posts]).toEqual([0, 0, 2]);
  } finally {
    await f.close();
  }
}, 15000);

test('actual publication with unavailable durable mutation result stays original unknown; lookup does not retry effect', async () => {
  const f = await fixture();
  try {
    const original = f.runtime.finishHostMutation.bind(f.runtime);
    f.runtime.finishHostMutation = async (input) => {
      if (input.state === 'applied' && input.commandId.startsWith('mcp-select-'))
        throw Error('owned_sqlite_receipt_unavailable');
      return original(input);
    };
    const port = createTuiMcpPort(f.tracked, f.storeId, f.journal),
      signal = new AbortController().signal;
    const saved = intent(await port.read('a', signal), 'original-uncertain');
    await port.submit(saved);
    await f.runtime.waitForCommand(saved.request.commandId, { timeoutMs: 8000 });
    const first = await port.lookup(saved, signal),
      second = await port.lookup(saved, signal);
    expect(first.phase).toBe('outcome_unknown');
    expect(second.phase).toBe('outcome_unknown');
    expect(first.execution?.id).toBe(second.execution?.id);
    expect(first.intent).toEqual(saved);
    expect((await port.read('a', signal)).items[0]!.selected).toBe(false);
    expect([f.rpc, f.credentialReads, f.posts]).toEqual([0, 0, 1]);
  } finally {
    await f.close();
  }
}, 15000);

test('MCP saved phase requires original command, exact action binding and full mutation digest; admission alone stays pending', async () => {
  const pureRoot = realpathSync(mkdtempSync('/private/tmp/kite-mcp-receipt-'));
  const pureAccess = acquireProfileAccess({ dataRoot: join(pureRoot, 'data'), profile: 'owned' });
  mkdirSync(pureAccess.profilePath, { recursive: true, mode: 0o700 });
  const pureJournal = openMcpSelectionJournal({
    access: pureAccess,
    acquireWriteLock: () => acquireProfileDataLock(pureAccess, 'tui_private'),
  });
  const stat = lstatSync(pureRoot, { bigint: true });
  const facts: TuiMcpSnapshot = {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    workspaceIdentity: mcpCanonical({
      root: pureRoot,
      dev: String(stat.dev),
      ino: String(stat.ino),
    }),
    workspacePath: '/owned',
    registryRevision: 'rev',
    readSet: {
      userEtag: 'a'.repeat(64),
      workspaceEtag: 'b'.repeat(64),
      explicitDigest: 'c'.repeat(64),
      registryDigest: 'd'.repeat(64),
      registryRevision: 'rev',
      scopeDigest: 'e'.repeat(64),
    },
    items: [
      {
        id: 'one',
        configDigest: 'f'.repeat(64),
        transport: 'stdio',
        source: { kind: 'user', id: 'safe', revision: '1' },
        admitted: true,
        selected: true,
        available: true,
        reason: null,
      },
    ],
  };
  const saved = intent(facts, 'original');
  const { expectedStoreId: _store, commandId: _command, ...request } = saved.request;
  const command: Command = {
    id: 'original',
    sessionId: 's',
    originStoreId: 'store',
    subjectId: 'subject',
    requestDigest: sha(canonical(request)),
    kind: 'extension.invoke',
    status: 'applied',
    receipt: { executionId: 'execution' },
    cancelRequestedAt: null,
  };
  const mutation = {
    id: 'mcp-select-execution',
    originStoreId: 'store',
    subjectId: 'subject',
    requestDigest: sha(
      canonical({
        executionId: 'execution',
        inputDigest: sha(canonical(saved.request.input)),
        ...saved.request.input,
      }),
    ),
    kind: 'config.user.write',
    scope: 'user',
    safeRequest: { scope: 'user', ifMatch: facts.readSet.userEtag, operationCount: 1 },
    state: 'applied',
    receipt: { status: 'applied', etag: 'f'.repeat(64) },
  };
  const execution: Execution = {
    id: 'execution',
    originStoreId: 'store',
    sessionId: 's',
    runId: null,
    kind: 'job',
    definitionId: 'builtin.mcp.management/mcp.server.select',
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
    cancelRequestedAt: null,
    result: {
      outcome: 'succeeded',
      content: 'saved',
      details: {
        mutation,
        binding: {
          executionId: 'execution',
          originCommandId: 'original',
          originalStoreId: 'store',
          sessionId: 's',
          serverId: 'one',
          enabled: false,
          scope: 'user',
        },
      },
    },
  };
  let cmd = structuredClone(command),
    exe = structuredClone(execution),
    posts = 0,
    mutationReads = 0;
  const port = createTuiMcpPort(
    {
      serverInfo: { subjectId: 'subject', storeId: 'store' } as AgentClient['serverInfo'],
      async getView() {
        return {
          storeId: 'store',
          session: { id: 's', workspaceId: 'w', deletedAt: null },
        } as Awaited<ReturnType<AgentClient['getView']>>;
      },
      async listWorkspaces() {
        return [{ id: 'w', rootUri: `file://${pureRoot}`, name: 'owned' }];
      },
      async queryExtension() {
        throw Error('unused');
      },
      async invokeExtension() {
        posts++;
        return cmd;
      },
      async getCommand() {
        return cmd;
      },
      async getExecution() {
        return exe;
      },
      async getHostMutation() {
        mutationReads++;
        return {
          commandId: mutation.id,
          originStoreId: 'store',
          scope: 'user',
          kind: 'config.patch',
          ifMatch: facts.readSet.userEtag,
          state: 'applied',
          receipt: mutation.receipt as { status: 'applied'; etag: string },
        };
      },
    },
    'store',
    // This pure receipt matrix mutates fixtures backwards in time; durable phase transitions are tested separately.
    { ...pureJournal, record() {} },
  );
  pureJournal.prepare(createMcpSelectionRecord(saved, 'subject'));
  // Test-owned resources are released even when an assertion fails.
  try {
    const signal = new AbortController().signal;
    cmd.status = 'accepted';
    cmd.receipt = null;
    expect((await port.lookup(saved, signal)).phase).toBe('pending');
    cmd = structuredClone(command);
    expect((await port.lookup(saved, signal)).phase).toBe('applied');
    for (const change of [
      (c: Command) => {
        c.requestDigest = '0'.repeat(64);
      },
      (c: Command) => {
        c.subjectId = 'foreign';
      },
      (c: Command) => {
        c.sessionId = 'foreign';
      },
      (c: Command) => {
        c.kind = 'run.start';
      },
    ]) {
      cmd = structuredClone(command);
      change(cmd);
      expect((await port.lookup(saved, signal)).phase).toBe('outcome_unknown');
    }
    cmd = structuredClone(command);
    for (const field of ['requestDigest', 'subjectId', 'originStoreId', 'id']) {
      exe = structuredClone(execution);
      const result = exe.result as { details: { mutation: Record<string, unknown> } };
      result.details.mutation[field] = 'foreign';
      expect((await port.lookup(saved, signal)).phase).toBe('outcome_unknown');
    }
    exe = structuredClone(execution);
    exe.status = 'running';
    exe.result = null;
    expect((await port.lookup(saved, signal)).phase).toBe('pending');
    expect(posts).toBe(0);
    expect(mutationReads).toBe(1);
  } finally {
    pureJournal.close();
    pureAccess.lock.release();
    rmSync(pureRoot, { recursive: true, force: true });
  }
});

test('actual missing private journal authority and corrupted durable file grant zero selection POST', async () => {
  const f = await fixture();
  try {
    const noJournal = createTuiMcpPort(f.tracked, f.storeId);
    const facts = await noJournal.read('a', new AbortController().signal),
      saved = intent(facts, 'cannot-send');
    expect((await noJournal.submit(saved)).phase).toBe('outcome_unknown');
    expect(f.posts).toBe(0);
    f.journal.prepare(createMcpSelectionRecord(saved, f.client.serverInfo!.subjectId!));
    const journalPath = f.journalPath;
    writeFileSync(journalPath, 'broken', { mode: 0o600 });
    const port = createTuiMcpPort(f.tracked, f.storeId, f.journal);
    expect(
      (await port.submit({ ...saved, request: { ...saved.request, commandId: 'second' } })).phase,
    ).toBe('outcome_unknown');
    expect(f.posts).toBe(0);
    expect(readFileSync(journalPath, 'utf8')).toBe('broken');
  } finally {
    await f.close();
  }
});

test('actual removed Server and renamed physical Workspace retain original historical GET; fresh dispatch and mismatched durable identities are denied', async () => {
  const f = await fixture(true);
  try {
    const port = createTuiMcpPort(f.tracked, f.storeId, f.journal),
      signal = new AbortController().signal;
    const facts = await port.read('a', signal),
      server = facts.items.find((row) => row.source.kind === 'user');
    expect(server?.admitted).toBe(true);
    const saved = intent(facts, 'historical-original');
    saved.request.input.serverId = server!.id;
    await port.submit(saved);
    const result = await until(async () => {
      const row = await port.lookup(saved, signal);
      return row.phase === 'applied' ? row : undefined;
    });
    writeFileSync(f.sourcePath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    expect((await port.read('a', signal)).items.some((row) => row.id === server!.id)).toBe(false);
    expect((await port.lookup(saved, signal)).execution!.id).toBe(result.execution!.id);
    renameSync(f.workspace, `${f.workspace}-moved`);
    await expect(port.read('a', signal)).rejects.toThrow();
    expect((await port.lookup(saved, signal)).phase).toBe('applied');
    expect((await port.submit(saved)).phase).toBe('applied');
    expect(
      (
        await port.submit({
          ...saved,
          request: { ...saved.request, commandId: 'fresh-after-drift' },
        })
      ).phase,
    ).toBe('outcome_unknown');
    for (const changed of [
      { ...saved, sessionId: 'other' },
      { ...saved, workspaceId: 'other' },
      { ...saved, workspaceIdentity: 'other-physical-identity' },
      { ...saved, request: { ...saved.request, input: { ...saved.request.input, enabled: true } } },
      { ...saved, request: { ...saved.request, expectedStoreId: 'other-store' } },
    ])
      expect((await port.lookup(changed, signal)).phase).toBe('outcome_unknown');
    const wrongStore = createTuiMcpPort(
      { ...f.tracked, serverInfo: { ...f.client.serverInfo!, storeId: 'other-store' } },
      f.storeId,
      f.journal,
    );
    expect((await wrongStore.lookup(saved, signal)).phase).toBe('outcome_unknown');
    expect([f.posts, f.rpc, f.credentialReads]).toEqual([1, 0, 0]);
    console.log(
      JSON.stringify({
        case: 'mcp_historical_read_only',
        storeId: f.storeId,
        commandId: result.command!.id,
        executionId: result.execution!.id,
        serverRemoved: true,
        workspaceRenamed: true,
        posts: f.posts,
        rpc: f.rpc,
      }),
    );
  } finally {
    await f.close();
  }
});
