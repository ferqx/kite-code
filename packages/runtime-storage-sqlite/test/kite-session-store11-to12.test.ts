import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  assertKiteSessionStore11Schema,
  assertKiteSessionStore12Schema,
  KITE_SESSION_STORE11_DDL,
  KITE_SESSION_STORE11_TABLE_COLUMNS,
} from '../src/kite-home-store';
import { convertKiteSessionStore11CandidateTo12 } from '../src/kite-session-store11-to12';
import { captureSqliteTableContentDigests } from '../src/sqlite-table-content';

function candidate(): Database {
  const database = new Database(':memory:', { strict: true });
  database.run('PRAGMA foreign_keys=ON');
  for (const statement of KITE_SESSION_STORE11_DDL) database.run(statement);
  database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run('format_epoch', 'kite-session-lineage-2026-09-24');
  database.run('PRAGMA user_version=11');
  assertKiteSessionStore11Schema(database);
  database
    .query(`INSERT INTO workspaces(
    workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,
    display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      'workspace-1',
      '/workspace',
      `sha256:${'1'.repeat(64)}`,
      'project-1',
      'digest-1',
      'Workspace',
      1,
      1,
    );
  database
    .query(`INSERT INTO runtime_sessions(
    session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,
    revision,name,updated_at,run_index_from_revision) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'original-session-id',
      'workspace-1',
      'project-1',
      'digest-1',
      27,
      'kite-agent-server-api-v1-2026-08-29',
      1,
      'Original',
      1,
      0,
    );
  database
    .query(`INSERT INTO runtime_events(
    session_id,event_id,sequence,schema_version,event_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(
      'original-session-id',
      'event-1',
      1,
      27,
      JSON.stringify({ type: 'turn.started', turnId: 'turn-1' }),
      1,
    );
  return database;
}

describe('private Store 11 to 12 candidate conversion', () => {
  test('adds cross-Session mail and approval tables while retaining every lineage Store 11 row', () => {
    const database = candidate();
    try {
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name='agent_mail_outbox'").get(),
      ).toBeNull();
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name='agent_mail_inbox'").get(),
      ).toBeNull();
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS);
      convertKiteSessionStore11CandidateTo12({ database });
      assertKiteSessionStore12Schema(database);
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name='agent_mail_outbox'").get(),
      ).toEqual({ name: 'agent_mail_outbox' });
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name='agent_mail_inbox'").get(),
      ).toEqual({ name: 'agent_mail_inbox' });
      const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS);
      for (const table of Object.keys(KITE_SESSION_STORE11_TABLE_COLUMNS).filter(
        (name) => name !== 'kite_meta',
      ))
        expect(after[table]).toEqual(before[table]);
      expect(
        database
          .query<{ count: number }, []>('SELECT count(*) AS count FROM child_approval_proxies')
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ session_id: string }, [string]>(
            'SELECT session_id FROM runtime_sessions WHERE session_id=?',
          )
          .get('original-session-id')?.session_id,
      ).toBe('original-session-id');
      expect(
        database
          .query<{ event_json: string }, [string]>(
            'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=1',
          )
          .get('original-session-id')?.event_json,
      ).toBe(
        JSON.stringify({
          type: 'turn.started',
          turnId: 'turn-1',
        }),
      );
      expect(
        database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      ).toBe(12);
    } finally {
      database.close();
    }
  });

  test('rolls back the exact Store 11 candidate on a precommit fault', () => {
    const database = candidate();
    try {
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS);
      expect(() =>
        convertKiteSessionStore11CandidateTo12({
          database,
          faultBeforeCommit: () => {
            throw new Error('fault');
          },
        }),
      ).toThrow('fault');
      assertKiteSessionStore11Schema(database);
      expect(
        captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS),
      ).toEqual(before);
    } finally {
      database.close();
    }
  });
});
