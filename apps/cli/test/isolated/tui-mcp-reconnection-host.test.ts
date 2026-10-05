import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  carrier,
  prepareReconnectionEngine,
  reconnect,
  reconnectionHostFixture,
  until,
} from '../fixtures/mcp-reconnection-host';

let engine: Awaited<ReturnType<typeof prepareReconnectionEngine>> | undefined;
beforeAll(async () => {
  engine = await prepareReconnectionEngine();
}, 60000);
afterAll(() => engine?.close());
const signal = () => new AbortController().signal;

// These definitions exercise the public Host/Service/Client assembly when Root runs this
// isolated file. Author-time transpilation is not business or platform qualification.
test('warm B targets original A; two forced replacements stop the exact holder before initialize', async () => {
  const f = await reconnectionHostFixture(false, true);
  try {
    const a = await f.ordinary('ordinary_A');
    const readyA = await f.connectionReady(a.intent);
    expect(readyA.fact?.created).toBe(true);
    const b = await f.ordinary('warm_B');
    const readyB = await f.connectionReady(b.intent);
    expect(readyB.fact?.created).toBe(false);
    expect(readyB.fact?.connection?.id).toBe(readyA.fact?.connection?.id);
    expect(readyB.fact?.operationRef).toEqual(readyA.fact?.operationRef);
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);

    const metadata = f.management();
    const snapshots = await metadata.readToolsSnapshots!('s', signal());
    const original = snapshots.items.find(
      (row) => row.origin.connectionExecutionId === readyA.fact?.connection?.id,
    )!;
    expect(original.availability).toBe('available');
    const page = await metadata.readToolsPage!('s', original, signal());
    const descriptor = await metadata.readToolDescriptor!(
      's',
      page.binding,
      page.entries[0]!,
      signal(),
    );
    expect(descriptor.description).toBe(f.description);
    expect(descriptor.annotations).toMatchObject({ title: '原始完整标题' });

    const observed = await f.port().observe(carrier(b.intent), signal());
    expect(observed.target.carrierKey).toBe(b.intent.request.input.key);
    expect(observed.target.operationRef.commandId).toBe(readyA.fact!.operationRef!.commandId);
    expect(observed.target.connectionExecutionId).toBe(readyA.fact!.connection!.id);
    expect(observed.source!.items.length).toBe(27);
    expect(
      f.counts().wireHttp.filter((row) => row.operation === 'workspaces').length,
    ).toBeGreaterThanOrEqual(2);
    const r1 = reconnect(observed, 'forced_R1');
    f.expectOld(observed.target.connectionExecutionId);
    await f.port().submit(r1, observed);
    const readyR1 = await f.reconnectionReady(r1);
    expect(readyR1.fact?.oldStop.confirmed).toBe(true);
    expect(readyR1.fact?.oldStop.execution?.id).toBe(observed.target.connectionExecutionId);
    expect(readyR1.fact?.newConnection?.parentExecutionId).toBe(readyR1.fact?.execution.id);
    expect(readyR1.fact?.newOperationRef?.commandId).toBe(
      readyR1.fact?.newConnection?.originCommandId,
    );
    expect(readyR1.fact?.live).toBe(true);
    const newInitialize = f
      .counts()
      .wire.find(
        (row) =>
          row.method === 'initialize' &&
          row.oldExecutionId === observed.target.connectionExecutionId,
      )!;
    expect(newInitialize.oldTerminal).toBe(true);
    expect(newInitialize.oldTransportStopped).toBe(true);

    const c = await f.ordinary('warm_C');
    const readyC = await f.connectionReady(c.intent);
    expect(readyC.fact?.created).toBe(false);
    expect(readyC.fact?.connection?.id).toBe(readyR1.fact?.newConnection?.id);
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list', 'initialize', 'tools/list']);
    const second = await f.port().observe(carrier(r1), signal());
    const r2 = reconnect(second, 'forced_R2');
    expect(r2.targetRequest).toEqual(r1.request);
    expect(Object.hasOwn(r2.targetRequest, 'targetRequest')).toBe(false);
    f.expectOld(second.target.connectionExecutionId);
    await f.port().submit(r2, second);
    const readyR2 = await f.reconnectionReady(r2);
    expect(readyR2.fact?.oldStop.confirmed).toBe(true);
    expect(readyR2.fact?.newConnection?.id).not.toBe(readyR1.fact?.newConnection?.id);
    expect(
      f
        .counts()
        .wire.find(
          (row) =>
            row.method === 'initialize' &&
            row.oldExecutionId === second.target.connectionExecutionId,
        ),
    ).toMatchObject({ oldTerminal: true, oldTransportStopped: true });
    expect(
      await metadata.readToolDescriptor!('s', page.binding, page.entries[0]!, signal()),
    ).toEqual(descriptor);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
    expect((await f.client.getView('s')).runs).toEqual([]);
    console.log(
      JSON.stringify({
        stage: 'reconnection_host_two_replacements',
        storeId: f.storeId,
        commands: [
          a.intent.request.commandId,
          b.intent.request.commandId,
          r1.request.commandId,
          c.intent.request.commandId,
          r2.request.commandId,
        ],
        originalConnection: readyA.fact?.connection?.id,
        replacements: [readyR1.fact?.newConnection?.id, readyR2.fact?.newConnection?.id],
        rpc: f.counts().rpc,
      }),
    );
  } finally {
    await f.close();
  }
}, 30000);

test('independent Action and replacement Job Ask: denial leaves original stopped and permits explicit new connect', async () => {
  const f = await reconnectionHostFixture(true);
  try {
    const a = await f.ordinary('ask_A');
    expect(f.counts().rpc).toEqual([]);
    await f.answer(
      await f.approval(a.intent.request.commandId, 'builtin.mcp/mcp.connect'),
      'approve',
    );
    const originalJob = await f.approval(a.intent.request.commandId, 'mcp.source.connection');
    expect(f.counts().rpc).toEqual([]);
    await f.answer(originalJob, 'approve');
    const readyA = await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const intent = reconnect(observed, 'ask_R');
    f.expectOld(readyA.fact!.connection!.id);
    await f.port().submit(intent, observed);
    const action = await f.approval(intent.request.commandId, 'builtin.mcp/mcp.reconnect');
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    expect((await f.store.getExecution(readyA.fact!.connection!.id))?.status).toBe('running');
    await f.answer(action, 'approve');
    const replacement = await f.approval(intent.request.commandId, 'mcp.source.connection');
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    const old = await f.store.getExecution(readyA.fact!.connection!.id);
    expect(old?.status).toBe('cancelled');
    expect(old?.result).toMatchObject({ details: { transportStopped: true } });
    await f.answer(replacement, 'deny');
    const refused = await until(async () => {
      const value = await f.port().lookup(intent, signal());
      return value.phase === 'failed' || value.phase === 'cancelled' ? value : undefined;
    });
    expect(refused.fact?.oldStop.confirmed).toBe(true);
    expect(refused.fact?.ready).toBeNull();
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    const fresh = await f.ordinary('after_denial');
    await f.answer(
      await f.approval(fresh.intent.request.commandId, 'builtin.mcp/mcp.connect'),
      'approve',
    );
    await f.answer(
      await f.approval(fresh.intent.request.commandId, 'mcp.source.connection'),
      'approve',
    );
    expect((await f.connectionReady(fresh.intent)).fact?.created).toBe(true);
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list', 'initialize', 'tools/list']);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
  } finally {
    await f.close();
  }
}, 30000);

test('fresh Source drift rejects before POST; cold removed Source and physical Workspace retain original GET-only history', async () => {
  const f = await reconnectionHostFixture();
  try {
    const a = await f.ordinary('history_A');
    await f.connectionReady(a.intent);
    const stale = await f.port().observe(carrier(a.intent), signal());
    f.changeSource(2);
    const before = f.counts();
    const rejected = await f.port().submit(reconnect(stale, 'drift_before_stop'), stale);
    expect(rejected.phase).toBe('outcome_unknown');
    expect(f.counts().wireHttp.filter((row) => row.method === 'POST').length).toBe(
      before.wireHttp.filter((row) => row.method === 'POST').length,
    );
    expect(f.counts().rpc).toEqual(before.rpc);
    expect((await f.store.getExecution(stale.target.connectionExecutionId))?.status).toBe(
      'running',
    );
    const current = await f.port().observe(carrier(a.intent), signal());
    expect(current.replacement.expectedConfigDigest).not.toBe(current.target.configDigest);
    const r = reconnect(current, 'history_R');
    await f.port().submit(r, current);
    const ready = await f.reconnectionReady(r);
    expect(ready.fact?.oldStop.confirmed).toBe(true);
    expect(ready.fact?.ready?.configDigest).toBe(current.replacement.expectedConfigDigest);
    await f.offline();
    f.removeSourceAndMoveWorkspace();
    await f.reopen();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const cold = f.counts();
    const listed = await f.port().list();
    expect(listed.map((row) => row.intent.request.commandId)).toContain(r.request.commandId);
    expect(f.counts().wireHttp).toEqual(cold.wireHttp);
    const original = await f.port().lookup(r, signal());
    expect(original.phase).toBe('ready');
    expect(original.fact?.live).toBe(false);
    expect(original.fact?.currentGeneration).toBeNull();
    expect(original.fact?.execution.id).toBe(ready.fact?.execution.id);
    expect(original.fact?.newConnection?.id).toBe(ready.fact?.newConnection?.id);
    const calls = f.counts().wireHttp.slice(cold.wireHttp.length);
    expect(
      calls.every(
        (row) =>
          row.method === 'GET' && ['command', 'query:mcp.reconnection'].includes(row.operation),
      ),
    ).toBe(true);
    expect(calls.map((row) => row.operation)).toEqual(['command', 'query:mcp.reconnection']);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts().rpc).toEqual(cold.rpc);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
  } finally {
    await f.close();
  }
}, 30000);
