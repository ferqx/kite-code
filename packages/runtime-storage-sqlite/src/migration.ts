import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { RuntimeSnapshotCodec } from '@kite-ai/runtime-host/storage';
import {
  createSqliteRuntimeLayoutCutover,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  readSqliteRuntimeMigrationFence,
  resolveSqliteCatalogPath,
  type SqliteRuntimeLayoutManifest,
  type SqliteRuntimeLayoutPaths,
  type SqliteRuntimeMigrationFence,
  type SqliteRuntimeMigrationJournal,
  writeSqliteRuntimeMigrationJournal,
} from './layout';
import {
  assertCurrentSqliteRuntimeStoreConnection,
  assertNoFollowDatabasePath,
  assertSqliteRuntimeWorkspaceBinding,
  assertWorkspaceSqliteRuntimeStoreConnection,
  checksum,
  openSqliteReadonlySnapshotView,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';
import { initializeSqliteRuntimeSchema } from './schema';

const SOURCE_PROFILE = Object.freeze({
  stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
});

export interface SqliteRuntimeMigrationSessionIdentity {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly revision: number;
}

export interface SqliteRuntimeMigrationWorkspaceBinding extends SqliteRuntimeWorkspaceBinding {
  readonly projectId: string;
  readonly workspaceDigest: string;
}

export interface SqliteRuntimeMigrationSourceGuard {
  readonly serviceAbsent: boolean;
  readonly sourceStoreIdentity: string;
  readonly sourceStoreDigest: string;
  readonly fence: SqliteRuntimeMigrationFence;
}

/**
 * The only Catalog data a Store migration may hand to its owning composition.
 * It deliberately excludes Workspace paths, titles, Runtime bodies and
 * credentials; the Coordinator package owns the physical Catalog schema.
 */
export interface SqliteRuntimeMigrationCatalogSession {
  readonly sessionId: string;
  readonly workerScopeId: string;
  readonly directoryRevision: string;
  readonly updatedAt: string;
  readonly tombstone: boolean;
}

/**
 * Service/Coordinator-owned Catalog construction seam. The storage package
 * supplies an exact target path and path-free routing metadata, then verifies
 * the returned digest against the published file before switching layout.
 */
export interface SqliteRuntimeMigrationCatalogBuilder {
  build(input: {
    readonly catalogPath: string;
    readonly layoutGeneration: string;
    readonly sessions: readonly SqliteRuntimeMigrationCatalogSession[];
  }): string | Promise<string>;
}

export interface SqliteRuntimeWorkspaceMigrationOptions<Event = unknown, State = unknown> {
  readonly sourceStorePath: string;
  readonly layout: SqliteRuntimeLayoutPaths;
  readonly targetLayoutGeneration: string;
  readonly sourceGuard: SqliteRuntimeMigrationSourceGuard;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>;
  /** Required Coordinator-owned Catalog builder; migration never defines Catalog DDL. */
  readonly catalogBuilder: SqliteRuntimeMigrationCatalogBuilder;
  /** Resolve only from validated persisted identity; returning null blocks the whole migration. */
  readonly resolveWorkspaceBinding: (
    identity: SqliteRuntimeMigrationSessionIdentity,
  ) => SqliteRuntimeMigrationWorkspaceBinding | null;
  /** Test-only fault injection before pointer switch. */
  readonly faultAfterSessionCopies?: number;
}

export type SqliteRuntimeWorkspaceMigrationResult =
  | {
      readonly status: 'committed';
      readonly targetLayoutGeneration: string;
      readonly catalogDigest: string;
      readonly workspaceStoreDigests: readonly {
        readonly workerScopeId: string;
        readonly digest: string;
      }[];
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'service_present'
        | 'missing_fence'
        | 'source_changed'
        | 'source_corrupt'
        | 'unowned_session'
        | 'orphan_receipt'
        | 'conflicting_workspace'
        | 'copy_interrupted'
        | 'target_invalid'
        | 'layout_invalid';
      readonly journal?: SqliteRuntimeMigrationJournal;
    };

export class SqliteRuntimeWorkspaceMigrationError extends Error {
  readonly code = 'migration_blocked' as const;
  readonly reason: Extract<SqliteRuntimeWorkspaceMigrationResult, { status: 'blocked' }>['reason'];

  constructor(
    reason: Extract<SqliteRuntimeWorkspaceMigrationResult, { status: 'blocked' }>['reason'],
    message: string,
  ) {
    super(message);
    this.name = 'SqliteRuntimeWorkspaceMigrationError';
    this.reason = reason;
  }
}

interface SourceSessionMaterial {
  readonly session: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly workspaceDigest: string;
    readonly stateSchema: number;
    readonly formatEpoch: string;
    readonly revision: number;
    readonly name: string;
    readonly modelProvider: string | null;
    readonly modelName: string | null;
    readonly updatedAt: number;
  };
  readonly snapshot: {
    readonly schemaVersion: number;
    readonly formatEpoch: string;
    readonly revision: number;
    readonly stateJson: string;
    readonly eventPosition: number;
    readonly stateChecksum: string;
    readonly createdAt: number;
  };
  readonly events: readonly {
    readonly eventId: string;
    readonly sequence: number;
    readonly schemaVersion: number;
    readonly eventJson: string;
    readonly causationId: string | null;
    readonly occurredAt: string | null;
    readonly createdAt: number;
  }[];
  readonly namedSnapshots: readonly {
    readonly name: string;
    readonly schemaVersion: number;
    readonly formatEpoch: string;
    readonly revision: number;
    readonly stateJson: string;
    readonly eventPosition: number;
    readonly stateChecksum: string;
    readonly createdAt: number;
  }[];
  readonly filePreimages: readonly {
    readonly path: string;
    readonly eventPosition: number;
    readonly content: string | null;
    readonly existed: boolean;
    readonly postHash: string | null;
    readonly postExisted: boolean | null;
    readonly createdAt: number;
  }[];
  readonly effects: readonly {
    readonly effectId: string;
    readonly ownerId: string;
    readonly leaseRevision: number;
    readonly certainty: string;
    readonly expiresAtMs: number;
  }[];
  readonly binding: SqliteRuntimeMigrationWorkspaceBinding;
  readonly contentDigest: string;
}

interface SourceReceipt {
  readonly scopeSessionId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly targetSessionId: string;
  readonly originalReceiptJson: string;
  readonly committedRevision: number;
  readonly committedAt: number;
}

export async function migrateSqliteRuntimeStoreToWorkspaceLayout<Event = unknown, State = unknown>(
  options: SqliteRuntimeWorkspaceMigrationOptions<Event, State>,
): Promise<SqliteRuntimeWorkspaceMigrationResult> {
  let journal: SqliteRuntimeMigrationJournal | undefined;
  let switched = false;
  try {
    ensureSqliteRuntimeLayoutRoot(options.layout.root);
    if (!options.sourceGuard.serviceAbsent) return blocked('service_present');
    if (
      options.sourceGuard.fence.state !== 'active' ||
      options.sourceGuard.fence.sourceStoreIdentity !== options.sourceGuard.sourceStoreIdentity ||
      options.sourceGuard.fence.sourceStoreDigest !== options.sourceGuard.sourceStoreDigest ||
      options.sourceGuard.fence.targetLayoutGeneration !== options.targetLayoutGeneration ||
      !sameProfile(options.sourceGuard.fence.sourceProfile, SOURCE_PROFILE)
    ) {
      return blocked('missing_fence');
    }
    let persistedFence: SqliteRuntimeMigrationFence | undefined;
    try {
      persistedFence = readSqliteRuntimeMigrationFence(options.layout);
    } catch {
      return blocked('missing_fence');
    }
    if (!persistedFence || !sameFence(persistedFence, options.sourceGuard.fence)) {
      return blocked('missing_fence');
    }
    const sourceIdentity = sqliteRuntimeStoreFingerprint(options.sourceStorePath);
    if (
      sourceIdentity !== options.sourceGuard.sourceStoreIdentity ||
      sqliteRuntimeStoreDigest(options.sourceStorePath) !== options.sourceGuard.sourceStoreDigest
    ) {
      return blocked('source_changed');
    }

    journal = initialJournal(options);
    writeMigrationJournal(options.layout, journal);
    const sourceView = openSqliteReadonlySnapshotView(options.sourceStorePath);
    let sourceMaterial: {
      readonly sessions: readonly SourceSessionMaterial[];
      readonly receipts: readonly SourceReceipt[];
      readonly recoveryMeta: readonly { readonly key: string; readonly value: string }[];
    };
    try {
      sourceMaterial = readAndValidateSource(sourceView.database, options);
    } finally {
      sourceView.close();
    }
    if (
      sqliteRuntimeStoreFingerprint(options.sourceStorePath) !==
        options.sourceGuard.sourceStoreIdentity ||
      sqliteRuntimeStoreDigest(options.sourceStorePath) !== options.sourceGuard.sourceStoreDigest
    ) {
      return blockedWithJournal('source_changed', options.layout, journal);
    }

    const receiptByTarget = new Map<string, SourceReceipt[]>();
    const sessionsById = new Map(
      sourceMaterial.sessions.map((session) => [session.session.sessionId, session]),
    );
    for (const receipt of sourceMaterial.receipts) {
      const target = sessionsById.get(receipt.targetSessionId);
      if (!target) return blockedWithJournal('orphan_receipt', options.layout, journal);
      if (receipt.committedRevision > target.session.revision) {
        return blockedWithJournal('source_corrupt', options.layout, journal);
      }
      const scope = sessionsById.get(receipt.scopeSessionId);
      if (!scope) return blockedWithJournal('orphan_receipt', options.layout, journal);
      if (!sameWorkspaceBinding(scope.binding, target.binding)) {
        return blockedWithJournal('conflicting_workspace', options.layout, journal);
      }
      const rows = receiptByTarget.get(receipt.targetSessionId) ?? [];
      rows.push(receipt);
      receiptByTarget.set(receipt.targetSessionId, rows);
    }

    const storesByScope = new Map<string, SourceSessionMaterial[]>();
    for (const session of sourceMaterial.sessions) {
      const rows = storesByScope.get(session.binding.workerScopeId) ?? [];
      rows.push(session);
      storesByScope.set(session.binding.workerScopeId, rows);
    }

    const storeDigests: { workerScopeId: string; digest: string }[] = [];
    let copiedSessions = 0;
    for (const [workerScopeId, sessions] of storesByScope) {
      const binding = sessions[0]!.binding;
      const databasePath = ensureSqliteWorkspaceStoreDirectory(
        options.layout,
        options.targetLayoutGeneration,
        workerScopeId,
      );
      const database = createWorkspaceTarget(databasePath, binding);
      try {
        copyWorkspaceSessions(database, sessions, receiptByTarget, sourceMaterial.recoveryMeta);
        for (let index = 0; index < sessions.length; index += 1) {
          copiedSessions += 1;
          if (
            options.faultAfterSessionCopies !== undefined &&
            copiedSessions >= options.faultAfterSessionCopies
          ) {
            throw new SqliteRuntimeWorkspaceMigrationError(
              'copy_interrupted',
              'SQLite Workspace migration was interrupted before pointer switch.',
            );
          }
        }
        assertWorkspaceSqliteRuntimeStoreConnection(database, binding);
        for (const session of sessions) {
          const targetDigest = readTargetSessionDigest(database, session.session.sessionId);
          if (targetDigest !== session.contentDigest) {
            throw new SqliteRuntimeWorkspaceMigrationError(
              'target_invalid',
              'SQLite Workspace migration target content digest mismatches its source.',
            );
          }
          if (
            readTargetReceiptDigest(database, session.session.sessionId) !==
            digestReceipts(receiptByTarget.get(session.session.sessionId) ?? [])
          ) {
            throw new SqliteRuntimeWorkspaceMigrationError(
              'target_invalid',
              'SQLite Workspace migration target receipt digest mismatches its source.',
            );
          }
        }
      } finally {
        database.close();
      }
      storeDigests.push({
        workerScopeId,
        digest: sqliteRuntimeStoreDigest(databasePath),
      });
    }

    // The read view is isolated, but the legacy file must still be unchanged
    // at the final publication boundary. A supported caller holds the fence;
    // this second check also fails closed if that contract was violated.
    if (
      sqliteRuntimeStoreFingerprint(options.sourceStorePath) !==
        options.sourceGuard.sourceStoreIdentity ||
      sqliteRuntimeStoreDigest(options.sourceStorePath) !== options.sourceGuard.sourceStoreDigest
    ) {
      return blockedWithJournal('source_changed', options.layout, journal);
    }

    const catalogPath = resolveSqliteCatalogPath(options.layout, options.targetLayoutGeneration);
    assertNoFollowDatabasePath(catalogPath);
    ensureSqliteRuntimeGenerationRoot(options.layout, options.targetLayoutGeneration);
    const catalogDigest = await buildCatalog(
      options.catalogBuilder,
      catalogPath,
      options.targetLayoutGeneration,
      sourceMaterial.sessions,
    );
    const targetJournal: SqliteRuntimeMigrationJournal = {
      ...journal,
      targetCatalogDigest: catalogDigest,
      workspaceStoreDigests: storeDigests,
    };
    writeMigrationJournal(options.layout, targetJournal);
    journal = targetJournal;

    if (
      sqliteRuntimeStoreFingerprint(options.sourceStorePath) !==
        options.sourceGuard.sourceStoreIdentity ||
      sqliteRuntimeStoreDigest(options.sourceStorePath) !== options.sourceGuard.sourceStoreDigest
    ) {
      return blockedWithJournal('source_changed', options.layout, journal);
    }

    const manifest: SqliteRuntimeLayoutManifest = {
      schema: 'kite.runtime-layout-manifest.v1' as const,
      generation: options.targetLayoutGeneration,
      profile: {
        stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
        formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      },
      catalogDigest,
      workspaceStores: storeDigests,
    };
    const cutover = createSqliteRuntimeLayoutCutover(options.layout);
    cutover.prepareTarget(manifest, targetJournal, options.sourceGuard.fence);
    cutover.switchPointer();
    switched = true;
    cutover.markTargetReady();
    cutover.commit();
    return {
      status: 'committed',
      targetLayoutGeneration: options.targetLayoutGeneration,
      catalogDigest,
      workspaceStoreDigests: storeDigests,
    };
  } catch (error) {
    if (error instanceof SqliteRuntimeWorkspaceMigrationError) {
      if (switched) throw error;
      return blockedWithJournal(error.reason, options.layout, journal);
    }
    if (switched) throw error;
    return blockedWithJournal('target_invalid', options.layout, journal);
  }
}

function readAndValidateSource<Event, State>(
  database: Database,
  options: SqliteRuntimeWorkspaceMigrationOptions<Event, State>,
): {
  readonly sessions: readonly SourceSessionMaterial[];
  readonly receipts: readonly SourceReceipt[];
  readonly recoveryMeta: readonly { readonly key: string; readonly value: string }[];
} {
  try {
    assertCurrentSqliteRuntimeStoreConnection(database);
    assertNoOrphanRuntimeRows(database);
    const rows = database
      .query<
        {
          session_id: string;
          project_id: string;
          workspace_digest: string;
          state_schema: number;
          format_epoch: string;
          revision: number;
          name: string;
          model_provider: string | null;
          model_name: string | null;
          updated_at: number;
        },
        []
      >(
        'SELECT session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, model_provider, model_name, updated_at FROM runtime_sessions ORDER BY session_id',
      )
      .all();
    const sessions: SourceSessionMaterial[] = [];
    const scopes = new Map<string, string>();
    const identities = new Map<string, string>();
    for (const row of rows) {
      const identity: SqliteRuntimeMigrationSessionIdentity = {
        sessionId: row.session_id,
        projectId: row.project_id,
        workspaceDigest: row.workspace_digest,
        revision: row.revision,
      };
      const binding = options.resolveWorkspaceBinding(identity);
      if (!binding)
        throw new SqliteRuntimeWorkspaceMigrationError(
          'unowned_session',
          'Workspace ownership is unavailable.',
        );
      assertMigrationBinding(binding, options.targetLayoutGeneration, identity);
      const scopeIdentity = JSON.stringify([
        binding.projectId,
        binding.workspaceDigest,
        binding.workspaceIdentityDigest,
      ]);
      const priorIdentity = scopes.get(binding.workerScopeId);
      if (priorIdentity !== undefined && priorIdentity !== scopeIdentity) {
        throw new SqliteRuntimeWorkspaceMigrationError(
          'conflicting_workspace',
          'Worker scope maps to multiple Workspaces.',
        );
      }
      const priorScope = identities.get(scopeIdentity);
      if (priorScope !== undefined && priorScope !== binding.workerScopeId) {
        throw new SqliteRuntimeWorkspaceMigrationError(
          'conflicting_workspace',
          'Workspace maps to multiple Worker scopes.',
        );
      }
      scopes.set(binding.workerScopeId, scopeIdentity);
      identities.set(scopeIdentity, binding.workerScopeId);
      const material = readSourceSession(database, row, binding, options.codec);
      sessions.push(material);
    }
    const receipts = readSourceReceipts(database);
    const runtimeMeta = database
      .query<{ key: string; value: string }, []>(
        'SELECT key, value FROM runtime_store_meta ORDER BY key',
      )
      .all();
    const recoveryMeta = runtimeMeta.filter((entry) =>
      entry.key.startsWith('recovery_identity_v1:'),
    );
    for (const entry of runtimeMeta) {
      if (
        entry.key !== 'format_version' &&
        entry.key !== 'runtime_format_epoch' &&
        !entry.key.startsWith('recovery_identity_v1:')
      ) {
        throw new SqliteRuntimeWorkspaceMigrationError(
          'source_corrupt',
          'SQLite source contains unknown metadata.',
        );
      }
    }
    const sessionIds = new Set(sessions.map((session) => session.session.sessionId));
    for (const entry of recoveryMeta) {
      const encodedSessionId = entry.key.slice('recovery_identity_v1:'.length);
      if (
        !/^[a-f0-9]+$/u.test(encodedSessionId) ||
        encodedSessionId.length % 2 !== 0 ||
        !sessionIds.has(Buffer.from(encodedSessionId, 'hex').toString('utf8')) ||
        Buffer.from(Buffer.from(encodedSessionId, 'hex').toString('utf8'), 'utf8').toString(
          'hex',
        ) !== encodedSessionId
      ) {
        throw new SqliteRuntimeWorkspaceMigrationError(
          'source_corrupt',
          'Recovery identity metadata is malformed.',
        );
      }
      if (!/^[a-f0-9]{64}$/u.test(entry.value)) {
        throw new SqliteRuntimeWorkspaceMigrationError(
          'source_corrupt',
          'Recovery identity metadata is malformed.',
        );
      }
    }
    return { sessions, receipts, recoveryMeta };
  } catch (error) {
    if (error instanceof SqliteRuntimeWorkspaceMigrationError) throw error;
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'SQLite source is corrupt or unknown.',
    );
  }
}

function assertNoOrphanRuntimeRows(database: Database): void {
  for (const table of [
    'runtime_events',
    'runtime_snapshots',
    'runtime_named_snapshots',
    'runtime_file_preimages',
    'runtime_effect_leases',
  ]) {
    const orphan = database
      .query<{ session_id: string }, []>(
        `SELECT ${table}.session_id FROM ${table} LEFT JOIN runtime_sessions ON runtime_sessions.session_id = ${table}.session_id WHERE runtime_sessions.session_id IS NULL LIMIT 1`,
      )
      .get();
    if (orphan) {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        `SQLite source contains an orphan row in ${table}.`,
      );
    }
  }
}

function readSourceSession<Event, State>(
  database: Database,
  row: {
    readonly session_id: string;
    readonly project_id: string;
    readonly workspace_digest: string;
    readonly state_schema: number;
    readonly format_epoch: string;
    readonly revision: number;
    readonly name: string;
    readonly model_provider: string | null;
    readonly model_name: string | null;
    readonly updated_at: number;
  },
  binding: SqliteRuntimeMigrationWorkspaceBinding,
  codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>,
): SourceSessionMaterial {
  if (
    !isNonEmptyText(row.session_id) ||
    !isNonEmptyText(row.project_id) ||
    !isNonEmptyText(row.workspace_digest) ||
    row.state_schema !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    row.format_epoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
    !isNonNegativeSafeInteger(row.revision) ||
    !isOptionalText(row.name) ||
    !isOptionalText(row.model_provider) ||
    !isOptionalText(row.model_name) ||
    !isNonNegativeSafeInteger(row.updated_at)
  ) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source Session profile is invalid.',
    );
  }
  const events = database
    .query<
      {
        event_id: string;
        sequence: number;
        schema_version: number;
        event_json: string;
        causation_id: string | null;
        occurred_at: string | null;
        created_at: number;
      },
      [string]
    >(
      'SELECT event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence',
    )
    .all(row.session_id);
  if (events.length !== row.revision) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source Session event count is invalid.',
    );
  }
  for (const [index, event] of events.entries()) {
    if (
      !isNonEmptyText(event.event_id) ||
      event.sequence !== index + 1 ||
      event.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      typeof event.event_json !== 'string' ||
      !isOptionalText(event.causation_id) ||
      !isOptionalText(event.occurred_at) ||
      !isNonNegativeSafeInteger(event.created_at)
    ) {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'Source Session event sequence is invalid.',
      );
    }
    try {
      codec.decodeEvent(event.event_json);
    } catch {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'Source Session event body is invalid.',
      );
    }
  }
  const snapshot = database
    .query<
      {
        schema_version: number;
        format_epoch: string;
        revision: number;
        state_json: string;
        event_position: number;
        state_checksum: string;
        created_at: number;
      },
      [string]
    >(
      'SELECT schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
    )
    .get(row.session_id);
  if (
    !snapshot ||
    snapshot.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    snapshot.format_epoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
    snapshot.revision !== row.revision ||
    snapshot.event_position !== row.revision ||
    !snapshot.state_checksum ||
    typeof snapshot.state_json !== 'string' ||
    !isNonNegativeSafeInteger(snapshot.event_position) ||
    !isNonNegativeSafeInteger(snapshot.created_at) ||
    checksum(snapshot.state_json) !== snapshot.state_checksum
  ) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source Session snapshot is invalid.',
    );
  }
  let state: State;
  try {
    state = codec.decodeState<State>(snapshot.state_json);
    const sessionIdentity = codec.sessionIdentity?.(state);
    const metadata = codec.snapshotMetadata(state);
    if (
      !sessionIdentity ||
      sessionIdentity.projectId !== row.project_id ||
      sessionIdentity.canonicalWorkspaceDigest !== row.workspace_digest ||
      metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      metadata.stateRevision !== row.revision
    ) {
      throw new Error('session identity mismatch');
    }
    codec.validateSnapshot?.({
      state,
      sessionId: row.session_id,
      eventPosition: snapshot.event_position,
      stateRevision: snapshot.revision,
      schemaVersion: snapshot.schema_version,
      eventRevision: row.revision,
    });
  } catch {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source Session state identity is invalid.',
    );
  }
  const namedSnapshots = database
    .query<
      {
        name: string;
        schema_version: number;
        format_epoch: string;
        revision: number;
        state_json: string;
        event_position: number;
        state_checksum: string;
        created_at: number;
      },
      [string]
    >(
      'SELECT name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at FROM runtime_named_snapshots WHERE session_id = ? ORDER BY event_position, name',
    )
    .all(row.session_id);
  for (const named of namedSnapshots) {
    if (
      !isNonEmptyText(named.name) ||
      named.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      named.format_epoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
      typeof named.state_json !== 'string' ||
      named.revision !== named.event_position ||
      !isNonNegativeSafeInteger(named.revision) ||
      named.event_position > row.revision ||
      !isNonNegativeSafeInteger(named.event_position) ||
      !isNonNegativeSafeInteger(named.created_at) ||
      !named.state_checksum ||
      checksum(named.state_json) !== named.state_checksum
    ) {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'Source named snapshot is invalid.',
      );
    }
    try {
      const namedState = codec.decodeState<State>(named.state_json);
      const namedIdentity = codec.sessionIdentity?.(namedState);
      const namedMetadata = codec.snapshotMetadata(namedState);
      if (
        !namedIdentity ||
        namedIdentity.projectId !== row.project_id ||
        namedIdentity.canonicalWorkspaceDigest !== row.workspace_digest ||
        namedMetadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        namedMetadata.stateRevision !== named.revision
      ) {
        throw new Error('named snapshot identity mismatch');
      }
    } catch {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'Source named snapshot state is invalid.',
      );
    }
  }
  const filePreimages = database
    .query<
      {
        path: string;
        event_position: number;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
        created_at: number;
      },
      [string]
    >(
      'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE session_id = ? ORDER BY event_position, path',
    )
    .all(row.session_id);
  if (
    filePreimages.some(
      (entry) =>
        !entry.path ||
        entry.path.includes('\0') ||
        entry.event_position < 0 ||
        entry.event_position > row.revision ||
        !isNonNegativeSafeInteger(entry.event_position) ||
        (entry.existed !== 0 && entry.existed !== 1) ||
        (entry.post_existed !== null && entry.post_existed !== 0 && entry.post_existed !== 1) ||
        !isNonNegativeSafeInteger(entry.created_at),
    )
  ) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source file preimage is invalid.',
    );
  }
  const effects = database
    .query<
      {
        effect_id: string;
        owner_id: string;
        lease_revision: number;
        certainty: string;
        expires_at_ms: number;
      },
      [string]
    >(
      'SELECT effect_id, owner_id, lease_revision, certainty, expires_at_ms FROM runtime_effect_leases WHERE session_id = ? ORDER BY effect_id',
    )
    .all(row.session_id);
  if (
    effects.some(
      (effect) =>
        !isNonEmptyText(effect.effect_id) ||
        !isNonEmptyText(effect.owner_id) ||
        !isNonNegativeSafeInteger(effect.lease_revision) ||
        !isNonEmptyText(effect.certainty) ||
        !isNonNegativeSafeInteger(effect.expires_at_ms),
    )
  ) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'Source effect lease is invalid.',
    );
  }
  const contentDigest = digestSourceContent({
    row,
    snapshot,
    events,
    namedSnapshots,
    filePreimages,
    effects,
  });
  return {
    session: {
      sessionId: row.session_id,
      projectId: row.project_id,
      workspaceDigest: row.workspace_digest,
      stateSchema: row.state_schema,
      formatEpoch: row.format_epoch,
      revision: row.revision,
      name: row.name,
      modelProvider: row.model_provider,
      modelName: row.model_name,
      updatedAt: row.updated_at,
    },
    snapshot: {
      schemaVersion: snapshot.schema_version,
      formatEpoch: snapshot.format_epoch,
      revision: snapshot.revision,
      stateJson: snapshot.state_json,
      eventPosition: snapshot.event_position,
      stateChecksum: snapshot.state_checksum,
      createdAt: snapshot.created_at,
    },
    events: events.map((event) => ({
      eventId: event.event_id,
      sequence: event.sequence,
      schemaVersion: event.schema_version,
      eventJson: event.event_json,
      causationId: event.causation_id,
      occurredAt: event.occurred_at,
      createdAt: event.created_at,
    })),
    namedSnapshots: namedSnapshots.map((named) => ({
      name: named.name,
      schemaVersion: named.schema_version,
      formatEpoch: named.format_epoch,
      revision: named.revision,
      stateJson: named.state_json,
      eventPosition: named.event_position,
      stateChecksum: named.state_checksum,
      createdAt: named.created_at,
    })),
    filePreimages: filePreimages.map((entry) => ({
      path: entry.path,
      eventPosition: entry.event_position,
      content: entry.content,
      existed: entry.existed === 1,
      postHash: entry.post_hash,
      postExisted: entry.post_existed == null ? null : entry.post_existed === 1,
      createdAt: entry.created_at,
    })),
    effects: effects.map((effect) => ({
      effectId: effect.effect_id,
      ownerId: effect.owner_id,
      leaseRevision: effect.lease_revision,
      certainty: effect.certainty,
      expiresAtMs: effect.expires_at_ms,
    })),
    binding,
    contentDigest,
  };
}

function readSourceReceipts(database: Database): readonly SourceReceipt[] {
  const rows = database
    .query<
      {
        scope_session_id: string;
        command_id: string;
        request_digest: string;
        target_session_id: string;
        original_receipt_json: string;
        committed_revision: number;
        committed_at: number;
      },
      []
    >(
      'SELECT scope_session_id, command_id, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at FROM runtime_command_receipts ORDER BY scope_session_id, command_id',
    )
    .all();
  return rows.map((row) => {
    const receipt = {
      scopeSessionId: row.scope_session_id,
      commandId: row.command_id,
      requestDigest: row.request_digest,
      targetSessionId: row.target_session_id,
      originalReceiptJson: row.original_receipt_json,
      committedRevision: row.committed_revision,
      committedAt: row.committed_at,
    };
    if (
      !receipt.scopeSessionId ||
      !receipt.commandId ||
      !receipt.targetSessionId ||
      !/^[a-f0-9]{64}$/u.test(receipt.requestDigest) ||
      !Number.isSafeInteger(receipt.committedRevision) ||
      receipt.committedRevision < 0 ||
      !Number.isSafeInteger(receipt.committedAt) ||
      receipt.committedAt < 0 ||
      receipt.originalReceiptJson !==
        JSON.stringify({
          status: 'applied',
          commandId: receipt.commandId,
          sessionId: receipt.targetSessionId,
          revision: receipt.committedRevision,
        })
    ) {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'Source command receipt is invalid.',
      );
    }
    return receipt;
  });
}

function digestSourceContent(input: {
  readonly row: {
    readonly session_id: string;
    readonly project_id: string;
    readonly workspace_digest: string;
    readonly revision: number;
    readonly name: string;
    readonly model_provider: string | null;
    readonly model_name: string | null;
    readonly updated_at: number;
  };
  readonly snapshot: {
    readonly revision: number;
    readonly state_json: string;
    readonly event_position: number;
    readonly state_checksum: string;
    readonly created_at: number;
  };
  readonly events: readonly {
    readonly event_id: string;
    readonly sequence: number;
    readonly event_json: string;
    readonly causation_id: string | null;
    readonly occurred_at: string | null;
    readonly created_at: number;
  }[];
  readonly namedSnapshots: readonly {
    readonly name: string;
    readonly revision: number;
    readonly state_json: string;
    readonly event_position: number;
    readonly state_checksum: string;
    readonly created_at: number;
  }[];
  readonly filePreimages: readonly {
    readonly path: string;
    readonly event_position: number;
    readonly content: string | null;
    readonly existed: number;
    readonly post_hash: string | null;
    readonly post_existed: number | null;
    readonly created_at: number;
  }[];
  readonly effects: readonly {
    readonly effect_id: string;
    readonly owner_id: string;
    readonly lease_revision: number;
    readonly certainty: string;
    readonly expires_at_ms: number;
  }[];
}): string {
  return digestJson({
    session: {
      session_id: input.row.session_id,
      project_id: input.row.project_id,
      workspace_digest: input.row.workspace_digest,
      revision: input.row.revision,
      name: input.row.name,
      model_provider: input.row.model_provider,
      model_name: input.row.model_name,
      updated_at: input.row.updated_at,
    },
    snapshot: {
      revision: input.snapshot.revision,
      state_json: input.snapshot.state_json,
      event_position: input.snapshot.event_position,
      state_checksum: input.snapshot.state_checksum,
      created_at: input.snapshot.created_at,
    },
    events: input.events.map((event) => ({
      event_id: event.event_id,
      sequence: event.sequence,
      event_json: event.event_json,
      causation_id: event.causation_id,
      occurred_at: event.occurred_at,
      created_at: event.created_at,
    })),
    namedSnapshots: input.namedSnapshots.map((snapshot) => ({
      name: snapshot.name,
      revision: snapshot.revision,
      state_json: snapshot.state_json,
      event_position: snapshot.event_position,
      state_checksum: snapshot.state_checksum,
      created_at: snapshot.created_at,
    })),
    filePreimages: input.filePreimages,
    effects: input.effects,
  });
}

function createWorkspaceTarget(
  databasePath: string,
  binding: SqliteRuntimeMigrationWorkspaceBinding,
): Database {
  assertNoFollowDatabasePath(databasePath);
  assertSqliteRuntimeWorkspaceBinding(binding);
  const database = new Database(
    databasePath,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    chmodSync(databasePath, 0o600);
    database.run('PRAGMA journal_mode = delete');
    initializeSqliteRuntimeSchema(database, {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      workspaceBinding: binding,
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function copyWorkspaceSessions(
  database: Database,
  sessions: readonly SourceSessionMaterial[],
  receiptsByTarget: ReadonlyMap<string, readonly SourceReceipt[]>,
  recoveryMeta: readonly { readonly key: string; readonly value: string }[],
): void {
  database.run('BEGIN IMMEDIATE');
  try {
    for (const session of sessions) {
      database
        .query(
          'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, name, model_provider, model_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          session.session.sessionId,
          session.session.projectId,
          session.session.workspaceDigest,
          session.binding.workerScopeId,
          session.binding.workspaceIdentityDigest,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          session.session.revision,
          session.session.name,
          session.session.modelProvider,
          session.session.modelName,
          session.session.updatedAt,
        );
      for (const event of session.events) {
        database
          .query(
            'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            session.session.sessionId,
            event.eventId,
            event.sequence,
            event.schemaVersion,
            event.eventJson,
            event.causationId,
            event.occurredAt,
            event.createdAt,
          );
      }
      database
        .query(
          'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          session.session.sessionId,
          session.snapshot.schemaVersion,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          session.snapshot.revision,
          session.snapshot.stateJson,
          session.snapshot.eventPosition,
          session.snapshot.stateChecksum,
          session.snapshot.createdAt,
        );
      for (const named of session.namedSnapshots) {
        database
          .query(
            'INSERT INTO runtime_named_snapshots (session_id, name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            session.session.sessionId,
            named.name,
            named.schemaVersion,
            SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
            named.revision,
            named.stateJson,
            named.eventPosition,
            named.stateChecksum,
            named.createdAt,
          );
      }
      for (const file of session.filePreimages) {
        database
          .query(
            'INSERT INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            session.session.sessionId,
            file.path,
            file.eventPosition,
            file.content,
            file.existed ? 1 : 0,
            file.postHash,
            file.postExisted == null ? null : file.postExisted ? 1 : 0,
            file.createdAt,
          );
      }
      for (const effect of session.effects) {
        database
          .query(
            'INSERT INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            session.session.sessionId,
            effect.effectId,
            effect.ownerId,
            effect.leaseRevision,
            effect.certainty,
            effect.expiresAtMs,
          );
      }
      for (const receipt of receiptsByTarget.get(session.session.sessionId) ?? []) {
        database
          .query(
            'INSERT INTO runtime_command_receipts (scope_session_id, command_id, worker_scope_id, project_id, workspace_digest, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            receipt.scopeSessionId,
            receipt.commandId,
            session.binding.workerScopeId,
            session.binding.projectId,
            session.binding.workspaceDigest,
            receipt.requestDigest,
            receipt.targetSessionId,
            receipt.originalReceiptJson,
            receipt.committedRevision,
            receipt.committedAt,
          );
      }
      for (const meta of recoveryMetaForSession(recoveryMeta, session.session.sessionId)) {
        database
          .query('INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES (?, ?)')
          .run(meta.key, meta.value);
      }
    }
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // SQLite may already have rolled back after a constraint failure.
    }
    throw error;
  }
}

function recoveryMetaForSession(
  entries: readonly { readonly key: string; readonly value: string }[],
  sessionId: string,
): readonly { readonly key: string; readonly value: string }[] {
  const encoded = Buffer.from(sessionId, 'utf8').toString('hex');
  return entries.filter((entry) => entry.key === `recovery_identity_v1:${encoded}`);
}

function readTargetSessionDigest(database: Database, sessionId: string): string {
  const session = database
    .query<
      {
        session_id: string;
        project_id: string;
        workspace_digest: string;
        revision: number;
        name: string;
        model_provider: string | null;
        model_name: string | null;
        updated_at: number;
      },
      [string]
    >(
      'SELECT session_id, project_id, workspace_digest, revision, name, model_provider, model_name, updated_at FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    )
    .get(sessionId);
  const snapshot = database
    .query<
      {
        revision: number;
        state_json: string;
        event_position: number;
        state_checksum: string;
        created_at: number;
      },
      [string]
    >(
      'SELECT revision, state_json, event_position, state_checksum, created_at FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
    )
    .get(sessionId);
  const events = database
    .query<
      {
        event_id: string;
        sequence: number;
        event_json: string;
        causation_id: string | null;
        occurred_at: string | null;
        created_at: number;
      },
      [string]
    >(
      'SELECT event_id, sequence, event_json, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence',
    )
    .all(sessionId);
  const namedSnapshots = database
    .query<
      {
        name: string;
        revision: number;
        state_json: string;
        event_position: number;
        state_checksum: string;
        created_at: number;
      },
      [string]
    >(
      'SELECT name, revision, state_json, event_position, state_checksum, created_at FROM runtime_named_snapshots WHERE session_id = ? ORDER BY event_position, name',
    )
    .all(sessionId);
  const filePreimages = database
    .query<
      {
        path: string;
        event_position: number;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
        created_at: number;
      },
      [string]
    >(
      'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE session_id = ? ORDER BY event_position, path',
    )
    .all(sessionId);
  const effects = database
    .query<
      {
        effect_id: string;
        owner_id: string;
        lease_revision: number;
        certainty: string;
        expires_at_ms: number;
      },
      [string]
    >(
      'SELECT effect_id, owner_id, lease_revision, certainty, expires_at_ms FROM runtime_effect_leases WHERE session_id = ? ORDER BY effect_id',
    )
    .all(sessionId);
  return digestJson({
    session,
    snapshot,
    events,
    namedSnapshots,
    filePreimages,
    effects,
  });
}

async function buildCatalog(
  builder: SqliteRuntimeMigrationCatalogBuilder,
  catalogPath: string,
  targetLayoutGeneration: string,
  sessions: readonly SourceSessionMaterial[],
): Promise<string> {
  const ordered = [...sessions].sort((left, right) =>
    left.session.sessionId.localeCompare(right.session.sessionId),
  );
  const metadata: SqliteRuntimeMigrationCatalogSession[] = ordered.map((session, index) => ({
    sessionId: session.session.sessionId,
    workerScopeId: session.binding.workerScopeId,
    directoryRevision: String(index + 1),
    updatedAt: new Date(session.session.updatedAt * 1_000).toISOString(),
    tombstone: false,
  }));
  const returnedDigest = await builder.build({
    catalogPath,
    layoutGeneration: targetLayoutGeneration,
    sessions: metadata,
  });
  if (!/^[a-f0-9]{64}$/u.test(returnedDigest)) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'target_invalid',
      'Coordinator Catalog builder returned an invalid digest.',
    );
  }
  const actualDigest = sqliteRuntimeStoreDigest(catalogPath);
  if (actualDigest !== returnedDigest) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'target_invalid',
      'Coordinator Catalog builder digest does not match its target file.',
    );
  }
  return actualDigest;
}

function readTargetReceiptDigest(database: Database, sessionId: string): string {
  const rows = database
    .query<
      {
        scope_session_id: string;
        command_id: string;
        request_digest: string;
        target_session_id: string;
        original_receipt_json: string;
        committed_revision: number;
        committed_at: number;
      },
      [string]
    >(
      'SELECT scope_session_id, command_id, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at FROM runtime_command_receipts WHERE target_session_id = ? ORDER BY scope_session_id, command_id',
    )
    .all(sessionId);
  return digestReceipts(
    rows.map((row) => ({
      scopeSessionId: row.scope_session_id,
      commandId: row.command_id,
      requestDigest: row.request_digest,
      targetSessionId: row.target_session_id,
      originalReceiptJson: row.original_receipt_json,
      committedRevision: row.committed_revision,
      committedAt: row.committed_at,
    })),
  );
}

function digestReceipts(receipts: readonly SourceReceipt[]): string {
  return digestJson(
    [...receipts]
      .sort((left, right) =>
        `${left.scopeSessionId}\0${left.commandId}`.localeCompare(
          `${right.scopeSessionId}\0${right.commandId}`,
        ),
      )
      .map((receipt) => ({
        scopeSessionId: receipt.scopeSessionId,
        commandId: receipt.commandId,
        requestDigest: receipt.requestDigest,
        targetSessionId: receipt.targetSessionId,
        originalReceiptJson: receipt.originalReceiptJson,
        committedRevision: receipt.committedRevision,
        committedAt: receipt.committedAt,
      })),
  );
}

function assertMigrationBinding(
  binding: SqliteRuntimeMigrationWorkspaceBinding,
  targetLayoutGeneration: string,
  identity: SqliteRuntimeMigrationSessionIdentity,
): void {
  try {
    assertSqliteRuntimeWorkspaceBinding(binding);
  } catch {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'unowned_session',
      'Workspace binding is invalid.',
    );
  }
  if (
    binding.layoutGeneration !== targetLayoutGeneration ||
    binding.projectId !== identity.projectId ||
    binding.workspaceDigest !== identity.workspaceDigest
  ) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'unowned_session',
      'Workspace binding does not match persisted identity.',
    );
  }
}

function sameWorkspaceBinding(
  left: SqliteRuntimeMigrationWorkspaceBinding,
  right: SqliteRuntimeMigrationWorkspaceBinding,
): boolean {
  return (
    left.layoutGeneration === right.layoutGeneration &&
    left.workerScopeId === right.workerScopeId &&
    left.workspaceIdentityDigest === right.workspaceIdentityDigest &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function initialJournal(
  options: SqliteRuntimeWorkspaceMigrationOptions,
): SqliteRuntimeMigrationJournal {
  return {
    schema: 'kite.runtime-migration-journal.v1',
    sourceStoreIdentity: options.sourceGuard.sourceStoreIdentity,
    sourceStoreDigest: options.sourceGuard.sourceStoreDigest,
    sourceProfile: SOURCE_PROFILE,
    targetLayoutGeneration: options.targetLayoutGeneration,
    targetCatalogDigest: '0'.repeat(64),
    workspaceStoreDigests: [],
    pointerPhase: 'source_active',
    targetWriteState: 'none',
    migrationNonce: options.sourceGuard.fence.migrationNonce,
  };
}

function writeMigrationJournal(
  layout: SqliteRuntimeLayoutPaths,
  journal: SqliteRuntimeMigrationJournal,
): void {
  writeSqliteRuntimeMigrationJournal(layout, journal);
}

function blocked(
  reason: Extract<SqliteRuntimeWorkspaceMigrationResult, { status: 'blocked' }>['reason'],
): SqliteRuntimeWorkspaceMigrationResult {
  return { status: 'blocked', reason };
}

function blockedWithJournal(
  reason: Extract<SqliteRuntimeWorkspaceMigrationResult, { status: 'blocked' }>['reason'],
  layout: SqliteRuntimeLayoutPaths,
  journal: SqliteRuntimeMigrationJournal | undefined,
): SqliteRuntimeWorkspaceMigrationResult {
  if (!journal) return blocked(reason);
  const blockedJournal: SqliteRuntimeMigrationJournal = {
    ...journal,
    pointerPhase: 'blocked',
  };
  try {
    writeMigrationJournal(layout, blockedJournal);
  } catch {
    // Preserve the original blocked result; an absent journal is itself a recovery blocker.
  }
  return { status: 'blocked', reason, journal: blockedJournal };
}

function sameFence(left: SqliteRuntimeMigrationFence, right: SqliteRuntimeMigrationFence): boolean {
  return (
    left.sourceStoreIdentity === right.sourceStoreIdentity &&
    left.sourceStoreDigest === right.sourceStoreDigest &&
    left.targetLayoutGeneration === right.targetLayoutGeneration &&
    left.migrationNonce === right.migrationNonce &&
    left.state === right.state &&
    JSON.stringify(left.sourceProfile) === JSON.stringify(right.sourceProfile)
  );
}

function sameProfile(
  left: {
    readonly stateSchemaVersion: number;
    readonly storeSchemaVersion: number;
    readonly formatEpoch: string;
  },
  right: {
    readonly stateSchemaVersion: number;
    readonly storeSchemaVersion: number;
    readonly formatEpoch: string;
  },
): boolean {
  return (
    left.stateSchemaVersion === right.stateSchemaVersion &&
    left.storeSchemaVersion === right.storeSchemaVersion &&
    left.formatEpoch === right.formatEpoch
  );
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && !value.includes('\0'));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function sqliteRuntimeStoreDigest(path: string): string {
  assertNoFollowDatabasePath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SqliteRuntimeWorkspaceMigrationError(
      'source_corrupt',
      'SQLite store is not a regular file.',
    );
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sqliteRuntimeStoreFingerprint(path: string): string {
  assertNoFollowDatabasePath(path);
  const stat = statSync(path);
  const real = realpathSync(path);
  const sidecar = (suffix: string): string => {
    const side = `${path}${suffix}`;
    if (!existsSync(side)) return 'missing';
    const sideStat = lstatSync(side);
    if (sideStat.isSymbolicLink()) {
      throw new SqliteRuntimeWorkspaceMigrationError(
        'source_corrupt',
        'SQLite sidecar is a symlink.',
      );
    }
    return `${sideStat.dev}:${sideStat.ino}:${sideStat.size}:${sideStat.mtimeMs}`;
  };
  return `${real}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}|wal=${sidecar('-wal')}|shm=${sidecar('-shm')}`;
}
