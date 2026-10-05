import { createRequire } from 'node:module';
import {
  assertSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
} from '@kite-ai/service/sqlite-release-assets';

const require = createRequire(import.meta.url);
/** Formal Main verifies its own built-in engine before opening Profile/UI data. */
export function assertNativeSqliteEngine(identity: SqliteReleaseIdentity): void {
  if (identity.driver !== 'node:sqlite' || identity.linkage !== 'builtin')
    throw Error('native_sqlite_engine_invalid');
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const actual = db
      .prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId')
      .get() as { version: string; sourceId: string };
    assertSqliteReleaseIdentity(identity, actual);
  } finally {
    db.close();
  }
}
