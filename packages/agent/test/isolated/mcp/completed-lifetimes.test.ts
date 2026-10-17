import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Json, OperationRef } from '../../../src/extensions';
import { createMcpLifecycle, type McpReconnectionInput } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-completed-lifetimes-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let opens = 0,
    stops = 0,
    wire = 0;
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: string | number; method: string };
      wire++;
      if (rpc.id === undefined) return new Response(null, { status: 202 });
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
            : { tools: [] },
      });
    },
  });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport: { type: 'http', url: peer.url.href } }],
    transportPort: {
      async open() {
        opens++;
        const transport = new StreamableHTTPClientTransport(peer.url);
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
            stops++;
            await transport.close();
            return { status: 'stopped' as const };
          },
        };
      },
    },
  });
  const runtime = createRuntime({
    store,
    extensions: [lifecycle.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'lifetimes',
  });
  const invoke = async (id: string, actionId: string, input: Json) => {
    await runtime.submitCommand({
      ...base,
      commandId: id,
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId,
        definitionVersion: '1',
        input,
      },
    });
    const command = await runtime.waitForCommand(id, { timeoutMs: 5000 });
    const executionId = (command.receipt as { executionId: string }).executionId;
    const execution = (await store.getExecution(executionId))!;
    if (execution.status !== 'succeeded')
      throw Error(`mcp_lifetime_${id}:${JSON.stringify(execution.result)}`);
    return execution;
  };
  const query = async (id: string, key?: string) =>
    (
      await runtime.queryExtension({
        sessionId: 's',
        subjectId: 'owner',
        extensionId: 'builtin.mcp',
        queryId: key ? 'mcp.connection' : 'mcp.reconnection',
        input: key ? { executionId: id, serverId: 'local', key } : { executionId: id },
      })
    )[0]!.payload as Record<string, Json>;
  const stop = async (ref: OperationRef, id: string) => {
    await runtime.cancelExecution({ ...base, commandId: id, executionId: ref.executionId! });
    const deadline = Date.now() + 5000;
    while ((await store.getExecution(ref.executionId!))!.status !== 'cancelled') {
      if (Date.now() > deadline) throw Error('owned_connection_stop_deadline');
      await Bun.sleep(1);
    }
  };
  return {
    store,
    runtime,
    invoke,
    query,
    stop,
    get opens() {
      return opens;
    },
    get stops() {
      return stops;
    },
    get wire() {
      return wire;
    },
    async close() {
      try {
        await runtime.close();
        await lifecycle.close();
      } finally {
        peer.stop(true);
        await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

for (const mode of ['connect-stop', 'reconnect'] as const)
  test(`more than 512 confirmed completed MCP ${mode} lifetimes retain original cold proof and continue admitting new work`, async () => {
    const f = await fixture();
    try {
      let carrier = await f.invoke('first', 'mcp.connect', { serverId: 'local', key: 'first' });
      const originalId = carrier.id;
      let current = await f.query(carrier.id, 'first');
      const firstReady = structuredClone(current.ready);
      const firstRef = current.operationRef as unknown as OperationRef;
      let currentKey = 'first';
      for (let index = 0; index < 513; index++) {
        const key = `cycle-${index}`;
        if (mode === 'connect-stop') {
          await f.stop(
            (current.operationRef ?? current.newOperationRef) as unknown as OperationRef,
            `stop-${index}`,
          );
          carrier = await f.invoke(key, 'mcp.connect', { serverId: 'local', key });
          current = await f.query(carrier.id, key);
        } else {
          const ref = (current.operationRef ??
            current.newOperationRef) as unknown as McpReconnectionInput['target']['operationRef'];
          const ready = current.ready as Record<string, Json>;
          const input: McpReconnectionInput = {
            serverId: 'local',
            key,
            target: {
              carrierExecutionId: carrier.id,
              carrierKey: currentKey,
              operationRef: ref,
              connectionExecutionId: ref.executionId,
              configDigest: String(ready.configDigest),
              currentGeneration: Number(current.currentGeneration),
            },
            replacement: { kind: 'static', expectedConfigDigest: String(ready.configDigest) },
          };
          carrier = await f.invoke(key, 'mcp.reconnect', input as unknown as Json);
          current = await f.query(carrier.id);
        }
        expect(current.live).toBe(true);
        currentKey = key;
      }
      expect(f.opens).toBe(514);
      expect(f.stops).toBe(513);
      const firstTerminal = (await f.store.getExecution(firstRef.executionId!))!;
      expect(firstTerminal.status).toBe('cancelled');
      const beforeWire = f.wire;
      const historical = await f.query(originalId, 'first');
      expect(historical.ready).toEqual(firstReady);
      expect(historical.live).toBe(false);
      expect(historical.currentGeneration).toBeNull();
      expect(f.wire).toBe(beforeWire);
      expect((await f.store.getExecution(firstRef.executionId!))!.result).toEqual(
        firstTerminal.result,
      );
    } finally {
      await f.close();
    }
  }, 120000);
