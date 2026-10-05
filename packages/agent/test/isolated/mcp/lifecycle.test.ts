import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createMcpLifecycle,
  type McpLifecycleTransportPort,
  mcpLifecycleExtensionId,
} from '../../../src/mcp';
import { selectProfile } from '../../../src/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(withPort = true, beforeOpen?: () => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-lifecycle-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let opens = 0,
    connections = 0,
    calls = 0;
  const modelRequests: Record<string, unknown>[] = [];
  const stops: string[] = [];
  let confirmStop = true;
  let rejectInitialize = false;
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number | string; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') {
        connections++;
        if (rejectInitialize)
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32000, message: 'owned initialize failure' },
          });
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
              description: 'Harmless local result',
              inputSchema: { type: 'object' },
            },
          ],
        };
      else {
        calls++;
        result = { content: [{ type: 'text', text: 'actual remote result' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const port: McpLifecycleTransportPort = {
    async open(binding) {
      opens++;
      const execution = await store.getExecution(binding.executionId);
      expect(execution?.kind).toBe('job');
      expect(execution?.status).toBe('dispatching');
      const command = await store.getCommand(execution!.originCommandId);
      expect((command!.receipt as { executionId: string }).executionId).toBe(binding.executionId);
      await beforeOpen?.();
      let ended!: (value: { supervision: 'ended' }) => void;
      const stopped = new Promise<{ supervision: 'ended' }>((resolve) => {
        ended = resolve;
      });
      const transport = new StreamableHTTPClientTransport(network.url);
      const close = transport.close.bind(transport);
      transport.close = async () => {
        await close();
        ended({ supervision: 'ended' });
      };
      return {
        transport,
        stopped,
        async stop() {
          stops.push(binding.sessionId);
          if (!confirmStop) return { status: 'unknown' };
          await transport.close();
          return { status: 'stopped' };
        },
      };
    },
  };
  const servers = [{ id: 'local', transport: { type: 'http' as const, url: network.url.href } }];
  const lifecycle = createMcpLifecycle({ servers, ...(withPort ? { transportPort: port } : {}) });
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      modelRequests.push(body);
      const text = JSON.stringify(body.messages);
      const route = text.includes('use-b')
        ? 'use-b'
        : text.includes('connect-b')
          ? 'connect-b'
          : 'connect-a';
      const step = steps.get(route) ?? 0;
      steps.set(route, step + 1);
      const tools = body.tools as { function: { name: string } }[];
      const remote = tools.find((tool) => tool.function.name.startsWith('mcp.local.'))?.function
        .name;
      const tool =
        step === 0 && route !== 'use-b'
          ? { name: 'mcp.connect', input: { serverId: 'local', key: 'first' } }
          : (step === 1 && route !== 'use-b') || (step === 0 && route === 'use-b')
            ? remote
              ? { name: remote, input: {} }
              : null
            : null;
      const chunk = {
        id: 'local',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${modelRequests.length}`,
                      type: 'function',
                      function: { name: tool.name, arguments: JSON.stringify(tool.input) },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const model = createSdkModelAdapter({
    models: new Map([
      [
        'local',
        createCompatibleModelBinding({ baseURL: `${provider.url.href}v1`, modelId: 'local' }),
      ],
    ]),
  });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'local',
    extensions: [lifecycle.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'explicit-local-fixture' };
      },
    },
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'local',
      toolIds: ['mcp.connect'],
      snapshot: {},
      readStepCapabilities: async (input) => {
        const value = await lifecycle.readStepCapabilities(input);
        return { ...value, toolIds: ['mcp.connect', ...value.toolIds] };
      },
    }),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${root}`,
  });
  for (const sessionId of ['a', 'b'])
    await runtime.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: sessionId,
      subjectId: 'user',
    });
  return {
    root,
    profile,
    store,
    runtime,
    lifecycle,
    servers,
    port,
    expectedStoreId,
    modelRequests,
    stops,
    rejectInitialize(value: boolean) {
      rejectInitialize = value;
    },
    get confirmStop() {
      return confirmStop;
    },
    set confirmStop(value: boolean) {
      confirmStop = value;
    },
    get opens() {
      return opens;
    },
    get connections() {
      return connections;
    },
    get calls() {
      return calls;
    },
    async run(sessionId: string, commandId: string, content = commandId) {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId,
        subjectId: 'user',
        commandId,
        request: { kind: 'run.start', content },
      });
      return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    },
    async close() {
      await runtime.close();
      await lifecycle.close();
      provider.stop(true);
      network.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('durable connection Job precedes network; next actual compatible Model sees cached remote definitions and catalogue Query performs no I/O', async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.lifecycle.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'a' },
        })
      ).toolIds,
    ).toEqual([]);
    expect(f.opens).toBe(0);
    const command = await f.run('a', 'connect-a');
    expect(command.status).toBe('applied');
    expect(f.connections).toBe(1);
    expect(f.calls).toBe(1);
    expect(f.modelRequests[0]!.tools as unknown[]).toHaveLength(1);
    expect(JSON.stringify(f.modelRequests[1]!.tools)).toContain('mcp.local.');
    const execution = (await f.store.listExecutions('a')).find((item) =>
      item.definitionId.startsWith('mcp.local.'),
    )!;
    expect(execution.status).toBe('succeeded');
    expect(execution.definitionVersion).toHaveLength(64);
    const before = {
      opens: f.opens,
      connections: f.connections,
      calls: f.calls,
      cursor: (await f.store.getMetadata()).lastChangeCursor,
    };
    const views = await f.runtime.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: mcpLifecycleExtensionId,
      queryId: 'mcp.catalogue',
      input: {},
    });
    expect(JSON.stringify(views)).toContain(f.expectedStoreId);
    expect(await f.run('a', 'connect-a')).toEqual(command);
    expect({
      opens: f.opens,
      connections: f.connections,
      calls: f.calls,
      cursor: (await f.store.getMetadata()).lastChangeCursor,
    }).toEqual(before);
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        (
          await readonly.getExtensionRecord({
            sessionId: 'a',
            extensionId: mcpLifecycleExtensionId,
            key: 'connection/local/first',
          })
        )?.originStoreId,
      ).toBe(f.expectedStoreId);
    } finally {
      await readonly.close();
    }
    const cold = createMcpLifecycle({ servers: f.servers });
    expect(
      (
        await cold.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'a' },
        })
      ).toolIds,
    ).toEqual([]);
    expect(f.connections).toBe(1);
    await cold.close();
  } finally {
    await f.close();
  }
}, 15000);

test('connection Job cancellation is exact per Session and leaves another Session cached connection usable', async () => {
  const f = await fixture();
  try {
    await f.run('a', 'connect-a');
    await f.run('b', 'connect-b');
    expect(f.connections).toBe(2);
    expect(f.calls).toBe(2);
    const record = (await f.store.getExtensionRecord({
      sessionId: 'a',
      extensionId: mcpLifecycleExtensionId,
      key: 'connection/local/first',
    }))!;
    const ref = (record.value as { operationRef: { executionId: string } }).operationRef;
    await f.runtime.cancelExecution({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      commandId: 'stop-a',
      executionId: ref.executionId,
    });
    const deadline = Date.now() + 5000;
    while ((await f.store.getExecution(ref.executionId))!.status !== 'cancelled') {
      if (Date.now() > deadline) throw new Error('connection_cancel_deadline');
      await Bun.sleep(5);
    }
    expect(f.stops).toEqual(['a']);
    expect(
      (
        await f.lifecycle.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'a' },
        })
      ).toolIds,
    ).toEqual([]);
    expect(
      (
        await f.lifecycle.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'b' },
        })
      ).toolIds,
    ).toHaveLength(1);
    await f.run('b', 'use-b');
    expect(f.connections).toBe(2);
    expect(f.calls).toBe(3);
  } finally {
    await f.close();
  }
}, 15000);

test('missing trusted transport stays locally unavailable without starting a connection Job or network', async () => {
  const f = await fixture(false);
  try {
    await f.run('a', 'connect-a');
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect(f.calls).toBe(0);
    expect((await f.store.listExecutions('a')).filter((item) => item.kind === 'job')).toEqual([]);
    expect(
      JSON.stringify(
        (await f.store.listExecutions('a')).find((item) => item.definitionId === 'mcp.connect')!
          .result,
      ),
    ).toContain('mcp_transport_unavailable');
  } finally {
    await f.close();
  }
}, 15000);

test('readonly Runtime reopen exposes saved catalogue without live restoration; original key cannot reconnect in a new process scope', async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof createRuntime> | undefined;
  let cold: ReturnType<typeof createMcpLifecycle> | undefined;
  try {
    await f.run('a', 'connect-a');
    await f.runtime.close();
    const before = { opens: f.opens, connections: f.connections, calls: f.calls };
    cold = createMcpLifecycle({ servers: f.servers, transportPort: f.port });
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    reopened = createRuntime({
      store: readonly,
      extensions: [cold.extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'history-only' };
        },
      },
    });
    const views = await reopened.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: mcpLifecycleExtensionId,
      queryId: 'mcp.catalogue',
      input: {},
    });
    expect(views).toHaveLength(1);
    expect((views[0]!.payload as { items: { live: boolean }[] }).items[0]!.live).toBe(false);
    expect(
      (
        await cold.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'a' },
        })
      ).toolIds,
    ).toEqual([]);
    await reopened.close();
    reopened = undefined;
    const writable = await openSqliteStore(f.profile);
    reopened = createRuntime({
      store: writable,
      extensions: [cold.extension],
      model: createFixedModel([
        [
          {
            type: 'tool_call',
            id: 'retry',
            name: 'mcp.connect',
            arguments: '{"serverId":"local","key":"first"}',
          },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'explicit-test' };
        },
      },
    });
    await reopened.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'cold-retry',
      request: { kind: 'run.start', content: 'Original key is historical, never reconnect it' },
    });
    await reopened.waitForCommand('cold-retry', { timeoutMs: 5000 });
    const retry = (await writable.listExecutions('a')).find(
      (item) => item.originCommandId === 'cold-retry' && item.definitionId === 'mcp.connect',
    )!;
    expect(JSON.stringify(retry.result)).toContain('mcp_historical_connection_unavailable');
    expect({ opens: f.opens, connections: f.connections, calls: f.calls }).toEqual(before);
    expect(
      (await writable.listExecutions('a')).filter((item) =>
        item.definitionId.startsWith('mcp.connection.'),
      ),
    ).toHaveLength(1);
  } finally {
    await reopened?.close();
    await cold?.close();
    await f.close();
  }
}, 15000);

test('unconfirmed owned transport stop invalidates future tools without inventing a terminal or remote stop', async () => {
  const f = await fixture();
  try {
    await f.run('a', 'connect-a');
    const record = (await f.store.getExtensionRecord({
      sessionId: 'a',
      extensionId: mcpLifecycleExtensionId,
      key: 'connection/local/first',
    }))!;
    const ref = (record.value as { operationRef: { executionId: string } }).operationRef;
    f.confirmStop = false;
    await f.runtime.cancelExecution({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      commandId: 'stop-unknown',
      executionId: ref.executionId,
    });
    const deadline = Date.now() + 5000;
    while (!f.stops.includes('a')) {
      if (Date.now() > deadline) throw new Error('stop_attempt_deadline');
      await Bun.sleep(5);
    }
    const pending = await f.store.getExecution(ref.executionId);
    expect(pending!.cancelRequestedAt).not.toBeNull();
    expect(pending!.status).toBe('running');
    expect(
      (
        await f.lifecycle.readStepCapabilities({
          command: { originStoreId: f.expectedStoreId },
          session: { id: 'a' },
        })
      ).toolIds,
    ).toEqual([]);
    expect(f.connections).toBe(1);
    f.confirmStop = true;
    await f.lifecycle.close();
    while ((await f.store.getExecution(ref.executionId))!.status === 'running') {
      if (Date.now() > deadline) throw new Error('confirmed_stop_deadline');
      await Bun.sleep(5);
    }
    expect((await f.store.getExecution(ref.executionId))!.result).toMatchObject({
      details: { transportStopped: true, remoteToolStopConfirmed: false },
    });
  } finally {
    f.confirmStop = true;
    await f.close();
  }
}, 15000);

test('idle bootstrap Action uses the same durable connection Job and warm original-key reuse creates no second connection', async () => {
  const f = await fixture();
  try {
    const request = {
      kind: 'extension.invoke' as const,
      extensionId: mcpLifecycleExtensionId,
      actionId: 'mcp.connect',
      definitionVersion: '1',
      input: { serverId: 'local', key: 'idle' },
    };
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'idle-connect',
      request,
    });
    const first = await f.runtime.waitForCommand('idle-connect', { timeoutMs: 5000 });
    expect(first.status).toBe('applied');
    expect(f.modelRequests).toHaveLength(0);
    expect(f.connections).toBe(1);
    expect(f.calls).toBe(0);
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'warm-connect',
      request,
    });
    await f.runtime.waitForCommand('warm-connect', { timeoutMs: 5000 });
    expect(f.connections).toBe(1);
    expect(
      (await f.store.listExecutions('a')).filter((item) =>
        item.definitionId.startsWith('mcp.connection.'),
      ),
    ).toHaveLength(1);
    expect(
      (await f.store.getExtensionRecord({
        sessionId: 'a',
        extensionId: mcpLifecycleExtensionId,
        key: 'connection/local/idle',
      }))!.revision,
    ).toBe('1');
  } finally {
    await f.close();
  }
}, 15000);

test('connection leaf refuses a self-reported Store scope without its actual bootstrap staging, before transport open', async () => {
  const f = await fixture();
  try {
    const job = f.lifecycle.extension.jobs![0]!;
    await expect(
      job.start(
        {
          serverId: 'local',
          configDigest: job.version,
          originStoreId: f.expectedStoreId,
          key: 'forged',
          bootstrapId: 'self-reported',
        },
        { sessionId: 'a', executionId: 'not-a-durable-job', signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'mcp_bootstrap_unavailable' });
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect(await f.store.listExecutions('a')).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

test('close during actual dispatched Job open collects the late owned handle without publishing a ready catalogue', async () => {
  for (const confirmation of [true, false]) {
    let entered!: () => void;
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(true, async () => {
      entered();
      await gate;
    });
    f.confirmStop = confirmation;
    let work: Promise<unknown> | undefined;
    try {
      work = f.run('a', 'close-opening');
      await opening;
      const job = (await f.store.listExecutions('a')).find(
        (execution) => execution.kind === 'job',
      )!;
      expect(job.status).toBe('dispatching');
      expect(f.connections).toBe(0);
      const closing = f.lifecycle.close();
      expect(
        (
          await f.lifecycle.readStepCapabilities({
            command: { originStoreId: f.expectedStoreId },
            session: { id: 'a' },
          })
        ).toolIds,
      ).toEqual([]);
      release();
      await closing;
      await work;
      expect(f.stops).toContain('a');
      expect(f.calls).toBe(0);
      expect(
        (
          await f.lifecycle.readStepCapabilities({
            command: { originStoreId: f.expectedStoreId },
            session: { id: 'a' },
          })
        ).extensions,
      ).toEqual([]);
      if (!confirmation) {
        const pending = await f.store.getExecution(job.id);
        expect(pending!.status).toBe('running');
        expect(pending!.result).toBeNull();
        expect(
          (
            await f.lifecycle.readStepCapabilities({
              command: { originStoreId: f.expectedStoreId },
              session: { id: 'a' },
            })
          ).toolIds,
        ).toEqual([]);
        f.confirmStop = true;
        await f.lifecycle.close();
      }
      const deadline = Date.now() + 5000;
      let terminal = await f.store.getExecution(job.id);
      while (terminal!.status === 'dispatching' || terminal!.status === 'running') {
        if (Date.now() > deadline) throw new Error('late_handle_terminal_deadline');
        await Bun.sleep(5);
        terminal = await f.store.getExecution(job.id);
      }
      expect(terminal!.status).toBe('failed');
      expect(terminal!.result).toMatchObject({
        details: { transportStopped: true, remoteToolStopConfirmed: false },
      });
      const query = await f.runtime.queryExtension({
        sessionId: 'a',
        subjectId: 'user',
        extensionId: mcpLifecycleExtensionId,
        queryId: 'mcp.catalogue',
        input: {},
      });
      expect(JSON.stringify(query)).not.toContain('"live":true');
      expect(
        await f.store.getExtensionRecord({
          sessionId: 'a',
          extensionId: mcpLifecycleExtensionId,
          key: 'connection/local/first',
        }),
      ).toBeNull();
    } finally {
      release();
      await work?.catch(() => {});
      f.confirmStop = true;
      await f.close();
    }
  }
}, 15000);

for (const corruptParent of [false, true])
  test(`ordinary failed opening releases only its committed stopped Job proof (${corruptParent ? 'corrupt original parent refused' : 'exact original identity'})`, async () => {
    const f = await fixture();
    const finish = f.store.finishExecution.bind(f.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldId: string | undefined;
    const until = async <T>(read: () => Promise<T | null>): Promise<T> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const result = await read();
        if (result !== null) return result;
        if (Date.now() > deadline) throw Error('owned_stopped_opening_deadline');
        await Bun.sleep(5);
      }
    };
    const invoke = async (id: string, sessionId = 'a') => {
      await f.runtime.submitCommand({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'user',
        sessionId,
        commandId: id,
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp',
          actionId: 'mcp.connect',
          definitionVersion: '1',
          input: { serverId: 'local', key: id },
        },
      });
      return until(async () => {
        const command = await f.store.getCommand(id);
        const receipt = command?.receipt as { executionId?: string } | null;
        const e = receipt?.executionId ? await f.store.getExecution(receipt.executionId) : null;
        return e && ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status)
          ? e
          : null;
      });
    };
    f.store.finishExecution = async (input) => {
      const own = await f.store.getExecution(input.executionId);
      if (!heldId && own?.definitionId === 'mcp.connection.local' && own.sessionId === 'a') {
        heldId = own.id;
        await gate; // Real transport has stopped; deliberately delay only its original SQL terminal commit.
      }
      return finish(input);
    };
    let corruption: Database | undefined;
    try {
      f.rejectInitialize(true);
      f.confirmStop = false;
      const original = await invoke('failed-opening');
      expect(original.status).toBe('failed');
      const child = (await f.store.listExecutions('a')).find(
        (e) => e.parentExecutionId === original.id,
      )!;
      expect(child.definitionId).toBe('mcp.connection.local');
      expect(child.status).toBe('running');
      const initialOpens = f.opens;
      const blockedUnknown = await invoke('unknown-stop');
      expect(blockedUnknown.status).toBe('failed');
      expect(f.opens).toBe(initialOpens);
      f.confirmStop = true;
      await f.runtime.cancelExecution({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'user',
        sessionId: 'a',
        commandId: 'stop-original',
        executionId: child.id,
      });
      await until(async () => (heldId === child.id ? child.id : null));
      const pending = await f.store.getExecution(child.id);
      expect(['dispatching', 'running']).toContain(pending!.status);
      expect(pending!.result).toBeNull();
      const blockedCommit = await invoke('before-terminal-commit');
      expect(blockedCommit.status).toBe('failed');
      expect(f.opens).toBe(initialOpens);
      f.rejectInitialize(false);
      const independent = await invoke('independent-session', 'b');
      expect(independent.status).toBe('succeeded');
      expect(f.opens).toBe(initialOpens + 1);
      release();
      const terminal = await until(async () => {
        const e = await f.store.getExecution(child.id);
        return e && ['failed', 'cancelled', 'succeeded'].includes(e.status) ? e : null;
      });
      expect(terminal.result).toMatchObject({
        details: { transportStopped: true, remoteToolStopConfirmed: false },
      });
      expect(terminal.parentExecutionId).toBe(original.id);
      if (corruptParent) {
        // Explicit owned-SQLite corruption: preserve the real stopped result but break original parent identity.
        corruption = new Database(selectProfile(f.profile).databasePath);
        corruption
          .query('UPDATE execution SET parent_execution_id = ? WHERE id = ?')
          .run(independent.id, child.id);
        expect((await f.store.getExecution(child.id))!.parentExecutionId).toBe(independent.id);
        const refused = await invoke('corrupt-proof');
        expect(refused.status).toBe('failed');
        expect(f.opens).toBe(initialOpens + 1);
        corruption
          .query('UPDATE execution SET parent_execution_id = ? WHERE id = ?')
          .run(original.id, child.id);
      }
      const next = await invoke('exact-stopped-new-key');
      expect(next.status).toBe('succeeded');
      expect(f.opens).toBe(initialOpens + 2);
      expect(f.calls).toBe(0);
    } finally {
      release();
      f.confirmStop = true;
      f.store.finishExecution = finish;
      corruption?.close();
      await f.close();
    }
  }, 30000);
