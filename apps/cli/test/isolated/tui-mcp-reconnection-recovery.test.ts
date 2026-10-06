import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryResponse } from '@kite-ai/client';
import { createMcpReconnectionRecord } from '../../host/mcp-reconnection-intents';
import { createTuiMcpReconnectionPort } from '../../host/tui-mcp-reconnection';
import {
  carrier,
  prepareReconnectionEngine,
  reconnect,
  reconnectionHostFixture,
  until,
} from '../fixtures/mcp-reconnection-host';
import { reconnectionRecoveryFixture } from '../fixtures/mcp-reconnection-host-recovery';

let engine: Awaited<ReturnType<typeof prepareReconnectionEngine>> | undefined;
beforeAll(async () => {
  engine = await prepareReconnectionEngine();
}, 60000);
afterAll(() => engine?.close());
const signal = () => new AbortController().signal;

test('physical accepted POST loss and cold GET loss preserve original unknown; duplicate uses GET and never another POST', async () => {
  const relay = await reconnectionRecoveryFixture();
  const f = relay.f;
  try {
    const a = await f.ordinary('relay_A');
    await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const original = reconnect(observed, 'relay_R');
    relay.lose(original, 'POST');
    expect((await f.port().submit(original, observed)).phase).toBe('outcome_unknown');
    expect(relay.counts()).toMatchObject({ posts: 1, physicalDrops: 1, relayFailed: false });
    expect(f.journal.list()[0]?.phase).toBe('outcome_unknown');
    const blocked = await f.ordinary('unknown_fenced_C');
    expect(blocked.outcome.phase).toBe('outcome_unknown');
    expect(relay.counts().posts).toBe(1);
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list', 'initialize', 'tools/list']);
    const path = join(f.profile.profilePath, 'ui/mcp-reconnection-intents.json');
    const unknownBytes = readFileSync(path);
    await f.offline();
    f.removeSourceAndMoveWorkspace();
    await f.reopen();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const before = f.counts();
    expect(await f.port().list()).toEqual([{ intent: original, phase: 'outcome_unknown' }]);
    expect(f.counts()).toEqual(before);
    relay.lose(original, 'GET');
    expect((await f.port().lookup(original, signal())).phase).toBe('outcome_unknown');
    expect(relay.counts()).toMatchObject({ posts: 1, physicalDrops: 2, relayFailed: false });
    expect(readFileSync(path)).toEqual(unknownBytes);
    const recovered = await f.port().submit(original, observed);
    expect(recovered.phase).toBe('ready');
    expect(recovered.fact?.live).toBe(false);
    expect(recovered.fact?.oldStop.confirmed).toBe(true);
    expect(recovered.fact?.execution.originCommandId).toBe(original.request.commandId);
    expect(relay.counts().posts).toBe(1);
    expect(
      f
        .counts()
        .wireHttp.slice(before.wireHttp.length)
        .every(
          (row) =>
            row.method === 'GET' && ['command', 'query:mcp.reconnection'].includes(row.operation),
        ),
    ).toBe(true);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
    console.log(
      JSON.stringify({
        stage: 'reconnection_recovery_original',
        commandId: original.request.commandId,
        storeId: f.storeId,
        actionId: recovered.fact?.execution.id,
        newConnectionId: recovered.fact?.newConnection?.id,
        ...relay.counts(),
      }),
    );
  } finally {
    await relay.close();
  }
}, 30000);

test('replacement Job Ask Source drift occurs after exact old stop and prevents new remote initialize', async () => {
  const f = await reconnectionHostFixture(true);
  const finish = f.store.finishExecution.bind(f.store);
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  let terminalAttempt: Parameters<typeof finish>[0] | undefined;
  try {
    const a = await f.ordinary('drift_ask_A');
    await f.answer(
      await f.approval(a.intent.request.commandId, 'builtin.mcp/mcp.connect'),
      'approve',
    );
    await f.answer(
      await f.approval(a.intent.request.commandId, 'mcp.source.connection'),
      'approve',
    );
    await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const r = reconnect(observed, 'drift_job_R');
    await f.port().submit(r, observed);
    await f.answer(await f.approval(r.request.commandId, 'builtin.mcp/mcp.reconnect'), 'approve');
    const replacement = await f.approval(r.request.commandId, 'mcp.source.connection');
    expect(
      (await f.store.getExecution(observed.target.connectionExecutionId))?.result,
    ).toMatchObject({ details: { transportStopped: true } });
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    f.store.finishExecution = async (input) => {
      if (input.executionId === replacement.executionId) {
        terminalAttempt = input;
        await terminalGate;
      }
      return finish(input);
    };
    f.changeSource(7);
    await f.answer(replacement, 'approve');
    await until(async () => terminalAttempt);
    expect(terminalAttempt).toMatchObject({
      status: 'failed',
      result: { content: 'mcp_source_stale', details: { transportStopped: true } },
    });
    expect(await f.store.getExecution(replacement.executionId)).toMatchObject({
      status: 'running',
      result: null,
      resultRevision: '0',
    });
    const pending = await f.port().lookup(r, signal());
    expect(pending.phase).toBe('pending');
    expect(pending.fact?.oldStop.confirmed).toBe(true);
    expect(pending.fact?.ready).toBeNull();
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    releaseTerminal();
    const refused = await until(async () => {
      const value = await f.port().lookup(r, signal());
      return ['failed', 'cancelled'].includes(value.phase) ? value : undefined;
    });
    expect(refused.phase).toBe('failed');
    expect(refused.fact?.oldStop.confirmed).toBe(true);
    expect(refused.fact?.ready).toBeNull();
    expect(refused.fact?.newConnection).toMatchObject({
      id: replacement.executionId,
      status: 'failed',
    });
    expect(await f.store.getExecution(replacement.executionId)).toMatchObject({
      status: 'failed',
      resultRevision: '1',
      result: { content: 'mcp_source_stale', details: { transportStopped: true } },
    });
    expect(f.counts().rpc).toEqual(['initialize', 'tools/list']);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
  } finally {
    releaseTerminal();
    f.store.finishExecution = finish;
    await f.close();
  }
}, 30000);

test('cloned actual ready Query corruption cannot become authority; foreign subject/store fail before GET', async () => {
  const f = await reconnectionHostFixture();
  try {
    const a = await f.ordinary('controls_A');
    await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const r = reconnect(observed, 'controls_R');
    await f.port().submit(r, observed);
    const ready = await f.reconnectionReady(r);
    const actual = await f.client.queryExtension('s', 'builtin.mcp', 'mcp.reconnection', {
      executionId: ready.fact!.execution.id,
    });
    // Fault setup: mutate only the real response, never fabricate a producer or persisted receipt.
    const changes: ((fact: Record<string, unknown>) => void)[] = [
      (fact) => {
        (fact.oldStop as { execution: Record<string, unknown> }).execution.status =
          'outcome_unknown';
      },
      (fact) => {
        (fact.oldStop as { execution: Record<string, unknown> }).execution.resultRevision = '0';
      },
      (fact) => {
        (fact.newConnection as Record<string, unknown>).definitionId = 'mcp.connection.alias';
      },
      (fact) => {
        (fact.newConnection as Record<string, unknown>).parentExecutionId = 'wrong_parent';
      },
      (fact) => {
        (fact.newOperationRef as Record<string, unknown>).executionId = 'wrong_ref';
      },
      (fact) => {
        (fact.execution as Record<string, unknown>).inputDigest = '0'.repeat(64);
      },
      (fact) => {
        fact.originalAlias = 'forbidden';
      },
      (fact) => {
        fact.phase = ['ready'];
      },
    ];
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const postCount = f.counts().wireHttp.filter((row) => row.method === 'POST').length;
    for (const change of changes) {
      const bad = structuredClone(actual);
      change(bad[0]!.payload as Record<string, unknown>);
      const client = {
        ...f.tracked,
        async queryExtension(
          ...args: Parameters<typeof f.tracked.queryExtension>
        ): Promise<QueryResponse> {
          if (args[2] === 'mcp.reconnection') return bad;
          return f.tracked.queryExtension(...args);
        },
      };
      const port = createTuiMcpReconnectionPort(
        client,
        f.storeId,
        { connection: f.connectionJournal, reconnection: f.journal },
        f.sourcePort(),
      );
      expect((await port.lookup(r, signal())).phase).toBe('outcome_unknown');
    }
    for (const identity of [{ subjectId: 'foreign_owner' }, { storeId: 'foreign_store' }]) {
      const client = { ...f.tracked, serverInfo: { ...f.client.serverInfo!, ...identity } };
      const port = createTuiMcpReconnectionPort(
        client,
        f.storeId,
        { connection: f.connectionJournal, reconnection: f.journal },
        f.sourcePort(),
      );
      const before = f.counts().wireHttp;
      expect((await port.lookup(r, signal())).phase).toBe('outcome_unknown');
      await expect(port.observe(carrier(r), signal())).rejects.toThrow();
      expect(f.counts().wireHttp).toEqual(before);
    }
    expect(f.counts().wireHttp.filter((row) => row.method === 'POST').length).toBe(postCount);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
  } finally {
    await f.close();
  }
}, 30000);

// Fault boundary: the real caller durably prepares its original request, then loses
// the pre-POST continuation. This grants no producer receipt or transport permit.
test('durable unknown original R prevents a different new R while exact original holder stays live', async () => {
  const f = await reconnectionHostFixture();
  try {
    const a = await f.ordinary('fence_holder_A');
    const ready = await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const original = reconnect(observed, 'durable_unknown_R');
    const record = createMcpReconnectionRecord(original, f.client.serverInfo!.subjectId!);
    expect(f.journal.prepare(record)).toBe(true);
    f.journal.record(record, 'outcome_unknown');
    const path = join(f.profile.profilePath, 'ui/mcp-reconnection-intents.json');
    const bytes = readFileSync(path);
    const before = f.counts();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const competing = reconnect(observed, 'different_new_R');
    expect((await f.port().submit(competing, observed)).phase).toBe('outcome_unknown');
    expect(f.journal.list()).toEqual([{ ...record, phase: 'outcome_unknown' }]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(f.counts().wireHttp.filter((row) => row.method === 'POST')).toEqual(
      before.wireHttp.filter((row) => row.method === 'POST'),
    );
    expect(f.counts().rpc).toEqual(before.rpc);
    expect((await f.store.getExecution(ready.fact!.connection!.id))?.status).toBe('running');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
  } finally {
    await f.close();
  }
}, 30000);
