import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { initializeDefaultSqliteEngine } from '../sqlite-engine';
import { decimal, openPrivate } from './files';
import { MaintenanceError } from './types';

const schemaQuery =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
let expected: { schema: string; checksum: string } | undefined;
function baseline() {
  if (expected) return expected;
  const sql = readFileSync(
    new URL('../storage/migrations/0001-baseline.sql', import.meta.url),
    'utf8',
  );
  initializeDefaultSqliteEngine();
  const db = new Database(':memory:');
  try {
    db.exec(sql);
    expected = {
      schema: JSON.stringify(db.query(schemaQuery).all()),
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
    return expected;
  } finally {
    db.close(true);
  }
}
export function openBackupDatabase(path: string): Database {
  closeSync(openPrivate(path));
  initializeDefaultSqliteEngine();
  const db = new Database(path, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW);
  try {
    db.run('PRAGMA busy_timeout=100');
    db.run('PRAGMA synchronous=FULL');
    const supported = baseline();
    if (JSON.stringify(db.query(schemaQuery).all()) !== supported.schema)
      throw new MaintenanceError('backup_store_incompatible');
    const migration = db
      .query<{ checksum: string }, []>(
        "SELECT checksum FROM schema_migration WHERE id='0001-baseline'",
      )
      .get();
    if (migration?.checksum !== supported.checksum)
      throw new MaintenanceError('backup_store_incompatible');
    if (
      db.query<{ integrity_check: string }, []>('PRAGMA integrity_check(1)').get()
        ?.integrity_check !== 'ok' ||
      db.query('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()
    )
      throw new MaintenanceError('backup_database_invalid');
    if (
      db
        .query(
          `SELECT 1 FROM execution_output o WHERE o.blob_hash IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM blob_ref r WHERE r.blob_hash=o.blob_hash) LIMIT 1`,
        )
        .get()
    )
      throw new MaintenanceError('backup_media_reference_invalid');
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}
export function capture(db: Database) {
  const row = db
    .query<{ storeId: string; formatMajor: number; snapshotCursor: string }, []>(
      `SELECT store_id AS storeId,format_major AS formatMajor,
       CAST(last_change_cursor AS TEXT) AS snapshotCursor FROM storage_meta WHERE singleton=1`,
    )
    .get();
  if (row?.formatMajor !== 1 || !row.storeId)
    throw new MaintenanceError('backup_store_incompatible');
  return {
    ...row,
    snapshotCursor: decimal(row.snapshotCursor),
    migrationChecksum: baseline().checksum,
  };
}
export interface MediaRow {
  hash: string;
  size: string;
  referenceCount: string;
}
export function mediaRows(db: Database): IterableIterator<MediaRow> {
  return db
    .query<MediaRow, []>(
      `SELECT b.hash,CAST(b.size AS TEXT) AS size,CAST(COUNT(*) AS TEXT) AS referenceCount
       FROM blob b JOIN blob_ref r ON r.blob_hash=b.hash GROUP BY b.hash ORDER BY b.hash`,
    )
    .iterate();
}
