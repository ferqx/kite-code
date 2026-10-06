import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpSourceReadSet } from '../../../src/config/mcp-sources';
import type { AuthorizationRequest, Json, ToolContext } from '../../../src/extensions';
import { createMcpLifecycle, type McpReconnectionInput } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(processConcurrency = 1, staticServer = false, readyTimeoutMs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-reconnection-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const wire: string[] = [],
    opens: string[] = [],
    stops: string[] = [];
  let fresh = true,
    postDrift = false,
    unknown = false,
    holdStop = false,
    denyJob = false,
    holdOpening = false;
  let releaseOpen!: () => void, openEntered!: () => void;
  const openGate = new Promise<void>((r) => {
    releaseOpen = r;
  });
  const opening = new Promise<void>((r) => {
    openEntered = r;
  });
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stopEntered!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  let descriptorVersion = 1;
  let resolves = 0,
    replacements = 0;
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
                tools: [
                  {
                    name: 'original',
                    description: String(descriptorVersion),
                    inputSchema: { type: 'object' },
                  },
                ],
              },
      });
    },
  });
  const readSet: McpSourceReadSet = {
    scopeDigest: 'a'.repeat(64),
    user: {
      identity: { kind: 'user', pathDigest: 'b'.repeat(64), rootIdentity: 'owned-user' },
      etag: null,
      error: null,
    },
    workspace: null,
    approvalEtag: null,
    bindingEtag: null,
    variablesDigest: 'c'.repeat(64),
  };
  const resolution = () => ({
    server: { id: 'local', transport: { type: 'http' as const, url: peer.url.href } },
    captureDigest: 'd'.repeat(64),
    snapshotDigest: 'e'.repeat(64),
    assertFresh({ signal }: { signal: AbortSignal }) {
      signal.throwIfAborted();
      if (!fresh) throw Error('actual_source_drift');
    },
    transportPort: {
      async open(binding: { executionId: string }) {
        opens.push(binding.executionId);
        if (holdOpening && opens.length > 1) {
          openEntered();
          await openGate;
        }
        const transport = new StreamableHTTPClientTransport(peer.url);
        let ended!: (v: { supervision: 'ended' }) => void;
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
            stops.push(binding.executionId);
            stopEntered();
            if (holdStop) await stopGate;
            if (unknown) return { status: 'unknown' as const };
            await transport.close();
            if (postDrift) fresh = false;
            return { status: 'stopped' as const };
          },
        };
      },
    },
  });
  const options = {
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    servers: staticServer ? [resolution().server] : [],
    transportPort: staticServer ? resolution().transportPort : undefined,
    scopedSources: {
      async resolve() {
        resolves++;
        return resolution();
      },
      async resolveReplacement(input: { expectedReadSet: McpSourceReadSet }) {
        replacements++;
        expect(input.expectedReadSet).toEqual(readSet);
        return resolution();
      },
    },
  };
  let lifecycle = createMcpLifecycle(options);
  expect(
    lifecycle.extension.jobs?.find((job) => job.id === 'mcp.source.connection')?.resources?.slot,
  ).toBe('process');
  const makeRuntime = () =>
    createRuntime({
      get store() {
        return store;
      },
      processConcurrency,
      extensions: [lifecycle.extension],
      permissions: {
        async authorize(request: AuthorizationRequest) {
          return {
            allowed: !(denyJob && request.definitionId === 'mcp.source.connection'),
            revision: 'owned',
          };
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
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create_${sessionId}`,
      workspaceId: 'w',
      title: 'owned',
      subjectId: 'owner',
    });
  async function submit(commandId: string, actionId: string, input: Json, sessionId = 's') {
    return runtime.submitCommand({
      expectedStoreId,
      sessionId,
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
  }
  async function invoke(commandId: string, actionId: string, input: Json, sessionId = 's') {
    await submit(commandId, actionId, input, sessionId);
    await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const deadline = Date.now() + 5000;
    for (;;) {
      const e = (await store.listExecutions(sessionId)).find(
        (e) => e.originCommandId === commandId && e.definitionId === `builtin.mcp/${actionId}`,
      );
      if (e && ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status)) return e;
      if (Date.now() > deadline) throw Error('reconnection_deadline');
      await Bun.sleep(5);
    }
  }
  async function query(executionId: string, sessionId = 's') {
    const contents = await runtime.queryExtension({
      sessionId,
      subjectId: 'owner',
      extensionId: 'builtin.mcp',
      queryId: 'mcp.reconnection',
      input: { executionId },
    });
    expect(Buffer.byteLength(JSON.stringify(contents))).toBeLessThanOrEqual(16 * 1024);
    expect(contents[0]!.actions).toEqual([]);
    expect(contents[0]!.artifactRefs).toEqual([]);
    return contents[0]!.payload as Record<string, Json>;
  }
  async function connection(executionId: string, key: string) {
    return (
      await runtime.queryExtension({
        sessionId: 's',
        subjectId: 'owner',
        extensionId: 'builtin.mcp',
        queryId: 'mcp.connection',
        input: { executionId, serverId: 'local', key },
      })
    )[0]!.payload as Record<string, Json>;
  }
  function input(carrier: Record<string, Json>, key: string): McpReconnectionInput {
    const e = carrier.execution as Record<string, Json>,
      ready = carrier.ready as Record<string, Json>;
    const operationRef = (carrier.operationRef ??
      carrier.newOperationRef) as unknown as McpReconnectionInput['target']['operationRef'];
    return {
      serverId: 'local',
      key,
      target: {
        carrierExecutionId: String(e.id),
        carrierKey: key === 'r1' ? 'b' : 'r1',
        operationRef,
        connectionExecutionId: operationRef.executionId,
        configDigest: String(ready.configDigest),
        currentGeneration: Number(carrier.currentGeneration),
      },
      replacement: staticServer
        ? { kind: 'static', expectedConfigDigest: String(ready.configDigest) }
        : {
            kind: 'source',
            expectedConfigDigest: String(ready.configDigest),
            expectedReadSet: readSet,
          },
    };
  }
  let faultHits = 0;
  let restoreRecord = () => {};
  let restoreAction = () => {};
  let resultFaultId: string | undefined;
  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const disarmFault = () => {
    restoreRecord();
    restoreAction();
    restoreRecord = () => {};
    restoreAction = () => {};
  };
  return {
    armResultFault(afterCommit: boolean) {
      const targetStore = store;
      const apply = targetStore.applyExtensionAction.bind(targetStore);
      restoreAction = () => {
        targetStore.applyExtensionAction = apply;
      };
      targetStore.applyExtensionAction = async (input) => {
        const own = await targetStore.getExecution(input.executionId);
        if (
          !resultFaultId &&
          own?.originCommandId === 'r1' &&
          own.definitionId === 'builtin.mcp/mcp.reconnect' &&
          own.kind === 'job' &&
          input.extensionId === 'builtin.mcp' &&
          input.status === 'succeeded'
        ) {
          if (afterCommit) await apply(input);
          resultFaultId = own.id;
          await resultGate;
          throw Error(
            afterCommit ? 'owned_action_result_reply_lost' : 'owned_action_result_commit_failed',
          );
        }
        return apply(input);
      };
    },
    releaseResult,
    async resultFault() {
      const deadline = Date.now() + 5000;
      while (!resultFaultId) {
        if (Date.now() > deadline) throw Error('owned_action_result_fault_deadline');
        await Bun.sleep(5);
      }
      return resultFaultId;
    },
    armStageFault(stage: string, afterCommit: boolean) {
      const targetStore = store;
      const writeRecord = targetStore.writeExtensionRecord.bind(targetStore);
      restoreRecord = () => {
        targetStore.writeExtensionRecord = writeRecord;
      };
      targetStore.writeExtensionRecord = async (input) => {
        const value = input.write.value;
        if (
          faultHits === 0 &&
          input.originCommandId === 'r1' &&
          input.write.contentType === 'builtin.mcp.reconnection' &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.stage === stage
        ) {
          faultHits++;
          if (afterCommit) await writeRecord(input);
          throw Error(afterCommit ? 'owned_stage_reply_lost' : 'owned_stage_write_failed');
        }
        return writeRecord(input);
      };
    },
    get faultHits() {
      return faultHits;
    },
    disarmFault,
    wire,
    opening,
    holdOpen() {
      holdOpening = true;
    },
    releaseOpen() {
      releaseOpen();
    },
    closeFactory() {
      return lifecycle.close();
    },
    opens,
    stops,
    invoke,
    submit,
    query,
    connection,
    step() {
      return lifecycle.readStepCapabilities({
        command: { originStoreId: expectedStoreId },
        session: { id: 's' },
      });
    },
    input,
    changeDescriptor() {
      descriptorVersion++;
    },
    stopping,
    readSet,
    get store() {
      return store;
    },
    get counters() {
      return { resolves, replacements };
    },
    hold() {
      holdStop = true;
    },
    release() {
      releaseStop();
    },
    deny(value: boolean) {
      denyJob = value;
    },
    setUnknown() {
      unknown = true;
    },
    preDrift() {
      fresh = false;
    },
    postDrift() {
      postDrift = true;
    },
    async cold() {
      await lifecycle.close();
      await runtime.close();
      await store.close();
      store = await openSqliteStore(profile);
      lifecycle = createMcpLifecycle(options);
      runtime = makeRuntime();
    },
    async close() {
      releaseResult();
      disarmFault();
      unknown = false;
      postDrift = false;
      fresh = true;
      releaseStop();
      releaseOpen();
      try {
        await lifecycle.close();
      } finally {
        try {
          await runtime.close();
        } finally {
          try {
            await store.close();
          } finally {
            peer.stop(true);
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    },
  };
}

test('last process slot: warm B targets A, stop barrier precedes new open, new R parent supports warm C and repeated R; cold Query has no effects', async () => {
  const f = await fixture();
  try {
    const a = await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    expect(a.status).toBe('succeeded');
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    expect(warm.created).toBe(false);
    expect(f.opens.length).toBe(1);
    const oldStep = await f.step();
    const oldTool = oldStep.extensions[0]!.tools![0]!;
    f.hold();
    const pending = f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
    void pending.catch(() => {});
    await f.stopping;
    expect((await f.step()).toolIds).toEqual([]);
    const beforeWire = [...f.wire];
    const deniedOld = await oldTool.execute({}, {
      signal: new AbortController().signal,
    } as ToolContext);
    expect(deniedOld.outcome).toBe('failed');
    expect(f.wire).toEqual(beforeWire);
    const originalJob = await f.store.getExecution(
      (warm.operationRef as Record<string, Json>).executionId as string,
    );
    expect(originalJob?.status).toBe('running');
    expect(f.opens.length).toBe(1);
    await f.submit('during_connect', 'mcp.connect', { serverId: 'local', key: 'during' });
    await f.submit('during_r', 'mcp.reconnect', {
      ...f.input(warm, 'r1'),
      key: 'during-r',
    } as unknown as Json);
    expect((await f.store.getCommand('during_connect'))?.status).toBe('accepted');
    expect((await f.store.getCommand('during_r'))?.status).toBe('accepted');
    expect(f.opens.length).toBe(1);
    expect(f.wire).toEqual(beforeWire);
    expect(
      (await f.store.listExecutions('s')).filter(
        (e) => e.originCommandId === 'during_connect' || e.originCommandId === 'during_r',
      ),
    ).toHaveLength(0);
    f.release();
    const r1 = await pending;
    expect(r1.status).toBe('succeeded');
    const first = await f.query(r1.id);
    expect(first.phase).toBe('ready');
    expect(first.live).toBe(true);
    expect((first.oldStop as Record<string, Json>).confirmed).toBe(true);
    expect(f.opens.length).toBe(2);
    expect((first.newConnection as Record<string, Json>).parentExecutionId).toBe(r1.id);
    const c = await f.invoke('c', 'mcp.connect', { serverId: 'local', key: 'c' });
    const reused = await f.connection(c.id, 'c');
    expect(reused.created).toBe(false);
    expect(reused.operationRef).toEqual(first.newOperationRef);
    expect(f.opens.length).toBe(2);
    const r2 = await f.invoke('r2', 'mcp.reconnect', f.input(first, 'r2') as unknown as Json);
    expect(r2.status).toBe('succeeded');
    expect(f.opens.length).toBe(3);
    expect((await f.query(r2.id)).phase).toBe('ready');
    await f.cold();
    const before = {
      wire: [...f.wire],
      opens: [...f.opens],
      counters: f.counters,
      cursor: (await f.store.getMetadata()).lastChangeCursor,
    };
    const historical = await f.query(r1.id);
    expect(historical.phase).toBe('ready');
    expect(historical.live).toBe(false);
    expect(historical.currentGeneration).toBeNull();
    expect(f.wire).toEqual(before.wire);
    expect(f.opens).toEqual(before.opens);
    expect(f.counters).toEqual(before.counters);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.cursor);
  } finally {
    await f.close();
  }
}, 30000);

test('unknown owned stop quarantines same scope; no new ensure/open and another Session is independent', async () => {
  // The unconfirmed original transport retains its permit; the independent Session needs its own slot.
  const f = await fixture(2);
  try {
    const a = await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    f.setUnknown();
    const r = await f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
    expect(r.status).toBe('outcome_unknown');
    const fact = await f.query(r.id);
    expect(fact.phase).toBe('outcome_unknown');
    expect((fact.oldStop as Record<string, Json>).confirmed).toBe(false);
    expect(fact.newOperationRef).toBeNull();
    expect(f.opens).toHaveLength(1);
    const blocked = await f.invoke('blocked', 'mcp.connect', { serverId: 'local', key: 'blocked' });
    expect(blocked.status).toBe('failed');
    expect(f.opens).toHaveLength(1);
    const other = await f.invoke(
      'other',
      'mcp.connect',
      { serverId: 'local', key: 'other' },
      'other',
    );
    expect(other.status).toBe('succeeded');
    expect(f.opens).toHaveLength(2);
    expect(a.status).toBe('succeeded');
  } finally {
    await f.close();
  }
}, 30000);

test('replacement freshness drift before stop leaves original live; post-stop drift records stopped without new admission', async () => {
  for (const after of [false, true]) {
    const f = await fixture();
    try {
      await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
      const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
      const warm = await f.connection(b.id, 'b');
      if (after) f.postDrift();
      else f.preDrift();
      const r = await f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
      expect(r.status).toBe('failed');
      expect(f.opens).toHaveLength(1);
      expect(f.stops).toHaveLength(after ? 1 : 0);
      if (after) {
        const fact = await f.query(r.id);
        expect(fact.phase).toBe('failed');
        expect((fact.oldStop as Record<string, Json>).confirmed).toBe(true);
        expect(fact.newOperationRef).toBeNull();
      } else expect((await f.connection(b.id, 'b')).live).toBe(true);
    } finally {
      await f.close();
    }
  }
}, 30000);

test('ordinary connect denied connection Job settles unopened bootstrap; independent new key can admit and open', async () => {
  const f = await fixture();
  try {
    f.deny(true);
    const denied = await f.invoke('denied', 'mcp.connect', { serverId: 'local', key: 'denied' });
    expect(denied.status).toBe('failed');
    expect(f.opens).toHaveLength(0);
    const children = (await f.store.listExecutions('s')).filter(
      (e) => e.parentExecutionId === denied.id,
    );
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe('failed');
    expect(children[0]!.result).toMatchObject({
      content: 'permission_denied',
      details: { adapterAttempted: false, stopConfirmation: null },
    });
    f.deny(false);
    const next = await f.invoke('next', 'mcp.connect', { serverId: 'local', key: 'next' });
    expect(next.status).toBe('succeeded');
    expect(f.opens).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('replacement Job denied after old stop retains exact terminal child/ref and allows independent explicit new connect', async () => {
  const f = await fixture();
  try {
    await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    f.deny(true);
    const r = await f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
    expect(r.status).toBe('failed');
    const fact = await f.query(r.id);
    expect(fact.phase).toBe('failed');
    expect((fact.oldStop as Record<string, Json>).confirmed).toBe(true);
    expect((fact.newConnection as Record<string, Json>).status).toBe('failed');
    expect(f.opens).toHaveLength(1);
    f.deny(false);
    const next = await f.invoke('next', 'mcp.connect', { serverId: 'local', key: 'next' });
    expect(next.status).toBe('succeeded');
    expect(f.opens).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20000);

test('replacement terminal wait timeout keeps the original unknown after the real child later commits', async () => {
  const f = await fixture(1, false, 2000);
  const write = f.store.writeExtensionRecord.bind(f.store);
  const finish = f.store.finishExecution.bind(f.store);
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  let terminalAttempt: Parameters<typeof finish>[0] | undefined;
  try {
    await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    f.store.writeExtensionRecord = async (input) => {
      const receipt = await write(input);
      const value = input.write.value;
      if (
        input.originCommandId === 'r1' &&
        input.write.contentType === 'builtin.mcp.reconnection' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.stage === 'new_planned'
      )
        f.preDrift();
      return receipt;
    };
    f.store.finishExecution = async (input) => {
      const child = await f.store.getExecution(input.executionId);
      const parent = child?.parentExecutionId
        ? await f.store.getExecution(child.parentExecutionId)
        : null;
      if (child?.definitionId === 'mcp.source.connection' && parent?.originCommandId === 'r1') {
        terminalAttempt = input;
        await terminalGate;
      }
      return finish(input);
    };
    const r = await f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
    expect(r.status).toBe('outcome_unknown');
    expect(terminalAttempt).toBeDefined();
    expect(terminalAttempt).toMatchObject({
      status: 'failed',
      result: { details: { transportStopped: true, remoteToolStopConfirmed: false } },
    });
    const childId = terminalAttempt!.executionId;
    expect(await f.store.getExecution(childId)).toMatchObject({
      status: 'running',
      result: null,
      resultRevision: '0',
    });
    const before = await f.query(r.id);
    expect(before.phase).toBe('outcome_unknown');
    expect((before.oldStop as Record<string, Json>).confirmed).toBe(true);
    expect(before.ready).toBeNull();
    expect(f.opens).toHaveLength(1);
    expect(f.stops).toHaveLength(1);
    const wire = [...f.wire];
    releaseTerminal();
    const deadline = Date.now() + 5000;
    while ((await f.store.getExecution(childId))?.status !== 'failed') {
      if (Date.now() > deadline) throw Error('owned_replacement_terminal_deadline');
      await Bun.sleep(5);
    }
    expect(await f.store.getExecution(childId)).toMatchObject({ resultRevision: '1' });
    expect(await f.store.getExecution(r.id)).toEqual(r);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const after = await f.query(r.id);
    expect(after.phase).toBe('outcome_unknown');
    expect((after.newConnection as Record<string, Json>).status).toBe('failed');
    expect(after.ready).toBeNull();
    expect((await f.step()).toolIds).toEqual([]);
    expect(f.opens).toHaveLength(1);
    expect(f.wire).toEqual(wire);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    releaseTerminal();
    f.store.writeExtensionRecord = write;
    f.store.finishExecution = finish;
    await f.close();
  }
}, 15000);

test('refresh then same-key carrier retains original catalogue while reconnect observes current generation', async () => {
  const f = await fixture();
  try {
    await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const before = await f.connection(b.id, 'b');
    const ready = before.ready as Record<string, Json>,
      ref = before.operationRef as Record<string, Json>;
    f.changeDescriptor();
    const refresh = await f.invoke('refresh', 'mcp.catalogue.refresh', {
      serverId: 'local',
      connectionKey: 'b',
      configDigest: ready.configDigest!,
      generation: before.currentGeneration!,
      connectionExecutionId: ref.executionId!,
    });
    expect(refresh.status).toBe('succeeded');
    const again = await f.invoke('same_b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const carrier = await f.connection(again.id, 'b');
    expect(carrier.ready).toEqual(before.ready);
    expect(Number(carrier.currentGeneration)).toBeGreaterThan(
      Number((carrier.ready as Record<string, Json>).generation),
    );
    const r = await f.invoke('r1', 'mcp.reconnect', f.input(carrier, 'r1') as unknown as Json);
    expect(r.status).toBe('succeeded');
    expect((await f.query(r.id)).phase).toBe('ready');
  } finally {
    await f.close();
  }
}, 20000);

test('closing during replacement open collects late owned handle; no discovery or ready escapes fence', async () => {
  const f = await fixture();
  let work: ReturnType<typeof f.invoke> | undefined;
  try {
    await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    const before = [...f.wire];
    f.holdOpen();
    work = f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
    void work.catch(() => {});
    await f.opening;
    const closing = f.closeFactory();
    f.releaseOpen();
    await closing;
    const r = await work;
    expect(r.status).not.toBe('succeeded');
    const fact = await f.query(r.id);
    expect(fact.phase).not.toBe('ready');
    expect(fact.ready).toBeNull();
    expect((fact.oldStop as Record<string, Json>).confirmed).toBe(true);
    expect(f.wire).toEqual(before);
    const childId = (fact.newConnection as Record<string, Json>).id as string;
    const deadline = Date.now() + 5000;
    let child = await f.store.getExecution(childId);
    while (child && ['running', 'dispatching'].includes(child.status)) {
      if (Date.now() > deadline) throw Error('late_owned_job_deadline');
      await Bun.sleep(5);
      child = await f.store.getExecution(childId);
    }
    expect(child?.result).toMatchObject({
      details: { transportStopped: true, remoteToolStopConfirmed: false },
    });
    expect(f.stops).toContain(childId);
  } finally {
    f.releaseOpen();
    await work?.catch(() => {});
    await f.close();
  }
}, 20000);

for (const fault of [
  { stage: 'prepared', afterCommit: false },
  { stage: 'old_stopped', afterCommit: true },
  { stage: 'new_planned', afterCommit: false },
  { stage: 'ready', afterCommit: false },
  { stage: 'ready', afterCommit: true },
]) {
  test(`R ${fault.stage} ${fault.afterCommit ? 'committed reply loss' : 'write failure'} retains actual stop/open evidence`, async () => {
    const f = await fixture();
    try {
      await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
      const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
      const warm = await f.connection(b.id, 'b');
      const oldId = String((warm.operationRef as Record<string, Json>).executionId);
      const oldTool = (await f.step()).extensions[0]!.tools![0]!;
      const originalWire = [...f.wire];
      f.armStageFault(fault.stage, fault.afterCommit);
      const r = await f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
      expect(f.faultHits).toBe(1);
      expect(r.status).not.toBe('succeeded');
      const fact = await f.query(r.id);
      expect(fact.phase).not.toBe('ready');
      expect(fact.ready).toBeNull();
      const old = await f.store.getExecution(oldId);
      const children = (await f.store.listExecutions('s')).filter(
        (e) => e.parentExecutionId === r.id,
      );
      const opened = fault.stage === 'ready';
      expect(f.opens).toHaveLength(opened ? 2 : 1);
      expect(f.wire.filter((method) => method === 'initialize')).toHaveLength(opened ? 2 : 1);
      expect(children).toHaveLength(fault.stage === 'new_planned' || opened ? 1 : 0);
      if (fault.stage === 'new_planned') {
        const deadline = Date.now() + 5000;
        let child = await f.store.getExecution(children[0]!.id);
        while (child && ['planned', 'dispatching', 'running'].includes(child.status)) {
          if (Date.now() > deadline) throw Error('unopened_job_terminal_deadline');
          await Bun.sleep(5);
          child = await f.store.getExecution(children[0]!.id);
        }
        expect(child?.status).toBe('failed');
        expect(child?.result).toMatchObject({
          outcome: 'failed',
          details: { transportStopped: true, remoteToolStopConfirmed: false },
        });
      }
      if (fault.stage === 'prepared') {
        expect(old?.status).toBe('running');
        expect(f.stops).toHaveLength(0);
        expect(f.wire).toEqual(originalWire);
      } else {
        expect(old?.result).toMatchObject({
          details: { transportStopped: true, remoteToolStopConfirmed: false },
        });
        expect(old).not.toBeNull();
        expect(['cancelled', 'failed', 'succeeded']).toContain(old!.status);
        expect(f.stops).toContain(oldId);
        expect((await f.step()).toolIds).toEqual([]);
        const beforeWire = [...f.wire];
        const denied = await oldTool.execute({}, {
          signal: new AbortController().signal,
        } as ToolContext);
        expect(denied.outcome).toBe('failed');
        expect(f.wire).toEqual(beforeWire);
      }
      if (r.status === 'outcome_unknown') {
        expect(fact.phase).toBe('outcome_unknown');
        const before = { opens: [...f.opens], wire: [...f.wire], children: children.length };
        const blocked = await f.invoke('blocked', 'mcp.connect', {
          serverId: 'local',
          key: 'blocked',
        });
        expect(blocked.status).toBe('failed');
        const repeated = await f.invoke('repeat_r', 'mcp.reconnect', {
          ...f.input(warm, 'r1'),
          key: 'repeat-r',
        } as unknown as Json);
        expect(repeated.status).toBe('failed');
        expect(f.opens).toEqual(before.opens);
        expect(f.wire).toEqual(before.wire);
        expect(
          (await f.store.listExecutions('s')).filter(
            (e) => e.parentExecutionId === blocked.id || e.parentExecutionId === repeated.id,
          ),
        ).toHaveLength(0);
      }
      f.disarmFault();
    } finally {
      await f.close();
    }
  }, 30000);
}

test('fixed programmatic static replacement preserves warm original ref and rejects source/static confusion before stop', async () => {
  const f = await fixture(1, true);
  try {
    await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
    const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
    const warm = await f.connection(b.id, 'b');
    expect(warm.created).toBe(false);
    const input = f.input(warm, 'r1');
    const confused = await f.invoke('confused', 'mcp.reconnect', {
      ...input,
      key: 'confused',
      replacement: {
        kind: 'source',
        expectedConfigDigest: input.replacement.expectedConfigDigest,
        expectedReadSet: f.readSet,
      },
    } as unknown as Json);
    expect(confused.status).toBe('failed');
    expect(f.stops).toHaveLength(0);
    expect(f.opens).toHaveLength(1);
    const r = await f.invoke('r1', 'mcp.reconnect', input as unknown as Json);
    expect(r.status).toBe('succeeded');
    const fact = await f.query(r.id);
    expect(fact.phase).toBe('ready');
    expect((fact.oldStop as Record<string, Json>).confirmed).toBe(true);
    expect(f.opens).toHaveLength(2);
    expect(f.wire.filter((method) => method === 'initialize')).toHaveLength(2);
    expect((fact.newConnection as Record<string, Json>).parentExecutionId).toBe(r.id);
    expect((fact.newConnection as Record<string, Json>).definitionId).toBe('mcp.connection.local');
    expect(f.counters).toEqual({ resolves: 0, replacements: 0 });
  } finally {
    await f.close();
  }
}, 30000);

for (const afterCommit of [false, true]) {
  test(`R final Action result ${afterCommit ? 'committed reply loss' : 'before commit failure'} preserves proof-dependent live capabilities`, async () => {
    const f = await fixture();
    let work: ReturnType<typeof f.invoke> | undefined;
    try {
      await f.invoke('a', 'mcp.connect', { serverId: 'local', key: 'a' });
      const b = await f.invoke('b', 'mcp.connect', { serverId: 'local', key: 'b' });
      const warm = await f.connection(b.id, 'b');
      const oldTool = (await f.step()).extensions[0]!.tools![0]!;
      f.armResultFault(afterCommit);
      work = f.invoke('r1', 'mcp.reconnect', f.input(warm, 'r1') as unknown as Json);
      // Only prevent an unhandled rejection while the owned receipt barrier is inspected.
      void work.catch((error) => {
        console.log(
          JSON.stringify({
            stage: 'reconnection_final_result_original_wait_rejected',
            afterCommit,
            code: error && typeof error === 'object' && 'code' in error ? error.code : null,
          }),
        );
      });
      const id = await f.resultFault();
      expect(f.opens).toHaveLength(2);
      expect(f.wire.filter((method) => method === 'initialize')).toHaveLength(2);
      const durable = await f.store.getExecution(id);
      const fact = await f.query(id);
      const step = await f.step();
      // Check the capability boundary immediately, before any queued same-Session work.
      if (afterCommit) {
        expect(durable?.status).toBe('succeeded');
        expect(fact.phase).toBe('ready');
        expect(fact.live).toBe(true);
        expect(step.toolIds).toHaveLength(1);
      } else {
        expect(durable?.status).toBe('dispatching');
        expect(fact.phase).toBe('pending');
        expect(fact.ready).toBeNull();
        expect(step.toolIds).toEqual([]);
      }
      const beforeWire = [...f.wire];
      const oldResult = await oldTool.execute({}, {
        signal: new AbortController().signal,
      } as ToolContext);
      expect(oldResult.outcome).toBe('failed');
      expect(f.wire).toEqual(beforeWire);
      if (!afterCommit) {
        await f.submit('c', 'mcp.connect', { serverId: 'local', key: 'c' });
        expect((await f.store.getCommand('c'))?.status).toBe('accepted');
        expect(
          (await f.store.listExecutions('s')).filter((e) => e.originCommandId === 'c'),
        ).toHaveLength(0);
        expect(f.opens).toHaveLength(2);
        expect(f.wire).toEqual(beforeWire);
        expect((await f.query(id)).phase).toBe('pending');
        expect((await f.step()).toolIds).toEqual([]);
      }
      f.releaseResult();
      console.log(
        JSON.stringify({ stage: 'reconnection_final_result_barrier_released', afterCommit }),
      );
      if (afterCommit) {
        const r = await work;
        expect(r.id).toBe(id);
        expect(r.status).toBe('succeeded');
      } else {
        // The failed final commit leaves the original durable Action unresolved.
        // Waiting observes its original deadline; it cannot manufacture a terminal result.
        let failure: unknown;
        try {
          await work;
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: 'wait_timeout' });
        const original = await f.store.getExecution(id);
        expect(original?.status).toBe('dispatching');
        expect(original?.result).toBeNull();
        expect(original?.resultRevision).toBe('0');
        expect((await f.query(id)).phase).toBe('pending');
      }
      console.log(
        JSON.stringify({ stage: 'reconnection_final_result_wait_observed', afterCommit }),
      );
      expect(f.opens).toHaveLength(2);
      expect(f.wire).toEqual(beforeWire);
      if (afterCommit) {
        const warmC = await f.invoke('c', 'mcp.connect', { serverId: 'local', key: 'c' });
        expect(warmC.status).toBe('succeeded');
        expect((await f.connection(warmC.id, 'c')).operationRef).toEqual(fact.newOperationRef);
        const before = {
          wire: [...f.wire],
          opens: [...f.opens],
          cursor: (await f.store.getMetadata()).lastChangeCursor,
        };
        expect((await f.query(id)).phase).toBe('ready');
        expect(f.wire).toEqual(before.wire);
        expect(f.opens).toEqual(before.opens);
        expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.cursor);
      } else {
        // The original unresolved Action owns this serial Session boundary.
        // The accepted caller above proves no new work escaped while it was held.
        expect((await f.store.getCommand('c'))?.status).toBe('accepted');
        expect(
          (await f.store.listExecutions('s')).filter((e) => e.originCommandId === 'c'),
        ).toHaveLength(0);
        expect((await f.query(id)).phase).not.toBe('ready');
        expect((await f.step()).toolIds).toEqual([]);
      }
    } finally {
      f.releaseResult();
      // Observe the original caller promise during cleanup; never retry its POST or invent success.
      await work?.catch(() => {});
      console.log(
        JSON.stringify({ stage: 'reconnection_final_result_close_started', afterCommit }),
      );
      await f.close();
      console.log(
        JSON.stringify({ stage: 'reconnection_final_result_close_confirmed', afterCommit }),
      );
    }
  }, 30000);
}
