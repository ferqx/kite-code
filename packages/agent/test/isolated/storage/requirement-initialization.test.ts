import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';

async function rejected(promise: Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-initialization-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///temporary',
    name: 'w',
  });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'initialize metadata' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const configuration = {
    extensions: [
      { id: 'fixture', version: '1' },
      { id: 'other', version: '2' },
    ],
    tools: [{ id: 'parent', version: '1', extensionId: 'fixture' }],
  };
  const run = await store.startRun({ ...write, commandId: 'work', configuration });
  const initialize = (key: string, value: Json = { actual: 'metadata' }, extensionId = 'fixture') =>
    store.initializeRunRecord({
      ...write,
      runId: run.id,
      extensionId,
      write: { key, contentType: 'fixture.initial', contentVersion: 3, value },
    });
  const key = (suffix: string) => `run/${run.id}/${suffix}`;
  const cursor = async () => (await store.getMetadata()).lastChangeCursor;
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  const authorization = {
    allowed: true,
    revision: '1',
    definitionVersion: '1',
    inputDigest: await semanticDigest({}),
  };
  const plan = (executionId: string) =>
    store.planExecution({
      ...write,
      executionId,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: executionId,
      callId: executionId,
      definitionId: 'parent',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
  const db = new Database(join(dataRoot, 'new', 'core.db'));
  return {
    store,
    profile,
    base,
    write,
    run,
    configuration,
    initialize,
    key,
    cursor,
    source,
    authorization,
    plan,
    db,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('Run initialization seals manifest namespace and immutable metadata; first planned execution closes the retained port', async () => {
  const f = await fixture();
  try {
    const before = await f.cursor();
    const first = await f.initialize(f.key('one'));
    expect(first).toMatchObject({
      originStoreId: f.base.expectedStoreId,
      sessionId: 's',
      revision: '1',
      contentVersion: 3,
    });
    expect(BigInt(await f.cursor()) - BigInt(before)).toBe(1n);
    const cursor = await f.cursor();
    expect(await f.initialize(f.key('one'))).toEqual(first);
    await rejected(f.initialize(f.key('one'), { replacement: true }), 'record_revision_conflict');
    for (const change of [{ contentType: 'changed.type' }, { contentVersion: 4 }]) {
      await rejected(
        f.store.initializeRunRecord({
          ...f.write,
          runId: f.run.id,
          extensionId: 'fixture',
          write: {
            key: f.key('one'),
            contentType: 'fixture.initial',
            contentVersion: 3,
            value: first.value,
            ...change,
          },
        }),
        'record_revision_conflict',
      );
    }
    await rejected(
      f.store.initializeRunRecord({
        ...f.write,
        runId: f.run.id,
        extensionId: 'fixture',
        write: {
          key: f.key('forbidden-authority'),
          contentType: 'fixture.initial',
          contentVersion: 3,
          value: {},
          executable: true,
        } as Parameters<typeof f.store.initializeRunRecord>[0]['write'],
      }),
      'invalid_extension_record',
    );

    await rejected(
      f.initialize(f.key('unknown'), {}, 'not-in-manifest'),
      'extension_namespace_mismatch',
    );
    for (const key of ['run/another/one', `run/${f.run.id}/`, 'outside'])
      await rejected(f.initialize(key), 'invalid_extension_record');
    await rejected(f.initialize(f.key('oversized'), 'x'.repeat(32767)), 'invalid_extension_record');
    expect(await f.cursor()).toBe(cursor);
    await f.initialize(f.key('exact-byte-bound'), 'x'.repeat(32766));
    // The finite count is shared by all actual extension namespaces in this Run.
    for (let i = 2; i < 64; i++)
      await f.initialize(f.key(`entry-${i}`), { index: i }, i % 2 ? 'fixture' : 'other');
    const full = await f.cursor();
    await rejected(f.initialize(f.key('65'), {}, 'other'), 'requirement_limit');
    expect(await f.cursor()).toBe(full);
    expect(await f.initialize(f.key('one'))).toEqual(first);
    const planned = await f.plan('first-actual-execution');
    expect(planned.status).toBe('planned');
    const closed = await f.cursor();
    await rejected(f.initialize(f.key('one')), 'run_initialization_closed');
    await rejected(f.initialize(f.key('later')), 'run_initialization_closed');
    expect(await f.cursor()).toBe(closed);
    expect(
      (await f.store.getExtensionRecord({ ...f.base, extensionId: 'fixture', key: f.key('one') }))!
        .value,
    ).toEqual(first.value);
  } finally {
    await f.close();
  }
});

test('initialization checks Store/root owner and original cancellation, child carrier and ancestor boundaries', async () => {
  const f = await fixture();
  try {
    const input = {
      ...f.write,
      runId: f.run.id,
      extensionId: 'fixture',
      write: {
        key: f.key('guarded'),
        contentType: 'fixture.initial',
        contentVersion: 1,
        value: {},
      },
    };
    const cursor = await f.cursor();
    await rejected(
      f.store.initializeRunRecord({ ...input, expectedStoreId: 'different-store' }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.initializeRunRecord({ ...input, owner: { ...f.write.owner, generation: '999' } }),
      'owner_changed',
    );
    expect(await f.cursor()).toBe(cursor);
    await f.store.cancelCommand({
      ...f.base,
      commandId: 'cancel-original',
      targetCommandId: 'work',
    });
    const stopped = await f.cursor();
    await rejected(f.store.initializeRunRecord(input), 'cancelled_before_dispatch');
    expect(await f.cursor()).toBe(stopped);
  } finally {
    await f.close();
  }
  for (const stop of ['carrier', 'ancestor'] as const) {
    const c = await fixture();
    try {
      await c.plan('parent');
      await c.store.markDispatching({
        ...c.write,
        executionId: 'parent',
        authorization: c.authorization,
        requirements: [],
        freshness: { checked: true, source: c.source },
      });
      const child = await c.store.ensureOperation({
        ...c.write,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'work',
        parentExecutionId: 'parent',
        operationKey: 'child',
        cancellation: 'detached',
        request: { kind: 'agent', configurationId: 'child', input: {} },
        childConfiguration: { id: 'child', version: '1', snapshot: c.configuration },
      });
      await c.store.markDispatching({
        ...c.write,
        executionId: child.executionId!,
        authorization: c.authorization,
        requirements: [],
        freshness: { checked: true, source: c.source },
      });
      const actual = await c.store.activateChildRun({
        ...c.write,
        executionId: child.executionId!,
        configuration: c.configuration,
        requirementEvaluations: [],
        freshness: { checked: true, source: c.source },
      });
      const input = {
        ...c.write,
        runId: actual.run.id,
        extensionId: 'fixture',
        write: {
          key: `run/${actual.run.id}/own`,
          contentType: 'fixture.child',
          contentVersion: 1,
          value: { child: true },
        },
      };
      expect((await c.store.initializeRunRecord(input)).sessionId).toBe(actual.session.id);
      await rejected(
        c.store.initializeRunRecord({
          ...input,
          write: { ...input.write, key: c.key('parent-namespace') },
        }),
        'invalid_extension_record',
      );
      if (stop === 'carrier') {
        // Fault injection: foreign carrier provenance must not authorize child metadata.
        const beforeCarrierFault = await c.cursor();
        c.db
          .query('UPDATE execution SET origin_store_id=? WHERE id=?')
          .run('foreign-carrier', child.executionId!);
        await rejected(
          c.store.initializeRunRecord({
            ...input,
            write: { ...input.write, key: `run/${actual.run.id}/foreign-carrier` },
          }),
          'child_not_active',
        );
        expect(await c.cursor()).toBe(beforeCarrierFault);
        c.db
          .query('UPDATE execution SET origin_store_id=? WHERE id=?')
          .run(c.base.expectedStoreId, child.executionId!);
      }
      if (stop === 'carrier')
        await c.store.cancelWork({
          ...c.base,
          commandId: 'stop-carrier',
          kind: 'execution.cancel',
          executionId: child.executionId!,
        });
      else
        await c.store.cancelWork({
          ...c.base,
          commandId: 'stop-ancestor',
          kind: 'session.cancel',
          includeBackground: true,
        });
      const stopped = await c.cursor();
      await rejected(
        c.store.initializeRunRecord({
          ...input,
          write: { ...input.write, key: `run/${actual.run.id}/late` },
        }),
        'cancelled_before_dispatch',
      );
      expect(await c.cursor()).toBe(stopped);
    } finally {
      await c.close();
    }
  }
});

test('real event trigger rolls back initialization; readonly reopening and corrupted origin cannot relabel metadata', async () => {
  const f = await fixture();
  try {
    const cursor = await f.cursor();
    f.db.exec(
      "CREATE TRIGGER initialization_fault BEFORE INSERT ON change_event WHEN NEW.type='extension.record_updated' BEGIN SELECT RAISE(ABORT,'fixture-fault'); END",
    );
    let failed = false;
    try {
      await f.initialize(f.key('rollback'));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(
      await f.store.getExtensionRecord({
        ...f.base,
        extensionId: 'fixture',
        key: f.key('rollback'),
      }),
    ).toBeNull();
    expect(await f.cursor()).toBe(cursor);
    f.db.exec('DROP TRIGGER initialization_fault');
    const original = await f.initialize(f.key('saved'));
    const savedCursor = await f.cursor();
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        await readonly.getExtensionRecord({
          ...f.base,
          extensionId: 'fixture',
          key: f.key('saved'),
        }),
      ).toEqual(original);
      await rejected(
        readonly.initializeRunRecord({
          ...f.write,
          runId: f.run.id,
          extensionId: 'fixture',
          write: {
            key: f.key('readonly'),
            contentType: 'fixture.initial',
            contentVersion: 3,
            value: {},
          },
        }),
        'owner_changed',
      );
    } finally {
      await readonly.close();
    }
    expect(await f.cursor()).toBe(savedCursor);
    // Fault injection only: simulate restored foreign provenance, never fabricate executable qualification.
    f.db
      .query('UPDATE extension_record SET origin_store_id=? WHERE key=?')
      .run('foreign-original-store', f.key('saved'));
    await rejected(f.initialize(f.key('saved')), 'record_revision_conflict');
    expect(
      (await f.store.getExtensionRecord({
        ...f.base,
        extensionId: 'fixture',
        key: f.key('saved'),
      }))!.originStoreId,
    ).toBe('foreign-original-store');
    expect(await f.cursor()).toBe(savedCursor);
    f.db.query('UPDATE run SET origin_store_id=? WHERE id=?').run('foreign-run-store', f.run.id);
    await rejected(f.initialize(f.key('restored-run')), 'operation_unverifiable');
    expect(await f.cursor()).toBe(savedCursor);
  } finally {
    await f.close();
  }
});
