import { afterAll, expect, mock, test } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JobContext, Json, ToolContext } from '../../../src/extensions';
import * as workerModule from '../../../src/platform/process/owned-worker';

// Delay only actual owned cleanup; schema compilation and RPCs use their real implementations.
const originalWorkers = { ...workerModule };
let nextCompileGate: ReturnType<typeof barrier> | undefined;
const workers: {
  responses: number;
  beforeStop?: () => Promise<void>;
  stopActual(): Promise<void>;
  stopped: boolean;
}[] = [];
mock.module('../../../src/platform/process/owned-worker', () => ({
  ...originalWorkers,
  createOwnedWorker(...args: Parameters<typeof originalWorkers.createOwnedWorker>) {
    const owned = originalWorkers.createOwnedWorker(...args);
    const terminate = owned.terminate.bind(owned);
    const compileGate = nextCompileGate;
    nextCompileGate = undefined;
    if (compileGate) {
      const post = owned.worker.postMessage.bind(owned.worker);
      owned.worker.postMessage = (
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) => {
        const send = () => {
          if (Array.isArray(options)) post(message, options);
          else post(message, options);
        };
        if ((message as { kind?: string })?.kind === 'compile') void compileGate.hold().then(send);
        else send();
      };
    }
    const observed: (typeof workers)[number] = {
      responses: 0,
      stopped: false,
      async stopActual() {
        await terminate();
        observed.stopped = true;
      },
    };
    workers.push(observed);
    owned.worker.addEventListener('message', () => observed.responses++);
    owned.terminate = async () => {
      await observed.beforeStop?.();
      await observed.stopActual();
    };
    return owned;
  },
}));
afterAll(() => mock.module('../../../src/platform/process/owned-worker', () => originalWorkers));
const { createMcpAdapter } = await import('../../../src/mcp');
const context = () => ({ signal: new AbortController().signal }) as ToolContext;
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async hold() {
      enter();
      await waiting;
    },
  };
}
async function until(read: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() >= deadline) throw Error('schema_publication_fixture_timeout');
    await Bun.sleep(1);
  }
}
async function fixture() {
  const start = workers.length;
  const server = new Server(
    { name: 'schema-publication', version: '1' },
    { capabilities: { tools: {} } },
  );
  let description = 'original';
  let invalidSchema = false;
  let fresh = true;
  let calls = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description,
        inputSchema: {
          type: 'object',
          ...(invalidSchema ? { properties: { value: { type: 'invalid' } } } : {}),
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    calls++;
    return { content: [{ type: 'text', text: 'original result' }] };
  });
  const [client, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  const adapter = createMcpAdapter({
    id: 'publication',
    transport: { type: 'http', url: 'http://unused.invalid/mcp' },
    createTransport: async () => client,
    assertFresh() {
      if (!fresh) throw Error('source_changed');
    },
  });
  const scope = adapter.scope('original');
  const original = (await scope.snapshotTools())[0]!;
  return {
    adapter,
    scope,
    original,
    start,
    closeServer: () => server.close(),
    oldWorker: workers[start]!,
    get calls() {
      return calls;
    },
    set description(value: string) {
      description = value;
    },
    set invalidSchema(value: boolean) {
      invalidSchema = value;
    },
    set fresh(value: boolean) {
      fresh = value;
    },
    async close() {
      await scope.release();
      await adapter.close();
      await server.close();
      expect(workers.slice(start).every((worker) => worker.stopped)).toBe(true);
    },
  };
}

test('refresh cancellation after retiring original schemas invalidates the cache and permits identical-descriptor recovery', async () => {
  const f = await fixture(),
    gate = barrier();
  try {
    expect((await f.original.execute({}, context())).outcome).toBe('succeeded');
    const generation = f.adapter.getCatalogue().generation;
    f.oldWorker.beforeStop = gate.hold;
    f.description = 'new candidate';
    const abort = new AbortController();
    const refresh = f.scope.captureRefresh(generation).execute({ signal: abort.signal });
    await gate.entered;
    abort.abort();
    gate.release();
    expect(await refresh).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'mcp_refresh_unconfirmed',
    });
    expect(f.adapter.getCatalogue().available).toBe(false);
    expect(f.scope.getCachedTools()).toEqual([]);
    expect((await f.original.execute({}, context())).content).toBe('mcp_catalogue_stale');
    expect(f.calls).toBe(1);
    f.description = 'original';
    const recovered = (await f.scope.snapshotTools())[0]!;
    expect((await recovered.execute({}, context())).outcome).toBe('succeeded');
    expect(
      await f.scope.captureRefresh(f.adapter.getCatalogue().generation).execute(context()),
    ).toMatchObject({ outcome: 'succeeded' });
    expect((await f.scope.getCachedTools()[0]!.execute({}, context())).outcome).toBe('succeeded');
    expect(f.calls).toBe(3);
  } finally {
    gate.release();
    await f.close();
  }
}, 10000);

test('snapshot publication losing source freshness during cleanup does not retain an available retired cache', async () => {
  const f = await fixture(),
    gate = barrier();
  try {
    f.oldWorker.beforeStop = gate.hold;
    f.description = 'new candidate';
    const snapshot = f.scope.snapshotTools();
    const failure = snapshot.catch((error: unknown) => error);
    await gate.entered;
    f.fresh = false;
    gate.release();
    expect(await failure).toMatchObject({ message: 'source_changed' });
    expect(f.adapter.getCatalogue().available).toBe(false);
    f.fresh = true;
    f.description = 'original';
    expect((await (await f.scope.snapshotTools())[0]!.execute({}, context())).outcome).toBe(
      'succeeded',
    );
  } finally {
    gate.release();
    f.fresh = true;
    await f.close();
  }
}, 10000);

test('simultaneous refresh candidates preserve the winner schemas and reject the stale generation without extra RPC', async () => {
  const f = await fixture(),
    gate = barrier();
  try {
    const generation = f.adapter.getCatalogue().generation;
    const first = f.scope.captureRefresh(generation),
      second = f.scope.captureRefresh(generation);
    f.oldWorker.beforeStop = gate.hold;
    f.description = 'new candidate';
    const one = first.execute(context());
    await gate.entered;
    const two = second.execute(context());
    await until(() => workers.length >= f.start + 3 && workers[f.start + 2]!.responses > 0);
    gate.release();
    const results = await Promise.all([one, two]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'outcome_unknown',
      'succeeded',
    ]);
    expect(f.adapter.getCatalogue()).toMatchObject({ available: true, generation: generation + 1 });
    expect(() => f.scope.captureRefresh(generation)).toThrow('mcp_catalogue_stale');
    expect((await f.original.execute({}, context())).content).toBe('mcp_catalogue_stale');
    expect(f.calls).toBe(0);
    expect((await f.scope.getCachedTools()[0]!.execute({}, context())).outcome).toBe('succeeded');
    expect(f.calls).toBe(1);
  } finally {
    gate.release();
    await f.close();
  }
}, 10000);

test('unconfirmed old Worker cleanup rejects publication and retains the original cleanup failure', async () => {
  const f = await fixture();
  const failure = new originalWorkers.WorkerCleanupError(
    Error('injected_exit_unconfirmed'),
    f.oldWorker,
  );
  try {
    const generation = f.adapter.getCatalogue().generation;
    f.oldWorker.beforeStop = async () => {
      throw failure;
    };
    f.description = 'new candidate';
    await expect(f.scope.captureRefresh(generation).execute(context())).rejects.toBe(failure);
    expect(f.adapter.getCatalogue().available).toBe(false);
    expect(f.scope.getCachedTools()).toEqual([]);
    await expect(f.scope.release()).rejects.toBe(failure);
    await expect(f.adapter.close()).rejects.toBe(failure);
    expect(f.calls).toBe(0);
  } finally {
    // Confirm the exact fixture-owned resource without clearing the adapter's retained failure.
    await f.oldWorker.stopActual();
    await f.adapter.close().catch(() => {});
    await f.closeServer();
    expect(workers.slice(f.start).every((worker) => worker.stopped)).toBe(true);
  }
}, 10000);

for (const operation of ['snapshot', 'refresh'] as const) {
  test(`${operation} candidate finishing preparation after another publishes closes only its losing Worker`, async () => {
    const f = await fixture(),
      gate = barrier();
    try {
      const generation = f.adapter.getCatalogue().generation;
      f.description = 'new candidate';
      nextCompileGate = gate;
      const losing = (
        operation === 'snapshot'
          ? f.scope.snapshotTools()
          : f.scope.captureRefresh(generation).execute(context())
      ).catch((error: unknown) => error);
      await gate.entered;
      const losingWorker = workers[f.start + 1]!;
      expect(losingWorker.stopped).toBe(false);
      expect(await f.scope.captureRefresh(generation).execute(context())).toMatchObject({
        outcome: 'succeeded',
      });
      const winningWorker = workers[f.start + 2]!;
      gate.release();
      expect(await losing).toMatchObject(
        operation === 'snapshot'
          ? { code: 'mcp_catalogue_stale' }
          : { outcome: 'outcome_unknown', content: 'mcp_refresh_unconfirmed' },
      );
      expect(losingWorker.stopped).toBe(true);
      expect(winningWorker.stopped).toBe(false);
      expect(f.adapter.getCatalogue()).toMatchObject({
        available: true,
        generation: generation + 1,
      });
      expect((await f.scope.getCachedTools()[0]!.execute({}, context())).outcome).toBe('succeeded');
      expect(f.calls).toBe(1);
    } finally {
      nextCompileGate = undefined;
      gate.release();
      await f.close();
    }
  }, 10000);
}

test('failed schema preparation closes its candidate before returning and preserves the callable old catalogue', async () => {
  const f = await fixture();
  try {
    const generation = f.adapter.getCatalogue().generation;
    f.invalidSchema = true;
    expect(await f.scope.captureRefresh(generation).execute(context())).toMatchObject({
      outcome: 'outcome_unknown',
    });
    expect(workers[f.start + 1]!.stopped).toBe(true);
    expect(f.oldWorker.stopped).toBe(false);
    expect(f.adapter.getCatalogue()).toMatchObject({ available: true, generation });
    expect((await f.original.execute({}, context())).outcome).toBe('succeeded');
  } finally {
    await f.close();
  }
}, 10000);

async function taskFixture() {
  const start = workers.length;
  const [client, server] = InMemoryTransport.createLinkedPair();
  let description = 'original',
    duplicate = false,
    invalidSchema = false,
    calls = 0;
  server.onmessage = (message) => {
    if (!('method' in message) || !('id' in message)) return;
    let result: Record<string, unknown>;
    const task = {
      taskId: 'original-task',
      status: 'working',
      ttl: 60000,
      createdAt: '2026-01-01T00:00:00Z',
      lastUpdatedAt: '2026-01-01T00:00:00Z',
    };
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
        serverInfo: { name: 'task-publication', version: '1' },
      };
    else if (message.method === 'tools/list') {
      const tool = {
        name: 'effect',
        description,
        execution: { taskSupport: 'required' },
        inputSchema: {
          type: 'object',
          ...(invalidSchema ? { properties: { value: { type: 'invalid' } } } : {}),
        },
      };
      result = { tools: duplicate ? [tool, tool] : [tool] };
    } else if (message.method === 'tools/call') {
      calls++;
      result = { task };
    } else if (message.method === 'tasks/cancel') result = { ...task, status: 'cancelled' };
    else throw Error('unexpected_task_rpc');
    void server.send({ jsonrpc: '2.0', id: message.id!, result });
  };
  await server.start();
  const adapter = createMcpAdapter({
    id: 'tasks',
    tasks: true,
    transport: { type: 'http', url: 'http://unused.invalid/mcp' },
    createTransport: async () => client,
  });
  const scope = adapter.scope('original');
  await scope.snapshotTools();
  return {
    adapter,
    scope,
    start,
    oldWorker: workers[start]!,
    get calls() {
      return calls;
    },
    set description(value: string) {
      description = value;
    },
    set duplicate(value: boolean) {
      duplicate = value;
    },
    set invalidSchema(value: boolean) {
      invalidSchema = value;
    },
    async executePublishedTask() {
      let jobInput: Json | undefined;
      const toolContext = {
        executionId: 'original-tool',
        sessionId: 'original',
        signal: new AbortController().signal,
        getExecution: async () => ({ originStoreId: 'original-store' }),
        operations: {
          ensure: async (input: { request: { input: Json } }) => {
            jobInput = input.request.input;
            return { executionId: 'original-job' };
          },
        },
      } as unknown as ToolContext;
      expect((await scope.getCachedTools()[0]!.execute({}, toolContext)).outcome).toBe('succeeded');
      const job = scope.getCachedJobs()[0]!;
      const jobContext: JobContext = {
        sessionId: 'original',
        executionId: 'original-job',
        signal: new AbortController().signal,
      };
      const handle = await job.start(jobInput!, jobContext);
      try {
        expect(await job.cancel(handle)).toEqual({ status: 'stopped' });
      } finally {
        await job.dispose(handle);
      }
    },
    async close() {
      await scope.release();
      await adapter.close();
      await server.close();
      expect(workers.slice(start).every((worker) => worker.stopped)).toBe(true);
    },
  };
}

test('same-scope concurrent required-task candidates publish matching Tool and Job ticket closures', async () => {
  const f = await taskFixture(),
    gate = barrier();
  try {
    const generation = f.adapter.getCatalogue().generation;
    f.description = 'new candidate';
    f.oldWorker.beforeStop = gate.hold;
    const first = f.scope.captureRefresh(generation).execute(context());
    await gate.entered;
    const second = f.scope.captureRefresh(generation).execute(context());
    await until(() => workers.length >= f.start + 3 && workers[f.start + 2]!.responses > 0);
    gate.release();
    expect((await Promise.all([first, second])).map((result) => result.outcome).sort()).toEqual([
      'outcome_unknown',
      'succeeded',
    ]);
    await f.executePublishedTask();
    expect(f.calls).toBe(1);
  } finally {
    gate.release();
    await f.close();
  }
}, 10000);

for (const failure of ['binding', 'preparation'] as const)
  test(`candidate ${failure} failure cannot replace the published required-task Job closure`, async () => {
    const f = await taskFixture();
    try {
      const originalJob = f.scope.getCachedJobs()[0]!;
      const generation = f.adapter.getCatalogue().generation;
      f.description = 'rejected candidate';
      if (failure === 'binding') f.duplicate = true;
      else f.invalidSchema = true;
      expect(await f.scope.captureRefresh(generation).execute(context())).toMatchObject({
        outcome: 'outcome_unknown',
      });
      expect(f.scope.getCachedJobs()[0]).toBe(originalJob);
      expect(f.adapter.getCatalogue()).toMatchObject({ available: true, generation });
      await f.executePublishedTask();
      expect(f.calls).toBe(1);
    } finally {
      await f.close();
    }
  }, 10000);
