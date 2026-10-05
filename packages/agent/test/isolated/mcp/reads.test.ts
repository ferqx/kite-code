import { expect, test } from 'bun:test';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpAdapter } from '../../../src/mcp';

async function fixture(limits?: Parameters<typeof createMcpAdapter>[0]['limits']) {
  const wire: { method: string; params?: Record<string, unknown> }[] = [];
  let opens = 0,
    large = false;
  let tools: { name: string; inputSchema: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await req.json()) as {
        id?: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push({ method: rpc.method, params: rpc.params });
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'fixture', version: '1' },
              capabilities: { tools: {}, resources: {}, prompts: {} },
            }
          : rpc.method === 'tools/list'
            ? { tools }
            : rpc.method === 'resources/list'
              ? {
                  resources: [
                    { uri: 'fixture://one', name: 'one' },
                    { uri: 'fixture://two', name: 'two' },
                  ],
                }
              : rpc.method === 'resources/read'
                ? { contents: [{ uri: rpc.params!.uri, text: 'original' }] }
                : rpc.method === 'prompts/list'
                  ? { prompts: [{ name: 'guidance' }] }
                  : {
                      messages: [
                        {
                          role: 'user',
                          content: {
                            type: 'text',
                            text: large ? 'x'.repeat(2048) : JSON.stringify(rpc.params),
                          },
                        },
                      ],
                    };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const adapter = createMcpAdapter({
    id: 'local',
    transport: { type: 'http', url: server.url.href },
    limits,
    createTransport: async () => {
      opens++;
      return new StreamableHTTPClientTransport(server.url);
    },
  });
  const scope = adapter.scope('actual-fixture-scope');
  return {
    adapter,
    scope,
    wire,
    set tools(value: typeof tools) {
      tools = value;
    },
    get opens() {
      return opens;
    },
    set large(value: boolean) {
      large = value;
    },
    async close() {
      await adapter.close();
      server.stop(true);
    },
  };
}

test('read capture is live-only, generation exact and signal aware; invalidation cannot reconnect or switch client', async () => {
  const f = await fixture();
  try {
    expect(() => f.scope.captureRead(1)).toThrow('mcp_catalogue_stale');
    expect(f.opens).toBe(0);
    expect(f.wire).toHaveLength(0);
    await f.scope.snapshotTools();
    const captured = f.scope.captureRead(f.adapter.getCatalogue().generation);
    const controller = new AbortController();
    controller.abort();
    const before = f.wire.length;
    expect(
      await captured.execute({ method: 'resources/list' }, { signal: controller.signal }),
    ).toMatchObject({ outcome: 'cancelled', details: { adapterAttempted: false } });
    expect(f.wire).toHaveLength(before);
    expect(
      await captured.execute(
        { method: 'resources/read', uri: 'x'.repeat(8193) },
        { signal: new AbortController().signal },
      ),
    ).toMatchObject({
      outcome: 'failed',
      content: 'mcp_arguments_invalid',
      details: { adapterAttempted: false },
    });
    const request = {
      method: 'prompts/get' as const,
      name: 'guidance',
      arguments: { original: 'fixed' },
    };
    const original = captured.execute(request, { signal: new AbortController().signal });
    request.name = 'changed';
    request.arguments.original = 'changed';
    expect((await original).outcome).toBe('succeeded');
    expect(f.wire.at(-1)!.params).toEqual({ name: 'guidance', arguments: { original: 'fixed' } });
    f.adapter.invalidateCatalogue();
    const count = f.wire.length;
    expect(
      await captured.execute(
        { method: 'resources/list' },
        { signal: new AbortController().signal },
      ),
    ).toMatchObject({
      outcome: 'failed',
      content: 'mcp_catalogue_stale',
      details: { adapterAttempted: false },
    });
    expect(() => f.scope.captureRead(2)).toThrow('mcp_catalogue_stale');
    expect(f.wire).toHaveLength(count);
    expect(f.opens).toBe(1);
  } finally {
    await f.close();
  }
});

test('read response and aggregate item budgets refuse actual received data without reporting success', async () => {
  const f = await fixture({ maxFrameBytes: 1024, maxItems: 1 });
  try {
    await f.scope.snapshotTools();
    const capture = f.scope.captureRead(f.adapter.getCatalogue().generation),
      signal = new AbortController().signal;
    expect(await capture.execute({ method: 'resources/list' }, { signal })).toMatchObject({
      outcome: 'outcome_unknown',
      details: { adapterAttempted: true, code: 'mcp_catalogue_limit' },
    });
    f.large = true;
    expect(
      await capture.execute({ method: 'prompts/get', name: 'guidance', arguments: {} }, { signal }),
    ).toMatchObject({
      outcome: 'outcome_unknown',
      details: { adapterAttempted: true, code: 'mcp_payload_limit' },
    });
    expect(f.opens).toBe(1);
  } finally {
    await f.close();
  }
});

test('live refresh publishes accurate new generation/schema; old captured tool and read reject before wire without reconnect', async () => {
  const f = await fixture();
  try {
    expect(() => f.scope.captureRefresh(1)).toThrow('mcp_catalogue_stale');
    expect(f.opens).toBe(0);
    f.tools = [
      {
        name: 'effect',
        inputSchema: {
          type: 'object',
          properties: { old: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ];
    const oldTools = await f.scope.snapshotTools(),
      generation = f.adapter.getCatalogue().generation;
    const oldRead = f.scope.captureRead(generation),
      refresh = f.scope.captureRefresh(generation);
    const cancelled = new AbortController();
    cancelled.abort();
    const before = f.wire.length;
    expect(await refresh.execute({ signal: cancelled.signal })).toMatchObject({
      outcome: 'cancelled',
      details: { adapterAttempted: false },
    });
    expect(f.wire).toHaveLength(before);
    f.tools = [
      {
        name: 'effect',
        inputSchema: {
          type: 'object',
          properties: { current: { type: 'number' } },
          additionalProperties: false,
        },
      },
    ];
    expect(await refresh.execute({ signal: new AbortController().signal })).toMatchObject({
      outcome: 'succeeded',
      details: { generation: generation + 1 },
    });
    const count = f.wire.length;
    expect(
      await oldTools[0]!.execute({ old: 'original' }, {
        signal: new AbortController().signal,
      } as never),
    ).toMatchObject({ outcome: 'failed', details: { adapterAttempted: false } });
    expect(
      await oldRead.execute({ method: 'resources/list' }, { signal: new AbortController().signal }),
    ).toMatchObject({ outcome: 'failed', content: 'mcp_catalogue_stale' });
    expect(f.wire).toHaveLength(count);
    expect(f.opens).toBe(1);
    expect(f.scope.getCachedTools()[0]!.version).not.toBe(oldTools[0]!.version);
    expect(JSON.stringify(f.scope.getCachedTools()[0]!.inputSchema)).toContain('current');
  } finally {
    await f.close();
  }
});
