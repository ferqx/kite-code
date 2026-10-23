import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import { originalCompressionInput } from '../../../src/storage/sqlite/compression-inputs';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

async function fixture(initial?: { content: string; files?: { name: string; uri: string }[] }) {
  const root = temporaryDirectory('kite-retained-inputs-');
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'original' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', ...(initial ?? { content: 'Original human task' }) },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({ ...write, commandId: 'work', configuration: {} });
  const db = new Database(join(root, 'test/core.db'));
  let compressionCount = 0;
  async function steer(id: string, content = id, files?: { name: string; uri: string }[]) {
    await store.acceptCommand({
      ...base,
      commandId: id,
      request: {
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId: run.contextSelectionId,
        content,
        ...(files ? { files } : {}),
      },
    });
    return store.applyInput({ ...write, commandId: id, runId: run.id, kind: 'steer' });
  }
  function internal(id: string) {
    const { next_seq: seq } = db
      .query("UPDATE session SET next_seq=next_seq+1 WHERE id='s' RETURNING next_seq")
      .get() as { next_seq: number };
    const source = JSON.stringify({
      content: 'Low trust Agent data, not a human requirement',
      sourceIds: [id],
    });
    db.query(
      "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) VALUES(?,'s',?,?,'user','complete',?)",
    ).run(id, run.id, seq, source);
    db.query(
      "INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,0,'text',1,0,?)",
    ).run(id, source);
  }
  async function compress(target = run) {
    const executionId = `summary-${++compressionCount}`;
    const pending = await store.beginCompression({
      ...write,
      runId: target.id,
      executionId,
      expectedContextSelectionId: target.contextSelectionId,
      trigger: 'automatic',
      compressor: { id: 'fixture', version: '1', snapshot: null },
    });
    const input = { messages: [], tools: [] };
    const source = { kind: 'context_compression', compressionId: pending.id };
    await store.planExecution({
      ...write,
      executionId,
      sessionId: 's',
      runId: target.id,
      originCommandId: target.originCommandId,
      stepId: executionId,
      callId: executionId,
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
    await store.markDispatching({
      ...write,
      executionId,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await store.finishExecution({
      ...write,
      executionId,
      status: 'succeeded',
      result: { content: 'Summary deliberately omits human requirements' },
      message: {
        role: 'assistant',
        content: 'Summary deliberately omits human requirements',
        sourceIds: [executionId],
      },
    });
    return store.commitCompression({ ...write, runId: target.id, compressionId: pending.id });
  }
  return {
    root,
    profile,
    store,
    db,
    base,
    write,
    run,
    steer,
    internal,
    compress,
    close: async () => {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('model context retains exact human originals through repeated compression, pages across excluded internal users, and keeps selected/expanded contracts', async () => {
  const f = await fixture();
  try {
    f.internal('agent-note');
    const first = await f.steer('first', 'Use Blue.\nOriginal requirement 雪🙂');
    const before = await f.store.getModelContext(f.base);
    expect(before.retainedInputMessageIds).toEqual(
      before.messages
        .filter((m) => m.content !== 'Low trust Agent data, not a human requirement')
        .map((m) => m.id),
    );
    expect(before.retainedInputMessageIds).toContain(first.message.id);
    await f.compress();
    const second = await f.steer(
      'second',
      'Correction: use Green, preserve the earlier Unicode detail.',
    );
    await f.compress();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const raw = await f.store.listMessages('s');
    const paged = [];
    let afterSeq = '0',
      upperSeq: string | undefined;
    let emptyAdvances = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await f.store.getModelContext({
        ...f.base,
        messageLimit: 1,
        afterSeq,
        ...(upperSeq ? { upperSeq } : {}),
      });
      upperSeq ??= page.highWaterSeq;
      expect(page.retainedInputMessageIds).toEqual(page.messages.map((m) => m.id));
      paged.push(...page.messages);
      if (!page.nextAfterSeq) break;
      expect(BigInt(page.nextAfterSeq)).toBeGreaterThan(BigInt(afterSeq));
      if (!page.messages.length) emptyAdvances++;
      afterSeq = page.nextAfterSeq;
    }
    expect(emptyAdvances).toBeGreaterThan(0);
    expect(paged.map((m) => m.content)).toEqual([
      'Original human task',
      first.message.content,
      second.message.content,
    ]);
    expect(paged.map((m) => m.sourceIds)).toEqual([['work'], ['first'], ['second']]);
    expect((await f.store.getSelectedContext(f.base)).messages).toHaveLength(0);
    expect((await f.store.getExpandedContext(f.base)).messages.map((m) => m.content)).toContain(
      first.message.content,
    );
    expect(await f.store.listMessages('s')).toEqual(raw);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('covered spoofed or Agent-authored inputs cannot acquire retention, and retained bodies honor original Part and byte limits', async () => {
  const f = await fixture();
  try {
    const applied = await f.steer('guide', 'G'.repeat(3000));
    await f.compress();
    const original = f.db
      .query("SELECT request_digest,receipt_json FROM command WHERE id='guide'")
      .get() as { request_digest: string; receipt_json: string };
    const retained = async () => (await f.store.getModelContext(f.base)).retainedInputMessageIds;
    expect(await retained()).toContain(applied.message.id);
    for (const mutation of [
      () => f.db.query("UPDATE command SET request_digest=? WHERE id='guide'").run('damaged'),
      () =>
        f.db
          .query("UPDATE command SET receipt_json=? WHERE id='guide'")
          .run(JSON.stringify({ ...JSON.parse(original.receipt_json), messageId: 'wrong' })),
      () =>
        f.db
          .query("UPDATE command SET agent_source_execution_id=? WHERE id='guide'")
          .run('summary-1'),
    ]) {
      mutation();
      expect(await retained()).not.toContain(applied.message.id);
      f.db
        .query(
          "UPDATE command SET request_digest=?,receipt_json=?,agent_source_execution_id=NULL WHERE id='guide'",
        )
        .run(original.request_digest, original.receipt_json);
    }
    const budgetError = await f.store.getModelContext({ ...f.base, byteLimit: 1024 }).then(
      () => null,
      (error) => error,
    );
    expect(budgetError).toMatchObject({ code: 'context_item_too_large' });
    f.db
      .query('UPDATE message_part SET content_version=2 WHERE message_id=?')
      .run(applied.message.id);
    const partError = await f.store.getModelContext(f.base).then(
      () => null,
      (error) => error,
    );
    expect(partError).toMatchObject({ code: 'context_content_unsupported' });
    f.db
      .query('UPDATE message_part SET content_version=1 WHERE message_id=?')
      .run(applied.message.id);
  } finally {
    await f.close();
  }
});

test('sealed Fork copies retain their original human identity, rewinds do not revive excluded inputs, and cold reads write nothing', async () => {
  const f = await fixture();
  try {
    const applied = await f.steer('guide', 'Retain this exact human input');
    await f.compress();
    await f.store.finishRun({ ...f.write, runId: f.run.id, status: 'completed', requirements: [] });
    await f.store.forkSession({
      ...f.base,
      commandId: 'fork',
      sourceSessionId: 's',
      expectedContextSelectionId: f.run.contextSelectionId,
      newSessionId: 'fork',
      title: 'copy',
    });
    const fork = await f.store.getModelContext({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 'fork',
    });
    expect(fork.messages.map((m) => m.content)).toEqual([
      'Original human task',
      applied.message.content,
    ]);
    expect(fork.retainedInputMessageIds).toEqual(fork.messages.map((m) => m.id));
    expect(fork.messages.every((m) => m.runId === null)).toBe(true);
    const first = (await f.store.listMessages('s'))[0]!;
    await f.store.selectContext({
      ...f.base,
      commandId: 'rewind',
      expectedContextSelectionId: f.run.contextSelectionId,
      boundary: { messageId: first.id, seq: first.seq },
    });
    const selected = await f.store.getModelContext(f.base);
    expect(selected.messages.map((m) => m.content)).toEqual(['Original human task']);
    expect(selected.retainedInputMessageIds).toEqual([first.id]);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await cold.getModelContext(f.base)).toEqual(selected);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('explicit follow-up and a new Run retain selected inputs in order without task-text classification; fixed snapshots exclude later steering', async () => {
  const f = await fixture();
  try {
    const earlier = await f.steer('earlier', 'Keep independent instruction A');
    await f.compress();
    await f.store.finishRun({ ...f.write, runId: f.run.id, status: 'completed', requirements: [] });
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'follow',
      request: {
        kind: 'input.follow_up',
        afterRunId: f.run.id,
        contextSelectionId: f.run.contextSelectionId,
        content: 'New task: actual explicit follow-up, preserve the selected conversation',
      },
    });
    const next = await f.store.applyInput({
      ...f.write,
      commandId: 'follow',
      kind: 'follow_up',
      configuration: {},
    });
    const snapshot = await f.store.getModelContext(f.base);
    expect(snapshot.retainedInputMessageIds).toContain(next.message.id);
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'later',
      request: {
        kind: 'input.steer',
        targetRunId: next.run.id,
        contextSelectionId: next.run.contextSelectionId,
        content: 'Correction B is newer; A remains independently applicable',
      },
    });
    const later = await f.store.applyInput({
      ...f.write,
      commandId: 'later',
      kind: 'steer',
      runId: next.run.id,
    });
    const frozen = await f.store.getModelContext({ ...f.base, upperSeq: snapshot.highWaterSeq });
    expect(frozen.retainedInputMessageIds).toEqual(snapshot.retainedInputMessageIds);
    expect(frozen.messages.some((m) => m.id === later.message.id)).toBe(false);
    await f.compress(next.run);
    const selected = await f.store.getModelContext(f.base);
    expect(selected.messages.map((m) => m.content)).toEqual([
      'Original human task',
      earlier.message.content,
      next.message.content,
      later.message.content,
    ]);
    expect(selected.retainedInputMessageIds).toEqual(selected.messages.map((m) => m.id));
    expect(new Set(selected.retainedInputMessageIds).size).toBe(4);
  } finally {
    await f.close();
  }
});

test('attachment-only originals retain their unchanged references and unexpected storage failures never become an exclusion', async () => {
  const files = [{ name: 'only.txt', uri: 'file:///fixture/only.txt' }];
  const f = await fixture({ content: '', files });
  try {
    const guide = await f.steer('files-only', '', files);
    await f.compress();
    const page = await f.store.getModelContext(f.base);
    expect(page.messages).toHaveLength(2);
    expect(page.retainedInputMessageIds).toEqual(page.messages.map((m) => m.id));
    for (const input of page.messages) {
      expect(input.content).toBe('');
      expect(input.files).toEqual(files);
    }
    const raw = f.db
      .query<Record<string, string | number | bigint | null>, [string]>(
        'SELECT * FROM message WHERE id=?',
      )
      .get(guide.message.id)!;
    const operations = new SqliteOperations(f.db, true);
    operations.row = () => {
      throw Error('unexpected SQLite read failure');
    };
    expect(() => originalCompressionInput(operations, raw, 'owner')).toThrow(
      'unexpected SQLite read failure',
    );
  } finally {
    await f.close();
  }
});
