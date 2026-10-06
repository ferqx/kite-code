import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import {
  type createCredentialVault,
  createTemporaryCredentialBackend,
} from '@kite-ai/agent/config';
import { createMcpCredentialBroker, type McpCredentialRef } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { InteractionRecord } from '@kite-ai/agent/storage';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';

function gate() {
  let release!: () => void, entered!: () => void;
  return {
    wait: new Promise<void>((resolve) => (release = resolve)),
    seen: new Promise<void>((resolve) => (entered = resolve)),
    release: () => release(),
    enter: () => entered(),
  };
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-broker-'))),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'temporary' }),
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
    metadata = await store.getMetadata();
  await store.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'temporary',
  });
  for (const id of ['a', 'b'])
    await store.createSession({
      expectedStoreId: metadata.storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      subjectId: 'owner',
      title: id,
    });
  let requests = 0,
    calls = 0,
    lookups = 0,
    allow = true,
    awaitingApproval = false,
    now = Date.now(),
    mode: 'normal' | 'scope' | 'expired' | 'revoked' | 'purpose' = 'normal';
  let lookupGate: ReturnType<typeof gate> | undefined,
    requestGate: ReturnType<typeof gate> | undefined;
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    requests++;
    received.push(req.headers.authorization ?? '');
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const rpc = JSON.parse(Buffer.concat(parts).toString()) as { id?: number; method: string };
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'local', version: '1' },
        capabilities: { tools: {} },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [{ name: 'effect', inputSchema: { type: 'object', additionalProperties: false } }],
      };
    else {
      calls++;
      const hold = requestGate;
      if (hold) {
        hold.enter();
        await hold.wait;
      }
      result = { content: [{ type: 'text', text: 'physical request completed' }] };
    }
    if (!res.destroyed)
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://broker-fixture.invalid:${(server.address() as { port: number }).port}/mcp`;
  const backend = createTemporaryCredentialBackend(),
    secret = `private-fixture-${crypto.randomUUID()}`,
    refs = new Map<string, McpCredentialRef>(),
    storedRefs = new Map<string, string>();
  let storedRef = '',
    factoryCalls = 0;
  let vault!: ReturnType<typeof createCredentialVault>;
  const providerRequests: Record<string, unknown>[] = [];
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages: { role: string; content: string }[];
        tools: { function: { name: string } }[];
      };
      providerRequests.push(body);
      const marker = body.messages
        .filter((message) => message.role === 'user' && message.content.startsWith('broker-run-'))
        .slice(-1)[0]!.content;
      const step = steps.get(marker) ?? 0;
      steps.set(marker, step + 1);
      const connecting = marker.includes('connect');
      const remote = body.tools.find((tool) => tool.function.name.startsWith('mcp.local.'));
      const call =
        connecting && step === 0
          ? {
              name: 'mcp.connect',
              input: { serverId: 'local', key: marker.includes('-b') ? 'first-b' : 'first-a' },
            }
          : (connecting ? step === 1 : step === 0) && remote
            ? { name: remote.function.name, input: {} }
            : null;
      const chunk = {
        id: 'local',
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
                      id: `call-${providerRequests.length}`,
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
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [
        { id: 'local', provider: 'compatible', model: 'local', baseURL: `${provider.url.href}v1` },
      ],
      tools: [{ id: 'mcp.connect', definitionVersion: '1' }],
      mcp: [{ id: 'local' }],
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      put: (id, secret) => backend.put(id, secret),
      remove: (id) => backend.remove(id),
      resolve: async (id) => {
        lookups++;
        const hold = lookupGate;
        if (hold) {
          hold.enter();
          await hold.wait;
        }
        return backend.resolve(id);
      },
    },
    permissions: {
      authorize: async (request) =>
        awaitingApproval && request.kind !== 'model'
          ? {
              allowed: false,
              revision: 'explicit-connection-permission-1',
              approval: { request: { title: 'Exact connection transport' } },
            }
          : { allowed: allow, revision: 'explicit-connection-permission-1' },
    },
    mcp: (context) => {
      factoryCalls++;
      vault = context.credentialVault;
      expect(context.profile.profileAccessKey).toBe(profile.profileAccessKey);

      const broker = createMcpCredentialBroker({ now: () => now, vault });
      const port = createMcpHttpTransportPort({
        servers: [
          {
            id: 'local',
            url,
            credential: {
              broker,
              async bind(binding) {
                const job = await store.getExecution(binding.executionId);
                expect(job?.status).toBe('dispatching');
                expect(job?.originStoreId).toBe(binding.originalStoreId);
                expect(job?.definitionVersion).toBe(binding.configDigest);
                const session = await store.getSession(binding.sessionId),
                  workspace = await store.getWorkspace(session!.workspaceId);
                const identity = {
                  profileId: profile.profileAccessKey,
                  originalStoreId: job!.originStoreId,
                  workspaceId: workspace!.id,
                  workspaceIdentity: realpathSync(fileURLToPath(workspace!.rootUri)),
                  sessionId: session!.id,
                  connectionExecutionId: job!.id,
                  source: { kind: 'programmatic' as const, id: 'trusted-host', revision: 'host-1' },
                  serverId: binding.serverId,
                  configDigest: binding.configDigest,
                  authProfileId: 'fixture-profile',
                  policyRevision: 'explicit-connection-permission-1',
                };
                const ref = broker.issue({
                  credentialRef: storedRefs.get(session!.id)!,
                  identity,
                  purpose: mode === 'purpose' ? ('other' as 'mcp.http') : 'mcp.http',
                  expiresAt: now + 60000,
                  revocationRevision: 0,
                });
                refs.set(session!.id, ref);
                if (mode === 'revoked') broker.revoke(ref);
                if (mode === 'expired') now += 60000;
                return {
                  ref,
                  identity: mode === 'scope' ? { ...identity, sessionId: 'other' } : identity,
                  revocationRevision: 0,
                };
              },
            },
          },
        ],
        allowLoopbackForTests: true,
        resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        async admit(binding) {
          const execution = await store.getExecution(binding.executionId);
          if (
            !allow ||
            execution?.kind !== 'job' ||
            execution.originStoreId !== metadata.storeId ||
            execution.status !== 'dispatching'
          )
            throw Error('unadmitted');
        },
      });
      return { servers: [{ id: 'local', transport: { type: 'http', url } }], transportPort: port };
    },
  });
  const runtime = createRuntime({
    store,
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const manager = host.configurationManagement!(runtime);
  expect(lookups).toBe(0);
  expect(requests).toBe(0);
  expect(factoryCalls).toBe(1);
  const saved = await manager.putCredential({
    commandId: 'put',
    subjectId: 'owner',
    expectedStoreId: metadata.storeId,
    secret,
  });
  storedRef = (saved.receipt as { opaqueRef: string }).opaqueRef;
  storedRefs.set('a', storedRef);
  const other = await manager.putCredential({
    commandId: 'put-b',
    subjectId: 'owner',
    expectedStoreId: metadata.storeId,
    secret: `${secret}-b`,
  });
  storedRefs.set('b', (other.receipt as { opaqueRef: string }).opaqueRef);
  return {
    runtime,
    store,

    refs,
    secret,
    manager,
    storedRef,
    storedRefs,
    get factoryCalls() {
      return factoryCalls;
    },
    get providerCount() {
      return providerRequests.length;
    },
    received,
    get requests() {
      return requests;
    },
    get calls() {
      return calls;
    },
    get lookups() {
      return lookups;
    },
    set ask(value: boolean) {
      awaitingApproval = value;
    },
    expectedStoreId: metadata.storeId,
    set allow(value: boolean) {
      allow = value;
    },
    set mode(value: typeof mode) {
      mode = value;
    },
    set lookupGate(value: typeof lookupGate) {
      lookupGate = value;
    },
    set requestGate(value: typeof requestGate) {
      requestGate = value;
    },
    async run(sessionId: string, commandId: string) {
      await runtime.submitCommand({
        expectedStoreId: metadata.storeId,
        sessionId,
        commandId,
        subjectId: 'owner',
        request: { kind: 'run.start', content: `broker-run-${commandId}` },
      });
      return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    },
    async cancel(sessionId: string) {
      return runtime.cancelSession({
        expectedStoreId: metadata.storeId,
        sessionId,
        subjectId: 'owner',
        commandId: `stop-${sessionId}`,
        includeBackground: true,
      });
    },
    async close() {
      lookupGate?.release();
      requestGate?.release();
      await runtime.close();
      provider.stop(true);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default trusted MCP factory shares management vault; compatible Model connects then consumes actual remote catalogue, revoked future requests remain isolated', async () => {
  const f = await fixture();
  try {
    await f.run('a', 'connect-a');
    await f.run('b', 'connect-b');
    expect(f.calls).toBe(2);
    expect(f.factoryCalls).toBe(1);
    const before = f.requests;
    const old = (await f.store.listExecutions('a')).find(
      (item) => item.kind === 'tool' && item.definitionId.startsWith('mcp.local.'),
    );
    expect(old?.status).toBe('succeeded');
    const revoked = await f.manager.revokeCredential({
      commandId: 'revoke',
      subjectId: 'owner',
      expectedStoreId: f.expectedStoreId,
      opaqueRef: f.storedRef,
    });
    expect(revoked.state).toBe('applied');
    await f.run('a', 'after-a');
    expect(f.requests).toBe(before);
    expect(f.calls).toBe(2);
    await f.run('b', 'after-b');
    expect(f.calls).toBe(3);
    expect((await f.store.getExecution(old!.id))?.status).toBe('succeeded');
    for (const session of ['a', 'b'])
      expect(JSON.stringify(await f.runtime.getView(session))).not.toContain(f.secret);
    expect(
      JSON.stringify(
        await f.manager.getMutation({
          commandId: 'put',
          subjectId: 'owner',
          expectedStoreId: f.expectedStoreId,
        }),
      ),
    ).not.toContain(f.secret);
    expect(
      JSON.stringify(
        await f.manager.getMutation({
          commandId: 'revoke',
          subjectId: 'owner',
          expectedStoreId: f.expectedStoreId,
        }),
      ),
    ).not.toContain(f.secret);
  } finally {
    await f.close();
  }
}, 15000);
test('default Model can propose connection while durable approval retains zero secret/socket; management revoke during lookup prevents the late remote request', async () => {
  const f = await fixture();
  try {
    f.ask = true;
    const work = f.run('a', 'connect-a');
    void work.catch(() => {});
    const deadline = Date.now() + 5000;
    let card: InteractionRecord | undefined;
    while (!card) {
      card = (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions[0];
      if (card) break;
      if (Date.now() > deadline) throw Error('card_deadline');
      await Bun.sleep(5);
    }
    expect(f.providerCount).toBe(1);
    expect(f.lookups).toBe(0);
    expect(f.requests).toBe(0);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'owner',
      commandId: 'cancel',
      targetCommandId: 'connect-a',
    });
    await work;
    f.ask = false;
    await f.run('b', 'connect-b');
    const before = f.requests,
      waiting = gate();
    f.lookupGate = waiting;
    const pending = f.run('b', 'after-b');
    await waiting.seen;
    await f.manager.revokeCredential({
      commandId: 'revoke-pending',
      subjectId: 'owner',
      expectedStoreId: f.expectedStoreId,
      opaqueRef: f.storedRefs.get('b')!,
    });
    waiting.release();
    await pending;
    expect(f.requests).toBe(before);
    expect(f.calls).toBe(1);
    expect(JSON.stringify(await f.runtime.getView('b'))).not.toContain(f.secret);
  } finally {
    await f.close();
  }
}, 15000);
