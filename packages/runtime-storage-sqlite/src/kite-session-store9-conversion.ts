import type { Database } from 'bun:sqlite';
import { createHash, type Hash } from 'node:crypto';
import { inspectSqliteWorkspaceAuthorityMetadataKey } from './authority';
import { createKiteHomeWorkspaceAuthority } from './kite-home-authority';
import { createKiteHomeRuntimeStorageForConnection } from './kite-home-runtime-storage';
import {
  assertKiteHomeStoreSchema,
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_HOME_STORE_TABLE_COLUMNS,
  KITE_SESSION_EFFECT_LEASE_DDL,
} from './kite-home-store';
import type { KiteHomeWorkspaceAdmission } from './kite-home-workspaces';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import {
  createKiteSessionExecutionAuthority,
  KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
} from './kite-session-execution-authority';
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

export class KiteStore9ConversionUnsupported extends Error {
  readonly code = 'store9_conversion_unsupported';
  constructor() {
    super('Store 9 contains facts outside the verified Store 10 conversion subset.');
  }
}

/** Caller owns source backup, old-process shutdown and exclusive maintenance admission. */
export function convertKiteStore9ToSessionStore10<Event, State>(input: {
  readonly database: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly isSettledState: (state: State) => boolean;
  readonly nowMs: number;
}): { readonly sessions: number; readonly recoveryRequired: number } {
  const { database } = input;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
    throw new TypeError('Time is invalid.');
  assertKiteHomeStoreSchema(database);
  assertKiteStoreIntegrity(database);
  return database.transaction(() => {
    assertKiteHomeStoreSchema(database);
    if (
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('trigger', 'view') UNION ALL SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type IN ('trigger', 'view')",
        )
        .all()
        .some((row) => row.count !== 0)
    )
      unsupported();
    const effectCount = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_effect_leases')
      .get()?.count;
    if (effectCount !== 0) unsupported();
    const originalMeta = new Map(
      database
        .query<{ key: string; value: string }, []>('SELECT key, value FROM kite_meta')
        .all()
        .map((row) => [row.key, row.value] as const),
    );
    const before = preservedBusinessDigest(database);
    const workspaces = new Map(
      database
        .query<
          {
            workspace_id: string;
            canonical_path: string;
            workspace_identity_digest: string;
            project_id: string;
            workspace_digest: string;
            display_name: string;
          },
          []
        >(
          `SELECT workspace_id, canonical_path, workspace_identity_digest, project_id,
                  workspace_digest, display_name FROM workspaces`,
        )
        .all()
        .map(
          (row) =>
            [
              row.workspace_id,
              {
                workspaceId: row.workspace_id,
                canonicalPath: row.canonical_path,
                workspaceIdentityDigest: row.workspace_identity_digest,
                projectId: row.project_id,
                workspaceDigest: row.workspace_digest,
                displayName: row.display_name,
              } satisfies KiteHomeWorkspaceAdmission,
            ] as const,
        ),
    );
    const sessions = database
      .query<{ session_id: string; workspace_id: string; state_json: string }, []>(
        `SELECT s.session_id, s.workspace_id, p.state_json FROM runtime_sessions s
           JOIN runtime_snapshots p ON p.session_id = s.session_id ORDER BY s.session_id`,
      )
      .all();
    const sessionCount = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
      .get()?.count;
    if (sessions.length !== sessionCount) unsupported();
    const expectedKeys = new Set(['schema_version', 'format_epoch']);
    const controllerKeys = new Set<string>();
    const recoveryKeys = new Set<string>();
    const operationKeys: Array<{ workspaceId: string; sessionId: string; requestId: string }> = [];
    const sessionWorkspace = new Map(sessions.map((row) => [row.session_id, row.workspace_id]));

    for (const [key, value] of originalMeta) {
      if (expectedKeys.has(key)) continue;
      const match = /^workspace_authority\/([^/]+)\/(.+)$/u.exec(key);
      if (!match) unsupported();
      const workspaceId = match[1]!;
      const localKey = match[2]!;
      if (!workspaces.has(workspaceId)) unsupported();
      const recoveryIdentityOwner = sessions.find(
        (row) =>
          row.workspace_id === workspaceId && localKey === recoveryIdentityMetaKey(row.session_id),
      );
      if (recoveryIdentityOwner) {
        if (!isCanonicalRecoveryIdentity(value)) unsupported();
        expectedKeys.add(key);
        continue;
      }
      let parsed: ReturnType<typeof inspectSqliteWorkspaceAuthorityMetadataKey>;
      try {
        parsed = inspectSqliteWorkspaceAuthorityMetadataKey(localKey);
      } catch {
        unsupported();
      }
      if (sessionWorkspace.get(parsed.sessionId) !== workspaceId) unsupported();
      if (parsed.kind === 'controller') controllerKeys.add(parsed.sessionId);
      else if (parsed.kind === 'recovery') recoveryKeys.add(parsed.sessionId);
      else if (parsed.kind === 'operation')
        operationKeys.push({
          workspaceId,
          sessionId: parsed.sessionId,
          requestId: parsed.identity,
        });
      else unsupported();
      expectedKeys.add(key);
    }
    if (expectedKeys.size !== originalMeta.size) unsupported();

    const writer = createKiteHomeWriteTransactionPort(database);
    const authorityByWorkspace = new Map(
      [...workspaces].map(
        ([id, workspace]) =>
          [id, createKiteHomeWorkspaceAuthority({ database, writer, workspace })] as const,
      ),
    );
    for (const { workspaceId, sessionId, requestId } of operationKeys) {
      const receipt = authorityByWorkspace
        .get(workspaceId)
        ?.controller.lookupOperation(sessionId, requestId);
      if (!receipt) unsupported();
    }
    const oldStorage = createKiteHomeRuntimeStorageForConnection({
      database,
      codec: input.codec,
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      ownsDatabase: false,
    });
    const seeds: Array<{ sessionId: string; value: string; needsRecovery: boolean }> = [];
    for (const row of sessions) {
      if (!controllerKeys.has(row.session_id) || !recoveryKeys.has(row.session_id)) unsupported();
      const identityKey = `workspace_authority/${row.workspace_id}/${recoveryIdentityMetaKey(row.session_id)}`;
      if (!originalMeta.has(identityKey)) unsupported();
      const old = authorityByWorkspace.get(row.workspace_id);
      if (!old) unsupported();
      const controller = old.controller.read(row.session_id);
      const recovery = old.controller.readRecovery(row.session_id);
      const allowedPair =
        (controller.status === 'idle' && recovery.status === 'normal') ||
        (controller.status === 'detached' && recovery.status === 'detached') ||
        (controller.status === 'active' && recovery.status === 'normal');
      if (
        !allowedPair ||
        recovery.controllerGeneration > controller.controllerGeneration ||
        controller.interactionGeneration !== recovery.interactionGeneration ||
        controller.controllerGeneration >= Number.MAX_SAFE_INTEGER - 1
      )
        unsupported();
      let state: State | null;
      try {
        state = oldStorage.storage.sessions.loadSnapshot<State>(row.session_id);
      } catch {
        unsupported();
      }
      if (state === null) unsupported();
      const settled = input.isSettledState(state);
      const activeRunCount = database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runtime_runs WHERE session_id = ? AND status IN ('queued', 'running', 'waiting')",
        )
        .get(row.session_id)?.count;
      const needsRecovery = controller.status !== 'idle' || !settled || activeRunCount !== 0;
      const generation = Math.max(controller.controllerGeneration + 1, needsRecovery ? 2 : 1);
      seeds.push({
        sessionId: row.session_id,
        needsRecovery,
        value: JSON.stringify({
          schema: KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
          sessionId: row.session_id,
          status: needsRecovery ? 'recovery_required' : 'idle',
          controllerGeneration: generation,
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          interactionGeneration: controller.interactionGeneration,
          leaseUntilMs: null,
          cleanupConfirmed: !needsRecovery,
          updatedAt: input.nowMs,
          revision: 1,
        }),
      });
    }
    oldStorage.close();

    database.run('DROP TABLE runtime_effect_leases');
    database.run(KITE_SESSION_EFFECT_LEASE_DDL);
    database
      .query("UPDATE kite_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(KITE_SESSION_STORE_SCHEMA_VERSION));
    database
      .query("UPDATE kite_meta SET value = ? WHERE key = 'format_epoch'")
      .run(KITE_SESSION_STORE_FORMAT_EPOCH);
    database.run(`PRAGMA user_version = ${KITE_SESSION_STORE_SCHEMA_VERSION}`);
    const insert = database.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)');
    for (const seed of seeds) insert.run(`session_execution/${seed.sessionId}`, seed.value);
    assertKiteSessionStoreSchema(database);
    const newAuthority = createKiteSessionExecutionAuthority({
      database,
      writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
    });
    for (const seed of seeds) {
      const read = newAuthority.read(seed.sessionId);
      if (
        read.status !== (seed.needsRecovery ? 'recovery_required' : 'idle') ||
        read.cleanupConfirmed === seed.needsRecovery
      )
        unsupported();
    }
    if (preservedBusinessDigest(database) !== before) unsupported();
    for (const [key, value] of originalMeta) {
      if (key === 'schema_version' || key === 'format_epoch') continue;
      if (
        database
          .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key = ?')
          .get(key)?.value !== value
      )
        unsupported();
    }
    const finalKeys = database
      .query<{ key: string }, []>('SELECT key FROM kite_meta')
      .all()
      .map((row) => row.key);
    const expectedFinalKeys = new Set([
      ...originalMeta.keys(),
      ...seeds.map((seed) => `session_execution/${seed.sessionId}`),
    ]);
    if (
      finalKeys.length !== expectedFinalKeys.size ||
      finalKeys.some((key) => !expectedFinalKeys.has(key))
    )
      unsupported();
    assertKiteStoreIntegrity(database);
    return Object.freeze({
      sessions: seeds.length,
      recoveryRequired: seeds.filter((seed) => seed.needsRecovery).length,
    });
  })();
}

function preservedBusinessDigest(database: Database): string {
  const hash = createHash('sha256');
  for (const [table, columns] of Object.entries(KITE_HOME_STORE_TABLE_COLUMNS).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (table === 'kite_meta' || table === 'runtime_effect_leases') continue;
    hash.update(`${table}\0`);
    const keys = database
      .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
      .all()
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (keys.length === 0) unsupported();
    const query = database.query<Record<string, string | number | bigint | Uint8Array | null>, []>(
      `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${keys.join(', ')}`,
    );
    (query as typeof query & { safeIntegers(enabled: boolean): unknown }).safeIntegers(true);
    for (const row of query.iterate()) {
      for (const column of columns) {
        const value = row[column];
        if (value === undefined) unsupported();
        updateValue(hash, value);
      }
    }
  }
  return hash.digest('hex');
}

function updateValue(hash: Hash, value: string | number | bigint | Uint8Array | null): void {
  const tag =
    value === null
      ? 0
      : typeof value === 'string'
        ? 1
        : typeof value === 'bigint'
          ? 2
          : typeof value === 'number'
            ? 3
            : value instanceof Uint8Array
              ? 4
              : -1;
  if (tag < 0) unsupported();
  const bytes =
    value === null
      ? Buffer.alloc(0)
      : typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : typeof value === 'bigint'
          ? Buffer.from(value.toString(10), 'ascii')
          : typeof value === 'number'
            ? (() => {
                const result = Buffer.allocUnsafe(8);
                result.writeDoubleBE(value);
                return result;
              })()
            : Buffer.from(value);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(tag, 0);
  header.writeUInt32BE(bytes.length, 1);
  hash.update(header);
  hash.update(bytes);
}

function unsupported(): never {
  throw new KiteStore9ConversionUnsupported();
}
