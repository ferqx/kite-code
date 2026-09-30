import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  assertKiteSessionStore15Schema,
  assertKiteSessionStoreSchema,
  KITE_SESSION_STORE15_DDL,
} from '../src/kite-home-store';
import { convertKiteSessionStore15CandidateTo16 } from '../src/kite-session-store15-to16';

function store15(): Database {
  const db = new Database(':memory:');
  for (const sql of KITE_SESSION_STORE15_DDL) db.run(sql);
  db.run(
    "INSERT INTO kite_meta VALUES ('schema_version','15'),('format_epoch','kite-session-unbounded-child-artifacts-2026-09-29')",
  );
  db.run('PRAGMA user_version=15');
  db.run(
    "INSERT INTO workspaces (workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,created_at,updated_at) VALUES ('w','/w','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','p','digest',1,1)",
  );
  db.run(
    "INSERT INTO runtime_sessions (session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at) VALUES ('s','w','p','digest',27,'state',0,1)",
  );
  db.run(
    "INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at) VALUES ('s','first',1,27,'{}',1)",
  );
  return db;
}

test('Store 16 preserves prior facts and distinguishes append from every prefix mutation', () => {
  using db = store15();
  convertKiteSessionStore15CandidateTo16({ database: db });
  assertKiteSessionStoreSchema(db);
  const revision = () =>
    db
      .query<
        {
          history_generation: number;
          history_rewrite_generation: number;
          history_append_sequence: number;
          history_instance_id: string;
        },
        []
      >(
        'SELECT history_generation,history_rewrite_generation,history_append_sequence,history_instance_id FROM runtime_sessions',
      )
      .get()!;
  const first = revision();
  expect(first.history_instance_id).toMatch(/^[a-f0-9]{32}$/u);
  expect(first.history_rewrite_generation).toBe(0);
  expect(first.history_append_sequence).toBe(1);
  expect(db.query('SELECT event_json FROM runtime_events').get()).toEqual({ event_json: '{}' });
  db.run(
    "INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at) VALUES ('s','second',2,27,'{}',2)",
  );
  expect(revision().history_rewrite_generation).toBe(0);
  db.run(
    "UPDATE runtime_events SET event_json='{" + '"changed":true' + "}' WHERE event_id='first'",
  );
  expect(revision().history_rewrite_generation).toBe(1);
  db.run("DELETE FROM runtime_events WHERE event_id='second'");
  expect(revision().history_rewrite_generation).toBe(2);
  db.run(
    "INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at) VALUES ('s','replacement',2,27,'{}',3)",
  );
  expect(revision().history_rewrite_generation).toBe(3);
  expect(revision().history_generation).toBe(first.history_generation + 4);
  db.run("DELETE FROM runtime_sessions WHERE session_id='s'");
  db.run(
    "INSERT INTO runtime_sessions (session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at) VALUES ('s','w','p','digest',27,'state',0,1)",
  );
  expect(revision().history_instance_id).not.toBe(first.history_instance_id);
});

test('a failed Store 16 candidate conversion leaves the verified Store 15 unchanged', () => {
  using db = store15();
  expect(() =>
    convertKiteSessionStore15CandidateTo16({
      database: db,
      faultBeforeCommit: () => {
        throw new Error('injected');
      },
    }),
  ).toThrow('injected');
  assertKiteSessionStore15Schema(db);
  expect(db.query('SELECT event_json FROM runtime_events').get()).toEqual({ event_json: '{}' });
});
