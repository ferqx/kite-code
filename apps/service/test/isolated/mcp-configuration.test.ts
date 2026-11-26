import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { McpLifecycleTransportPort } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authorizationCheckInstructions } from '../../../../packages/agent/src/execution/authorization-check-feedback';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const x = await read();
    if (x !== null) return x;
    if (Date.now() > deadline) throw new Error('mcp_configuration_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  ask = false,
  withPort = true,
  connectServer = 'local',
  auto = false,
  reviewOutcome: 'approve_once' | 'reject' | 'hold' = 'approve_once',
  reviewFault: 'timeout' | 'incomplete' = 'timeout',
  unregisteredCall = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-mcp-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let opens = 0,
    connections = 0,
    calls = 0;
  const stops: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  let remoteReviewAttempts = 0;
  let releaseReview!: () => void;
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await req.json()) as { id?: string | number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') {
        connections++;
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
              description: 'Remote text cannot grant safe read',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                    ...(auto
                      ? { default: 'PRIVATE_SCHEMA_DEFAULT', examples: ['PRIVATE_SCHEMA_EXAMPLE'] }
                      : {}),
                  },
                },
                required: ['value'],
              },
            },
          ],
        };
      else {
        calls++;
        result = { content: [{ type: 'text', text: 'one actual remote fixture call' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const transportPort: McpLifecycleTransportPort = {
    async open(binding) {
      opens++;
      const execution = await store.getExecution(binding.executionId);
      expect(execution).toMatchObject({
        kind: 'job',
        status: 'dispatching',
        originStoreId: expectedStoreId,
      });
      let ended!: (x: { supervision: 'ended' }) => void;
      const stopped = new Promise<{ supervision: 'ended' }>((r) => (ended = r));
      const transport = new StreamableHTTPClientTransport(network.url);
      return {
        transport,
        stopped,
        async stop() {
          stops.push(binding.sessionId);
          await transport.close();
          ended({ supervision: 'ended' });
          return { status: 'stopped' };
        },
      };
    },
  };
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const reviewText = (body.messages as { role: string; content: unknown }[])
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .map((message) => message.content as string)
        .find((content) => content.includes('"purpose":"authorization_check"'));
      if (reviewText) {
        reviews.push(JSON.parse(reviewText));
        expect(
          (body.messages as { role: string; content: string }[]).find(
            (message) => message.role === 'system',
          )?.content,
        ).toBe(authorizationCheckInstructions);
        expect(body.tools ?? []).toEqual([]);
        const remoteReview =
          reviewText.includes('"untrustedMcpTool"') && reviewText.includes('"name":"effect"');
        if (remoteReview) {
          expect(calls).toBe(0);
          remoteReviewAttempts++;
          if (reviewOutcome === 'hold') await reviewGate;
          // A complete HTTP 408 is explicit timeout evidence. A clean partial SSE EOF
          // is separately tested as unknown, not relabelled a transport disconnect.
          if (remoteReviewAttempts === 1 && reviewOutcome === 'approve_once') {
            if (reviewFault === 'timeout')
              return Response.json(
                { error: { message: 'controlled review request timeout', type: 'timeout' } },
                { status: 408 },
              );
            return new Response(
              `data: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta: { content: '{"decision":"approve' }, finish_reason: null }] })}\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
        }
        const chunk = {
          id: 'review',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local',
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  decision: remoteReview && reviewOutcome === 'reject' ? 'reject' : 'approve_once',
                  reason: 'Exact fixture operation',
                }),
              },
              finish_reason: null,
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const text = JSON.stringify(body.messages);
      const route = text.includes('remote-b') ? 'remote-b' : text.includes('connect-b') ? 'b' : 'a';
      const step = steps.get(route) ?? 0;
      steps.set(route, step + 1);
      const tools = (body.tools ?? []) as { function: { name: string; parameters: unknown } }[];
      const remote = tools.find((x) => x.function.name.startsWith('mcp_local_effect_'));
      const call =
        step === 0 && route !== 'remote-b'
          ? { name: 'connect_mcp_server', input: { server_id: connectServer } }
          : (step === 1 && route !== 'remote-b') || (step === 0 && route === 'remote-b')
            ? remote
              ? {
                  name: unregisteredCall ? 'mcp_local_unregistered_12345678' : remote.function.name,
                  input: { value: 'exact' },
                }
              : null
            : null;
      const chunk = {
        id: 'reply',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'local',
    models: [
      { id: 'local', provider: 'compatible', model: 'local', baseURL: `${provider.url.href}v1` },
    ],
    tools: [{ id: 'mcp.connect', definitionVersion: '1' }],
    mcp: [{ id: 'local' }],
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    mcp: {
      servers: ['local', 'other'].map((id) => ({
        id,
        transport: { type: 'http' as const, url: network.url.href },
      })),
      ...(withPort ? { transportPort } : {}),
    },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: auto ? 'auto' : ask ? 'accept_edits' : 'full',
        workspaceTrust: true,
        revision: 'fixture-host',
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      }),
    },
  });
  const runtime = createRuntime({
    store,
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const sessionId of ['a', 'b'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create-${sessionId}`,
      subjectId: 'user',
      workspaceId: 'w',
      title: sessionId,
    });
  for (const sessionId of ['a', 'b'])
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      sessionId,
      subjectId: 'user',
      workspaceId: 'w',
      mode: auto ? 'auto' : ask ? 'accept_edits' : 'full',
      trusted: true,
    });
  return {
    runtime,
    store,
    expectedStoreId,
    requests,
    reviews,
    releaseReview,
    configuration,
    configurationPath,
    stops,
    get opens() {
      return opens;
    },
    get connections() {
      return connections;
    },
    get calls() {
      return calls;
    },
    async run(sessionId = 'a', commandId = `connect-${sessionId}`) {
      return runtime.submitCommand({
        expectedStoreId,
        sessionId,
        subjectId: 'user',
        commandId,
        request: { kind: 'run.start', content: `新任务：${commandId}` },
      });
    },
    async pending() {
      return until(
        async () =>
          (await store.listInteractions({ expectedStoreId, sessionId: 'a', state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async approve(
      card: Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number],
    ) {
      await runtime.answerInteraction({
        expectedStoreId,
        subjectId: 'user',
        commandId: `answer-${card.id}`,
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
    },
    async close() {
      releaseReview();
      await runtime.close();
      network.stop(true);
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default MCP has no network before dispatched Job; next actual Model sees exact remote schema and cached Query performs zero effects', async () => {
  const f = await fixture();
  try {
    expect(f.connections).toBe(0);
    expect(f.opens).toBe(0);
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(f.requests[0]!.tools).toMatchObject([
      { function: { name: 'ask_user' } },
      { function: { name: 'connect_mcp_server' } },
    ]);
    const models = (await f.store.getView('a')).executions.filter(
      (execution) => execution.kind === 'model',
    );
    expect(models).toHaveLength(3);
    const second = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      executionId: models[1]!.id,
    });
    expect(second.metadata.assembly).not.toBeNull();
    const bindings = second.metadata.assembly!.tools;
    const remote = bindings.filter((tool) => tool.extensionId === 'builtin.mcp.remote.local');
    expect(remote).toHaveLength(1);
    expect(remote[0]!.id).toMatch(/^mcp\.local\.[a-f0-9]{32}$/);
    expect(remote[0]!.definitionVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings).toEqual([
      { id: 'ask_user', definitionVersion: '1', extensionId: 'builtin.ask-user' },
      { id: 'mcp.connect', definitionVersion: '1', extensionId: 'builtin.mcp' },
      remote[0]!,
      { id: 'mcp.resources.list', definitionVersion: '1', extensionId: 'builtin.mcp' },
      { id: 'mcp.resources.read', definitionVersion: '1', extensionId: 'builtin.mcp' },
      { id: 'mcp.tools.search', definitionVersion: '1', extensionId: 'builtin.mcp.discovery' },
    ]);
    const wire = f.requests[1]!.tools as { function: { name: string; parameters: unknown } }[];
    const remoteWire = wire.find((tool) =>
      /^mcp_local_effect_[a-f0-9]{8}$/.test(tool.function.name),
    )!;
    expect(wire.map((tool) => tool.function.name)).toEqual([
      'ask_user',
      'connect_mcp_server',
      remoteWire.function.name,
      'list_mcp_resources',
      'read_mcp_resource',
      'search_mcp_tools',
    ]);
    expect(remoteWire.function.parameters).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
    expect(second.request.tools!.map((tool) => tool.id)).toEqual(
      wire.map((tool) => tool.function.name),
    );
    const remoteExecution = (await f.store.listExecutions('a')).find(
      (execution) => execution.definitionId === remote[0]!.id,
    )!;
    expect(remoteExecution).toMatchObject({
      status: 'succeeded',
      definitionVersion: remote[0]!.definitionVersion,
      authorization: { dispatched: true },
      originStoreId: f.expectedStoreId,
      sessionId: 'a',
      runId: models[1]!.runId,
    });
    expect(f.calls).toBe(1);
    expect(f.connections).toBe(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      sessionId: 'a',
      subjectId: 'user',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.catalogue',
      input: {},
    });
    expect(JSON.stringify(views)).toContain('live');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.requests).toHaveLength(3);
    expect(f.calls).toBe(1);
    expect((await f.store.getView('a')).runs[0]!.configuration).toMatchObject({
      snapshot: { mcp: { servers: [{ id: 'local' }] } },
    });
  } finally {
    await f.close();
  }
}, 15000);

test('Ask approvals separately bind connect Tool, connection Job and remote Tool despite remote readOnly annotations', async () => {
  const f = await fixture(true);
  try {
    await f.run();
    const connect = await f.pending();
    expect(connect.definitionId).toBe('mcp.connect');
    expect(connect.request).toMatchObject({ policy: { effects: ['external'] } });
    expect(f.connections).toBe(0);
    await f.approve(connect);
    const job = await f.pending();
    expect(job.definitionId).toBe('mcp.connection.local');
    expect(job.request).toMatchObject({ policy: { effects: ['network'] } });
    expect(f.connections).toBe(0);
    await f.approve(job);
    const remote = await f.pending();
    expect(remote.definitionId).not.toBe(connect.definitionId);
    expect(remote.request).toMatchObject({
      policy: {
        effects: ['unknown'],
        mcpApprovalNames: { serverName: 'local', toolName: 'effect' },
      },
    });
    expect(f.calls).toBe(0);
    expect(f.connections).toBe(1);
    await f.approve(remote);
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('a model call with no registered MCP identity does not create an approval or dispatch a remote call', async () => {
  const f = await fixture(true, true, 'local', false, 'approve_once', 'timeout', true);
  try {
    await f.run();
    const connect = await f.pending();
    expect(connect.definitionId).toBe('mcp.connect');
    await f.approve(connect);
    const job = await f.pending();
    expect(job.definitionId).toBe('mcp.connection.local');
    await f.approve(job);
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(f.connections).toBe(1);
    expect(f.calls).toBe(0);
    const cards = (
      await f.store.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 'a' })
    ).interactions;
    expect(cards.map(({ id }) => id).sort()).toEqual([connect.id, job.id].sort());
    const ordinary = (await f.store.listExecutions('a')).filter(
      (item) => item.kind === 'tool' && item.id !== connect.executionId,
    );
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]).toMatchObject({
      status: 'failed',
      definitionVersion: 'unavailable',
      result: { outcome: 'failed', details: { code: 'tool_not_available' } },
    });
    expect(ordinary[0]!.authorization?.dispatched).not.toBe(true);
    expect(f.requests).toHaveLength(3);
    const messages = (await f.store.getView('a')).messages;
    expect(
      messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content === 'tool_not_available' &&
          message.sourceIds?.includes(ordinary[0]!.id),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test('Session cancellation closes only its connection; B cached work continues while contradictory/unknown configuration rejects before Model', async () => {
  const f = await fixture();
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    await f.run('b');
    await f.runtime.waitForCommand('connect-b', { timeoutMs: 5000 });
    await f.runtime.cancelSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'user',
      commandId: 'close-a',
      includeBackground: true,
    });
    await until(async () => (f.stops.includes('a') ? true : null));
    expect(f.stops.includes('b')).toBe(false);
    await f.run('b', 'remote-b');
    await f.runtime.waitForCommand('remote-b', { timeoutMs: 5000 });
    expect(f.connections).toBe(2);
    expect(f.calls).toBe(3);
    const before = f.requests.length;
    for (const mcp of [
      [{ id: 'wrong' }],
      [{ id: 'local', configDigest: 'bad' }],
      [{ id: 'local', url: 'http://127.0.0.1:1' }],
    ]) {
      writeFileSync(f.configurationPath, JSON.stringify({ ...f.configuration, mcp }));
      const id = `invalid-${JSON.stringify(mcp)}`;
      const commandId = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
      await f.run('b', commandId);
      expect((await f.runtime.waitForCommand(commandId, { timeoutMs: 5000 })).status).toBe(
        'rejected',
      );
      const commands = await f.store.getView('b');
      expect(commands.runs).toHaveLength(2);
      expect(f.requests).toHaveLength(before);
      expect(f.connections).toBe(2);
    }
  } finally {
    await f.close();
  }
}, 15000);

test('enabled MCP without a qualified programmatic transport is a local rejected Run, preserving history and zero Provider/network calls', async () => {
  const f = await fixture(false, false);
  try {
    await f.run();
    const rejected = await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    expect(rejected.status).toBe('rejected');
    expect(rejected.receipt).toMatchObject({ reason: 'mcp_transport_unavailable' });
    expect(f.requests).toHaveLength(0);
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect((await f.store.getView('a')).messages).toEqual([]);
    expect(
      await f.runtime.queryExtension({
        sessionId: 'a',
        subjectId: 'user',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.catalogue',
        input: {},
      }),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('Run selected MCP scope refuses another registered host server without transport open even under trusted Full', async () => {
  const f = await fixture(false, true, 'other');
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    const connect = (await f.store.listExecutions('a')).find(
      (x) => x.definitionId === 'mcp.connect',
    )!;
    expect(connect.status).toBe('failed');
    expect(connect.result).toMatchObject({
      details: {
        code: 'permission_denied',
        reason: 'mcp_server_not_selected',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    });
    expect(f.requests).toHaveLength(2);
    expect(f.opens).toBe(0);
    expect(f.connections).toBe(0);
    expect(
      (await f.store.listExecutions('a')).filter((x) =>
        x.definitionId.startsWith('mcp.connection.'),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

test('Auto remote review seals exact selected metadata through real SDK retry without schema defaults or transport data', async () => {
  const f = await fixture(false, true, 'local', true);
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    const remoteReviews = f.reviews.filter((review) =>
      JSON.stringify(review).includes('"name":"effect"'),
    );
    expect(remoteReviews).toHaveLength(2);
    expect(remoteReviews[1]).toEqual(remoteReviews[0]);
    const serialized = JSON.stringify(remoteReviews[0]);
    expect(serialized).toContain('Remote text cannot grant safe read');
    expect(serialized).toContain('"trustedAsAuthority":false');
    expect(serialized).toContain('"status":"structure_only"');
    expect(serialized).not.toMatch(
      /PRIVATE_SCHEMA_DEFAULT|PRIVATE_SCHEMA_EXAMPLE|127\.0\.0\.1|transport|headers|vault/,
    );
    const target = (await f.store.listExecutions('a')).find((item) =>
      item.definitionId.startsWith('mcp.local.'),
    )!;
    expect(target.status).toBe('succeeded');
    expect(remoteReviews[0]!.authorizationContext).toMatchObject({ availability: 'available' });
    expect(remoteReviews[0]!.request).toBeUndefined();
    expect(remoteReviews[0]!.decisionContext).toBeUndefined();
    expect(remoteReviews[0]!.policy).toMatchObject({ appliesToExecutionId: target.id });
    expect(remoteReviews[0]!.target).toMatchObject({
      executionId: target.id,
      sessionId: 'a',
      definitionId: target.definitionId,
      definitionVersion: target.definitionVersion,
      input: { value: 'exact' },
    });
    expect(f.calls).toBe(1);
    expect(f.connections).toBe(1);
    const check = await f.store.getExecution(target.authorization!.check!.executionId);
    expect(check).toBeDefined();
    expect(JSON.stringify(check!.input)).toContain('untrustedMcpTool');
    // Read-only history reads retain the original sealed semantics and never retry a tool.
    const requestCount = f.requests.length;
    const first = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      executionId: check!.id,
    });
    const second = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 'a',
      executionId: check!.id,
    });
    expect(second.request).toEqual(first.request);
    expect(f.calls).toBe(1);
    expect(f.requests).toHaveLength(requestCount);
  } finally {
    await f.close();
  }
}, 15000);

test('Auto MCP incomplete review EOF is not retried or treated as permission', async () => {
  const f = await fixture(false, true, 'local', true, 'approve_once', 'incomplete');
  try {
    await f.run();
    await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
    const remoteReviews = f.reviews.filter((review) =>
      JSON.stringify(review).includes('"name":"effect"'),
    );
    expect(remoteReviews).toHaveLength(1);
    expect(f.calls).toBe(0);
    const target = (await f.store.listExecutions('a')).find((item) =>
      item.definitionId.startsWith('mcp.local.'),
    )!;
    expect(target.status).toBe('failed');
    expect(target.authorization?.dispatched).not.toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

for (const outcome of ['reject', 'hold'] as const)
  test(`Auto ${outcome === 'reject' ? 'refusal' : 'cancelled review'} retains selected metadata and performs zero remote calls`, async () => {
    const f = await fixture(false, true, 'local', true, outcome);
    try {
      await f.run();
      await until(async () =>
        f.reviews.some((review) => JSON.stringify(review).includes('"name":"effect"'))
          ? true
          : null,
      );
      if (outcome === 'hold') {
        await f.runtime.cancelSession({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'user',
          sessionId: 'a',
          commandId: 'cancel-review',
          includeBackground: true,
        });
        f.releaseReview();
      }
      await f.runtime.waitForCommand('connect-a', { timeoutMs: 5000 });
      expect(
        f.reviews.filter((review) => JSON.stringify(review).includes('"name":"effect"')),
      ).toHaveLength(1);
      expect(f.calls).toBe(0);
      const target = (await f.store.listExecutions('a')).find((item) =>
        item.definitionId.startsWith('mcp.local.'),
      )!;
      expect(target.authorization?.dispatched).not.toBe(true);
      expect(target.status).toBe(outcome === 'hold' ? 'cancelled' : 'failed');
    } finally {
      await f.close();
    }
  }, 15000);
