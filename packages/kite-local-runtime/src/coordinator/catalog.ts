import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { secureWindowsStatePath, verifyWindowsStatePath } from '../service/windows-state-security';
import { COORDINATOR_SESSION_METADATA_SCHEMA, type CoordinatorSessionMetadata } from './codecs';

const CATALOG_SCHEMA_VERSION = 1;
export const COORDINATOR_CATALOG_SCHEMA_ = 'kite.local-coordinator-catalog.v1' as const;
export const COORDINATOR_CATALOG_PROFILE_ =
  'kite-coordinator-workspace-worker-web-v1-2026-08-28' as const;
const MAX_SESSIONS = 100_000;
const MAX_OPERATION_RECEIPTS = 100_000;
const MUTATING_METHODS = [
  'ensureWorkspaceWorker',
  'mintWorkerConnectionCapability',
  'ensureWebGateway',
  'stopWebGateway',
] as const;

export type CoordinatorMutationMethod = (typeof MUTATING_METHODS)[number];
export type CoordinatorOperationState = 'in_progress' | 'committed' | 'outcome_unknown';

export interface CoordinatorOperationIdentity {
  readonly idempotencyKey: string;
  readonly method: CoordinatorMutationMethod;
  readonly requestDigest: string;
}

export type CoordinatorOperationAdmission =
  | { readonly status: 'new' }
  | { readonly status: CoordinatorOperationState }
  | { readonly status: 'digest_mismatch' };

export interface CoordinatorCatalog extends AsyncDisposable {
  listSessions(): readonly CoordinatorSessionMetadata[];
  upsertSession(metadata: CoordinatorSessionMetadata): void;
  removeSession(sessionId: string): void;
  outboxCursor(workerScopeId: string): string | undefined;
  advanceOutboxCursor(workerScopeId: string, expected: string | undefined, next: string): boolean;
  admitOperation(identity: CoordinatorOperationIdentity): CoordinatorOperationAdmission;
  settleOperation(
    identity: CoordinatorOperationIdentity,
    state: Exclude<CoordinatorOperationState, 'in_progress'>,
  ): void;
  close(): void;
}

export interface CoordinatorCatalogStorageIdentity {
  /** Canonical Kite home already admitted by the layout owner. */
  readonly canonicalKiteHomeRoot: string;
  readonly layoutGeneration: string;
  /** Must be exactly layouts/<generation>/catalog.sqlite under that home. */
  readonly catalogPath: string;
  /** Only the offline layout builder may create a new target Catalog. */
  readonly mode: 'open_active' | 'initialize_target';
  /** Active-layout owner callback; invoked before every steady-state write. */
  readonly beforeWrite?: () => void;
}

export interface CoordinatorCatalogGenerationCopyInput {
  readonly canonicalKiteHomeRoot: string;
  readonly sourceLayoutGeneration: string;
  readonly targetLayoutGeneration: string;
  readonly sourceCatalogPath: string;
  readonly targetCatalogPath: string;
  readonly expectedWorkerScopeIds: readonly string[];
}

/** Offline exact Catalog copy used only while the whole Runtime layout is fenced and stopped. */
export function copyCoordinatorCatalogGeneration(
  input: CoordinatorCatalogGenerationCopyInput,
): string {
  const sourcePath = validateCatalogStorageIdentity({
    canonicalKiteHomeRoot: input.canonicalKiteHomeRoot,
    layoutGeneration: input.sourceLayoutGeneration,
    catalogPath: input.sourceCatalogPath,
    mode: 'open_active',
  });
  const targetPath = validateCatalogStorageIdentity({
    canonicalKiteHomeRoot: input.canonicalKiteHomeRoot,
    layoutGeneration: input.targetLayoutGeneration,
    catalogPath: input.targetCatalogPath,
    mode: 'initialize_target',
  });
  if (
    sourcePath === targetPath ||
    CLAIMED_CATALOGS.has(sourcePath) ||
    CLAIMED_CATALOGS.has(targetPath)
  ) {
    throw new Error('Coordinator Catalog generation copy conflicts with an active owner.');
  }
  assertNoCatalogSidecarEntries(sourcePath);
  assertNoCatalogSidecarEntries(targetPath);
  const sourceBytesBefore = readFileSync(sourcePath);
  const source = new Database(sourcePath, { readonly: true, strict: true });
  let target: Database | undefined;
  let ownedTarget: CatalogFileIdentity | undefined;
  try {
    verify(source, input.sourceLayoutGeneration);
    assertCatalogReadyForGenerationCopy(source, input.expectedWorkerScopeIds);
    writeFileSync(targetPath, source.serialize(), { flag: 'wx', mode: 0o600 });
    ownedTarget = readCatalogFileIdentity(targetPath);
    secureWindowsStatePath(targetPath, 'file', { allowOwnerInitialization: true });
    target = new Database(targetPath, { strict: true });
    target.run('PRAGMA journal_mode = DELETE');
    target
      .query<void, [string]>(
        'UPDATE coordinator_catalog_metadata SET layout_generation = ? WHERE catalog_id = 1',
      )
      .run(input.targetLayoutGeneration);
    verify(target, input.targetLayoutGeneration);
    target.run('PRAGMA wal_checkpoint(TRUNCATE)');
    target.close(false);
    target = undefined;
    assertCatalogPath(targetPath);
    assertNoCatalogSidecarEntries(targetPath);
    fsyncFile(targetPath);
    fsyncDirectory(resolve(targetPath, '..'));
    if (!readFileSync(sourcePath).equals(sourceBytesBefore)) {
      throw new Error('Coordinator Catalog source changed during generation copy.');
    }
    return createHash('sha256').update(readFileSync(targetPath)).digest('hex');
  } catch (error) {
    target?.close(false);
    if (ownedTarget) removeOwnedCatalogTarget(targetPath, ownedTarget);
    throw error;
  } finally {
    source.close(false);
  }
}

function assertCatalogReadyForGenerationCopy(
  database: Database,
  expectedWorkerScopeIds: readonly string[],
): void {
  if (!Array.isArray(expectedWorkerScopeIds) || expectedWorkerScopeIds.length > 10_000) {
    throw new Error('Coordinator Catalog migration Workspace set is invalid.');
  }
  const expected = new Set<string>();
  for (const workerScopeId of expectedWorkerScopeIds) {
    safeIdentifier(workerScopeId);
    if (expected.has(workerScopeId)) {
      throw new Error('Coordinator Catalog migration Workspace set is duplicated.');
    }
    expected.add(workerScopeId);
  }
  const catalogScopes = database
    .query<{ worker_scope_id: string }, []>(
      `SELECT worker_scope_id FROM coordinator_session_metadata
       UNION SELECT worker_scope_id FROM coordinator_worker_outbox_cursor`,
    )
    .all();
  if (catalogScopes.some((row) => !expected.has(row.worker_scope_id))) {
    throw new Error('Coordinator Catalog contains an unowned Workspace route.');
  }
  const activeOperations = database
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM coordinator_operation_receipt WHERE state = 'in_progress'",
    )
    .get()?.count;
  if (activeOperations !== 0) {
    throw new Error('Coordinator Catalog contains an unsettled operation receipt.');
  }
}

const CLAIMED_CATALOGS = new Set<string>();

/**
 * Coordinator-owned routing Catalog. It persists path-free Session routing,
 * Worker outbox cursors, and mutation idempotency state only. Runtime events,
 * presentation, Controller state, credentials, and capability values have no
 * columns and cannot be stored here.
 */
export function openCoordinatorCatalog(
  storage: CoordinatorCatalogStorageIdentity,
): CoordinatorCatalog {
  const catalogPath = validateCatalogStorageIdentity(storage);
  const existed = catalogEntryExists(catalogPath);
  if (storage.mode === 'initialize_target' && existed) {
    throw new Error('Coordinator Catalog initialize target must be absent.');
  }
  if (storage.mode === 'initialize_target') {
    assertNoCatalogSidecarEntries(catalogPath);
    assertTargetGenerationIsNotActive(storage.canonicalKiteHomeRoot, storage.layoutGeneration);
  }
  if (storage.mode === 'open_active' && !existed) {
    throw new Error('Coordinator active-layout Catalog is missing.');
  }
  if (CLAIMED_CATALOGS.has(catalogPath)) {
    throw new Error('Coordinator Catalog already has a process writer.');
  }
  CLAIMED_CATALOGS.add(catalogPath);
  let database: Database;
  let ownedTarget: CatalogFileIdentity | undefined;
  try {
    database = new Database(catalogPath, {
      create: storage.mode === 'initialize_target',
      strict: true,
    });
    if (!existed) {
      ownedTarget = readCatalogFileIdentity(catalogPath);
      secureWindowsStatePath(catalogPath, 'file', { allowOwnerInitialization: true });
    }
  } catch (error) {
    CLAIMED_CATALOGS.delete(catalogPath);
    throw error;
  }
  try {
    chmodSync(catalogPath, 0o600);
    database.run('PRAGMA journal_mode = DELETE');
    database.run('PRAGMA synchronous = FULL');
    database.run('PRAGMA foreign_keys = ON');
    if (storage.mode === 'initialize_target') initialize(database, storage.layoutGeneration);
    verify(database, storage.layoutGeneration);
    assertCatalogPath(catalogPath);
  } catch (error) {
    closeDatabaseAfterFailure(database, catalogPath, ownedTarget);
    CLAIMED_CATALOGS.delete(catalogPath);
    throw error;
  }
  let closed = false;

  const catalog: CoordinatorCatalog = {
    listSessions() {
      ensureOpen();
      return database
        .query<CoordinatorSessionRow, []>(
          `SELECT session_id, worker_scope_id, directory_revision, updated_at, tombstone
             FROM coordinator_session_metadata
            ORDER BY session_id ASC`,
        )
        .all()
        .map(decodeSessionRow);
    },
    upsertSession(metadata) {
      ensureOpen();
      const value = COORDINATOR_SESSION_METADATA_SCHEMA.parse(metadata);
      const count = database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM coordinator_session_metadata')
        .get()?.count;
      if (count === undefined || count > MAX_SESSIONS)
        throw new Error('Coordinator Catalog is invalid.');
      if (count === MAX_SESSIONS) {
        const exists = database
          .query<{ present: number }, [string]>(
            'SELECT 1 AS present FROM coordinator_session_metadata WHERE session_id = ?',
          )
          .get(value.sessionId);
        if (!exists) throw new Error('Coordinator Catalog Session bound is exhausted.');
      }
      beforeWrite();
      database
        .query<void, [string, string, string, string, number]>(
          `INSERT INTO coordinator_session_metadata
             (session_id, worker_scope_id, directory_revision, updated_at, tombstone)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             worker_scope_id = excluded.worker_scope_id,
             directory_revision = excluded.directory_revision,
             updated_at = excluded.updated_at,
             tombstone = excluded.tombstone`,
        )
        .run(
          value.sessionId,
          value.workerScopeId,
          value.directoryRevision,
          value.updatedAt,
          value.tombstone ? 1 : 0,
        );
    },
    removeSession(sessionId) {
      ensureOpen();
      safeIdentifier(sessionId);
      beforeWrite();
      database
        .query<void, [string]>('DELETE FROM coordinator_session_metadata WHERE session_id = ?')
        .run(sessionId);
    },
    outboxCursor(workerScopeId) {
      ensureOpen();
      safeIdentifier(workerScopeId);
      return database
        .query<{ cursor: string }, [string]>(
          'SELECT cursor FROM coordinator_worker_outbox_cursor WHERE worker_scope_id = ?',
        )
        .get(workerScopeId)?.cursor;
    },
    advanceOutboxCursor(workerScopeId, expected, next) {
      ensureOpen();
      safeIdentifier(workerScopeId);
      safeIdentifier(next);
      if (expected !== undefined) safeIdentifier(expected);
      return database.transaction(() => {
        const current = catalog.outboxCursor(workerScopeId);
        if (current !== expected) return false;
        beforeWrite();
        database
          .query<void, [string, string]>(
            `INSERT INTO coordinator_worker_outbox_cursor(worker_scope_id, cursor)
             VALUES (?, ?)
             ON CONFLICT(worker_scope_id) DO UPDATE SET cursor = excluded.cursor`,
          )
          .run(workerScopeId, next);
        return true;
      })();
    },
    admitOperation(identity) {
      ensureOpen();
      validateOperation(identity);
      return database.transaction((): CoordinatorOperationAdmission => {
        const existing = database
          .query<OperationRow, [string]>(
            `SELECT method, request_digest, state
               FROM coordinator_operation_receipt
              WHERE idempotency_key = ?`,
          )
          .get(identity.idempotencyKey);
        if (existing) {
          if (
            existing.method !== identity.method ||
            existing.request_digest !== identity.requestDigest
          ) {
            return { status: 'digest_mismatch' };
          }
          return { status: operationState(existing.state) };
        }
        const count = database
          .query<{ count: number }, []>(
            'SELECT COUNT(*) AS count FROM coordinator_operation_receipt',
          )
          .get()?.count;
        if (count === undefined || count >= MAX_OPERATION_RECEIPTS) {
          throw new Error('Coordinator operation receipt bound is exhausted.');
        }
        beforeWrite();
        database
          .query<void, [string, string, string]>(
            `INSERT INTO coordinator_operation_receipt
               (idempotency_key, method, request_digest, state)
             VALUES (?, ?, ?, 'in_progress')`,
          )
          .run(identity.idempotencyKey, identity.method, identity.requestDigest);
        return { status: 'new' };
      })();
    },
    settleOperation(identity, state) {
      ensureOpen();
      validateOperation(identity);
      if (state !== 'committed' && state !== 'outcome_unknown') {
        throw new TypeError('Coordinator operation terminal state is invalid.');
      }
      beforeWrite();
      const result = database
        .query<void, [string, string, string, string]>(
          `UPDATE coordinator_operation_receipt
              SET state = ?
            WHERE idempotency_key = ? AND method = ? AND request_digest = ?
              AND state = 'in_progress'`,
        )
        .run(state, identity.idempotencyKey, identity.method, identity.requestDigest);
      if (result.changes !== 1) throw new Error('Coordinator operation receipt transition failed.');
    },
    close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        // The Catalog is DELETE-journal only.  The explicit checkpoint is a
        // defensive boundary for a future SQLite option drift and makes the
        // no-sidecar invariant observable before hashing the file.
        database.run('PRAGMA journal_mode = DELETE');
        database.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        failure = error;
      }
      try {
        database.close(false);
      } catch (error) {
        failure ??= error;
      }
      CLAIMED_CATALOGS.delete(catalogPath);
      try {
        if (!failure) {
          assertCatalogPath(catalogPath);
          assertNoSqliteSidecars(catalogPath);
          fsyncFile(catalogPath);
          fsyncDirectory(resolve(catalogPath, '..'));
        }
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    },
    [Symbol.asyncDispose]() {
      catalog.close();
      return Promise.resolve();
    },
  };
  return Object.freeze(catalog);

  function ensureOpen(): void {
    if (closed) throw new Error('Coordinator Catalog is closed.');
  }

  function beforeWrite(): void {
    if (storage.mode === 'open_active') {
      if (!storage.beforeWrite) {
        throw new Error('Coordinator active-layout Catalog has no write-fence authority.');
      }
      storage.beforeWrite();
    }
  }
}

interface CoordinatorSessionRow {
  readonly session_id: string;
  readonly worker_scope_id: string;
  readonly directory_revision: string;
  readonly updated_at: string;
  readonly tombstone: number;
}

interface OperationRow {
  readonly method: string;
  readonly request_digest: string;
  readonly state: string;
}

function initialize(database: Database, layoutGeneration: string): void {
  const version = database
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get()?.user_version;
  if (version !== 0 && version !== CATALOG_SCHEMA_VERSION) {
    throw new Error('Coordinator Catalog schema is incompatible.');
  }
  if (version === CATALOG_SCHEMA_VERSION) return;
  database.transaction(() => {
    database.run(`CREATE TABLE coordinator_catalog_metadata (
      catalog_id INTEGER PRIMARY KEY NOT NULL CHECK (catalog_id = 1),
      schema TEXT NOT NULL CHECK (schema = '${COORDINATOR_CATALOG_SCHEMA_}'),
      profile TEXT NOT NULL CHECK (profile = '${COORDINATOR_CATALOG_PROFILE_}'),
      layout_generation TEXT NOT NULL
    ) STRICT`);
    database.run(`CREATE TABLE coordinator_session_metadata (
      session_id TEXT PRIMARY KEY NOT NULL,
      worker_scope_id TEXT NOT NULL,
      directory_revision TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1))
    ) STRICT`);
    database.run(`CREATE TABLE coordinator_worker_outbox_cursor (
      worker_scope_id TEXT PRIMARY KEY NOT NULL,
      cursor TEXT NOT NULL
    ) STRICT`);
    database.run(`CREATE TABLE coordinator_operation_receipt (
      idempotency_key TEXT PRIMARY KEY NOT NULL,
      method TEXT NOT NULL CHECK (method IN (
        'ensureWorkspaceWorker',
        'mintWorkerConnectionCapability',
        'ensureWebGateway',
        'stopWebGateway'
      )),
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'committed', 'outcome_unknown'))
    ) STRICT`);
    database
      .query<void, [string, string, string]>(
        'INSERT INTO coordinator_catalog_metadata(catalog_id, schema, profile, layout_generation) VALUES (1, ?, ?, ?)',
      )
      .run(COORDINATOR_CATALOG_SCHEMA_, COORDINATOR_CATALOG_PROFILE_, layoutGeneration);
    database.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
  })();
}

function verify(database: Database, layoutGeneration: string): void {
  const version = database
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get()?.user_version;
  if (version !== CATALOG_SCHEMA_VERSION) {
    throw new Error('Coordinator Catalog schema version is incompatible.');
  }
  const quick = database
    .query<{ quick_check: string }, []>('PRAGMA quick_check')
    .get()?.quick_check;
  if (quick !== 'ok') throw new Error('Coordinator Catalog integrity check failed.');
  const expected = [
    'coordinator_catalog_metadata',
    'coordinator_operation_receipt',
    'coordinator_session_metadata',
    'coordinator_worker_outbox_cursor',
  ];
  const actual = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Coordinator Catalog schema shape is invalid.');
  }
  verifyColumns(database, 'coordinator_catalog_metadata', [
    'catalog_id',
    'schema',
    'profile',
    'layout_generation',
  ]);
  const metadata = database
    .query<{ catalog_id: number; schema: string; profile: string; layout_generation: string }, []>(
      'SELECT catalog_id, schema, profile, layout_generation FROM coordinator_catalog_metadata ORDER BY catalog_id',
    )
    .all();
  if (
    metadata.length !== 1 ||
    metadata[0]?.catalog_id !== 1 ||
    metadata[0].schema !== COORDINATOR_CATALOG_SCHEMA_ ||
    metadata[0].profile !== COORDINATOR_CATALOG_PROFILE_ ||
    metadata[0].layout_generation !== layoutGeneration
  ) {
    throw new Error('Coordinator Catalog metadata is invalid.');
  }
  verifyColumns(database, 'coordinator_session_metadata', [
    'session_id',
    'worker_scope_id',
    'directory_revision',
    'updated_at',
    'tombstone',
  ]);
  verifyColumns(database, 'coordinator_worker_outbox_cursor', ['worker_scope_id', 'cursor']);
  verifyColumns(database, 'coordinator_operation_receipt', [
    'idempotency_key',
    'method',
    'request_digest',
    'state',
  ]);
}

function verifyColumns(database: Database, table: string, expected: readonly string[]): void {
  const actual = database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Coordinator Catalog column shape is invalid.');
  }
}

function decodeSessionRow(row: CoordinatorSessionRow): CoordinatorSessionMetadata {
  return COORDINATOR_SESSION_METADATA_SCHEMA.parse({
    sessionId: row.session_id,
    workerScopeId: row.worker_scope_id,
    directoryRevision: row.directory_revision,
    updatedAt: row.updated_at,
    tombstone: row.tombstone === 1,
  });
}

function validateOperation(identity: CoordinatorOperationIdentity): void {
  safeIdentifier(identity.idempotencyKey);
  if (!MUTATING_METHODS.includes(identity.method)) {
    throw new TypeError('Coordinator operation method is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.requestDigest)) {
    throw new TypeError('Coordinator operation request digest is invalid.');
  }
}

function operationState(value: string): CoordinatorOperationState {
  if (value === 'in_progress' || value === 'committed' || value === 'outcome_unknown') return value;
  throw new Error('Coordinator operation receipt state is invalid.');
}

function safeIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError('Coordinator Catalog identifier is invalid.');
  }
}

function validateCatalogStorageIdentity(storage: CoordinatorCatalogStorageIdentity): string {
  if (
    (storage.mode !== 'open_active' && storage.mode !== 'initialize_target') ||
    !isAbsolute(storage.canonicalKiteHomeRoot) ||
    realpathSync.native(storage.canonicalKiteHomeRoot) !== resolve(storage.canonicalKiteHomeRoot) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(storage.layoutGeneration)
  ) {
    throw new Error('Coordinator Catalog layout identity is invalid.');
  }
  const expected = join(
    storage.canonicalKiteHomeRoot,
    'layouts',
    storage.layoutGeneration,
    'catalog.sqlite',
  );
  if (!isAbsolute(storage.catalogPath) || resolve(storage.catalogPath) !== resolve(expected)) {
    throw new Error('Coordinator Catalog path is not the active layout identity.');
  }
  for (const directory of [
    storage.canonicalKiteHomeRoot,
    join(storage.canonicalKiteHomeRoot, 'layouts'),
    join(storage.canonicalKiteHomeRoot, 'layouts', storage.layoutGeneration),
  ]) {
    assertCatalogDirectory(directory);
  }
  if (catalogEntryExists(expected)) {
    assertCatalogPath(expected);
    const canonical = realpathSync.native(expected);
    if (canonical !== resolve(expected)) {
      throw new Error('Coordinator Catalog path aliases another file.');
    }
    return canonical;
  }
  if (storage.mode !== 'initialize_target') {
    throw new Error('Coordinator active-layout Catalog is missing.');
  }
  return resolve(expected);
}

function assertCatalogDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Coordinator Catalog directory is unsafe.');
  }
  if (realpathSync.native(path) !== resolve(path)) {
    throw new Error('Coordinator Catalog directory aliases another path.');
  }
  if (process.platform === 'win32') {
    verifyWindowsStatePath(path, 'directory');
    return;
  }
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Coordinator Catalog directory is not owner-only.');
  }
}

function assertCatalogPath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('Coordinator Catalog path is unsafe.');
  }
  if (process.platform === 'win32') {
    verifyWindowsStatePath(path, 'file');
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Coordinator Catalog permissions are not owner-only.');
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('Coordinator Catalog owner is invalid.');
  }
}

function catalogEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function assertTargetGenerationIsNotActive(
  canonicalKiteHomeRoot: string,
  targetGeneration: string,
): void {
  const pointerPath = join(canonicalKiteHomeRoot, 'active-layout');
  if (!catalogEntryExists(pointerPath)) return;
  const stat = lstatSync(pointerPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('Coordinator active-layout pointer is unsafe.');
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Coordinator active-layout pointer is not owner-only.');
    }
  } else {
    verifyWindowsStatePath(pointerPath, 'file');
  }
  const raw = readFileSync(pointerPath, 'utf8');
  if (raw.length > 4096) throw new Error('Coordinator active-layout pointer is oversized.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Coordinator active-layout pointer is invalid.');
  }
  if (!isExactActiveLayoutPointer(value)) {
    throw new Error('Coordinator active-layout pointer is invalid.');
  }
  try {
    assertCatalogDirectory(join(canonicalKiteHomeRoot, 'layouts', value.generation));
  } catch {
    throw new Error('Coordinator active-layout pointer is invalid.');
  }
  if (value.generation === targetGeneration) {
    throw new Error('Coordinator Catalog target generation is already active.');
  }
}

function isExactActiveLayoutPointer(
  value: unknown,
): value is { readonly schema: 'kite.runtime-active-layout.v1'; readonly generation: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 2) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === 'kite.runtime-active-layout.v1' &&
    typeof record.generation === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.generation)
  );
}

function assertNoSqliteSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${path}${suffix}`;
    if (!catalogEntryExists(sidecar)) continue;
    const stat = lstatSync(sidecar);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    ) {
      throw new Error('Coordinator Catalog SQLite sidecar is unsafe.');
    }
    throw new Error('Coordinator Catalog SQLite sidecar remains after close.');
  }
}

function assertNoCatalogSidecarEntries(path: string): void {
  if (['-wal', '-shm'].some((suffix) => catalogEntryExists(`${path}${suffix}`))) {
    throw new Error('Coordinator Catalog target has pre-existing SQLite sidecar evidence.');
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  // Windows does not expose directory handles through the Node/Bun portable
  // fsync API. Hosted Windows qualification verifies the equivalent atomic
  // publication contract; POSIX must provide the durable parent barrier.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface CatalogFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function readCatalogFileIdentity(path: string): CatalogFileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('Coordinator Catalog path is unsafe.');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function closeDatabaseAfterFailure(
  database: Database,
  path: string,
  ownedTarget: CatalogFileIdentity | undefined,
): void {
  try {
    database.close(false);
  } finally {
    if (ownedTarget) removeOwnedCatalogTarget(path, ownedTarget);
  }
}

function removeOwnedCatalogTarget(path: string, identity: CatalogFileIdentity): void {
  if (!catalogEntryExists(path)) return;
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  ) {
    return;
  }
  unlinkSync(path);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
