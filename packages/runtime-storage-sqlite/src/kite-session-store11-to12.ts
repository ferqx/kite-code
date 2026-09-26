import type { Database } from 'bun:sqlite';
import {
  KITE_CHILD_APPROVAL_PROXY_DDL,
  KITE_CHILD_APPROVAL_PROXY_PARENT_INDEX,
} from './kite-child-approval-proxy';
import {
  assertKiteSessionStore11Schema,
  assertKiteSessionStore12Schema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE11_TABLE_COLUMNS,
} from './kite-home-store';
import { KITE_SESSION_AGENT_CROSS_SESSION_DDL } from './kite-session-agent-schema';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

/** Convert only a private copied candidate. The original Store 11 remains untouched. */
export function convertKiteSessionStore11CandidateTo12(input: {
  readonly database: Database;
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore11Schema(database);
  assertKiteStoreIntegrity(database);
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS);
  database.run('BEGIN IMMEDIATE');
  try {
    for (const statement of KITE_SESSION_AGENT_CROSS_SESSION_DDL) database.run(statement);
    database.run(KITE_CHILD_APPROVAL_PROXY_DDL);
    database.run(KITE_CHILD_APPROVAL_PROXY_PARENT_INDEX);
    database.query('UPDATE kite_meta SET value=? WHERE key=?').run('12', 'schema_version');
    database
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run('kite-session-child-approval-2026-09-25', 'format_epoch');
    database.run('PRAGMA user_version = 12');
    assertKiteSessionStore12Schema(database);
    assertKiteStoreIntegrity(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE11_TABLE_COLUMNS);
    for (const table of Object.keys(KITE_SESSION_STORE11_TABLE_COLUMNS)) {
      if (table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]))
        throw new Error('Store 11 rows changed while converting the private Store 12 candidate.');
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
  assertKiteSessionStore12Schema(database);
  assertKiteStoreIntegrity(database);
}
