import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { canonicalJson } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { readRunExecutionSafetySnapshot } from '../../../src/storage/sqlite/run-execution-safety';

type Row = Record<string, string | number | bigint | null>;
async function fixture() {
  const dataRoot = temporaryDirectory('kite-run-safety-history-');
  const store = await openSqliteStore({ dataRoot, profile: 'owned' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'owned',
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
  const owner = (await store.acquireSessionOwner('s', 'owned-host'))!;
  const run = await store.startRun({
    expectedStoreId,
    owner,
    commandId: 'work',
    configuration: {},
  });
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'seed',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'seed',
    callId: 'seed',
    kind: 'tool',
    definitionId: 'fixture/read',
    definitionVersion: '1',
    input: {},
    decisionSource: {},
  });
  const db = new Database(join(dataRoot, 'owned', 'core.db'));
  db.run(
    "UPDATE execution SET state='succeeded',result_revision=1,result_json='{}' WHERE id='seed'",
  );
  const seed = db.query<Row, []>("SELECT * FROM execution WHERE id='seed'").get()!;
  const columns = Object.keys(seed);
  const insert = db.prepare(
    `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
  );
  const append = (id: string, changes: Partial<Row> = {}) => {
    const row = { ...seed, id, step_id: id, call_id: id, ...changes } as Row;
    insert.run(...columns.map((column) => row[column]!));
  };
  const history = (count = 5000) =>
    db.transaction(() => {
      for (let index = 0; index < count; index++)
        append(`history-${String(index).padStart(5, '0')}`);
    })();
  const request = { expectedStoreId, subjectId: 'owner', sessionId: 's', runId: run.id };
  const clone = (table: 'session' | 'command' | 'run', id: string, changes: Row) => {
    const original = db.query<Row, [string]>(`SELECT * FROM ${table} WHERE id=?`).get(id)!;
    const row = { ...original, ...changes },
      keys = Object.keys(row);
    db.run(
      `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      keys.map((key) => row[key]!),
    );
  };
  const safety = async (input: Parameters<typeof readRunExecutionSafetySnapshot>[1] = request) => {
    const operations = new SqliteOperations(db, true);
    try {
      return readRunExecutionSafetySnapshot(operations, input);
    } finally {
      operations.releaseStatements();
    }
  };
  return {
    safety,
    db,
    store,
    run,
    seed,
    request,
    append,
    history,
    clone,
    async close() {
      insert.finalize();
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('successful cumulative history beyond 4096 stays safe and every historical revision still contributes to its digest', async () => {
  const f = await fixture();
  try {
    f.history();
    const before = await f.store.readRunExecutionSafety(f.request);
    expect(before.unconfirmed).toBe(false);
    expect(before.unconfirmedExecutionIds).toEqual([]);
    // A finite reference fixture proves compatibility with the previous canonical digest format.
    const original = f.db.query<
      Row,
      [string]
    >(`SELECT e.id,e.session_id,e.run_id,e.kind,e.state,e.parent_execution_id,e.child_session_id,
      e.origin_store_id,e.root_session_id,e.root_work_command_id,e.root_work_seq,e.result_revision,
      c.subject_id,s.root_id,s.workspace_id FROM execution e JOIN command c ON c.id=e.origin_command_id
      JOIN session s ON s.id=e.session_id WHERE e.run_id=? ORDER BY e.id`);
    (original as typeof original & { safeIntegers(value: boolean): typeof original }).safeIntegers(
      true,
    );
    const legacyRows = original
      .all(f.run.id)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === 'bigint' ? String(value) : value,
          ]),
        ),
      );
    expect(before.revision).toBe(
      createHash('sha256')
        .update(
          canonicalJson({
            runId: f.run.id,
            sessionId: 's',
            storeId: f.request.expectedStoreId,
            excludedExecutionId: null,
            rows: legacyRows,
          }),
        )
        .digest('hex'),
    );
    expect((await f.safety(f.request)).revision).toBe(before.revision);
    f.db.run("UPDATE execution SET result_revision=result_revision+1 WHERE id='history-04999'");
    expect((await f.safety(f.request)).revision).not.toBe(before.revision);
    const operations = new SqliteOperations(f.db, true);
    operations.rows = () => {
      throw Error('history must not be materialized as a JS array');
    };
    try {
      expect(readRunExecutionSafetySnapshot(operations, f.request).unconfirmed).toBe(false);
    } finally {
      operations.releaseStatements();
    }
  } finally {
    await f.close();
  }
});

test('all unfinished states beyond the historical prefix stay visible and exclusion remains an exact original Tool boundary', async () => {
  const f = await fixture();
  try {
    f.history();
    for (const state of ['planned', 'dispatching', 'running', 'outcome_unknown'])
      f.append(`z-${state}`, { state });
    f.append('z-model', { kind: 'model', state: 'running' });
    const facts = await f.safety(f.request);
    expect(facts.unconfirmed).toBe(true);
    expect(facts.unconfirmedExecutionIds).toEqual([
      'z-dispatching',
      'z-outcome_unknown',
      'z-planned',
      'z-running',
    ]);
    expect(
      (await f.safety({ ...f.request, excludeExecutionId: 'z-running' })).unconfirmedExecutionIds,
    ).toEqual(['z-dispatching', 'z-outcome_unknown', 'z-planned']);
    await expect(f.safety({ ...f.request, excludeExecutionId: 'seed' })).rejects.toMatchObject({
      code: 'execution_safety_boundary_invalid',
    });
  } finally {
    await f.close();
  }
});

test('the full cross-Run and child-Session closure survives cycles and rejects late foreign ownership', async () => {
  const f = await fixture();
  try {
    f.history();
    f.clone('command', 'work', { id: 'later-work', seq: 40 });
    f.clone('run', f.run.id, {
      id: 'later-run',
      origin_command_id: 'later-work',
      is_active: 0,
      status: 'completed',
    });
    f.append('z-cross-run', {
      run_id: 'later-run',
      origin_command_id: 'later-work',
      parent_execution_id: 'seed',
      state: 'outcome_unknown',
    });
    f.clone('session', 's', { id: 'child', parent_id: 's', owner_instance: null });
    f.clone('command', 'work', { id: 'child-work', session_id: 'child', seq: 1 });
    f.clone('run', f.run.id, {
      id: 'child-run',
      session_id: 'child',
      origin_command_id: 'child-work',
    });
    f.append('z-child', {
      session_id: 'child',
      run_id: 'child-run',
      origin_command_id: 'child-work',
      state: 'running',
    });
    f.db.run(
      "UPDATE execution SET child_session_id='child',parent_execution_id='z-cross-run' WHERE id='seed'",
    );
    const facts = await f.safety(f.request);
    expect(facts.unconfirmedExecutionIds).toEqual(['z-child', 'z-cross-run']);
    expect(facts.unconfirmed).toBe(true);
    f.db.run("UPDATE execution SET state='succeeded' WHERE id IN('z-child','z-cross-run')");
    expect((await f.safety(f.request)).unconfirmed).toBe(false);
    f.db.run("UPDATE execution SET root_work_command_id='foreign-work' WHERE id='z-child'");
    await expect(f.safety(f.request)).rejects.toMatchObject({
      code: 'execution_safety_scope_denied',
    });
  } finally {
    await f.close();
  }
});

test('only an actually oversized unfinished closure fails closed; completed history has no cumulative count ceiling', async () => {
  const f = await fixture();
  try {
    f.history();
    f.db.transaction(() => {
      for (let index = 0; index < 4097; index++)
        f.append(`unconfirmed-${String(index).padStart(4, '0')}`, { state: 'running' });
    })();
    await expect(f.safety(f.request)).rejects.toMatchObject({
      code: 'execution_safety_unavailable',
    });
    f.db.run("UPDATE execution SET state='succeeded' WHERE id='unconfirmed-4096'");
    const facts = await f.safety(f.request);
    expect(facts.unconfirmed).toBe(true);
    expect(facts.unconfirmedExecutionIds).toHaveLength(4096);
    expect(facts.unconfirmedExecutionIds.at(-1)).toBe('unconfirmed-4095');
  } finally {
    await f.close();
  }
});
