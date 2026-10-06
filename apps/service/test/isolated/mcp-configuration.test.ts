import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { McpLifecycleTransportPort } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDefaultProcessConfiguration } from '../../src/configuration';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const x = await read();
    if (x !== null) return x;
    if (Date.now() > deadline) throw new Error('mcp_configuration_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(ask = false, withPort = true, connectServer = 'local') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-mcp-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let opens = 0,
    connections = 0,
    calls = 0;
  const stops: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await req.json()) as { id?: string | number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') {
        connections++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'local', version: '1' },
          capabilities: { tools: {} },
        };
      } else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'effect',
              description: 'Remote text cannot grant safe read',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          ],
        };
      else {
        calls++;
        result = { content: [{ type: 'text', text: 'one actual remote fixture call' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const transportPort: McpLifecycleTransportPort = {
    async open(binding) {
      opens++;
      const execution = await store.getExecution(binding.executionId);
      expect(execution).toMatchObject({
        kind: 'job',
        status: 'dispatching',
        originStoreId: expectedStoreId,
      });
      let ended!: (x: { supervision: 'ended' }) => void;
      const stopped = new Promise<{ supervision: 'ended' }>((r) => (ended = r));
      const transport = new StreamableHTTPClientTransport(network.url);
      return {
        transport,
        stopped,
        async stop() {
          stops.push(binding.sessionId);
          await transport.close();
          ended({ supervision: 'ended' });
          return { status: 'stopped' };
        },
      };
    },
  };
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const text = JSON.stringify(body.messages);
      const route = text.includes('remote-b') ? 'remote-b' : text.includes('connect-b') ? 'b' : 'a';
      const step = steps.get(route) ?? 0;
      steps.set(route, step + 1);
      const tools = (body.tools ?? []) as { function: { name: string; parameters: unknown } }[];
      const remote = tools.find((x) => x.function.name.startsWith('mcp.local.'));
      const call =
        step === 0 && route !== 'remote-b'
          ? { name: 'mcp.connect', input: { serverId: connectServer, key: 'first' } }
          : (step === 1 && route !== 'remote-b') || (step === 0 && route === 'remote-b')
            ? remote
              ? { name: remote.function.name, input: { value: 'exact' } }
              : null
            : null;
      const chunk = {
        id: 'reply',
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
                      id: `call-${requests.length}`,
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
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'local',
    models: [
      { id: 'local', provider: 'compatible', model: 'local', baseURL: `${provider.url.href}v1` },
    ],
    tools: [{ id: 'mcp.connect', definitionVersion: '1' }],
    mcp: [{ id: 'local' }],
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    profile,
    mcp: {
      servers: ['local', 'other'].map((id) => ({
        id,
        transport: { type: 'http' as const, url: network.url.href },
      })),
      ...(withPort ? { transportPort } : {}),
    },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: ask ? 'ask' : 'full',
        workspaceTrust: true,
        revision: 'fixture-host',
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
  const runtime = createRuntime({
    store,
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${workspace}`,
  });
  for (const sessionId of ['a', 'b'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create-${sessionId}`,
      subjectId: 'user',
      workspaceId: 'w',
      title: sessionId,
    });
  return {
    runtime,
    store,
    expectedStoreId,
    requests,
    configuration,
    configurationPath,
    stops,
    get opens() {
      return opens;
    },
    get connections() {
      return connections;
    },
    get calls() {
      return calls;
    },
    async run(sessionId = 'a', commandId = `connect-${sessionId}`) {
      return runtime.submitCommand({
        expectedStoreId,
        sessionId,
        subjectId: 'user',
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
    },
    async pending() {
      return until(
        async () =>
          (await store.listInteractions({ expectedStoreId, sessionId: 'a', state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async approve(
      card: Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number],
    ) {
      await runtime.answerInteraction({
        expectedStoreId,
        subjectId: 'user',
        commandId: `answer-${card.id}`,
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
    },
    async close() {
      await runtime.close();
      network.stop(true);
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default MCP has no network before dispatched Job; next actual Model sees exact remote schema and cached Query performs zero effects', async () => {
  const f = await fixture();
  try {
    expect(f.connections).toBe(0);
    expect(f.opens).toBe(0);
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(f.requests[0]!.tools).toMatchObject([
      { function: { name: 'ask_user' } },
      { function: { name: 'mcp.connect' } },
    ]);
    expect(f.requests[1]!.tools).toMatchObject([
      { function: { name: 'ask_user' } },
      { function: { name: 'mcp.connect' } },
      {
        function: {
          parameters: { properties: { value: { type: 'string' } }, required: ['value'] },
        },
      },
    ]);
    expect(f.calls).toBe(1);
    expect(f.connections).toBe(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.catalogue',
      input: {},
    });
    expect(JSON.stringify(views)).toContain('live');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.requests).toHaveLength(3);
    expect(f.calls).toBe(1);
    expect((await f.store.getView('a')).runs[0]!.configuration).toMatchObject({
      snapshot: { mcp: { servers: [{ id: 'local' }] } },
    });
  } finally {
    await f.close();
  }
}, 15000);

test('Ask approvals separately bind connect Tool, connection Job and remote Tool despite remote readOnly annotations', async () => {
  const f = await fixture(true);
  try {
    await f.run();
    const connect = await f.pending();
    expect(connect.definitionId).toBe('mcp.connect');
    expect(connect.request).toMatchObject({ policy: { effects: ['external'] } });
    expect(f.connections).toBe(0);
    await f.approve(connect);
    const job = await f.pending();
    expect(job.definitionId).toBe('mcp.connection.local');
    expect(job.request).toMatchObject({ policy: { effects: ['network'] } });
    expect(f.connections).toBe(0);
    await f.approve(job);
    const remote = await f.pending();
    expect(remote.definitionId).not.toBe(connect.definitionId);
    expect(remote.request).toMatchObject({ policy: { effects: ['unknown'] } });
    expect(f.calls).toBe(0);
    expect(f.connections).toBe(1);
    await f.approve(remote);
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('Session cancellation closes only its connection; B cached work continues while contradictory/unknown configuration rejects before Model', async () => {
  const f = await fixture();
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    await f.run('b');
    await f.runtime.waitForCommand('connect-b', { timeoutMs: 5000 });
    await f.runtime.cancelSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'close-a',
      includeBackground: true,
    });
    await until(async () => (f.stops.includes('a') ? true : null));
    expect(f.stops.includes('b')).toBe(false);
    await f.run('b', 'remote-b');
    await f.runtime.waitForCommand('remote-b', { timeoutMs: 5000 });
    expect(f.connections).toBe(2);
    expect(f.calls).toBe(3);
    const before = f.requests.length;
    for (const mcp of [
      [{ id: 'wrong' }],
      [{ id: 'local', configDigest: 'bad' }],
      [{ id: 'local', url: 'http://127.0.0.1:1' }],
    ]) {
      writeFileSync(f.configurationPath, JSON.stringify({ ...f.configuration, mcp }));
      const id = `invalid-${JSON.stringify(mcp)}`;
      const commandId = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
      await f.run('b', commandId);
      expect((await f.runtime.waitForCommand(commandId, { timeoutMs: 5000 })).status).toBe(
        'rejected',
      );
      const commands = await f.store.getView('b');
      expect(commands.runs).toHaveLength(2);
      expect(f.requests).toHaveLength(before);
      expect(f.connections).toBe(2);
    }
  } finally {
    await f.close();
  }
}, 15000);

test('enabled MCP without a qualified programmatic transport is a local rejected Run, preserving history and zero Provider/network calls', async () => {
  const f = await fixture(false, false);
  try {
    await f.run();
    const rejected = await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(rejected.status).toBe('rejected');
    expect(rejected.receipt).toMatchObject({ reason: 'mcp_transport_unavailable' });
    expect(f.requests).toHaveLength(0);
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect((await f.store.getView('a')).messages).toEqual([]);
    expect(
      await f.runtime.queryExtension({
        sessionId: 'a',
        subjectId: 'user',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.catalogue',
        input: {},
      }),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('Run selected MCP scope refuses another registered host server without transport open even under trusted Full', async () => {
  const f = await fixture(false, true, 'other');
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    const connect = (await f.store.listExecutions('a')).find(
      (x) => x.definitionId === 'mcp.connect',
    )!;
    expect(connect.status).toBe('failed');
    expect(connect.result).toMatchObject({ content: 'permission_denied' });
    expect(f.requests).toHaveLength(2);
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect(
      (await f.store.listExecutions('a')).filter((x) =>
        x.definitionId.startsWith('mcp.connection.'),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);
