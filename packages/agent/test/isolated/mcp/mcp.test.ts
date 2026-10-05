import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import type { ToolContext } from '../../../src/extensions';
import { defineExtension } from '../../../src/extensions';
import { createMcpAdapter } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const serverPath = join(import.meta.dir, '../../../../../tests/fixtures/mcp-leaf/stdio.ts');
const descriptor = {
  name: 'external-tool',
  description: 'Remote operation',
  inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
  outputSchema: {
    type: 'object',
    required: ['version'],
    properties: { version: { const: 'old' } },
  },
};
function context(signal = new AbortController().signal): ToolContext {
  return { signal } as ToolContext;
}
function setup(
  gated = false,
  limits?: Parameters<typeof createMcpAdapter>[0]['limits'],
  admitToolCall?: Parameters<typeof createMcpAdapter>[0]['admitToolCall'],
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-mcp-'));
  const ledger = join(root, 'ledger');
  const catalogue = join(root, 'catalogue');
  const gate = join(root, 'release');
  writeFileSync(catalogue, JSON.stringify([descriptor]));
  const adapter = createMcpAdapter({
    id: 'fixture',
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [serverPath, ledger, catalogue, gated ? gate : ''],
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
    },
    limits,
    admitToolCall,
  });
  return {
    root,
    ledger,
    catalogue,
    gate,
    adapter,
    async close() {
      writeFileSync(gate, 'release');
      await adapter.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function until(read: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error('fixture_deadline');
    await Bun.sleep(5);
  }
}

test('MCP lazy stdio scopes share a connection; immutable snapshots retain old schemas and output validation', async () => {
  const f = setup();
  try {
    expect(existsSync(f.ledger)).toBe(false);
    const a = f.adapter.scope('session-a');
    const b = f.adapter.scope('session-b');
    expect(existsSync(f.ledger)).toBe(false);
    const old = (await a.snapshotTools())[0]!;
    expect(Object.isFrozen(old)).toBe(true);
    expect(Object.isFrozen(old.inputSchema)).toBe(true);
    const resources = await b.listResources();
    expect(resources[0]?.uri).toBe('fixture://resource');
    expect((await b.readResource(resources[0]!.uri)).contents[0]).toMatchObject({
      text: 'resource-text',
    });
    expect((await b.listPrompts())[0]?.name).toBe('guidance');
    expect((await b.getPrompt('guidance')).messages[0]?.content).toMatchObject({
      text: 'prompt-text',
    });
    writeFileSync(
      f.catalogue,
      JSON.stringify([
        {
          ...descriptor,
          inputSchema: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'number' } },
          },
          outputSchema: {
            type: 'object',
            required: ['version'],
            properties: { version: { const: 'new' } },
          },
        },
      ]),
    );
    const fresh = (await b.snapshotTools())[0]!;
    expect(fresh.id).toBe(old.id);
    expect(fresh.version).not.toBe(old.version);
    expect(old.inputSchema).toEqual(descriptor.inputSchema);
    expect(await old.execute({ value: 'original' }, context())).toMatchObject({
      outcome: 'failed',
      content: 'mcp_catalogue_stale',
      details: { adapterAttempted: false },
    });
    expect((await fresh.execute({ value: 2 }, context())).outcome).toBe('outcome_unknown');
    writeFileSync(f.catalogue, '[]');
    expect(await b.snapshotTools()).toEqual([]);
    expect(old.inputSchema).toEqual(descriptor.inputSchema);
    await a.release();
    await a.release();
    expect(await old.execute({ value: 'original' }, context())).toMatchObject({
      outcome: 'failed',
      content: 'mcp_scope_released',
      details: { adapterAttempted: false },
    });
    expect(await b.listResources()).toHaveLength(1);
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line === 'connect'),
    ).toHaveLength(1);
    await b.release();
  } finally {
    await f.close();
  }
});

test('MCP cancellation after remote effect stays unknown; releasing one scope preserves another and never retries', async () => {
  const f = setup(true);
  try {
    const a = f.adapter.scope('a');
    const b = f.adapter.scope('b');
    const tool = (await a.snapshotTools())[0]!;
    const before = new AbortController();
    before.abort();
    expect(await tool.execute({ value: 'never-called' }, context(before.signal))).toMatchObject({
      outcome: 'cancelled',
      details: { adapterAttempted: false },
    });
    expect(readFileSync(f.ledger, 'utf8').includes('effect:')).toBe(false);
    const controller = new AbortController();
    const call = tool.execute({ value: 'effect' }, context(controller.signal));
    await until(() => existsSync(f.ledger) && readFileSync(f.ledger, 'utf8').includes('effect:'));
    controller.abort();
    const result = await call;
    expect(result).toMatchObject({
      outcome: 'outcome_unknown',
      details: { remoteStopConfirmed: false },
    });
    await a.release();
    expect(await b.listPrompts()).toHaveLength(1);
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:')),
    ).toHaveLength(1);
    writeFileSync(f.gate, 'release');
    await b.release();
  } finally {
    await f.close();
  }
});

test('MCP oversized stdio frames fail locally; ordinary no-MCP Runtime still completes', async () => {
  const f = setup(false, { maxFrameBytes: 1024 });
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    writeFileSync(f.catalogue, JSON.stringify([{ ...descriptor, description: 'x'.repeat(4096) }]));
    const scope = f.adapter.scope('bounded');
    await expect(scope.snapshotTools()).rejects.toBeDefined();
    await scope.release();
    const store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'local' });
    const model = createFixedModel([
      [
        { type: 'text_delta', text: 'ordinary reply' },
        { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
    ]);
    runtime = createRuntime({
      store,
      model,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    const info = await store.getMetadata();
    await store.createWorkspace({
      expectedStoreId: info.storeId,
      id: 'w',
      rootUri: `file://${f.root}`,
      name: 'local',
    });
    await store.createSession({
      expectedStoreId: info.storeId,
      commandId: 'session',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'local',
    });
    await runtime.submitCommand({
      expectedStoreId: info.storeId,
      commandId: 'ordinary',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'hello' },
    });
    await runtime.waitForCommand('ordinary');
    expect((await runtime.getView('s')).runs[0]?.status).toBe('completed');
    expect(model.requests).toHaveLength(1);
  } finally {
    await runtime?.close();
    await f.close();
  }
});

test('MCP ToolDefinition is executed by actual UnifiedExecution with durable provenance and host permission', async () => {
  const f = setup();
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const scope = f.adapter.scope('runtime');
    const tools = await scope.snapshotTools();
    const tool = tools[0]!;
    const store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'local' });
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'call', name: tool.id, arguments: '{"value":"local"}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    let authorizations = 0;
    runtime = createRuntime({
      store,
      model,
      extensions: [defineExtension({ id: 'mcp.fixture', version: '1', apiMajor: 1, tools })],
      permissions: {
        async authorize() {
          authorizations++;
          return { allowed: true, revision: '1' };
        },
      },
    });
    const info = await store.getMetadata();
    await store.createWorkspace({
      expectedStoreId: info.storeId,
      id: 'w',
      rootUri: `file://${f.root}`,
      name: 'local',
    });
    await store.createSession({
      expectedStoreId: info.storeId,
      commandId: 'session',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'local',
    });
    await runtime.submitCommand({
      expectedStoreId: info.storeId,
      commandId: 'run',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'explicit tool' },
    });
    await runtime.waitForCommand('run');
    const view = await runtime.getView('s');
    const execution = view.executions.find((value) => value.kind === 'tool')!;
    expect(execution).toMatchObject({
      status: 'succeeded',
      definitionId: tool.id,
      definitionVersion: tool.version,
    });
    expect(execution.originCommandId).toBe('run');
    expect(authorizations).toBeGreaterThan(0);
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:')),
    ).toHaveLength(1);
    await scope.release();
  } finally {
    await runtime?.close();
    await f.close();
  }
});

test('MCP real HTTP initializes on demand, bounds bodies and retains unknown effect on lost result', async () => {
  let initializations = 0;
  let effects = 0;
  let lost = false;
  let large = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer private-fixture');
      if (request.method === 'GET' || request.method === 'DELETE')
        return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: string | number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') {
        initializations++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'http-fixture', version: '1' },
          capabilities: { tools: {} },
        };
      } else if (rpc.method === 'tools/list')
        result = { tools: [{ ...descriptor, description: large ? 'x'.repeat(4096) : 'remote' }] };
      else {
        effects++;
        if (lost) return new Response(null, { status: 500 });
        result = {
          content: [{ type: 'text', text: 'remote result' }],
          structuredContent: { version: 'old' },
        };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const adapter = createMcpAdapter({
    id: 'http',
    transport: {
      type: 'http',
      url: server.url.href,
      headers: { Authorization: 'Bearer private-fixture' },
    },
    limits: { maxFrameBytes: 2048 },
  });
  try {
    const scope = adapter.scope('s');
    expect(initializations).toBe(0);
    const tool = (await scope.snapshotTools())[0]!;
    expect(initializations).toBe(1);
    expect((await tool.execute({ value: 'first' }, context())).outcome).toBe('succeeded');
    lost = true;
    expect((await tool.execute({ value: 'lost' }, context())).outcome).toBe('outcome_unknown');
    expect(effects).toBe(2);
    large = true;
    await expect(scope.snapshotTools()).rejects.toBeDefined();
    await scope.release();
  } finally {
    await adapter.close();
    server.stop(true);
  }
});

test('MCP bounds pending requests and catalogue pagination; disconnect cannot invent remote stop', async () => {
  const f = setup(true, { maxInFlight: 1, maxItems: 1 });
  try {
    const scope = f.adapter.scope('bounded');
    const tool = (await scope.snapshotTools())[0]!;
    writeFileSync(f.catalogue, JSON.stringify([descriptor, { ...descriptor, name: 'second' }]));
    await expect(scope.snapshotTools()).rejects.toMatchObject({ code: 'mcp_catalogue_limit' });
    writeFileSync(f.catalogue, JSON.stringify({ tools: [], nextCursor: 'repeated' }));
    await expect(scope.snapshotTools()).rejects.toMatchObject({ code: 'mcp_cursor_repeated' });
    const call = tool.execute({ value: 'disconnect' }, context());
    await until(() => readFileSync(f.ledger, 'utf8').includes('effect:'));
    await expect(scope.listPrompts()).rejects.toMatchObject({ code: 'mcp_request_capacity' });
    await f.adapter.close();
    expect(await call).toMatchObject({
      outcome: 'outcome_unknown',
      details: { remoteStopConfirmed: false },
    });
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:')),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('MCP pure catalogue reads never connect; invalidation during host admission prevents the old RPC', async () => {
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bindings: Parameters<
    NonNullable<Parameters<typeof createMcpAdapter>[0]['admitToolCall']>
  >[0][] = [];
  const f = setup(false, undefined, async (binding) => {
    bindings.push(binding);
    if (bindings.length === 1) {
      reached();
      await gate;
    }
  });
  try {
    const a = f.adapter.scope('a');
    const b = f.adapter.scope('b');
    for (let i = 0; i < 8; i++) {
      expect(a.getCachedTools()).toEqual([]);
      expect(f.adapter.getCatalogue()).toMatchObject({ available: false, definitions: [] });
    }
    expect(existsSync(f.ledger)).toBe(false);
    const old = (await a.snapshotTools())[0]!;
    const before = readFileSync(f.ledger, 'utf8');
    const oldCatalogue = f.adapter.getCatalogue();
    expect(b.getCachedTools()[0]?.version).toBe(old.version);
    expect(a.getCachedTools()[0]).toBe(old);
    expect(readFileSync(f.ledger, 'utf8')).toBe(before);
    const pending = old.execute({ value: 'old-intent' }, context());
    await entered;
    expect(Object.isFrozen(bindings[0])).toBe(true);
    expect(bindings[0]).toEqual({
      serverId: 'fixture',
      scopeId: 'a',
      configDigest: oldCatalogue.configDigest,
      catalogueGeneration: oldCatalogue.generation,
      definitionId: old.id,
      definitionVersion: old.version,
    });
    f.adapter.invalidateCatalogue();
    expect(b.getCachedTools()).toEqual([]);
    expect(f.adapter.getCatalogue().available).toBe(false);
    writeFileSync(f.catalogue, JSON.stringify([{ ...descriptor, description: 'New descriptor' }]));
    const fresh = (await b.snapshotTools())[0]!;
    expect(fresh.version).not.toBe(old.version);
    expect(f.adapter.getCatalogue().generation).toBeGreaterThan(oldCatalogue.generation);
    release();
    expect(await pending).toMatchObject({
      outcome: 'failed',
      content: 'mcp_catalogue_stale',
      details: { adapterAttempted: false },
    });
    expect(readFileSync(f.ledger, 'utf8').includes('effect:')).toBe(false);
    expect((await fresh.execute({ value: 'new-intent' }, context())).outcome).toBe('succeeded');
    expect(bindings[1]?.definitionVersion).toBe(fresh.version);
    await a.release();
    expect((await fresh.execute({ value: 'other-scope' }, context())).outcome).toBe('succeeded');
    expect(readFileSync(f.ledger, 'utf8').split('effect:')).toHaveLength(3);
    await b.release();
    expect(f.adapter.getCatalogue().available).toBe(false);
  } finally {
    release();
    await f.close();
  }
}, 10000);

test('MCP host admission rejection is local and sanitized; abort during admission sends no RPC', async () => {
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deny = true;
  const f = setup(false, undefined, async () => {
    if (deny) throw new Error('secret-host-error-must-not-leak');
    reached();
    await gate;
  });
  try {
    const scope = f.adapter.scope('admission');
    const tool = (await scope.snapshotTools())[0]!;
    const generation = f.adapter.getCatalogue().generation;
    expect((await scope.snapshotTools())[0]).toBe(tool);
    expect(f.adapter.getCatalogue().generation).toBe(generation);
    const rejected = await tool.execute({ value: 'denied' }, context());
    expect(rejected).toMatchObject({
      outcome: 'failed',
      content: 'mcp_admission_rejected',
      details: { adapterAttempted: false },
    });
    expect(JSON.stringify(rejected)).not.toContain('secret-host-error');
    deny = false;
    const controller = new AbortController();
    const pending = tool.execute({ value: 'cancelled' }, context(controller.signal));
    await entered;
    controller.abort();
    release();
    expect(await pending).toMatchObject({
      outcome: 'cancelled',
      content: 'mcp_cancelled_before_call',
      details: { adapterAttempted: false },
    });
    expect(readFileSync(f.ledger, 'utf8').includes('effect:')).toBe(false);
    await scope.release();
  } finally {
    release();
    await f.close();
  }
}, 10000);

test('admission waits retain a single original schema-valid bounded argument snapshot on actual RPC', async () => {
  let entered!: () => void;
  let release!: () => void;
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = setup(false, { maxFrameBytes: 4096 }, async () => {
    entered();
    await gate;
  });
  try {
    const scope = f.adapter.scope('argument-snapshot');
    const tool = (await scope.snapshotTools())[0]!;
    const input = { value: 'original', nested: { note: 'captured' } };
    const pending = tool.execute(input, context());
    await admission;
    (input as Record<string, unknown>).value = 42;
    input.nested.note = 'x'.repeat(8192);
    release();
    expect((await pending).outcome).toBe('succeeded');
    const wire = readFileSync(f.ledger, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('effect:'))!;
    expect(JSON.parse(wire.slice('effect:'.length))).toEqual({
      name: descriptor.name,
      arguments: { value: 'original', nested: { note: 'captured' } },
    });
    expect(tool.inputSchema).toEqual(descriptor.inputSchema);
    expect(Object.isFrozen(tool.inputSchema)).toBe(true);
    expect((input as Record<string, unknown>).value).toBe(42);
    expect(input.nested.note.length).toBe(8192);
    expect(await tool.execute({ value: 1 }, context())).toMatchObject({
      outcome: 'failed',
      content: 'mcp_arguments_invalid',
    });
    expect(await tool.execute({ value: 'x'.repeat(8192) }, context())).toMatchObject({
      outcome: 'failed',
      content: 'mcp_payload_limit',
      details: { adapterAttempted: false },
    });
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('effect:')),
    ).toHaveLength(1);
    await scope.release();
  } finally {
    release();
    await f.close();
  }
}, 10000);
