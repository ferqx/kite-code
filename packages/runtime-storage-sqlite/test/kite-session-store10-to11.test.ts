import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  assertKiteSessionStore10Schema,
  assertKiteSessionStore11Schema,
  KITE_SESSION_STORE10_DDL,
  KITE_SESSION_STORE10_TABLE_COLUMNS,
  KITE_SESSION_STORE11_TABLE_COLUMNS,
} from '../src/kite-home-store';
import { convertKiteSessionStore10CandidateTo11 } from '../src/kite-session-store10-to11';
import { captureSqliteTableContentDigests } from '../src/sqlite-table-content';

function candidate(): Database {
  const database = new Database(':memory:', { strict: true });
  database.run('PRAGMA foreign_keys = ON');
  for (const statement of KITE_SESSION_STORE10_DDL) database.run(statement);
  database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '10');
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run('format_epoch', 'kite-session-app-server-2026-09-02');
  database.run('PRAGMA user_version = 10');
  assertKiteSessionStore10Schema(database);
  database
    .query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES ('workspace-1','/workspace','sha256:${'1'.repeat(64)}','project-1','digest-1','Workspace',1,1)`)
    .run();
  database
    .query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,name,updated_at,run_index_from_revision)
    VALUES ('session-1','workspace-1','project-1','digest-1',27,'kite-agent-server-api-v1-2026-08-29',0,'',1,0)`)
    .run();
  database
    .query(`INSERT INTO model_artifacts(artifact_id,kind,integrity_identifier,artifact_format_version,canonical_json,byte_length,created_at)
    VALUES ('pa_${'a'.repeat(64)}','model_surface','sha256:${'a'.repeat(64)}',1,'{}',2,1)`)
    .run();
  return database;
}

describe('private Store 10 to 11 candidate conversion', () => {
  test('retains every Store 10 row and creates only the exact new inventory', () => {
    const database = candidate();
    try {
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS);
      convertKiteSessionStore10CandidateTo11({ database });
      assertKiteSessionStore11Schema(database);
      expect(
        database
          .query<{ parent_session_id: string | null }, []>(
            "SELECT parent_session_id FROM runtime_sessions WHERE session_id = 'session-1'",
          )
          .get()?.parent_session_id,
      ).toBeNull();
      expect(
        database
          .query<{ table: string }, []>('PRAGMA foreign_key_list(runtime_sessions)')
          .all()
          .some((row) => row.table === 'runtime_sessions'),
      ).toBe(true);
      const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS);
      for (const table of Object.keys(KITE_SESSION_STORE10_TABLE_COLUMNS).filter(
        (name) => name !== 'kite_meta',
      ))
        expect(after[table]).toEqual(before[table]);
      for (const table of Object.keys(KITE_SESSION_STORE11_TABLE_COLUMNS).filter(
        (name) => !(name in KITE_SESSION_STORE10_TABLE_COLUMNS),
      )) {
        expect(
          database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()
            ?.count,
        ).toBe(0);
      }
      expect(
        database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      ).toBe(11);
    } finally {
      database.close();
    }
  });

  test('a precommit fault leaves the exact Store 10 schema and content', () => {
    const database = candidate();
    try {
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS);
      expect(() =>
        convertKiteSessionStore10CandidateTo11({
          database,
          faultBeforeCommit: () => {
            throw new Error('fault');
          },
        }),
      ).toThrow('fault');
      assertKiteSessionStore10Schema(database);
      expect(
        captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS),
      ).toEqual(before);
      expect(
        database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      ).toBe(10);
    } finally {
      database.close();
    }
  });
});
