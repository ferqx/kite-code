import type { Database } from 'bun:sqlite';
import {
  KITE_CROSS_SESSION_INTERRUPT_DDL,
  KITE_CROSS_SESSION_INTERRUPT_PENDING_INDEX,
} from './kite-cross-session-agent-interrupt';
import {
  KITE_CROSS_SESSION_FOLLOWUP_FUNDING_DDL,
  KITE_CROSS_SESSION_FOLLOWUP_GRANT_DDL,
  KITE_CROSS_SESSION_FOLLOWUP_OUTBOX_DDL,
  KITE_CROSS_SESSION_FOLLOWUP_ROUTE_DDL,
} from './kite-cross-session-followup-schema';
import {
  assertKiteSessionStore12Schema,
  assertKiteSessionStore13Schema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE12_TABLE_COLUMNS,
} from './kite-home-store';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

const OLD_OUTBOX_COLUMNS = KITE_SESSION_STORE12_TABLE_COLUMNS.agent_mail_outbox;

/** Convert only a verified private candidate; Store 12 source files remain untouched. */
export function convertKiteSessionStore12CandidateTo13(input: {
  readonly database: Database;
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore12Schema(database);
  assertKiteStoreIntegrity(database);
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS);
  database.run('BEGIN IMMEDIATE');
  try {
    const oldTrigger = database
      .query<{ message_id: string }, []>(
        "SELECT message_id FROM agent_mail_outbox WHERE mode='trigger_turn' LIMIT 1",
      )
      .get();
    if (oldTrigger)
      throw new Error('Store 12 TriggerTurn outbox has no durable admission binding.');
    database.run(
      KITE_CROSS_SESSION_FOLLOWUP_OUTBOX_DDL.replace(
        'CREATE TABLE agent_mail_outbox (',
        'CREATE TABLE agent_mail_outbox_new (',
      ),
    );
    const columns = OLD_OUTBOX_COLUMNS.join(',');
    database.run(
      `INSERT INTO agent_mail_outbox_new (${columns}) SELECT ${columns} FROM agent_mail_outbox`,
    );
    database.run('DROP TABLE agent_mail_outbox');
    database.run('ALTER TABLE agent_mail_outbox_new RENAME TO agent_mail_outbox');
    database.run(
      'CREATE INDEX agent_mail_outbox_pending ON agent_mail_outbox(source_session_id,message_id) WHERE delivered_target_revision IS NULL',
    );
    database.run(KITE_CROSS_SESSION_FOLLOWUP_ROUTE_DDL);
    database.run(KITE_CROSS_SESSION_FOLLOWUP_FUNDING_DDL);
    database.run(KITE_CROSS_SESSION_FOLLOWUP_GRANT_DDL);
    database.run(KITE_CROSS_SESSION_INTERRUPT_DDL);
    database.run(KITE_CROSS_SESSION_INTERRUPT_PENDING_INDEX);
    database.query('UPDATE kite_meta SET value=? WHERE key=?').run('13', 'schema_version');
    database
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run('kite-session-cross-followup-2026-09-25', 'format_epoch');
    database.run('PRAGMA user_version = 13');
    assertKiteSessionStore13Schema(database);
    assertKiteStoreIntegrity(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE12_TABLE_COLUMNS);
    for (const table of Object.keys(KITE_SESSION_STORE12_TABLE_COLUMNS)) {
      if (table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]))
        throw new Error('Store 12 rows changed while converting the private Store 13 candidate.');
    }
    input.faultBeforeCommit?.();
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      /* SQLite may already have rolled back. */
    }
    throw error;
  }
  assertKiteSessionStore13Schema(database);
  assertKiteStoreIntegrity(database);
}
