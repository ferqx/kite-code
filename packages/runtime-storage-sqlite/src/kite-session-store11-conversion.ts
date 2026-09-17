import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createKiteHomeRuntimeStorageForConnection } from './kite-home-runtime-storage';
import {
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_SESSION_STORE_DDL,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from './kite-home-store';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import { createKiteSessionExecutionAuthority } from './kite-session-execution-authority';
import {
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_SCHEMA_VERSION,
} from './kite-session-store-format';
import {
  isCanonicalRecoveryIdentity,
  recoveryIdentityMetaKey,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
} from './preflight';

const SOURCE_SCHEMA = 11;
const SOURCE_EPOCH = 'kite-session-accepted-runs-2026-09-15';
const PENDING_INDEX =
  "CREATE INDEX runtime_runs_pending_input ON runtime_runs(session_id) WHERE status = 'queued' AND input_json IS NOT NULL";
const findDDL = (prefix: string): string => {
  const ddl = KITE_SESSION_STORE_DDL.find((sql) => sql.startsWith(prefix));
  if (!ddl) throw new Error('Target Store DDL is incomplete.');
  return ddl;
};
const targetRunDDL = findDDL('CREATE TABLE runtime_runs ');
const targetCapabilityDDL = findDDL('CREATE TABLE capability_artifacts ');
const sourceRunDDL = targetRunDDL
  .replace(
    'terminal_json TEXT CHECK (terminal_json IS NULL OR json_valid(terminal_json)),\n    PRIMARY KEY',
    'terminal_json TEXT CHECK (terminal_json IS NULL OR json_valid(terminal_json)),\n    input_json TEXT CHECK (input_json IS NULL OR (json_valid(input_json) AND length(input_json) <= 4194304)), preparation_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (preparation_failure_count BETWEEN 0 AND 3 AND (preparation_failure_count = 0 OR input_json IS NOT NULL)), PRIMARY KEY',
  )
  .replace(
    "CHECK ((status = 'queued') = (started_at_ms IS NULL))",
    "CHECK ((status = 'queued' AND started_at_ms IS NULL) OR (status = 'cancelled') OR (status = 'failed' AND (input_json IS NOT NULL OR origin_session_id IS NOT NULL) AND last_revision = created_revision) OR (status <> 'queued' AND started_at_ms IS NOT NULL))",
  );
const sourceCapabilityDDL = targetCapabilityDDL
  .replace('invocation_id TEXT NOT NULL,', 'invocation_id TEXT NOT NULL UNIQUE,')
  .replace(
    'created_at INTEGER NOT NULL CHECK (created_at >= 0),\n    UNIQUE (invocation_id, evidence_digest)',
    'created_at INTEGER NOT NULL CHECK (created_at >= 0)',
  );
if (sourceRunDDL === targetRunDDL || sourceCapabilityDDL === targetCapabilityDDL)
  throw new Error('Source Store DDL derivation failed.');
export const KITE_SESSION_STORE11_DDL = Object.freeze([
  ...KITE_SESSION_STORE_DDL.map((sql) =>
    sql === targetRunDDL ? sourceRunDDL : sql === targetCapabilityDDL ? sourceCapabilityDDL : sql,
  ),
  PENDING_INDEX,
]);

export const KITE_SESSION_STORE11_TABLE_COLUMNS = Object.freeze({
  ...KITE_SESSION_STORE_TABLE_COLUMNS,
  runtime_runs: [
    ...KITE_SESSION_STORE_TABLE_COLUMNS.runtime_runs,
    'input_json',
    'preparation_failure_count',
  ],
} as const);

export class KiteStore11ConversionUnsupported extends Error {
  readonly code = 'store11_conversion_unsupported';
  constructor() {
    super('Store 11 contains facts outside the verified Store 10 conversion subset.');
  }
}
const unsupported = (): never => {
  throw new KiteStore11ConversionUnsupported();
};
const normalized = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** Exact observed source layout only. Value-level admission is the converter's job. */
export function assertKiteSessionStore11Schema(database: Database): void {
  const expected = new Map<string, string>();
  for (const sql of KITE_SESSION_STORE11_DDL) {
    const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/u.exec(sql);
    if (!match) throw new KiteStore11ConversionUnsupported();
    expected.set(`${match[1]}:${match[2]}`, normalized(sql));
  }
  const rows = database
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' UNION ALL SELECT type, name, sql FROM sqlite_temp_schema WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (rows.length !== expected.size) unsupported();
  for (const row of rows) {
    if (row.type !== 'table' && row.type !== 'index') unsupported();
    if (
      row.sql === null ||
      normalized(row.sql) !== expected.get(`${row.type.toUpperCase()}:${row.name}`)
    )
      unsupported();
  }
  const meta = new Map(
    database
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM kite_meta WHERE key IN ('schema_version','format_epoch')",
      )
      .all()
      .map((r) => [r.key, r.value] as const),
  );
  if (
    meta.size !== 2 ||
    meta.get('schema_version') !== String(SOURCE_SCHEMA) ||
    meta.get('format_epoch') !== SOURCE_EPOCH
  )
    unsupported();
  if (
    database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !==
    SOURCE_SCHEMA
  )
    unsupported();
  for (const [table, columns] of Object.entries(KITE_SESSION_STORE11_TABLE_COLUMNS)) {
    const actual = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) unsupported();
  }
}

const businessDigest = (database: Database): string => {
  const hash = createHash('sha256');
  for (const [table, columns] of Object.entries(KITE_SESSION_STORE_TABLE_COLUMNS).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (table === 'kite_meta') continue;
    hash.update(`${table}\0`);
    const keys = database
      .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!keys.length) unsupported();
    const query = database.query<Record<string, string | number | bigint | Uint8Array | null>, []>(
      `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${keys.join(',')}`,
    );
    (query as typeof query & { safeIntegers(enabled: boolean): unknown }).safeIntegers(true);
    for (const row of query.iterate())
      for (const column of columns) {
        const value = row[column];
        if (value === undefined) unsupported();
        const tag =
          value === null
            ? 'n'
            : typeof value === 'string'
              ? 's'
              : typeof value === 'number'
                ? 'd'
                : typeof value === 'bigint'
                  ? 'i'
                  : value instanceof Uint8Array
                    ? 'b'
                    : '?';
        if (tag === '?') unsupported();
        const bytes =
          value === null
            ? Buffer.alloc(0)
            : value instanceof Uint8Array
              ? Buffer.from(value)
              : Buffer.from(String(value));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.length);
        hash.update(tag).update(length).update(bytes);
      }
  }
  return hash.digest('hex');
};

/** Caller owns a consistent source backup, exclusive maintenance admission and old-writer shutdown. */
export function convertKiteSessionStore11To10<Event, State>(input: {
  readonly database: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly isSettledState: (state: State) => boolean;
  readonly nowMs: number;
}): { readonly sessions: number; readonly recoveryRequired: number } {
  const { database } = input;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
    throw new TypeError('Time is invalid.');
  assertKiteSessionStore11Schema(database);
  assertKiteStoreIntegrity(database);
  return database.transaction(() => {
    assertKiteSessionStore11Schema(database);
    const forbidden = database
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM runtime_runs WHERE input_json IS NOT NULL OR preparation_failure_count <> 0',
      )
      .get()?.count;
    if (forbidden !== 0) unsupported();
    const incompatibleTiming = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runtime_runs WHERE (status = 'queued') <> (started_at_ms IS NULL)",
      )
      .get()?.count;
    if (incompatibleTiming !== 0) unsupported();
    if (
      database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_effect_leases')
        .get()?.count !== 0
    )
      unsupported();
    const originalMeta = new Map(
      database
        .query<{ key: string; value: string }, []>('SELECT key,value FROM kite_meta')
        .all()
        .map((r) => [r.key, r.value] as const),
    );
    const sessions = database
      .query<{ session_id: string; workspace_id: string }, []>(
        'SELECT session_id,workspace_id FROM runtime_sessions ORDER BY session_id',
      )
      .all();
    const expectedKeys = new Set(['schema_version', 'format_epoch']);
    const originalAuthority = new Map<string, Record<string, unknown>>();
    for (const session of sessions) {
      const key = `session_execution/${session.session_id}`;
      const raw = originalMeta.get(key);
      if (!raw) throw new KiteStore11ConversionUnsupported();
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new KiteStore11ConversionUnsupported();
      }
      if (value.sessionId !== session.session_id) unsupported();
      originalAuthority.set(session.session_id, value);
      expectedKeys.add(key);
      const identityKey = `workspace_authority/${session.workspace_id}/${recoveryIdentityMetaKey(session.session_id)}`;
      if (!isCanonicalRecoveryIdentity(originalMeta.get(identityKey) ?? '')) unsupported();
      expectedKeys.add(identityKey);
    }
    if (
      expectedKeys.size !== originalMeta.size ||
      [...originalMeta.keys()].some((key) => !expectedKeys.has(key))
    )
      unsupported();
    const before = businessDigest(database);
    const runRows = database
      .query<{ session_id: string }, []>(
        "SELECT DISTINCT session_id FROM runtime_runs WHERE status IN ('queued','running','waiting')",
      )
      .all();
    const pendingSessions = new Set(runRows.map((r) => r.session_id));

    database.run('DROP INDEX runtime_runs_session_created_revision');
    database.run('DROP INDEX runtime_runs_pending_input');
    database.run(
      targetRunDDL.replace('CREATE TABLE runtime_runs (', 'CREATE TABLE runtime_runs_new ('),
    );
    database.run(
      `INSERT INTO runtime_runs_new (${KITE_SESSION_STORE_TABLE_COLUMNS.runtime_runs.join(',')}) SELECT ${KITE_SESSION_STORE_TABLE_COLUMNS.runtime_runs.join(',')} FROM runtime_runs`,
    );
    database.run('DROP TABLE runtime_runs');
    database.run('ALTER TABLE runtime_runs_new RENAME TO runtime_runs');
    database.run(
      'CREATE INDEX runtime_runs_session_created_revision ON runtime_runs(session_id, created_revision, run_id)',
    );
    database.run(
      targetCapabilityDDL.replace(
        'CREATE TABLE capability_artifacts (',
        'CREATE TABLE capability_artifacts_new (',
      ),
    );
    database.run(
      `INSERT INTO capability_artifacts_new (${KITE_SESSION_STORE_TABLE_COLUMNS.capability_artifacts.join(',')}) SELECT ${KITE_SESSION_STORE_TABLE_COLUMNS.capability_artifacts.join(',')} FROM capability_artifacts`,
    );
    database.run('DROP TABLE capability_artifacts');
    database.run('ALTER TABLE capability_artifacts_new RENAME TO capability_artifacts');
    database
      .query("UPDATE kite_meta SET value=? WHERE key='schema_version'")
      .run(String(KITE_SESSION_STORE_SCHEMA_VERSION));
    database
      .query("UPDATE kite_meta SET value=? WHERE key='format_epoch'")
      .run(KITE_SESSION_STORE_FORMAT_EPOCH);
    database.run(`PRAGMA user_version = ${KITE_SESSION_STORE_SCHEMA_VERSION}`);
    assertKiteSessionStoreSchema(database);

    const writer = createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema);
    const authority = createKiteSessionExecutionAuthority({ database, writer });
    const storage = createKiteHomeRuntimeStorageForConnection({
      database,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: 10,
      codec: input.codec,
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      ownsDatabase: false,
    });
    let recoveryRequired = 0;
    try {
      for (const session of sessions) {
        const old = originalAuthority.get(session.session_id)!;
        const parsed = authority.read(session.session_id);
        const state = storage.storage.sessions.loadSnapshot<State>(session.session_id);
        if (state === null) throw new KiteStore11ConversionUnsupported();
        storage.storage.sessions.loadEventsStrict(session.session_id);
        for (const named of storage.storage.checkpoints.listNamedSnapshots(session.session_id)) {
          if (!storage.storage.checkpoints.loadNamedSnapshot(session.session_id, named.snapshotId))
            unsupported();
        }
        const needsFence =
          parsed.status !== 'idle' ||
          pendingSessions.has(session.session_id) ||
          !input.isSettledState(state);
        if (needsFence) recoveryRequired++;
        if (needsFence && parsed.status !== 'recovery_required') {
          if (
            parsed.controllerGeneration >= Number.MAX_SAFE_INTEGER ||
            parsed.revision >= Number.MAX_SAFE_INTEGER
          )
            unsupported();
          const next = {
            ...old,
            status: 'recovery_required',
            controllerGeneration: parsed.controllerGeneration + 1,
            hostInstanceId: null,
            clientId: null,
            leaseUntilMs: null,
            cleanupConfirmed: false,
            updatedAt: input.nowMs,
            revision: parsed.revision + 1,
          };
          database
            .query('UPDATE kite_meta SET value=? WHERE key=?')
            .run(JSON.stringify(next), `session_execution/${session.session_id}`);
          const reread = authority.read(session.session_id);
          if (reread.status !== 'recovery_required' || reread.cleanupConfirmed) unsupported();
        }
      }
    } finally {
      storage.close();
    }
    if (businessDigest(database) !== before) unsupported();
    for (const [key, value] of originalMeta) {
      const updated = database
        .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
        .get(key)?.value;
      if (updated === undefined) throw new KiteStore11ConversionUnsupported();
      if (!key.startsWith('session_execution/') || updated === value) {
        if (updated !== value && key !== 'schema_version' && key !== 'format_epoch') unsupported();
      } else {
        const old = originalAuthority.get(key.slice('session_execution/'.length));
        const next = JSON.parse(updated) as Record<string, unknown>;
        if (!old || !next || typeof next !== 'object') throw new KiteStore11ConversionUnsupported();
        const allowed = new Set([
          'status',
          'controllerGeneration',
          'hostInstanceId',
          'clientId',
          'leaseUntilMs',
          'cleanupConfirmed',
          'updatedAt',
          'revision',
        ]);
        if (JSON.stringify(Object.keys(old).sort()) !== JSON.stringify(Object.keys(next).sort()))
          unsupported();
        for (const field of Object.keys(old))
          if (!allowed.has(field) && old[field] !== next[field]) unsupported();
      }
    }
    if (
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM kite_meta').get()
        ?.count !== originalMeta.size
    )
      unsupported();
    assertKiteStoreIntegrity(database);
    return Object.freeze({ sessions: sessions.length, recoveryRequired });
  })();
}
