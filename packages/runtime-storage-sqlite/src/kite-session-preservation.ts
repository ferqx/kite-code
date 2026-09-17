import type { Database } from 'bun:sqlite';
import {
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from './kite-home-store';

import { captureSqliteTableContentDigests } from './sqlite-table-content';

/** Exact, private comparison input for the current schema 10 Store only. */
export interface KiteSessionPreservationManifest {
  readonly schema: 'kite.session-preservation.schema10.v1';
  readonly tables: Readonly<Record<string, { readonly rows: number; readonly sha256: string }>>;
}

/** A read transaction gives one cross-table snapshot; the caller owns migration admission. */
export function captureKiteSessionPreservationManifest(
  database: Database,
): KiteSessionPreservationManifest {
  return database.transaction(() => {
    assertKiteSessionStoreSchema(database);
    assertKiteStoreIntegrity(database);
    return Object.freeze({
      schema: 'kite.session-preservation.schema10.v1' as const,
      tables: captureSqliteTableContentDigests(database, KITE_SESSION_STORE_TABLE_COLUMNS),
    });
  })();
}

/** Returns only changed table names and counts; never exposes row content or identifiers. */
export function compareKiteSessionPreservationManifests(
  before: KiteSessionPreservationManifest,
  after: KiteSessionPreservationManifest,
): { readonly preserved: boolean; readonly changedTables: readonly string[] } {
  if (
    before.schema !== 'kite.session-preservation.schema10.v1' ||
    after.schema !== 'kite.session-preservation.schema10.v1'
  ) {
    throw new Error('Store preservation manifest format is unsupported.');
  }
  const changedTables = Object.keys(KITE_SESSION_STORE_TABLE_COLUMNS).filter((table) => {
    const left = before.tables[table];
    const right = after.tables[table];
    return !left || !right || left.rows !== right.rows || left.sha256 !== right.sha256;
  });
  return Object.freeze({ preserved: changedTables.length === 0, changedTables });
}
