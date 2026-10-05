import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createMcpConfiguration } from '../../src/mcp-configuration';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    resolve: () => resolve(),
  };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('fixture_event_timeout')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw Error('fixture_timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-live-mcp-task-'))),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' }),
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
    storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'fixture',
  });
  for (const sessionId of ['a', 'b'])
    await store.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      subjectId: 'owner',
      title: sessionId,
    });
  const sockets = new Set<Socket>(),
    taskCreated = deferred(),
    queried = deferred(),
    tasks = new Map<string, { status: string; invalid?: boolean }>(),
    requests: string[] = [],
    models: Record<string, unknown>[] = [];
  let taskCalls = 0,
    badOutput = false,
    inputRequired = false,
    cancelAckOnly = false,
    disconnectQueries = false;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method: string;
      params?: { taskId: string };
    };
    requests.push(rpc.method);
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    const task = tasks.get(rpc.params?.taskId ?? '');
    const fact = (id: string, status: string) => ({
      taskId: id,
      status,
      ttl: 60000,
      createdAt: '2026-01-01T00:00:00Z',
      lastUpdatedAt: '2026-01-01T00:00:00Z',
      pollInterval: 1000000,
    });
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'local', version: '1' },
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'effect',
            description: 'Real task fixture',
            execution: { taskSupport: 'required' },
            inputSchema: { type: 'object', additionalProperties: false },
            outputSchema: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string' } },
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      taskCalls++;
      // Socket proves actual dispatch preceded the physical start, not just an in-memory callback.
      const jobs = [
        ...(await store.listExecutions('a')),
        ...(await store.listExecutions('b')),
      ].filter((e) => e.definitionId?.endsWith('.task') && e.status === 'dispatching');
      expect(jobs.length).toBeGreaterThan(0);
      const id = `remote-${taskCalls}`;
      tasks.set(id, { status: inputRequired ? 'input_required' : 'working', invalid: badOutput });
      result = { task: fact(id, 'working') };
      taskCreated.resolve();
    } else if (rpc.method === 'tasks/get') {
      if (disconnectQueries) {
        res.destroy();
        return;
      }
      result = fact(rpc.params!.taskId, task!.status);
      queried.resolve();
    } else if (rpc.method === 'tasks/result')
      result = {
        content: [{ type: 'text', text: 'actual task result' }],
        structuredContent: task?.invalid ? { value: 9 } : { value: 'physical result' },
      };
    else if (rpc.method === 'tasks/cancel') {
      if (!cancelAckOnly) task!.status = 'cancelled';
      result = fact(rpc.params!.taskId, task!.status);
    } else throw Error('unexpected_rpc');
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const transport = {
    type: 'http' as const,
    url: `http://task.invalid:${(server.address() as { port: number }).port}/mcp`,
  };
  const port = createMcpHttpTransportPort({
    servers: [{ id: 'local', url: transport.url }],
    allowLoopbackForTests: true,
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    admit: async (binding) => {
      const job = await store.getExecution(binding.executionId);
      if (
        job?.kind !== 'job' ||
        job.status !== 'dispatching' ||
        job.originStoreId !== storeId ||
        job.sessionId !== binding.sessionId ||
        job.definitionVersion !== binding.configDigest
      )
        throw new Error('fixture_connection_not_admitted');
    },
  });
  let askTask = false,
    denyTask = false;
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages: { role: string; content: string }[];
        tools?: { function: { name: string; parameters: unknown } }[];
      };
      models.push(body);
      const marker = body.messages
        .filter((m) => m.role === 'user' && m.content.startsWith('task-run-'))
        .slice(-1)[0]!.content;
      const step = steps.get(marker) ?? 0;
      steps.set(marker, step + 1);
      const connect = marker.includes('connect'),
        remote = body.tools?.find((t) => t.function.name.startsWith('mcp.local.'));
      const call =
        connect && step === 0
          ? { name: 'mcp.connect', arguments: JSON.stringify({ serverId: 'local', key: marker }) }
          : step === (connect ? 1 : 0) && remote
            ? { name: remote.function.name, arguments: '{}' }
            : undefined;
      const base = { id: 'local', object: 'chat.completion.chunk', created: 1, model: 'local' };
      const delta = call
        ? {
            tool_calls: [
              { index: 0, id: `call-${models.length}`, type: 'function', function: call },
            ],
          }
        : { content: 'done' };
      return new Response(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const writeConfig = (
    mcp: unknown[] = [{ id: 'local' }],
    tools: unknown[] = [{ id: 'mcp.connect', definitionVersion: '1' }],
  ) =>
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools,
        mcp,
      }),
    );
  writeConfig();
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: createTemporaryCredentialBackend(),
    mcp: { servers: [{ id: 'local', transport }], transportPort: port },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode:
          askTask && request.kind === 'job' && request.definitionId.endsWith('.task')
            ? 'ask'
            : 'full',
        workspaceTrust: true,
        revision: 'trusted-fixture-1',
        allowed:
          denyTask && request.kind === 'job' && request.definitionId.endsWith('.task')
            ? []
            : [
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
  const connect = async (sessionId: string) => {
    const commandId = `connect-${sessionId}`;
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId,
      sessionId,
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId: 'mcp.connect',
        definitionVersion: '1',
        input: { serverId: 'local', key: commandId },
      },
    });
    return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
  };
  const run = async (sessionId: string, commandId: string) => {
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId,
      sessionId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: `task-run-${commandId}` },
    });
    return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
  };
  const taskExecution = (session: string) =>
    until(
      () => store.listExecutions(session),
      (es) => es.some((e) => e.definitionId?.endsWith('.task')),
    ).then((es) => es.find((e) => e.definitionId?.endsWith('.task'))!);
  return {
    root,
    profile,
    store,
    storeId,
    runtime,
    writeConfig,
    requests,
    models,
    tasks,
    taskCreated,
    queried,
    connect,
    run,
    taskExecution,
    get calls() {
      return taskCalls;
    },
    set ask(value: boolean) {
      askTask = value;
    },
    set deny(value: boolean) {
      denyTask = value;
    },
    set bad(value: boolean) {
      badOutput = value;
    },
    set input(value: boolean) {
      inputRequired = value;
    },
    set disconnect(value: boolean) {
      disconnectQueries = value;
    },
    set ack(value: boolean) {
      cancelAckOnly = value;
    },
    async close() {
      await runtime.close();
      provider.stop(true);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default compatible Model learns captured Task tools after connection, ordinary Task Job persists and survives parent completion', async () => {
  const f = await fixture();
  try {
    expect(f.requests).toEqual([]);
    await f.run('a', 'connect-a');
    await bounded(f.taskCreated.promise);
    expect(f.calls).toBe(1);
    expect(f.models.length).toBe(3);
    const second = f.models[1] as { tools: { function: { name: string; parameters: unknown } }[] };
    expect(second.tools.some((t) => t.function.name.startsWith('mcp.local.'))).toBe(true);
    const job = await f.taskExecution('a');
    const live = await until(
      () => f.store.getExecution(job.id),
      (e) => !!e?.reference,
    );
    expect(live?.kind).toBe('job');
    expect(JSON.stringify(live?.reference)).toContain('remote-1');
    const command = await f.store.getCommand('connect-a'),
      run = await f.store.getRun((command!.receipt as { runId: string }).runId);
    expect(run?.status).toBe('completed');
    expect(live?.status).toBe('running');
    const before = f.requests.length,
      modelCount = f.models.length;
    await f.runtime.queryExtension({
      sessionId: 'a',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.catalogue',
      input: {},
      subjectId: 'owner',
    });
    expect(f.requests.length).toBe(before);
    expect(f.models.length).toBe(modelCount);
    f.tasks.get('remote-1')!.status = 'completed';
    expect(
      (
        await until(
          () => f.store.getExecution(job.id),
          (e) => e?.status === 'succeeded',
        )
      )?.status,
    ).toBe('succeeded');
    expect(f.calls).toBe(1);
    expect(f.models.length).toBe(modelCount);
  } finally {
    await f.close();
  }
}, 15000);

test('default Ask requires independent Task Job approval after Full connection/Tool; cancellation does not create task', async () => {
  const f = await fixture();
  try {
    f.ask = true;
    await f.run('a', 'connect-ask');
    const cards = await until(
        () =>
          f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 'a',
            state: 'pending',
          }),
        (page) => page.interactions.length > 0,
      ),
      card = cards.interactions[0]!;
    expect(card.kind).toBe('approval');
    expect(card.definitionId.endsWith('.task')).toBe(true);
    expect(f.calls).toBe(0);
    const tool = (await f.store.listExecutions('a')).find(
      (e) => e.kind === 'tool' && e.definitionId.startsWith('mcp.local.'),
    );
    expect(tool?.status).toBe('succeeded');
    expect(card.request).toMatchObject({ policy: { mode: 'ask', effects: ['unknown'] } });
    await f.runtime.cancelExecution({
      expectedStoreId: f.storeId,
      sessionId: 'a',
      subjectId: 'owner',
      commandId: 'cancel-task',
      executionId: card.executionId,
    });
    await until(
      () =>
        f.runtime.getInteraction({
          expectedStoreId: f.storeId,
          sessionId: 'a',
          interactionId: card.id,
        }),
      (value) => value?.state === 'cancelled',
    );
    expect(f.calls).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);

test('default server selection is a hard boundary in Full; new unselected Run has zero future task RPC and no old task replay', async () => {
  const f = await fixture();
  try {
    await f.run('a', 'connect-original');
    await bounded(f.taskCreated.promise);
    const job = await f.taskExecution('a');
    f.tasks.get('remote-1')!.status = 'completed';
    await until(
      () => f.store.getExecution(job.id),
      (e) => e?.status === 'succeeded',
    );
    const calls = f.calls,
      providers = f.models.length;
    f.writeConfig([], []);
    await f.run('a', 'selection-removed');
    expect(f.calls).toBe(calls);
    expect(f.models.length).toBe(providers + 1);
    f.writeConfig([{ id: 'not-trusted' }]);
    await f.run('a', 'unknown-server');
    expect(f.calls).toBe(calls);
    expect(f.models.length).toBe(providers + 1);
    const bad = await f.store.getCommand('unknown-server');
    expect(JSON.stringify(bad?.receipt)).toContain('mcp_server_unavailable');
    expect((await f.store.getExecution(job.id))?.status).toBe('succeeded');
  } finally {
    await f.close();
  }
}, 15000);

test('pure capability listing has actual kind-specific static identities and zero port/model I/O', async () => {
  let opens = 0;
  const mcp = createMcpConfiguration({
    servers: [{ id: 'local', transport: { type: 'http', url: 'http://pure.invalid/mcp' } }],
    transportPort: {
      async open() {
        opens++;
        throw Error('must-not-open');
      },
    },
  });
  const selection = mcp.select([{ id: 'local' }], ['mcp.connect']);
  const before = selection.listCapabilities();
  expect(Object.isFrozen(before)).toBe(true);
  expect(opens).toBe(0);
  expect(before.some((d) => d.kind === 'job' && d.definitionId === 'mcp.connection.local')).toBe(
    true,
  );
  expect(before.every((d) => d.safeRead === false)).toBe(true);
  expect(
    mcp
      .listCapabilities()
      .some((d) => d.kind === 'job' && d.definitionId === 'builtin.mcp/mcp.connect'),
  ).toBe(true);
  expect(
    mcp
      .select([], [])
      .listCapabilities()
      .some((d) => d.definitionId === 'mcp.connection.local'),
  ).toBe(false);
  expect(opens).toBe(0);
});
