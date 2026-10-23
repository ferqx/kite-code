import type { Database } from 'bun:sqlite';
import { supportedSchemas } from '../../../src/storage/sqlite/migrations';

/** Restore actual historical DDL, including its runless-Model prohibition.
 * Removing a migration ledger row alone would leave a false legacy fixture. */
export function restoreLegacyExecutionSchema(db: Database, schemaIndex: number) {
  const schema = JSON.parse(supportedSchemas()[schemaIndex]!.schema) as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }[];
  const table = schema.find((row) => row.type === 'table' && row.name === 'execution')!;
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
  try {
    const read = db.query('SELECT * FROM execution');
    (read as typeof read & { safeIntegers(value: boolean): typeof read }).safeIntegers(true);
    const rows = read.all() as Record<string, string | number | bigint | null>[];
    db.exec('DROP TABLE execution');
    db.exec(table.sql);
    if (rows.length) {
      const columns = Object.keys(rows[0]!);
      const insert = db.query(
        `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      );
      for (const row of rows) insert.run(...columns.map((column) => row[column]!));
    }
    for (const object of schema.filter(
      (row) =>
        row.tbl_name === 'execution' && (row.type === 'index' || row.type === 'trigger') && row.sql,
    ))
      db.exec(object.sql);
    db.run("DELETE FROM schema_migration WHERE id='0005-authorization-check'");
    db.exec('DROP TABLE IF EXISTS input_file_import');
    db.run("DELETE FROM schema_migration WHERE id='0006-input-file-imports'");
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table=OFF');
  }
}
