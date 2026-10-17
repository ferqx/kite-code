import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'kite-cancel-history-'));
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///history', name: 'w' });
  for (const sessionId of ['root', 'foreign'])
    await store.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
      subjectId: 'owner',
    });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  const base = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 'foreign',
    subjectId: 'owner',
    commandId: 'foreign-work',
    request: { kind: 'run.start', content: 'Independent live work' },
  });
  async function run() {
    await store.acceptCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'actual foreground' },
    });
    const owner = (await store.acquireSessionOwner('root', 'host'))!;
    return store.startRun({ expectedStoreId, owner, commandId: 'work', configuration: {} });
  }
  return {
    db,
    store,
    base,
    run,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('full stop covers an accumulated child Session subtree beyond 256 and preserves foreign roots', async () => {
  const f = await fixture();
  try {
    // Seed persisted historical Sessions, not cancellation results or Store return values.
    f.db.transaction(() => {
      const insert = f.db.prepare(
        'INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id) VALUES(?,?,?,?,?,?)',
      );
      for (let i = 0; i < 300; i++)
        insert.run(
          `old-${String(i).padStart(4, '0')}`,
          'w',
          'root',
          'root',
          'historical child',
          `context-${i}`,
        );
      f.db.run(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES('live-child','old-0299',1,'run.start','owner','fixture','{}','accepted',?,'live-child',1)",
        [f.base.expectedStoreId],
      );
      f.db.run(
        "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,started_at,context_selection_id) VALUES('child-run','old-0299','live-child',?,'live-child',1,'running',1,'{}','1','context-299')",
        [f.base.expectedStoreId],
      );
    })();
    const receipt = await f.store.cancelWork({
      ...f.base,
      commandId: 'stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect(receipt.status).toBe('applied');
    expect((await f.store.getCommand('foreign-work'))?.cancelRequestedAt).toBeNull();
    expect(
      (
        f.db
          .query('SELECT count(*) AS n FROM session WHERE root_id=? AND stop_boundary>0')
          .get('root') as { n: number }
      ).n,
    ).toBe(301);
    expect(
      (
        f.db.query("SELECT cancel_requested FROM run WHERE id='child-run'").get() as {
          cancel_requested: number;
        }
      ).cancel_requested,
    ).toBe(1);
    expect((await f.store.getCommand('live-child'))?.cancelRequestedAt).not.toBeNull();
    expect(
      (
        f.db.query('SELECT stop_boundary FROM session WHERE id=?').get('foreign') as {
          stop_boundary: number;
        }
      ).stop_boundary,
    ).toBe(0);
    expect(
      await f.store.cancelWork({
        ...f.base,
        commandId: 'stop',
        kind: 'session.cancel',
        includeBackground: true,
      }),
    ).toEqual(receipt);
  } finally {
    await f.close();
  }
});

test('cyclic historical parent edges terminate and malformed foreign-root edges receive no stop boundary', async () => {
  const f = await fixture();
  try {
    // Foreign keys permit these malformed edges; cancellation must still terminate
    // and confine every stop boundary to the original root/workspace identity.
    f.db.run(
      "INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id) VALUES('cycle-child','w','root','root','cycle child','cycle-context')",
    );
    f.db.run("UPDATE session SET parent_id='cycle-child' WHERE id='root'");
    f.db.run("UPDATE session SET parent_id='root' WHERE id='foreign'");
    const result = await f.store.cancelWork({
      ...f.base,
      commandId: 'cycle-stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect(result.status).toBe('applied');
    expect(
      (
        f.db
          .query("SELECT count(*) AS n FROM session WHERE root_id='root' AND stop_boundary>0")
          .get() as { n: number }
      ).n,
    ).toBe(2);
    expect(
      (
        f.db.query("SELECT stop_boundary FROM session WHERE id='foreign'").get() as {
          stop_boundary: number;
        }
      ).stop_boundary,
    ).toBe(0);
    expect((await f.store.getCommand('foreign-work'))?.cancelRequestedAt).toBeNull();
  } finally {
    await f.close();
  }
}, 5000);

test('exact Run cancellation handles more than 4096 executions and accumulated inputs atomically', async () => {
  const f = await fixture();
  try {
    const run = await f.run();
    f.db.transaction(() => {
      const input = f.db.prepare(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq,input_target_run_id) VALUES(?,'root',?,'input.steer','owner','fixture','{}','applied',?,'work',2,?)",
      );
      const execution = f.db.prepare(
        "INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation) VALUES(?,'root',?,'tool','work',?,'work',2,'root',?,?,1,'fixture','1','planned','{}','{}',1)",
      );
      for (let i = 0; i < 4105; i++) {
        const id = `item-${String(i).padStart(5, '0')}`;
        input.run(`input-${id}`, i + 100, f.base.expectedStoreId, run.id);
        execution.run(id, run.id, f.base.expectedStoreId, id, id);
      }
      f.db.run("UPDATE session SET next_seq=5000 WHERE id='root'");
      f.db.run("UPDATE execution SET parent_execution_id='item-00000' WHERE id<>'item-00000'");
      f.db.run(
        "INSERT INTO interaction(id,origin_store_id,subject_id,session_id,run_id,execution_id,attempt,presentation_session_id,ancestry_json,kind,definition_id,definition_version,input_digest,policy_revision,required_refs_json,source_json,request_digest,request_json,state) VALUES('pending',?,'owner','root',?,'item-04104',1,'root','[]','approval','fixture','1','digest','policy','[]','{}','digest','{}','pending')",
        [f.base.expectedStoreId, run.id],
      );
    })();
    const exact = await f.store.cancelWork({
      ...f.base,
      commandId: 'stop-tree',
      kind: 'execution.cancel',
      executionId: 'item-00000',
    });
    expect(exact.status).toBe('applied');
    expect(
      (
        f.db.query('SELECT count(*) AS n FROM execution WHERE cancel_requested=1').get() as {
          n: number;
        }
      ).n,
    ).toBe(4105);
    expect(
      (
        f.db.query('SELECT cancel_requested FROM run WHERE id=?').get(run.id) as {
          cancel_requested: number;
        }
      ).cancel_requested,
    ).toBe(0);
    const input = { ...f.base, commandId: 'stop-run', kind: 'run.cancel' as const, runId: run.id };
    const receipt = await f.store.cancelWork(input);
    expect(receipt.status).toBe('applied');
    expect(
      (
        f.db
          .query('SELECT count(*) AS n FROM execution WHERE run_id=? AND cancel_requested=1')
          .get(run.id) as { n: number }
      ).n,
    ).toBe(4105);
    expect(
      (
        f.db
          .query(
            "SELECT count(*) AS n FROM command WHERE kind='input.steer' AND input_target_run_id=? AND cancelled=1",
          )
          .get(run.id) as { n: number }
      ).n,
    ).toBe(4105);
    expect(
      (
        f.db.query('SELECT cancel_requested FROM run WHERE id=?').get(run.id) as {
          cancel_requested: number;
        }
      ).cancel_requested,
    ).toBe(1);
    expect(
      (f.db.query("SELECT state FROM interaction WHERE id='pending'").get() as { state: string })
        .state,
    ).toBe('cancelled');
    expect(
      (
        f.db
          .query(
            "SELECT count(*) AS n FROM change_event WHERE object_id='pending' AND type='interaction.cancelled'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(await f.store.cancelWork(input)).toEqual(receipt);
  } finally {
    await f.close();
  }
}, 15000);

test('full stop cancels every accepted command beyond 4096 without crossing the root boundary', async () => {
  const f = await fixture();
  try {
    f.db.transaction(() => {
      const insert = f.db.prepare(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,'root',?,'extension.invoke','owner','fixture','{}','accepted',?,?,?)",
      );
      for (let i = 0; i < 4105; i++) {
        const id = `queued-${String(i).padStart(5, '0')}`;
        insert.run(id, i + 100, f.base.expectedStoreId, id, i + 100);
      }
      f.db.run("UPDATE session SET next_seq=5000 WHERE id='root'");
    })();
    const result = await f.store.cancelWork({
      ...f.base,
      commandId: 'stop-queue',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect(result.status).toBe('applied');
    expect(
      (
        f.db
          .query(
            "SELECT count(*) AS n FROM command WHERE id LIKE 'queued-%' AND status='rejected' AND cancelled=1",
          )
          .get() as { n: number }
      ).n,
    ).toBe(4105);
    expect((await f.store.getCommand('foreign-work'))?.cancelRequestedAt).toBeNull();
  } finally {
    await f.close();
  }
}, 15000);
