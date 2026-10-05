import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStore } from '../../../src/sqlite';
import { readSessionLogs } from '../../../src/storage/session-logs';
import type { Json } from '../../../src/storage/types';

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw Error('expected rejection');
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-core-session-log-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'owned' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///PRIVATE_WORKSPACE_SECRET',
    name: 'PRIVATE_TITLE_SECRET',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: 'PRIVATE_TITLE_SECRET',
      subjectId: 'actor',
    });
  const db = new Database(join(dataRoot, 'owned', 'core.db'));
  const input = { expectedStoreId, sessionId: 's', subjectId: 'actor', afterCursor: '0' };
  const append = async (index: number, sessionId = 's') =>
    store.acceptCommand({
      expectedStoreId,
      commandId: `work-${index}`,
      sessionId,
      subjectId: 'actor',
      request: { kind: 'run.start', content: 'PRIVATE_RAW_INPUT_SECRET' },
    });
  return {
    store,
    input,
    db,
    dataRoot,
    append,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('fixed upper pages >200 real events, exact Session scope, current status drift and readonly cold observation', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 205; n++) await f.append(n);
    await f.append(999, 'other');
    const first = await f.store.getSessionLogs(f.input);
    expect(first.entries).toHaveLength(200);
    expect(first.complete).toBe(false);
    expect(first.nextAfterCursor).toBe(first.entries.at(-1)!.cursor);
    expect(first.entries.every((entry) => entry.sessionId === 's')).toBe(true);
    const actual = first.entries.find((entry) => entry.objectId === 'work-0')!;
    expect(actual.recordedStatus).toBe('accepted');
    expect(actual.occurredAt).toBeGreaterThan(0);
    expect(actual.details.commandId).toBe('work-0');
    const owner = (await f.store.acquireSessionOwner('s', 'owner'))!;
    await f.store.rejectCommand({
      expectedStoreId: f.input.expectedStoreId,
      owner,
      commandId: 'work-0',
      reason: 'PRIVATE_EXCEPTION_SECRET',
    });
    await f.append(206);
    const second = await f.store.getSessionLogs({
      ...f.input,
      afterCursor: first.nextAfterCursor!,
      upperCursor: first.upperCursor,
    });
    expect(second.complete).toBe(true);
    expect(second.nextAfterCursor).toBeNull();
    expect(second.upperCursor).toBe(first.upperCursor);
    expect(second.entries.some((entry) => entry.objectId === 'work-206')).toBe(false);
    expect(BigInt(second.snapshotCursor)).toBeGreaterThan(BigInt(first.upperCursor));
    const repeated = await f.store.getSessionLogs({ ...f.input, upperCursor: first.upperCursor });
    expect(repeated.entries.find((entry) => entry.cursor === actual.cursor)).toEqual(actual);
    const fresh = await f.store.getSessionLogs({ ...f.input, afterCursor: first.upperCursor });
    expect(fresh.entries.find((entry) => entry.type === 'command.rejected')!.recordedStatus).toBe(
      'rejected',
    );
    expect(JSON.stringify([first, second, fresh])).not.toContain('PRIVATE_');
    expect(f.db.query('SELECT COUNT(*) AS count FROM run').get()).toEqual({ count: 0 });
    expect(f.db.query('SELECT COUNT(*) AS count FROM execution').get()).toEqual({ count: 0 });
    await f.store.close();
    const cold = await openSqliteStore({
      dataRoot: f.dataRoot,
      profile: 'owned',
      mode: 'readonly',
    });
    try {
      const before = await cold.getMetadata();
      expect(
        (await cold.getSessionLogs({ ...f.input, upperCursor: first.upperCursor })).entries,
      ).toEqual(first.entries);
      expect(await cold.getMetadata()).toEqual(before);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('old, future and malformed private metadata stay locally unavailable and getChanges preserves only original payload', async () => {
  const f = await fixture();
  try {
    await f.append(1);
    const first = await f.store.getSessionLogs(f.input);
    const current = first.entries.find((entry) => entry.objectId === 'work-1')!;
    const row = f.db
      .query('SELECT payload_json FROM change_event WHERE cursor=?')
      .get(current.cursor) as { payload_json: string };
    const envelope = JSON.parse(row.payload_json);
    const original = {
      raw: 'PRIVATE_RAW_PAYLOAD_SECRET',
      nested: { credential: 'PRIVATE_HEADER_SECRET' },
    };
    for (const value of [
      original,
      { ...envelope, payload: original, version: 999 },
      { ...envelope, payload: original, occurredAt: null },
      {
        ...envelope,
        payload: original,
        snapshot: { ...envelope.snapshot, unknown: 'PRIVATE_SNAPSHOT_SECRET' },
      },
      { ...envelope, payload: original, snapshot: { ...envelope.snapshot, category: ['command'] } },
      {
        ...envelope,
        payload: original,
        snapshot: { ...envelope.snapshot, recordedStatus: ['accepted'] },
      },
      {
        ...envelope,
        payload: original,
        snapshot: { ...envelope.snapshot, details: { kind: ['model'] } },
      },
      { format: 'kite.session-log', version: 9 },
    ]) {
      f.db
        .query('UPDATE change_event SET payload_json=? WHERE cursor=?')
        .run(JSON.stringify(value), current.cursor);
      const logs = await f.store.getSessionLogs(f.input),
        entry = logs.entries.find((entry) => entry.cursor === current.cursor)!;
      expect(entry.occurredAt).toBeNull();
      expect(entry.recordedStatus).toBeNull();
      expect(entry.modelExecutionId).toBeNull();
      expect(entry.details).toEqual({});
      expect(entry.summary).toContain('metadata unavailable');
      expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
      const changes = await f.store.getChanges({ after: '0', sessionIds: ['s'] });
      const publicPayload = changes.events.find(
        (entry) => entry.cursor === current.cursor,
      )!.payload;
      expect(publicPayload).toEqual('raw' in value || 'payload' in value ? original : null);
      expect(JSON.stringify(publicPayload)).not.toContain('kite.session-log');
      expect(JSON.stringify(publicPayload)).not.toContain('PRIVATE_SNAPSHOT');
    }
  } finally {
    await f.close();
  }
});

test('Decimal64 watermarks, replay loss, subject/Store/scope and bounded inputs reject without writes', async () => {
  const f = await fixture();
  try {
    for (const change of [
      { expectedStoreId: 'foreign' },
      { subjectId: 'foreign' },
      { sessionId: 'missing' },
      { afterCursor: '00' },
      { afterCursor: '-1' },
      { upperCursor: '9223372036854775808' },
      { upperCursor: '0', afterCursor: '1' },
      { limit: 201 },
      { limit: 0 },
      { limit: 1.5 },
    ]) {
      let failure: unknown;
      try {
        await f.store.getSessionLogs({ ...f.input, ...change });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    }
    const cursor = '9007199254740993';
    f.db.query('UPDATE storage_meta SET last_change_cursor=?').run(cursor);
    await f.append(2);
    const page = await f.store.getSessionLogs({ ...f.input, afterCursor: cursor });
    expect(page.entries[0]!.cursor).toBe('9007199254740994');
    expect(page.upperCursor).toBe('9007199254740994');
    f.db.query('UPDATE storage_meta SET replay_floor=?').run(cursor);
    const before = await f.store.getMetadata();
    let expired: unknown;
    try {
      await f.store.getSessionLogs(f.input);
    } catch (error) {
      expired = error;
    }
    expect(expired).toMatchObject({ code: 'cursor_expired' });
    expect(
      (await f.store.getSessionLogs({ ...f.input, afterCursor: cursor })).entries,
    ).toHaveLength(1);
    expect(await f.store.getMetadata()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('real append transaction metadata and original payload roll back atomically', async () => {
  const f = await fixture();
  try {
    const before = await f.store.getMetadata();
    f.db.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON change_event WHEN NEW.type='command.accepted' BEGIN SELECT RAISE(ABORT,'owned fixture failure'); END",
    );
    expect(await rejection(f.append(7))).toBeInstanceOf(Error);
    expect(await f.store.getCommand('work-7')).toBeNull();
    expect(await f.store.getMetadata()).toEqual(before);
    expect(
      f.db.query("SELECT cursor FROM change_event WHERE object_id='work-7'").all(),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('model navigation captures real input metadata, not event name; old metadata cannot acquire navigation or current status', async () => {
  const f = await fixture();
  try {
    await f.append(0);
    const owner = (await f.store.acquireSessionOwner('s', 'owner'))!;
    const run = await f.store.startRun({
      expectedStoreId: f.input.expectedStoreId,
      owner,
      commandId: 'work-0',
      configuration: {},
    });
    for (const [executionId, kind, metadata] of [
      [
        'model',
        'model',
        {
          version: 1,
          adapter: { availability: 'unavailable', reason: 'adapter_opaque' },
          assembly: { extensions: [], tools: [], capabilitySnapshotDigest: null },
          context: {
            transformationId: 'kite.model-request',
            transformationVersion: '1',
            messageOrder: 'request.messages',
            sourceOrder: 'request.messages[].sourceIds',
            sources: [],
          },
        },
      ],
      ['tool', 'tool', undefined],
      ['unrecorded', 'model', undefined],
    ] as const)
      await f.store.planExecution({
        expectedStoreId: f.input.expectedStoreId,
        owner,
        executionId,
        sessionId: 's',
        runId: run.id,
        originCommandId: 'work-0',
        stepId: executionId,
        callId: executionId,
        kind,
        definitionId: 'fixed',
        definitionVersion: '1',
        input: { modelId: 'fixed', requestId: executionId, messages: [], tools: [] },
        decisionSource: { kind: 'model_decision', executionId: 'model', callId: executionId },
        modelMetadata: metadata as Json | undefined,
      });
    const page = await f.store.getSessionLogs(f.input);
    expect(page.entries.find((entry) => entry.objectId === 'model')!.modelExecutionId).toBe(
      'model',
    );
    expect(page.entries.find((entry) => entry.objectId === 'tool')!.modelExecutionId).toBeNull();
    expect(
      page.entries.find((entry) => entry.objectId === 'unrecorded')!.modelExecutionId,
    ).toBeNull();
    const model = page.entries.find((entry) => entry.objectId === 'model')!;
    f.db.query("UPDATE execution SET intent_json='{}',state='succeeded' WHERE id='model'").run();
    const drift = await f.store.getSessionLogs(f.input);
    expect(
      drift.entries.find((entry) => entry.cursor === model.cursor)!.modelExecutionId,
    ).toBeNull();
    expect(drift.entries.find((entry) => entry.cursor === model.cursor)!.recordedStatus).toBe(
      'planned',
    );
    f.db.query("UPDATE change_event SET payload_json='null' WHERE cursor=?").run(model.cursor);
    const old = (await f.store.getSessionLogs(f.input)).entries.find(
      (entry) => entry.cursor === model.cursor,
    )!;
    expect(old.recordedStatus).toBeNull();
    expect(old.modelExecutionId).toBeNull();
    expect(JSON.stringify(page)).not.toContain('modelInputDigest');
    // Actual private Store command with a different original subject cannot gain Model navigation for the root creator.
    await f.store.acceptCommand({
      expectedStoreId: f.input.expectedStoreId,
      commandId: 'foreign-work',
      sessionId: 'other',
      subjectId: 'foreign',
      request: { kind: 'run.start', content: 'private' },
    });
    const foreignOwner = (await f.store.acquireSessionOwner('other', 'owner'))!;
    const foreignRun = await f.store.startRun({
      expectedStoreId: f.input.expectedStoreId,
      owner: foreignOwner,
      commandId: 'foreign-work',
      configuration: {},
    });
    const metadata = JSON.parse(
      String(
        (
          f.db.query("SELECT model_snapshot_json FROM execution WHERE id='model'").get() as {
            model_snapshot_json: string;
          }
        ).model_snapshot_json,
      ),
    );
    await f.store.planExecution({
      expectedStoreId: f.input.expectedStoreId,
      owner: foreignOwner,
      executionId: 'foreign-model',
      sessionId: 'other',
      runId: foreignRun.id,
      originCommandId: 'foreign-work',
      stepId: 'foreign',
      callId: 'foreign',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: { modelId: 'fixed', requestId: 'foreign-model', messages: [], tools: [] },
      decisionSource: { kind: 'model_decision', executionId: 'foreign-model' },
      modelMetadata: metadata,
    });
    expect(
      (await f.store.getSessionLogs({ ...f.input, sessionId: 'other' })).entries.find(
        (entry) => entry.objectId === 'foreign-model',
      )!.modelExecutionId,
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('abort releases only the read observation and never starts/cancels business work', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    expect(
      await rejection(
        readSessionLogs(
          {
            async getSessionLogs(input) {
              reads++;
              return f.store.getSessionLogs(input);
            },
          },
          f.input,
          { signal: controller.signal },
        ),
      ),
    ).toBeInstanceOf(Error);
    expect(reads).toBe(0);
    const later = new AbortController();
    const before = await f.store.getMetadata();
    expect(
      await rejection(
        readSessionLogs(
          {
            async getSessionLogs(input) {
              const page = await f.store.getSessionLogs(input);
              later.abort();
              return page;
            },
          },
          f.input,
          { signal: later.signal },
        ),
      ),
    ).toBeInstanceOf(Error);
    expect(await f.store.getMetadata()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('actual Runtime sealed input navigation survives cold readonly without Model/Source/permission I/O', async () => {
  const f = await fixture();
  const { createRuntime } = await import('../../../src');
  const { createFixedModel } = await import('@kite-ai/ai');
  const { createArtifactStore } = await import('../../../src/artifacts');
  const profile = { dataRoot: f.dataRoot, profile: 'owned' };
  const artifacts = createArtifactStore({ profile, store: f.store });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'original answer' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store: f.store,
    artifacts,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.submitCommand({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'actor',
      commandId: 'large',
      request: { kind: 'run.start', content: 'PRIVATE_FULL_INPUT_SECRET'.repeat(10000) },
    });
    await runtime.waitForCommand('large', { timeoutMs: 25000 });
    const execution = (await f.store.listExecutions('s')).find((entry) => entry.kind === 'model')!;
    const stored = await f.store.getModelInputSnapshot({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'actor',
      executionId: execution.id,
    });
    expect(JSON.stringify(stored.input)).toContain('model_body');
    const logs = await f.store.getSessionLogs(f.input);
    expect(logs.entries.some((entry) => entry.modelExecutionId === execution.id)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
    expect(JSON.stringify(logs)).not.toContain('blob');
    await runtime.close();
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const before = await readonly.getMetadata();
      const cold = await readonly.getSessionLogs({ ...f.input, upperCursor: logs.upperCursor });
      expect(cold.entries).toEqual(logs.entries);
      expect(await readonly.getMetadata()).toEqual(before);
      // Explicit Store-ID drift fixture models retained original Model/Artifact provenance; this is not physical restore qualification.
      f.db.query('UPDATE storage_meta SET store_id=?').run('restored-store');
      const restored = await readonly.getSessionLogs({
        ...f.input,
        expectedStoreId: 'restored-store',
        upperCursor: logs.upperCursor,
      });
      expect(restored.storeId).toBe('restored-store');
      expect(restored.entries.some((entry) => entry.modelExecutionId === execution.id)).toBe(true);
      expect((await readonly.getExecution(execution.id))!.originStoreId).toBe(
        f.input.expectedStoreId,
      );
    } finally {
      await readonly.close();
    }
  } finally {
    await runtime.close();
    await f.close();
  }
}, 30000);
