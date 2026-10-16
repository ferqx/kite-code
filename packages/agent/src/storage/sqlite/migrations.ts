import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const schemaQuery =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
export type SchemaVersion = {
  schema: string;
  checksum: string;
  migrations: { id: string; checksum: string; sql: string }[];
};
const cache = new Map<string, SchemaVersion[]>();
/** Closed, explicitly supported additive schema versions; no arbitrary migration discovery. */
export function supportedSchemas(
  baseline = new URL('../migrations/0001-baseline.sql', import.meta.url),
): SchemaVersion[] {
  const cached = cache.get(baseline.href);
  if (cached) return cached;
  const db = new Database(':memory:');
  const result: SchemaVersion[] = [];
  const migrations: SchemaVersion['migrations'] = [];
  try {
    for (const id of ['0001-baseline', '0002-recovery-audit']) {
      const sql = readFileSync(new URL(`./${id}.sql`, baseline), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      db.exec(sql);
      migrations.push({ id, checksum, sql });
      result.push({
        schema: JSON.stringify(db.query(schemaQuery).all()),
        checksum:
          migrations.length === 1
            ? checksum
            : createHash('sha256')
                .update(migrations.map((item) => item.checksum).join(':'))
                .digest('hex'),
        migrations: [...migrations],
      });
    }
    cache.set(baseline.href, result);
    return result;
  } finally {
    db.close(true);
  }
}
export function matchingSchema(db: Database, baseline?: URL): SchemaVersion | undefined {
  const schema = JSON.stringify(db.query(schemaQuery).all());
  const version = supportedSchemas(baseline).find((candidate) => candidate.schema === schema);
  if (!version) return undefined;
  const migrations = db
    .query<{ id: string; checksum: string }, []>(
      'SELECT id,checksum FROM schema_migration ORDER BY id',
    )
    .all();
  if (
    migrations.length !== version.migrations.length ||
    version.migrations.some(
      (item, index) =>
        migrations[index]?.id !== item.id || migrations[index]?.checksum !== item.checksum,
    )
  )
    return undefined;
  return version;
}
