import { constants, Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ArtifactPort,
  type CheckpointPort,
  canonicalRuntimeDataOriginSetV1,
  createArtifactPortV1,
  type EffectLeasePort,
  RUNTIME_DATA_ORIGIN_ARTIFACT_NAMESPACE_V1,
  RUNTIME_EGRESS_AUTHORITY_ARTIFACT_NAMESPACE_V1,
  type RuntimeDataOriginLedgerPortV1,
  type RuntimeDataOriginRecordV1,
  type RuntimeEgressAuthorityLedgerPortV1,
  type RuntimeEgressAuthorityRecordV1,
  type RuntimeEventMetadataV1,
  type RuntimeFileRestoreMaterialV1,
  type RuntimePersistedAuthorityCodecV1,
  type RuntimeRecoveryIdentityPortV1,
  type RuntimeSessionInfoV1,
  type RuntimeSessionModelRouteV1,
  type RuntimeSnapshotCodecV1,
  type RuntimeSnapshotMetadataV1,
  type RuntimeStorage,
  type RuntimeStorageBoundaryV1,
  type RuntimeTransactionInputV1,
  RuntimeUniqueReceiptConflictErrorV1,
  type RuntimeUniqueReceiptV1,
  type SessionStore,
  type StoredRuntimeEventV1,
} from '@kite/runtime-host/storage';

export const SQLITE_RUNTIME_STATE_SCHEMA_VERSION = 25;
export const SQLITE_RUNTIME_STORE_SCHEMA_VERSION = 4;
export const SQLITE_RUNTIME_FORMAT_EPOCH = 'kite-runtime-2026-08-18' as const;
export interface SqliteRuntimeFormatProfileV1 {
  readonly stateSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly formatEpoch: string;
}
export type SqliteRuntimeJournalModeV1 = 'wal' | 'delete';

/** Platform-safe journal mode shared by the target Store5 implementation and legacy tests. */
export function defaultSqliteRuntimeJournalModeV1(): SqliteRuntimeJournalModeV1 {
  return process.platform === 'win32' ? 'delete' : 'wal';
}

/** Test-only legacy Store4 path derivation; production uses sqliteRuntimeStorePathForV2. */
export function sqliteRuntimeStorePathForV1(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/, '')}.runtime.db`;
}

export class SqliteRuntimeStorageOpenError extends Error {
  readonly code = 'invalid_configuration' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SqliteRuntimeStorageOpenError';
  }
}

export class SqliteRuntimeFormatIncompatibleError extends Error {
  readonly actualSchemaVersion: number | null;
  readonly actualFormatEpoch: string | null;

  constructor(
    actualSchemaVersion: number | null,
    actualFormatEpoch: string | null,
    cause?: unknown,
  ) {
    super(
      `Runtime format is incompatible (schema=${actualSchemaVersion ?? 'missing'}, epoch=${actualFormatEpoch ?? 'missing'}).`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SqliteRuntimeFormatIncompatibleError';
    this.actualSchemaVersion = actualSchemaVersion;
    this.actualFormatEpoch = actualFormatEpoch;
  }
}

export class SqliteRuntimeRevisionConflictError extends Error {
  constructor(sessionId: string, expected: number, actual: number | null, detail?: string) {
    super(
      detail ??
        `Runtime revision conflict for ${sessionId}: expected ${expected}, found ${actual ?? 'deleted'}.`,
    );
    this.name = 'SqliteRuntimeRevisionConflictError';
  }
}

export class SqliteRuntimeEffectLeaseConflictError extends Error {
  constructor(sessionId: string, effectId: string) {
    super(`Runtime effect lease is stale for ${sessionId}/${effectId}; commit refused.`);
    this.name = 'SqliteRuntimeEffectLeaseConflictError';
  }
}

export class SqliteRuntimeUniqueReceiptConflictError extends RuntimeUniqueReceiptConflictErrorV1 {
  constructor(cause?: unknown) {
    super(cause);
    this.name = 'SqliteRuntimeUniqueReceiptConflictError';
  }
}

export type SqliteRuntimeSnapshotCodecV1<Event = unknown, State = unknown> = RuntimeSnapshotCodecV1<
  Event,
  State
>;

export type SqliteRuntimeUniqueReceiptV1 = RuntimeUniqueReceiptV1;

export interface SqliteRuntimeStorageOptionsV1 {
  readonly journalMode?: SqliteRuntimeJournalModeV1;
  /** Test-only deterministic SQLITE_FULL injection. */
  readonly faultInjectionMaxPageCount?: number;
}

export interface SqliteRuntimeStorageInputV1<Event = unknown, State = unknown> {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodecV1<Event, State>;
  readonly artifacts?: ArtifactPort;
  readonly options?: SqliteRuntimeStorageOptionsV1;
  /** Optional session boundary to check before the write connection is opened. */
  readonly sessionId?: string;
  /** Host-owned extraction of a one-shot receipt permit from an opaque event. */
  readonly uniqueReceiptForEvent?: (event: Event) => SqliteRuntimeUniqueReceiptV1 | null;
  /** Required by Store5; omitted only by the isolated legacy Store4 constructor. */
  readonly persistedAuthority?: RuntimePersistedAuthorityCodecV1;
}

interface SqliteRuntimeStorageInternalInputV1<Event = unknown, State = unknown>
  extends SqliteRuntimeStorageInputV1<Event, State> {
  readonly formatProfile?: SqliteRuntimeFormatProfileV1;
}

interface EventRow {
  id: number;
  thread_id: string;
  event_json: string;
  created_at: number;
  event_id: string | null;
  revision: number;
  causation_id: string | null;
  occurred_at: string | null;
}

interface SnapshotRow {
  thread_id: string;
  state_json: string;
  created_at: number;
  event_position: number;
  state_revision: number;
  state_checksum: string;
  schema_version: number;
}

interface NamedSnapshotRow extends SnapshotRow {
  name: string;
}

interface Store5ReceiptRowV1 {
  invocation_id: string;
  nonce_namespace: string;
  nonce_digest: string;
  consumed_at: string;
  authority_envelope: string;
  thread_id: string;
  receipt_digest: string;
  origin_digest: string;
  source_origin_ids_json: string;
  egress_authority_id: string;
  route_identity: string;
  expires_at: string;
}

interface Store5DataOriginRowV1 {
  origin_id: string;
  kind: string;
  observation_id: string;
  project_id: string;
  classification: string;
  parent_origins_json: string;
  authority_envelope: string;
}

interface Store5EgressAuthorityRowV1 {
  egress_id: string;
  destination_id: string;
  destination_kind: string;
  route_identity: string;
  nonce_namespace: string;
  invocation_id: string;
  origin_ids_json: string;
  allowed_classifications_json: string;
  allowed_origin_kinds_json: string;
  expires_at: string;
  authority_envelope: string;
}

function verifyStore5ReceiptRowV1(
  row: Store5ReceiptRowV1,
  persistedAuthority: RuntimePersistedAuthorityCodecV1,
): void {
  const serializedPayload = persistedAuthority.verify({
    kind: 'receipt',
    domain: 'mcp-egress-receipt-v1',
    identity: `${row.thread_id}/receipt/${row.invocation_id}/${row.nonce_digest}`,
    serialized: row.authority_envelope,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(serializedPayload);
  } catch {
    throw new SqliteRuntimeStorageOpenError('Store5 receipt authority payload is invalid.');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !==
      'consumedAt,egressAuthorityId,expiresAt,invocationId,nonceDigest,nonceNamespace,originDigest,receiptDigest,routeIdentity,sourceOriginIds,threadId' ||
    (payload as Record<string, unknown>).invocationId !== row.invocation_id ||
    (payload as Record<string, unknown>).nonceNamespace !== row.nonce_namespace ||
    (payload as Record<string, unknown>).nonceDigest !== row.nonce_digest ||
    (payload as Record<string, unknown>).consumedAt !== row.consumed_at ||
    (payload as Record<string, unknown>).threadId !== row.thread_id ||
    (payload as Record<string, unknown>).receiptDigest !== row.receipt_digest ||
    (payload as Record<string, unknown>).originDigest !== row.origin_digest ||
    JSON.stringify((payload as Record<string, unknown>).sourceOriginIds) !==
      row.source_origin_ids_json ||
    (payload as Record<string, unknown>).egressAuthorityId !== row.egress_authority_id ||
    (payload as Record<string, unknown>).routeIdentity !== row.route_identity ||
    (payload as Record<string, unknown>).expiresAt !== row.expires_at
  ) {
    throw new SqliteRuntimeStorageOpenError('Store5 receipt authority row mismatch.');
  }
}

const DATA_ORIGIN_KINDS_V1 = new Set(['runtime', 'project', 'user', 'external', 'credential']);
const DATA_CLASSIFICATIONS_V1 = new Set(['public', 'internal', 'confidential', 'secret']);

function canonicalDataOriginPayloadV1(origin: RuntimeDataOriginRecordV1): string {
  return JSON.stringify({
    originId: origin.originId,
    kind: origin.kind,
    classification: origin.classification,
    ownerProjectId: origin.ownerProjectId,
    parentOriginIds: [...origin.parentOriginIds],
    observationId: origin.observationId,
  });
}

function assertDataOriginRecordV1(origin: RuntimeDataOriginRecordV1): void {
  const parents = [...origin.parentOriginIds];
  if (
    !origin.originId ||
    !DATA_ORIGIN_KINDS_V1.has(origin.kind) ||
    !DATA_CLASSIFICATIONS_V1.has(origin.classification) ||
    !origin.ownerProjectId.startsWith('project_') ||
    !origin.observationId ||
    parents.some((parent) => !parent || parent === origin.originId) ||
    new Set(parents).size !== parents.length ||
    parents.some((parent, index) => index > 0 && parents[index - 1]! >= parent)
  ) {
    throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin record is invalid.');
  }
}

function decodeDataOriginPayloadV1(payload: string): RuntimeDataOriginRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin payload is not JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin payload is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(',') !==
      'originId,kind,classification,ownerProjectId,parentOriginIds,observationId' ||
    typeof record.originId !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.classification !== 'string' ||
    typeof record.ownerProjectId !== 'string' ||
    !Array.isArray(record.parentOriginIds) ||
    record.parentOriginIds.some((parent) => typeof parent !== 'string') ||
    typeof record.observationId !== 'string'
  ) {
    throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin payload schema is invalid.');
  }
  const origin = {
    originId: record.originId,
    kind: record.kind,
    classification: record.classification,
    ownerProjectId: record.ownerProjectId,
    parentOriginIds: Object.freeze([...(record.parentOriginIds as string[])]),
    observationId: record.observationId,
  } as RuntimeDataOriginRecordV1;
  assertDataOriginRecordV1(origin);
  if (canonicalDataOriginPayloadV1(origin) !== payload) {
    throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin payload is not canonical.');
  }
  return Object.freeze(origin);
}

function withArtifactNamespaceV1(
  base: ArtifactPort,
  namespace: string,
  access: object,
): ArtifactPort {
  if (base.getNamespace(namespace)) {
    throw new SqliteRuntimeStorageOpenError(`Artifact namespace is already bound: ${namespace}`);
  }
  const names = Object.freeze([...base.listNamespaces(), namespace].sort());
  return Object.freeze({
    getNamespace<Access extends object = object>(requested: string): Access | null {
      return requested === namespace ? (access as Access) : base.getNamespace<Access>(requested);
    },
    listNamespaces: () => names,
  });
}

function canonicalEgressAuthorityPayloadV1(authority: RuntimeEgressAuthorityRecordV1): string {
  return JSON.stringify({
    egressId: authority.egressId,
    destinationId: authority.destinationId,
    destinationKind: authority.destinationKind,
    routeIdentity: authority.routeIdentity,
    nonceNamespace: authority.nonceNamespace,
    invocationId: authority.invocationId,
    originIds: [...authority.originIds],
    allowedClassifications: [...authority.allowedClassifications],
    allowedOriginKinds: [...authority.allowedOriginKinds],
    expiresAt: authority.expiresAt,
  });
}

function assertEgressAuthorityRecordV1(authority: RuntimeEgressAuthorityRecordV1): void {
  const originIds = [...authority.originIds];
  if (
    !authority.egressId ||
    !authority.destinationId ||
    !['model', 'mcp', 'filesystem', 'process'].includes(authority.destinationKind) ||
    !authority.routeIdentity ||
    !authority.nonceNamespace ||
    !authority.invocationId ||
    originIds.length === 0 ||
    new Set(originIds).size !== originIds.length ||
    originIds.some(
      (originId, index) => !originId || (index > 0 && originIds[index - 1]! >= originId),
    ) ||
    authority.allowedClassifications.length === 0 ||
    authority.allowedClassifications.some((value) => !DATA_CLASSIFICATIONS_V1.has(value)) ||
    authority.allowedOriginKinds.length === 0 ||
    authority.allowedOriginKinds.some((value) => !DATA_ORIGIN_KINDS_V1.has(value)) ||
    !Number.isFinite(Date.parse(authority.expiresAt))
  ) {
    throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority record is invalid.');
  }
}

function decodeEgressAuthorityPayloadV1(payload: string): RuntimeEgressAuthorityRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority payload is not JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority payload is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(',') !==
      'egressId,destinationId,destinationKind,routeIdentity,nonceNamespace,invocationId,originIds,allowedClassifications,allowedOriginKinds,expiresAt' ||
    typeof record.egressId !== 'string' ||
    typeof record.destinationId !== 'string' ||
    typeof record.destinationKind !== 'string' ||
    typeof record.routeIdentity !== 'string' ||
    typeof record.nonceNamespace !== 'string' ||
    typeof record.invocationId !== 'string' ||
    !Array.isArray(record.originIds) ||
    record.originIds.some((entry) => typeof entry !== 'string') ||
    !Array.isArray(record.allowedClassifications) ||
    record.allowedClassifications.some((entry) => typeof entry !== 'string') ||
    !Array.isArray(record.allowedOriginKinds) ||
    record.allowedOriginKinds.some((entry) => typeof entry !== 'string') ||
    typeof record.expiresAt !== 'string'
  ) {
    throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority payload schema is invalid.');
  }
  const authority = {
    egressId: record.egressId,
    destinationId: record.destinationId,
    destinationKind: record.destinationKind,
    routeIdentity: record.routeIdentity,
    nonceNamespace: record.nonceNamespace,
    invocationId: record.invocationId,
    originIds: Object.freeze([...(record.originIds as string[])]),
    allowedClassifications: Object.freeze([...(record.allowedClassifications as string[])]),
    allowedOriginKinds: Object.freeze([...(record.allowedOriginKinds as string[])]),
    expiresAt: record.expiresAt,
  } as RuntimeEgressAuthorityRecordV1;
  assertEgressAuthorityRecordV1(authority);
  if (canonicalEgressAuthorityPayloadV1(authority) !== payload) {
    throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority payload is not canonical.');
  }
  return Object.freeze(authority);
}

function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function tableExists(database: Database, table: string): boolean {
  return Boolean(
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.count,
  );
}

const STORE_TABLE_COLUMNS = {
  runtime_events: [
    'id',
    'thread_id',
    'event_json',
    'event_id',
    'revision',
    'causation_id',
    'occurred_at',
    'created_at',
  ],
  runtime_sessions: ['thread_id', 'name', 'model_provider', 'model_name', 'updated_at'],
  runtime_named_snapshots: [
    'thread_id',
    'name',
    'event_position',
    'state_json',
    'state_revision',
    'state_checksum',
    'schema_version',
    'created_at',
  ],
  runtime_snapshots: [
    'thread_id',
    'state_json',
    'event_position',
    'state_revision',
    'state_checksum',
    'schema_version',
    'created_at',
  ],
  runtime_file_preimages: [
    'thread_id',
    'path',
    'event_position',
    'content',
    'existed',
    'post_hash',
    'post_existed',
    'created_at',
  ],
  runtime_mcp_egress_nonces: [
    'thread_id',
    'nonce_digest',
    'invocation_id',
    'receipt_digest',
    'expires_at',
    'created_at',
  ],
  runtime_effect_leases: ['thread_id', 'effect_id', 'owner_id', 'expires_at_ms'],
} as const;

const STORE5_TABLE_COLUMNS = {
  runtime_store_meta: ['key', 'value'],
  runtime_events: [
    'session_id',
    'event_id',
    'sequence',
    'schema_version',
    'event_json',
    'causation_id',
    'occurred_at',
    'created_at',
  ],
  runtime_sessions: [
    'session_id',
    'project_id',
    'workspace_digest',
    'state_schema',
    'format_epoch',
    'revision',
    'name',
    'model_provider',
    'model_name',
    'updated_at',
  ],
  runtime_snapshots: [
    'session_id',
    'schema_version',
    'format_epoch',
    'revision',
    'state_json',
    'event_position',
    'state_checksum',
    'created_at',
  ],
  runtime_named_snapshots: [
    'session_id',
    'name',
    'schema_version',
    'format_epoch',
    'revision',
    'state_json',
    'event_position',
    'state_checksum',
    'created_at',
  ],
  runtime_file_preimages: [
    'session_id',
    'path',
    'event_position',
    'content',
    'existed',
    'post_hash',
    'post_existed',
    'created_at',
  ],
  runtime_effect_leases: [
    'session_id',
    'effect_id',
    'owner_id',
    'lease_revision',
    'certainty',
    'expires_at_ms',
  ],
  runtime_mcp_egress_nonces: [
    'invocation_id',
    'nonce_namespace',
    'nonce_digest',
    'consumed_at',
    'authority_envelope',
    'thread_id',
    'receipt_digest',
    'origin_digest',
    'source_origin_ids_json',
    'egress_authority_id',
    'route_identity',
    'expires_at',
    'created_at',
  ],
  runtime_data_origins: [
    'origin_id',
    'kind',
    'observation_id',
    'project_id',
    'classification',
    'parent_origins_json',
    'authority_envelope',
  ],
  runtime_egress_authorities: [
    'egress_id',
    'destination_id',
    'destination_kind',
    'route_identity',
    'nonce_namespace',
    'invocation_id',
    'origin_ids_json',
    'allowed_classifications_json',
    'allowed_origin_kinds_json',
    'expires_at',
    'authority_envelope',
  ],
} as const;

const RECOVERY_IDENTITY_META_PREFIX = 'recovery_identity_v1:';

function assertNonEmptySessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SqliteRuntimeStorageOpenError('Runtime recovery identity requires a sessionId.');
  }
}

function isCanonicalRecoveryIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function recoveryIdentityMetaKey(sessionId: string): string {
  assertNonEmptySessionId(sessionId);
  const bytes = new TextEncoder().encode(sessionId);
  let encoded = '';
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0');
  return `${RECOVERY_IDENTITY_META_PREFIX}${encoded}`;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function rejectSymlink(path: string, label: string, allowMissing = true): void {
  const stat = lstatIfPresent(path);
  if (!stat && allowMissing) return;
  if (stat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError(`${label} must not be a symlink.`);
  }
}

function assertNoFollowDatabasePath(dbPath: string): void {
  if (dbPath === ':memory:') return;
  rejectSymlink(dbPath, 'SQLite database path');
  rejectSymlink(dirname(dbPath), 'SQLite database parent');
}

function copyNoFollowFile(sourcePath: string, targetPath: string, label: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) {
      throw new SqliteRuntimeStorageOpenError(`${label} must be a regular file.`);
    }
    writeFileSync(targetPath, readFileSync(descriptor), { flag: 'wx' });
  } catch (error) {
    if (error instanceof SqliteRuntimeStorageOpenError) throw error;
    throw new SqliteRuntimeStorageOpenError(
      `SQLite preflight could not safely copy ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertStoreShape(database: Database): void {
  for (const [table, required] of Object.entries(STORE_TABLE_COLUMNS)) {
    if (!tableExists(database, table)) throw new SqliteRuntimeFormatIncompatibleError(null, null);
    const columns = new Set(
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((entry) => entry.name),
    );
    if (required.some((column) => !columns.has(column))) {
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  }
}

function assertStore5Shape(database: Database): void {
  const expectedTables = Object.keys(STORE5_TABLE_COLUMNS).sort();
  const actualTables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((entry) => entry.name);
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw new SqliteRuntimeFormatIncompatibleError(null, null);
  }
  for (const [table, required] of Object.entries(STORE5_TABLE_COLUMNS)) {
    if (!tableExists(database, table)) throw new SqliteRuntimeFormatIncompatibleError(null, null);
    const columns = new Set(
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((entry) => entry.name),
    );
    if (columns.size !== required.length || required.some((column) => !columns.has(column))) {
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  }
  const expectedIndexes = [
    'runtime_data_origins_observation',
    'runtime_egress_authorities_invocation',
    'runtime_events_session_sequence',
    'runtime_file_preimages_position',
  ];
  const actualIndexes = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    )
    .all()
    .map((entry) => entry.name);
  if (
    actualIndexes.length !== expectedIndexes.length ||
    actualIndexes.some((index, position) => index !== expectedIndexes[position])
  ) {
    throw new SqliteRuntimeFormatIncompatibleError(null, null);
  }
}

function openPreflightView(dbPath: string): { database: Database; close: () => void } {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assertNoFollowDatabasePath(dbPath);
  const walStat = lstatIfPresent(walPath);
  const shmStat = lstatIfPresent(shmPath);
  if (walStat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError('SQLite WAL source must not be a symlink.');
  }
  if (shmStat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError('SQLite SHM source must not be a symlink.');
  }
  if (!walStat) {
    const immutableUrl = pathToFileURL(dbPath);
    immutableUrl.searchParams.set('immutable', '1');
    const database = new Database(
      immutableUrl.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW,
    );
    return { database, close: () => database.close() };
  }
  const copyRoot = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-preflight-'));
  const copyPath = join(copyRoot, basename(dbPath));
  try {
    copyNoFollowFile(dbPath, copyPath, 'SQLite database');
    copyNoFollowFile(walPath, `${copyPath}-wal`, 'SQLite WAL source');
    if (shmStat) copyNoFollowFile(shmPath, `${copyPath}-shm`, 'SQLite SHM source');
    const database = new Database(
      copyPath,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    );
    return {
      database,
      close: () => {
        database.close();
        rmSync(copyRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(copyRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Read-only Store 4 preflight. Existing files are never migrated or rewritten. */
export function assertSqliteRuntimeStorageCanOpen<Event = unknown, State = unknown>(
  dbPath: string,
  codec?: SqliteRuntimeSnapshotCodecV1<Event, State>,
  sessionId?: string,
): void {
  if (dbPath === ':memory:') return;
  assertNoFollowDatabasePath(dbPath);
  if (!existsSync(dbPath)) return;
  const view = openPreflightView(dbPath);
  try {
    const database = view.database;
    const hasMeta = tableExists(database, 'runtime_store_meta');
    const hasData =
      tableExists(database, 'runtime_events') ||
      tableExists(database, 'runtime_snapshots') ||
      tableExists(database, 'runtime_named_snapshots');
    if (!hasMeta) {
      if (hasData) throw new SqliteRuntimeFormatIncompatibleError(null, null);
      return;
    }
    const marker = database
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM runtime_store_meta WHERE key IN ('format_version', 'runtime_format_epoch')",
      )
      .all();
    const values = new Map(marker.map((entry) => [entry.key, entry.value]));
    if (
      Number(values.get('format_version')) !== SQLITE_RUNTIME_STORE_SCHEMA_VERSION ||
      values.get('runtime_format_epoch') !== SQLITE_RUNTIME_FORMAT_EPOCH
    ) {
      throw new SqliteRuntimeFormatIncompatibleError(
        Number(values.get('format_version')) || null,
        values.get('runtime_format_epoch') ?? null,
      );
    }
    assertStoreShape(database);
    if (!codec || !sessionId) return;
    const row = database
      .query<
        {
          state_json: string;
          schema_version: number;
          event_position: number;
          state_revision: number;
        },
        [string]
      >(
        'SELECT state_json, schema_version, event_position, state_revision FROM runtime_snapshots WHERE thread_id = ? LIMIT 1',
      )
      .get(sessionId);
    if (!row) return;
    try {
      const state = codec.decodeState<State>(row.state_json);
      const metadata = codec.snapshotMetadata(state);
      const eventRevision =
        database
          .query<{ revision: number }, [string, number]>(
            'SELECT revision FROM runtime_events WHERE thread_id = ? AND id <= ? ORDER BY id DESC LIMIT 1',
          )
          .get(sessionId, row.event_position)?.revision ?? 0;
      if (
        row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        metadata.stateRevision !== row.state_revision ||
        row.state_revision !== eventRevision
      ) {
        throw new SqliteRuntimeFormatIncompatibleError(
          metadata.schemaVersion,
          SQLITE_RUNTIME_FORMAT_EPOCH,
        );
      }
      codec.validateSnapshot?.({
        state,
        sessionId,
        eventPosition: row.event_position,
        stateRevision: row.state_revision,
        schemaVersion: row.schema_version,
        eventRevision,
      });
    } catch (error) {
      if (error instanceof SqliteRuntimeFormatIncompatibleError) throw error;
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  } finally {
    view.close();
  }
}

/** Read-only Store 5 preflight. Existing files are never migrated or rewritten. */
export function assertSqliteRuntimeStorageV5CanOpen<Event = unknown, State = unknown>(
  dbPath: string,
  codec?: SqliteRuntimeSnapshotCodecV1<Event, State>,
  sessionId?: string,
  persistedAuthority?: RuntimePersistedAuthorityCodecV1,
  uniqueReceiptForEvent?: (event: Event) => RuntimeUniqueReceiptV1 | null,
): void {
  if (dbPath === ':memory:') return;
  assertNoFollowDatabasePath(dbPath);
  if (!existsSync(dbPath)) return;
  const view = openPreflightView(dbPath);
  try {
    const database = view.database;
    const hasMeta = tableExists(database, 'runtime_store_meta');
    const hasData =
      tableExists(database, 'runtime_events') ||
      tableExists(database, 'runtime_snapshots') ||
      tableExists(database, 'runtime_sessions');
    if (!hasMeta) {
      if (hasData) throw new SqliteRuntimeFormatIncompatibleError(null, null);
      return;
    }
    const marker = database
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM runtime_store_meta WHERE key IN ('format_version', 'runtime_format_epoch')",
      )
      .all();
    const values = new Map(marker.map((entry) => [entry.key, entry.value]));
    if (
      Number(values.get('format_version')) !== 5 ||
      values.get('runtime_format_epoch') !== 'kite-runtime-modularization-v1-2026-08-19'
    ) {
      throw new SqliteRuntimeFormatIncompatibleError(
        Number(values.get('format_version')) || null,
        values.get('runtime_format_epoch') ?? null,
      );
    }
    assertStore5Shape(database);
    const originRows = database
      .query<Store5DataOriginRowV1, []>(
        'SELECT origin_id, kind, observation_id, project_id, classification, parent_origins_json, authority_envelope FROM runtime_data_origins ORDER BY origin_id',
      )
      .all();
    if (originRows.length > 0 && !persistedAuthority) {
      throw new SqliteRuntimeFormatIncompatibleError(5, values.get('runtime_format_epoch')!);
    }
    const decodedOrigins = new Map<string, RuntimeDataOriginRecordV1>();
    try {
      for (const originRow of originRows) {
        const origin = decodeDataOriginPayloadV1(
          persistedAuthority!.verify({
            kind: 'origin',
            domain: 'runtime-data-origin-v1',
            identity: originRow.origin_id,
            serialized: originRow.authority_envelope,
          }),
        );
        if (
          origin.originId !== originRow.origin_id ||
          origin.kind !== originRow.kind ||
          origin.observationId !== originRow.observation_id ||
          origin.ownerProjectId !== originRow.project_id ||
          origin.classification !== originRow.classification ||
          JSON.stringify(origin.parentOriginIds) !== originRow.parent_origins_json
        ) {
          throw new Error('Store5 DataOrigin row identity mismatch.');
        }
        decodedOrigins.set(origin.originId, origin);
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (origin: RuntimeDataOriginRecordV1): void => {
        if (visited.has(origin.originId)) return;
        if (visiting.has(origin.originId)) throw new Error('Store5 DataOrigin cycle.');
        visiting.add(origin.originId);
        for (const parentId of origin.parentOriginIds) {
          const parent = decodedOrigins.get(parentId);
          if (!parent) throw new Error('Store5 DataOrigin parent missing.');
          visit(parent);
        }
        visiting.delete(origin.originId);
        visited.add(origin.originId);
      };
      for (const origin of decodedOrigins.values()) visit(origin);
    } catch (error) {
      throw new SqliteRuntimeFormatIncompatibleError(null, null, error);
    }
    const authorityRows = database
      .query<Store5EgressAuthorityRowV1, []>(
        'SELECT egress_id, destination_id, destination_kind, route_identity, nonce_namespace, invocation_id, origin_ids_json, allowed_classifications_json, allowed_origin_kinds_json, expires_at, authority_envelope FROM runtime_egress_authorities ORDER BY egress_id',
      )
      .all();
    if (authorityRows.length > 0 && !persistedAuthority) {
      throw new SqliteRuntimeFormatIncompatibleError(5, values.get('runtime_format_epoch')!);
    }
    const decodedAuthorities = new Map<string, RuntimeEgressAuthorityRecordV1>();
    try {
      for (const authorityRow of authorityRows) {
        const authority = decodeEgressAuthorityPayloadV1(
          persistedAuthority!.verify({
            kind: 'grant',
            domain: 'runtime-egress-authority-v1',
            identity: authorityRow.egress_id,
            serialized: authorityRow.authority_envelope,
          }),
        );
        if (
          authority.egressId !== authorityRow.egress_id ||
          authority.destinationId !== authorityRow.destination_id ||
          authority.destinationKind !== authorityRow.destination_kind ||
          authority.routeIdentity !== authorityRow.route_identity ||
          authority.nonceNamespace !== authorityRow.nonce_namespace ||
          authority.invocationId !== authorityRow.invocation_id ||
          JSON.stringify(authority.originIds) !== authorityRow.origin_ids_json ||
          JSON.stringify(authority.allowedClassifications) !==
            authorityRow.allowed_classifications_json ||
          JSON.stringify(authority.allowedOriginKinds) !== authorityRow.allowed_origin_kinds_json ||
          authority.expiresAt !== authorityRow.expires_at
        ) {
          throw new Error('Store5 EgressAuthority row identity mismatch.');
        }
        if (authority.originIds.some((originId) => !decodedOrigins.has(originId))) {
          throw new Error('Store5 EgressAuthority origin is missing.');
        }
        decodedAuthorities.set(authority.egressId, authority);
      }
    } catch {
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
    const receiptRows = database
      .query<Store5ReceiptRowV1, []>(
        'SELECT invocation_id, nonce_namespace, nonce_digest, consumed_at, authority_envelope, thread_id, receipt_digest, origin_digest, source_origin_ids_json, egress_authority_id, route_identity, expires_at FROM runtime_mcp_egress_nonces ORDER BY invocation_id, nonce_namespace, nonce_digest',
      )
      .all();
    if (receiptRows.length > 0 && !persistedAuthority) {
      throw new SqliteRuntimeFormatIncompatibleError(5, values.get('runtime_format_epoch')!);
    }
    try {
      for (const receiptRow of receiptRows) {
        verifyStore5ReceiptRowV1(receiptRow, persistedAuthority!);
        const authority = decodedAuthorities.get(receiptRow.egress_authority_id);
        if (
          !authority ||
          authority.invocationId !== receiptRow.invocation_id ||
          authority.routeIdentity !== receiptRow.route_identity ||
          authority.nonceNamespace !== receiptRow.nonce_namespace ||
          receiptRow.origin_digest.length === 0
        ) {
          throw new Error('Store5 MCP receipt authority binding mismatch.');
        }
      }
    } catch (error) {
      throw new SqliteRuntimeFormatIncompatibleError(null, null, error);
    }
    if (!codec) return;
    if (!persistedAuthority)
      throw new SqliteRuntimeFormatIncompatibleError(5, values.get('runtime_format_epoch')!);
    try {
      const expectedOriginIds = new Set<string>();
      const expectedAuthorityIds = new Set<string>();
      const expectedReceiptKeys = new Set<string>();
      const receiptByKey = new Map(
        receiptRows.map((row) => [`${row.invocation_id}\0${row.nonce_digest}`, row]),
      );
      const eventRows = database
        .query<{ session_id: string; event_id: string; event_json: string }, []>(
          'SELECT session_id, event_id, event_json FROM runtime_events ORDER BY session_id, sequence',
        )
        .all();
      for (const eventRow of eventRows) {
        const event = codec.decodeEvent(
          persistedAuthority.verify({
            kind: 'event',
            domain: 'runtime-event-v1',
            identity: `${eventRow.session_id}/event/${eventRow.event_id}`,
            serialized: eventRow.event_json,
          }),
        );
        for (const origin of codec.dataOriginsForEvent?.(event) ?? []) {
          const stored = decodedOrigins.get(origin.originId);
          if (
            !stored ||
            canonicalDataOriginPayloadV1(stored) !== canonicalDataOriginPayloadV1(origin)
          ) {
            throw new Error('Store5 event DataOrigin ledger is incomplete.');
          }
          expectedOriginIds.add(origin.originId);
        }
        for (const authority of codec.egressAuthoritiesForEvent?.(event) ?? []) {
          const stored = decodedAuthorities.get(authority.egressId);
          if (
            !stored ||
            canonicalEgressAuthorityPayloadV1(stored) !==
              canonicalEgressAuthorityPayloadV1(authority)
          ) {
            throw new Error('Store5 event EgressAuthority ledger is incomplete.');
          }
          expectedAuthorityIds.add(authority.egressId);
        }
        const receipt = uniqueReceiptForEvent?.(event);
        if (receipt) {
          const key = `${receipt.invocationId}\0${receipt.nonceDigest}`;
          const row = receiptByKey.get(key);
          if (
            !row ||
            row.receipt_digest !== receipt.receiptDigest ||
            row.origin_digest !== receipt.originDigest ||
            row.egress_authority_id !== receipt.egressAuthorityId ||
            row.route_identity !== receipt.routeIdentity ||
            row.source_origin_ids_json !== JSON.stringify(receipt.sourceOriginIds)
          ) {
            throw new Error('Store5 event MCP receipt ledger is incomplete.');
          }
          const sourceOrigins: RuntimeDataOriginRecordV1[] = receipt.sourceOriginIds.map(
            (originId) => {
              const origin = decodedOrigins.get(originId);
              if (!origin) throw new Error('Store5 MCP source DataOrigin is missing.');
              return origin;
            },
          );
          const authority = decodedAuthorities.get(receipt.egressAuthorityId);
          if (
            new Bun.CryptoHasher('sha256')
              .update(canonicalRuntimeDataOriginSetV1(sourceOrigins))
              .digest('hex') !== receipt.originDigest ||
            !authority ||
            receipt.sourceOriginIds.some((originId) => !authority.originIds.includes(originId))
          ) {
            throw new Error('Store5 MCP receipt provenance digest mismatch.');
          }
          expectedReceiptKeys.add(key);
        }
      }
      if (
        expectedOriginIds.size !== decodedOrigins.size ||
        expectedAuthorityIds.size !== decodedAuthorities.size ||
        expectedReceiptKeys.size !== receiptRows.length
      ) {
        throw new Error('Store5 authority ledger contains orphaned rows.');
      }
    } catch {
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
    try {
      const sessionIds = sessionId
        ? [sessionId]
        : database
            .query<{ session_id: string }, []>(
              'SELECT session_id FROM runtime_sessions ORDER BY session_id',
            )
            .all()
            .map((entry) => entry.session_id);
      for (const currentSessionId of sessionIds) {
        const row = database
          .query<
            {
              state_json: string;
              schema_version: number;
              format_epoch: string;
              event_position: number;
              revision: number;
              state_checksum: string;
            },
            [string]
          >(
            'SELECT state_json, schema_version, format_epoch, event_position, revision, state_checksum FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
          )
          .get(currentSessionId);
        if (!row) {
          throw new SqliteRuntimeFormatIncompatibleError(26, values.get('runtime_format_epoch')!);
        }
        if (!row.state_checksum || checksum(row.state_json) !== row.state_checksum) {
          throw new SqliteRuntimeStorageOpenError('Store5 snapshot checksum is invalid.');
        }
        const state = codec.decodeState<State>(
          persistedAuthority.verify({
            kind: 'snapshot',
            domain: 'runtime-snapshot-v1',
            identity: `${currentSessionId}/snapshot/${row.revision}`,
            serialized: row.state_json,
          }),
        );
        const metadata = codec.snapshotMetadata(state);
        const identity = codec.sessionIdentity?.(state);
        const session = database
          .query<
            {
              project_id: string;
              workspace_digest: string;
              state_schema: number;
              format_epoch: string;
              revision: number;
            },
            [string]
          >(
            'SELECT project_id, workspace_digest, state_schema, format_epoch, revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
          )
          .get(currentSessionId);
        const eventRevision =
          database
            .query<{ sequence: number }, [string, number]>(
              'SELECT sequence FROM runtime_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1',
            )
            .get(currentSessionId, row.event_position)?.sequence ?? 0;
        if (
          row.schema_version !== 26 ||
          row.format_epoch !== 'kite-runtime-modularization-v1-2026-08-19' ||
          metadata.schemaVersion !== 26 ||
          metadata.stateRevision !== row.revision ||
          row.revision !== eventRevision ||
          !identity ||
          !session ||
          session.project_id !== identity.projectId ||
          session.workspace_digest !== identity.canonicalWorkspaceDigest ||
          session.state_schema !== 26 ||
          session.format_epoch !== 'kite-runtime-modularization-v1-2026-08-19' ||
          session.revision !== row.revision
        ) {
          throw new SqliteRuntimeFormatIncompatibleError(
            metadata.schemaVersion,
            values.get('runtime_format_epoch')!,
          );
        }
        codec.validateSnapshot?.({
          state,
          sessionId: currentSessionId,
          eventPosition: row.event_position,
          stateRevision: row.revision,
          schemaVersion: row.schema_version,
          eventRevision,
        });
      }
    } catch (error) {
      if (error instanceof SqliteRuntimeFormatIncompatibleError) throw error;
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  } finally {
    view.close();
  }
}

function eventMetadataAt(
  metadata: readonly RuntimeEventMetadataV1[] | undefined,
  index: number,
): RuntimeEventMetadataV1 | undefined {
  return metadata?.[index];
}

class SqliteRuntimeStorageAdapter<Event = unknown, State = unknown>
  implements RuntimeStorage<Event, State>
{
  readonly adapterId = 'sqlite';
  readonly stateSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly compatibilityEpoch: string;
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeStorage<Event, State>['transactions'];
  readonly effects: EffectLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly artifacts: ArtifactPort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPortV1;
  readonly #db: Database;
  readonly #codec: SqliteRuntimeSnapshotCodecV1<Event, State>;
  readonly #uniqueReceiptForEvent?: (event: Event) => SqliteRuntimeUniqueReceiptV1 | null;
  readonly #persistedAuthority: RuntimePersistedAuthorityCodecV1 | undefined;
  #closed = false;

  constructor(input: SqliteRuntimeStorageInternalInputV1<Event, State>) {
    if (!input.databasePath || !input.codec) {
      throw new SqliteRuntimeStorageOpenError(
        'SQLite Runtime storage requires a databasePath and codec.',
      );
    }
    const profile = input.formatProfile ?? {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    };
    this.stateSchemaVersion = profile.stateSchemaVersion;
    this.storeSchemaVersion = profile.storeSchemaVersion;
    this.compatibilityEpoch = profile.formatEpoch;
    this.#codec = input.codec;
    this.#uniqueReceiptForEvent = input.uniqueReceiptForEvent;
    this.#persistedAuthority = input.persistedAuthority;
    if (profile.storeSchemaVersion === 5 && !this.#persistedAuthority) {
      throw new SqliteRuntimeStorageOpenError('Store5 requires persisted record integrity.');
    }
    const baseArtifacts = input.artifacts ?? createArtifactPortV1();
    assertNoFollowDatabasePath(input.databasePath);
    if (profile.storeSchemaVersion === 5) {
      assertSqliteRuntimeStorageV5CanOpen(
        input.databasePath,
        input.codec,
        input.sessionId,
        input.persistedAuthority,
        input.uniqueReceiptForEvent,
      );
    } else {
      assertSqliteRuntimeStorageCanOpen(input.databasePath, input.codec, input.sessionId);
    }
    if (input.databasePath !== ':memory:')
      mkdirSync(dirname(input.databasePath), { recursive: true });
    const db = new Database(
      input.databasePath,
      constants.SQLITE_OPEN_READWRITE |
        constants.SQLITE_OPEN_CREATE |
        constants.SQLITE_OPEN_NOFOLLOW,
    );
    const journalMode = input.options?.journalMode ?? defaultSqliteRuntimeJournalModeV1();
    try {
      db.run('PRAGMA busy_timeout = 5000');
      db.run(`PRAGMA journal_mode = ${journalMode}`);
      db.run('BEGIN IMMEDIATE');
      try {
        if (profile.storeSchemaVersion === 5) {
          db.run(
            `CREATE TABLE IF NOT EXISTS runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          );
          db.run(`CREATE TABLE IF NOT EXISTS runtime_events (
            session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            schema_version INTEGER NOT NULL, event_json TEXT NOT NULL,
            causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_sessions (
            session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL,
            state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_snapshots (
            session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL,
            revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
            session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL,
            format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
            event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_file_preimages (
            session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER,
            created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_effect_leases (
            session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL,
            lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain',
            expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_mcp_egress_nonces (
            invocation_id TEXT NOT NULL, nonce_namespace TEXT NOT NULL, nonce_digest TEXT NOT NULL,
            consumed_at TEXT NOT NULL, authority_envelope TEXT NOT NULL,
            thread_id TEXT NOT NULL, receipt_digest TEXT NOT NULL,
            origin_digest TEXT NOT NULL, source_origin_ids_json TEXT NOT NULL,
            egress_authority_id TEXT NOT NULL,
            route_identity TEXT NOT NULL,
            expires_at TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (nonce_namespace, nonce_digest))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_data_origins (
            origin_id TEXT PRIMARY KEY, kind TEXT NOT NULL, observation_id TEXT NOT NULL,
            project_id TEXT NOT NULL, classification TEXT NOT NULL,
            parent_origins_json TEXT NOT NULL, authority_envelope TEXT NOT NULL)`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_egress_authorities (
            egress_id TEXT PRIMARY KEY, destination_id TEXT NOT NULL,
            destination_kind TEXT NOT NULL, route_identity TEXT NOT NULL,
            nonce_namespace TEXT NOT NULL, invocation_id TEXT NOT NULL,
            origin_ids_json TEXT NOT NULL, allowed_classifications_json TEXT NOT NULL,
            allowed_origin_kinds_json TEXT NOT NULL, expires_at TEXT NOT NULL,
            authority_envelope TEXT NOT NULL)`);
          db.run(
            'CREATE INDEX IF NOT EXISTS runtime_events_session_sequence ON runtime_events(session_id, sequence)',
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS runtime_data_origins_observation ON runtime_data_origins(observation_id)',
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS runtime_egress_authorities_invocation ON runtime_egress_authorities(invocation_id)',
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
          );
        } else {
          db.run(
            `CREATE TABLE IF NOT EXISTS runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          );
          db.run(`CREATE TABLE IF NOT EXISTS runtime_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event_json TEXT NOT NULL,
            event_id TEXT, revision INTEGER NOT NULL DEFAULT 0, causation_id TEXT, occurred_at TEXT,
            created_at INTEGER DEFAULT (unixepoch()))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_sessions (
            thread_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model_provider TEXT,
            model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
            thread_id TEXT NOT NULL, name TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            state_json TEXT NOT NULL, state_revision INTEGER NOT NULL, state_checksum TEXT NOT NULL,
            schema_version INTEGER NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (thread_id, name))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_snapshots (
            thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            state_revision INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '',
            schema_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_file_preimages (
            thread_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER,
            created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (thread_id, path, event_position))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_mcp_egress_nonces (
            thread_id TEXT NOT NULL, nonce_digest TEXT NOT NULL, invocation_id TEXT NOT NULL,
            receipt_digest TEXT NOT NULL, expires_at TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (nonce_digest))`);
          db.run(`CREATE TABLE IF NOT EXISTS runtime_effect_leases (
            thread_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL,
            expires_at_ms INTEGER NOT NULL, PRIMARY KEY (thread_id, effect_id))`);
          db.run(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_event_id ON runtime_events(thread_id, event_id) WHERE event_id IS NOT NULL',
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON runtime_events(thread_id)',
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_runtime_file_preimages_position ON runtime_file_preimages(thread_id, event_position)',
          );
        }
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('format_version', ?)",
          [String(profile.storeSchemaVersion)],
        );
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('runtime_format_epoch', ?)",
          [profile.formatEpoch],
        );
        const marker = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'format_version'",
          )
          .get();
        const epoch = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'runtime_format_epoch'",
          )
          .get();
        if (
          !marker ||
          Number(marker.value) !== profile.storeSchemaVersion ||
          !epoch ||
          epoch.value !== profile.formatEpoch
        ) {
          throw new SqliteRuntimeFormatIncompatibleError(
            Number(marker?.value) || null,
            epoch?.value ?? null,
          );
        }
        db.run('COMMIT');
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* begin may have failed */
        }
        throw error;
      }
      if (input.options?.faultInjectionMaxPageCount != null) {
        const value = input.options.faultInjectionMaxPageCount;
        if (!Number.isInteger(value) || value <= 0)
          throw new SqliteRuntimeStorageOpenError(
            'faultInjectionMaxPageCount must be a positive integer',
          );
        db.run(`PRAGMA max_page_count = ${value}`);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    const assertStorageOpen = (): void => {
      if (this.#closed)
        throw new SqliteRuntimeStorageOpenError('SQLite Runtime storage is closed.');
    };
    const withImmediateTransaction = <T>(work: () => T): T => {
      assertStorageOpen();
      db.run('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.run('COMMIT');
        return result;
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* The transaction may already have been rolled back by SQLite. */
        }
        throw error;
      }
    };
    this.recoveryIdentities = Object.freeze({
      read: (sessionId: string): string | null => {
        assertStorageOpen();
        const key = recoveryIdentityMetaKey(sessionId);
        const row = selectRecoveryIdentity.get(key);
        if (!row) return null;
        if (!isCanonicalRecoveryIdentity(row.value)) {
          throw new SqliteRuntimeStorageOpenError(
            'Persisted runtime recovery identity is malformed.',
          );
        }
        return row.value;
      },
      getOrCreate: (sessionId: string, allocate: () => string): string => {
        assertNonEmptySessionId(sessionId);
        if (typeof allocate !== 'function') {
          throw new SqliteRuntimeStorageOpenError(
            'Runtime recovery identity requires a Host allocator.',
          );
        }
        const key = recoveryIdentityMetaKey(sessionId);
        return withImmediateTransaction(() => {
          const existing = selectRecoveryIdentity.get(key)?.value;
          if (existing !== undefined) {
            if (!isCanonicalRecoveryIdentity(existing)) {
              throw new SqliteRuntimeStorageOpenError(
                'Persisted runtime recovery identity is malformed.',
              );
            }
            return existing;
          }
          const allocated = allocate();
          if (!isCanonicalRecoveryIdentity(allocated)) {
            throw new SqliteRuntimeStorageOpenError(
              'Host recovery identity allocator returned an invalid key.',
            );
          }
          insertRecoveryIdentity.run(key, allocated);
          return allocated;
        });
      },
      remove: (sessionId: string): void => {
        const key = recoveryIdentityMetaKey(sessionId);
        withImmediateTransaction(() => {
          deleteRecoveryIdentity.run(key);
        });
      },
    });
    const targetFormat = profile.storeSchemaVersion === 5;
    const persistedAuthority = this.#persistedAuthority;
    const insertDataOrigin = targetFormat
      ? db.query(
          'INSERT INTO runtime_data_origins (origin_id, kind, observation_id, project_id, classification, parent_origins_json, authority_envelope) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
      : undefined;
    const selectDataOrigin = targetFormat
      ? db.query<Store5DataOriginRowV1, [string]>(
          'SELECT origin_id, kind, observation_id, project_id, classification, parent_origins_json, authority_envelope FROM runtime_data_origins WHERE origin_id = ?',
        )
      : undefined;
    const selectDataOriginsByObservation = targetFormat
      ? db.query<Store5DataOriginRowV1, [string]>(
          'SELECT origin_id, kind, observation_id, project_id, classification, parent_origins_json, authority_envelope FROM runtime_data_origins WHERE observation_id = ? ORDER BY origin_id',
        )
      : undefined;
    const deleteDataOrigin = targetFormat
      ? db.query('DELETE FROM runtime_data_origins WHERE origin_id = ?')
      : undefined;
    const insertEgressAuthority = targetFormat
      ? db.query(
          'INSERT INTO runtime_egress_authorities (egress_id, destination_id, destination_kind, route_identity, nonce_namespace, invocation_id, origin_ids_json, allowed_classifications_json, allowed_origin_kinds_json, expires_at, authority_envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
      : undefined;
    const selectEgressAuthority = targetFormat
      ? db.query<Store5EgressAuthorityRowV1, [string]>(
          'SELECT egress_id, destination_id, destination_kind, route_identity, nonce_namespace, invocation_id, origin_ids_json, allowed_classifications_json, allowed_origin_kinds_json, expires_at, authority_envelope FROM runtime_egress_authorities WHERE egress_id = ?',
        )
      : undefined;
    const selectEgressAuthoritiesByInvocation = targetFormat
      ? db.query<Store5EgressAuthorityRowV1, [string]>(
          'SELECT egress_id, destination_id, destination_kind, route_identity, nonce_namespace, invocation_id, origin_ids_json, allowed_classifications_json, allowed_origin_kinds_json, expires_at, authority_envelope FROM runtime_egress_authorities WHERE invocation_id = ? ORDER BY egress_id',
        )
      : undefined;
    const deleteEgressAuthority = targetFormat
      ? db.query('DELETE FROM runtime_egress_authorities WHERE egress_id = ?')
      : undefined;
    const openDataOrigin = (row: Store5DataOriginRowV1): RuntimeDataOriginRecordV1 => {
      const payload = persistedAuthority!.verify({
        kind: 'origin',
        domain: 'runtime-data-origin-v1',
        identity: row.origin_id,
        serialized: row.authority_envelope,
      });
      const origin = decodeDataOriginPayloadV1(payload);
      if (
        origin.originId !== row.origin_id ||
        origin.kind !== row.kind ||
        origin.observationId !== row.observation_id ||
        origin.ownerProjectId !== row.project_id ||
        origin.classification !== row.classification ||
        JSON.stringify(origin.parentOriginIds) !== row.parent_origins_json
      ) {
        throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin row identity mismatch.');
      }
      return origin;
    };
    const persistDataOrigins = (origins: readonly RuntimeDataOriginRecordV1[]): void => {
      if (!targetFormat) {
        if (origins.length > 0)
          throw new SqliteRuntimeStorageOpenError('DataOrigin persistence requires Store5.');
        return;
      }
      const pending = new Map<string, RuntimeDataOriginRecordV1>();
      for (const origin of origins) {
        assertDataOriginRecordV1(origin);
        const prior = pending.get(origin.originId);
        if (prior && canonicalDataOriginPayloadV1(prior) !== canonicalDataOriginPayloadV1(origin)) {
          throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin identity is duplicated.');
        }
        pending.set(origin.originId, origin);
      }
      const ordered: RuntimeDataOriginRecordV1[] = [];
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (origin: RuntimeDataOriginRecordV1): void => {
        if (visited.has(origin.originId)) return;
        if (visiting.has(origin.originId)) {
          throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin lineage contains a cycle.');
        }
        visiting.add(origin.originId);
        for (const parentId of origin.parentOriginIds) {
          const parent = pending.get(parentId);
          if (parent) visit(parent);
          else {
            const row = selectDataOrigin!.get(parentId);
            if (!row) {
              throw new SqliteRuntimeStorageOpenError(
                `Store5 DataOrigin parent is unavailable: ${parentId}`,
              );
            }
            openDataOrigin(row);
          }
        }
        visiting.delete(origin.originId);
        visited.add(origin.originId);
        ordered.push(origin);
      };
      for (const origin of pending.values()) visit(origin);
      for (const origin of ordered) {
        const payload = canonicalDataOriginPayloadV1(origin);
        const existing = selectDataOrigin!.get(origin.originId);
        if (existing) {
          if (canonicalDataOriginPayloadV1(openDataOrigin(existing)) !== payload) {
            throw new SqliteRuntimeStorageOpenError('Store5 DataOrigin identity drifted.');
          }
          continue;
        }
        const envelope = persistedAuthority!.seal({
          kind: 'origin',
          domain: 'runtime-data-origin-v1',
          identity: origin.originId,
          payload,
        });
        insertDataOrigin!.run(
          origin.originId,
          origin.kind,
          origin.observationId,
          origin.ownerProjectId,
          origin.classification,
          JSON.stringify(origin.parentOriginIds),
          envelope,
        );
      }
    };
    const openEgressAuthority = (
      row: Store5EgressAuthorityRowV1,
    ): RuntimeEgressAuthorityRecordV1 => {
      const payload = persistedAuthority!.verify({
        kind: 'grant',
        domain: 'runtime-egress-authority-v1',
        identity: row.egress_id,
        serialized: row.authority_envelope,
      });
      const authority = decodeEgressAuthorityPayloadV1(payload);
      if (
        authority.egressId !== row.egress_id ||
        authority.destinationId !== row.destination_id ||
        authority.destinationKind !== row.destination_kind ||
        authority.routeIdentity !== row.route_identity ||
        authority.nonceNamespace !== row.nonce_namespace ||
        authority.invocationId !== row.invocation_id ||
        JSON.stringify(authority.originIds) !== row.origin_ids_json ||
        JSON.stringify(authority.allowedClassifications) !== row.allowed_classifications_json ||
        JSON.stringify(authority.allowedOriginKinds) !== row.allowed_origin_kinds_json ||
        authority.expiresAt !== row.expires_at
      ) {
        throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority row identity mismatch.');
      }
      return authority;
    };
    const persistEgressAuthorities = (
      authorities: readonly RuntimeEgressAuthorityRecordV1[],
    ): void => {
      if (!targetFormat) {
        if (authorities.length > 0) {
          throw new SqliteRuntimeStorageOpenError('EgressAuthority persistence requires Store5.');
        }
        return;
      }
      for (const authority of authorities) {
        assertEgressAuthorityRecordV1(authority);
        for (const originId of authority.originIds) {
          const originRow = selectDataOrigin!.get(originId);
          if (!originRow) {
            throw new SqliteRuntimeStorageOpenError(
              `Store5 EgressAuthority origin is unavailable: ${originId}`,
            );
          }
          openDataOrigin(originRow);
        }
        const payload = canonicalEgressAuthorityPayloadV1(authority);
        const existing = selectEgressAuthority!.get(authority.egressId);
        if (existing) {
          if (canonicalEgressAuthorityPayloadV1(openEgressAuthority(existing)) !== payload) {
            throw new SqliteRuntimeStorageOpenError('Store5 EgressAuthority identity drifted.');
          }
          continue;
        }
        const envelope = persistedAuthority!.seal({
          kind: 'grant',
          domain: 'runtime-egress-authority-v1',
          identity: authority.egressId,
          payload,
        });
        insertEgressAuthority!.run(
          authority.egressId,
          authority.destinationId,
          authority.destinationKind,
          authority.routeIdentity,
          authority.nonceNamespace,
          authority.invocationId,
          JSON.stringify(authority.originIds),
          JSON.stringify(authority.allowedClassifications),
          JSON.stringify(authority.allowedOriginKinds),
          authority.expiresAt,
          envelope,
        );
      }
    };
    const dataOriginLedger: RuntimeDataOriginLedgerPortV1 = Object.freeze({
      record: (origins: readonly RuntimeDataOriginRecordV1[]) =>
        withImmediateTransaction(() => persistDataOrigins(origins)),
      read: (originId: string) => {
        assertStorageOpen();
        if (!targetFormat) return null;
        const row = selectDataOrigin!.get(originId);
        return row ? openDataOrigin(row) : null;
      },
      readByObservation: (observationId: string) => {
        assertStorageOpen();
        if (!targetFormat) return Object.freeze([]);
        return Object.freeze(
          selectDataOriginsByObservation!.all(observationId).map(openDataOrigin),
        );
      },
    });
    const egressAuthorityLedger: RuntimeEgressAuthorityLedgerPortV1 = Object.freeze({
      record: (authorities: readonly RuntimeEgressAuthorityRecordV1[]) =>
        withImmediateTransaction(() => persistEgressAuthorities(authorities)),
      read: (egressId: string) => {
        assertStorageOpen();
        if (!targetFormat) return null;
        const row = selectEgressAuthority!.get(egressId);
        return row ? openEgressAuthority(row) : null;
      },
      readByInvocation: (invocationId: string) => {
        assertStorageOpen();
        if (!targetFormat) return Object.freeze([]);
        return Object.freeze(
          selectEgressAuthoritiesByInvocation!.all(invocationId).map(openEgressAuthority),
        );
      },
    });
    const artifactsWithOrigins = targetFormat
      ? withArtifactNamespaceV1(
          baseArtifacts,
          RUNTIME_DATA_ORIGIN_ARTIFACT_NAMESPACE_V1,
          dataOriginLedger,
        )
      : baseArtifacts;
    this.artifacts = targetFormat
      ? withArtifactNamespaceV1(
          artifactsWithOrigins,
          RUNTIME_EGRESS_AUTHORITY_ARTIFACT_NAMESPACE_V1,
          egressAuthorityLedger,
        )
      : artifactsWithOrigins;
    const sealEvent = (sessionId: string, eventId: string, payload: string): string =>
      targetFormat
        ? persistedAuthority!.seal({
            kind: 'event',
            domain: 'runtime-event-v1',
            identity: `${sessionId}/event/${eventId}`,
            payload,
          })
        : payload;
    const openEvent = (row: EventRow): string =>
      targetFormat
        ? persistedAuthority!.verify({
            kind: 'event',
            domain: 'runtime-event-v1',
            identity: `${row.thread_id}/event/${row.event_id ?? ''}`,
            serialized: row.event_json,
          })
        : row.event_json;
    const sealSnapshot = (
      sessionId: string,
      namespace: 'snapshot' | `named/${string}`,
      revision: number,
      payload: string,
    ): string =>
      targetFormat
        ? persistedAuthority!.seal({
            kind: 'snapshot',
            domain: 'runtime-snapshot-v1',
            identity: `${sessionId}/${namespace}/${revision}`,
            payload,
          })
        : payload;
    const openSnapshot = (
      row: SnapshotRow | NamedSnapshotRow,
      namespace: 'snapshot' | `named/${string}`,
    ): string =>
      targetFormat
        ? persistedAuthority!.verify({
            kind: 'snapshot',
            domain: 'runtime-snapshot-v1',
            identity: `${row.thread_id}/${namespace}/${row.state_revision}`,
            serialized: row.state_json,
          })
        : row.state_json;
    const insertEvent = db.query(
      targetFormat
        ? 'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())'
        : 'INSERT INTO runtime_events (thread_id, event_json) VALUES (?, ?)',
    );
    const insertEventWithMetadata = db.query(
      targetFormat
        ? 'INSERT OR IGNORE INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())'
        : 'INSERT OR IGNORE INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertUniqueReceipt = db.query(
      targetFormat
        ? 'INSERT INTO runtime_mcp_egress_nonces (invocation_id, nonce_namespace, nonce_digest, consumed_at, authority_envelope, thread_id, receipt_digest, origin_digest, source_origin_ids_json, egress_authority_id, route_identity, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO runtime_mcp_egress_nonces (thread_id, nonce_digest, invocation_id, receipt_digest, expires_at) VALUES (?, ?, ?, ?, ?)',
    );
    const deleteExpiredUniqueReceipts = db.query(
      'DELETE FROM runtime_mcp_egress_nonces WHERE expires_at <= ?',
    );
    const selectStore5Receipt = targetFormat
      ? db.query<Store5ReceiptRowV1, [string, string]>(
          'SELECT invocation_id, nonce_namespace, nonce_digest, consumed_at, authority_envelope, thread_id, receipt_digest, origin_digest, source_origin_ids_json, egress_authority_id, route_identity, expires_at FROM runtime_mcp_egress_nonces WHERE nonce_namespace = ? AND nonce_digest = ?',
        )
      : undefined;
    const selectStore5ReceiptsExpiringBefore = targetFormat
      ? db.query<Store5ReceiptRowV1, [string]>(
          'SELECT invocation_id, nonce_namespace, nonce_digest, consumed_at, authority_envelope, thread_id, receipt_digest, origin_digest, source_origin_ids_json, egress_authority_id, route_identity, expires_at FROM runtime_mcp_egress_nonces WHERE expires_at <= ? ORDER BY invocation_id, nonce_namespace, nonce_digest',
        )
      : undefined;
    const deleteStore5Receipt = targetFormat
      ? db.query(
          'DELETE FROM runtime_mcp_egress_nonces WHERE invocation_id = ? AND nonce_namespace = ? AND nonce_digest = ?',
        )
      : undefined;
    const insertForkEvent = db.query(
      targetFormat
        ? 'INSERT INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const selectEvents = db.query<EventRow, [string, number]>(
      targetFormat
        ? 'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC'
        : 'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC',
    );
    const selectAllEvents = db.query<EventRow, [string]>(
      targetFormat
        ? 'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC'
        : 'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? ORDER BY id ASC',
    );
    const upsertSnapshot = db.query(
      targetFormat
        ? 'INSERT OR REPLACE INTO runtime_snapshots (session_id, state_json, event_position, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())'
        : 'INSERT OR REPLACE INTO runtime_snapshots (thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const selectSnapshot = db.query<SnapshotRow, [string]>(
      targetFormat
        ? 'SELECT session_id AS thread_id, state_json, event_position, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
        : 'SELECT thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    const selectSnapshotRevision = db.query<{ state_revision: number }, [string]>(
      targetFormat
        ? 'SELECT revision AS state_revision FROM runtime_snapshots WHERE session_id = ?'
        : 'SELECT state_revision FROM runtime_snapshots WHERE thread_id = ?',
    );
    const selectLastEventPosition = db.query<{ id: number | null }, [string]>(
      targetFormat
        ? 'SELECT MAX(sequence) AS id FROM runtime_events WHERE session_id = ?'
        : 'SELECT MAX(id) AS id FROM runtime_events WHERE thread_id = ?',
    );
    const selectEventRevisionAtOrBefore = db.query<{ revision: number }, [string, number]>(
      targetFormat
        ? 'SELECT sequence AS revision FROM runtime_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1'
        : 'SELECT revision FROM runtime_events WHERE thread_id = ? AND id <= ? ORDER BY id DESC LIMIT 1',
    );
    const upsertSession = db.query(
      targetFormat
        ? 'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, workspace_digest = excluded.workspace_digest, state_schema = excluded.state_schema, format_epoch = excluded.format_epoch, revision = excluded.revision, updated_at = unixepoch()'
        : "INSERT INTO runtime_sessions (thread_id, name, updated_at) VALUES (?, '', unixepoch()) ON CONFLICT(thread_id) DO UPDATE SET updated_at = unixepoch()",
    );
    const updateSessionName = db.query(
      targetFormat
        ? 'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE session_id = ?'
        : 'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE thread_id = ?',
    );
    const selectSessionModelRoute = db.query<
      { model_provider: string | null; model_name: string | null },
      [string]
    >(
      targetFormat
        ? 'SELECT model_provider, model_name FROM runtime_sessions WHERE session_id = ?'
        : 'SELECT model_provider, model_name FROM runtime_sessions WHERE thread_id = ?',
    );
    const updateSessionModelRoute = db.query(
      targetFormat
        ? 'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE session_id = ?'
        : 'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE thread_id = ?',
    );
    const listSessionsQuery = db.query<
      { thread_id: string; name: string; updated_at: number },
      [number]
    >(
      targetFormat
        ? 'SELECT session_id AS thread_id, name, updated_at FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT thread_id, name, updated_at FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?',
    );
    const ensureSession = (sessionId: string, state?: State): void => {
      if (targetFormat) {
        const identity = state ? this.#codec.sessionIdentity?.(state) : undefined;
        if (!identity) {
          const existing = db
            .query<{ project_id: string; workspace_digest: string }, [string]>(
              'SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?',
            )
            .get(sessionId);
          if (existing) return;
          throw new SqliteRuntimeStorageOpenError(
            `Store5 session ${sessionId} has no State26 project identity.`,
          );
        }
        const existing = db
          .query<{ project_id: string; workspace_digest: string }, [string]>(
            'SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?',
          )
          .get(sessionId);
        if (
          existing &&
          (existing.project_id !== identity.projectId ||
            existing.workspace_digest !== identity.canonicalWorkspaceDigest)
        ) {
          throw new SqliteRuntimeFormatIncompatibleError(
            this.stateSchemaVersion,
            this.compatibilityEpoch,
          );
        }
        upsertSession.run(
          sessionId,
          identity.projectId,
          identity.canonicalWorkspaceDigest,
          this.stateSchemaVersion,
          this.compatibilityEpoch,
          state ? this.#codec.snapshotMetadata(state).stateRevision : 0,
        );
      } else {
        upsertSession.run(sessionId);
      }
    };
    const deleteEvents = db.query(
      targetFormat
        ? 'DELETE FROM runtime_events WHERE session_id = ?'
        : 'DELETE FROM runtime_events WHERE thread_id = ?',
    );
    const deleteEventsAfter = db.query(
      targetFormat
        ? 'DELETE FROM runtime_events WHERE session_id = ? AND sequence > ?'
        : 'DELETE FROM runtime_events WHERE thread_id = ? AND id > ?',
    );
    const deleteSnapshot = db.query(
      targetFormat
        ? 'DELETE FROM runtime_snapshots WHERE session_id = ?'
        : 'DELETE FROM runtime_snapshots WHERE thread_id = ?',
    );
    const deleteNamedSnapshots = db.query(
      targetFormat
        ? 'DELETE FROM runtime_named_snapshots WHERE session_id = ?'
        : 'DELETE FROM runtime_named_snapshots WHERE thread_id = ?',
    );
    const deleteNamedSnapshotsAfter = db.query(
      targetFormat
        ? 'DELETE FROM runtime_named_snapshots WHERE session_id = ? AND event_position > ?'
        : 'DELETE FROM runtime_named_snapshots WHERE thread_id = ? AND event_position > ?',
    );
    const upsertNamedSnapshot = db.query(
      targetFormat
        ? 'INSERT OR REPLACE INTO runtime_named_snapshots (session_id, name, event_position, state_json, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())'
        : 'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const insertForkNamedSnapshot = db.query(
      targetFormat
        ? 'INSERT OR REPLACE INTO runtime_named_snapshots (session_id, name, event_position, state_json, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const selectNamedSnapshot = db.query<NamedSnapshotRow, [string, string]>(
      targetFormat
        ? 'SELECT session_id AS thread_id, name, state_json, event_position, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND name = ?'
        : 'SELECT thread_id, name, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
    );
    const selectNamedSnapshotsForFork = db.query<NamedSnapshotRow, [string, number]>(
      targetFormat
        ? 'SELECT session_id AS thread_id, name, event_position, state_json, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND event_position <= ? ORDER BY event_position ASC, name ASC'
        : 'SELECT thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND event_position <= ? ORDER BY event_position ASC, name ASC',
    );
    const listNamedSnapshotsQuery = db.query<
      { name: string; event_position: number; created_at: number; affected_file_count: number },
      [string]
    >(
      targetFormat
        ? `SELECT s.name, s.event_position, s.created_at, (SELECT COUNT(DISTINCT p.path) FROM runtime_file_preimages p WHERE p.session_id = s.session_id AND p.event_position > s.event_position) AS affected_file_count FROM runtime_named_snapshots s WHERE s.session_id = ? ORDER BY s.created_at DESC, s.name DESC`
        : `SELECT s.name, s.event_position, s.created_at, (SELECT COUNT(DISTINCT p.path) FROM runtime_file_preimages p WHERE p.thread_id = s.thread_id AND p.event_position > s.event_position) AS affected_file_count FROM runtime_named_snapshots s WHERE s.thread_id = ? ORDER BY s.created_at DESC, s.name DESC`,
    );
    const selectNamedSnapshotEntry = db.query<NamedSnapshotRow, [string, string]>(
      targetFormat
        ? 'SELECT session_id AS thread_id, name, event_position, state_json, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND name = ?'
        : 'SELECT thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
    );
    const deleteFilePreimages = db.query(
      targetFormat
        ? 'DELETE FROM runtime_file_preimages WHERE session_id = ?'
        : 'DELETE FROM runtime_file_preimages WHERE thread_id = ?',
    );
    const deleteFilePreimagesAfter = db.query(
      targetFormat
        ? 'DELETE FROM runtime_file_preimages WHERE session_id = ? AND event_position > ?'
        : 'DELETE FROM runtime_file_preimages WHERE thread_id = ? AND event_position > ?',
    );
    const insertFilePreimage = db.query(
      targetFormat
        ? 'INSERT OR REPLACE INTO runtime_file_preimages (session_id, path, event_position, content, existed) VALUES (?, ?, ?, ?, ?)'
        : 'INSERT OR REPLACE INTO runtime_file_preimages (thread_id, path, event_position, content, existed) VALUES (?, ?, ?, ?, ?)',
    );
    const selectFilePreimageInWindow = db.query<{ path: string }, [string, string, number]>(
      targetFormat
        ? 'SELECT path FROM runtime_file_preimages WHERE session_id = ? AND path = ? AND event_position > ? LIMIT 1'
        : 'SELECT path FROM runtime_file_preimages WHERE thread_id = ? AND path = ? AND event_position > ? LIMIT 1',
    );
    const updateFilePostimageInWindow = db.query(
      targetFormat
        ? `UPDATE runtime_file_preimages SET post_hash = ?, post_existed = ? WHERE rowid = (SELECT rowid FROM runtime_file_preimages WHERE session_id = ? AND path = ? AND event_position > ? ORDER BY event_position DESC LIMIT 1)`
        : `UPDATE runtime_file_preimages SET post_hash = ?, post_existed = ? WHERE rowid = (SELECT rowid FROM runtime_file_preimages WHERE thread_id = ? AND path = ? AND event_position > ? ORDER BY event_position DESC LIMIT 1)`,
    );
    const selectLatestSnapshotPosition = db.query<{ event_position: number | null }, [string]>(
      targetFormat
        ? 'SELECT MAX(event_position) AS event_position FROM runtime_named_snapshots WHERE session_id = ?'
        : 'SELECT MAX(event_position) AS event_position FROM runtime_named_snapshots WHERE thread_id = ?',
    );
    const selectFileRestorePlan = db.query<
      {
        path: string;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
      },
      [string, number]
    >(
      targetFormat
        ? `WITH bounds AS (SELECT session_id, path, MIN(event_position) AS min_position, MAX(event_position) AS max_position FROM runtime_file_preimages WHERE session_id = ? AND event_position > ? GROUP BY session_id, path) SELECT first.path AS path, first.content AS content, first.existed AS existed, last.post_hash AS post_hash, last.post_existed AS post_existed FROM bounds JOIN runtime_file_preimages first ON first.session_id = bounds.session_id AND first.path = bounds.path AND first.event_position = bounds.min_position JOIN runtime_file_preimages last ON last.session_id = bounds.session_id AND last.path = bounds.path AND last.event_position = bounds.max_position`
        : `WITH bounds AS (SELECT thread_id, path, MIN(event_position) AS min_position, MAX(event_position) AS max_position FROM runtime_file_preimages WHERE thread_id = ? AND event_position > ? GROUP BY thread_id, path) SELECT first.path AS path, first.content AS content, first.existed AS existed, last.post_hash AS post_hash, last.post_existed AS post_existed FROM bounds JOIN runtime_file_preimages first ON first.thread_id = bounds.thread_id AND first.path = bounds.path AND first.event_position = bounds.min_position JOIN runtime_file_preimages last ON last.thread_id = bounds.thread_id AND last.path = bounds.path AND last.event_position = bounds.max_position`,
    );
    const selectFilePreimagesForFork = db.query<
      {
        path: string;
        event_position: number;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
        created_at: number;
      },
      [string, number]
    >(
      targetFormat
        ? 'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE session_id = ? AND event_position <= ? ORDER BY event_position ASC, path ASC'
        : 'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE thread_id = ? AND event_position <= ? ORDER BY event_position ASC, path ASC',
    );
    const insertForkFilePreimage = db.query(
      targetFormat
        ? 'INSERT OR REPLACE INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT OR REPLACE INTO runtime_file_preimages (thread_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const deleteEffectLeases = db.query(
      targetFormat
        ? 'DELETE FROM runtime_effect_leases WHERE session_id = ?'
        : 'DELETE FROM runtime_effect_leases WHERE thread_id = ?',
    );
    const deleteSession = db.query(
      targetFormat
        ? 'DELETE FROM runtime_sessions WHERE session_id = ?'
        : 'DELETE FROM runtime_sessions WHERE thread_id = ?',
    );
    const deleteExpiredLease = db.query(
      targetFormat
        ? 'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND expires_at_ms <= ?'
        : 'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND expires_at_ms <= ?',
    );
    const insertLease = db.query(
      targetFormat
        ? "INSERT OR IGNORE INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, 0, 'certain', ?)"
        : 'INSERT OR IGNORE INTO runtime_effect_leases (thread_id, effect_id, owner_id, expires_at_ms) VALUES (?, ?, ?, ?)',
    );
    const selectLease = db.query<{ owner_id: string }, [string, string, string, number]>(
      targetFormat
        ? 'SELECT owner_id FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?'
        : 'SELECT owner_id FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const renewLease = db.query(
      targetFormat
        ? 'UPDATE runtime_effect_leases SET expires_at_ms = ?, lease_revision = lease_revision + 1 WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?'
        : 'UPDATE runtime_effect_leases SET expires_at_ms = ? WHERE thread_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const releaseLease = db.query(
      targetFormat
        ? 'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ?'
        : 'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND owner_id = ?',
    );
    const selectRecoveryIdentity = db.query<{ value: string }, [string]>(
      'SELECT value FROM runtime_store_meta WHERE key = ?',
    );
    const insertRecoveryIdentity = db.query(
      'INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)',
    );
    const deleteRecoveryIdentity = db.query('DELETE FROM runtime_store_meta WHERE key = ?');

    const insertEvents = (
      sessionId: string,
      events: readonly Event[],
      metadata?: readonly RuntimeEventMetadataV1[],
      forkCreatedAt?: readonly number[],
    ): void => {
      const verifyStore5Receipt = (row: Store5ReceiptRowV1): void => {
        verifyStore5ReceiptRowV1(row, persistedAuthority!);
      };
      const pruneExpiredReceipts = (expiresAt: string): void => {
        if (!targetFormat) {
          deleteExpiredUniqueReceipts.run(expiresAt);
          return;
        }
        for (const row of selectStore5ReceiptsExpiringBefore!.all(expiresAt)) {
          verifyStore5Receipt(row);
          deleteStore5Receipt!.run(row.invocation_id, row.nonce_namespace, row.nonce_digest);
        }
      };
      for (const [index, event] of events.entries()) {
        persistDataOrigins(this.#codec.dataOriginsForEvent?.(event) ?? []);
        persistEgressAuthorities(this.#codec.egressAuthoritiesForEvent?.(event) ?? []);
        const receipt = this.#uniqueReceiptForEvent?.(event);
        if (receipt) {
          if (!targetFormat) pruneExpiredReceipts(receipt.pruneBefore ?? receipt.expiresAt);
          try {
            if (targetFormat) {
              const receiptIdentity = `${sessionId}/receipt/${receipt.invocationId}/${receipt.nonceDigest}`;
              const consumedAt = new Date().toISOString();
              const receiptEnvelope = persistedAuthority!.seal({
                kind: 'receipt',
                domain: 'mcp-egress-receipt-v1',
                identity: receiptIdentity,
                payload: JSON.stringify({
                  invocationId: receipt.invocationId,
                  nonceNamespace: 'mcp.egress.v1',
                  nonceDigest: receipt.nonceDigest,
                  consumedAt,
                  threadId: sessionId,
                  receiptDigest: receipt.receiptDigest,
                  originDigest: receipt.originDigest,
                  sourceOriginIds: receipt.sourceOriginIds,
                  egressAuthorityId: receipt.egressAuthorityId,
                  routeIdentity: receipt.routeIdentity,
                  expiresAt: receipt.expiresAt,
                }),
              });
              insertUniqueReceipt.run(
                receipt.invocationId,
                'mcp.egress.v1',
                receipt.nonceDigest,
                consumedAt,
                receiptEnvelope,
                sessionId,
                receipt.receiptDigest,
                receipt.originDigest,
                JSON.stringify(receipt.sourceOriginIds),
                receipt.egressAuthorityId,
                receipt.routeIdentity,
                receipt.expiresAt,
              );
            } else {
              insertUniqueReceipt.run(
                sessionId,
                receipt.nonceDigest,
                receipt.invocationId,
                receipt.receiptDigest,
                receipt.expiresAt,
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('runtime_mcp_egress_nonces') || message.includes('nonce_digest')) {
              if (targetFormat) {
                const existing = selectStore5Receipt!.get('mcp.egress.v1', receipt.nonceDigest);
                if (!existing) throw error;
                verifyStore5Receipt(existing);
              }
              throw new SqliteRuntimeUniqueReceiptConflictError(error);
            }
            throw error;
          }
        }
        const entry = eventMetadataAt(metadata, index);
        const implicitSequence = lastEvent(sessionId) + 1;
        const eventId = entry?.eventId ?? `${sessionId}:${implicitSequence}`;
        const json = sealEvent(sessionId, eventId, this.#codec.encodeEvent(event));
        if (entry) {
          const statement = forkCreatedAt ? insertForkEvent : insertEventWithMetadata;
          if (forkCreatedAt)
            statement.run(
              ...(targetFormat
                ? [
                    sessionId,
                    json,
                    entry.eventId,
                    entry.revision,
                    this.stateSchemaVersion,
                    entry.causationId ?? null,
                    entry.occurredAt ?? null,
                    forkCreatedAt[index] ?? 0,
                  ]
                : [
                    sessionId,
                    json,
                    entry.eventId,
                    entry.revision,
                    entry.causationId ?? null,
                    entry.occurredAt ?? null,
                    forkCreatedAt[index] ?? 0,
                  ]),
            );
          else
            statement.run(
              ...(targetFormat
                ? [
                    sessionId,
                    json,
                    entry.eventId,
                    entry.revision,
                    this.stateSchemaVersion,
                    entry.causationId ?? null,
                    entry.occurredAt ?? new Date().toISOString(),
                  ]
                : [
                    sessionId,
                    json,
                    entry.eventId,
                    entry.revision,
                    entry.causationId ?? null,
                    entry.occurredAt ?? new Date().toISOString(),
                  ]),
            );
        } else {
          if (forkCreatedAt)
            targetFormat
              ? insertForkEvent.run(
                  sessionId,
                  json,
                  eventId,
                  implicitSequence,
                  this.stateSchemaVersion,
                  null,
                  null,
                  forkCreatedAt[index] ?? 0,
                )
              : insertForkEvent.run(
                  sessionId,
                  json,
                  null,
                  0,
                  null,
                  null,
                  forkCreatedAt[index] ?? 0,
                );
          else if (targetFormat) {
            insertEvent.run(sessionId, eventId, implicitSequence, this.stateSchemaVersion, json);
          } else insertEvent.run(sessionId, json);
        }
      }
    };

    const garbageCollectStore5AuthorityV1 = (): void => {
      if (!targetFormat) return;
      const originIds = new Set<string>();
      const authorityIds = new Set<string>();
      const receiptKeys = new Set<string>();
      const rows = db
        .query<{ session_id: string; event_id: string; event_json: string }, []>(
          'SELECT session_id, event_id, event_json FROM runtime_events ORDER BY session_id, sequence',
        )
        .all();
      for (const row of rows) {
        const event = this.#codec.decodeEvent(
          persistedAuthority!.verify({
            kind: 'event',
            domain: 'runtime-event-v1',
            identity: `${row.session_id}/event/${row.event_id}`,
            serialized: row.event_json,
          }),
        );
        for (const origin of this.#codec.dataOriginsForEvent?.(event) ?? []) {
          originIds.add(origin.originId);
        }
        for (const authority of this.#codec.egressAuthoritiesForEvent?.(event) ?? []) {
          authorityIds.add(authority.egressId);
        }
        const receipt = this.#uniqueReceiptForEvent?.(event);
        if (receipt) receiptKeys.add(`${receipt.invocationId}\0${receipt.nonceDigest}`);
      }
      for (const row of db
        .query<{ origin_id: string }, []>('SELECT origin_id FROM runtime_data_origins')
        .all()) {
        if (!originIds.has(row.origin_id)) deleteDataOrigin!.run(row.origin_id);
      }
      for (const row of db
        .query<{ egress_id: string }, []>('SELECT egress_id FROM runtime_egress_authorities')
        .all()) {
        if (!authorityIds.has(row.egress_id)) deleteEgressAuthority!.run(row.egress_id);
      }
      for (const row of db
        .query<{ invocation_id: string; nonce_namespace: string; nonce_digest: string }, []>(
          'SELECT invocation_id, nonce_namespace, nonce_digest FROM runtime_mcp_egress_nonces',
        )
        .all()) {
        if (!receiptKeys.has(`${row.invocation_id}\0${row.nonce_digest}`)) {
          deleteStore5Receipt!.run(row.invocation_id, row.nonce_namespace, row.nonce_digest);
        }
      }
    };

    const snapshotMeta = (
      state: State,
      explicit?: RuntimeSnapshotMetadataV1,
    ): RuntimeSnapshotMetadataV1 => {
      const metadata = this.#codec.snapshotMetadata(state);
      if (explicit) {
        if (
          explicit.schemaVersion !== this.stateSchemaVersion ||
          metadata.schemaVersion !== this.stateSchemaVersion ||
          explicit.stateRevision !== metadata.stateRevision
        ) {
          throw new SqliteRuntimeFormatIncompatibleError(
            explicit.schemaVersion,
            this.compatibilityEpoch,
          );
        }
        return explicit;
      }
      return {
        eventPosition: 0,
        stateRevision: metadata.stateRevision,
        stateChecksum: '',
        schemaVersion: metadata.schemaVersion,
      };
    };
    const encodeSnapshot = (
      state: State,
      explicit?: RuntimeSnapshotMetadataV1,
    ): { json: string; metadata: RuntimeSnapshotMetadataV1 } => {
      const json = this.#codec.encodeState(state);
      const derived = snapshotMeta(state, explicit);
      return {
        json,
        metadata: { ...derived, stateChecksum: derived.stateChecksum || checksum(json) },
      };
    };
    const persistSnapshot = (
      sessionId: string,
      json: string,
      eventPosition: number,
      stateRevision: number,
      stateChecksum: string,
      schemaVersion: number,
    ): void => {
      if (targetFormat) {
        const sealed = sealSnapshot(sessionId, 'snapshot', stateRevision, json);
        upsertSnapshot.run(
          sessionId,
          sealed,
          eventPosition,
          stateRevision,
          checksum(sealed),
          schemaVersion,
          this.compatibilityEpoch,
        );
      } else {
        upsertSnapshot.run(
          sessionId,
          json,
          eventPosition,
          stateRevision,
          stateChecksum,
          schemaVersion,
        );
      }
    };
    const persistNamedSnapshot = (
      sessionId: string,
      name: string,
      eventPosition: number,
      json: string,
      stateRevision: number,
      stateChecksum: string,
      schemaVersion: number,
      createdAt?: number,
    ): void => {
      if (targetFormat) {
        const sealed = sealSnapshot(sessionId, `named/${name}`, stateRevision, json);
        const args = [
          sessionId,
          name,
          eventPosition,
          sealed,
          stateRevision,
          checksum(sealed),
          schemaVersion,
          this.compatibilityEpoch,
          ...(createdAt === undefined ? [] : [createdAt]),
        ];
        if (createdAt === undefined) upsertNamedSnapshot.run(...args);
        else insertForkNamedSnapshot.run(...args);
      } else if (createdAt === undefined) {
        upsertNamedSnapshot.run(
          sessionId,
          name,
          eventPosition,
          json,
          stateRevision,
          stateChecksum,
          schemaVersion,
        );
      } else {
        insertForkNamedSnapshot.run(
          sessionId,
          name,
          eventPosition,
          json,
          stateRevision,
          stateChecksum,
          schemaVersion,
          createdAt,
        );
      }
    };
    const restoreValidation = (
      state: State,
      sessionId: string,
      row: SnapshotRow | NamedSnapshotRow,
      eventRevision: number,
    ): void => {
      this.#codec.validateSnapshot?.({
        state,
        sessionId,
        eventPosition: row.event_position,
        stateRevision: row.state_revision,
        schemaVersion: row.schema_version,
        eventRevision,
      });
    };
    const loadEvents = (sessionId: string, since?: number): StoredRuntimeEventV1<Event>[] => {
      if (this.#closed) return [];
      const rows =
        since == null ? selectAllEvents.all(sessionId) : selectEvents.all(sessionId, since);
      return rows.map((row) => ({
        id: row.id,
        thread_id: row.thread_id,
        event: this.#codec.decodeEvent(openEvent(row)),
        created_at: row.created_at,
        ...(row.event_id ? { event_id: row.event_id } : {}),
        revision: row.revision,
        ...(row.causation_id ? { causation_id: row.causation_id } : {}),
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
      }));
    };
    const loadSnapshotRecord = <T = State>(
      sessionId: string,
    ): { state: T; metadata: RuntimeSnapshotMetadataV1 } | null => {
      if (this.#closed) return null;
      const row = selectSnapshot.get(sessionId);
      if (!row) {
        if (targetFormat && selectSessionModelRoute.get(sessionId)) {
          throw new SqliteRuntimeStorageOpenError(
            `Store5 session ${sessionId} is missing its sealed State26 snapshot.`,
          );
        }
        return null;
      }
      if (row.state_checksum && checksum(row.state_json) !== row.state_checksum) {
        throw new SqliteRuntimeStorageOpenError(
          `Store5 session ${sessionId} snapshot checksum is invalid.`,
        );
      }
      try {
        return {
          state: this.#codec.decodeState<T>(openSnapshot(row, 'snapshot')),
          metadata: {
            eventPosition: row.event_position,
            stateRevision: row.state_revision,
            stateChecksum: row.state_checksum,
            schemaVersion: row.schema_version,
          },
        };
      } catch (error) {
        if (error instanceof SqliteRuntimeStorageOpenError) throw error;
        throw new SqliteRuntimeStorageOpenError(
          `Store5 session ${sessionId} snapshot integrity is invalid.`,
          error,
        );
      }
    };
    const lastEvent = (sessionId: string): number =>
      selectLastEventPosition.get(sessionId)?.id ?? 0;
    const saveSnapshot = (sessionId: string, state: State): void => {
      if (this.#closed) return;
      ensureSession(sessionId, state);
      const encoded = encodeSnapshot(state);
      const position = lastEvent(sessionId);
      persistSnapshot(
        sessionId,
        encoded.json,
        position,
        encoded.metadata.stateRevision,
        encoded.metadata.stateChecksum,
        encoded.metadata.schemaVersion,
      );
    };

    const sessions: SessionStore<Event, State> = {
      appendEvents: (
        sessionId: string,
        events: readonly Event[],
        metadata?: readonly RuntimeEventMetadataV1[],
      ) => {
        if (this.#closed || events.length === 0) return;
        db.transaction(() => {
          ensureSession(sessionId);
          insertEvents(sessionId, events, metadata);
        })();
      },
      loadEventsStrict: loadEvents,
      saveSnapshot,
      loadSnapshot: <T = State>(sessionId: string) =>
        loadSnapshotRecord<T>(sessionId)?.state ?? null,
      loadSnapshotRecord,
      getLastEventPosition: (sessionId: string) => (this.#closed ? 0 : lastEvent(sessionId)),
      listSessions: (query = '', limit = 50): RuntimeSessionInfoV1[] => {
        if (this.#closed) return [];
        const needle = query.trim().toLowerCase();
        return listSessionsQuery
          .all(needle ? Math.max(limit, 200) : limit)
          .map((row) => {
            const first = loadEvents(row.thread_id)
              .map((entry) => ({ entry, summary: this.#codec.eventSummary?.(entry.event) ?? null }))
              .find((candidate) => candidate.summary?.isSessionNameCandidate);
            const firstText = first?.summary?.searchText ?? '';
            return { row, firstText };
          })
          .filter(
            ({ row, firstText }) =>
              !needle ||
              row.name.toLowerCase().includes(needle) ||
              firstText.toLowerCase().includes(needle),
          )
          .slice(0, limit)
          .map(({ row, firstText }) => ({
            threadId: row.thread_id,
            name: row.name || firstText || row.thread_id,
            updatedAt: row.updated_at,
            needsSmartName: !row.name,
          }));
      },
      setSessionName: (sessionId: string, name: string) => {
        if (!this.#closed) {
          ensureSession(sessionId);
          updateSessionName.run(name, sessionId);
        }
      },
      getSessionModelRoute: (sessionId): RuntimeSessionModelRouteV1 | null => {
        if (this.#closed) return null;
        const row = selectSessionModelRoute.get(sessionId);
        return row?.model_provider && row.model_name
          ? { provider: row.model_provider, name: row.model_name }
          : null;
      },
      setSessionModelRoute: (sessionId: string, route: RuntimeSessionModelRouteV1) => {
        if (!this.#closed && sessionId && route.provider.trim() && route.name.trim()) {
          ensureSession(sessionId);
          updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), sessionId);
        }
      },
      deleteSession: (sessionId: string) => {
        if (!this.#closed)
          db.transaction(() => {
            deleteEvents.run(sessionId);
            deleteSnapshot.run(sessionId);
            deleteNamedSnapshots.run(sessionId);
            deleteFilePreimages.run(sessionId);
            deleteEffectLeases.run(sessionId);
            deleteRecoveryIdentity.run(recoveryIdentityMetaKey(sessionId));
            deleteSession.run(sessionId);
            garbageCollectStore5AuthorityV1();
          })();
      },
    };
    this.sessions = Object.freeze(sessions);

    const commit = (input: RuntimeTransactionInputV1<Event, State>): void => {
      if (this.#closed) return;
      try {
        db.transaction(() => {
          if (
            input.requiredEffectLease &&
            !selectLease.get(
              input.sessionId,
              input.requiredEffectLease.effectId,
              input.requiredEffectLease.ownerId,
              input.requiredEffectLease.observedAtMs,
            )
          )
            throw new SqliteRuntimeEffectLeaseConflictError(
              input.sessionId,
              input.requiredEffectLease.effectId,
            );
          if (input.expectedRestoreBoundary) {
            const actual = selectSnapshot.get(input.sessionId);
            const expected = input.expectedRestoreBoundary.snapshot;
            const matches = expected
              ? actual != null &&
                actual.event_position === expected.eventPosition &&
                actual.state_revision === expected.stateRevision &&
                actual.state_checksum === expected.stateChecksum &&
                actual.schema_version === expected.schemaVersion
              : actual == null;
            const actualPosition = lastEvent(input.sessionId);
            if (!matches || actualPosition !== input.expectedRestoreBoundary.lastEventPosition)
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expected?.stateRevision ?? 0,
                actual?.state_revision ?? null,
                `Runtime restore boundary conflict for ${input.sessionId}: expected snapshot revision ${expected?.stateRevision ?? 'missing'} at event ${input.expectedRestoreBoundary.lastEventPosition}, found snapshot revision ${actual?.state_revision ?? 'missing'} at event ${actualPosition}.`,
              );
          }
          const firstRevision = input.metadata?.[0]?.revision;
          if (firstRevision != null) {
            const expectedRevision = firstRevision - 1;
            const actualRevision =
              selectSnapshotRevision.get(input.sessionId)?.state_revision ?? null;
            if (
              (actualRevision == null && expectedRevision !== 0) ||
              (actualRevision != null && actualRevision !== expectedRevision)
            )
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expectedRevision,
                actualRevision,
              );
          }
          ensureSession(input.sessionId, input.snapshot);
          insertEvents(input.sessionId, input.events, input.metadata);
          const encoded = encodeSnapshot(input.snapshot, input.snapshotMetadata);
          const position = input.snapshotMetadata?.eventPosition ?? lastEvent(input.sessionId);
          persistSnapshot(
            input.sessionId,
            encoded.json,
            position,
            encoded.metadata.stateRevision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
        })();
      } catch (error) {
        if (
          error instanceof SqliteRuntimeUniqueReceiptConflictError ||
          error instanceof SqliteRuntimeRevisionConflictError ||
          error instanceof SqliteRuntimeEffectLeaseConflictError
        )
          throw error;
        throw new Error(
          `Failed to persist runtime transaction for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };
    this.transactions = Object.freeze({
      commitDecision: commit,
      commitAttemptStart: commit,
      commitReceiptEvidence: commit,
      commitTerminalRecovery: commit,
    });
    this.effects = Object.freeze({
      tryAcquireEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        return db.transaction(() => {
          deleteExpiredLease.run(sessionId, effectId, now);
          insertLease.run(sessionId, effectId, ownerId, expiresAtMs);
          return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
        })();
      },
      renewEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        renewLease.run(expiresAtMs, sessionId, effectId, ownerId, now);
        return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
      },
      releaseEffectLease: (sessionId: string, effectId: string, ownerId: string): void => {
        if (!this.#closed) releaseLease.run(sessionId, effectId, ownerId);
      },
    });

    const loadNamed = <T = State>(sessionId: string, name: string): T | null => {
      if (this.#closed) return null;
      const row = selectNamedSnapshot.get(sessionId, name);
      if (!row || checksum(row.state_json) !== row.state_checksum) return null;
      try {
        return this.#codec.decodeState<T>(openSnapshot(row, `named/${name}`));
      } catch {
        return null;
      }
    };
    this.checkpoints = Object.freeze({
      saveNamedSnapshot: (
        sessionId: string,
        name: string,
        state: State,
        eventPosition?: number,
      ) => {
        if (this.#closed) return;
        ensureSession(sessionId, state);
        const encoded = encodeSnapshot(state);
        persistNamedSnapshot(
          sessionId,
          name,
          eventPosition ?? lastEvent(sessionId),
          encoded.json,
          encoded.metadata.stateRevision,
          encoded.metadata.stateChecksum,
          encoded.metadata.schemaVersion,
        );
      },
      loadNamedSnapshot: loadNamed,
      listNamedSnapshots: (sessionId: string) => {
        if (this.#closed) return [];
        const events = loadEvents(sessionId);
        return listNamedSnapshotsQuery.all(sessionId).map((row) => {
          const target = events.find(
            (entry) =>
              entry.id > row.event_position &&
              this.#codec.eventSummary?.(entry.event)?.isSessionNameCandidate,
          );
          const summary = target ? this.#codec.eventSummary?.(target.event) : null;
          return {
            snapshotId: row.name,
            eventPosition: row.event_position,
            createdAt: row.created_at,
            ...(summary?.searchText != null ? { targetMessage: summary.searchText } : {}),
            ...(target ? { targetMessageCreatedAt: target.created_at } : {}),
            affectedFileCount: row.affected_file_count,
          };
        });
      },
      getNamedSnapshotEntry: (sessionId: string, snapshotId: string) => {
        if (this.#closed) return null;
        const row = selectNamedSnapshotEntry.get(sessionId, snapshotId);
        return row
          ? { snapshotId: row.name, eventPosition: row.event_position, createdAt: row.created_at }
          : null;
      },
      restoreNamedSnapshot: (sessionId: string, snapshotId: string): boolean => {
        if (this.#closed) return false;
        const row = selectNamedSnapshot.get(sessionId, snapshotId);
        if (!row || checksum(row.state_json) !== row.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(openSnapshot(row, `named/${snapshotId}`));
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sessionId, row.event_position)?.revision ?? 0;
          restoreValidation(state, sessionId, row, eventRevision);
          if (
            row.schema_version !== this.stateSchemaVersion ||
            row.event_position > lastEvent(sessionId) ||
            row.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        db.transaction(() => {
          deleteEventsAfter.run(sessionId, row.event_position);
          deleteNamedSnapshotsAfter.run(sessionId, row.event_position);
          deleteFilePreimagesAfter.run(sessionId, row.event_position);
          const encoded = encodeSnapshot(state);
          persistSnapshot(
            sessionId,
            encoded.json,
            row.event_position,
            row.state_revision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
          ensureSession(sessionId, state);
          garbageCollectStore5AuthorityV1();
        })();
        return true;
      },
      forkSession: (
        sourceSessionId: string,
        snapshotId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ): boolean => {
        if (
          this.#closed ||
          !sourceSessionId ||
          !targetSessionId ||
          sourceSessionId === targetSessionId
        )
          return false;
        if (!isCanonicalRecoveryIdentity(targetRecoveryIdentityKey)) return false;
        const current = snapshotId === '__runtime_current__';
        const rolling = current ? selectSnapshot.get(sourceSessionId) : null;
        const named = current ? null : selectNamedSnapshot.get(sourceSessionId, snapshotId);
        const sourceRow = rolling ?? named;
        if (!sourceRow || checksum(sourceRow.state_json) !== sourceRow.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(
            openSnapshot(sourceRow, current ? 'snapshot' : `named/${snapshotId}`),
          );
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sourceSessionId, sourceRow.event_position)
              ?.revision ?? 0;
          restoreValidation(state, sourceSessionId, sourceRow, eventRevision);
          if (this.#codec.canFork && !this.#codec.canFork(state)) return false;
          if (
            sourceRow.schema_version !== this.stateSchemaVersion ||
            sourceRow.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        let sourceEvents: StoredRuntimeEventV1<Event>[];
        try {
          sourceEvents = loadEvents(sourceSessionId).filter(
            (entry) =>
              entry.id <= sourceRow.event_position &&
              (!current || !this.#codec.isCurrentPendingInteractionRequest?.(state, entry.event)),
          );
        } catch {
          return false;
        }
        const sourceNamed = selectNamedSnapshotsForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceFiles = selectFilePreimagesForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceRoute = this.sessions.getSessionModelRoute(sourceSessionId);
        const snapshotRecoveryIdentity = this.#codec.recoveryIdentity?.(state);
        if (
          snapshotRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(snapshotRecoveryIdentity)
        )
          return false;
        const persistedRecoveryIdentity = selectRecoveryIdentity.get(
          recoveryIdentityMetaKey(sourceSessionId),
        )?.value;
        if (
          persistedRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(persistedRecoveryIdentity)
        )
          return false;
        if (
          snapshotRecoveryIdentity !== undefined &&
          persistedRecoveryIdentity !== undefined &&
          snapshotRecoveryIdentity !== persistedRecoveryIdentity
        )
          return false;
        const sourceRecoveryIdentity = persistedRecoveryIdentity ?? snapshotRecoveryIdentity;
        if (
          (this.#codec.recoveryIdentity && sourceRecoveryIdentity === undefined) ||
          sourceRecoveryIdentity === targetRecoveryIdentityKey
        )
          return false;
        const forkState = this.#codec.rebindForkState(
          state,
          targetSessionId,
          targetRecoveryIdentityKey,
        );
        try {
          const forkMetadata = this.#codec.snapshotMetadata(forkState);
          this.#codec.validateSnapshot?.({
            state: forkState,
            sessionId: targetSessionId,
            eventPosition: 0,
            stateRevision: forkMetadata.stateRevision,
            schemaVersion: forkMetadata.schemaVersion,
            eventRevision: forkMetadata.stateRevision,
          });
        } catch {
          return false;
        }
        db.transaction(() => {
          deleteEvents.run(targetSessionId);
          deleteSnapshot.run(targetSessionId);
          deleteNamedSnapshots.run(targetSessionId);
          deleteFilePreimages.run(targetSessionId);
          deleteRecoveryIdentity.run(recoveryIdentityMetaKey(targetSessionId));
          deleteSession.run(targetSessionId);
          ensureSession(targetSessionId, forkState);
          if (sourceRecoveryIdentity !== undefined) {
            if (persistedRecoveryIdentity === undefined) {
              insertRecoveryIdentity.run(
                recoveryIdentityMetaKey(sourceSessionId),
                sourceRecoveryIdentity,
              );
            }
            insertRecoveryIdentity.run(
              recoveryIdentityMetaKey(targetSessionId),
              targetRecoveryIdentityKey,
            );
          }
          if (sourceRoute)
            updateSessionModelRoute.run(sourceRoute.provider, sourceRoute.name, targetSessionId);
          const positions = new Map<number, number>();
          for (const entry of sourceEvents) {
            persistDataOrigins(this.#codec.dataOriginsForEvent?.(entry.event) ?? []);
            persistEgressAuthorities(this.#codec.egressAuthoritiesForEvent?.(entry.event) ?? []);
            const eventId = entry.event_id ?? `${targetSessionId}:${entry.revision}`;
            const serialized = sealEvent(
              targetSessionId,
              eventId,
              this.#codec.encodeEvent(entry.event),
            );
            const inserted = insertForkEvent.run(
              ...(targetFormat
                ? [
                    targetSessionId,
                    serialized,
                    eventId,
                    entry.revision ?? 0,
                    this.stateSchemaVersion,
                    entry.causation_id ?? null,
                    entry.occurred_at ?? null,
                    entry.created_at,
                  ]
                : [
                    targetSessionId,
                    serialized,
                    entry.event_id ?? null,
                    entry.revision ?? 0,
                    entry.causation_id ?? null,
                    entry.occurred_at ?? null,
                    entry.created_at,
                  ]),
            );
            positions.set(
              entry.id,
              targetFormat ? (entry.revision ?? 0) : Number(inserted.lastInsertRowid),
            );
          }
          const remap = (position: number): number => {
            let target = 0;
            for (const entry of sourceEvents) {
              if (entry.id > position) break;
              target = positions.get(entry.id) ?? target;
            }
            return target;
          };
          for (const file of sourceFiles)
            insertForkFilePreimage.run(
              targetSessionId,
              file.path,
              remap(file.event_position),
              file.content,
              file.existed,
              file.post_hash,
              file.post_existed,
              file.created_at,
            );
          const encodedFork = encodeSnapshot(forkState);
          persistSnapshot(
            targetSessionId,
            encodedFork.json,
            remap(sourceRow.event_position),
            encodedFork.metadata.stateRevision,
            encodedFork.metadata.stateChecksum,
            encodedFork.metadata.schemaVersion,
          );
          for (const snapshot of sourceNamed) {
            try {
              if (checksum(snapshot.state_json) !== snapshot.state_checksum) continue;
              const namedState = this.#codec.decodeState<State>(
                openSnapshot(snapshot, `named/${snapshot.name}`),
              );
              if (this.#codec.canFork && !this.#codec.canFork(namedState)) continue;
              const rebound = this.#codec.rebindForkState(
                namedState,
                targetSessionId,
                targetRecoveryIdentityKey,
              );
              this.#codec.validateSnapshot?.({
                state: rebound,
                sessionId: targetSessionId,
                eventPosition: remap(snapshot.event_position),
                stateRevision: snapshot.state_revision,
                schemaVersion: snapshot.schema_version,
                eventRevision: snapshot.state_revision,
              });
              const encodedNamed = encodeSnapshot(rebound, {
                eventPosition: remap(snapshot.event_position),
                stateRevision: snapshot.state_revision,
                stateChecksum: '',
                schemaVersion: snapshot.schema_version,
              });
              persistNamedSnapshot(
                targetSessionId,
                snapshot.name,
                remap(snapshot.event_position),
                encodedNamed.json,
                snapshot.state_revision,
                encodedNamed.metadata.stateChecksum,
                snapshot.schema_version,
                snapshot.created_at,
              );
            } catch {
              /* corrupt or rejected recovery points are omitted */
            }
          }
          garbageCollectStore5AuthorityV1();
        })();
        return true;
      },
      forkCurrentSession: (
        sourceSessionId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ) =>
        this.checkpoints.forkSession(
          sourceSessionId,
          '__runtime_current__',
          targetSessionId,
          targetRecoveryIdentityKey,
        ),
      recordFilePreimage: (
        sessionId: string,
        path: string,
        content: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          if (selectFilePreimageInWindow.get(sessionId, path, boundary)) return;
          insertFilePreimage.run(sessionId, path, lastEvent(sessionId), content, existed ? 1 : 0);
        } catch {
          /* best effort by contract */
        }
      },
      recordFilePostimage: (
        sessionId: string,
        path: string,
        contentHash: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          updateFilePostimageInWindow.run(contentHash, existed ? 1 : 0, sessionId, path, boundary);
        } catch {
          /* best effort by contract */
        }
      },
      fileRestorePlan: (
        sessionId: string,
        eventPosition: number,
      ): RuntimeFileRestoreMaterialV1[] =>
        this.#closed
          ? []
          : selectFileRestorePlan.all(sessionId, eventPosition).map((row) => ({
              path: row.path,
              content: row.content,
              existed: row.existed === 1,
              postHash: row.post_hash,
              postExisted: row.post_existed == null ? null : row.post_existed === 1,
            })),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db) {
      try {
        this.#db.fileControl('main', constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      } catch {
        /* best effort */
      }
      try {
        this.#db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort */
      }
      this.#db.close();
    }
  }
}

export function createSqliteRuntimeStorage<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInputV1<Event, State>,
): RuntimeStorage<Event, State> {
  return new SqliteRuntimeStorageAdapter(input);
}

/** Package-internal target constructor; only store5.ts owns the profile. */
export function createSqliteRuntimeStorageForFormatV1<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInputV1<Event, State>,
  formatProfile: SqliteRuntimeFormatProfileV1,
): RuntimeStorage<Event, State> {
  return new SqliteRuntimeStorageAdapter({ ...input, formatProfile });
}

export function createSqliteRuntimeStorageBoundaryV1(): RuntimeStorageBoundaryV1 {
  return Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    compatibilityEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
  });
}
