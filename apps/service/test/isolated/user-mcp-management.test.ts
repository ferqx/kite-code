import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  mcpCanonical,
  readConfigurationFile,
  readMcpSources,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { createMcpAdapter, createMcpLifecycle } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { acquireFileLock } from '../../../../packages/agent/src/platform/locks';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import type {
  UserMcpOperationResult,
  UserMcpSettingsOperation,
} from '../../src/http/schema/user-mcp';
import {
  createMcpHttpTransportPort,
  createUserMcpHttpTransportPort,
} from '../../src/mcp-http-port';
import { createMcpSourceConfiguration } from '../../src/mcp-source-configuration';
import { userMcpOAuthScope } from '../../src/user-mcp-credentials';
import { createUserMcpManagement } from '../../src/user-mcp-management';
import { disabledUserMcpSources } from '../../src/user-mcp-selection';

const digest = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= end) throw Error('global_mcp_test_deadline');
    await Bun.sleep(2);
  }
}
async function fixture(auth: 'none' | 'oauth' | 'credential' = 'none', actualRuntimeMcp = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-user-mcp-owner-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'global' });
  privateDirectory(profile.profilePath);
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let runtime!: ReturnType<typeof createRuntime>;
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, subjectId: 'owner' };
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() });
  const credential = await vault.put('synthetic-manual-bearer');
  let hold: { entered: boolean; wait: Promise<void>; release(): void } | undefined;
  let descriptors = Array.from({ length: 35 }, (_, i) => ({
    name: `tool-${i}`,
    description: `${i} original`,
    inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } } },
  }));
  let browserCalls = 0,
    challenge: string | undefined;
  let holdBrowser = false;
  const wire: { method: string; authorization: string | null }[] = [],
    oauthWire: string[] = [];
  const peer: Bun.Server<undefined> = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url),
        base = peer.url.origin;
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        oauthWire.push(url.pathname);
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['tools'],
        });
      }
      if (url.pathname.startsWith('/.well-known/')) {
        oauthWire.push(url.pathname);
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/register') {
        oauthWire.push('register');
        return Response.json({
          ...((await request.json()) as object),
          client_id: 'synthetic-client',
        });
      }
      if (url.pathname === '/token') {
        oauthWire.push('token');
        const body = new URLSearchParams(await request.text());
        if (body.get('grant_type') === 'authorization_code')
          expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
            challenge!,
          );
        return Response.json({
          access_token: 'synthetic-oauth-access',
          refresh_token: 'synthetic-oauth-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.pathname === '/revoke') {
        oauthWire.push('revoke');
        return new Response(null, { status: 200 });
      }
      if (!['/mcp', '/mcp-next'].includes(url.pathname) || request.method !== 'POST')
        return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number | string; method: string };
      wire.push({ method: rpc.method, authorization: request.headers.get('authorization') });
      if (rpc.method === 'tools/list' && hold) {
        hold.entered = true;
        await hold.wait;
      }
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'controlled-global', version: '1' },
              capabilities: { tools: {} },
            }
          : rpc.method === 'tools/list'
            ? { tools: descriptors }
            : {};
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const path = join(profile.profilePath, 'mcp.json'),
    userConfigurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        global: {
          type: 'http',
          url: new URL('/mcp', peer.url).href,
          ...(auth === 'none'
            ? { auth: { type: 'none' } }
            : auth === 'oauth'
              ? { auth: { type: 'oauth', scopes: ['tools'] } }
              : { auth: { type: 'credential', profile: 'manual', credentialRef: credential.id } }),
        },
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(userConfigurationPath, '{\n// user selection\n"unknown":42\n}\n', { mode: 0o600 });
  let agentAllowed = false;
  const permissionCalls: string[] = [];
  const sourceSelection = () => {
    const user = readConfigurationFile({ path: userConfigurationPath }).value;
    return {
      present: Object.hasOwn(user, 'mcp'),
      configurations: (user.mcp ?? []) as { id: string; enabled?: boolean }[],
      disabledUserServerIds: disabledUserMcpSources(user),
    };
  };
  const sources = actualRuntimeMcp
    ? createMcpSourceConfiguration({
        profile,
        runtime: () => runtime,
        credentialVault: vault,
        selection: sourceSelection,
        http: { allowLoopbackForTests: true },
      })
    : undefined;
  const lifecycle = sources
    ? createMcpLifecycle({ servers: [], scopedSources: sources.sourcePort })
    : undefined;
  const model = createFixedModel([]);
  runtime = createRuntime({
    store,
    permissions: {
      async authorize(request) {
        permissionCalls.push(request.definitionId);
        return {
          allowed: agentAllowed,
          revision: agentAllowed ? 'explicit-real-run' : 'no-agent-tools',
        };
      },
    },
    ...(sources && lifecycle
      ? {
          artifacts: createArtifactStore({ profile, store }),
          extensions: [sources.extension, lifecycle.extension],
          model,
          modelId: 'fixed',
          resolveRunConfiguration: async (input) => {
            const capture = await sources.capture(input),
              selection = sources.select(capture, sourceSelection());
            return {
              model,
              modelId: 'fixed',
              snapshot: { mcp: { sources: selection.snapshot } } as unknown as Json,
              toolIds: ['mcp.connect', 'mcp.sources.list'],
              sources: selection.sources,
            };
          },
        }
      : {}),
  });
  const create = () =>
    createUserMcpManagement({
      profile,
      runtime: () => runtime,
      credentialVault: vault,
      userConfigurationPath,
      subjectId: 'owner',
      http: { allowLoopbackForTests: true },
      oauth: {
        network: { allowLoopbackForTests: true },
        callbackTimeoutMs: 1000,
        async openBrowser(url, signal) {
          browserCalls++;
          challenge = url.searchParams.get('code_challenge')!;
          if (holdBrowser) {
            await new Promise<void>((_resolve, reject) => {
              const cancel = () => reject(Error('cancelled'));
              signal.addEventListener('abort', cancel, { once: true });
              if (signal.aborted) cancel();
            });
            return;
          }
          const callback = new URL(url.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', url.searchParams.get('state')!);
          callback.searchParams.set('code', 'synthetic-code');
          expect((await fetch(callback)).status).toBe(200);
        },
      },
    });
  let manager = create();
  async function final(commandId: string): Promise<UserMcpOperationResult> {
    return until(async () => {
      const result = await manager.lookup({ ...identity, commandId });
      return result.state === 'pending' ? null : result;
    });
  }
  async function mutate(commandId: string, operation: UserMcpSettingsOperation) {
    const view = await manager.read(identity);
    const result = await manager.mutate({
      ...identity,
      commandId,
      expectedReadSet: view.readSet!,
      operation,
    });
    return result.state === 'pending' ? final(commandId) : result;
  }
  return {
    root,
    profile,
    path,
    userConfigurationPath,
    store,
    runtime,
    expectedStoreId,
    identity,
    vault,
    credential,
    wire,
    oauthWire,
    create,
    manager: () => manager,
    final,
    mutate,
    permissionCalls,
    sources,
    sourceSelection,
    allowAgent(value: boolean) {
      agentAllowed = value;
    },
    changeSource() {
      const source = JSON.parse(readFileSync(path, 'utf8'));
      source.mcpServers.global.url = new URL('/mcp-next', peer.url).href;
      writeFileSync(path, JSON.stringify(source));
    },
    browserCalls: () => browserCalls,
    holdBrowser: () => {
      holdBrowser = true;
    },
    descriptors(value: typeof descriptors) {
      descriptors = value;
    },
    hold() {
      let release!: () => void;
      hold = {
        entered: false,
        wait: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release: () => release(),
      };
      return hold;
    },
    async reopen() {
      await manager.close();
      manager = create();
    },
    async close() {
      hold?.release();
      await manager.close();
      await runtime.close();
      await lifecycle?.close();
      peer.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('user owner initializes and reads full live metadata without any Session, Workspace or tools/call authority', async () => {
  const f = await fixture();
  try {
    const view = await f.manager().read(f.identity),
      serverId = view.sources[0]!.id;
    expect(view.sources[0]!.connection.state).toBe('disconnected');
    expect(f.wire).toEqual([]);
    expect(await f.store.listWorkspaces()).toEqual([]);
    expect(await f.store.listSessions()).toEqual([]);
    expect((await f.mutate('connect', { kind: 'connect', serverId })).state).toBe('applied');
    const connected = await f.manager().read(f.identity),
      generation = connected.sources[0]!.connection.generation!;
    expect(connected.sources[0]!.connection).toEqual({ state: 'ready', generation, toolCount: 35 });
    const first = await f.manager().tools({ ...f.identity, serverId, generation });
    expect(first.entries).toHaveLength(32);
    expect(first.complete).toBe(false);
    expect(first.nextAfterIndex).toBe(31);
    const next = await f
      .manager()
      .tools({ ...f.identity, serverId, generation, afterIndex: first.nextAfterIndex! });
    expect(next.entries.map((row) => row.index)).toEqual([32, 33, 34]);
    expect(next.complete).toBe(true);
    expect(next.entries[0]!.descriptor).toMatchObject({
      name: 'tool-32',
      description: '32 original',
    });
    f.descriptors([
      {
        name: 'updated',
        description: 'full new schema',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ]);
    expect((await f.mutate('refresh', { kind: 'refresh', serverId })).state).toBe('applied');
    expect((await f.manager().read(f.identity)).sources[0]!.connection.toolCount).toBe(1);
    expect(
      await f
        .manager()
        .tools({ ...f.identity, serverId, generation })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'mcp_tools_snapshot_stale' });
    expect(f.wire.map((row) => row.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);
    expect((await f.mutate('disconnect', { kind: 'disconnect', serverId })).state).toBe('applied');
    expect((await f.manager().read(f.identity)).sources[0]!.connection.state).toBe('disconnected');
    await f.reopen();
    expect((await f.manager().lookup({ ...f.identity, commandId: 'connect' })).state).toBe(
      'applied',
    );
    expect((await f.manager().read(f.identity)).sources[0]!.connection.state).toBe('disconnected');
    expect(await f.store.listSessions()).toEqual([]);
  } finally {
    await f.close();
  }
});

test('global HostMutation writes and credential binding do not depend on project approval contents or locks', async () => {
  const f = await fixture('credential');
  try {
    const before = await f.manager().read(f.identity);
    const serverId = before.sources[0]!.id;
    const approval = join(f.profile.profilePath, 'mcp-approvals.json');
    writeFileSync(approval, '{ invalid project approval', { mode: 0o600 });
    const originalApproval = readFileSync(approval);
    const lock = acquireFileLock(`${approval}.lock`, 'exclusive');
    try {
      expect((await f.manager().read(f.identity)).readSet).toBe(before.readSet);
      const added = await f.manager().mutate({
        ...f.identity,
        commandId: 'global-add-with-project-approval',
        expectedReadSet: before.readSet!,
        operation: {
          kind: 'add',
          name: 'new-user-source',
          entry: { type: 'http', url: 'https://new-user.example.test/mcp' },
        },
      });
      expect(added.state).toBe('applied');
      expect(added.receipt.configuration).toBe('published');
      const current = await f.manager().read(f.identity);
      const addedId = current.sources.find((row) => row.name === 'new-user-source')!.id;
      expect(
        (
          await f.mutate('global-remove-with-project-approval', {
            kind: 'remove',
            serverId: addedId,
          })
        ).state,
      ).toBe('applied');
      expect(
        (
          await f.mutate('global-bind-with-project-approval', {
            kind: 'bind',
            serverId,
            expiresAt: Date.now() + 60000,
          })
        ).state,
      ).toBe('applied');
      expect((await f.manager().read(f.identity)).sources[0]!.authentication.status).toBe(
        'present',
      );
      const record = await f.runtime.getHostMutation({
        ...f.identity,
        commandId: 'global-add-with-project-approval',
      });
      expect(record).toMatchObject({ kind: 'config.user.write', scope: 'user', state: 'applied' });
      expect(readFileSync(approval)).toEqual(originalApproval);
      expect(await f.store.listWorkspaces()).toEqual([]);
      expect(await f.store.listSessions()).toEqual([]);
      expect(f.wire).toEqual([]);
    } finally {
      lock.release();
    }
  } finally {
    await f.close();
  }
});

test('cancel settles the original connection and repeated IDs never reissue; cold pending remains unknown', async () => {
  const f = await fixture();
  try {
    const hold = f.hold(),
      view = await f.manager().read(f.identity),
      serverId = view.sources[0]!.id;
    const input = {
      ...f.identity,
      commandId: 'cancel-original',
      expectedReadSet: view.readSet!,
      operation: { kind: 'connect' as const, serverId },
    };
    expect((await f.manager().mutate(input)).state).toBe('pending');
    await until(async () => (hold.entered ? true : null));
    const cancelled = await f.manager().cancel({ ...f.identity, commandId: input.commandId });
    expect(cancelled.state).toBe('failed');
    expect(cancelled.receipt.cancelled).toBe(true);
    hold.release();
    const count = f.wire.length;
    expect(await f.manager().mutate(input)).toEqual(cancelled);
    expect(f.wire).toHaveLength(count);
    expect((await f.manager().read(f.identity)).sources[0]!.connection.state).toBe('failed');
    const operation = { kind: 'connect' as const, serverId },
      requestDigest = 'c'.repeat(64);
    await f.runtime.beginHostMutation({
      ...f.identity,
      commandId: 'orphan',
      kind: 'config.user.write',
      scope: 'user',
      requestDigest,
      safeRequest: {
        scope: 'user',
        ifMatch: view.readSet!,
        operationCount: 1,
        mcpSettings: { expectedReadSet: view.readSet!, operation },
      },
    });
    const unknown = await f.manager().lookup({ ...f.identity, commandId: 'orphan' });
    expect(unknown.state).toBe('outcome_unknown');
    expect(unknown.receipt.code).toBe('mcp_operation_owner_unavailable');
    expect(f.wire).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('GET invalidates metadata for changed same-name source and only explicit reconnect replaces the live transport', async () => {
  const f = await fixture();
  try {
    const first = await f.manager().read(f.identity),
      serverId = first.sources[0]!.id;
    expect((await f.mutate('connect', { kind: 'connect', serverId })).state).toBe('applied');
    const generation = (await f.manager().read(f.identity)).sources[0]!.connection.generation!;
    f.changeSource();
    const calls = f.wire.length;
    const changed = await f.manager().read(f.identity);
    expect(changed.sources[0]!.address).toEndWith('/mcp-next');
    expect(changed.sources[0]!.connection).toEqual({
      state: 'failed',
      generation: null,
      toolCount: null,
    });
    expect(changed.sources[0]!.diagnostics).toContain('mcp_source_conflict');
    expect(f.wire).toHaveLength(calls);
    expect(
      await f
        .manager()
        .tools({ ...f.identity, serverId, generation })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'mcp_source_conflict' });
    const retained = await f.mutate('still-owned', { kind: 'connect', serverId });
    expect(retained.state).toBe('failed');
    expect(retained.receipt.code).toBe('mcp_connection_exists');
    expect(f.wire).toHaveLength(calls);
    expect((await f.mutate('replace', { kind: 'reconnect', serverId })).state).toBe('applied');
    expect((await f.manager().read(f.identity)).sources[0]!.connection.state).toBe('ready');
    expect(f.wire.filter((row) => row.method === 'initialize')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('a source change during the final tools/list response cannot publish ready metadata', async () => {
  const f = await fixture();
  try {
    const view = await f.manager().read(f.identity),
      serverId = view.sources[0]!.id,
      hold = f.hold();
    expect(
      (
        await f.manager().mutate({
          ...f.identity,
          commandId: 'inflight',
          expectedReadSet: view.readSet!,
          operation: { kind: 'connect', serverId },
        })
      ).state,
    ).toBe('pending');
    await until(async () => (hold.entered ? true : null));
    f.changeSource();
    hold.release();
    const result = await f.final('inflight');
    expect(result.state).toBe('failed');
    expect(result.receipt.code).toBe('mcp_source_conflict');
    const current = await f.manager().read(f.identity);
    expect(current.sources[0]!.connection).toEqual({
      state: 'failed',
      generation: null,
      toolCount: null,
    });
    expect(current.sources[0]!.address).toEndWith('/mcp-next');
  } finally {
    await f.close();
  }
});

for (const damage of ['missing-source', 'invalid-mcp', 'invalid-user'] as const)
  test(`a held global connection remains visible and independently stoppable after ${damage}`, async () => {
    const f = await fixture();
    try {
      const original = await f.manager().read(f.identity),
        serverId = original.sources[0]!.id;
      expect((await f.mutate('connect', { kind: 'connect', serverId })).state).toBe('applied');
      if (damage === 'missing-source') unlinkSync(f.path);
      else
        writeFileSync(
          damage === 'invalid-mcp' ? f.path : f.userConfigurationPath,
          '{ invalid JSON',
        );
      const wireCount = f.wire.length,
        damaged = await f.manager().read(f.identity);
      expect(damaged.readSet).toMatch(/^[a-f0-9]{64}$/);
      expect(damaged.sources).toHaveLength(1);
      expect(damaged.sources[0]).toMatchObject({
        id: serverId,
        configured: false,
        enabled: false,
        diagnostics: ['mcp_source_entry_missing'],
        authentication: { status: 'unknown', loginAllowed: false },
        connection: { state: 'failed', generation: null, toolCount: null },
      });
      if (damage !== 'missing-source') expect(damaged.errors.length).toBeGreaterThan(0);
      expect((await f.manager().read(f.identity)).sources).toEqual(damaged.sources);
      expect(f.wire).toHaveLength(wireCount);
      const foreign = await f.mutate('foreign', {
        kind: 'disconnect',
        serverId: `mcp-${'0'.repeat(64)}`,
      });
      expect(foreign.state).toBe('failed');
      expect(foreign.receipt.code).toBe('mcp_connection_unavailable');
      expect((await f.manager().read(f.identity)).sources).toHaveLength(1);
      const stop = {
        ...f.identity,
        commandId: 'stop-held',
        expectedReadSet: original.readSet!,
        operation: { kind: 'disconnect' as const, serverId },
      };
      await f.manager().mutate(stop);
      const result = await f.final(stop.commandId);
      expect(result.state).toBe('applied');
      expect(result.receipt.connection).toEqual({
        state: 'disconnected',
        generation: null,
        toolCount: null,
      });
      expect((await f.manager().read(f.identity)).sources).toEqual([]);
      expect(await f.manager().mutate(stop)).toEqual(result);
      expect(f.wire).toHaveLength(wireCount);
    } finally {
      await f.close();
    }
  });

test('independent disconnect cancels and joins only the original held connection operation while its source is unavailable', async () => {
  const f = await fixture();
  try {
    const original = await f.manager().read(f.identity),
      serverId = original.sources[0]!.id,
      hold = f.hold();
    await f.manager().mutate({
      ...f.identity,
      commandId: 'opening',
      expectedReadSet: original.readSet!,
      operation: { kind: 'connect', serverId },
    });
    await until(async () => (hold.entered ? true : null));
    writeFileSync(f.userConfigurationPath, '{ broken');
    const damaged = await f.manager().read(f.identity);
    expect(damaged.sources[0]).toMatchObject({ id: serverId, configured: false });
    await f.manager().mutate({
      ...f.identity,
      commandId: 'independent-stop',
      expectedReadSet: damaged.readSet!,
      operation: { kind: 'disconnect', serverId },
    });
    const stop = await f.final('independent-stop'),
      originalResult = await f.final('opening');
    expect(stop.state).toBe('applied');
    expect(stop.receipt.connection?.state).toBe('disconnected');
    expect(originalResult.state).toBe('failed');
    expect(originalResult.receipt.cancelled).toBe(true);
    expect((await f.manager().read(f.identity)).sources).toEqual([]);
    expect(f.wire.filter((row) => row.method === 'initialize')).toHaveLength(1);
    hold.release();
  } finally {
    await f.close();
  }
});

test('global bind publishes an original HostMutation grant shared by real user source reads across Workspaces; toggling preserves it', async () => {
  const f = await fixture('credential');
  try {
    const before = await f.manager().read(f.identity),
      serverId = before.sources[0]!.id;
    expect(before.sources[0]!.authentication.status).toBe('missing');
    const originalSource = readFileSync(f.path, 'utf8');
    expect(
      (await f.mutate('bind', { kind: 'bind', serverId, expiresAt: Date.now() + 60000 })).state,
    ).toBe('applied');
    expect((await f.manager().read(f.identity)).sources[0]!.authentication.status).toBe('present');
    const binding = readMcpSources({
      profilePath: f.profile.profilePath,
      scope: {
        mode: 'user',
        profileId: f.profile.profileAccessKey,
        storeId: f.expectedStoreId,
        sessionId: null,
        workspaceId: null,
      },
    }).entries[0]!.userCredentialBinding!;
    const record = await f.runtime.getHostMutation({ ...f.identity, commandId: 'bind' });
    expect((record!.receipt as { credentialBindingDigest: string }).credentialBindingDigest).toBe(
      digest(binding),
    );
    for (const id of ['one', 'two']) {
      const workspace = join(f.root, id);
      privateDirectory(workspace);
      await f.runtime.createWorkspace({
        expectedStoreId: f.expectedStoreId,
        id,
        name: id,
        rootUri: pathToFileURL(workspace).href,
      });
      await f.runtime.createSession({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'owner',
        commandId: `session-${id}`,
        sessionId: id,
        workspaceId: id,
        title: id,
      });
      const source = readMcpSources({
        profilePath: f.profile.profilePath,
        workspacePath: workspace,
        scope: {
          profileId: f.profile.profileAccessKey,
          storeId: f.expectedStoreId,
          sessionId: id,
          workspaceId: id,
        },
      });
      expect(source.entries[0]!.userCredentialBinding).toEqual(binding);
      expect(source.entries[0]!.credentialBinding).toBeNull();
      expect(source.entries[0]!.server.admitted).toBe(true);
    }
    expect((await f.mutate('disable', { kind: 'enabled', serverId, enabled: false })).state).toBe(
      'applied',
    );
    expect((await f.manager().read(f.identity)).sources[0]!.enabled).toBe(false);
    expect(readFileSync(f.path, 'utf8')).toBe(originalSource);
    expect((await f.mutate('enable', { kind: 'enabled', serverId, enabled: true })).state).toBe(
      'applied',
    );
    expect((await f.manager().read(f.identity)).sources[0]!.authentication.status).toBe('present');
    expect((await f.mutate('connect', { kind: 'connect', serverId })).state).toBe('applied');
    expect(f.wire.filter((row) => row.method === 'initialize')[0]!.authorization).toBe(
      'Bearer synthetic-manual-bearer',
    );
    expect(
      JSON.stringify(await f.manager().lookup({ ...f.identity, commandId: 'bind' })),
    ).not.toContain(f.credential.id);
    expect(JSON.stringify(await f.manager().read(f.identity))).not.toContain(
      'synthetic-manual-bearer',
    );
  } finally {
    await f.close();
  }
});

test('global OAuth login is explicit, read stays cold, and original refresh/clear/revoke operate without a Session', async () => {
  const f = await fixture('oauth');
  try {
    const serverId = (await f.manager().read(f.identity)).sources[0]!.id;
    expect(f.browserCalls()).toBe(0);
    expect(f.oauthWire).toEqual([]);
    expect(f.wire).toEqual([]);
    expect((await f.mutate('login', { kind: 'login', serverId })).state).toBe('applied');
    expect(f.browserCalls()).toBe(1);
    const readCount = f.oauthWire.length,
      current = await f.manager().read(f.identity);
    expect(current.sources[0]!.authentication).toEqual({
      policy: 'oauth',
      status: 'present',
      loginAllowed: true,
    });
    expect(f.oauthWire).toHaveLength(readCount);
    expect((await f.mutate('connect', { kind: 'connect', serverId })).state).toBe('applied');
    expect(f.wire[0]!.authorization).toBe('Bearer synthetic-oauth-access');
    expect((await f.mutate('refresh-auth', { kind: 'authRefresh', serverId })).state).toBe(
      'applied',
    );
    expect(f.browserCalls()).toBe(1);
    expect((await f.mutate('revoke', { kind: 'revoke', serverId })).receipt.revocation).toBe(
      'completed',
    );
    expect((await f.manager().read(f.identity)).sources[0]!.authentication.status).toBe('missing');
    expect(f.oauthWire).toContain('revoke');
    expect(await f.store.listSessions()).toEqual([]);
    expect(await f.store.listWorkspaces()).toEqual([]);
    expect(
      JSON.stringify(await f.manager().lookup({ ...f.identity, commandId: 'login' })),
    ).not.toContain('synthetic-oauth');
  } finally {
    await f.close();
  }
});

test('global OAuth cancellation closes the original callback and never launches a replacement', async () => {
  const f = await fixture('oauth');
  try {
    f.holdBrowser();
    const view = await f.manager().read(f.identity),
      serverId = view.sources[0]!.id;
    const input = {
      ...f.identity,
      commandId: 'login-cancel',
      expectedReadSet: view.readSet!,
      operation: { kind: 'login' as const, serverId },
    };
    expect((await f.manager().mutate(input)).state).toBe('pending');
    await until(async () => (f.browserCalls() ? true : null));
    const result = await f.manager().cancel({ ...f.identity, commandId: input.commandId });
    expect(result.state).toBe('failed');
    expect(result.receipt.cancelled).toBe(true);
    const calls = f.oauthWire.length;
    expect(await f.manager().mutate(input)).toEqual(result);
    expect(f.browserCalls()).toBe(1);
    expect(f.oauthWire).toHaveLength(calls);
  } finally {
    await f.close();
  }
});

test('a lost final publication preserves unknown original state and never publishes a duplicate source', async () => {
  const f = await fixture();
  const finish = f.runtime.finishHostMutation.bind(f.runtime);
  try {
    const view = await f.manager().read(f.identity);
    const input = {
      ...f.identity,
      commandId: 'publication-lost',
      expectedReadSet: view.readSet!,
      operation: {
        kind: 'add' as const,
        name: 'one-time',
        entry: { type: 'http' as const, url: 'https://controlled.invalid/mcp' },
      },
    };
    f.runtime.finishHostMutation = async (request) => {
      if (request.commandId === input.commandId) throw Error('synthetic durable reply unavailable');
      return finish(request);
    };
    const unknown = await f.manager().mutate(input);
    expect(unknown.state).toBe('outcome_unknown');
    expect(unknown.receipt.configuration).toBe('outcome_unknown');
    expect((await f.manager().read(f.identity)).sources.map((row) => row.name).sort()).toEqual([
      'global',
      'one-time',
    ]);
    const published = readFileSync(f.path, 'utf8');
    expect(await f.manager().mutate(input)).toEqual(unknown);
    expect(readFileSync(f.path, 'utf8')).toBe(published);
    await f.reopen();
    expect(await f.manager().lookup({ ...f.identity, commandId: input.commandId })).toEqual(
      unknown,
    );
    expect(f.wire).toEqual([]);
  } finally {
    f.runtime.finishHostMutation = finish;
    await f.close();
  }
});

test('global HTTP transport rejects execution methods and mixed Session bindings before any RPC', async () => {
  const f = await fixture();
  try {
    const view = await f.manager().read(f.identity),
      server = view.sources[0]!,
      configuration = {
        type: 'http' as const,
        url: server.address!.replace('127.0.0.1', 'controlled.fixture.invalid'),
      };
    const binding = {
      owner: 'user' as const,
      originalStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'wire-policy',
      requestDigest: 'a'.repeat(64),
      serverId: server.id,
      scopeId: JSON.stringify(['user', f.expectedStoreId, 'owner', server.id]),
      configDigest: createMcpAdapter({ id: server.id, transport: configuration }).getCatalogue()
        .configDigest,
      configuration,
    };
    let admissions = 0,
      dns = 0;
    const transportOptions = {
      servers: [{ id: server.id, url: configuration.url }],
      allowLoopbackForTests: true,
      async admit() {
        admissions++;
      },
      async resolveAddresses() {
        dns++;
        return [{ address: '127.0.0.1', family: 4 as const }];
      },
    };
    const port = createUserMcpHttpTransportPort(transportOptions);
    const invalid = await port
      .open({ ...binding, sessionId: 'fake' } as unknown as typeof binding, {
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: 'mcp_http_binding_invalid' });
    const sessionBinding = {
      originalStoreId: binding.originalStoreId,
      serverId: binding.serverId,
      configuration,
      configDigest: binding.configDigest,
      sessionId: 'real-session',
      executionId: 'real-execution',
      scopeId: JSON.stringify([binding.originalStoreId, 'real-session', server.id]),
    };
    expect(
      await port
        .open(sessionBinding as unknown as typeof binding, { signal: new AbortController().signal })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'mcp_http_binding_invalid' });
    expect(
      await createMcpHttpTransportPort(transportOptions)
        .open(binding as unknown as typeof sessionBinding, { signal: new AbortController().signal })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'mcp_http_binding_invalid' });
    expect(admissions).toBe(0);
    expect(dns).toBe(0);
    expect(f.wire).toEqual([]);
    const owned = await port.open(binding, { signal: new AbortController().signal });
    expect(admissions).toBe(1);
    expect(dns).toBe(1);
    try {
      await owned.transport.start();
      const denied = await owned.transport
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'effect', arguments: {} },
        })
        .catch((error: unknown) => error);
      expect(denied).toMatchObject({ code: 'mcp_settings_method_denied' });
      expect(f.wire).toEqual([]);
    } finally {
      expect((await owned.stop()).status).toBe('stopped');
    }
  } finally {
    await f.close();
  }
});

for (const auth of ['credential', 'oauth'] as const)
  test(`real connection Jobs in two Workspaces reuse only the explicit global ${auth} account and retain their own permission gates`, async () => {
    const f = await fixture(auth, true);
    try {
      const serverId = (await f.manager().read(f.identity)).sources[0]!.id;
      expect(
        (
          await f.mutate(
            'global-auth',
            auth === 'credential'
              ? { kind: 'bind', serverId, expiresAt: Date.now() + 60000 }
              : { kind: 'login', serverId },
          )
        ).state,
      ).toBe('applied');
      expect(f.permissionCalls).toEqual([]);
      for (const id of ['one', 'two']) {
        const workspace = join(f.root, id);
        privateDirectory(workspace);
        await f.runtime.createWorkspace({
          expectedStoreId: f.expectedStoreId,
          id,
          name: id,
          rootUri: pathToFileURL(workspace).href,
        });
        await f.runtime.createSession({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId: `session-${id}`,
          sessionId: id,
          workspaceId: id,
          title: id,
        });
      }
      const invoke = async (sessionId: string, commandId: string) => {
        await f.runtime.submitCommand({
          ...f.identity,
          sessionId,
          commandId,
          request: {
            kind: 'extension.invoke',
            extensionId: 'builtin.mcp',
            actionId: 'mcp.connect',
            definitionVersion: '1',
            input: { serverId, key: commandId },
          },
        });
        await f.runtime.waitForCommand(commandId, { timeoutMs: 5000 });
        return (await f.store.listExecutions(sessionId)).find(
          (row) => row.originCommandId === commandId,
        )!;
      };
      expect((await invoke('one', 'denied')).status).toBe('failed');
      expect(f.wire).toEqual([]);
      f.allowAgent(true);
      expect((await invoke('one', 'connect-one')).status).toBe('succeeded');
      expect((await invoke('two', 'connect-two')).status).toBe('succeeded');
      const starts = f.wire.filter((row) => row.method === 'initialize');
      expect(starts).toHaveLength(2);
      expect(starts.map((row) => row.authorization)).toEqual([
        `Bearer synthetic-${auth === 'credential' ? 'manual-bearer' : 'oauth-access'}`,
        `Bearer synthetic-${auth === 'credential' ? 'manual-bearer' : 'oauth-access'}`,
      ]);
      expect(f.permissionCalls).toContain('mcp.source.connection');
      for (const id of ['one', 'two'])
        expect(
          (await f.store.listExecutions(id)).filter(
            (row) => row.definitionId === 'mcp.source.connection',
          ),
        ).toHaveLength(1);
      expect(f.wire.some((row) => row.method === 'tools/call')).toBe(false);
    } finally {
      await f.close();
    }
  }, 20000);

test('global Remove clears only the original local OAuth account and never revokes remote or shared credentials', async () => {
  const f = await fixture('oauth');
  try {
    const serverId = (await f.manager().read(f.identity)).sources[0]!.id;
    expect((await f.mutate('login-remove', { kind: 'login', serverId })).state).toBe('applied');
    const scope = userMcpOAuthScope(
      f.profile.profileAccessKey,
      f.expectedStoreId,
      readMcpSources({
        profilePath: f.profile.profilePath,
        scope: {
          mode: 'user',
          profileId: f.profile.profileAccessKey,
          storeId: f.expectedStoreId,
          sessionId: null,
          workspaceId: null,
        },
      }).entries[0]!,
    );
    const unrelated = { namespace: 'mcp.oauth' as const, ownerDigest: 'f'.repeat(64) };
    await f.vault.writeOwned(unrelated, 'synthetic-unrelated-account');
    const originalMaterial = await f.vault.readOwned(scope);
    expect(originalMaterial).not.toBeNull();
    const originalSource = readFileSync(f.path, 'utf8');
    for (const enabled of [false, true]) {
      expect(
        (await f.mutate(`toggle-oauth-${enabled}`, { kind: 'enabled', serverId, enabled })).state,
      ).toBe('applied');
      expect(readFileSync(f.path, 'utf8')).toBe(originalSource);
      expect(await f.vault.readOwned(scope)).toBe(originalMaterial);
    }
    const beforeWire = [...f.oauthWire];
    expect((await f.mutate('remove-oauth', { kind: 'remove', serverId })).state).toBe('applied');
    expect((await f.manager().read(f.identity)).sources).toHaveLength(0);
    expect(await f.vault.readOwned(scope)).toBeNull();
    expect(await f.vault.readOwned(unrelated)).toBe('synthetic-unrelated-account');
    expect(await f.vault.resolve(f.credential)).toBe('synthetic-manual-bearer');
    expect(f.oauthWire).toEqual(beforeWire);
  } finally {
    await f.close();
  }
});

test('global Remove checks OAuth availability before source publication and never repeats unknown local cleanup', async () => {
  const f = await fixture('oauth');
  try {
    const serverId = (await f.manager().read(f.identity)).sources[0]!.id;
    expect((await f.mutate('login-remove-failure', { kind: 'login', serverId })).state).toBe(
      'applied',
    );
    const status = f.vault.statusOwned;
    f.vault.statusOwned = async () => 'locked';
    const original = readFileSync(f.path, 'utf8');
    const locked = await f.mutate('remove-locked', { kind: 'remove', serverId });
    expect(locked.state).toBe('failed');
    expect(locked.receipt.configuration).toBe('unchanged');
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    f.vault.statusOwned = status;
    let removals = 0;
    f.vault.removeOwned = async () => {
      removals++;
      throw Error('synthetic-unknown-remove');
    };
    const view = await f.manager().read(f.identity);
    const input = {
      ...f.identity,
      commandId: 'remove-unknown',
      expectedReadSet: view.readSet!,
      operation: { kind: 'remove' as const, serverId },
    };
    const result = await f.manager().mutate(input);
    expect(result.state).toBe('outcome_unknown');
    expect(result.receipt.configuration).toBe('published');
    expect(result.receipt.code).toBe('mcp_source_removed_credential_cleanup_unknown');
    expect((await f.manager().read(f.identity)).sources).toHaveLength(0);
    expect(await f.manager().mutate(input)).toEqual(result);
    expect(await f.manager().lookup({ ...f.identity, commandId: input.commandId })).toEqual(result);
    expect(removals).toBe(1);
    expect(f.oauthWire).not.toContain('revoke');
  } finally {
    await f.close();
  }
});

for (const projectName of ['projectOnly', 'global'])
  test(`user default toggles preserve approved ${projectName} project sources without selecting unapproved sources`, async () => {
    const f = await fixture('none', true);
    try {
      f.allowAgent(true);
      const workspace = join(f.root, 'project');
      privateDirectory(join(workspace, '.kite-code'));
      writeFileSync(
        join(workspace, '.kite-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            [projectName]: {
              type: 'http',
              url: 'https://project.example.test/mcp',
              auth: { type: 'none' },
            },
            unapproved: {
              type: 'http',
              url: 'https://project.example.test/unapproved',
              auth: { type: 'none' },
            },
          },
        }),
        { mode: 0o600 },
      );
      await f.runtime.createWorkspace({
        expectedStoreId: f.expectedStoreId,
        id: 'project',
        name: 'Project',
        rootUri: pathToFileURL(workspace).href,
      });
      await f.runtime.createSession({
        ...f.identity,
        commandId: 'create-toggle-session',
        sessionId: 'review',
        workspaceId: 'project',
        title: 'Review',
      });
      const source = readMcpSources({
        profilePath: f.profile.profilePath,
        workspacePath: workspace,
        scope: {
          profileId: f.profile.profileAccessKey,
          storeId: f.expectedStoreId,
          sessionId: 'review',
          workspaceId: 'project',
        },
      });
      const projectServer = source.entries.find(
        (entry) => entry.server.name === projectName,
      )!.server;
      await f.runtime.submitCommand({
        ...f.identity,
        sessionId: 'review',
        commandId: 'approve-toggle-project',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp.sources',
          actionId: 'mcp.source.approve',
          definitionVersion: '1',
          input: {
            serverId: projectServer.id,
            expectedReadSet: source.readSet as unknown as Json,
          },
        },
      });
      const card = await until(
        async () =>
          (
            await f.store.listInteractions({
              expectedStoreId: f.expectedStoreId,
              sessionId: 'review',
              state: 'pending',
            })
          ).interactions[0] ?? null,
      );
      await f.runtime.answerInteraction({
        ...f.identity,
        commandId: 'answer-toggle-project',
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'question', answers: { decision: 'approved' } },
      });
      await f.runtime.waitForCommand('approve-toggle-project', { timeoutMs: 5000 });
      const command = (await f.runtime.getCommand('approve-toggle-project'))!,
        session = (await f.runtime.getSession('review'))!,
        savedWorkspace = (await f.runtime.getWorkspace('project'))!;
      const capture = () => f.sources!.capture({ command, session, workspace: savedWorkspace });
      const selected = async () => f.sources!.select(await capture(), f.sourceSelection()).servers;
      expect((await selected()).some((server) => server.id === projectServer.id)).toBe(true);
      const before = readFileSync(f.path, 'utf8');
      const userId = (await f.manager().read(f.identity)).sources[0]!.id;
      expect(
        (await f.mutate('disable-default', { kind: 'enabled', serverId: userId, enabled: false }))
          .state,
      ).toBe('applied');
      expect((await f.manager().read(f.identity)).sources[0]!.enabled).toBe(false);
      expect(f.sourceSelection().present).toBe(false);
      expect((await selected()).map((server) => server.name)).toEqual([projectName]);
      const current = await capture();
      expect(
        f.sources!.select(current, {
          present: true,
          configurations: [],
          disabledUserServerIds: [userId],
        }).servers,
      ).toEqual([]);
      expect(
        f
          .sources!.select(current, {
            present: true,
            configurations: [{ id: userId, enabled: true }],
            disabledUserServerIds: [userId],
          })
          .servers.map((server) => server.id),
      ).toEqual([userId]);
      expect(
        (await capture()).servers.find((server) => server.name === 'unapproved')!.admitted,
      ).toBe(false);
      expect(readFileSync(f.path, 'utf8')).toBe(before);
      expect(
        (
          await f.mutate('add-after-disable', {
            kind: 'add',
            name: 'later',
            entry: { type: 'http', url: 'https://later.example.test/mcp' },
          })
        ).state,
      ).toBe('applied');
      expect((await selected()).map((server) => server.name).sort()).toEqual(
        [projectName, 'later'].sort(),
      );
      expect(
        (await f.mutate('enable-default', { kind: 'enabled', serverId: userId, enabled: true }))
          .state,
      ).toBe('applied');
      expect(
        (await f.manager().read(f.identity)).sources.find((server) => server.id === userId)!
          .enabled,
      ).toBe(true);
      expect(f.sourceSelection().disabledUserServerIds).toEqual([]);
      expect(
        (await selected()).some(
          (server) => server.source.kind === 'workspace' && server.id === projectServer.id,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

test('explicit MCP allowlists override default user exclusions; empty stays empty and invalid defaults fail closed', async () => {
  const f = await fixture();
  try {
    const serverId = (await f.manager().read(f.identity)).sources[0]!.id;
    expect(
      (await f.mutate('disable-before-explicit', { kind: 'enabled', serverId, enabled: false }))
        .state,
    ).toBe('applied');
    const raw = readConfigurationFile({ path: f.userConfigurationPath }).value;
    expect(raw.mcp).toBeUndefined();
    expect(raw.disabledUserMcpSources).toEqual([serverId]);
    for (const mcp of [[], [{ id: serverId, enabled: true }]]) {
      writeFileSync(f.userConfigurationPath, JSON.stringify({ ...raw, mcp }));
      expect(f.sourceSelection().disabledUserServerIds).toEqual([]);
      expect(f.sourceSelection().configurations).toEqual(mcp);
      expect((await f.manager().read(f.identity)).sources[0]!.enabled).toBe(mcp.length > 0);
    }
    expect(
      (await f.mutate('disable-explicit', { kind: 'enabled', serverId, enabled: false })).state,
    ).toBe('applied');
    expect(readConfigurationFile({ path: f.userConfigurationPath }).value.mcp).toEqual([
      { id: serverId, enabled: false },
    ]);
    expect(
      (await f.mutate('enable-explicit', { kind: 'enabled', serverId, enabled: true })).state,
    ).toBe('applied');
    expect((await f.manager().read(f.identity)).sources[0]!.enabled).toBe(true);
    writeFileSync(
      f.userConfigurationPath,
      JSON.stringify({ disabledUserMcpSources: [serverId, serverId] }),
    );
    expect((await f.manager().read(f.identity)).errors).toEqual(['mcp_configuration_unavailable']);
    expect(() => disabledUserMcpSources({ disabledUserMcpSources: ['workspace'] })).toThrow(
      'mcp_configuration_unavailable',
    );
  } finally {
    await f.close();
  }
});
