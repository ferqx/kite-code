import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createMcpLifecycle } from '@kite-ai/agent/mcp';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelRequest } from '@kite-ai/ai';
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
    profile = { dataRoot: join(root, 'data'), profile: 'new' },
    store = await openSqliteStore(profile),
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
    models: ModelRequest[] = [];
  let taskCalls = 0,
    denyJob = false,
    askJob = false,
    badOutput = false,
    inputRequired = false,
    cancelAckOnly = false,
    disconnectQueries = false;
  const authKinds: string[] = [];
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
    admit: async () => {},
  });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport }],
    transportPort: port,
  });
  const runtime = createRuntime({
    store,
    extensions: [lifecycle.extension],
    permissions: {
      authorize: async (req) => {
        authKinds.push(`${req.kind}:${req.definitionId}`);
        if (askJob && req.kind === 'job' && req.definitionId.endsWith('.task'))
          return {
            allowed: false,
            revision: 'explicit-fixture',
            approval: { request: { title: 'Independent exact remote Task' } },
          };
        return {
          allowed: !(denyJob && req.kind === 'job' && req.definitionId.endsWith('.task')),
          revision: 'explicit-fixture',
        };
      },
    },
    resolveRunConfiguration: async () => {
      let step = 0;
      return {
        modelId: 'fixed',
        toolIds: ['mcp.connect'],
        snapshot: {},
        readStepCapabilities: (context) => lifecycle.readStepCapabilities(context),
        model: {
          async *stream(request: ModelRequest) {
            models.push(structuredClone(request));
            if (step++ === 0) {
              const tool = request.tools.find((t) => t.id.startsWith('mcp.local.'))!;
              expect(tool.inputSchema).toEqual({ type: 'object', additionalProperties: false });
              yield { type: 'tool_call' as const, id: 'task-call', name: tool.id, arguments: '{}' };
              yield {
                type: 'finish' as const,
                reason: 'tool_calls' as const,
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            } else
              yield {
                type: 'finish' as const,
                reason: 'stop' as const,
                usage: { inputTokens: 0, outputTokens: 0 },
              };
          },
        },
      };
    },
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
      request: { kind: 'run.start', content: 'one real task' },
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
    lifecycle,
    requests,
    models,
    tasks,
    taskCreated,
    queried,
    authKinds,
    connect,
    run,
    taskExecution,
    get calls() {
      return taskCalls;
    },
    set ask(value: boolean) {
      askJob = value;
    },
    set deny(value: boolean) {
      denyJob = value;
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
    async close(expectUnconfirmed = false) {
      try {
        if (expectUnconfirmed) {
          const originalCalls = taskCalls,
            originalModels = models.length;
          const remoteFacts = [...tasks].map(([id, fact]) => [id, { ...fact }]);
          const unknownFacts = (await store.listExecutions('a')).filter(
            (execution) =>
              execution.definitionId?.endsWith('.task') && execution.status === 'outcome_unknown',
          );
          expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
            code: 'shutdown_cleanup_unconfirmed',
          });
          expect(runtime.getLifecycleState().state).toBe('drain_failed');
          expect(runtime.getLifecycleState().reasons).toContain('background');
          expect((await store.getMetadata()).storeId).toBe(storeId);
          expect(unknownFacts.length).toBeGreaterThan(0);
          expect(
            (await store.listExecutions('a')).filter(
              (execution) =>
                execution.definitionId?.endsWith('.task') && execution.status === 'outcome_unknown',
            ),
          ).toEqual(unknownFacts);
          expect(taskCalls).toBe(originalCalls);
          expect(models.length).toBe(originalModels);
          expect([...tasks].map(([id, fact]) => [id, { ...fact }])).toEqual(remoteFacts);
        } else await runtime.close();
      } finally {
        // The fake remote Task has only this test's map and loopback HTTP server.
        // Fixture cleanup does not supply production stop confirmation or erase unknown facts.
        await lifecycle.close();
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
        await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('actual pinned HTTP Task dispatch, frozen schema, independent permissions, detached lease and exact result', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    await f.connect('b');
    const before = f.requests.length;
    await f.lifecycle.readStepCapabilities({
      command: { originStoreId: f.storeId },
      session: { id: 'a' },
    });
    expect(f.requests.length).toBe(before);
    await f.run('a', 'run-a');
    await bounded(f.taskCreated.promise);
    await bounded(f.queried.promise);
    const job = await f.taskExecution('a');
    expect(f.calls).toBe(1);
    expect(
      (
        await f.store.getRun(
          ((await f.store.getCommand('run-a'))!.receipt as { runId: string }).runId,
        )
      )?.status,
    ).toBe('completed');
    expect(f.authKinds.some((x) => x.startsWith('tool:mcp.local.'))).toBe(true);
    expect(f.authKinds.some((x) => x.startsWith('job:mcp.local.'))).toBe(true);
    const reference = await until(
      () => f.store.getExecution(job.id),
      (e) => !!e?.reference,
    );
    expect(JSON.stringify(reference?.reference)).toContain('remote-1');
    await f.runtime.cancelSession({
      expectedStoreId: f.storeId,
      commandId: 'stop-b',
      sessionId: 'b',
      subjectId: 'owner',
      includeBackground: true,
    });
    f.tasks.get('remote-1')!.status = 'completed';
    const ended = await until(
      () => f.store.getExecution(job.id),
      (e) => e?.status === 'succeeded',
    );
    expect(JSON.stringify(ended?.result)).toContain('physical result');
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('Task Job denial sends zero tools/call; actual output mismatch and input_required never claim success', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    f.deny = true;
    await f.run('a', 'denied');
    const denied = await f.taskExecution('a');
    await until(
      () => f.store.getExecution(denied.id),
      (e) => e?.status === 'failed',
    );
    expect(f.calls).toBe(0);
    f.deny = false;
    f.bad = true;
    await f.connect('b');
    await f.run('b', 'invalid');
    await bounded(f.taskCreated.promise);
    f.tasks.get('remote-1')!.status = 'completed';
    const job = await f.taskExecution('b');
    const invalid = await until(
      () => f.store.getExecution(job.id),
      (e) => e?.status === 'outcome_unknown',
    );
    expect(JSON.stringify(invalid?.result)).toContain('mcp_task_output_invalid');
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('cancel acknowledgement is not remote stop, no sampling or replay, readonly reopening causes zero RPC', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    f.input = true;
    f.ack = true;
    await f.run('a', 'input');
    const job = await f.taskExecution('a');
    const unknown = await until(
      () => f.store.getExecution(job.id),
      (e) => e?.status === 'outcome_unknown',
    );
    expect(JSON.stringify(unknown?.result)).toContain('mcp_task_input_required_unsupported');
    expect(f.requests).not.toContain('tasks/result');
    expect(f.requests).toContain('tasks/cancel');
    expect(f.calls).toBe(1);
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const before = f.requests.length;
    expect((await readonly.getExecution(job.id))?.status).toBe('outcome_unknown');
    await readonly.close();
    expect(f.requests.length).toBe(before);
    expect(f.models.length).toBe(2);
  } finally {
    await f.close(true);
  }
}, 15000);

test('exact Task execution cancel confirms only its remote task while another Session and connection continue', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    await f.connect('b');
    await f.run('a', 'first');
    await f.run('b', 'second');
    const a = await f.taskExecution('a'),
      b = await f.taskExecution('b');
    await until(
      () => f.store.getExecution(a.id),
      (e) => !!e?.reference,
    );
    await until(
      () => f.store.getExecution(b.id),
      (e) => !!e?.reference,
    );
    let rejected = '';
    try {
      await f.runtime.cancelExecution({
        expectedStoreId: 'wrong-store',
        commandId: 'wrong-stop',
        sessionId: 'a',
        subjectId: 'owner',
        executionId: a.id,
      });
    } catch (error) {
      rejected = (error as { code: string }).code;
    }
    expect(rejected).toBe('store_identity_mismatch');
    expect(f.tasks.get('remote-1')?.status).toBe('working');
    await f.runtime.cancelExecution({
      expectedStoreId: f.storeId,
      commandId: 'exact-stop',
      sessionId: 'a',
      subjectId: 'owner',
      executionId: a.id,
    });
    const cancelled = await until(
      () => f.store.getExecution(a.id),
      (e) => e?.status === 'cancelled',
    );
    expect(cancelled?.status).toBe('cancelled');
    expect(f.tasks.get('remote-1')?.status).toBe('cancelled');
    expect(f.tasks.get('remote-2')?.status).toBe('working');
    f.tasks.get('remote-2')!.status = 'completed';
    expect(
      (
        await until(
          () => f.store.getExecution(b.id),
          (e) => e?.status === 'succeeded',
        )
      )?.status,
    ).toBe('succeeded');
    expect(f.calls).toBe(2);
    const cached = await f.lifecycle.readStepCapabilities({
      command: { originStoreId: f.storeId },
      session: { id: 'a' },
    });
    expect(cached.toolIds.length).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('lost remote task observation is unknown and never retries task creation', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    f.disconnect = true;
    f.ack = true;
    await f.run('a', 'lost');
    const job = await f.taskExecution('a');
    expect(
      (
        await until(
          () => f.store.getExecution(job.id),
          (e) => e?.status === 'outcome_unknown',
        )
      )?.status,
    ).toBe('outcome_unknown');
    expect(f.calls).toBe(1);
    expect(f.requests.filter((x) => x === 'tools/call').length).toBe(1);
    expect(f.models.length).toBe(2);
  } finally {
    await f.close(true);
  }
}, 15000);

test('Task Job has its own durable approval after connection and Tool grant, pending or cancelled card sends zero creation RPC', async () => {
  const f = await fixture();
  try {
    await f.connect('a');
    f.ask = true;
    await f.run('a', 'needs-task-approval');
    const cards = await until(
      () =>
        f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 'a',
          state: 'pending',
        }),
      (page) => page.interactions.length > 0,
    );
    const card = cards.interactions[0]!;
    expect(card.kind).toBe('approval');
    expect(card.definitionId.endsWith('.task')).toBe(true);
    expect(f.calls).toBe(0);
    expect(f.requests).not.toContain('tools/call');
    expect(JSON.stringify(card.request)).toContain('arguments');
    await f.runtime.cancelExecution({
      expectedStoreId: f.storeId,
      commandId: 'cancel-unapproved-task',
      sessionId: 'a',
      subjectId: 'owner',
      executionId: card.executionId,
    });
    const saved = await until(
      () =>
        f.runtime.getInteraction({
          expectedStoreId: f.storeId,
          sessionId: 'a',
          interactionId: card.id,
        }),
      (value) => value?.state === 'cancelled',
    );
    expect(saved?.state).toBe('cancelled');
    expect(f.calls).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);
