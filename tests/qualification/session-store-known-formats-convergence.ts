// Offline qualification only. Inputs must be four separately prepared, consistent SQLite backups
// in this order: current Store 10, another Store 10, Store 11, legacy Store 9.
// bun run tests/qualification/session-store-known-formats-convergence.ts <10-a> <10-b> <11> <9>
// The script copies every input into a private temporary directory and never writes an input.

import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeHostStateStorageBinding,
  isRuntimeHostStateSettledForMigration,
} from '../../packages/runtime-host/src';
import {
  assertKiteSessionStoreSchema,
  convertKiteSessionStore11To10,
  convertKiteStore9ToSessionStore10,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from '../../packages/runtime-storage-sqlite/src';
import { validateKiteSessionStoreContinuity } from '../../packages/runtime-storage-sqlite/src/kite-session-continuity-validation';
import { mergeKiteSessionStores10 } from '../../packages/runtime-storage-sqlite/src/kite-session-store-merge';

type Value = string | number | bigint | Uint8Array | null;
type Row = Record<string, Value>;
const args = process.argv.slice(2);
if (args.length !== 4)
  throw new Error('Expected four explicit backup paths: Store10 Store10 Store11 Store9.');
const inputs = args.map((path) => realpathSync.native(path));
assert.equal(new Set(inputs).size, 4, 'Inputs must be distinct files.');
const root = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-convergence-')),
);
const databases: Database[] = [];
const codec = createRuntimeHostStateStorageBinding().codec;
let stage = 'open-inputs';

try {
  for (const [index, input] of inputs.entries()) {
    const source = new Database(input, { readonly: true });
    try {
      const schema = source
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version;
      assert.equal(schema, [10, 10, 11, 9][index], 'Input schema order is invalid.');
      assert.equal(
        source.query<{ quick_check: string }, []>('PRAGMA quick_check').get()?.quick_check,
        'ok',
      );
    } finally {
      source.close();
    }
    const copy = join(root, `source-${index}.sqlite`);
    copyFileSync(input, copy);
    databases.push(new Database(copy, { strict: true }));
  }
  const [target, second, eleven, nine] = databases as [Database, Database, Database, Database];
  const nowMs = Date.now();
  stage = 'convert-11';
  const result11 = convertKiteSessionStore11To10({
    database: eleven,
    codec,
    isSettledState: isRuntimeHostStateSettledForMigration,
    nowMs,
  });
  stage = 'convert-9';
  const result9 = convertKiteStore9ToSessionStore10({
    database: nine,
    codec,
    isSettledState: isRuntimeHostStateSettledForMigration,
    nowMs,
  });
  stage = 'snapshot-converted';
  for (const database of databases) assertKiteSessionStoreSchema(database);

  const sourceSessionIds = databases.map(
    (database) =>
      new Set(
        database
          .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
          .all()
          .map((row) => row.session_id),
      ),
  );
  const uniqueSessionIds = new Set(sourceSessionIds.flatMap((ids) => [...ids]));
  assert.equal(
    uniqueSessionIds.size,
    sourceSessionIds.reduce((sum, ids) => sum + ids.size, 0),
    'Source Session IDs overlap.',
  );
  const sourceRows = databases.map((database) => captureRows(database));
  stage = 'merge';
  const merges = [second, eleven, nine].map((source) =>
    mergeKiteSessionStores10({ target, source }),
  );
  verifyRows(target, sourceRows);
  stage = 'production-reads';
  const validation = validateKiteSessionStoreContinuity({ database: target, codec });
  assert.equal(validation.sessions, uniqueSessionIds.size);

  const forkOriginCount =
    target
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM runtime_runs WHERE origin_session_id IS NOT NULL',
      )
      .get()?.count ?? 0;
  const missingForkOriginCount =
    target
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM runtime_runs child LEFT JOIN runtime_runs parent
      ON parent.session_id = child.origin_session_id AND parent.run_id = child.origin_run_id
      WHERE child.origin_session_id IS NOT NULL AND parent.run_id IS NULL`,
      )
      .get()?.count ?? 0;
  assert.equal(missingForkOriginCount, 0, 'Run Fork origin is unresolved.');
  console.log(
    JSON.stringify({
      status: 'qualified',
      sourceSessions: sourceSessionIds.map((ids) => ids.size),
      finalSessions: uniqueSessionIds.size,
      source11RecoveryRequired: result11.recoveryRequired,
      source9RecoveryRequired: result9.recoveryRequired,
      insertedSessions: merges.map((merge) => merge.insertedRows.runtime_sessions),
      forkOriginCount,
      missingForkOriginCount,
      verifiedTables: Object.keys(KITE_SESSION_STORE_TABLE_COLUMNS).length,
      productionValidation: validation,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      stage,
      category: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exitCode = 1;
} finally {
  for (const database of databases) database.close(false);
  rmSync(root, { recursive: true, force: true });
}

function captureRows(database: Database): Map<string, Map<string, Row>> {
  const result = new Map<string, Map<string, Row>>();
  for (const [table, columns] of Object.entries(KITE_SESSION_STORE_TABLE_COLUMNS)) {
    const pk = database
      .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
      .all()
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    assert.ok(pk.length > 0);
    const rows = new Map<string, Row>();
    const query = database.query<Row, []>(`SELECT ${columns.join(', ')} FROM ${table}`);
    (query as typeof query & { safeIntegers(enabled: boolean): unknown }).safeIntegers(true);
    for (const row of query.iterate()) rows.set(pk.map((key) => encode(row[key]!)).join('\0'), row);
    result.set(table, rows);
  }
  return result;
}

function verifyRows(target: Database, sourceRows: readonly Map<string, Map<string, Row>>[]): void {
  const finalRows = captureRows(target);
  for (const [table, columns] of Object.entries(KITE_SESSION_STORE_TABLE_COLUMNS)) {
    const union = new Set<string>();
    for (const rows of sourceRows) {
      for (const [key, row] of rows.get(table)!) {
        union.add(key);
        const actual = finalRows.get(table)?.get(key);
        assert.ok(actual, 'A persisted row was lost.');
        if (table === 'workspaces') {
          for (const column of columns.filter(
            (name) => name !== 'created_at' && name !== 'updated_at',
          ))
            assert.equal(
              encode(actual[column]!),
              encode(row[column]!),
              'Workspace identity changed.',
            );
        } else if (
          table === 'kite_meta' &&
          (row.key === 'schema_version' || row.key === 'format_epoch')
        ) {
          assert.equal(encode(actual.value!), encode(row.value!), 'Store identity changed.');
        } else {
          for (const column of columns)
            assert.equal(
              encode(actual[column]!),
              encode(row[column]!),
              'Persisted row content changed.',
            );
        }
      }
    }
    assert.equal(finalRows.get(table)?.size, union.size, 'Unexpected merged rows.');
  }
}

function encode(value: Value): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `text:${value}`;
  if (typeof value === 'bigint') return `integer:${value}`;
  if (typeof value === 'number') return `float:${value}`;
  return `blob:${Buffer.from(value).toString('hex')}`;
}
