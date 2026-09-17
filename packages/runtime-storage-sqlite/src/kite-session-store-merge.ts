import type { Database } from 'bun:sqlite';
import { inspectSqliteWorkspaceAuthorityMetadataKey } from './authority';
import {
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from './kite-home-store';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import { createKiteSessionExecutionAuthority } from './kite-session-execution-authority';
import { isCanonicalRecoveryIdentity, recoveryIdentityMetaKey } from './preflight';

/** Explicit parent-first copy order for the complete Store 10 table set. */
const TABLE_ORDER = [
  'kite_meta',
  'workspaces',
  'runtime_sessions',
  'runtime_session_tombstones',
  'runtime_events',
  'runtime_snapshots',
  'runtime_named_snapshots',
  'runtime_file_preimages',
  'runtime_command_receipts',
  'runtime_runs',
  'runtime_effect_leases',
  'model_artifacts',
  'plan_artifacts',
  'capability_artifacts',
  'filesystem_preimage_artifacts',
  'sandbox_preparation_artifacts',
  'subagent_task_artifacts',
  'subagent_lifecycle_artifacts',
  'subagent_continuation_artifacts',
] as const;

type Value = string | number | bigint | Uint8Array | null;
type Row = Record<string, Value>;

export class KiteSessionStoreMergeConflict extends Error {
  readonly code = 'session_store_merge_conflict';
  constructor() {
    super('Session Store sources cannot be merged without changing a persisted fact.');
  }
}

/** Caller owns immutable source backup, maintenance admission and target backup. */
export function mergeKiteSessionStores10(input: {
  readonly target: Database;
  readonly source: Database;
}): { readonly insertedRows: Readonly<Record<string, number>>; readonly sharedWorkspaces: number } {
  const { target, source } = input;
  if (target === source) throw new TypeError('Merge source and target must differ.');
  const expected = Object.keys(KITE_SESSION_STORE_TABLE_COLUMNS).sort();
  if (
    expected.length !== TABLE_ORDER.length ||
    TABLE_ORDER.some((table) => !expected.includes(table))
  )
    throw new Error('Session Store table mapping is incomplete.');
  return source.transaction(() =>
    target.transaction(() => {
      assertKiteSessionStoreSchema(source);
      assertKiteSessionStoreSchema(target);
      assertKiteStoreIntegrity(source);
      assertKiteStoreIntegrity(target);
      rejectExtensions(source);
      rejectExtensions(target);
      assertNoLiveAuthority(source);
      assertNoLiveAuthority(target);
      assertScopedMetadata(source);
      assertScopedMetadata(target);
      assertNoIdentityContradictions(source);
      assertNoIdentityContradictions(target);

      const insertedRows: Record<string, number> = {};
      let sharedWorkspaces = 0;
      for (const table of TABLE_ORDER) {
        const columns = KITE_SESSION_STORE_TABLE_COLUMNS[table];
        const primaryKey = source
          .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
          .all()
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
        if (primaryKey.length === 0) conflict();
        const select = `SELECT ${columns.join(', ')} FROM ${table}`;
        const sourceQuery = source.query<Row, []>(select);
        (
          sourceQuery as typeof sourceQuery & { safeIntegers(enabled: boolean): unknown }
        ).safeIntegers(true);
        const existingQuery = target.query<Row, Value[]>(
          `${select} WHERE ${primaryKey.map((column) => `${column} = ?`).join(' AND ')}`,
        );
        (
          existingQuery as typeof existingQuery & { safeIntegers(enabled: boolean): unknown }
        ).safeIntegers(true);
        const insert = target.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        );
        let inserted = 0;
        for (const row of sourceQuery.iterate()) {
          const values = columns.map((column) => row[column]);
          if (values.some((value) => value === undefined)) conflict();
          if (
            table === 'kite_meta' &&
            (row.key === 'schema_version' || row.key === 'format_epoch')
          ) {
            const current = existingQuery.get(...primaryKey.map((column) => row[column]!));
            if (!current || !sameRow(row, current, columns)) conflict();
            continue;
          }
          const current = existingQuery.get(...primaryKey.map((column) => row[column]!));
          if (!current) {
            if (table === 'workspaces') {
              const pathOwner = target
                .query<{ workspace_id: string }, [string]>(
                  'SELECT workspace_id FROM workspaces WHERE canonical_path = ?',
                )
                .get(row.canonical_path as string);
              if (pathOwner) conflict();
            }
            insert.run(...(values as Value[]));
            inserted++;
            continue;
          }
          if (table === 'workspaces') {
            const invariant = columns.filter(
              (column) => column !== 'created_at' && column !== 'updated_at',
            );
            if (!sameRow(row, current, invariant)) conflict();
            const created = minInteger(row.created_at, current.created_at);
            const updated = maxInteger(row.updated_at, current.updated_at);
            target
              .query('UPDATE workspaces SET created_at = ?, updated_at = ? WHERE workspace_id = ?')
              .run(created, updated, row.workspace_id as string);
            sharedWorkspaces++;
          } else if (!sameRow(row, current, columns)) {
            conflict();
          }
        }
        insertedRows[table] = inserted;
      }
      assertKiteSessionStoreSchema(target);
      assertKiteStoreIntegrity(target);
      assertNoLiveAuthority(target);
      assertScopedMetadata(target);
      assertNoIdentityContradictions(target);
      return Object.freeze({ insertedRows: Object.freeze(insertedRows), sharedWorkspaces });
    })(),
  )();
}

function assertScopedMetadata(database: Database): void {
  const sessionWorkspace = new Map(
    database
      .query<{ session_id: string; workspace_id: string }, []>(
        'SELECT session_id, workspace_id FROM runtime_sessions',
      )
      .all()
      .map((row) => [row.session_id, row.workspace_id] as const),
  );
  for (const row of database
    .query<{ key: string; value: string }, []>('SELECT key, value FROM kite_meta')
    .iterate()) {
    if (row.key === 'schema_version' || row.key === 'format_epoch') continue;
    if (row.key.startsWith('session_execution/')) {
      if (!sessionWorkspace.has(row.key.slice('session_execution/'.length))) conflict();
      continue;
    }
    const match = /^workspace_authority\/([^/]+)\/(.+)$/u.exec(row.key);
    if (!match) conflict();
    const workspaceId = match[1]!;
    const localKey = match[2]!;
    const recoveryOwner = [...sessionWorkspace].find(
      ([sessionId, owner]) =>
        owner === workspaceId && localKey === recoveryIdentityMetaKey(sessionId),
    );
    if (recoveryOwner) {
      if (!isCanonicalRecoveryIdentity(row.value)) conflict();
      continue;
    }
    let parsed: ReturnType<typeof inspectSqliteWorkspaceAuthorityMetadataKey>;
    try {
      parsed = inspectSqliteWorkspaceAuthorityMetadataKey(localKey);
    } catch {
      conflict();
    }
    if (
      sessionWorkspace.get(parsed.sessionId) !== workspaceId ||
      !['controller', 'recovery', 'operation'].includes(parsed.kind)
    )
      conflict();
  }
}

function assertNoIdentityContradictions(database: Database): void {
  if (
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM runtime_sessions s
      JOIN runtime_session_tombstones t ON t.session_id = s.session_id`,
      )
      .get()?.count !== 0
  )
    conflict();
  if (
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM runtime_runs child
      LEFT JOIN runtime_runs parent
        ON parent.session_id = child.origin_session_id AND parent.run_id = child.origin_run_id
      WHERE child.origin_session_id IS NOT NULL AND parent.run_id IS NULL`,
      )
      .get()?.count !== 0
  )
    conflict();
}

function assertNoLiveAuthority(database: Database): void {
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
  });
  for (const row of database
    .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
    .iterate()) {
    if (
      !database
        .query<{ key: string }, [string]>('SELECT key FROM kite_meta WHERE key = ?')
        .get(`session_execution/${row.session_id}`)
    )
      conflict();
    const state = authority.read(row.session_id);
    if (
      !(
        (state.status === 'idle' && state.cleanupConfirmed) ||
        (state.status === 'recovery_required' && !state.cleanupConfirmed)
      ) ||
      state.hostInstanceId !== null ||
      state.clientId !== null ||
      state.leaseUntilMs !== null
    )
      conflict();
    for (const effect of database
      .query<{ state: string }, [string]>(
        'SELECT state FROM runtime_effect_leases WHERE session_id = ?',
      )
      .iterate(row.session_id)) {
      if (
        effect.state === 'prepared' ||
        (effect.state === 'unknown' && state.status !== 'recovery_required')
      )
        conflict();
    }
  }
}

function rejectExtensions(database: Database): void {
  for (const master of ['sqlite_master', 'sqlite_temp_master']) {
    if (
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM ${master} WHERE type IN ('trigger', 'view')`,
        )
        .get()?.count !== 0
    )
      conflict();
  }
}

function sameRow(left: Row, right: Row, columns: readonly string[]): boolean {
  return columns.every((column) => sameValue(left[column], right[column]));
}

function sameValue(left: Value | undefined, right: Value | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (left instanceof Uint8Array || right instanceof Uint8Array)
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      Buffer.from(left).equals(Buffer.from(right))
    );
  return typeof left === typeof right && Object.is(left, right);
}

function minInteger(left: Value | undefined, right: Value | undefined): bigint {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') conflict();
  return left < right ? left : right;
}

function maxInteger(left: Value | undefined, right: Value | undefined): bigint {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') conflict();
  return left > right ? left : right;
}

function conflict(): never {
  throw new KiteSessionStoreMergeConflict();
}
