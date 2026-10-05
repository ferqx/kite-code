import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Json } from '../../../src/extensions';
import { createMcpLifecycle } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-connection-query-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const wire: string[] = [];
  let resolutions = 0;
  let stopUnknown = false;
  let stopEntered = false;
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push(rpc.method);
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'owned', version: '1' },
                capabilities: { tools: {} },
              }
            : {
                tools: Array.from({ length: 400 }, (_, i) => ({
                  name: `tool_${i}`,
                  inputSchema: {
                    type: 'object',
                    description: i === 399 ? '原🙂'.repeat(100000) : 'original',
                  },
                })),
              },
      });
    },
  });
  const options = {
    servers: [],
    scopedSources: {
      async resolve() {
        resolutions++;
        return {
          server: {
            id: 'local',
            transport: { type: 'http' as const, url: peer.url.href },
            limits: { maxFrameBytes: 8 * 1024 * 1024 },
          },
          captureDigest: 'a'.repeat(64),
          assertFresh({ signal }: { signal: AbortSignal }) {
            signal.throwIfAborted();
          },
          transportPort: {
            async open() {
              const transport = new StreamableHTTPClientTransport(peer.url);
              let ended!: (v: { supervision: 'ended' }) => void;
              const stopped = new Promise<{ supervision: 'ended' }>((r) => {
                ended = r;
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
                  if (stopUnknown) {
                    stopEntered = true;
                    await stopGate;
                    return { status: 'unknown' as const };
                  }
                  await transport.close();
                  return { status: 'stopped' as const };
                },
              };
            },
          },
        };
      },
    },
  };
  let lifecycle = createMcpLifecycle(options);
  const makeRuntime = () =>
    createRuntime({
      get store() {
        return store;
      },
      extensions: [lifecycle.extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
    });
  let runtime = makeRuntime();
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
  async function action(id: string, key: string, serverId = 'local') {
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: id,
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId: 'mcp.connect',
        definitionVersion: '1',
        input: { serverId, key },
      },
    });
    await runtime.waitForCommand(id, { timeoutMs: 5000 });
    const deadline = Date.now() + 5000;
    for (;;) {
      const e = (await store.listExecutions('s')).find(
        (e) => e.originCommandId === id && e.definitionId === 'builtin.mcp/mcp.connect',
      );
      if (e && ['succeeded', 'failed', 'outcome_unknown'].includes(e.status)) return e;
      if (Date.now() > deadline) throw Error('connection_deadline');
      await Bun.sleep(5);
    }
  }
  async function query(executionId: string, key: string, subjectId = 'owner', serverId = 'local') {
    const view = await runtime.queryExtension({
      sessionId: 's',
      subjectId,
      extensionId: 'builtin.mcp',
      queryId: 'mcp.connection',
      input: { executionId, serverId, key },
    });
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(16 * 1024);
    expect(view[0]!.actions).toEqual([]);
    expect(view[0]!.artifactRefs).toEqual([]);
    return view[0]!.payload as Record<string, unknown>;
  }
  return {
    root,
    get store() {
      return store;
    },
    profile,
    wire,
    action,
    query,
    get resolutions() {
      return resolutions;
    },
    async beginUnknownStop() {
      stopUnknown = true;
      const closing = lifecycle.close();
      const deadline = Date.now() + 5000;
      while (!stopEntered) {
        if (Date.now() > deadline) throw Error('stop_barrier_deadline');
        await Bun.sleep(5);
      }
      return {
        async release() {
          releaseStop();
          await closing;
        },
      };
    },
    async cold() {
      await runtime.close();
      await lifecycle.close();
      store = await openSqliteStore(profile);
      lifecycle = createMcpLifecycle(options);
      runtime = makeRuntime();
    },
    async close() {
      stopUnknown = false;
      releaseStop();
      await lifecycle.close();
      await runtime.close();
      await store.close();
      peer.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('actual scoped Action new/warm/cold finite original ready facts, 400-tool catalogue and no read effects', async () => {
  const f = await fixture();
  try {
    const a = await f.action('connect_a', 'a');
    expect(a.status).toBe('succeeded');
    const first = await f.query(a.id, 'a');
    expect(first.phase).toBe('ready');
    expect(first.created).toBe(true);
    expect(first.live).toBe(true);
    expect((first.ready as { toolCount: number }).toolCount).toBe(400);
    const b = await f.action('connect_b', 'b');
    const warm = await f.query(b.id, 'b');
    expect(warm.phase).toBe('ready');
    expect(warm.created).toBe(false);
    expect(warm.operationRef).toEqual(first.operationRef);
    const before = [...f.wire];
    await expect(f.query(a.id, 'wrong')).rejects.toThrow();
    await expect(f.query(a.id, 'a', 'foreign')).rejects.toThrow();
    await f.cold();
    const coldCursor = (await f.store.getMetadata()).lastChangeCursor;
    const cold = await f.query(a.id, 'a');
    expect(cold.phase).toBe('ready');
    expect(cold.live).toBe(false);
    expect(cold.currentGeneration).toBeNull();
    expect(cold.operationRef).toEqual(first.operationRef);
    expect(f.wire).toEqual(before);
    expect(f.resolutions).toBe(2);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(coldCursor);
    const repeated = await f.action('cold_same', 'a');
    expect(repeated.status).toBe('failed');
    const failed = await f.query(repeated.id, 'a');
    expect(failed.phase).toBe('failed');
    expect(f.wire).toEqual(before);
    console.log(
      JSON.stringify({
        case: 'scoped_connection',
        original: first,
        warm: { execution: warm.execution, created: warm.created },
        cold: {
          execution: cold.execution,
          live: cold.live,
          currentGeneration: cold.currentGeneration,
        },
        wire: before,
        resolutions: f.resolutions,
        coldReadCursor: coldCursor,
      }),
    );
  } finally {
    await f.close();
  }
}, 10000);
test('corrupt original ready/ref and failed detached operation stay unknown, never claim zero effect', async () => {
  const f = await fixture();
  try {
    const a = await f.action('connect', 'original');
    const good = await f.query(a.id, 'original');
    const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      const result = structuredClone(a.result) as {
        outcome: string;
        details: Record<string, Json>;
      };
      const connectionId = (good.operationRef as { executionId: string }).executionId;
      const originalWire = [...f.wire];
      const originalCursor = (await f.store.getMetadata()).lastChangeCursor;
      for (const [field, value] of [
        ['sessionId', 'foreign'],
        ['originStoreId', 'foreign'],
        ['commandId', 'foreign'],
        ['key', 'connection/local/foreign'],
      ] as const) {
        const forged = structuredClone(result);
        (forged.details.operationRef as Record<string, Json>)[field] = value;
        db.query('UPDATE execution SET result_json=? WHERE id=?').run(JSON.stringify(forged), a.id);
        const fact = await f.query(a.id, 'original');
        expect(fact.phase).toBe('outcome_unknown');
        expect(fact.ready).toBeNull();
        expect(fact.operationRef).toBeNull();
      }
      db.query('UPDATE execution SET result_json=? WHERE id=?').run(JSON.stringify(result), a.id);
      db.query("UPDATE execution SET definition_version='foreign' WHERE id=?").run(connectionId);
      expect((await f.query(a.id, 'original')).ready).toBeNull();
      db.query("UPDATE execution SET definition_version='1' WHERE id=?").run(connectionId);
      const wrongGeneration = structuredClone(result);
      wrongGeneration.details.generation = -1;
      db.query('UPDATE execution SET result_json=? WHERE id=?').run(
        JSON.stringify(wrongGeneration),
        a.id,
      );
      expect((await f.query(a.id, 'original')).ready).toBeNull();
      expect(f.wire).toEqual(originalWire);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(originalCursor);
      expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'model')).toHaveLength(0);
      result.outcome = 'failed';
      result.details.adapterAttempted = false;
      db.query("UPDATE execution SET state='failed',result_json=? WHERE id=?").run(
        JSON.stringify(result),
        a.id,
      );
      const unknown = await f.query(a.id, 'original');
      expect(unknown.phase).toBe('outcome_unknown');
      expect(unknown.ready).toBeNull();
      expect(unknown.operationRef).toEqual(good.operationRef);
      result.details.operationRef = {
        ...(result.details.operationRef as Record<string, Json>),
        commandId: 'forged',
      };
      db.query('UPDATE execution SET result_json=? WHERE id=?').run(JSON.stringify(result), a.id);
      const forged = await f.query(a.id, 'original');
      expect(forged.phase).toBe('outcome_unknown');
      expect(forged.operationRef).toBeNull();
    } finally {
      db.close(true);
    }
  } finally {
    await f.close();
  }
}, 10000);

test('actual stop barrier and unconfirmed stop withdraw live generation while original ready persists', async () => {
  const f = await fixture();
  try {
    const action = await f.action('connect_stop', 'stop_key');
    const original = await f.query(action.id, 'stop_key');
    expect(original.phase).toBe('ready');
    expect(original.live).toBe(true);
    const stopping = await f.beginUnknownStop();
    const wire = [...f.wire];
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    try {
      const during = await f.query(action.id, 'stop_key');
      expect(during.phase).toBe('ready');
      expect(during.ready).toEqual(original.ready);
      expect(during.live).toBe(false);
      expect(during.currentGeneration).toBeNull();
      expect(during.execution).toEqual(original.execution);
      expect(during.operationRef).toEqual(original.operationRef);
    } finally {
      await stopping.release();
    }
    const unknown = await f.query(action.id, 'stop_key');
    expect(unknown.phase).toBe('ready');
    expect(unknown.ready).toEqual(original.ready);
    expect(unknown.live).toBe(false);
    expect(unknown.currentGeneration).toBeNull();
    expect(unknown.execution).toEqual(original.execution);
    expect(unknown.operationRef).toEqual(original.operationRef);
    expect(f.wire).toEqual(wire);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
}, 10000);
