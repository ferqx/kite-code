import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

async function fixture() {
  const dataRoot = temporaryDirectory('kite-message-changes-');
  const store = await openSqliteStore({ dataRoot, profile: 'isolated' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///isolated',
    name: 'test',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'history',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'original task' },
  });
  const owner = (await store.acquireSessionOwner('s', 'test-host'))!;
  const run = await store.startRun({
    expectedStoreId,
    owner,
    commandId: 'work',
    configuration: {},
  });
  await store.planExecution({
    expectedStoreId,
    owner,
    sessionId: 's',
    runId: run.id,
    executionId: 'model',
    originCommandId: 'work',
    stepId: 'model',
    callId: 'model',
    kind: 'model',
    definitionId: 'model',
    definitionVersion: '1',
    input: {},
    decisionSource: {},
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'model',
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source: {} },
  });
  const db = new Database(join(dataRoot, 'isolated', 'core.db'));
  const ops = new SqliteOperations(db, false);
  return {
    store,
    db,
    ops,
    owner,
    expectedStoreId,
    run,
    async close() {
      ops.releaseStatements();
      db.close();
      await store.close();
    },
  };
}

test('durable changes read only same-seq partial updates beyond 5000 historical messages, including replay and worker reopen', async () => {
  const f = await fixture();
  try {
    f.ops.tx(() => {
      for (let index = 0; index < 5001; index++)
        f.ops.appendMessage(
          's',
          f.run.id,
          { content: `saved-${index}` },
          'assistant',
          'complete',
          `old-${index}`,
        );
    });
    const partial = (content: string) =>
      f.store.persistModelPartial({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: 'model',
        content,
      });
    await partial('first');
    const before = await f.store.getView('s');
    const original = (await f.store.listMessages('s', { afterSeq: '5000', limit: 200 })).find(
      (message) => message.id === 'partial_model',
    )!;
    await partial('first second');
    await partial('first second third');
    const after = await f.store.getView('s');
    expect(after.session.nextSeq).toBe(before.session.nextSeq);
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      afterCursor: before.snapshotCursor,
      upperCursor: after.snapshotCursor,
      upperSeq: after.session.nextSeq,
    };
    const page = await f.store.listMessageChanges(input);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      id: original.id,
      seq: original.seq,
      content: 'first second third',
    });
    expect(page.nextCursor).toBe(after.snapshotCursor);
    expect(page.removedIds).toEqual([]);
    expect(await f.store.listMessageChanges(input)).toEqual(page);
    const empty = await f.store.listMessageChanges({ ...input, afterCursor: page.nextCursor });
    expect(empty.messages).toEqual([]);
    expect(empty.nextCursor).toBe(page.nextCursor);
    const { metadata } = await f.store.getChanges({ after: '0', limit: 1 });
    expect(metadata.lastChangeCursor).toBe(after.snapshotCursor);
    // A new SQLite reader uses persisted events; no in-memory SSE journal is required.
    const reopened = new SqliteOperations(f.db, false);
    try {
      expect(reopened.call('listMessageChanges', [input])).toEqual(page);
    } finally {
      reopened.releaseStatements();
    }
  } finally {
    await f.close();
  }
});

test('metadata changes re-project old dependent rows and cursor pages advance even when no public row exists', async () => {
  const f = await fixture();
  try {
    f.ops.tx(() => {
      for (let index = 0; index < 5; index++)
        f.ops.appendMessage(
          's',
          f.run.id,
          { content: 'input', sourceIds: ['work'] },
          'user',
          'complete',
          `dependent-${index}`,
        );
    });
    const before = await f.store.getView('s');
    f.ops.tx(() => f.ops.event('foreign', 'name', 'session.renamed'));
    const after = await f.store.getView('s');
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      afterCursor: before.snapshotCursor,
      upperCursor: after.snapshotCursor,
      upperSeq: after.session.nextSeq,
      limit: 2,
    };
    let afterSeq = '0';
    const ids: string[] = [];
    for (;;) {
      const page = await f.store.listMessageChanges({ ...input, afterSeq });
      ids.push(...page.messages.map((message) => message.id));
      expect(page.nextCursor).toBe(after.snapshotCursor);
      if (page.nextAfterSeq === null) break;
      expect(BigInt(page.nextAfterSeq)).toBeGreaterThan(BigInt(afterSeq));
      afterSeq = page.nextAfterSeq;
    }
    expect(new Set(ids).size).toBe(6);
    expect(ids).toContain('dependent-0');
    f.ops.tx(() => {
      for (let index = 0; index < 405; index++)
        f.ops.event('foreign', `foreign-${index}`, 'message.updated');
    });
    const head = await f.store.getView('s');
    let cursor = after.snapshotCursor,
      batches = 0;
    while (cursor !== head.snapshotCursor) {
      const page = await f.store.listMessageChanges({
        ...input,
        afterCursor: cursor,
        upperCursor: head.snapshotCursor,
      });
      expect(page.messages).toEqual([]);
      expect(BigInt(page.nextCursor)).toBeGreaterThan(BigInt(cursor));
      cursor = page.nextCursor;
      batches++;
    }
    expect(batches).toBe(3);
  } finally {
    await f.close();
  }
});

test('Store mismatch, expired/ahead cursors and collected history cannot masquerade as continuous changes', async () => {
  const f = await fixture();
  const rejects = async (promise: Promise<unknown>, code: string) => {
    let failure: unknown;
    try {
      await promise;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code });
  };
  try {
    const view = await f.store.getView('s');
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      afterCursor: view.snapshotCursor,
      upperCursor: view.snapshotCursor,
      upperSeq: view.session.nextSeq,
    };
    await rejects(
      f.store.listMessageChanges({ ...input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejects(
      f.store.listMessageChanges({ ...input, upperCursor: '9223372036854775807' }),
      'cursor_ahead',
    );
    f.ops.tx(() => f.ops.event('s', 's', 'session.history_collected'));
    const after = await f.store.getView('s');
    await rejects(
      f.store.listMessageChanges({ ...input, upperCursor: after.snapshotCursor }),
      'cursor_expired',
    );
    f.db.run('UPDATE storage_meta SET replay_floor=?', [after.snapshotCursor]);
    await rejects(f.store.listMessageChanges(input), 'cursor_expired');
  } finally {
    await f.close();
  }
});
