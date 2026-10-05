import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createMcpAdapter, createMcpLifecycle } from '@kite-ai/agent/mcp';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';

async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error('http_port_deadline');
    await Bun.sleep(5);
  }
}
async function network() {
  const sockets = new Set<Socket>(),
    headers: { host?: string; authorization?: string }[] = [];
  let rpcCount = 0,
    calls = 0;
  let mode: 'normal' | 'redirect' | 'large' | 'wait' = 'normal';
  let release!: () => void;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const rpc = JSON.parse(Buffer.concat(parts).toString()) as { id?: number; method: string };
    headers.push({ host: req.headers.host, authorization: req.headers.authorization });
    rpcCount++;
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/never' }).end();
      return;
    }
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
        tools: [{ name: 'effect', inputSchema: { type: 'object' } }],
        ...(mode === 'large' ? { padding: 'x'.repeat(4096) } : {}),
      };
    else {
      calls++;
      if (mode === 'wait') await new Promise<void>((resolve) => (release = resolve));
      result = { content: [{ type: 'text', text: 'actual protocol result' }] };
    }
    if (!res.destroyed) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port,
    url = `http://mcp-fixture.invalid:${port}/mcp`;
  return {
    url,
    sockets,
    headers,
    get rpcCount() {
      return rpcCount;
    },
    get calls() {
      return calls;
    },
    set mode(value: typeof mode) {
      mode = value;
    },
    release() {
      release?.();
    },
    async close() {
      release?.();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function binding(url: string, executionId = 'actual-job') {
  return {
    serverId: 'local',
    scopeId: JSON.stringify(['store', 's', 'local']),
    sessionId: 's',
    executionId,
    originalStoreId: 'store',
    configuration: { type: 'http' as const, url },
    configDigest: createMcpAdapter({ id: 'local', transport: { type: 'http', url } }).getCatalogue()
      .configDigest,
  };
}

test('real HTTP sockets stay pinned across hostile resolver change, retain original Host and private header, and stop confirms only the owned transport', async () => {
  const n = await network();
  let resolutions = 0;
  const secret = 'Bearer test-secret-not-a-user-credential';
  const proxy = await network();
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'] as const;
  const proxyRoot = proxyKeys.map((key) => process.env[key]);
  for (const key of proxyKeys)
    process.env[key] =
      key === 'NODE_USE_ENV_PROXY' ? '1' : proxy.url.replace('mcp-fixture.invalid', '127.0.0.1');
  const port = createMcpHttpTransportPort({
    servers: [{ id: 'local', url: n.url, headers: { authorization: secret } }],
    allowLoopbackForTests: true,
    admit: async () => {},
    resolveAddresses: async () => {
      resolutions++;
      return resolutions === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    },
  });
  const owned = await port.open(binding(n.url), { signal: new AbortController().signal }),
    client = new Client({ name: 'test', version: '1' });
  try {
    expect(n.rpcCount).toBe(0);
    await client.connect(owned.transport);
    await client.listTools();
    await client.callTool({ name: 'effect', arguments: { value: 'exact' } });
    expect(resolutions).toBe(1);
    expect(n.calls).toBe(1);
    expect(
      n.headers.every((h) => h.host === new URL(n.url).host && h.authorization === secret),
    ).toBe(true);
    expect(proxy.rpcCount).toBe(0);
    expect(await owned.stop()).toEqual({ status: 'stopped' });
    expect(await owned.stopped).toEqual({ supervision: 'ended' });
    await until(() => n.sockets.size === 0);
    expect(n.sockets.size).toBe(0);
  } finally {
    await owned.stop();
    await n.close();
    await proxy.close();
    proxyKeys.forEach((key, index) => {
      if (proxyRoot[index] === undefined) delete process.env[key];
      else process.env[key] = proxyRoot[index];
    });
  }
}, 15000);

test('whole DNS candidate set, mapped IPv6/literal metadata and exact configuration reject before any RPC; redirect never follows', async () => {
  const n = await network();
  try {
    for (const candidates of [
      [
        { address: '1.1.1.1', family: 4 as const },
        { address: '10.0.0.1', family: 4 as const },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 as const }],
    ]) {
      const port = createMcpHttpTransportPort({
        servers: [{ id: 'local', url: n.url }],
        admit: async () => {},
        resolveAddresses: async () => candidates,
      });
      await expect(
        port.open(binding(n.url), { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'mcp_http_destination_denied' });
      expect(n.rpcCount).toBe(0);
    }
    const literal = 'http://169.254.169.254/mcp',
      literalPort = createMcpHttpTransportPort({
        servers: [{ id: 'local', url: literal }],
        admit: async () => {},
      });
    await expect(
      literalPort.open(binding(literal), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'mcp_http_destination_denied' });
    const port = createMcpHttpTransportPort({
      servers: [{ id: 'local', url: n.url }],
      allowLoopbackForTests: true,
      admit: async () => {},
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(
      port.open(
        {
          ...binding(n.url),
          configuration: { type: 'http', url: n.url, headers: { authorization: 'forbidden' } },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'mcp_http_binding_invalid' });
    expect(n.rpcCount).toBe(0);
    n.mode = 'redirect';
    const owned = await port.open(binding(n.url), { signal: new AbortController().signal });
    try {
      const client = new Client({ name: 'test', version: '1' });
      await expect(client.connect(owned.transport)).rejects.toThrow();
      expect(n.rpcCount).toBe(1);
    } finally {
      await owned.stop();
    }
  } finally {
    await n.close();
  }
}, 15000);

test('bounded request/response and abort destroy actual owned sockets; error text never exposes private header', async () => {
  const n = await network();
  const secret = 'Bearer opaque-fixture-header';
  const port = createMcpHttpTransportPort({
    servers: [{ id: 'local', url: n.url, headers: { authorization: secret } }],
    allowLoopbackForTests: true,
    limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 3000 },
    admit: async () => {},
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const controller = new AbortController();
  const owned = await port.open(binding(n.url), { signal: controller.signal }),
    client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(owned.transport);
    let text = '';
    try {
      await client.callTool({ name: 'effect', arguments: { value: 'x'.repeat(2048) } });
    } catch (error) {
      text = String(error);
    }
    expect(text).not.toContain(secret);
    expect(n.calls).toBe(0);
    n.mode = 'large';
    await expect(client.listTools()).rejects.toThrow();
    n.mode = 'wait';
    const call = client.callTool({ name: 'effect', arguments: { value: 'wait' } });
    void call.catch(() => {});
    await until(() => n.calls === 1);
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(await owned.stop()).toEqual({ status: 'stopped' });
    await until(() => n.sockets.size === 0);
    expect(n.sockets.size).toBe(0);
  } finally {
    await owned.stop();
    await n.close();
  }
}, 15000);

test('actual SQLite/Core dispatched connection Jobs admit exact origin and cancel A sockets without closing B; headers stay outside durable records', async () => {
  const n = await network(),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-http-port-core-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' },
    store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  let admissions = 0;
  const secret = 'Bearer private-host-test-only';
  const port = createMcpHttpTransportPort({
    servers: [{ id: 'local', url: n.url, headers: { authorization: secret } }],
    allowLoopbackForTests: true,
    limits: { maxSockets: 1 },
    admit: async (input) => {
      const execution = await store.getExecution(input.executionId);
      expect(execution).toMatchObject({
        kind: 'job',
        status: 'dispatching',
        sessionId: input.sessionId,
        originStoreId: input.originalStoreId,
        definitionVersion: input.configDigest,
      });
      expect(input.originalStoreId).toBe(expectedStoreId);
      admissions++;
    },
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport: { type: 'http', url: n.url } }],
    transportPort: port,
  });
  const finish = {
      type: 'finish' as const,
      reason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    toolFinish = { ...finish, reason: 'tool_calls' as const };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'a',
        name: 'mcp.connect',
        arguments: '{"serverId":"local","key":"first"}',
      },
      toolFinish,
    ],
    [finish],
    [
      {
        type: 'tool_call',
        id: 'b',
        name: 'mcp.connect',
        arguments: '{"serverId":"local","key":"first"}',
      },
      toolFinish,
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [lifecycle.extension],
    permissions: { authorize: async () => ({ allowed: true, revision: 'trusted-fixture' }) },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${root}`,
    });
    for (const sessionId of ['a', 'b']) {
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        commandId: `create-${sessionId}`,
        subjectId: 'user',
        workspaceId: 'w',
        title: sessionId,
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId,
        commandId: `work-${sessionId}`,
        subjectId: 'user',
        request: { kind: 'run.start', content: sessionId },
      });
      await runtime.waitForCommand(`work-${sessionId}`, { timeoutMs: 5000 });
    }
    expect(admissions).toBe(2);
    expect(n.sockets.size).toBe(2);
    expect(JSON.stringify(await store.getView('a'))).not.toContain(secret);
    expect(
      JSON.stringify(
        await runtime.queryExtension({
          sessionId: 'a',
          subjectId: 'user',
          extensionId: 'builtin.mcp',
          queryId: 'mcp.catalogue',
          input: {},
        }),
      ),
    ).not.toContain(secret);
    await runtime.cancelSession({
      expectedStoreId,
      sessionId: 'a',
      commandId: 'stop-a',
      subjectId: 'user',
      includeBackground: true,
    });
    await until(() => n.sockets.size === 1);
    expect(
      (
        await lifecycle.readStepCapabilities({
          command: { originStoreId: expectedStoreId },
          session: { id: 'b' },
        })
      ).toolIds,
    ).toHaveLength(1);
    await runtime.close();
    await until(() => n.sockets.size === 0);
    const reopened = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(JSON.stringify(await reopened.getView('a'))).not.toContain(secret);
      expect(
        (await reopened.listExecutions('a')).find((x) => x.definitionId === 'mcp.connection.local')!
          .status,
      ).toBe('cancelled');
    } finally {
      await reopened.close();
    }
  } finally {
    await lifecycle.close();
    await runtime.close();
    await n.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('DNS wait abort prevents any late socket/RPC even when the trusted resolver completes after cancellation', async () => {
  const n = await network();
  let release!: (addresses: readonly { address: string; family: 4 }[]) => void;
  let resolvingStarted = false;
  const resolving = new Promise<readonly { address: string; family: 4 }[]>(
    (resolve) => (release = resolve),
  );
  const controller = new AbortController();
  const port = createMcpHttpTransportPort({
    servers: [{ id: 'local', url: n.url }],
    allowLoopbackForTests: true,
    admit: async () => {},
    resolveAddresses: async () => {
      resolvingStarted = true;
      return resolving;
    },
  });
  try {
    const opening = port.open(binding(n.url), { signal: controller.signal });
    void opening.catch(() => {});
    await until(() => resolvingStarted);
    controller.abort();
    await expect(opening).rejects.toThrow();
    release([{ address: '127.0.0.1', family: 4 }]);
    await resolving;
    expect(n.rpcCount).toBe(0);
    expect(n.sockets.size).toBe(0);
  } finally {
    release?.([{ address: '127.0.0.1', family: 4 }]);
    await n.close();
  }
}, 15000);
