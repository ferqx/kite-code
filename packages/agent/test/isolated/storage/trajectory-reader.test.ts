import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type TrajectoryEvent, verifyTrajectoryPage } from '@kite-ai/trajectory';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import {
  openTrajectory,
  readTrajectoryEvents,
} from '../../../src/storage/sqlite/trajectory-reader';

async function rejection(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

async function fixture() {
  const dataRoot = temporaryDirectory('kite-trajectory-reader-');
  const profile = { dataRoot, profile: 'reader' },
    store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: 'file:///PRIVATE_PATH',
    name: 'PRIVATE_NAME',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      expectedStoreId: storeId,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: 'PRIVATE_TITLE',
      subjectId: 'actor',
    });
  const db = new Database(join(dataRoot, 'reader', 'core.db'));
  const scope = { storeId, sessionId: 's', subjectId: 'actor' };
  const append = (id: string, sessionId = 's') =>
    store.acceptCommand({
      expectedStoreId: storeId,
      sessionId,
      commandId: id,
      subjectId: 'actor',
      request: { kind: 'run.start', content: 'PRIVATE_INPUT' },
    });
  return {
    profile,
    store,
    scope,
    db,
    append,
    async close() {
      db.close(true);
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('fixed upper traverses >200 facts through global filtering holes, empty pages and later state changes', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 205; index++) await f.append(`work-${index}`);
    await f.append('other-work', 'other');
    const snapshot = await f.store.openTrajectory(f.scope);
    const commandSnapshot = await f.store.openTrajectory({ ...f.scope, eventKinds: ['command'] });
    expect(commandSnapshot.historyCoverage.integrity.reasons).not.toContain('unknown_event');
    const commandPage = await f.store.readTrajectoryEvents({
      ...f.scope,
      eventKinds: ['command'],
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
    });
    expect(commandPage.integrity.reasons).not.toContain('unknown_event');
    const firstRequest = {
      ...f.scope,
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
      limit: 1,
    };
    const first = verifyTrajectoryPage(
      await f.store.readTrajectoryEvents(firstRequest),
      (({ subjectId: _, ...request }) => request)(firstRequest),
    );
    expect(first.events).toEqual([]);
    expect(first.scannedThrough).toBe('1');
    expect(first.exhausted).toBe(false);
    const events: TrajectoryEvent[] = [];
    let after = first.scannedThrough,
      pages = 0;
    do {
      const request = { ...f.scope, afterCursor: after, upperCursor: snapshot.upperCursor };
      const page = verifyTrajectoryPage(
        await f.store.readTrajectoryEvents(request),
        (({ subjectId: _, ...value }) => value)(request),
      );
      events.push(...page.events);
      pages++;
      after = page.scannedThrough;
      if (page.exhausted) break;
    } while (pages < 10);
    expect(pages).toBe(2);
    expect(after).toBe(snapshot.upperCursor);
    const original = events.find(
      (event) => event.kind === 'command' && event.attributes.commandId === 'work-0',
    )!;
    expect(original.recordedStatus).toBe('accepted');
    const owner = (await f.store.acquireSessionOwner('s', 'host'))!;
    await f.store.rejectCommand({
      expectedStoreId: f.scope.storeId,
      owner,
      commandId: 'work-0',
      reason: 'PRIVATE_REASON',
    });
    await f.append('later');
    const repeat = await f.store.readTrajectoryEvents({
      ...f.scope,
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
    });
    expect(repeat.events.find((event) => event.eventId === original.eventId)).toEqual(original);
    expect(events.filter((event) => event.kind === 'command')).toHaveLength(205);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    const before = await f.store.getMetadata();
    f.db.run('UPDATE storage_meta SET replay_floor=last_change_cursor');
    expect(
      await f.store.readTrajectoryEvents({
        ...f.scope,
        afterCursor: '0',
        upperCursor: snapshot.upperCursor,
      }),
    ).toEqual(repeat);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
  } finally {
    await f.close();
  }
});

test('each call rechecks actor, Store, retained history and exact Run/Execution scope without writes', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.store.openTrajectory(f.scope),
      before = await f.store.getMetadata();
    const request = { ...f.scope, afterCursor: '0', upperCursor: snapshot.upperCursor };
    await rejection(
      f.store.readTrajectoryEvents({ ...request, subjectId: 'foreign' }),
      'trajectory_scope_denied',
    );
    await rejection(
      f.store.openTrajectory({ ...f.scope, storeId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejection(
      f.store.openTrajectory({ ...f.scope, runId: 'foreign-run' }),
      'trajectory_scope_denied',
    );
    await rejection(
      f.store.openTrajectory({ ...f.scope, executionId: 'foreign-execution' }),
      'trajectory_scope_denied',
    );
    await rejection(
      f.store.readTrajectoryEvents({ ...request, upperCursor: '9223372036854775807' }),
      'cursor_ahead',
    );
    await rejection(
      f.store.readTrajectoryEvents({ ...request, afterCursor: '01' }),
      'invalid_trajectory_request',
    );
    // Same transaction marker as real history GC: only this collected root loses its source.
    f.db.run('UPDATE workspace SET metadata_json=? WHERE id=?', [
      JSON.stringify({ sessionHistoryCollection: { version: 1, roots: { s: 1 } } }),
      'w',
    ]);
    await rejection(f.store.readTrajectoryEvents(request), 'history_unavailable');
    expect((await f.store.openTrajectory({ ...f.scope, sessionId: 'other' })).upperCursor).toBe(
      snapshot.upperCursor,
    );
    expect(await f.store.getMetadata()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('Decimal64 remains precise and a malformed or future fact cannot leak raw fields or damage Session Logs', async () => {
  const f = await fixture();
  try {
    f.db.run('UPDATE storage_meta SET last_change_cursor=9007199254740993');
    await f.append('large');
    const snapshot = await f.store.openTrajectory(f.scope);
    const query = {
      ...f.scope,
      afterCursor: '9007199254740993',
      upperCursor: snapshot.upperCursor,
    };
    const original = await f.store.readTrajectoryEvents(query);
    expect(original.events[0]!.sequence).toBe('9007199254740994');
    const logsInput = {
      expectedStoreId: f.scope.storeId,
      sessionId: 's',
      subjectId: 'actor',
      afterCursor: query.afterCursor,
      upperCursor: query.upperCursor,
    };
    const logs = await f.store.getSessionLogs(logsInput);
    const fact = f.db
      .query<{ trajectory_fact_json: string }, []>(
        "SELECT trajectory_fact_json FROM change_event WHERE object_id='large'",
      )
      .get()!;
    for (const value of [
      '{broken PRIVATE_BAD',
      JSON.stringify({
        format: 'kite.trajectory-fact',
        version: 99,
        event: { PRIVATE_RAW: 'PRIVATE_SENTINEL' },
        bindings: [{ value: 'PRIVATE_MATERIAL' }],
      }),
    ]) {
      f.db.run("UPDATE change_event SET trajectory_fact_json=? WHERE object_id='large'", [value]);
      const page = await f.store.readTrajectoryEvents(query);
      expect(page.events[0]!.kind).toBe('unknown');
      expect(page.events[0]!.evidenceRefs).toEqual([]);
      expect(page.integrity.facts).toBe('partial');
      expect(JSON.stringify(page)).not.toContain('PRIVATE_');
      expect(await f.store.getSessionLogs(logsInput)).toEqual(logs);
    }
    const future = JSON.parse(fact.trajectory_fact_json);
    future.event.schemaVersion = 2;
    future.event.attributes = { PRIVATE_FUTURE: 'PRIVATE_SENTINEL' };
    f.db.run("UPDATE change_event SET trajectory_fact_json=? WHERE object_id='large'", [
      JSON.stringify(future),
    ]);
    const unsupported = await f.store.readTrajectoryEvents(query);
    expect(unsupported.events[0]!.eventId).toBe(original.events[0]!.eventId);
    expect(unsupported.events[0]!.origin).toEqual(original.events[0]!.origin);
    expect(unsupported.events[0]!.recordedStatus).toBeNull();
    expect(JSON.stringify(unsupported)).not.toContain('PRIVATE_');
    f.db.run("UPDATE change_event SET trajectory_fact_json=? WHERE object_id='large'", [
      fact.trajectory_fact_json,
    ]);
    expect(await f.store.readTrajectoryEvents(query)).toEqual(original);
  } finally {
    await f.close();
  }
});

test('Evidence binding resolves the original sealed input, rejects future/cross-version and corrupt checkpoints', async () => {
  const f = await fixture();
  try {
    await f.append('work');
    const owner = (await f.store.acquireSessionOwner('s', 'host'))!;
    const run = await f.store.startRun({
      expectedStoreId: f.scope.storeId,
      owner,
      commandId: 'work',
      configuration: {},
    });
    await f.store.planExecution({
      expectedStoreId: f.scope.storeId,
      owner,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      executionId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      stepId: 'step',
      callId: 'model',
      input: { modelId: 'fixed', requestId: 'original', messages: [], tools: [] },
      decisionSource: {},
    });
    const snapshot = await f.store.openTrajectory(f.scope);
    const page = await f.store.readTrajectoryEvents({
      ...f.scope,
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
    });
    const event = page.events.find((value) => value.executionId === 'model')!;
    const ref = event.evidenceRefs.find((value) => value.kind === 'model_input')!;
    const input = {
      ...f.scope,
      upperCursor: snapshot.upperCursor,
      atCursor: event.sequence,
      eventId: event.eventId,
      evidenceId: ref.evidenceId,
      contentVersion: ref.contentVersion,
    };
    const original = await f.store.readTrajectoryBinding(input);
    f.db.run("UPDATE execution SET intent_json='{}' WHERE id='model'");
    expect(await f.store.readTrajectoryBinding(input)).toEqual(original);
    expect(JSON.stringify(original.binding.value)).toContain('original');
    await rejection(
      f.store.readTrajectoryBinding({ ...input, atCursor: '0' }),
      'trajectory_evidence_unavailable',
    );
    await rejection(
      f.store.readTrajectoryBinding({ ...input, contentVersion: 'another' }),
      'trajectory_evidence_unavailable',
    );
    await rejection(
      f.store.readTrajectoryBinding({ ...input, sessionId: 'other' }),
      'trajectory_evidence_unavailable',
    );
    const row = f.db
      .query<{ trajectory_fact_json: string }, [string]>(
        'SELECT trajectory_fact_json FROM change_event WHERE cursor=?',
      )
      .get(event.sequence)!;
    const fact = JSON.parse(row.trajectory_fact_json);
    fact.bindings[0].value = { changed: true };
    f.db.run('UPDATE change_event SET trajectory_fact_json=? WHERE cursor=?', [
      JSON.stringify(fact),
      event.sequence,
    ]);
    await rejection(f.store.readTrajectoryBinding(input), 'trajectory_evidence_unavailable');
  } finally {
    await f.close();
  }
});

test('pre-enable readonly schema decodes only sealed old fields and keeps coverage legacy', () => {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
      'utf8',
    ),
  );
  db.run(
    "INSERT INTO storage_meta(singleton,store_id,format_major,last_change_cursor) VALUES(1,'legacy',1,7)",
  );
  db.run(
    "INSERT INTO workspace(id,root_uri,name) VALUES('w','file:///PRIVATE_PATH','PRIVATE_NAME')",
  );
  db.run(
    "INSERT INTO session(id,workspace_id,root_id,title,context_selection_id) VALUES('s','w','s','PRIVATE_TITLE','context')",
  );
  db.run(
    "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES('create','s',1,'session.create','actor','digest','{}','applied','legacy','create',1)",
  );
  db.run('INSERT INTO change_event VALUES(?,?,?,?,?,?)', [
    7,
    's',
    'create',
    0,
    'command.accepted',
    JSON.stringify({
      format: 'kite.session-log',
      version: 1,
      occurredAt: 123,
      snapshot: { recordedStatus: 'accepted' },
      payload: { PRIVATE_RAW: true },
    }),
  ]);
  const operations = new SqliteOperations(db, true),
    scope = { storeId: 'legacy', sessionId: 's', subjectId: 'actor' };
  try {
    const snapshot = openTrajectory(operations, scope);
    expect(snapshot.historyCoverage.status).toBe('legacy');
    const page = readTrajectoryEvents(operations, { ...scope, afterCursor: '0', upperCursor: '7' });
    expect(page.events[0]!.recordedStatus).toBe('accepted');
    expect(page.events[0]!.occurredAt).toBe(123);
    expect(page.events[0]!.identityConfidence).toBe('legacy_local');
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    expect(openTrajectory(operations, scope)).toEqual(snapshot);
  } finally {
    operations.releaseStatements();
    db.close(true);
  }
});
