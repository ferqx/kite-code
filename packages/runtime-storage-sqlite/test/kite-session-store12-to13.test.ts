import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  assertKiteSessionStore12Schema,
  assertKiteSessionStore13Schema,
  KITE_SESSION_STORE12_DDL,
  KITE_SESSION_STORE12_TABLE_COLUMNS,
} from '../src/kite-home-store';
import { convertKiteSessionStore12CandidateTo13 } from '../src/kite-session-store12-to13';
import { captureSqliteTableContentDigests } from '../src/sqlite-table-content';

function candidate(): Database {
  const database = new Database(':memory:', { strict: true });
  database.run('PRAGMA foreign_keys=ON');
  for (const statement of KITE_SESSION_STORE12_DDL) database.run(statement);
  database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '12');
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run('format_epoch', 'kite-session-child-approval-2026-09-25');
  database.run('PRAGMA user_version=12');
  database
    .query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,
      project_id,workspace_digest,display_name,created_at,updated_at)
      VALUES ('workspace','/workspace',?,'project','digest','Workspace',1,1)`)
    .run(`sha256:${'a'.repeat(64)}`);
  for (const [id, parent] of [
    ['source', null],
    ['target', 'source'],
  ] as const)
    database
      .query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,
        state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,parent_session_id)
        VALUES (?,'workspace','project','digest',27,'kite-agent-server-api-v1-2026-08-29',1,'',1,0,?)`)
      .run(id, parent);
  database
    .query(`INSERT INTO agent_mail_bodies(session_id,body_id,integrity_identifier,
      byte_length,body_text,created_at_ms) VALUES ('source',?, ?,5,'hello',1)`)
    .run(`pa_${'b'.repeat(64)}`, `sha256:${'b'.repeat(64)}`);
  database
    .query(`INSERT INTO agent_mail_outbox(source_session_id,message_id,target_session_id,
      command_id,request_digest,source_run_id,source_turn_id,source_model_invocation_id,
      source_tool_call_id,source_effect_attempt_id,mode,body_id,source_sequence,
      source_revision,accepted_at_ms)
      VALUES ('source','mail-1','target','mail-1',?,'run-1','turn-1','model-1',
      'tool-1','attempt-1','queue_only',?,1,1,1)`)
    .run('c'.repeat(64), `pa_${'b'.repeat(64)}`);
  assertKiteSessionStore12Schema(database);
  return database;
}

describe('private Store 12 to 13 candidate conversion', () => {
  test('preserves old QueueOnly, Session and History rows and adds empty route authority', () => {
    const database = candidate();
    try {
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS);
      convertKiteSessionStore12CandidateTo13({ database });
      assertKiteSessionStore13Schema(database);
      const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS);
      for (const table of Object.keys(KITE_SESSION_STORE12_TABLE_COLUMNS).filter(
        (name) => name !== 'kite_meta',
      ))
        expect(after[table]).toEqual(before[table]);
      expect(
        database
          .query<
            { submission_id: string | null; followup_admission_artifact_id: string | null },
            []
          >('SELECT submission_id,followup_admission_artifact_id FROM agent_mail_outbox')
          .get(),
      ).toEqual({ submission_id: null, followup_admission_artifact_id: null });
      expect(
        database
          .query<{ count: number }, []>('SELECT count(*) AS count FROM agent_interrupt_intents')
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>('SELECT count(*) AS count FROM agent_followup_routes')
          .get()?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  test('rolls back on a fault and refuses unproven Store 12 TriggerTurn rows', () => {
    const database = candidate();
    try {
      const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS);
      expect(() =>
        convertKiteSessionStore12CandidateTo13({
          database,
          faultBeforeCommit: () => {
            throw new Error('fault');
          },
        }),
      ).toThrow('fault');
      assertKiteSessionStore12Schema(database);
      expect(
        captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS),
      ).toEqual(before);
      database.run("UPDATE agent_mail_outbox SET mode='trigger_turn' WHERE message_id='mail-1'");
      expect(() => convertKiteSessionStore12CandidateTo13({ database })).toThrow(
        'no durable admission binding',
      );
      assertKiteSessionStore12Schema(database);
    } finally {
      database.close();
    }
  });
});
