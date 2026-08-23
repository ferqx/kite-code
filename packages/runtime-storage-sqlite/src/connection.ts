import { constants, Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Open the one concrete SQLite connection used by the adapter lifecycle. */
export function openSqliteRuntimeConnection(databasePath: string, journalMode: string): Database {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(
    databasePath,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.run('PRAGMA busy_timeout = 5000');
    db.run(`PRAGMA journal_mode = ${journalMode}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
