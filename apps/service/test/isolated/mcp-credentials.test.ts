import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import {
  createMcpCredentialBroker,
  createMcpLifecycle,
  type McpCredentialRef,
} from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { InteractionRecord } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';

function gate() {
  let release!: () => void, entered!: () => void;
  return {
    wait: new Promise<void>((resolve) => (release = resolve)),
    seen: new Promise<void>((resolve) => (entered = resolve)),
    release: () => release(),
    enter: () => entered(),
  };
}
async function fixture(injectAfterUnknown = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-broker-'))),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'temporary' }),
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
    metadata = await store.getMetadata();
  await store.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'temporary',
  });
  for (const id of ['a', 'b'])
    await store.createSession({
      expectedStoreId: metadata.storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      subjectId: 'owner',
      title: id,
    });
  let requests = 0,
    calls = 0,
    lookups = 0,
    allow = true,
    awaitingApproval = false,
    now = Date.now(),
    mode: 'normal' | 'scope' | 'expired' | 'revoked' | 'purpose' = 'normal';
  let lookupGate: ReturnType<typeof gate> | undefined,
    requestGate: ReturnType<typeof gate> | undefined;
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    requests++;
    received.push(req.headers.authorization ?? '');
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const rpc = JSON.parse(Buffer.concat(parts).toString()) as { id?: number; method: string };
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'local', version: '1' },
        capabilities: { tools: {} },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [{ name: 'effect', inputSchema: { type: 'object', additionalProperties: false } }],
      };
    else {
      calls++;
      const hold = requestGate;
      if (hold) {
        hold.enter();
        await hold.wait;
      }
      result = { content: [{ type: 'text', text: 'physical request completed' }] };
    }
    if (!res.destroyed)
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://broker-fixture.invalid:${(server.address() as { port: number }).port}/mcp`;
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    secret = `private-fixture-${crypto.randomUUID()}`,
    stored = await vault.put(secret),
    refs = new Map<string, McpCredentialRef>();
  const broker = createMcpCredentialBroker({
    now: () => now,
    vault: {
      resolve: async (ref) => {
        lookups++;
        const hold = lookupGate;
        if (hold) {
          hold.enter();
          await hold.wait;
        }
        return vault.resolve(ref);
      },
    },
  });
  const port = createMcpHttpTransportPort({
    servers: [
      {
        id: 'local',
        url,
        credential: {
          broker,
          async bind(binding) {
            const job = await store.getExecution(binding.executionId);
            expect(job?.status).toBe('dispatching');
            expect(job?.originStoreId).toBe(binding.originalStoreId);
            expect(job?.definitionVersion).toBe(binding.configDigest);
            const session = await store.getSession(binding.sessionId),
              workspace = await store.getWorkspace(session!.workspaceId);
            const identity = {
              profileId: profile.profileAccessKey,
              originalStoreId: job!.originStoreId,
              workspaceId: workspace!.id,
              workspaceIdentity: realpathSync(fileURLToPath(workspace!.rootUri)),
              sessionId: session!.id,
              connectionExecutionId: job!.id,
              source: { kind: 'programmatic' as const, id: 'trusted-host', revision: 'host-1' },
              serverId: binding.serverId,
              configDigest: binding.configDigest,
              authProfileId: 'fixture-profile',
              policyRevision: 'explicit-connection-permission-1',
            };
            const ref = broker.issue({
              credentialRef: stored.id,
              identity,
              purpose: mode === 'purpose' ? ('other' as 'mcp.http') : 'mcp.http',
              expiresAt: now + 60000,
              revocationRevision: 0,
            });
            refs.set(session!.id, ref);
            if (mode === 'revoked') broker.revoke(ref);
            if (mode === 'expired') now += 60000;
            return {
              ref,
              identity: mode === 'scope' ? { ...identity, sessionId: 'other' } : identity,
              revocationRevision: 0,
            };
          },
        },
      },
    ],
    allowLoopbackForTests: true,
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    async admit(binding) {
      const execution = await store.getExecution(binding.executionId);
      if (
        !allow ||
        execution?.kind !== 'job' ||
        execution.originStoreId !== metadata.storeId ||
        execution.status !== 'dispatching'
      )
        throw Error('unadmitted');
    },
  });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport: { type: 'http', url } }],
    transportPort: port,
  });
  const runtime = createRuntime({
    store,
    extensions: [lifecycle.extension],
    permissions: {
      authorize: async () =>
        awaitingApproval
          ? {
              allowed: false,
              revision: 'explicit-connection-permission-1',
              approval: { request: { title: 'Exact connection transport' } },
            }
          : { allowed: allow, revision: 'explicit-connection-permission-1' },
    },
    resolveRunConfiguration: async (input) => {
      const cached = await lifecycle.readStepCapabilities(input),
        tool = cached.toolIds[0]!;
      return {
        modelId: 'fixed',
        model: createFixedModel([
          [
            { type: 'tool_call', id: 'remote-call', name: tool, arguments: '{}' },
            { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
          ],
          [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
        ]),
        toolIds: ['mcp.connect'],
        snapshot: {},
        readStepCapabilities: (context) => lifecycle.readStepCapabilities(context),
      };
    },
  });
  const unknownBoundary = gate();
  let injected = false;
  const listAcceptedCommands = store.listAcceptedCommands.bind(store);
  store.listAcceptedCommands = async (sessionId, limit) => {
    const commands = await listAcceptedCommands(sessionId, limit);
    if (!injectAfterUnknown || injected || sessionId !== 'a' || commands.length) return commands;
    const unknown = (await store.listExecutions('a')).filter(
      (execution) => execution.kind === 'job' && execution.status === 'outcome_unknown',
    );
    if (!unknown.length) return commands;
    injected = true;
    // Accept real work after the pump's empty observation while the exact earlier Job remains unknown.
    await store.acceptCommand({
      expectedStoreId: metadata.storeId,
      sessionId: 'a',
      commandId: 'blocked-after-unknown',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId: 'mcp.connect',
        definitionVersion: '1',
        input: { serverId: 'local', key: 'blocked-after-unknown' },
      },
    });
    unknownBoundary.enter();
    return commands;
  };
  return {
    runtime,
    store,
    broker,
    refs,
    secret,
    received,
    unknownBoundary: unknownBoundary.seen,
    get requests() {
      return requests;
    },
    get calls() {
      return calls;
    },
    get lookups() {
      return lookups;
    },
    set ask(value: boolean) {
      awaitingApproval = value;
    },
    expectedStoreId: metadata.storeId,
    set allow(value: boolean) {
      allow = value;
    },
    set mode(value: typeof mode) {
      mode = value;
    },
    set lookupGate(value: typeof lookupGate) {
      lookupGate = value;
    },
    set requestGate(value: typeof requestGate) {
      requestGate = value;
    },
    async connect(sessionId: string, commandId: string) {
      await runtime.submitCommand({
        expectedStoreId: metadata.storeId,
        sessionId,
        commandId,
        subjectId: 'owner',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp',
          actionId: 'mcp.connect',
          definitionVersion: '1',
          input: { serverId: 'local', key: commandId },
        },
      });
      try {
        return await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      } catch (error) {
        console.error(
          JSON.stringify({
            diagnostic: 'mcp_credential_connection_failure',
            sessionId,
            commandId,
            mode,
            allow,
            lifecycle: runtime.getLifecycleState(),
            metadata: await store.getMetadata(),
            command: await store.getCommand(commandId),
            sessions: await Promise.all(
              ['a', 'b'].map(async (id) => {
                const view = await store.getView(id);
                return {
                  session: view.session,
                  runs: view.runs,
                  executions: view.executions.map(
                    ({
                      id,
                      definitionId,
                      definitionVersion,
                      kind,
                      status,
                      runId,
                      originCommandId,
                      parentExecutionId,
                      originStoreId,
                      ownerGeneration,
                      resultRevision,
                      delivery,
                      deliveryReason,
                      cancelRequestedAt,
                      result,
                    }) => ({
                      id,
                      definitionId,
                      definitionVersion,
                      kind,
                      status,
                      runId,
                      originCommandId,
                      parentExecutionId,
                      originStoreId,
                      ownerGeneration,
                      resultRevision,
                      delivery,
                      deliveryReason,
                      cancelRequestedAt,
                      result,
                    }),
                  ),
                  accepted: await store.listAcceptedCommands(id),
                };
              }),
            ),
            requests,
            calls,
            lookups,
          }),
        );
        throw error;
      }
    },
    async run(sessionId: string, commandId: string) {
      await runtime.submitCommand({
        expectedStoreId: metadata.storeId,
        sessionId,
        commandId,
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'actual remote call' },
      });
      return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    },
    async cancel(sessionId: string) {
      return runtime.cancelSession({
        expectedStoreId: metadata.storeId,
        sessionId,
        subjectId: 'owner',
        commandId: `stop-${sessionId}`,
        includeBackground: true,
      });
    },
    async close(expectUnconfirmed = false) {
      lookupGate?.release();
      requestGate?.release();
      try {
        if (expectUnconfirmed) {
          const originalRequests = requests,
            originalCalls = calls,
            originalLookups = lookups;
          const beforeClose = await store.listExecutions('a');
          const unknownFacts = beforeClose.filter(
            (execution) => execution.kind === 'job' && execution.status === 'outcome_unknown',
          );
          expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
            code: 'shutdown_cleanup_unconfirmed',
          });
          expect(runtime.getLifecycleState().state).toBe('drain_failed');
          expect(runtime.getLifecycleState().reasons).toContain('background');
          expect((await store.getMetadata()).storeId).toBe(metadata.storeId);
          expect(unknownFacts.length).toBeGreaterThan(0);
          expect(
            (await store.listExecutions('a')).filter(
              (execution) => execution.kind === 'job' && execution.status === 'outcome_unknown',
            ),
          ).toEqual(unknownFacts);
          expect(requests).toBe(originalRequests);
          expect(calls).toBe(originalCalls);
          expect(lookups).toBe(originalLookups);
        } else await runtime.close();
      } finally {
        // This fixture owns its temporary vault and loopback server; no external Task exists.
        // Explicit teardown follows proof that Runtime retained its unknown Job and Store.
        await lifecycle.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
test('actual SQLite connection approval and bound scope/purpose/expiry/revocation reject before credential use/socket', async () => {
  const f = await fixture();
  try {
    f.allow = false;
    await f.connect('a', 'denied');
    expect(f.requests).toBe(0);
    expect(f.lookups).toBe(0);
    expect(f.refs.size).toBe(0);
    expect(JSON.stringify(await f.runtime.getCommand('work-a'))).not.toContain(f.secret);
  } finally {
    await f.close();
  }
  for (const mode of ['scope', 'purpose', 'expired', 'revoked'] as const) {
    const isolated = await fixture();
    try {
      isolated.mode = mode;
      await isolated.connect('a', `reject-${mode}`);
      expect(isolated.requests).toBe(0);
      expect(isolated.lookups).toBe(0);
      expect(isolated.calls).toBe(0);
      const connection = (await isolated.store.listExecutions('a')).find(
        (execution) => execution.definitionId === 'mcp.connection.local',
      );
      expect(connection).toMatchObject({
        status: mode === 'scope' || mode === 'purpose' ? 'outcome_unknown' : 'failed',
        result: {
          outcome: mode === 'scope' || mode === 'purpose' ? 'outcome_unknown' : 'failed',
        },
      });
      expect(JSON.stringify(await isolated.runtime.getCommand(`reject-${mode}`))).not.toContain(
        isolated.secret,
      );
    } finally {
      await isolated.close(mode === 'scope' || mode === 'purpose');
    }
  }
}, 15000);
test('the actual idle handoff with an unknown connection blocks precise new intake without credential or socket use and retains original facts', async () => {
  const f = await fixture(true);
  try {
    f.mode = 'scope';
    await f.connect('a', 'reject-scope');
    await f.unknownBoundary;
    const unknown = (await f.store.listExecutions('a')).filter(
      (execution) => execution.kind === 'job' && execution.status === 'outcome_unknown',
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      definitionId: 'mcp.connection.local',
      originStoreId: f.expectedStoreId,
      resultRevision: '1',
      result: { outcome: 'outcome_unknown', content: 'job_stop_unconfirmed' },
    });
    expect(
      await f.runtime
        .waitForCommand('blocked-after-unknown', { timeoutMs: 5000 })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'session_recovery_required' });
    const session = await f.store.getSession('a');
    expect(session!.ownerInstanceId).not.toBeNull();
    expect(unknown[0]!.ownerGeneration).toBe(session!.ownerGeneration);
    expect(
      await f.store.inspectOwnerDispatch({
        expectedStoreId: f.expectedStoreId,
        sessionId: 'a',
        owner: {
          sessionId: 'a',
          instanceId: session!.ownerInstanceId!,
          generation: session!.ownerGeneration,
        },
      }),
    ).toEqual({
      hasPendingCommands: true,
      hasUnsettledWork: true,
      hasUncommittedAction: false,
    });
    expect(await f.store.getCommand('blocked-after-unknown')).toMatchObject({
      status: 'accepted',
      originStoreId: f.expectedStoreId,
    });
    expect((await f.store.getView('a')).runs).toHaveLength(0);
    expect(
      (await f.store.listExecutions('a')).some(
        (execution) => execution.originCommandId === 'blocked-after-unknown',
      ),
    ).toBe(false);
    expect(
      (await f.store.listExecutions('a')).filter(
        (execution) => execution.kind === 'job' && execution.status === 'outcome_unknown',
      ),
    ).toEqual(unknown);
    expect(f.requests).toBe(0);
    expect(f.calls).toBe(0);
    expect(f.lookups).toBe(0);
  } finally {
    await f.close(true);
  }
}, 15000);
test('revocation during pending wire resolution gives zero late RPC; another Session and an already received request retain actual facts', async () => {
  const f = await fixture();
  try {
    await f.connect('a', 'connect-a');
    await f.connect('b', 'connect-b');
    const before = f.requests;
    const waiting = gate();
    f.lookupGate = waiting;
    const a = f.run('a', 'work-a');
    await Promise.race([
      waiting.seen,
      a.then(async () => {
        throw new Error(`premature:${JSON.stringify(await f.runtime.getCommand('waiting'))}`);
      }),
    ]);
    f.broker.revoke(f.refs.get('a')!);
    waiting.release();
    await a;
    expect(f.requests).toBe(before);
    expect(f.calls).toBe(0);
    f.lookupGate = undefined;
    const received = gate();
    f.requestGate = received;
    const b = f.run('b', 'work-b');
    await received.seen;
    expect(f.calls).toBe(1);
    f.broker.revoke(f.refs.get('b')!);
    received.release();
    await b;
    expect(f.calls).toBe(1);
    expect(f.received.every((value) => value === `Bearer ${f.secret}`)).toBe(true);
    const tool = (await f.store.listExecutions('b')).find(
      (execution) => execution.originCommandId === 'work-b' && execution.kind === 'tool',
    );
    expect(tool?.status).toBe('succeeded');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(JSON.stringify(await f.runtime.getView('b'))).not.toContain(f.secret);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
}, 15000);
test('closing the actual connection while vault resolution waits aborts locally and cannot create a late socket', async () => {
  const f = await fixture();
  try {
    await f.connect('a', 'ready');
    const before = f.requests,
      waiting = gate();
    f.lookupGate = waiting;
    const work = f.run('a', 'waiting');
    await Promise.race([
      waiting.seen,
      work.then(async () => {
        throw new Error(`premature:${JSON.stringify(await f.runtime.getView('a'))}`);
      }),
    ]);
    await f.cancel('a');
    waiting.release();
    await work;
    expect(f.requests).toBe(before);
    expect(f.calls).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);

test('actual durable approval card precedes every credential lookup and socket; cancelling its original command does not connect', async () => {
  const f = await fixture();
  try {
    f.ask = true;
    const work = f.connect('a', 'approval');
    void work.catch(() => {});
    const deadline = Date.now() + 5000;
    let card: InteractionRecord | undefined;
    while (!card) {
      card = (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions[0];
      if (card) break;
      if (Date.now() > deadline) throw Error('approval_card_deadline');
      await Bun.sleep(5);
    }
    expect(card.kind).toBe('approval');
    expect(f.refs.size).toBe(0);
    expect(f.lookups).toBe(0);
    expect(f.requests).toBe(0);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      subjectId: 'owner',
      commandId: 'cancel-approval',
      targetCommandId: 'approval',
    });
    await work;
    expect(
      (
        await f.runtime.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          interactionId: card.id,
        })
      )?.state,
    ).toBe('cancelled');
    expect(f.lookups).toBe(0);
    expect(f.requests).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);
