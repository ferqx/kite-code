import type { Database } from 'bun:sqlite';
import { createHash, type Hash } from 'node:crypto';

export type SqliteTableContentDigests = Readonly<
  Record<string, { readonly rows: number; readonly sha256: string }>
>;

/** Internal comparison primitive. Caller validates a known layout and owns the read transaction. */
export function captureSqliteTableContentDigests(
  database: Database,
  tableColumns: Readonly<Record<string, readonly string[]>>,
): SqliteTableContentDigests {
  const tables: Record<string, { rows: number; sha256: string }> = {};
  const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const [table, columns] of Object.entries(tableColumns).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const primaryKey = database
      .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${identifier(table)})`)
      .all()
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    if (primaryKey.length === 0) throw new Error('Store preservation table has no primary key.');
    const hash = createHash('sha256');
    hash.update(`kite.sqlite-table-content.v1\0${table}\0`);
    let rows = 0;
    const query = database.query<Record<string, string | number | bigint | Uint8Array | null>, []>(
      `SELECT ${columns.map(identifier).join(', ')} FROM ${identifier(table)} ORDER BY ${primaryKey.map(identifier).join(', ')}`,
    );
    (query as typeof query & { safeIntegers(enabled: boolean): unknown }).safeIntegers(true);
    for (const row of query.iterate()) {
      for (const column of columns) {
        const value = row[column];
        if (value === undefined) throw new Error('Store preservation column is missing.');
        updateSqliteValue(hash, value);
      }
      rows++;
    }
    tables[table] = Object.freeze({ rows, sha256: hash.digest('hex') });
  }
  return Object.freeze(tables);
}

function updateSqliteValue(hash: Hash, value: string | number | bigint | Uint8Array | null): void {
  let tag: number;
  let bytes: Buffer;
  if (value === null) {
    tag = 0;
    bytes = Buffer.alloc(0);
  } else if (typeof value === 'string') {
    tag = 1;
    bytes = Buffer.from(value, 'utf8');
  } else if (typeof value === 'bigint') {
    tag = 2;
    bytes = Buffer.from(value.toString(10), 'ascii');
  } else if (typeof value === 'number') {
    tag = 3;
    bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
  } else if (value instanceof Uint8Array) {
    tag = 4;
    bytes = Buffer.from(value);
  } else {
    throw new Error('Store preservation encountered an unsupported SQLite value.');
  }
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(tag, 0);
  header.writeUInt32BE(bytes.length, 1);
  hash.update(header);
  hash.update(bytes);
}
