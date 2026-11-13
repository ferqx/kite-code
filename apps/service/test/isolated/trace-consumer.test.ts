import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import type { TraceEventBatch, TrajectoryEvent, TrajectoryPage } from '@kite-ai/trajectory';
import { afterEach, describe, expect, test } from '#kite-test';
import { testRuntimeFlags } from '../../../../scripts/tooling/test-command';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import {
  TraceConsumerCleanupError,
  TraceConsumerStore,
} from '../../src/trace-extensions/consumer-store';
import type { TraceEngineAssets } from '../../src/trace-extensions/engine';
import { engineDigest } from '../../src/trace-extensions/engine/assets';
import { buildTraceEngineAssets } from '../../src/trace-extensions/engine/build-assets';
import { projectTraceEvent } from '../../src/trace-extensions/projection';
import type { TraceGrant } from '../../src/trace-extensions/types';

const roots: string[] = [],
  stores: TraceConsumerStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scope = { storeId: 'read-store-secret', sessionId: 'session-secret' };
const grant: TraceGrant = {
  scopes: [scope],
  eventKinds: ['model'],
  evidenceKinds: [],
  origins: [],
  metadata: [],
  originalIdentity: false,
  allowHistory: true,
};
function setup(upper = '30', trusted = false) {
  const root = temporaryDirectory('kite-trace-consumer-');
  roots.push(root);
  const path = join(root, 'consumer.db'),
    store = new TraceConsumerStore(path);
  stores.push(store);
  const source = 'defineTraceExtension({onEvents(){}})';
  const install = trusted
    ? store.installTrusted.bind(store, 'opentelemetry')
    : store.install.bind(store);
  const id = install(
    {
      apiVersion: 1,
      name: 'fixture',
      history: true,
      eventKinds: ['model'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source, sha256: engineDigest(source) },
  );
  store.authorize(id, grant);
  store.enable(id);
  const partition = store.createPartition(id, scope, ['model'], upper, {
    exportId: 'export',
    fromCursor: '0',
  });
  const generation = store.nextGeneration(id);
  return { root, path, store, id, partition, generation };
}
function event(sequence: string): TrajectoryEvent {
  return {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
    sequence,
    origin: { storeId: 'origin-store-secret', cursor: sequence },
    sessionId: scope.sessionId,
    workspaceId: '/secret/workspace',
    executionId: 'execution-secret',
    parentExecutionId: 'parent-secret',
    operationId: 'operation-secret',
    runId: 'run-secret',
    sourceEventType: '/secret/path',
    sourceRecordRevision: '1',
    kind: 'model',
    phase: 'failed',
    recordedStatus: 'failed',
    occurredAt: 123,
    attributes: {
      commandId: 'command-secret',
      rootWorkCommandId: 'root-secret',
      definitionId: 'definition-secret',
      definitionVersion: 'secret-version',
      previousExecutionId: 'previous-secret',
      usage: { inputTokens: '10' },
    },
    identityConfidence: 'verified_origin',
    evidenceRefs: [
      {
        evidenceId: 'evidence-secret',
        contentVersion: 'version-secret',
        kind: 'model_output',
        availability: 'available',
        mediaType: 'text/secret',
      },
    ],
  };
}

test('message metadata uses an opaque original-source reference and requires an explicit evidence grant', () => {
  const input: TrajectoryEvent = {
    ...event('1'),
    kind: 'message',
    messageOriginStoreId: 'message-origin-secret',
    attributes: {
      messageId: 'message-secret',
      role: 'user',
      messageSeq: '2',
      revision: '1',
      status: 'complete',
    },
    evidenceRefs: [
      {
        evidenceId: 'message-evidence-secret',
        contentVersion: 'message-version-secret',
        kind: 'message',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  };
  const first = projectTraceEvent(
    input,
    { ...grant, eventKinds: ['message'] },
    'key',
    scope.storeId,
  );
  expect(first.kind).toBe('message');
  expect(first.evidenceRefs).toEqual([]);
  expect(JSON.stringify(first)).not.toContain('message-secret');
  expect(JSON.stringify(first)).not.toContain('message-origin-secret');
  expect(first.originalIdentity).toBeUndefined();
  const restored = projectTraceEvent(
    input,
    { ...grant, eventKinds: ['message'] },
    'key',
    'new-read-store',
  );
  expect(restored.attributes).toEqual(first.attributes);
  const authorized = projectTraceEvent(
    input,
    { ...grant, eventKinds: ['message'], evidenceKinds: ['message'] },
    'key',
    scope.storeId,
  );
  expect(authorized.evidenceRefs).toHaveLength(1);
  expect(authorized.evidenceRefs[0]!.evidenceId).not.toBe('message-evidence-secret');
  expect(authorized.evidenceRefs[0]!.mediaType).toBe('application/octet-stream');
});
function page(
  store: TraceConsumerStore,
  partition: string,
  sequences: string[],
  through: string,
): TrajectoryPage {
  const { limit: _, ...query } = store.requestFor(partition);
  return {
    ...query,
    events: sequences.map(event),
    scannedThrough: through,
    exhausted: through === query.upperCursor,
    integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
  };
}
function ack(batch: TraceEventBatch, ids = batch.events.map((item) => item.eventId)) {
  return {
    batchId: batch.batchId,
    leaseToken: batch.leaseToken,
    processGeneration: batch.processGeneration,
    subscriptionEpoch: batch.partition.subscriptionEpoch,
    acknowledgedEventIds: ids,
    rejected: [],
  };
}

async function killConsumerAt(input: {
  root: string;
  path: string;
  installationId: string;
  partitionId: string;
  mode: 'enqueue_before' | 'enqueue_after' | 'ack_before' | 'ack_after';
  page?: TrajectoryPage;
  assets?: TraceEngineAssets;
}) {
  const path = join(input.root, 'crash-input.json');
  writeFileSync(path, JSON.stringify(input));
  const child = spawn(
    process.execPath,
    [...testRuntimeFlags, join(import.meta.dirname, 'trace-consumer-crash.fixture.ts'), path],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '',
    buffer = '',
    receipt: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stderr.on('data', (bytes) => {
    stderr += String(bytes);
  });
  const exited = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      receipt = { code, signal };
      resolve();
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await new Promise<{
      mode: string;
      pid: number;
      sentEventIds: string[];
      synchronous: { synchronous: number };
      journal: { journal_mode: string };
    }>((resolve, reject) => {
      timer = setTimeout(() => reject(Error(`fixture_milestone_timeout:${stderr}`)), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(Error(`fixture_early_exit:${stderr}`)));
      child.stdout.on('data', (bytes) => {
        buffer += String(bytes);
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          try {
            resolve(JSON.parse(buffer.slice(0, end)));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    expect(observed.mode).toBe(input.mode);
    expect(observed.pid).toBe(child.pid!);
    expect(observed.synchronous.synchronous).toBe(2);
    expect(observed.journal.journal_mode).toBe('wal');
    child.kill('SIGKILL');
    await exited;
    expect(receipt).toEqual({ code: null, signal: 'SIGKILL' });
    return observed;
  } finally {
    if (timer) clearTimeout(timer);
    if (!receipt) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

describe('persistent Trace consumer state', () => {
  test.each([
    'enqueue_before',
    'enqueue_after',
    'ack_before',
    'ack_after',
  ] as const)('real process SIGKILL at %s preserves the committed consumer boundary', async (mode) => {
    const isEnqueue = mode.startsWith('enqueue');
    const { root, path, store, id, partition } = setup('3', !isEnqueue);
    store.enqueuePage(
      partition,
      page(store, partition, isEnqueue ? ['1'] : ['1', '2', '3'], isEnqueue ? '1' : '3'),
    );
    const nextPage = isEnqueue ? page(store, partition, ['2', '3'], '3') : undefined;
    const baseline = store.inspectPartition(partition);
    store.close();
    const observed = await killConsumerAt({
      root,
      path,
      installationId: id,
      partitionId: partition,
      mode,
      ...(nextPage
        ? { page: nextPage }
        : { assets: await buildTraceEngineAssets(join(root, 'assets')) }),
    });
    const reopened = new TraceConsumerStore(path);
    stores.push(reopened);
    const recovered = reopened.inspectPartition(partition);
    if (mode === 'enqueue_before') {
      expect(recovered.sourceScanPosition).toBe(baseline.sourceScanPosition);
      expect(recovered.pending).toBe(1);
      expect(recovered.contiguousAcknowledgedPosition).toBe('0');
      expect(reopened.enqueuePage(partition, nextPage!).accepted).toBe(true);
    } else if (mode === 'enqueue_after') {
      expect(recovered.sourceScanPosition).toBe('3');
      expect(recovered.pending).toBe(3);
      expect(recovered.contiguousAcknowledgedPosition).toBe('0');
    }
    if (mode === 'ack_after') {
      expect(recovered.sourceScanPosition).toBe('3');
      expect(recovered.contiguousAcknowledgedPosition).toBe('3');
      expect(recovered.pending).toBe(0);
      expect(reopened.lease(partition, reopened.nextGeneration(id))).toBeNull();
      expect(recovered.deliveryComplete).toBe(true);
    } else {
      const batch = reopened.lease(partition, reopened.nextGeneration(id))!;
      expect(batch.events.map((item) => item.eventId)).toEqual(
        ['1', '2', '3'].map((value) => event(value).eventId),
      );
      if (mode === 'ack_before') {
        expect(batch.events.map((item) => item.eventId)).toEqual(observed.sentEventIds);
        expect(recovered.contiguousAcknowledgedPosition).toBe('0');
        expect(recovered.pending).toBe(3);
      }
      reopened.acknowledge(partition, ack(batch));
      expect(reopened.inspectPartition(partition).deliveryComplete).toBe(true);
    }
  }, 15000);

  test('real SQLITE_FULL rolls back enqueue and ACK while independent Runtime admission continues', async () => {
    const { root, store, id, partition, generation } = setup('300');
    store.enqueuePage(partition, page(store, partition, ['1'], '1'));
    const lease = store.lease(partition, generation)!,
      response = ack(lease),
      before = store.inspectPartition(partition);
    const db = Reflect.get(store, 'db') as Database;
    db.exec('CREATE TABLE fixture_disk_pressure(payload BLOB NOT NULL)');
    const count = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
    db.exec(`PRAGMA max_page_count=${count + 8}`);
    let fillError: unknown;
    for (let index = 0; index < 100; index++) {
      try {
        db.run('INSERT INTO fixture_disk_pressure VALUES(zeroblob(4096))');
      } catch (error) {
        fillError = error;
        break;
      }
    }
    expect(fillError).toMatchObject({ code: 'SQLITE_FULL' });
    const sourcePage = page(
      store,
      partition,
      Array.from({ length: 200 }, (_, index) => String(index + 2)),
      '201',
    );
    let enqueueError: unknown;
    try {
      store.enqueuePage(partition, sourcePage);
    } catch (error) {
      enqueueError = error;
    }
    expect(enqueueError).toMatchObject({ code: 'SQLITE_FULL' });
    expect(store.inspectPartition(partition)).toEqual(before);
    db.exec(
      "CREATE TEMP TRIGGER fixture_ack_full AFTER UPDATE OF state ON pending WHEN NEW.state='acknowledged' BEGIN INSERT INTO fixture_disk_pressure VALUES(zeroblob(65536)); END",
    );
    let ackError: unknown;
    try {
      store.acknowledge(partition, response);
    } catch (error) {
      ackError = error;
    }
    expect(ackError).toMatchObject({ code: 'SQLITE_FULL' });
    expect(store.inspectPartition(partition)).toEqual(before);
    const authority = await openSqliteStore({
        dataRoot: join(root, 'authority'),
        profile: 'independent',
      }),
      model = createFixedModel([]);
    const runtime = createRuntime({
      store: authority,
      model,
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'fixture' };
        },
      },
    });
    try {
      const metadata = await runtime.getMetadata();
      await runtime.createWorkspace({
        expectedStoreId: metadata.storeId,
        id: 'workspace',
        rootUri: 'file:///fixture',
        name: 'fixture',
      });
      await runtime.createSession({
        expectedStoreId: metadata.storeId,
        sessionId: 'during-consumer-full',
        commandId: 'create',
        workspaceId: 'workspace',
        title: 'Consumer disk full does not hold Runtime',
        subjectId: 'actor',
      });
      expect(BigInt((await runtime.getMetadata()).lastChangeCursor)).toBeGreaterThan(
        BigInt(metadata.lastChangeCursor),
      );
      expect(model.requests).toHaveLength(0);
    } finally {
      await runtime.close();
    }
    db.exec(
      'DROP TRIGGER fixture_ack_full; DELETE FROM fixture_disk_pressure; PRAGMA max_page_count=1073741823',
    );
    store.acknowledge(partition, response);
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('1');
    expect(store.enqueuePage(partition, sourcePage).accepted).toBe(true);
    const retry = store.lease(partition, store.nextGeneration(id))!;
    expect(retry.events.map((item) => item.eventId)).toEqual(
      sourcePage.events.map((item) => item.eventId),
    );
    expect(store.inspectPartition(partition).sourceScanPosition).toBe('201');
  });

  test('a sealed Run start keeps its closed public start classification without exposing free source types', () => {
    const input = {
      ...event('1'),
      kind: 'run' as const,
      phase: 'observed' as const,
      sourceEventType: 'run.started',
      attributes: {},
    };
    expect(projectTraceEvent(input, grant, 'key', scope.storeId).sourceEventType).toBe(
      'run.started',
    );
    expect(
      projectTraceEvent(
        { ...input, sourceEventType: 'PRIVATE_SOURCE_TYPE' },
        grant,
        'key',
        scope.storeId,
      ).sourceEventType,
    ).toBe('run.observed');
    expect(
      projectTraceEvent({ ...input, kind: 'model' }, grant, 'key', scope.storeId).sourceEventType,
    ).toBe('model.observed');
  });
  test('entity origins distinguish equal IDs and preserve proven execution relations across restore', () => {
    const original = {
      ...event('1'),
      executionOriginStoreId: 'entity-origin-A',
      runOriginStoreId: 'run-origin-A',
      operationOriginStoreId: 'operation-origin-A',
      parentExecutionOriginStoreId: 'parent-origin-A',
    };
    const first = projectTraceEvent(original, grant, 'fixture-key', 'read-before');
    const restored = projectTraceEvent(
      { ...original, origin: { storeId: 'new-fact-store', cursor: '2' } },
      grant,
      'fixture-key',
      'read-after',
    );
    expect(first.scope.executionRef).toBe(restored.scope.executionRef);
    expect(first.scope.runRef).toBe(restored.scope.runRef);
    expect(first.scope.operationRef).toBe(restored.scope.operationRef);
    expect(first.scope.parentExecutionRef).toBe(restored.scope.parentExecutionRef);
    expect(first.scope.storeRef).not.toBe(restored.scope.storeRef);
    const foreign = projectTraceEvent(
      { ...original, executionOriginStoreId: 'foreign-entity-origin' },
      grant,
      'fixture-key',
      'read-before',
    );
    expect(first.scope.executionRef).not.toBe(foreign.scope.executionRef);
    expect(JSON.stringify(first)).not.toContain('entity-origin-A');
  });
  test('filtered source positions and partial ACK retain the real unacknowledged prefix', () => {
    const { store, partition, generation } = setup();
    expect(store.enqueuePage(partition, page(store, partition, ['3', '8', '15'], '20'))).toEqual({
      accepted: true,
      queued: 3,
    });
    expect(store.inspectPartition(partition).sourceScanPosition).toBe('20');
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('2');
    const first = store.lease(partition, generation, 0)!;
    expect(store.lease(partition, generation, 0)).toBeNull();
    store.acknowledge(
      partition,
      ack(
        first,
        first.events.slice(1).map((item) => item.eventId),
      ),
      0,
    );
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('2');
    const retry = store.lease(partition, generation, 10000)!;
    expect(retry.events.map((item) => item.sequence)).toEqual(['3']);
    store.acknowledge(partition, ack(retry), 10000);
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('20');
    expect(store.enqueuePage(partition, page(store, partition, [], '30')).queued).toBe(0);
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('30');
    expect(store.inspectPartition(partition).deliveryComplete).toBe(true);
  });

  test('the whole ACK response is validated before any member changes', () => {
    const { store, partition, generation } = setup();
    store.enqueuePage(partition, page(store, partition, ['1', '2'], '30'));
    const first = store.lease(partition, generation)!;
    for (const response of [
      ack(first, [first.events[0]!.eventId, 'foreign']),
      ack(first, [first.events[0]!.eventId, first.events[0]!.eventId]),
      { ...ack(first), leaseToken: 'old' },
      { ...ack(first), rejected: [{ eventId: first.events[0]!.eventId, reason: 'retry' }] },
    ]) {
      expect(() => store.acknowledge(partition, response)).toThrow();
      expect(store.inspectPartition(partition).pending).toBe(2);
      expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('0');
    }
    store.acknowledge(partition, ack(first));
    expect(store.inspectPartition(partition).deliveryComplete).toBe(true);
  });

  test('a failed SQLite enqueue transaction advances neither membership nor scan', () => {
    const { store, partition, path } = setup();
    const fault = new Database(path);
    const originalPrepare = Database.prototype.prepare;
    const statements: ReturnType<Database['prepare']>[] = [];
    fault.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON pending WHEN NEW.sequence='2' BEGIN SELECT RAISE(ABORT,'fixture_write_failure'); END;",
    );
    try {
      Database.prototype.prepare = function <
        Row,
        Params extends import('@kite-ai/agent/runtime-sqlite').SQLQueryBindings[],
      >(sql: string) {
        const stmt = (originalPrepare<Row, Params>).call(this, sql);
        statements.push(stmt as ReturnType<Database['prepare']>);
        return stmt;
      };
      expect(() =>
        store.enqueuePage(partition, page(store, partition, ['1', '2'], '30')),
      ).toThrow();
    } finally {
      Database.prototype.prepare = originalPrepare;
    }
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements)
      expect(() => statement.get()).toThrow('native_sqlite_statement_finalized');
    expect(store.inspectPartition(partition).pending).toBe(0);
    expect(store.inspectPartition(partition).sourceScanPosition).toBe('0');
    fault.exec('DROP TRIGGER fail_second');
    fault.close();
    expect(store.enqueuePage(partition, page(store, partition, ['1', '2'], '30')).queued).toBe(2);
  });
  test('startup lock failure closes its original connection and retains it if close is unconfirmed', () => {
    const { path } = setup();
    const blocker = new Database(path);
    blocker.exec('BEGIN IMMEDIATE');
    const originalClose = Database.prototype.close;
    const attempted: Database[] = [];
    try {
      Database.prototype.close = function (...args) {
        attempted.push(this);
        return originalClose.apply(this, args);
      };
      expect(() => new TraceConsumerStore(path)).toThrow('database is locked');
      expect(attempted).toHaveLength(1);
      expect(() => attempted[0]!.query('SELECT 1').get()).toThrow();
      Database.prototype.close = function () {
        attempted.push(this);
        throw Error('fixture_close_unknown');
      };
      let failure: unknown;
      try {
        new TraceConsumerStore(path);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TraceConsumerCleanupError);
      expect(JSON.stringify(failure)).toBe('{"code":"trace_consumer_cleanup_unconfirmed"}');
      expect((failure as Error).cause).toMatchObject({
        database: attempted[1],
        originalError: { message: 'database is locked' },
        cleanupError: { message: 'fixture_close_unknown' },
      });
    } finally {
      Database.prototype.close = originalClose;
      blocker.exec('ROLLBACK');
      blocker.close();
      if (attempted[1]) originalClose.call(attempted[1]);
    }
  });

  test('consumer lock contention fails immediately and leaves the source checkpoint unchanged', () => {
    const { store, partition, path } = setup();
    const blocker = new Database(path);
    blocker.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      expect(() => store.enqueuePage(partition, page(store, partition, ['1'], '30'))).toThrow();
      expect(performance.now() - started).toBeLessThan(300);
      expect(store.inspectPartition(partition).pending).toBe(0);
      expect(store.inspectPartition(partition).sourceScanPosition).toBe('0');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    expect(store.enqueuePage(partition, page(store, partition, ['1'], '30')).accepted).toBe(true);
  });

  test('reopen retires the old lease and preserves safe copied events after source deletion', () => {
    const { store, partition, generation, path } = setup();
    store.enqueuePage(partition, page(store, partition, ['1', '5'], '20'));
    const old = store.lease(partition, generation)!;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new TraceConsumerStore(path);
    stores.push(reopened);
    expect(() => reopened.acknowledge(partition, ack(old))).toThrow('trace_lease_stale');
    reopened.markSourceUnavailable(partition);
    const copied = reopened.lease(partition, generation)!;
    expect(copied.events).toEqual(old.events);
    reopened.acknowledge(partition, ack(copied));
    expect(reopened.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('20');
    expect(reopened.inspectPartition(partition).integrity.reasons).toEqual(['source_unavailable']);
    expect(reopened.inspectPartition(partition).deliveryComplete).toBe(false);
    expect(() => reopened.requestFor(partition)).toThrow('trace_permission_revoked');
  });

  test('dead letter blocks its partition until explicit retry and cannot silently skip', () => {
    const { store, partition, generation } = setup();
    store.enqueuePage(partition, page(store, partition, ['2', '9'], '30'));
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = store.lease(partition, generation, attempt * 1000000)!;
      expect(current.events.map((item) => item.sequence)).toEqual(['2', '9']);
      store.deliveryFailed(partition, attempt * 1000000);
    }
    expect(store.inspectPartition(partition).deadLetter).toBe(2);
    expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('1');
    expect(store.lease(partition, generation, 100000000)).toBeNull();
    store.retryDeadLetter(partition);
    const retry = store.lease(partition, generation, 100000000)!;
    store.acknowledge(partition, ack(retry));
    expect(store.inspectPartition(partition).deliveryComplete).toBe(true);
  });

  test('queue budget refuses an entire page and preserves its original source position', () => {
    const { store, partition } = setup('5000');
    let previous = '0',
      refused = false;
    for (let start = 1; start <= 5000; start += 200) {
      const through = String(start + 199);
      const result = store.enqueuePage(
        partition,
        page(
          store,
          partition,
          Array.from({ length: 200 }, (_, index) => String(start + index)),
          through,
        ),
      );
      if (!result.accepted) {
        refused = true;
        expect(store.inspectPartition(partition).sourceScanPosition).toBe(previous);
        break;
      }
      previous = through;
    }
    expect(refused).toBe(true);
    expect(store.inspectPartition(partition).pending).toBeGreaterThan(0);
    expect(store.inspectPartition(partition).pending).toBeLessThanOrEqual(4000);
  });

  test('queued views contain no raw identities, path, free source strings or default evidence', () => {
    const { store, partition, generation } = setup();
    store.enqueuePage(partition, page(store, partition, ['1'], '30'));
    const view = store.lease(partition, generation)!.events[0]!;
    const encoded = JSON.stringify(view);
    expect(encoded).not.toContain('secret');
    expect(encoded).not.toContain('/');
    expect(view.evidenceRefs).toEqual([]);
    expect(view.originalIdentity).toBeUndefined();
    expect(view.recordedStatus).toBe('failed');
    expect(view.occurredAt).toBeNull();
    expect(view.scope.storeRef).not.toBe(view.origin.storeRef);
    expect(view.attributes).not.toHaveProperty('usage');
  });
});
