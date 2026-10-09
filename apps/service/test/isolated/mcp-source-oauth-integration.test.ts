import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import {
  type CredentialBackend,
  createTemporaryCredentialBackend,
  mcpCanonical,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { CommandRecord, ExecutionRecord } from '@kite-ai/agent/storage';
import { createClient, decodeMcpAuthResult } from '@kite-ai/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { createMcpOAuthBrowser } from '../../src/mcp-oauth-browser';
import {
  decodeMcpOAuthLauncherEvidence,
  type McpOAuthLauncherEvidence,
} from '../../src/mcp-oauth-launcher-evidence';

const object = (v: unknown): Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
const sha = (v: Json) => createHash('sha256').update(mcpCanonical(v)).digest('hex');
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= end) throw Error('oauth_integration_deadline');
    await Bun.sleep(5);
  }
}

/** Actual SDK MCP endpoint and AS wire. Tokens never enter a public ledger or model fixture. */
async function peer(ownedLauncher = false) {
  const calls = {
    metadata: 0,
    register: 0,
    authorize: 0,
    token: 0,
    refresh: 0,
    revoke: 0,
    unauthorized: 0,
    initialize: 0,
    list: 0,
    tool: 0,
  };
  let invalidRefresh = false,
    tokenGeneration = 0;
  const tokens = new Set<string>(),
    codes = new Map<string, { challenge: string; redirect: string }>();
  const active = new Set<McpServer>();
  async function handleMcp(request: Request) {
    const sdk = new McpServer({ name: 'owned-oauth-peer', version: '1' });
    sdk.registerTool(
      'owned_effect',
      { description: '原SDK完整描述🙂\r\nTAIL', inputSchema: { value: z.literal('exact') } },
      async () => {
        calls.tool++;
        return { content: [{ type: 'text', text: 'owned effect' }] };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(sdk);
    try {
      await sdk.connect(transport);
      const response = await transport.handleRequest(request);
      // Stateless SDK transport is single-request; drain its actual response before close.
      const bytes = await response.arrayBuffer();
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally {
      await sdk.close();
      active.delete(sdk);
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        base = url.origin;
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        calls.metadata++;
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['tools'],
        });
      }
      if (url.pathname.startsWith('/.well-known/')) {
        calls.metadata++;
        return Response.json({
          issuer: base,
          authorization_endpoint: `${ownedLauncher ? base.replace('http:', 'https:') : base}/authorize`,
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
        calls.register++;
        const input = object(await request.json());
        return Response.json({ ...input, client_id: 'owned-client' });
      }
      if (url.pathname === '/authorize') {
        calls.authorize++;
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        const code = `owned-code-${calls.authorize}`,
          redirect = url.searchParams.get('redirect_uri')!;
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        return new Response(null, { status: 302, headers: { location: callback.href } });
      }
      if (url.pathname === '/token') {
        calls.token++;
        const body = new URLSearchParams(await request.text());
        if (body.get('grant_type') === 'refresh_token') {
          calls.refresh++;
          if (invalidRefresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        } else {
          const code = codes.get(body.get('code')!);
          expect(code).toBeDefined();
          expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
            code!.challenge,
          );
          expect(body.get('redirect_uri')).toBe(code!.redirect);
          codes.delete(body.get('code')!);
        }
        const token = `owned-access-${++tokenGeneration}`;
        tokens.clear();
        tokens.add(token);
        return Response.json({
          access_token: token,
          refresh_token: `owned-refresh-${tokenGeneration}`,
          token_type: 'Bearer',
          expires_in: 60,
        });
      }
      if (url.pathname === '/revoke') {
        calls.revoke++;
        expect(request.method).toBe('POST');
        tokens.clear();
        return new Response('');
      }
      if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
      const authorization = request.headers.get('authorization');
      if (!authorization || !tokens.has(authorization.replace(/^Bearer /, ''))) {
        calls.unauthorized++;
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      if (request.method === 'POST') {
        const rpc = object(await request.clone().json());
        if (rpc.method === 'initialize') calls.initialize++;
        if (rpc.method === 'tools/list') calls.list++;
      }
      return handleMcp(request);
    },
  });
  return {
    url: `${server.url.origin}/mcp`,
    counts: () => ({ ...calls }),
    invalidateRefresh() {
      invalidRefresh = true;
    },
    async close() {
      for (const sdk of active) await sdk.close();
      server.stop(true);
    },
  };
}

type Auth = 'implicit' | 'oauth' | 'none' | 'manual';
async function fixture(
  auth: Auth = 'oauth',
  options: { ask?: boolean; observer?: string; ownedLauncher?: boolean } = {},
) {
  const root = mkdtempSync('/private/tmp/kite-source-oauth-integration-');
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  const remote = await peer(options.ownedLauncher),
    temporary = createTemporaryCredentialBackend();
  let failRead = false,
    failRemove = false;
  let locked = false,
    browser = 0,
    clockOffset = 0,
    holdBrowser = false,
    heldCallback: URL | undefined;
  const vault = { read: 0, write: 0, remove: 0, status: 0 };
  const backend: CredentialBackend = {
    kind: 'temporary',
    async put(id, value) {
      vault.write++;
      await temporary.put(id, value);
    },
    async resolve(id) {
      vault.read++;
      if (failRead && id.startsWith('owned-credential:')) {
        failRead = false;
        throw Error('owned_read_reply_lost');
      }
      return temporary.resolve(id);
    },
    async remove(id) {
      vault.remove++;
      if (failRemove && id.startsWith('owned-credential:')) throw Error('owned_remove_failure');
      await temporary.remove(id);
    },
    async status() {
      vault.status++;
      return locked ? 'locked' : 'available';
    },
  };
  const source = () =>
    JSON.stringify({
      mcpServers: {
        owned: {
          type: 'http',
          url: remote.url,
          ...(auth === 'implicit'
            ? {}
            : {
                auth:
                  auth === 'manual'
                    ? {
                        type: 'credential',
                        credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
                      }
                    : { type: auth },
              }),
        },
      },
    });
  writeFileSync(sourcePath, source(), { mode: 0o600 });
  const holders: { close(): Promise<void> }[] = [];
  async function launch(sessionId = 's') {
    const configuration = createDefaultProcessConfiguration({
      profile,
      observerSubjectId: options.observer ?? 'owner',
      credentialBackend: backend,
      mcpSources: {
        http: { allowLoopbackForTests: true },
        oauth: {
          network: { allowLoopbackForTests: true },
          callbackTimeoutMs: 2000,
          now: () => Date.now() + clockOffset,
          async openBrowser(url, signal, observe) {
            browser++;
            signal.throwIfAborted();
            if (options.ownedLauncher) {
              const launcher = createMcpOAuthBrowser((argv, spawnOptions) =>
                Bun.spawn(
                  [
                    process.execPath,
                    '-e',
                    `const url=new URL(process.argv[1]);url.protocol='http:';
const response=await fetch(url,{redirect:'manual'});if(response.status!==302)process.exit(2);
const callback=new URL(response.headers.get('location'));
if(process.argv[2]==='hold')await new Promise(()=>{});
const result=await fetch(callback);if(result.status!==200)process.exit(3);`,
                    argv.at(-1)!,
                    holdBrowser ? 'hold' : 'complete',
                  ],
                  spawnOptions,
                ),
              );
              await launcher(url, signal, observe);
              return;
            }
            const response = await fetch(url, { redirect: 'manual', signal });
            expect(response.status).toBe(302);
            const callback = new URL(response.headers.get('location')!);
            if (holdBrowser) {
              heldCallback = callback;
              return;
            }
            expect((await fetch(callback, { signal })).status).toBe(200);
          },
        },
      },
      permissionPolicy: {
        readPolicy: (request) => ({
          mode: options.ask ? 'ask' : 'full',
          workspaceTrust: true,
          revision: 'owned-oauth-integration',
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
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId;
    const locks = createWorkspaceSerialLocks(profile);
    configuration.bindWorkspaceSerialLocks!(locks);
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      processConcurrency: 1,
      extensions: configuration.extensions,
      permissions: configuration.permissions!,
      conditions: configuration.conditions,
      initializeRunRequirements: configuration.initializeRunRequirements,
      supportsExtensionInputs: configuration.supportsExtensionInputs,
      resolveRunConfiguration: configuration.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: configuration.resolveRecoveryRunConfiguration,
    });
    configuration.permissionManagement?.(runtime);
    if (!(await store.getWorkspace('w')))
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(`${workspace}/`).href,
      });
    if (!(await store.getSession(sessionId)))
      await runtime.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: 'owned',
        subjectId: 'owner',
      });
    const service = await startService({
      runtime,
      subjectId: 'owner',
      buildId: 'owned-oauth-integration',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    const client = createClient({
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
    let closed = false;
    const holder = {
      runtime,
      store,
      storeId,
      client,
      sessionId,
      async directory() {
        return object(
          (await client.queryExtension(sessionId, 'builtin.mcp.sources', 'mcp.sources', {}))[0]!
            .payload,
        );
      },
      async terminal(id: string) {
        return until(async () => {
          const command = await runtime.getCommand(id);
          const executionId = object(command?.receipt).executionId;
          if (typeof executionId !== 'string') return null;
          const execution = await runtime.getExecution(executionId);
          return execution && !['planned', 'dispatching', 'running'].includes(execution.status)
            ? { command: command!, execution }
            : null;
        });
      },
      async auth(id: string, action = 'login', captured?: Record<string, Json>) {
        const directory = captured ?? (await holder.directory());
        const item = object((directory.items as Json[])[0]);
        await client.invokeExtension(sessionId, {
          expectedStoreId: storeId,
          commandId: id,
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp.sources',
          actionId: `mcp.auth.${action}`,
          definitionVersion: '1',
          input: { serverId: item.id!, expectedReadSet: directory.readSet! },
        });
        return holder.terminal(id);
      },
      async history(id: string) {
        const rows = await client.queryExtension(
          sessionId,
          'builtin.mcp.sources',
          'mcp.auth.result',
          { commandId: id },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actions).toEqual([]);
        expect(rows[0]!.artifactRefs).toEqual([]);
        expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(16384);
        expect(object(decodeMcpAuthResult(rows))).toEqual(object(rows[0]!.payload));
        return object(rows[0]!.payload);
      },
      async connect(id: string) {
        const directory = await holder.directory(),
          item = object((directory.items as Json[])[0]);
        const input = { serverId: item.id!, key: id };
        await client.invokeExtension(sessionId, {
          expectedStoreId: storeId,
          commandId: id,
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp',
          actionId: 'mcp.connect',
          definitionVersion: '1',
          input,
        });
        const original = await holder.terminal(id);
        const fact = object(
          (
            await client.queryExtension(sessionId, 'builtin.mcp', 'mcp.connection', {
              executionId: original.execution.id,
              ...input,
            })
          )[0]!.payload,
        );
        return { ...original, fact, input };
      },
      async close() {
        if (closed) return;
        const errors: unknown[] = [];
        client.disposeNetwork();
        for (const close of [
          () => service.close(),
          () => runtime.close(),
          () => locks.close(),
          () => store.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'owned_service_cleanup_unconfirmed');
        closed = true;
      },
    };
    holders.push(holder);
    return holder;
  }
  return {
    root,
    remote,
    sourcePath,
    workspace,
    launch,
    counts: () => ({ browser, vault: { ...vault }, remote: remote.counts() }),
    locked() {
      locked = true;
    },
    unlock() {
      locked = false;
    },
    loseRead() {
      failRead = true;
    },
    failCleanup() {
      failRemove = true;
    },
    expire() {
      clockOffset = 120000;
    },
    hold() {
      holdBrowser = true;
    },
    async callback() {
      expect(heldCallback).toBeDefined();
      expect((await fetch(heldCallback!)).status).toBe(200);
      heldCallback = undefined;
      holdBrowser = false;
    },
    mutateSource() {
      writeFileSync(sourcePath, `${source().slice(0, -1)},"revision":"changed"}`, { mode: 0o600 });
    },
    removePhysical() {
      rmSync(sourcePath);
      renameSync(workspace, join(root, 'removed-workspace'));
    },
    async close() {
      const errors: unknown[] = [];
      for (const holder of [...holders].reverse())
        try {
          await holder.close();
        } catch (e) {
          errors.push(e);
        }
      try {
        await remote.close();
      } catch (e) {
        errors.push(e);
      }
      if (errors.length) throw new AggregateError(errors, 'owned_oauth_cleanup_unconfirmed');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function originalProof(
  original: { command: CommandRecord; execution: ExecutionRecord },
  fact: Record<string, Json>,
) {
  expect(object(fact.command).id).toBe(original.command.id);
  expect(object(fact.command).originStoreId).toBe(original.command.originStoreId);
  expect(object(fact.execution).id).toBe(original.execution.id);
  expect(object(fact.execution).originCommandId).toBe(original.execution.originCommandId);
  expect(object(fact.execution).inputDigest).toBe(sha(original.execution.input));
}

test('implicit real 401 permits explicit Login; fresh connect and cold owned token resume do not auto-login or retry old Tools', async () => {
  const f = await fixture('implicit', { ownedLauncher: true });
  try {
    const warm = await f.launch();
    const absent = await warm.auth('before-401');
    expect(absent.execution.status).toBe('failed');
    expect(f.counts().browser).toBe(0);
    const challenged = await warm.connect('challenge');
    expect(challenged.fact.phase).not.toBe('ready');
    expect(f.remote.counts().unauthorized).toBeGreaterThan(0);
    expect(f.counts().browser).toBe(0);
    const challengeChild = await until(async () => {
      const children = (await warm.store.listExecutions('s')).filter(
        (e) => e.parentExecutionId === challenged.execution.id,
      );
      const child = children.find((e) => !['planned', 'dispatching', 'running'].includes(e.status));
      return child ?? null;
    });
    const childResult = object(challengeChild.result);
    console.error(
      JSON.stringify({
        stage: 'oauth_challenge_terminal',
        executionId: challengeChild.id,
        parentExecutionId: challengeChild.parentExecutionId,
        status: challengeChild.status,
        details: { transportStopped: object(childResult.details).transportStopped ?? null },
      }),
    );
    const login = await warm.auth('login');
    const fact = await warm.history('login');
    originalProof(login, fact);
    expect(fact.phase).toBe('completed');
    expect(fact.authStatus).toBe('authenticated');
    const originalExecution = await warm.client.getExecution(login.execution.id);
    const launcher = object(originalExecution.result).details as Record<string, Json>;
    const proof = launcher.ownedLauncher as unknown as McpOAuthLauncherEvidence;
    expect(proof).toMatchObject({
      version: 1,
      coverage: 'oauth-launcher-only',
      browserOwnership: 'external',
      ownerPid: process.pid,
      launcher: { exit: { reaped: true }, kernelState: 'absent' },
    });
    expect(proof.binding).toEqual(
      launcher.binding as unknown as McpOAuthLauncherEvidence['binding'],
    );
    expect(proof.binding.executionId).toBe(login.execution.id);
    expect(proof.binding.originCommandId).toBe(login.command.id);
    expect(proof.binding.inputDigest).toBe(sha(login.execution.input));
    if (process.platform === 'darwin') {
      expect(proof.launcher.birth).not.toBeNull();
      expect(proof.launcher.parentPid).toBe(process.pid);
    } else expect(proof.launcher.birth).toBeNull();
    expect(originalExecution.result).toEqual(login.execution.result);
    expect(
      decodeMcpOAuthLauncherEvidence(proof, { ...proof.binding, sessionId: 'foreign' }),
    ).toBeUndefined();
    expect(JSON.stringify(proof)).not.toContain('owned-code');
    expect(JSON.stringify(proof)).not.toContain('owned-client');
    expect(JSON.stringify(proof)).not.toContain('code_verifier');
    expect(f.remote.counts().initialize).toBe(0);
    const connected = await warm.connect('fresh');
    if (connected.fact.phase !== 'ready') {
      const result = object(connected.execution.result);
      const code =
        typeof result.code === 'string' && /^[a-z0-9_]{1,128}$/.test(result.code)
          ? result.code
          : null;
      console.error(
        JSON.stringify({
          stage: 'oauth_fresh_connect_failure',
          commandId: connected.command.id,
          executionId: connected.execution.id,
          status: connected.execution.status,
          phase: connected.fact.phase,
          code,
          resultKeys: Object.keys(result),
          contentCode:
            typeof result.content === 'string' && /^[a-z0-9_]{1,128}$/.test(result.content)
              ? result.content
              : null,
          detailKeys: Object.keys(object(result.details)),
          counters: f.remote.counts(),
        }),
      );
    }
    expect(connected.fact.phase).toBe('ready');
    expect(connected.fact.live).toBe(true);
    expect(f.remote.counts().initialize).toBe(1);
    expect(f.remote.counts().list).toBe(1);
    expect(f.remote.counts().tool).toBe(0);
    await warm.close();
    const before = f.counts();
    const cold = await f.launch();
    expect((await cold.history('login')).phase).toBe('completed');
    const coldExecution = await cold.client.getExecution(login.execution.id);
    expect(object(object(coldExecution.result).details).ownedLauncher).toEqual(
      proof as unknown as Json,
    );
    expect(await cold.client.getExecution(login.execution.id)).toEqual(originalExecution);
    expect(f.counts()).toEqual(before);
    const resumed = await cold.connect('cold-fresh');
    expect(resumed.fact.phase).toBe('ready');
    expect(f.counts().browser).toBe(before.browser);
    expect(f.remote.counts().register).toBe(before.remote.register);
    expect(f.remote.counts().tool).toBe(0);
    expect((await cold.runtime.getView('s')).runs).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

for (const auth of ['none', 'manual'] as const)
  test(`explicit ${auth} never upgrades a challenge to OAuth`, async () => {
    const f = await fixture(auth);
    try {
      const host = await f.launch();
      await host.connect('blocked');
      const action = await host.auth('no-upgrade');
      expect(action.execution.status).toBe('failed');
      expect(f.counts().browser).toBe(0);
      expect(f.remote.counts().register).toBe(0);
      expect(f.remote.counts().token).toBe(0);
      expect(f.remote.counts().tool).toBe(0);
    } finally {
      await f.close();
    }
  }, 30000);

test('invalid refresh is explicit reauth_required without browser/register or old Tool retry; history survives absent source and physical Workspace', async () => {
  const f = await fixture();
  try {
    const host = await f.launch();
    await host.auth('login');
    const before = f.counts();
    f.remote.invalidateRefresh();
    f.expire();
    const refresh = await host.auth('refresh', 'refresh');
    const fact = await host.history('refresh');
    originalProof(refresh, fact);
    expect(fact.phase).toBe('failed');
    expect(fact.authStatus).toBe('reauth_required');
    expect(f.counts().browser).toBe(before.browser);
    expect(f.remote.counts().register).toBe(before.remote.register);
    expect(f.remote.counts().tool).toBe(0);
    const metadata = await host.store.getMetadata();
    f.removePhysical();
    const counts = f.counts();
    expect((await host.history('login')).phase).toBe('completed');
    expect((await host.history('refresh')).phase).toBe('failed');
    expect(f.counts()).toEqual(counts);
    expect(await host.store.getMetadata()).toEqual(metadata);
  } finally {
    await f.close();
  }
}, 30000);

test('locked preflight and full captured read-set drift have no browser/AS publication', async () => {
  const f = await fixture();
  try {
    const host = await f.launch(),
      directory = await host.directory();
    f.locked();
    const locked = await host.auth('locked', 'login', directory);
    expect(locked.execution.status).toBe('failed');
    expect(f.counts().browser).toBe(0);
    expect(f.remote.counts().register).toBe(0);
    f.mutateSource();
    const drift = await host.auth('drift', 'login', directory);
    expect(drift.execution.status).toBe('failed');
    expect(f.remote.counts().token).toBe(0);
    expect(f.counts().vault.write).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

test('ordinary Auth Ask is independent; explicit execution.cancel closes only owned callback and preserves original history', async () => {
  const f = await fixture('oauth', { ask: true, ownedLauncher: true });
  try {
    const host = await f.launch();
    f.hold();
    const work = host.auth('cancel-login');
    const card = await until(
      async () =>
        (
          await host.store.listInteractions({
            expectedStoreId: host.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(card.kind).toBe('approval');
    expect(f.counts().browser).toBe(0);
    expect(f.remote.counts().metadata).toBe(0);
    await host.client.answerInteraction('s', card.id, {
      expectedStoreId: host.storeId,
      commandId: 'approve-login',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await until(async () => (f.counts().browser === 1 ? true : null));
    const command = await host.runtime.getCommand('cancel-login'),
      executionId = object(command?.receipt).executionId;
    expect(typeof executionId).toBe('string');
    await host.client.cancelExecution('s', {
      expectedStoreId: host.storeId,
      commandId: 'cancel-original',
      kind: 'execution.cancel',
      executionId: executionId as string,
    });
    const original = await work,
      fact = await host.history('cancel-login');
    originalProof(original, fact);
    expect(fact.phase).toBe('cancelled');
    const launcher = object(object(original.execution.result).details)
      .ownedLauncher as unknown as McpOAuthLauncherEvidence;
    expect(launcher).toMatchObject({
      coverage: 'oauth-launcher-only',
      browserOwnership: 'external',
      launcher: { exit: { reaped: true }, kernelState: 'absent' },
    });
    expect(launcher.binding.executionId).toBe(original.execution.id);
    const publicExecution = await host.client.getExecution(original.execution.id);
    expect(object(object(publicExecution.result).details).ownedLauncher).toEqual(
      launcher as unknown as Json,
    );
    expect(f.remote.counts().token).toBe(0);
    expect(f.counts().vault.write).toBeGreaterThan(0);
    expect(f.remote.counts().tool).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

test('two actual Services on one Profile coordinate Auth across distinct Sessions; only the released holder permits second browser', async () => {
  const f = await fixture();
  try {
    const first = await f.launch('s'),
      second = await f.launch('s2');
    f.hold();
    const a = first.auth('first-login');
    await until(async () => (f.counts().browser === 1 ? true : null));
    const b = second.auth('second-login');
    await until(async () =>
      (await second.runtime.getCommand('second-login'))?.status === 'applied' ? true : null,
    );
    expect(f.counts().browser).toBe(1);
    expect(f.remote.counts().token).toBe(0);
    await f.callback();
    const originalA = await a;
    expect(originalA.execution.status).toBe('succeeded');
    const originalB = await b;
    expect(originalB.execution.status).toBe('succeeded');
    expect(f.counts().browser).toBe(2);
    expect(f.remote.counts().token).toBe(2);
    originalProof(originalA, await first.history('first-login'));
    originalProof(originalB, await second.history('second-login'));
    expect(f.remote.counts().tool).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

test('lost owned read does not restart authorization; clear and reLogin do not give the old connection a fresh credential permit', async () => {
  const f = await fixture();
  try {
    const host = await f.launch();
    await host.auth('login');
    const connection = await host.connect('original-holder');
    expect(connection.fact.phase).toBe('ready');
    const before = f.counts();
    f.loseRead();
    const lost = await host.auth('lost-read', 'refresh');
    expect(lost.execution.status).toBe('failed');
    expect(f.counts().browser).toBe(before.browser);
    expect(f.remote.counts().register).toBe(before.remote.register);
    expect(f.remote.counts().token).toBe(before.remote.token);
    const cleared = await host.auth('clear', 'clear');
    expect(cleared.execution.status).toBe('succeeded');
    expect((await host.history('clear')).authStatus).toBe('revoked');
    await host.auth('relogin');
    const counts = f.counts();
    const old = object(
      (
        await host.client.queryExtension('s', 'builtin.mcp', 'mcp.connection', {
          executionId: connection.execution.id,
          ...connection.input,
        })
      )[0]!.payload,
    );
    expect(object(old.execution).id).toBe(connection.execution.id);
    // Authentication and connection health are separate. An actual wire use of the old
    // credential holder must fail; a cached live catalogue is not credential proof.
    const ready = object(old.ready),
      ref = object(old.operationRef);
    const holderId = String(ref.executionId);
    await host.client.invokeExtension('s', {
      expectedStoreId: host.storeId,
      commandId: 'old-refresh',
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp',
      actionId: 'mcp.catalogue.refresh',
      definitionVersion: '1',
      input: {
        serverId: connection.input.serverId,
        connectionKey: String(ref.key).split('/').pop()!,
        connectionExecutionId: holderId,
        configDigest: ready.configDigest!,
        generation: ready.generation!,
      },
    });
    const stale = await host.terminal('old-refresh');
    console.error(
      JSON.stringify({
        stage: 'oauth_old_holder_result',
        status: stale.execution.status,
        contentCode:
          typeof object(stale.execution.result).content === 'string' &&
          /^[a-z0-9_]{1,128}$/.test(String(object(stale.execution.result).content))
            ? object(stale.execution.result).content
            : null,
        counters: f.remote.counts(),
      }),
    );
    expect(stale.execution.status).toBe('outcome_unknown');
    const afterOldUse = f.counts();
    expect(afterOldUse.remote).toEqual(counts.remote);
    expect(afterOldUse.browser).toBe(counts.browser);
    expect(afterOldUse.vault).toEqual({ ...counts.vault, read: counts.vault.read + 1 });
    expect(f.remote.counts().tool).toBe(0);
    await host.client.cancelExecution('s', {
      expectedStoreId: host.storeId,
      commandId: 'close-original-holder',
      kind: 'execution.cancel',
      executionId: holderId,
    });
    await until(async () => {
      const e = await host.runtime.getExecution(holderId);
      return e && !['planned', 'dispatching', 'running'].includes(e.status) ? e : null;
    });
    const fresh = await host.connect('replacement-holder');
    expect(fresh.fact.phase).toBe('ready');
    expect(f.remote.counts().tool).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

test('approval-time Source drift and mismatched trusted observer/Store cause no authentication publication', async () => {
  const f = await fixture('oauth', { ask: true });
  try {
    const host = await f.launch();
    const work = host.auth('drift-ask');
    const card = await until(
      async () =>
        (
          await host.store.listInteractions({
            expectedStoreId: host.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    f.mutateSource();
    await host.client.answerInteraction('s', card.id, {
      expectedStoreId: host.storeId,
      commandId: 'approve-drift',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect((await work).execution.status).toBe('failed');
    expect(f.counts().browser).toBe(0);
    expect(f.remote.counts().metadata).toBe(0);
    expect(f.counts().vault.write).toBe(0);
    const d = await host.directory(),
      item = object((d.items as Json[])[0]);
    await expect(
      host.client.invokeExtension('s', {
        expectedStoreId: 'foreign',
        commandId: 'foreign-store',
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp.sources',
        actionId: 'mcp.auth.login',
        definitionVersion: '1',
        input: { serverId: item.id!, expectedReadSet: d.readSet! },
      }),
    ).rejects.toBeDefined();
    expect(f.counts().browser).toBe(0);
  } finally {
    await f.close();
  }
  // Explicit trusted-composition mismatch fault; never a public caller-supplied subject.
  const mismatch = await fixture('oauth', { observer: 'other' });
  try {
    const host = await mismatch.launch();
    const original = await host.auth('wrong-observer');
    expect(original.execution.status).toBe('failed');
    expect(mismatch.counts().browser).toBe(0);
    expect(mismatch.remote.counts().metadata).toBe(0);
    expect(mismatch.counts().vault.write).toBe(0);
  } finally {
    await mismatch.close();
  }
}, 30000);

for (const failure of [false, true])
  test(`Source remove saves only the declaration and reports ${failure ? 'outcome_unknown' : 'completed'} credential cleanup independently`, async () => {
    const f = await fixture();
    try {
      const host = await f.launch();
      await host.auth('login');
      const directory = await host.directory(),
        item = object((directory.items as Json[])[0]);
      if (failure) f.failCleanup();
      const counts = f.remote.counts();
      await host.client.invokeExtension('s', {
        expectedStoreId: host.storeId,
        commandId: 'remove',
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp.sources',
        actionId: 'mcp.source.remove',
        definitionVersion: '1',
        input: {
          scope: 'user',
          serverId: item.id!,
          expectedRawEntryDigest: item.rawEntryDigest!,
          expectedReadSet: directory.readSet!,
        },
      });
      const original = await host.terminal('remove');
      expect(original.execution.status).toBe(failure ? 'outcome_unknown' : 'succeeded');
      const fact = object(
        (
          await host.client.queryExtension(
            's',
            'builtin.mcp.sources',
            'mcp.source.mutation.result',
            {
              commandId: 'remove',
            },
          )
        )[0]!.payload,
      );
      expect(fact.phase).toBe('saved');
      expect(object(fact.credentialCleanup)).toEqual({
        status: failure ? 'outcome_unknown' : 'completed',
        attempted: true,
      });
      expect(object(fact.command).id).toBe('remove');
      expect(object(fact.execution).id).toBe(original.execution.id);
      expect(object(fact.mutation).state).toBe('applied');
      expect(f.remote.counts()).toEqual(counts);
      expect(f.remote.counts().tool).toBe(0);
      expect((await host.directory()).items).toEqual([]);
      expect((await host.history('login')).phase).toBe('completed');
    } finally {
      await f.close();
    }
  }, 30000);
