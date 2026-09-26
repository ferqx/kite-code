import type { Database } from 'bun:sqlite';
import {
  KITE_CHILD_SESSION_INTENT_DDL,
  KITE_CHILD_SESSION_INTENT_PENDING_INDEX,
} from './kite-child-session-intents';
import {
  assertKiteSessionStore10Schema,
  assertKiteSessionStore11Schema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE10_TABLE_COLUMNS,
} from './kite-home-store';
import { KITE_SESSION_AGENT_DDL } from './kite-session-agent-schema';
import { captureSqliteTableContentDigests } from './sqlite-table-content';

/**
 * Convert only the private copied candidate created by createKiteSessionStoreCandidate.
 * The original Store is opened READONLY by its verified-backup owner and is never passed here.
 */
export function convertKiteSessionStore10CandidateTo11(input: {
  readonly database: Database;
  /** Test-only failure before COMMIT, to prove the candidate rolls back to exact Store 10. */
  readonly faultBeforeCommit?: () => void;
}): void {
  const database = input.database;
  assertKiteSessionStore10Schema(database);
  assertKiteStoreIntegrity(database);
  const before = captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS);
  database.run('BEGIN IMMEDIATE');
  try {
    // Nullable lineage preserves every Store 10 Session as a top-level root.
    database.run(
      'ALTER TABLE runtime_sessions ADD COLUMN parent_session_id TEXT REFERENCES runtime_sessions(session_id)',
    );
    for (const statement of KITE_SESSION_AGENT_DDL) database.run(statement);
    database.run(KITE_CHILD_SESSION_INTENT_DDL);
    database.run(KITE_CHILD_SESSION_INTENT_PENDING_INDEX);
    database.query('UPDATE kite_meta SET value = ? WHERE key = ?').run('11', 'schema_version');
    database
      .query('UPDATE kite_meta SET value = ? WHERE key = ?')
      .run('kite-session-lineage-2026-09-24', 'format_epoch');
    database.run('PRAGMA user_version = 11');
    assertKiteSessionStore11Schema(database);
    assertKiteStoreIntegrity(database);
    const after = captureSqliteTableContentDigests(database, KITE_SESSION_STORE10_TABLE_COLUMNS);
    if (
      Object.keys(KITE_SESSION_STORE10_TABLE_COLUMNS).some(
        (table) =>
          table !== 'kite_meta' && JSON.stringify(before[table]) !== JSON.stringify(after[table]),
      )
    ) {
      throw new Error('Store 10 rows changed while converting the private Store 11 candidate.');
    }
    input.faultBeforeCommit?.();
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // SQLite may have already rolled back a failed statement.
    }
    throw error;
  }
  assertKiteSessionStore11Schema(database);
  assertKiteStoreIntegrity(database);
}
