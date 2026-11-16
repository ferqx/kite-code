import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

async function connectionRecordKey(
  store: Awaited<ReturnType<typeof openSqliteStore>>,
  sessionId: string,
) {
  const intent = await store.getExtensionRecord({
    sessionId,
    extensionId: mcpLifecycleExtensionId,
    key: 'connection-intent/local',
  });
  if (!intent || typeof (intent.value as { key?: string }).key !== 'string')
    throw Error('fixture_connection_intent_missing');
  return `connection/local/${(intent.value as { key: string }).key}`;
}

async function fixture(
  withPort = true,
  beforeOpen?: () => Promise<void>,
  ownedObservation = false,
  options: {
    readyTimeoutMs?: number;
    jobApproval?: boolean;
    scopedSource?: boolean;
    beforeStart?: () => Promise<void>;
  } = {},
) {
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
        ...(ownedObservation
          ? {
              // Exercise the stdio producer's closed observation shape; this HTTP
              // fixture and null process entries do not qualify native supervision.
              readProcessEvidence: () => ({
                version: 2 as const,
                coverage: 'mcp-owned-coalition' as const,
                binding: {
                  originalStoreId: binding.originalStoreId,
                  sessionId: binding.sessionId,
                  executionId: binding.executionId,
                  serverId: binding.serverId,
                  scopeId: binding.scopeId,
                  configDigest: binding.configDigest,
                },
                ownerPid: process.pid,
                broker: null,
                guardian: null,
                server: null,
                coalition: null,
              }),
            }
          : {}),
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
  const lifecycle = createMcpLifecycle({
    servers: options.scopedSource ? [] : servers,
    ...(withPort ? { transportPort: port } : {}),
    readyTimeoutMs: options.readyTimeoutMs,
    ...(options.scopedSource
      ? {
          scopedSources: {
            async resolve() {
              return {
                server: servers[0]!,
                captureDigest: 'a'.repeat(64),
                transportPort: port,
                assertFresh({ signal }: { signal: AbortSignal }) {
                  signal.throwIfAborted();
                },
              };
            },
          },
        }
      : {}),
  });
  if (options.beforeStart) {
    const job = lifecycle.extension.jobs![0]!;
    const start = job.start;
    job.start = async (input, context) => {
      await options.beforeStart!();
      return start(input, context);
    };
  }
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
      const remote = tools.find((tool) => tool.function.name.startsWith('mcp_local_'))?.function
        .name;
      const tool =
        step === 0 && route !== 'use-b'
          ? { name: 'connect_mcp_server', input: { server_id: 'local' } }
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
      async authorize(request) {
        const approval =
          options.jobApproval &&
          ['mcp.source.connection', 'mcp.connection.local'].includes(request.definitionId);
        return {
          allowed: !approval,
          revision: 'explicit-local-fixture',
          ...(approval ? { approval: { request: { title: 'Owned connection approval' } } } : {}),
        };
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
    rootUri: pathToFileURL(root).href,
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
    async run(sessionId: string, commandId: string, content = `New task: ${commandId}`) {
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
      try {
        await runtime.close();
      } finally {
        await lifecycle.close();
        provider.stop(true);
        network.stop(true);
      }
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
    const selected = await f.lifecycle.readStepCapabilities({
      command: { originStoreId: f.expectedStoreId },
      session: { id: 'a' },
      selectedServerIds: ['local'],
    });
    const selectedTool = selected.extensions.flatMap((extension) => extension.tools ?? [])[0]!;
    expect(f.lifecycle.readToolReviewMetadata(selectedTool)).toMatchObject({
      name: 'effect',
      description: 'Harmless local result',
      inputSchema: { type: 'object' },
    });
    expect(f.lifecycle.readToolReviewMetadata({ ...selectedTool })).toBeNull();
    for (const input of [
      { command: { originStoreId: f.expectedStoreId }, session: { id: 'b' } },
      { command: { originStoreId: 'foreign-store' }, session: { id: 'a' } },
      {
        command: { originStoreId: f.expectedStoreId },
        session: { id: 'a' },
        selectedServerIds: ['other'],
      },
    ])
      expect((await f.lifecycle.readStepCapabilities(input)).extensions).toEqual([]);
    expect(f.modelRequests[0]!.tools as unknown[]).toHaveLength(1);
    expect(JSON.stringify(f.modelRequests[1]!.tools)).toContain('mcp_local_');
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
    const status = await f.runtime.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: mcpLifecycleExtensionId,
      queryId: 'mcp.server.status',
      input: {},
    });
    expect(status[0]!.payload).toMatchObject({
      storeId: f.expectedStoreId,
      sessionId: 'a',
      items: [
        {
          serverId: 'local',
          status: 'connected',
          toolCount: 1,
          resourceCount: null,
          promptCount: null,
        },
      ],
    });
    const otherStatus = await f.runtime.queryExtension({
      sessionId: 'b',
      subjectId: 'user',
      extensionId: mcpLifecycleExtensionId,
      queryId: 'mcp.server.status',
      input: {},
    });
    expect(otherStatus[0]!.payload).toMatchObject({
      storeId: f.expectedStoreId,
      sessionId: 'b',
      items: [],
    });
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
            key: await connectionRecordKey(f.store, 'a'),
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
      key: await connectionRecordKey(f.store, 'a'),
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
            name: 'connect_mcp_server',
            arguments: '{"server_id":"local"}',
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
      request: {
        kind: 'run.start',
        content: 'New task: Original key is historical, never reconnect it',
      },
    });
    const command = await reopened.waitForCommand('cold-retry', { timeoutMs: 5000 });
    const receipt = command.receipt as { runId: string; businessCommandId?: string };
    const run = (await writable.getRun(receipt.runId))!;
    expect(run.originCommandId).toBe(receipt.businessCommandId ?? command.id);
    const retry = (await writable.listExecutions('a')).find(
      (item) =>
        item.runId === run.id &&
        item.originCommandId === run.originCommandId &&
        item.definitionId === 'mcp.connect',
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
      key: await connectionRecordKey(f.store, 'a'),
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
      const openingStatus = await f.runtime.queryExtension({
        sessionId: 'a',
        subjectId: 'user',
        extensionId: mcpLifecycleExtensionId,
        queryId: 'mcp.server.status',
        input: {},
      });
      expect(openingStatus[0]!.payload).toMatchObject({
        storeId: f.expectedStoreId,
        sessionId: 'a',
        items: [
          {
            executionId: job.id,
            serverId: 'local',
            status: 'connecting',
            toolCount: null,
            resourceCount: null,
            promptCount: null,
          },
        ],
      });
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
          key: await connectionRecordKey(f.store, 'a'),
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
    const f = await fixture(true, undefined, true);
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
      const originalFact = async () =>
        (
          await f.runtime.queryExtension({
            sessionId: 'a',
            subjectId: 'user',
            extensionId: mcpLifecycleExtensionId,
            queryId: 'mcp.connection',
            input: { executionId: original.id, serverId: 'local', key: 'failed-opening' },
          })
        )[0]!.payload as { phase: string; ready: unknown; live: boolean };
      expect((await originalFact()).phase).toBe('outcome_unknown');
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
      expect((await originalFact()).phase).toBe('outcome_unknown');
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
      expect(terminal.result).toMatchObject({
        details: {
          ownedProcesses: {
            binding: {
              originalStoreId: f.expectedStoreId,
              sessionId: 'a',
              executionId: child.id,
              serverId: 'local',
              scopeId: JSON.stringify([f.expectedStoreId, 'a', 'local']),
              configDigest: child.definitionVersion,
            },
          },
        },
      });
      expect(terminal.parentExecutionId).toBe(original.id);
      expect(await originalFact()).toMatchObject({ phase: 'failed', ready: null, live: false });
      if (corruptParent) {
        // Explicit owned-SQLite corruption: preserve the real stopped result but break original parent identity.
        corruption = new Database(selectProfile(f.profile).databasePath);
        // The Worker can still commit another owned Job after the observed Tool terminal.
        // Wait only for SQLite's write lock; never retry the business connection or change IDs.
        corruption.exec('PRAGMA busy_timeout = 1000');
        corruption
          .query('UPDATE execution SET parent_execution_id = ? WHERE id = ?')
          .run(independent.id, child.id);
        expect((await f.store.getExecution(child.id))!.parentExecutionId).toBe(independent.id);
        const refused = await invoke('corrupt-proof');
        expect(refused.status).toBe('failed');
        expect(f.opens).toBe(initialOpens + 1);
        expect((await originalFact()).phase).toBe('outcome_unknown');
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

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw Error('original_connection_fact_deadline');
    await Bun.sleep(5);
  }
}
const connectionApproval = (f: Awaited<ReturnType<typeof fixture>>) =>
  eventually(
    async () =>
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions[0] ?? null,
  );
const answerConnection = (
  f: Awaited<ReturnType<typeof fixture>>,
  card: Awaited<ReturnType<typeof connectionApproval>>,
  decision: 'approve' | 'deny',
) =>
  f.runtime.answerInteraction({
    expectedStoreId: f.expectedStoreId,
    subjectId: 'user',
    commandId: `answer-${decision}-${card.id}`,
    presentationSessionId: card.presentationSessionId,
    interactionId: card.id,
    expectedRevision: card.revision,
    answer:
      decision === 'approve'
        ? { kind: 'approval', decision, optionId: 'once' }
        : { kind: 'approval', decision },
  });

for (const scopedSource of [false, true])
  test(`connection startup budget excludes delayed ordinary Job approval (${scopedSource ? 'source' : 'static'})`, async () => {
    const f = await fixture(true, undefined, false, {
      scopedSource,
      jobApproval: true,
      readyTimeoutMs: 500,
    });
    let work: ReturnType<typeof f.run> | undefined;
    try {
      work = f.run('a', 'connect-a');
      const card = await connectionApproval(f);
      const job = (await f.store.getExecution(card.executionId))!;
      const parent = (await f.store.getExecution(job.parentExecutionId!))!;
      expect(job.runId).toBeNull();
      expect(parent.runId).not.toBeNull();
      await Bun.sleep(800);
      expect((await f.store.getExecution(parent.id))!.status).toBe('dispatching');
      expect((await f.store.getExecution(job.id))!.status).toBe('planned');
      expect((await connectionApproval(f)).id).toBe(card.id);
      expect(f.opens).toBe(0);
      expect(f.connections).toBe(0);
      await answerConnection(f, card, 'approve');
      await work;
      expect((await f.store.getExecution(parent.id))!.status).toBe('succeeded');
      expect((await f.store.getExecution(job.id))!.status).toBe('running');
      expect(f.opens).toBe(1);
      expect(f.calls).toBe(1);
    } finally {
      await f.close();
      await work?.catch(() => {});
    }
  }, 15000);

for (const action of ['deny', 'cancel'] as const)
  test(`pending connection approval ${action} settles the original without open or replay`, async () => {
    const f = await fixture(true, undefined, false, {
      scopedSource: true,
      jobApproval: true,
      readyTimeoutMs: 100,
    });
    let work: ReturnType<typeof f.run> | undefined;
    try {
      work = f.run('a', 'connect-a');
      const card = await connectionApproval(f);
      const job = (await f.store.getExecution(card.executionId))!;
      await Bun.sleep(180);
      if (action === 'deny') await answerConnection(f, card, 'deny');
      else
        await f.runtime.cancelCommand({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'user',
          sessionId: 'a',
          commandId: 'stop-original',
          targetCommandId: 'connect-a',
        });
      await work;
      const terminal = await eventually(async () => {
        const e = (await f.store.getExecution(job.id))!;
        return ['failed', 'cancelled'].includes(e.status) ? e : null;
      });
      expect(terminal.result).toMatchObject({ details: { adapterAttempted: false } });
      expect(f.opens).toBe(0);
      expect(f.connections).toBe(0);
      expect(f.calls).toBe(0);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'a',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
      if (action === 'deny') {
        let rejected: unknown;
        try {
          await answerConnection(f, card, 'approve');
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ code: 'interaction_answer_conflict' });
      } else
        expect((await answerConnection(f, card, 'approve')).receipt).toMatchObject({
          cancelled: true,
        });
      expect(f.opens).toBe(0);
    } finally {
      await f.close();
      await work?.catch(() => {});
    }
  }, 15000);

for (const confirmStop of [true, false])
  test(`startup timeout collects a late handle without ready or replay (${confirmStop ? 'confirmed' : 'initially unknown'} stop)`, async () => {
    let entered!: () => void, release!: () => void;
    const opening = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(
      true,
      async () => {
        entered();
        await gate;
      },
      false,
      {
        scopedSource: true,
        readyTimeoutMs: 100,
      },
    );
    f.confirmStop = confirmStop;
    let work: ReturnType<typeof f.run> | undefined;
    try {
      work = f.run('a', 'connect-a');
      await opening;
      const parent = await eventually(
        async () =>
          (await f.store.listExecutions('a')).find(
            (e) => e.definitionId === 'mcp.connect' && e.status === 'failed',
          ) ?? null,
      );
      expect(parent.result).toMatchObject({
        content: 'mcp_ready_timeout',
        details: { stopConfirmed: false },
      });
      const job = (await f.store.listExecutions('a')).find(
        (e) => e.parentExecutionId === parent.id,
      )!;
      expect(f.opens).toBe(1);
      expect(f.connections).toBe(0);
      release();
      await work;
      await eventually(async () => (f.stops.length ? true : null));
      if (!confirmStop) {
        const pending = (await f.store.getExecution(job.id))!;
        expect(['dispatching', 'running']).toContain(pending.status);
        expect(pending.result).toBeNull();
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
      const terminal = await eventually(async () => {
        const e = (await f.store.getExecution(job.id))!;
        return ['failed', 'cancelled'].includes(e.status) ? e : null;
      });
      expect(terminal.result).toMatchObject({
        details: { transportStopped: true, remoteToolStopConfirmed: false },
      });
      expect(f.stops).toContain('a');
      expect(f.opens).toBe(1);
      expect(f.connections).toBe(0);
      expect(
        (
          await f.lifecycle.readStepCapabilities({
            command: { originStoreId: f.expectedStoreId },
            session: { id: 'a' },
          })
        ).toolIds,
      ).toEqual([]);
    } finally {
      release();
      f.confirmStop = true;
      await f.close();
      await work?.catch(() => {});
    }
  }, 15000);

for (const corruptRootWork of [false, true])
  test(`late admitted detached Job proves unopened only with exact lineage (${corruptRootWork ? 'corrupt' : 'original'})`, async () => {
    let entered!: () => void, release!: () => void;
    const starting = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(true, undefined, false, {
      scopedSource: true,
      beforeStart: async () => {
        entered();
        await gate;
      },
    });
    let work: ReturnType<typeof f.run> | undefined;
    let db: Database | undefined;
    let jobId: string | undefined;
    try {
      work = f.run('a', 'connect-a');
      await starting;
      const job = (await f.store.listExecutions('a')).find(
        (e) => e.definitionId === 'mcp.source.connection',
      )!;
      jobId = job.id;
      const parent = (await f.store.getExecution(job.parentExecutionId!))!;
      expect(parent.runId).not.toBeNull();
      expect(job.runId).toBeNull();
      // The owned factory closes while Core has admitted start but no port exists.
      // Retain the delayed original start, not a new request or a new connection.
      await f.lifecycle.close();
      if (corruptRootWork) {
        db = new Database(selectProfile(f.profile).databasePath);
        db.exec('PRAGMA busy_timeout = 1000');
        db.query('UPDATE execution SET root_work_seq = root_work_seq + 1 WHERE id = ?').run(job.id);
      }
      release();
      await work;
      const terminal = await eventually(async () => {
        const e = (await f.store.getExecution(job.id))!;
        return ['failed', 'cancelled', 'outcome_unknown'].includes(e.status) ? e : null;
      });
      expect(terminal.status).toBe(corruptRootWork ? 'outcome_unknown' : 'failed');
      if (!corruptRootWork)
        expect(terminal.result).toMatchObject({
          details: { transportStopped: true, remoteToolStopConfirmed: false },
        });
      else expect(terminal.result).not.toMatchObject({ details: { transportStopped: true } });
      expect(f.opens).toBe(0);
      expect(f.connections).toBe(0);
    } finally {
      if (db && jobId)
        db.query('UPDATE execution SET root_work_seq = root_work_seq - 1 WHERE id = ?').run(jobId);
      db?.close();
      release();
      if (corruptRootWork) {
        await expect(f.close()).rejects.toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
        await f.store.close();
      } else await f.close();
      await work?.catch(() => {});
    }
  }, 15000);
