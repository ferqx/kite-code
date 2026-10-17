import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

for (const ended of [false, true])
  test(`rollback failure preserves both errors and ${ended ? 'confirmed rollback remains usable' : 'unconfirmed transaction isolates reads and writes'}`, () => {
    const native = new Database(':memory:');
    native.run('CREATE TABLE effect(id TEXT PRIMARY KEY)');
    const business = new Error('original business failure');
    const rollback = new Error('actual rollback failure');
    let armed = true;
    const database = new Proxy(native, {
      get(target, key) {
        if (key === 'run')
          return (sql: string, ...args: unknown[]) => {
            if (sql === 'ROLLBACK' && armed) {
              armed = false;
              if (ended) target.run(sql);
              throw rollback;
            }
            return Reflect.apply(target.run, target, [sql, ...args]);
          };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const operations = new SqliteOperations(database, false);
    try {
      let failure: unknown;
      try {
        operations.tx(() => {
          operations.run("INSERT INTO effect VALUES('once')");
          throw business;
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([business, rollback]);
      expect((failure as Error).cause).toBe(business);
      expect(native.inTransaction).toBe(!ended);
      if (ended) {
        expect(operations.row('SELECT count(*) AS count FROM effect')?.count).toBe(0n);
        operations.tx(() => operations.run("INSERT INTO effect VALUES('later')"));
      } else {
        expect(() => operations.row('SELECT * FROM effect')).toThrow(
          'storage_transaction_unconfirmed',
        );
        expect(() =>
          operations.tx(() => operations.run("INSERT INTO effect VALUES('replay')")),
        ).toThrow('storage_transaction_unconfirmed');
      }
    } finally {
      operations.releaseStatements();
      native.close(true);
    }
  });

for (const mode of [
  'fault-write',
  'fault-read',
  'fault-read-helper',
  'unfinished-success',
] as const)
  test(`real Worker ${mode} cannot ACK or reuse an unconfirmed transaction and strict close returns actual writer/owner resources`, async () => {
    const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openSqliteStore } = await import('../../../src/sqlite');
    const { acquireProfileAccess } = await import('../../../src/platform/profile');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-transaction-isolation-')));
    const NativeWorker = globalThis.Worker;
    const received: {
      id: number;
      result?: unknown;
      error?: { code: string; message: string; errors?: unknown[] };
      fixture: {
        attempts: number;
        rollbacks: number;
        closes: number;
        transactionBeforeClose: boolean;
      };
    }[] = [];
    class FaultWorker extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof NativeWorker>) {
        super(new URL('./transaction-isolation-worker-fixture.ts', import.meta.url).href, args[1]);
        this.addEventListener('message', (event: MessageEvent) => received.push(event.data));
      }
    }
    globalThis.Worker = FaultWorker;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let observer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let peer: Database | undefined;
    try {
      store = await openSqliteStore({ dataRoot: root, profile: 'owned' });
      globalThis.Worker = NativeWorker;
      observer = await openSqliteStore({ dataRoot: root, profile: 'owned' });
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: 'file:///w' });
      await store.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'isolation',
      });
      const owner = (await store.acquireSessionOwner('s', 'host'))!;
      peer = new Database(join(root, 'owned', 'core.db'));
      peer.run('PRAGMA busy_timeout=0');
      const failure = await (mode === 'fault-read'
        ? store.getView(mode)
        : mode === 'fault-read-helper'
          ? store.readExecutionGroupSafety({ expectedStoreId, sessionId: mode, subjectId: 'owner' })
          : store.getWorkspace(mode)
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'storage_transaction_unconfirmed' });
      expect(received.at(-1)?.result).toBeUndefined();
      expect(received.at(-1)?.fixture.attempts).toBe(1);
      if (mode !== 'unfinished-success') {
        expect((failure as Error).message).toContain(
          mode === 'fault-read-helper'
            ? 'execution_group_scope_denied'
            : mode === 'fault-read'
              ? 'session_not_found'
              : 'original business failure',
        );
        expect((failure as Error).message).toContain('actual rollback failed');
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({
            code:
              mode === 'fault-read-helper'
                ? 'execution_group_scope_denied'
                : mode === 'fault-read'
                  ? 'session_not_found'
                  : 'fixture_business_failed',
          }),
          expect.objectContaining({ code: 'fixture_rollback_failed' }),
        ]);
        expect((failure as Error).cause).toMatchObject({
          code:
            mode === 'fault-read-helper'
              ? 'execution_group_scope_denied'
              : mode === 'fault-read'
                ? 'session_not_found'
                : 'fixture_business_failed',
        });
      }
      expect(
        await store.getWorkspace('dirty').then(
          () => 'dirty-read',
          (error: { code: string }) => error.code,
        ),
      ).toBe('storage_transaction_unconfirmed');
      expect(
        await store
          .createWorkspace({
            expectedStoreId,
            id: 'later',
            rootUri: 'file:///later',
            name: 'later',
          })
          .then(
            () => 'write',
            (error: { code: string }) => error.code,
          ),
      ).toBe('storage_transaction_unconfirmed');
      expect(
        await store.releaseSessionOwner(owner).then(
          () => 'released',
          (error: { code: string }) => error.code,
        ),
      ).toBe('storage_transaction_unconfirmed');
      expect(await observer.acquireSessionOwner('s', 'other')).toBeNull();
      expect(() =>
        acquireProfileAccess({ dataRoot: root, profile: 'owned' }, 'exclusive'),
      ).toThrow();
      expect(peer.query("SELECT id FROM workspace WHERE id='dirty'").get()).toBeNull();
      if (!mode.startsWith('fault-read')) expect(() => peer!.run('BEGIN IMMEDIATE')).toThrow();
      await store.close();
      store = undefined;
      expect(received.at(-1)?.fixture).toEqual({
        attempts: 1,
        rollbacks: mode === 'unfinished-success' ? 0 : 1,
        closes: 1,
        transactionBeforeClose: true,
      });
      peer.run('BEGIN IMMEDIATE');
      peer.run('ROLLBACK');
      expect(peer.query("SELECT id FROM workspace WHERE id IN ('dirty','later')").all()).toEqual(
        [],
      );
      const nextOwner = await observer.acquireSessionOwner('s', 'next');
      expect(nextOwner).not.toBeNull();
      await observer.releaseSessionOwner(nextOwner!);
      await observer.close();
      observer = undefined;
      const exclusive = acquireProfileAccess({ dataRoot: root, profile: 'owned' }, 'exclusive');
      exclusive.lock.release();
    } finally {
      globalThis.Worker = NativeWorker;
      await store?.close();
      await observer?.close();
      peer?.close(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

test('a real COMMIT followed by a thrown acknowledgment error is never replayed', () => {
  const native = new Database(':memory:');
  native.run('CREATE TABLE effect(id TEXT PRIMARY KEY)');
  const commit = new Error('fixture_commit_ack_lost');
  let armed = true;
  let callbacks = 0;
  const database = new Proxy(native, {
    get(target, key) {
      if (key === 'run')
        return (sql: string, ...args: unknown[]) => {
          const result = Reflect.apply(target.run, target, [sql, ...args]);
          if (sql === 'COMMIT' && armed) {
            armed = false;
            throw commit;
          }
          return result;
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const operations = new SqliteOperations(database, false);
  try {
    operations.beginRequest();
    let failure: unknown;
    try {
      operations.tx(() => {
        callbacks++;
        operations.run("INSERT INTO effect VALUES('once')");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(commit);
    expect((failure as Error).cause).toBe(commit);
    expect(native.inTransaction).toBe(false);
    operations.assertRequestSettled();
    expect(callbacks).toBe(1);
    expect(operations.row('SELECT count(*) AS count FROM effect')?.count).toBe(1n);
  } finally {
    operations.releaseStatements();
    native.close(true);
  }
});

test('Runtime closes an actually poisoned owner transaction only after normal work and configuration cleanup finish', async () => {
  const { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } = await import(
    'node:fs'
  );
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFixedModel } = await import('@kite-ai/ai');
  const { createRuntime } = await import('../../../src/runtime');
  const { openSqliteStore } = await import('../../../src/sqlite');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-runtime-transaction-isolation-')));
  const NativeWorker = globalThis.Worker;
  const received: {
    fixture?: { closes: number; rollbacks: number; transactionBeforeClose: boolean };
  }[] = [];
  class FaultWorker extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof NativeWorker>) {
      super(new URL('./transaction-isolation-worker-fixture.ts', import.meta.url).href, args[1]);
      this.addEventListener('message', (event: MessageEvent) => received.push(event.data));
    }
  }
  globalThis.Worker = FaultWorker;
  const store = await openSqliteStore({ dataRoot: root, profile: 'owned' });
  globalThis.Worker = NativeWorker;
  const observer = await openSqliteStore({ dataRoot: root, profile: 'owned' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: 'file:///w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'runtime isolation',
  });
  let effects = 0;
  const effectPath = join(root, 'effect.txt');
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'once', name: 'fixture.effect', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: 'text_delta', text: 'Complete once.' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  let disposals = 0;
  const runtime = createRuntime({
    store,
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'One harmless local effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              writeFileSync(effectPath, 'exact original effect');
              return { outcome: 'succeeded', content: 'effect completed' };
            },
          },
        ],
      },
    ],
    instanceId: 'host',
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'fixed',
        snapshot: {},
        async dispose() {
          disposals++;
        },
      };
    },
  });
  const peer = new Database(join(root, 'owned', 'core.db'));
  peer.run('PRAGMA busy_timeout=0');
  try {
    await store.getWorkspace('arm-owner-release-poison');
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Complete once.' },
    });
    const deadline = Date.now() + 5000;
    while (!received.some((item) => item.fixture?.rollbacks === 1)) {
      if (Date.now() > deadline) throw Error('runtime_poison_fixture_timeout');
      await Bun.sleep(1);
    }
    expect((await observer.getView('s')).runs).toMatchObject([{ status: 'completed' }]);
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    expect(readFileSync(effectPath, 'utf8')).toBe('exact original effect');
    expect(disposals).toBe(1);
    expect(() => peer.run('BEGIN IMMEDIATE')).toThrow();
    expect(await observer.acquireSessionOwner('s', 'other')).toBeNull();
    await runtime.close();
    expect(runtime.getLifecycleState()).toMatchObject({ state: 'closed', busy: false });
    expect(received.at(-1)?.fixture).toMatchObject({ closes: 1, transactionBeforeClose: true });
    peer.run('BEGIN IMMEDIATE');
    peer.run('ROLLBACK');
    const owner = await observer.acquireSessionOwner('s', 'new');
    expect(owner).not.toBeNull();
    await observer.releaseSessionOwner(owner!);
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    expect(readFileSync(effectPath, 'utf8')).toBe('exact original effect');
    expect(disposals).toBe(1);
  } finally {
    globalThis.Worker = NativeWorker;
    await runtime.close().catch(() => {});
    await store.close();
    await observer.close();
    peer.close(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
