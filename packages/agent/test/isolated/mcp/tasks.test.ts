import { expect, test } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  JobContext,
  JobDefinition,
  JobHandle,
  Json,
  ToolContext,
} from '../../../src/extensions';
import { createMcpAdapter } from '../../../src/mcp';

function gate() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    release: () => resolve(),
  };
}
async function fixture() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const entered = gate(),
    release = gate();
  let calls = 0,
    open = 0,
    gateAdmission = true,
    revision = 'old';
  const argumentsSeen: Json[] = [];
  server.onmessage = (message) => {
    if (!('method' in message) || !('id' in message)) return;
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
        serverInfo: { name: 'local', version: '1' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'effect',
            description: revision,
            execution: { taskSupport: 'required' },
            inputSchema: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string' } },
              additionalProperties: false,
            },
          },
        ],
      };
    else if (message.method === 'tools/call') {
      calls++;
      argumentsSeen.push(message.params?.arguments as Json);
      result = {
        task: {
          taskId: 'real-task-id',
          status: 'working',
          ttl: 60000,
          createdAt: '2026-01-01T00:00:00Z',
          lastUpdatedAt: '2026-01-01T00:00:00Z',
        },
      };
    } else if (message.method === 'tasks/cancel')
      result = {
        taskId: 'real-task-id',
        status: 'cancelled',
        ttl: 60000,
        createdAt: '2026-01-01T00:00:00Z',
        lastUpdatedAt: '2026-01-01T00:00:00Z',
      };
    else throw Error('unexpected_rpc');
    void server.send({
      jsonrpc: '2.0',
      id: message.id!,
      result: result as Record<string, unknown>,
    });
  };
  await server.start();
  const adapter = createMcpAdapter({
    id: 'local',
    tasks: true,
    transport: { type: 'http', url: 'http://protocol-only.invalid/mcp' },
    createTransport: async () => {
      open++;
      return client;
    },
    admitToolCall: async () => {
      if (gateAdmission) {
        entered.release();
        await release.promise;
      }
    },
  });
  const scope = adapter.scope('a');
  let jobInput: Json;
  const context = {
    executionId: 'tool-execution',
    sessionId: 'a',
    signal: new AbortController().signal,
    getExecution: async () => ({ originStoreId: 'store-original' }),
    operations: {
      ensure: async (input: { request: { input: Json; definitionVersion: string } }) => {
        jobInput = input.request.input;
        return { executionId: 'job-execution' };
      },
    },
  } as unknown as ToolContext;
  const jobContext: JobContext = {
    sessionId: 'a',
    executionId: 'job-execution',
    signal: new AbortController().signal,
  };
  return {
    adapter,
    scope,
    entered,
    release,
    argumentsSeen,
    context,
    jobContext,
    get calls() {
      return calls;
    },
    get open() {
      return open;
    },
    set revision(value: string) {
      revision = value;
    },
    set gate(value: boolean) {
      gateAdmission = value;
    },
    start: (job: JobDefinition) => job.start(jobInput!, jobContext),
    async close() {
      release.release();
      await adapter.close();
      await server.close();
    },
  };
}

test('pure task cache does no I/O; old immutable binding rejects after awaited admission and new catalogue gets exact new Job version', async () => {
  const f = await fixture();
  try {
    expect(f.scope.getCachedTools()).toEqual([]);
    expect(f.scope.getCachedJobs()).toEqual([]);
    expect(f.open).toBe(0);
    const old = (await f.scope.snapshotTools())[0]!,
      oldJob = f.scope.getCachedJobs()[0]!;
    expect(old.version).toBe(oldJob.version);
    expect(f.adapter.getCatalogue().definitions[0]?.version).toBe(old.version);
    await old.execute({ value: 'old' }, f.context);
    const pending = f.start(oldJob);
    await f.entered.promise;
    f.revision = 'new';
    await f.scope.snapshotTools();
    const next = f.scope.getCachedTools()[0]!,
      nextJob = f.scope.getCachedJobs()[0]!;
    expect(next.version).not.toBe(old.version);
    expect(nextJob.version).toBe(next.version);
    expect(old.description).toBe('External MCP Task: effect');
    f.release.release();
    let failure = '';
    try {
      await pending;
    } catch (error) {
      failure = (error as { code: string }).code;
    }
    expect(failure).toBe('mcp_catalogue_stale');
    expect(f.calls).toBe(0);
    f.gate = false;
    await next.execute({ value: 'new' }, f.context);
    const handle = await f.start(nextJob);
    expect(JSON.stringify(handle.reference)).toContain(next.version);
    expect(f.calls).toBe(1);
    expect(f.argumentsSeen).toEqual([{ value: 'new' }]);
  } finally {
    await f.close();
  }
});

test('queued Task captures arguments once; missing live handle never reconnects or repeats tools/call', async () => {
  const f = await fixture();
  try {
    const tool = (await f.scope.snapshotTools())[0]!,
      job = f.scope.getCachedJobs()[0]!,
      input = { value: 'captured' };
    await tool.execute(input, f.context);
    const pending = f.start(job);
    await f.entered.promise;
    input.value = 'changed';
    f.release.release();
    const handle = await pending;
    expect(f.argumentsSeen).toEqual([{ value: 'captured' }]);
    expect(JSON.stringify(handle.reference)).toContain('store-original');
    expect(f.calls).toBe(1);
    let error = '';
    try {
      await job.cancel({ reference: handle.reference } as JobHandle);
    } catch (failure) {
      error = (failure as Error).message;
    }
    expect(error).toBe('mcp_task_live_handle_unavailable');
    expect(f.calls).toBe(1);
    expect(f.open).toBe(1);
    expect(job.reconcile).toBeUndefined();
    await f.scope.release();
    expect(await job.cancel(handle)).toEqual({ status: 'stopped' });
    await job.dispose(handle);
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
});
