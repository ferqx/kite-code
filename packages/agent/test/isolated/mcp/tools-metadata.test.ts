import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createArtifactStore } from '../../../src/artifacts';
import type { Json } from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { createMcpAdapter, createMcpLifecycle } from '../../../src/mcp';
import type { ToolsEntry, ToolsSnapshot } from '../../../src/mcp/tools-metadata';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(
  publishFailure = false,
  toolMode = false,
  scopedMode = false,
  recordFailure: false | 'before' | 'after' = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tools-metadata-')));
  const profile = { dataRoot: join(root, 'profile'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  const wire: string[] = [];
  let tools: Tool[] = Array.from({ length: 65 }, (_, index) => ({
    name: index === 63 ? `${'界'.repeat(119)}🙂尾` : `tool-${index}`,
    description: index === 64 ? `完整描述🙂${'多字节🙂'.repeat(150000)}TAIL_原始正文` : 'original',
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          ...(index === 64 ? { description: `${'schema多字节🙂'.repeat(90000)}SCHEMA_TAIL` } : {}),
        },
      },
    },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: { original: 'retained' },
  }));
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await req.json()) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push(rpc.method);
      const start = Number(rpc.params?.cursor ?? 0);
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned', version: '1' },
              capabilities: { tools: {} },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: tools.slice(start, start + 20),
                ...(start + 20 < tools.length ? { nextCursor: String(start + 20) } : {}),
              }
            : { content: [{ type: 'text', text: 'effect' }] };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const servers = [
    {
      id: 'local',
      transport: { type: 'http' as const, url: network.url.href },
      limits: { maxFrameBytes: 8 * 1024 * 1024 },
    },
  ];
  const transportPort = {
    async open() {
      const transport = new StreamableHTTPClientTransport(network.url);
      let ended!: (value: { supervision: 'ended' }) => void;
      const stopped = new Promise<{ supervision: 'ended' }>((resolve) => {
        ended = resolve;
      });
      const close = transport.close.bind(transport);
      transport.close = async () => {
        await close();
        ended({ supervision: 'ended' });
      };
      return {
        transport,
        stopped,
        async stop() {
          await transport.close();
          return { status: 'stopped' as const };
        },
      };
    },
  };
  let resolutions = 0;
  const lifecycle = createMcpLifecycle(
    scopedMode
      ? {
          servers: [],
          scopedSources: {
            async resolve(input, options) {
              resolutions++;
              expect(input.sessionId).toBe('s');
              options.signal.throwIfAborted();
              return {
                server: servers[0]!,
                captureDigest: 'a'.repeat(64),
                transportPort,
                assertFresh({ signal }: { signal: AbortSignal }) {
                  signal.throwIfAborted();
                },
              };
            },
          },
        }
      : { servers, transportPort },
  );
  const runtimeStore = recordFailure
    ? new Proxy(store, {
        get(target, key) {
          if (key === 'writeExtensionRecord')
            return async (input: Parameters<typeof store.writeExtensionRecord>[0]) => {
              if (input.write.contentType === 'builtin.mcp.tools.snapshot') {
                if (recordFailure === 'after') await target.writeExtensionRecord(input);
                throw new Error('owned_snapshot_reply_lost');
              }
              return target.writeExtensionRecord(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : store;
  const refreshCall = {
    type: 'tool_call' as const,
    id: 'actual-refresh',
    name: 'mcp.catalogue.refresh',
    arguments: '{}',
  };
  const fixedModel = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'actual-call',
        name: 'mcp.connect',
        arguments: '{"serverId":"local","key":"original"}',
      },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    [
      refreshCall,
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store: runtimeStore,
    ...(toolMode
      ? {
          model: fixedModel,
          modelId: 'fixed',
        }
      : {}),
    extensions: [lifecycle.extension],
    artifacts: publishFailure
      ? {
          ...artifacts,
          async publish() {
            throw new Error('private failure');
          },
        }
      : artifacts,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned-local-test' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'owned',
    subjectId: 'owner',
  });
  async function action(commandId: string, actionId: string, input: Json) {
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId,
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId,
        definitionVersion: '1',
        input,
      },
    });
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const deadline = Date.now() + 5000;
    while (true) {
      const own = (await store.listExecutions('s')).find(
        (e) =>
          e.originCommandId === commandId &&
          [actionId, `builtin.mcp/${actionId}`].includes(e.definitionId),
      );
      if (own && ['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(own.status))
        return { command, own };
      if (Date.now() > deadline) throw new Error('owned_action_deadline');
      await Bun.sleep(5);
    }
  }
  async function query(queryId: string, input: Json = {}) {
    const views = await runtime.queryExtension({
      sessionId: 's',
      subjectId: 'owner',
      extensionId: 'builtin.mcp',
      queryId,
      input,
    });
    if (queryId.startsWith('mcp.tools'))
      expect(Buffer.byteLength(JSON.stringify(views))).toBeLessThanOrEqual(32 * 1024);
    return views[0]!.payload as Record<string, unknown>;
  }
  async function read(ref: {
    id: string;
    scope: { kind: 'execution'; id: string };
    size: string;
    hash: string;
  }) {
    const bytes = await artifacts.read({
      expectedStoreId,
      refId: ref.id,
      scope: ref.scope,
      sessionId: 's',
      subjectId: 'owner',
    });
    expect(String(bytes.length)).toBe(ref.size);
    expect(sha(bytes)).toBe(ref.hash);
    return bytes;
  }
  return {
    root,
    profile,
    store,
    artifacts,
    runtime,
    lifecycle,
    expectedStoreId,
    wire,
    get resolutions() {
      return resolutions;
    },
    network,
    servers,
    action,
    query,
    read,
    set refreshInput(input: Json) {
      refreshCall.arguments = JSON.stringify(input);
    },
    get modelRequests() {
      return fixedModel.requests;
    },
    get tools() {
      return tools;
    },
    set tools(value: Tool[]) {
      tools = value;
    },
    async close() {
      await lifecycle.close();
      await runtime.close();
      await artifacts.close();
      network.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('real paginated peer, immutable complete UTF8 descriptor, refresh generations and cold metadata reads are effect-free', async () => {
  const f = await fixture();
  try {
    const first = await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    expect(first.own.status).toBe('succeeded');
    expect(f.wire.filter((method) => method === 'tools/list')).toHaveLength(4);
    const snapshots = await f.query('mcp.tools.snapshots');
    const old = (snapshots.items as ToolsSnapshot[])[0]!;
    expect(old.availability).toBe('available');
    expect(old.toolCount).toBe(65);
    const before = [...f.wire];
    let page = await f.query('mcp.tools', {
      recordKey: old.recordKey,
      generation: old.origin.generation,
    });
    expect(page.entries as ToolsEntry[]).toHaveLength(32);
    expect(page.complete).toBe(false);
    expect(page.nextIndex).toBe(32);
    page = await f.query('mcp.tools', {
      recordKey: old.recordKey,
      generation: old.origin.generation,
      indexDigest: old.index!.hash,
      afterIndex: 64,
    });
    expect(page.complete).toBe(true);
    expect(page.nextIndex).toBeNull();
    const entry = (page.entries as ToolsEntry[])[0]!;
    const manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await f.read(entry.manifest)),
    ) as { chunks: { id: string; size: string; hash: string }[] };
    const chunks: Uint8Array[] = [];
    for (const [index, ref] of manifest.chunks.entries()) {
      const bytes = await f.read({ ...ref, scope: entry.manifest.scope });
      if (index + 1 < manifest.chunks.length) expect(bytes.length).toBe(65536);
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    expect(body.length).toBeGreaterThan(1024 * 1024);
    expect(sha(body)).toBe(entry.descriptorHash);
    expect(String(body.length)).toBe(entry.descriptorBytes);
    expect(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))).toEqual(f.tools[64]);
    expect(body.toString('utf8')).toContain('TAIL_原始正文');
    expect(f.wire).toEqual(before);
    f.tools = [{ name: 'new', inputSchema: { type: 'object' }, _meta: { version: 'second' } }];
    const refreshed = await f.action('refresh', 'mcp.catalogue.refresh', {
      serverId: 'local',
      connectionKey: 'original',
      connectionExecutionId: old.origin.connectionExecutionId,
      configDigest: old.origin.configDigest,
      generation: old.origin.generation,
    });
    expect(refreshed.own.status).toBe('succeeded');
    const all = (await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[];
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.origin.generation).sort()).toEqual([1, 2]);
    const historical = await f.query('mcp.tools', {
      recordKey: old.recordKey,
      generation: 1,
      afterIndex: 64,
      indexDigest: old.index!.hash,
    });
    expect(historical.live).toBe(false);
    expect(historical.currentGeneration).toBe(2);
    expect((historical.entries as ToolsEntry[])[0]).toEqual(entry);
    const catalogue = await f.query('mcp.catalogue');
    expect(JSON.stringify(catalogue)).not.toContain('mcp_tools_index');
    await f.runtime.close();
    await f.lifecycle.close();
    const coldStore = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const coldArtifacts = createArtifactStore({ profile: f.profile, store: coldStore });
    const coldLifecycle = createMcpLifecycle({ servers: [] });
    const cold = createRuntime({
      store: coldStore,
      artifacts: coldArtifacts,
      extensions: [coldLifecycle.extension],
      permissions: {
        async authorize() {
          throw new Error('cold_permission_called');
        },
      },
    });
    try {
      const cursor = (await coldStore.getMetadata()).lastChangeCursor;
      const wire = [...f.wire];
      const result = await cold.queryExtension({
        sessionId: 's',
        subjectId: 'owner',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.tools',
        input: {
          recordKey: old.recordKey,
          generation: 1,
          afterIndex: 64,
          indexDigest: old.index!.hash,
        },
      });
      expect((result[0]!.payload as Record<string, unknown>).complete).toBe(true);
      expect((result[0]!.payload as Record<string, unknown>).live).toBe(false);
      expect((await coldStore.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(f.wire).toEqual(wire);
      let denied = false;
      try {
        await cold.queryExtension({
          sessionId: 's',
          subjectId: 'foreign',
          extensionId: 'builtin.mcp',
          queryId: 'mcp.tools.snapshots',
          input: {},
        });
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
      const originalCommand = await coldStore.getCommand('connect');
      const evidencePath = `/private/tmp/kite-mcp-tools-evidence-${randomUUID()}.json`;
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            version: 1,
            originalStoreId: f.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            command: {
              id: originalCommand!.id,
              requestDigest: originalCommand!.requestDigest,
              inputDigest: sha(Buffer.from(canonicalJson(first.own.input))),
            },
            publisherExecutionId: old.origin.publisherExecutionId,
            connectionExecutionId: old.origin.connectionExecutionId,
            snapshots: all.map((s) => ({
              generation: s.origin.generation,
              publisherExecutionId: s.origin.publisherExecutionId,
              indexDigest: s.index!.hash,
            })),
            originalDescriptor: {
              toolIndex: 64,
              bytes: String(body.length),
              hash: sha(body),
              chunks: manifest.chunks.length,
              fullUtf8: true,
              schemaTail: body.toString('utf8').includes('SCHEMA_TAIL'),
            },
            effectLedger: {
              rpcMethods: f.wire,
              toolsCalls: f.wire.filter((method) => method === 'tools/call').length,
              modelExecutions: (await coldStore.listExecutions('s')).filter(
                (e) => e.kind === 'model',
              ).length,
            },
            coldRead: {
              beforeCursor: cursor,
              afterCursor: (await coldStore.getMetadata()).lastChangeCursor,
              rpcAdded: f.wire.length - wire.length,
              foreignDenied: denied,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(`MCP_TOOLS_SAFE_EVIDENCE=${evidencePath}`);
    } finally {
      await cold.close();
      await coldLifecycle.close();
      await coldArtifacts.close();
    }
  } finally {
    await f.close();
  }
}, 15000);

test('metadata publication failure preserves actual successful connection, records unavailable and never retries on Query', async () => {
  const f = await fixture(true);
  try {
    const connected = await f.action('connect', 'mcp.connect', {
      serverId: 'local',
      key: 'original',
    });
    expect(connected.own.status).toBe('succeeded');
    const old = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    expect(old.availability).toBe('unavailable');
    expect(old.index).toBeNull();
    expect(old.reason).toBe('mcp_tools_publication_failed');
    const before = [...f.wire];
    const page = await f.query('mcp.tools', {
      recordKey: old.recordKey,
      generation: old.origin.generation,
    });
    expect(page.entries).toEqual([]);
    expect(page.complete).toBe(false);
    expect(page.nextIndex).toBeNull();
    expect(f.wire).toEqual(before);
    await f.action('reuse', 'mcp.connect', { serverId: 'local', key: 'original' });
    expect(f.wire).toEqual(before);
    expect((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[]).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

test('pure getter captures one frozen SDK generation without wire I/O and retains full metadata', async () => {
  const f = await fixture();
  const adapter = createMcpAdapter({
    ...f.servers[0]!,
    createTransport: async () => new StreamableHTTPClientTransport(f.network.url),
  });
  const scope = adapter.scope('owned');
  try {
    expect(adapter.getToolsMetadata().available).toBe(false);
    expect(f.wire).toEqual([]);
    await scope.snapshotTools();
    const before = [...f.wire],
      old = adapter.getToolsMetadata();
    expect(Object.isFrozen(old)).toBe(true);
    expect(Object.isFrozen(old.tools[64]!.descriptor.inputSchema)).toBe(true);
    expect(old.tools.map((t) => ({ id: t.definitionId, version: t.definitionVersion }))).toEqual(
      adapter.getCatalogue().definitions,
    );
    expect(canonicalJson(old.tools[64]!.descriptor as Json)).toBe(
      canonicalJson(f.tools[64] as Json),
    );
    expect(f.wire).toEqual(before);
    f.tools = [{ name: 'next', inputSchema: { type: 'object' } }];
    const capture = scope.captureRefresh(old.generation);
    await capture.execute({ signal: new AbortController().signal });
    expect(capture.getToolsMetadata()!.generation).toBe(2);
    expect(old.generation).toBe(1);
    expect(old.tools).toHaveLength(65);
  } finally {
    await scope.release();
    await adapter.close();
    await f.close();
  }
}, 10000);

test('ordinary Model Tool connect uses its own actual publisher scope, never the detached connection scope', async () => {
  const f = await fixture(false, true);
  try {
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'tool-work',
      request: { kind: 'run.start', content: 'connect original' },
    });
    const command = await f.runtime.waitForCommand('tool-work', { timeoutMs: 5000 });
    expect(command.status).toBe('applied');
    const original = (await f.store.listExecutions('s')).find(
      (e) => e.kind === 'tool' && e.definitionId === 'mcp.connect',
    )!;
    expect(original.status).toBe('succeeded');
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    expect(saved.origin.publisherExecutionId).toBe(original.id);
    expect(saved.origin.connectionExecutionId).not.toBe(original.id);
    expect(saved.index!.scope).toEqual({ kind: 'execution', id: original.id });
    expect(
      (await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 })).availability,
    ).toBe('available');
  } finally {
    await f.close();
  }
}, 10000);

test('continuation, corrupt scope/provenance/hash and missing physical root fail closed without RPC or mutations', async () => {
  const f = await fixture();
  try {
    await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const cursor = (await f.store.getMetadata()).lastChangeCursor,
      wire = [...f.wire];
    const invalidInputs: Json[] = [
      { recordKey: saved.recordKey, generation: 1, afterIndex: 32 },
      { recordKey: saved.recordKey, generation: 1, afterIndex: 32, indexDigest: '0'.repeat(64) },
      { recordKey: saved.recordKey, generation: 1, afterIndex: 66, indexDigest: saved.index!.hash },
    ];
    for (const input of invalidInputs) {
      const page = await f.query('mcp.tools', input);
      expect(page.availability).toBe('unavailable');
      expect(page.entries).toEqual([]);
      expect(page.complete).toBe(false);
      expect(page.nextIndex).toBeNull();
    }
    const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      const change = (value: unknown, provenance: string | null = null) =>
        db.run(
          'UPDATE extension_record SET json=?,fork_provenance_json=? WHERE extension_id=? AND scope_id=? AND key=?',
          [JSON.stringify(value), provenance, 'builtin.mcp', 's', saved.recordKey],
        );
      change({ ...saved, origin: { ...saved.origin, sessionId: 'foreign' } });
      let denied = false;
      try {
        await f.query('mcp.tools.snapshots');
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
      change(saved, JSON.stringify({ version: 1 }));
      denied = false;
      try {
        await f.query('mcp.tools.snapshots');
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
      change({ ...saved, index: { ...saved.index, hash: '0'.repeat(64) } });
      const corrupt = await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 });
      expect(corrupt.availability).toBe('unavailable');
      expect(corrupt.entries).toEqual([]);
      change(saved);
    } finally {
      db.close();
    }
    const file = join(
      f.profile.dataRoot,
      f.profile.profile,
      'blobs',
      saved.index!.hash.slice(0, 2),
      saved.index!.hash,
    );
    chmodSync(file, 0o600);
    writeFileSync(file, 'invalid UTF8/hash bytes');
    let page = await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 });
    expect(page.availability).toBe('unavailable');
    expect(page.complete).toBe(false);
    expect(page.entries).toEqual([]);
    unlinkSync(file);
    page = await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 });
    expect(page.availability).toBe('unavailable');
    expect(page.entries).toEqual([]);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.wire).toEqual(wire);
  } finally {
    await f.close();
  }
}, 10000);

test('real Fork omits saved executable metadata; old foreign key cannot be borrowed by new Session', async () => {
  const f = await fixture();
  try {
    await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    await f.lifecycle.close();
    await f.runtime.forkSession({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'fork',
      sourceSessionId: 's',
      expectedContextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
      newSessionId: 'forked',
      title: 'forked',
      boundary: null,
    });
    const wire = [...f.wire];
    const rows = await f.runtime.queryExtension({
      sessionId: 'forked',
      subjectId: 'owner',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.tools.snapshots',
      input: {},
    });
    expect((rows[0]!.payload as Record<string, unknown>).items).toEqual([]);
    let denied = false;
    try {
      await f.runtime.queryExtension({
        sessionId: 'forked',
        subjectId: 'owner',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.tools',
        input: { recordKey: saved.recordKey, generation: 1 },
      });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect(f.wire).toEqual(wire);
  } finally {
    await f.close();
  }
}, 10000);

test('cold missing Artifact host and oversized metadata node are explicit unavailable, never prefix complete', async () => {
  const f = await fixture();
  try {
    await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      db.run('UPDATE extension_record SET json=? WHERE extension_id=? AND scope_id=? AND key=?', [
        JSON.stringify({ ...saved, index: { ...saved.index, size: String(256 * 1024 + 1) } }),
        'builtin.mcp',
        's',
        saved.recordKey,
      ]);
      const result = await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 });
      expect(result.availability).toBe('unavailable');
      expect(result.entries).toEqual([]);
      expect(result.complete).toBe(false);
      db.run('UPDATE extension_record SET json=? WHERE extension_id=? AND scope_id=? AND key=?', [
        JSON.stringify(saved),
        'builtin.mcp',
        's',
        saved.recordKey,
      ]);
    } finally {
      db.close();
    }
    await f.runtime.close();
    await f.lifecycle.close();
    const coldStore = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const coldLifecycle = createMcpLifecycle({ servers: [] });
    const cold = createRuntime({
      store: coldStore,
      extensions: [coldLifecycle.extension],
      permissions: {
        async authorize() {
          throw new Error('no_cold_authorization');
        },
      },
    });
    try {
      const before = (await coldStore.getMetadata()).lastChangeCursor,
        wire = [...f.wire];
      const rows = await cold.queryExtension({
        sessionId: 's',
        subjectId: 'owner',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.tools',
        input: { recordKey: saved.recordKey, generation: 1 },
      });
      const result = rows[0]!.payload as Record<string, unknown>;
      expect(result.availability).toBe('unavailable');
      expect(result.reason).toBe('mcp_tools_artifacts_unavailable');
      expect(result.entries).toEqual([]);
      expect(result.complete).toBe(false);
      expect((await coldStore.getMetadata()).lastChangeCursor).toBe(before);
      expect(f.wire).toEqual(wire);
    } finally {
      await cold.close();
      await coldLifecycle.close();
    }
  } finally {
    await f.close();
  }
}, 10000);

test('actual late scoped-source connection version1 and refresh expose original complete metadata without re-resolving', async () => {
  const f = await fixture(false, false, true);
  try {
    const connected = await f.action('source-connect', 'mcp.connect', {
      serverId: 'local',
      key: 'original',
    });
    expect(connected.own.status).toBe('succeeded');
    expect(f.resolutions).toBe(1);
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const connection = await f.store.getExecution(saved.origin.connectionExecutionId);
    expect(connection!.definitionId).toBe('mcp.source.connection');
    expect(connection!.definitionVersion).toBe('1');
    expect(
      (await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 })).availability,
    ).toBe('available');
    f.tools = [
      {
        name: 'source-new',
        inputSchema: { type: 'object' },
        _meta: { full: 'source-generation2' },
      },
    ];
    const refreshed = await f.action('source-refresh', 'mcp.catalogue.refresh', {
      serverId: 'local',
      connectionKey: 'original',
      connectionExecutionId: saved.origin.connectionExecutionId,
      configDigest: saved.origin.configDigest,
      generation: 1,
    });
    expect(refreshed.own.status).toBe('succeeded');
    expect(f.resolutions).toBe(1);
    const snapshots = (await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[];
    expect(snapshots).toHaveLength(2);
    const current = snapshots.find((s) => s.origin.generation === 2)!;
    const before = [...f.wire];
    expect(
      (await f.query('mcp.tools', { recordKey: current.recordKey, generation: 2 })).availability,
    ).toBe('available');
    expect(
      (await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 })).currentGeneration,
    ).toBe(2);
    expect(f.wire).toEqual(before);
    expect(f.resolutions).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('unconfirmed snapshot record reply preserves true publisher uncertainty and never fabricates saved metadata', async () => {
  const f = await fixture(false, false, false, 'after');
  try {
    const result = await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    expect(result.own.status).toBe('outcome_unknown');
    expect(result.own.result).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'mcp_tools_record_persistence_unconfirmed',
    });
    const connection = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.mcp',
      key: 'connection/local/original',
    });
    expect(connection).not.toBeNull();
    const actual = (
      await f.store.listExtensionRecords({
        sessionId: 's',
        extensionId: 'builtin.mcp',
        contentType: 'builtin.mcp.tools.snapshot',
        limit: 32,
      })
    )[0]!;
    expect(actual.value).toMatchObject({ availability: 'available' });
    const wire = [...f.wire];
    let denied = false;
    try {
      await f.query('mcp.tools.snapshots');
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect(f.wire).toEqual(wire);
    expect((await f.store.getExecution(result.own.id))!.status).toBe('outcome_unknown');
  } finally {
    await f.close();
  }
}, 10000);

test('actual SDK lone-surrogate name cannot yield a complete malformed public preview', async () => {
  const f = await fixture();
  try {
    f.tools = [{ name: 'prefix\ud800middle', inputSchema: { type: 'object' } }];
    const result = await f.action('connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    expect(result.own.status).toBe('succeeded');
    const saved = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    expect(saved.availability).toBe('unavailable');
    expect(saved.index).toBeNull();
    const page = await f.query('mcp.tools', { recordKey: saved.recordKey, generation: 1 });
    expect(page.complete).toBe(false);
    expect(page.entries).toEqual([]);
  } finally {
    await f.close();
  }
}, 10000);

test('actual warm new key preserves original connection key A while B metadata and B refresh remain readable', async () => {
  const f = await fixture();
  try {
    await f.action('connect-a', 'mcp.connect', { serverId: 'local', key: 'original' });
    const old = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const before = [...f.wire];
    const b = await f.action('connect-b', 'mcp.connect', { serverId: 'local', key: 'second' });
    expect(b.own.status).toBe('succeeded');
    expect(f.wire).toEqual(before);
    const recordB = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.mcp',
      key: 'connection/local/second',
    });
    expect(recordB!.value).toMatchObject({
      operationRef: {
        key: 'connection/local/original',
        executionId: old.origin.connectionExecutionId,
      },
    });
    const all = (await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[];
    expect(all).toHaveLength(2);
    const snapshotB = all.find((s) => s.origin.publisherExecutionId === b.own.id)!;
    expect(snapshotB.sourceRecordKey).toBe('connection/local/second');
    expect(
      (await f.query('mcp.tools', { recordKey: snapshotB.recordKey, generation: 1 })).availability,
    ).toBe('available');
    f.tools = [{ name: 'after-b-refresh', inputSchema: { type: 'object' } }];
    const refresh = await f.action('refresh-b', 'mcp.catalogue.refresh', {
      serverId: 'local',
      connectionKey: 'second',
      connectionExecutionId: old.origin.connectionExecutionId,
      configDigest: old.origin.configDigest,
      generation: 1,
    });
    expect(refresh.own.status).toBe('succeeded');
    const snapshots = (await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[];
    expect(snapshots).toHaveLength(3);
    const latest = snapshots.find((s) => s.origin.generation === 2)!;
    expect(
      (await f.query('mcp.tools', { recordKey: latest.recordKey, generation: 2 })).availability,
    ).toBe('available');
    for (const previous of [old, snapshotB]) {
      const page = await f.query('mcp.tools', { recordKey: previous.recordKey, generation: 1 });
      expect(page.availability).toBe('available');
      expect(page.live).toBe(false);
      expect(page.currentGeneration).toBe(2);
    }
    const wire = [...f.wire];
    await f.action('same-b', 'mcp.connect', { serverId: 'local', key: 'second' });
    expect(f.wire).toEqual(wire);
    expect((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[]).toHaveLength(3);
    expect(
      (await f.store.listExecutions('s')).filter((e) =>
        e.definitionId.startsWith('mcp.connection.'),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

async function fullDescriptor(
  read: (ref: ToolsEntry['manifest']) => Promise<Uint8Array>,
  entry: ToolsEntry,
) {
  const manifest = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await read(entry.manifest)),
  ) as { chunks: { id: string; size: string; hash: string }[] };
  const chunks: Uint8Array[] = [];
  for (const [index, ref] of manifest.chunks.entries()) {
    const bytes = await read({
      ...ref,
      scope: entry.manifest.scope,
      mediaType: 'application/octet-stream',
    });
    expect(String(bytes.length)).toBe(ref.size);
    expect(sha(bytes)).toBe(ref.hash);
    if (index + 1 < manifest.chunks.length) expect(bytes.length).toBe(65536);
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  expect(sha(body)).toBe(entry.descriptorHash);
  expect(String(body.length)).toBe(entry.descriptorBytes);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Tool;
}

test('actual ordinary Model Tool refresh seals its own scope and both original generation bodies remain readable', async () => {
  const f = await fixture(false, true);
  try {
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'model-connect',
      request: { kind: 'run.start', content: 'ordinary Tool connect' },
    });
    await f.runtime.waitForCommand('model-connect', { timeoutMs: 5000 });
    const first = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const original = f.tools[64]!;
    const second: Tool = {
      name: 'Tool-refresh-new',
      inputSchema: {
        type: 'object',
        properties: {
          full: { type: 'string', description: `${'完整🙂'.repeat(12000)}REFRESH_SCHEMA_TAIL` },
        },
      },
      _meta: { actual: 'second' },
    };
    f.tools = [second];
    f.refreshInput = {
      serverId: 'local',
      connectionKey: 'original',
      connectionExecutionId: first.origin.connectionExecutionId,
      configDigest: first.origin.configDigest,
      generation: 1,
    };
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'model-refresh',
      request: { kind: 'run.start', content: 'ordinary Tool refresh' },
    });
    await f.runtime.waitForCommand('model-refresh', { timeoutMs: 5000 });
    const executions = await f.store.listExecutions('s');
    const refresh = executions.find(
      (e) => e.kind === 'tool' && e.definitionId === 'mcp.catalogue.refresh',
    )!;
    expect(refresh.status).toBe('succeeded');
    expect(refresh.runId).not.toBeNull();
    expect(f.modelRequests).toHaveLength(4);
    const snapshots = (await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[];
    expect(snapshots).toHaveLength(2);
    const current = snapshots.find((s) => s.origin.generation === 2)!;
    expect(current.origin.publisherExecutionId).toBe(refresh.id);
    expect(current.index!.scope).toEqual({ kind: 'execution', id: refresh.id });
    expect(current.origin.connectionExecutionId).toBe(first.origin.connectionExecutionId);
    const before = [...f.wire],
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    const oldPage = await f.query('mcp.tools', {
      recordKey: first.recordKey,
      generation: 1,
      afterIndex: 64,
      indexDigest: first.index!.hash,
    });
    const newPage = await f.query('mcp.tools', { recordKey: current.recordKey, generation: 2 });
    expect(await fullDescriptor(f.read, (oldPage.entries as ToolsEntry[])[0]!)).toEqual(original);
    expect(await fullDescriptor(f.read, (newPage.entries as ToolsEntry[])[0]!)).toEqual(second);
    expect(oldPage.live).toBe(false);
    expect(newPage.live).toBe(true);
    expect(f.wire).toEqual(before);
    expect(f.modelRequests).toHaveLength(4);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
}, 15000);

test('actual public offline backup and restore A to B preserve old metadata/Artifact origin with cold zero effects', async () => {
  const f = await fixture();
  try {
    await f.action('original-connect', 'mcp.connect', { serverId: 'local', key: 'original' });
    const snapshot = ((await f.query('mcp.tools.snapshots')).items as ToolsSnapshot[])[0]!;
    const original = f.tools[64]!;
    await f.runtime.close();
    await f.lifecycle.close();
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.source.storeId).toBe(f.expectedStoreId);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.expectedStoreId);
    const coldStore = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const artifacts = createArtifactStore({ profile: f.profile, store: coldStore });
    let publishes = 0;
    const coldLifecycle = createMcpLifecycle({ servers: [] });
    const cold = createRuntime({
      store: coldStore,
      artifacts: {
        ...artifacts,
        async publish() {
          publishes++;
          throw new Error('cold_publish_forbidden');
        },
      },
      extensions: [coldLifecycle.extension],
      permissions: {
        async authorize() {
          throw new Error('restored_read_not_authorization');
        },
      },
    });
    try {
      const before = (await coldStore.getMetadata()).lastChangeCursor,
        wire = [...f.wire];
      const query = async (queryId: string, input: Json) =>
        (
          await cold.queryExtension({
            sessionId: 's',
            subjectId: 'owner',
            expectedStoreId: restored.storeId,
            extensionId: 'builtin.mcp',
            queryId,
            input,
          })
        )[0]!.payload as Record<string, unknown>;
      const rows = (await query('mcp.tools.snapshots', {})).items as ToolsSnapshot[];
      expect(rows).toEqual([snapshot]);
      expect(rows[0]!.origin.originStoreId).toBe(f.expectedStoreId);
      const page = await query('mcp.tools', {
        recordKey: snapshot.recordKey,
        generation: 1,
        afterIndex: 64,
        indexDigest: snapshot.index!.hash,
      });
      expect(page.availability).toBe('available');
      expect(page.complete).toBe(true);
      expect(page.live).toBe(false);
      expect(page.currentGeneration).toBeNull();
      const read = async (ref: ToolsEntry['manifest']) => {
        const bytes = await artifacts.read({
          expectedStoreId: restored.storeId,
          sessionId: 's',
          subjectId: 'owner',
          refId: ref.id,
          scope: ref.scope,
        });
        expect(String(bytes.length)).toBe(ref.size);
        expect(sha(bytes)).toBe(ref.hash);
        return bytes;
      };
      expect(await fullDescriptor(read, (page.entries as ToolsEntry[])[0]!)).toEqual(original);
      const oldPublisher = await coldStore.getExecution(snapshot.origin.publisherExecutionId);
      expect(oldPublisher!.originStoreId).toBe(f.expectedStoreId);
      expect(oldPublisher!.status).toBe('succeeded');
      let refused = false;
      try {
        await cold.queryExtension({
          sessionId: 's',
          subjectId: 'foreign',
          expectedStoreId: restored.storeId,
          extensionId: 'builtin.mcp',
          queryId: 'mcp.tools.snapshots',
          input: {},
        });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      refused = false;
      try {
        await cold.queryExtension({
          sessionId: 's',
          subjectId: 'owner',
          expectedStoreId: f.expectedStoreId,
          extensionId: 'builtin.mcp',
          queryId: 'mcp.tools.snapshots',
          input: {},
        });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(
        (
          await coldLifecycle.readStepCapabilities({
            command: { originStoreId: restored.storeId },
            session: { id: 's' },
          })
        ).toolIds,
      ).toEqual([]);
      expect((await coldStore.listExecutions('s')).filter((e) => e.kind === 'model')).toEqual([]);
      expect(publishes).toBe(0);
      expect(f.wire).toEqual(wire);
      expect((await coldStore.getMetadata()).lastChangeCursor).toBe(before);
    } finally {
      await cold.close();
      await coldLifecycle.close();
      await artifacts.close();
    }
  } finally {
    await f.close();
  }
}, 15000);
