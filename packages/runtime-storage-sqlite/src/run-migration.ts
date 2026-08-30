import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeSnapshotCodec } from '@kite-ai/runtime-host/storage';
import { inspectSqliteWorkspaceAuthorityGenerationCopy } from './authority';
import {
  createSqliteRuntimeLayoutCutover,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  readSqliteRuntimeMigrationFence,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteWorkspaceStorePath,
  type SqliteRuntimeLayoutManifest,
  type SqliteRuntimeLayoutPaths,
  type SqliteRuntimeMigrationFence,
  type SqliteRuntimeMigrationJournal,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from './layout';
import {
  assertNoFollowDatabasePath,
  assertSqliteRuntimeStorageTargetCanOpen_,
  assertSqliteRuntimeWorkspaceBinding,
  assertWorkspaceSqliteRuntimeStoreConnection,
  checksum,
  openSqliteReadonlySnapshotView,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';
import { assertSqliteRuntimeRunStoreConnection } from './run-store';
import { initializeSqliteRuntimeSchema } from './schema';

const SOURCE_PROFILE = Object.freeze({
  stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
});

const TARGET_PROFILE = Object.freeze({
  stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
});

export interface SqliteRuntimeRunMigrationMaintenanceBarrier {
  readonly coordinatorStopped: true;
  readonly workspaceWorkersStopped: true;
  readonly gatewayStopped: true;
  readonly activeTurns: 0;
  readonly pendingInteractions: 0;
  readonly activeEffects: 0;
  readonly externalProcesses: 0;
}

export interface SqliteRuntimeRunMigrationSourceEvidence {
  readonly sourceLayoutGeneration: string;
  readonly sourceStoreIdentity: string;
  readonly sourceStoreDigest: string;
  readonly sourceProfile: typeof SOURCE_PROFILE;
}

export interface SqliteRuntimeRunMigrationSourceGuard
  extends SqliteRuntimeRunMigrationSourceEvidence {
  readonly maintenanceBarrier: SqliteRuntimeRunMigrationMaintenanceBarrier;
  readonly fence: SqliteRuntimeMigrationFence;
}

export interface SqliteRuntimeRunMigrationCatalogPort {
  copy(input: {
    readonly sourceCatalogPath: string;
    readonly targetCatalogPath: string;
    readonly sourceLayoutGeneration: string;
    readonly targetLayoutGeneration: string;
    readonly expectedWorkerScopeIds: readonly string[];
  }): string | Promise<string>;
}

export interface SqliteRuntimeRunMigrationOptions<Event = unknown, State = unknown> {
  readonly layout: SqliteRuntimeLayoutPaths;
  readonly targetLayoutGeneration: string;
  readonly sourceGuard: SqliteRuntimeRunMigrationSourceGuard;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>;
  readonly isSessionSettled: (state: Readonly<State>) => boolean;
  readonly catalog: SqliteRuntimeRunMigrationCatalogPort;
  /** Test-only fault injection after a complete Workspace copy, before pointer switch. */
  readonly faultAfterWorkspaceCopies?: number;
}

export type SqliteRuntimeRunMigrationBlockedReason =
  | 'maintenance_required'
  | 'missing_fence'
  | 'source_changed'
  | 'source_corrupt'
  | 'active_work'
  | 'unowned_workspace'
  | 'partial_workspace'
  | 'copy_interrupted'
  | 'target_invalid'
  | 'layout_invalid';

export type SqliteRuntimeRunMigrationResult =
  | {
      readonly status: 'committed';
      readonly sourceLayoutGeneration: string;
      readonly targetLayoutGeneration: string;
      readonly catalogDigest: string;
      readonly workspaceStoreDigests: readonly {
        readonly workerScopeId: string;
        readonly digest: string;
      }[];
    }
  | {
      readonly status: 'blocked';
      readonly reason: SqliteRuntimeRunMigrationBlockedReason;
      readonly journal?: SqliteRuntimeMigrationJournal;
    };

export class SqliteRuntimeRunMigrationError extends Error {
  readonly code = 'run_migration_blocked' as const;
  readonly reason: SqliteRuntimeRunMigrationBlockedReason;

  constructor(reason: SqliteRuntimeRunMigrationBlockedReason, message: string) {
    super(message);
    this.name = 'SqliteRuntimeRunMigrationError';
    this.reason = reason;
  }
}

interface WorkspaceSource {
  readonly workerScopeId: string;
  readonly databasePath: string;
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly identity: string;
  readonly digest: string;
}

interface SourceLayout {
  readonly evidence: SqliteRuntimeRunMigrationSourceEvidence;
  readonly manifest: SqliteRuntimeLayoutManifest;
  readonly catalogPath: string;
  readonly catalogIdentity: string;
  readonly catalogDigest: string;
  readonly workspaces: readonly WorkspaceSource[];
}

/** Read-only source evidence used to construct the exact migration fence. */
export function inspectSqliteRuntimeRunMigrationSource(
  layout: SqliteRuntimeLayoutPaths,
): SqliteRuntimeRunMigrationSourceEvidence {
  return readSourceLayout(layout).evidence;
}

/** Offline, all-or-nothing Store 7 generation to Store 8 generation conversion. */
export async function migrateSqliteRuntimeLayoutToRunStore<Event = unknown, State = unknown>(
  options: SqliteRuntimeRunMigrationOptions<Event, State>,
): Promise<SqliteRuntimeRunMigrationResult> {
  let journal: SqliteRuntimeMigrationJournal | undefined;
  let switched = false;
  try {
    ensureSqliteRuntimeLayoutRoot(options.layout.root);
    if (!isClosedMaintenanceBarrier(options.sourceGuard.maintenanceBarrier)) {
      return { status: 'blocked', reason: 'maintenance_required' };
    }
    assertGeneration(options.targetLayoutGeneration);
    const source = readSourceLayout(options.layout);
    if (!sameEvidence(source.evidence, options.sourceGuard)) {
      return { status: 'blocked', reason: 'source_changed' };
    }
    if (
      options.targetLayoutGeneration === source.evidence.sourceLayoutGeneration ||
      !sameProfile(options.sourceGuard.fence.sourceProfile, SOURCE_PROFILE) ||
      options.sourceGuard.fence.sourceStoreIdentity !== source.evidence.sourceStoreIdentity ||
      options.sourceGuard.fence.sourceStoreDigest !== source.evidence.sourceStoreDigest ||
      options.sourceGuard.fence.targetLayoutGeneration !== options.targetLayoutGeneration ||
      options.sourceGuard.fence.state !== 'active'
    ) {
      return { status: 'blocked', reason: 'missing_fence' };
    }
    assertFreshTargetGeneration(options.layout, options.targetLayoutGeneration);

    journal = {
      schema: 'kite.runtime-migration-journal.v1',
      sourceStoreIdentity: source.evidence.sourceStoreIdentity,
      sourceStoreDigest: source.evidence.sourceStoreDigest,
      sourceProfile: SOURCE_PROFILE,
      targetLayoutGeneration: options.targetLayoutGeneration,
      targetCatalogDigest: '0'.repeat(64),
      workspaceStoreDigests: [],
      pointerPhase: 'source_active',
      targetWriteState: 'none',
      migrationNonce: options.sourceGuard.fence.migrationNonce,
    };
    writeSqliteRuntimeMigrationFence(options.layout, options.sourceGuard.fence);
    writeSqliteRuntimeMigrationJournal(options.layout, journal);
    ensureSqliteRuntimeGenerationRoot(options.layout, options.targetLayoutGeneration);

    const targetCatalogPath = resolveSqliteCatalogPath(
      options.layout,
      options.targetLayoutGeneration,
    );
    const catalogDigest = await options.catalog.copy({
      sourceCatalogPath: source.catalogPath,
      targetCatalogPath,
      sourceLayoutGeneration: source.evidence.sourceLayoutGeneration,
      targetLayoutGeneration: options.targetLayoutGeneration,
      expectedWorkerScopeIds: source.workspaces.map((workspace) => workspace.workerScopeId),
    });
    assertTargetFile(targetCatalogPath, catalogDigest, 'Coordinator Catalog');

    const workspaceStoreDigests: { readonly workerScopeId: string; readonly digest: string }[] = [];
    let copied = 0;
    for (const workspace of source.workspaces) {
      assertWorkspaceSourceDeep(workspace, options.codec, options.isSessionSettled);
      const targetBinding: SqliteRuntimeWorkspaceBinding = {
        ...workspace.binding,
        layoutGeneration: options.targetLayoutGeneration,
      };
      const targetPath = ensureSqliteWorkspaceStoreDirectory(
        options.layout,
        options.targetLayoutGeneration,
        workspace.workerScopeId,
      );
      copyWorkspaceStore(workspace, targetPath, targetBinding);
      assertTargetWorkspaceDeep(targetPath, targetBinding, options.codec);
      workspaceStoreDigests.push({
        workerScopeId: workspace.workerScopeId,
        digest: digestFile(targetPath),
      });
      copied += 1;
      if (
        options.faultAfterWorkspaceCopies !== undefined &&
        copied >= options.faultAfterWorkspaceCopies
      ) {
        throw new SqliteRuntimeRunMigrationError(
          'copy_interrupted',
          'Store 8 generation copy was interrupted before pointer switch.',
        );
      }
    }

    assertSourceUnchanged(options.layout, source);
    const orderedDigests = workspaceStoreDigests.sort((left, right) =>
      left.workerScopeId.localeCompare(right.workerScopeId),
    );
    const targetJournal: SqliteRuntimeMigrationJournal = {
      ...journal,
      targetCatalogDigest: catalogDigest,
      workspaceStoreDigests: orderedDigests,
    };
    writeSqliteRuntimeMigrationJournal(options.layout, targetJournal);
    journal = targetJournal;
    const manifest: SqliteRuntimeLayoutManifest = {
      schema: 'kite.runtime-layout-manifest.v1',
      generation: options.targetLayoutGeneration,
      profile: TARGET_PROFILE,
      catalogDigest,
      workspaceStores: orderedDigests,
    };
    const cutover = createSqliteRuntimeLayoutCutover(options.layout);
    cutover.prepareTarget(manifest, targetJournal, options.sourceGuard.fence);
    cutover.switchPointer();
    switched = true;
    cutover.markTargetReady();
    cutover.commit();
    return {
      status: 'committed',
      sourceLayoutGeneration: source.evidence.sourceLayoutGeneration,
      targetLayoutGeneration: options.targetLayoutGeneration,
      catalogDigest,
      workspaceStoreDigests: orderedDigests,
    };
  } catch (error) {
    if (switched) throw error;
    if (error instanceof SqliteRuntimeRunMigrationError) {
      return blockedWithJournal(error.reason, options.layout, journal);
    }
    return blockedWithJournal('target_invalid', options.layout, journal);
  }
}

function readSourceLayout(layout: SqliteRuntimeLayoutPaths): SourceLayout {
  try {
    const pointer = readSqliteActiveLayoutPointer(layout);
    if (!pointer) throw new Error('active pointer missing');
    const manifest = readSqliteRuntimeLayoutManifest(layout, pointer.generation);
    const journal = readSqliteRuntimeMigrationJournal(layout);
    const fence = readSqliteRuntimeMigrationFence(layout);
    if (
      !manifest ||
      manifest.profile.storeSchemaVersion !== SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION ||
      manifest.profile.stateSchemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      manifest.profile.formatEpoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
      !journal ||
      journal.pointerPhase !== 'committed' ||
      journal.targetLayoutGeneration !== pointer.generation ||
      !fence ||
      fence.targetLayoutGeneration !== pointer.generation ||
      fence.migrationNonce !== journal.migrationNonce ||
      manifest.catalogDigest !== journal.targetCatalogDigest ||
      JSON.stringify(manifest.workspaceStores) !== JSON.stringify(journal.workspaceStoreDigests)
    ) {
      throw new Error('source layout evidence invalid');
    }
    const catalogPath = resolveSqliteCatalogPath(layout, pointer.generation);
    assertPrivateSourceFile(catalogPath, 'Coordinator Catalog');
    if (journal.targetWriteState === 'none' && digestFile(catalogPath) !== manifest.catalogDigest) {
      throw new Error('source Catalog digest drift');
    }
    const catalogIdentity = fingerprintFile(catalogPath);
    const catalogDigest = digestSnapshot(catalogPath);
    const workspaces = manifest.workspaceStores.map((entry) => {
      const databasePath = resolveSqliteWorkspaceStorePath(
        layout,
        pointer.generation,
        entry.workerScopeId,
      );
      assertPrivateSourceFile(databasePath, 'Workspace Store');
      if (journal.targetWriteState === 'none' && digestFile(databasePath) !== entry.digest) {
        throw new Error('source Workspace digest drift');
      }
      const view = openSqliteReadonlySnapshotView(databasePath);
      try {
        const binding = bindingFromSource(view.database, pointer.generation, entry.workerScopeId);
        assertWorkspaceSqliteRuntimeStoreConnection(view.database, binding);
        return {
          workerScopeId: entry.workerScopeId,
          databasePath,
          binding,
          identity: fingerprintFile(databasePath),
          digest: digestDatabase(view.database),
        };
      } finally {
        view.close();
      }
    });
    assertExactWorkspaceDirectories(layout, pointer.generation, workspaces);
    const ordered = [...workspaces].sort((left, right) =>
      left.workerScopeId.localeCompare(right.workerScopeId),
    );
    const sourceStoreIdentity = hashJson({
      generation: pointer.generation,
      catalog: catalogIdentity,
      workspaces: ordered.map((workspace) => ({
        workerScopeId: workspace.workerScopeId,
        identity: workspace.identity,
      })),
    });
    const sourceStoreDigest = hashJson({
      generation: pointer.generation,
      catalog: catalogDigest,
      workspaces: ordered.map((workspace) => ({
        workerScopeId: workspace.workerScopeId,
        digest: workspace.digest,
      })),
    });
    return {
      evidence: {
        sourceLayoutGeneration: pointer.generation,
        sourceStoreIdentity,
        sourceStoreDigest,
        sourceProfile: SOURCE_PROFILE,
      },
      manifest,
      catalogPath,
      catalogIdentity,
      catalogDigest,
      workspaces: ordered,
    };
  } catch (error) {
    if (error instanceof SqliteRuntimeRunMigrationError) throw error;
    throw new SqliteRuntimeRunMigrationError(
      'source_corrupt',
      'Store 7 source generation is corrupt, partial, or unknown.',
    );
  }
}

function bindingFromSource(
  database: Database,
  layoutGeneration: string,
  workerScopeId: string,
): SqliteRuntimeWorkspaceBinding {
  const rows = database
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key IN ('layout_generation', 'worker_scope_id', 'workspace_identity_digest')",
    )
    .all();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const binding = {
    layoutGeneration,
    workerScopeId,
    workspaceIdentityDigest: values.get('workspace_identity_digest') ?? '',
  };
  if (
    values.get('layout_generation') !== layoutGeneration ||
    values.get('worker_scope_id') !== workerScopeId
  ) {
    throw new SqliteRuntimeRunMigrationError(
      'unowned_workspace',
      'Workspace Store header does not match its source generation.',
    );
  }
  assertSqliteRuntimeWorkspaceBinding(binding);
  return binding;
}

function assertWorkspaceSourceDeep<Event, State>(
  workspace: WorkspaceSource,
  codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>,
  isSessionSettled: (state: Readonly<State>) => boolean,
): void {
  const view = openSqliteReadonlySnapshotView(workspace.databasePath);
  try {
    assertWorkspaceSqliteRuntimeStoreConnection(view.database, workspace.binding);
    const authority = (() => {
      try {
        return inspectSqliteWorkspaceAuthorityGenerationCopy({
          db: view.database,
          sourceBinding: workspace.binding,
          targetBinding: workspace.binding,
        });
      } catch {
        sourceCorrupt('Workspace authority metadata is invalid.');
      }
    })();
    try {
      assertRecoveryIdentityMetadata(view.database);
    } catch {
      sourceCorrupt('Workspace recovery identity metadata is invalid.');
    }
    if (!authority.settled) {
      throw new SqliteRuntimeRunMigrationError(
        'active_work',
        'Workspace authority metadata has not converged for offline migration.',
      );
    }
    const activeEffects = view.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_effect_leases')
      .get()?.count;
    if (activeEffects !== 0) {
      throw new SqliteRuntimeRunMigrationError(
        'active_work',
        'Workspace Store retains an active effect lease.',
      );
    }
    const sessions = view.database
      .query<
        {
          session_id: string;
          project_id: string;
          workspace_digest: string;
          revision: number;
        },
        []
      >('SELECT session_id, project_id, workspace_digest, revision FROM runtime_sessions')
      .all();
    for (const session of sessions) {
      const events = view.database
        .query<{ sequence: number; schema_version: number; event_json: string }, [string]>(
          'SELECT sequence, schema_version, event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(session.session_id);
      if (events.length !== session.revision) sourceCorrupt('Session event count is invalid.');
      for (const [index, event] of events.entries()) {
        if (
          event.sequence !== index + 1 ||
          event.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION
        ) {
          sourceCorrupt('Session event sequence is invalid.');
        }
        try {
          codec.decodeEvent(event.event_json);
        } catch {
          sourceCorrupt('Session event body is invalid.');
        }
      }
      const snapshot = view.database
        .query<
          {
            schema_version: number;
            format_epoch: string;
            revision: number;
            state_json: string;
            event_position: number;
            state_checksum: string;
          },
          [string]
        >(
          'SELECT schema_version, format_epoch, revision, state_json, event_position, state_checksum FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
        )
        .get(session.session_id);
      if (
        !snapshot ||
        snapshot.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        snapshot.format_epoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
        snapshot.revision !== session.revision ||
        snapshot.event_position !== session.revision ||
        checksum(snapshot.state_json) !== snapshot.state_checksum
      ) {
        sourceCorrupt('Session snapshot is invalid.');
      }
      let state: State;
      try {
        state = codec.decodeState<State>(snapshot.state_json);
        const metadata = codec.snapshotMetadata(state);
        const identity = codec.sessionIdentity?.(state);
        if (
          metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
          metadata.stateRevision !== session.revision ||
          !identity ||
          identity.projectId !== session.project_id ||
          identity.canonicalWorkspaceDigest !== session.workspace_digest
        ) {
          throw new Error('State identity drift');
        }
        codec.validateSnapshot?.({
          state,
          sessionId: session.session_id,
          eventPosition: snapshot.event_position,
          stateRevision: snapshot.revision,
          schemaVersion: snapshot.schema_version,
          eventRevision: session.revision,
        });
      } catch {
        sourceCorrupt('Session State is invalid.');
      }
      let settled = false;
      try {
        settled = isSessionSettled(state);
      } catch {
        // A missing or unrecognized convergence fact is active-work uncertainty.
      }
      if (!settled) {
        throw new SqliteRuntimeRunMigrationError(
          'active_work',
          'Session has active Turn, Interaction, effect, or external process authority.',
        );
      }
      const named = view.database
        .query<
          {
            schema_version: number;
            format_epoch: string;
            revision: number;
            state_json: string;
            event_position: number;
            state_checksum: string;
          },
          [string]
        >(
          'SELECT schema_version, format_epoch, revision, state_json, event_position, state_checksum FROM runtime_named_snapshots WHERE session_id = ?',
        )
        .all(session.session_id);
      for (const entry of named) {
        if (
          entry.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
          entry.format_epoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
          entry.revision !== entry.event_position ||
          entry.revision > session.revision ||
          checksum(entry.state_json) !== entry.state_checksum
        ) {
          sourceCorrupt('Named snapshot is invalid.');
        }
        try {
          const namedState = codec.decodeState<State>(entry.state_json);
          const metadata = codec.snapshotMetadata(namedState);
          const identity = codec.sessionIdentity?.(namedState);
          if (
            metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
            metadata.stateRevision !== entry.revision ||
            !identity ||
            identity.projectId !== session.project_id ||
            identity.canonicalWorkspaceDigest !== session.workspace_digest
          ) {
            throw new Error('Named State identity drift');
          }
        } catch {
          sourceCorrupt('Named snapshot State is invalid.');
        }
      }
    }
    if (digestDatabase(view.database) !== workspace.digest) {
      throw new SqliteRuntimeRunMigrationError(
        'source_changed',
        'Workspace Store changed during source validation.',
      );
    }
  } finally {
    view.close();
  }
}

function copyWorkspaceStore(
  source: WorkspaceSource,
  targetPath: string,
  targetBinding: SqliteRuntimeWorkspaceBinding,
): void {
  assertTargetAbsent(targetPath);
  const sourceView = openSqliteReadonlySnapshotView(source.databasePath);
  const target = new Database(
    targetPath,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    chmodSync(targetPath, 0o600);
    target.run('PRAGMA journal_mode = DELETE');
    initializeSqliteRuntimeSchema(target, {
      ...TARGET_PROFILE,
      workspaceBinding: targetBinding,
    });
    target.run('BEGIN IMMEDIATE');
    try {
      copyWorkspaceRows(sourceView.database, target, source.binding, targetBinding);
      target.run('COMMIT');
    } catch (error) {
      try {
        target.run('ROLLBACK');
      } catch {
        // SQLite may already have rolled back a failed statement.
      }
      throw error;
    }
    assertSqliteRuntimeRunStoreConnection(target, targetBinding);
    if (
      digestLogicalWorkspace(sourceView.database, false, targetBinding.layoutGeneration) !==
      digestLogicalWorkspace(target, true, targetBinding.layoutGeneration)
    ) {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        'Store 8 logical Workspace facts do not match Store 7 source facts.',
      );
    }
    target.run('PRAGMA journal_mode = DELETE');
    target.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    target.close(false);
    sourceView.close();
  }
  assertPrivateTargetFile(targetPath, 'Workspace Store');
}

function copyWorkspaceRows(
  source: Database,
  target: Database,
  sourceBinding: SqliteRuntimeWorkspaceBinding,
  targetBinding: SqliteRuntimeWorkspaceBinding,
): void {
  const authorityRows = new Map(
    inspectSqliteWorkspaceAuthorityGenerationCopy({
      db: source,
      sourceBinding,
      targetBinding,
    }).rows.map((row) => [row.key, row.value]),
  );
  const insertMeta = target.query(
    'INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES (?, ?)',
  );
  for (const row of source
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key NOT IN ('format_version', 'runtime_format_epoch', 'layout_generation', 'worker_scope_id', 'workspace_identity_digest') ORDER BY key",
    )
    .iterate()) {
    insertMeta.run(row.key, authorityRows.get(row.key) ?? row.value);
  }

  copyMappedRows(
    source,
    target,
    'SELECT session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, revision, name, model_provider, model_name, updated_at FROM runtime_sessions ORDER BY session_id',
    `INSERT INTO runtime_sessions (
      session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest,
      state_schema, format_epoch, revision, name, model_provider, model_name, updated_at,
      run_index_from_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    (row) => [
      row[0],
      row[1],
      row[2],
      targetBinding.workerScopeId,
      targetBinding.workspaceIdentityDigest,
      row[5],
      SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      row[6],
      row[7],
      row[8],
      row[9],
      row[10],
      row[6],
    ],
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at FROM runtime_events ORDER BY session_id, sequence',
    'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, schema_version, revision, state_json, event_position, state_checksum, created_at FROM runtime_snapshots ORDER BY session_id',
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    (row) => [row[0], row[1], SQLITE_RUNTIME_RUN_FORMAT_EPOCH, ...row.slice(2)],
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, name, schema_version, revision, state_json, event_position, state_checksum, created_at FROM runtime_named_snapshots ORDER BY session_id, event_position, name',
    'INSERT INTO runtime_named_snapshots (session_id, name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (row) => [row[0], row[1], row[2], SQLITE_RUNTIME_RUN_FORMAT_EPOCH, ...row.slice(3)],
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages ORDER BY session_id, event_position, path',
    'INSERT INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms FROM runtime_effect_leases ORDER BY session_id, effect_id',
    'INSERT INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
  );
  copyMappedRows(
    source,
    target,
    'SELECT scope_session_id, command_id, worker_scope_id, project_id, workspace_digest, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at FROM runtime_command_receipts ORDER BY scope_session_id, command_id',
    `INSERT INTO runtime_command_receipts (
      scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
      request_digest, target_session_id, original_receipt_json, committed_revision, committed_at,
      result_schema, result_json, result_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at FROM session_workspace_tombstone ORDER BY session_id',
    'INSERT INTO session_workspace_tombstone (session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  copyMappedRows(
    source,
    target,
    'SELECT session_id, worker_scope_id, revision, updated_at, tombstone FROM session_directory_outbox ORDER BY rowid',
    'INSERT INTO session_directory_outbox (session_id, worker_scope_id, revision, updated_at, tombstone) VALUES (?, ?, ?, ?, ?)',
  );
}

function copyMappedRows(
  source: Database,
  target: Database,
  selectSql: string,
  insertSql: string,
  map: (row: readonly unknown[]) => readonly unknown[] = (row) => row,
): void {
  const insert = target.query<void, SqliteBinding[]>(insertSql);
  for (const record of source.query<Record<string, SqliteBinding>, []>(selectSql).iterate()) {
    const row = Object.values(record);
    insert.run(...map(row).map(sqliteBinding));
  }
}

type SqliteBinding = string | number | bigint | boolean | Uint8Array | null;

function sqliteBinding(value: unknown): SqliteBinding {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new SqliteRuntimeRunMigrationError(
    'source_corrupt',
    'Source Workspace contains an unsupported SQLite value.',
  );
}

function digestLogicalWorkspace(
  database: Database,
  target: boolean,
  targetLayoutGeneration: string,
): string {
  const hash = createHash('sha256');
  const sourceBinding = bindingFromDatabase(database);
  const authorityRows = new Map(
    inspectSqliteWorkspaceAuthorityGenerationCopy({
      db: database,
      sourceBinding,
      targetBinding: { ...sourceBinding, layoutGeneration: targetLayoutGeneration },
    }).rows.map((row) => [row.key, row.value]),
  );
  const queries = [
    "SELECT key, value FROM runtime_store_meta WHERE key NOT IN ('format_version', 'runtime_format_epoch', 'layout_generation', 'worker_scope_id', 'workspace_identity_digest') ORDER BY key",
    target
      ? 'SELECT session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, revision, name, model_provider, model_name, updated_at FROM runtime_sessions ORDER BY session_id'
      : 'SELECT session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, revision, name, model_provider, model_name, updated_at FROM runtime_sessions ORDER BY session_id',
    'SELECT session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at FROM runtime_events ORDER BY session_id, sequence',
    'SELECT session_id, schema_version, revision, state_json, event_position, state_checksum, created_at FROM runtime_snapshots ORDER BY session_id',
    'SELECT session_id, name, schema_version, revision, state_json, event_position, state_checksum, created_at FROM runtime_named_snapshots ORDER BY session_id, event_position, name',
    'SELECT session_id, path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages ORDER BY session_id, event_position, path',
    'SELECT session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms FROM runtime_effect_leases ORDER BY session_id, effect_id',
    'SELECT scope_session_id, command_id, worker_scope_id, project_id, workspace_digest, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at FROM runtime_command_receipts ORDER BY scope_session_id, command_id',
    'SELECT session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at FROM session_workspace_tombstone ORDER BY session_id',
    'SELECT session_id, worker_scope_id, revision, updated_at, tombstone FROM session_directory_outbox ORDER BY rowid',
  ];
  for (const [index, query] of queries.entries()) {
    hash.update(`table:${index}\0`);
    for (const record of database.query<Record<string, SqliteBinding>, []>(query).iterate()) {
      const row = Object.values(record);
      if (index === 0 && typeof row[0] === 'string' && typeof row[1] === 'string') {
        row[1] = authorityRows.get(row[0]) ?? row[1];
      }
      hash.update(JSON.stringify(row));
      hash.update('\0');
    }
  }
  if (target) {
    const invalidCoverage = database
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM runtime_sessions WHERE run_index_from_revision != revision',
      )
      .get()?.count;
    const runCount = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_runs')
      .get()?.count;
    const resultCount = database
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM runtime_command_receipts WHERE result_schema IS NOT NULL OR result_json IS NOT NULL OR result_digest IS NOT NULL',
      )
      .get()?.count;
    if (invalidCoverage !== 0 || runCount !== 0 || resultCount !== 0) {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        'Store 8 coverage, Run, or receipt-result baseline is invalid.',
      );
    }
  }
  return hash.digest('hex');
}

function bindingFromDatabase(database: Database): SqliteRuntimeWorkspaceBinding {
  const rows = database
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key IN ('layout_generation', 'worker_scope_id', 'workspace_identity_digest')",
    )
    .all();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const binding = {
    layoutGeneration: values.get('layout_generation') ?? '',
    workerScopeId: values.get('worker_scope_id') ?? '',
    workspaceIdentityDigest: values.get('workspace_identity_digest') ?? '',
  };
  assertSqliteRuntimeWorkspaceBinding(binding);
  return binding;
}

function assertRecoveryIdentityMetadata(database: Database): void {
  const prefix = 'recovery_identity_v1:';
  const ownedSessions = new Set(
    database
      .query<{ session_id: string }, []>(
        `SELECT session_id FROM runtime_sessions
         UNION
         SELECT session_id FROM session_workspace_tombstone`,
      )
      .all()
      .map((row) => row.session_id),
  );
  for (const row of database
    .query<{ key: string; value: string }, [number, string]>(
      'SELECT key, value FROM runtime_store_meta WHERE substr(key, 1, ?) = ? ORDER BY key',
    )
    .iterate(prefix.length, prefix)) {
    const encoded = row.key.slice(prefix.length);
    if (!/^(?:[a-f0-9]{2})+$/u.test(encoded) || !/^[a-f0-9]{64}$/u.test(row.value)) {
      throw new Error('invalid recovery identity metadata');
    }
    const sessionId = Buffer.from(encoded, 'hex').toString('utf8');
    if (
      !sessionId ||
      Buffer.from(sessionId, 'utf8').toString('hex') !== encoded ||
      !ownedSessions.has(sessionId)
    ) {
      throw new Error('unowned recovery identity metadata');
    }
  }
}

function assertTargetWorkspaceDeep<Event, State>(
  databasePath: string,
  binding: SqliteRuntimeWorkspaceBinding,
  codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>,
): void {
  const view = openSqliteReadonlySnapshotView(databasePath);
  let sessionIds: string[];
  try {
    assertSqliteRuntimeRunStoreConnection(view.database, binding);
    const authority = inspectSqliteWorkspaceAuthorityGenerationCopy({
      db: view.database,
      sourceBinding: binding,
      targetBinding: binding,
    });
    if (!authority.settled) {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        'Store 8 authority metadata did not preserve a settled state.',
      );
    }
    try {
      assertRecoveryIdentityMetadata(view.database);
    } catch {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        'Store 8 recovery identity metadata is invalid.',
      );
    }
    sessionIds = view.database
      .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
      .all()
      .map((row) => row.session_id);
  } finally {
    view.close();
  }
  for (const sessionId of sessionIds) {
    assertSqliteRuntimeStorageTargetCanOpen_(databasePath, codec, sessionId, binding, {
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      assertConnection: (database) => assertSqliteRuntimeRunStoreConnection(database, binding),
    });
  }
}

function assertSourceUnchanged(layout: SqliteRuntimeLayoutPaths, source: SourceLayout): void {
  const pointer = readSqliteActiveLayoutPointer(layout);
  const manifest = pointer
    ? readSqliteRuntimeLayoutManifest(layout, pointer.generation)
    : undefined;
  if (
    pointer?.generation !== source.evidence.sourceLayoutGeneration ||
    JSON.stringify(manifest) !== JSON.stringify(source.manifest) ||
    fingerprintFile(source.catalogPath) !== source.catalogIdentity ||
    digestSnapshot(source.catalogPath) !== source.catalogDigest
  ) {
    throw new SqliteRuntimeRunMigrationError(
      'source_changed',
      'Store 7 source generation changed during migration.',
    );
  }
  for (const workspace of source.workspaces) {
    const view = openSqliteReadonlySnapshotView(workspace.databasePath);
    try {
      if (
        fingerprintFile(workspace.databasePath) !== workspace.identity ||
        digestDatabase(view.database) !== workspace.digest
      ) {
        throw new SqliteRuntimeRunMigrationError(
          'source_changed',
          'Workspace Store changed during migration.',
        );
      }
    } finally {
      view.close();
    }
  }
}

function assertExactWorkspaceDirectories(
  layout: SqliteRuntimeLayoutPaths,
  generation: string,
  workspaces: readonly WorkspaceSource[],
): void {
  const workersRoot = join(layout.layouts, generation, 'workers');
  const expected = new Set(workspaces.map((workspace) => workspace.workerScopeId));
  let entries: string[];
  try {
    entries = readdirSync(workersRoot);
  } catch {
    if (expected.size === 0) return;
    throw new SqliteRuntimeRunMigrationError(
      'partial_workspace',
      'Source generation Workspace directory is missing.',
    );
  }
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) {
    throw new SqliteRuntimeRunMigrationError(
      'partial_workspace',
      'Source generation contains an unmanifested or missing Workspace.',
    );
  }
}

function assertFreshTargetGeneration(layout: SqliteRuntimeLayoutPaths, generation: string): void {
  const root = join(layout.layouts, generation);
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(root).length !== 0) {
    throw new SqliteRuntimeRunMigrationError(
      'target_invalid',
      'Store 8 target generation must be absent or empty.',
    );
  }
}

function assertTargetAbsent(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        'Store 8 Workspace target already exists.',
      );
    }
  }
  assertNoFollowDatabasePath(path);
}

function assertTargetFile(path: string, digest: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(digest) || digestFile(path) !== digest) {
    throw new SqliteRuntimeRunMigrationError(
      'target_invalid',
      `${label} target digest is invalid.`,
    );
  }
  assertPrivateTargetFile(path, label);
}

function assertPrivateSourceFile(path: string, label: string): void {
  assertNoFollowDatabasePath(path);
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
  ) {
    throw new SqliteRuntimeRunMigrationError(
      'unowned_workspace',
      `${label} source is not a private owner-only regular file.`,
    );
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const sidecarStat = lstatSync(sidecar);
    if (
      sidecarStat.isSymbolicLink() ||
      !sidecarStat.isFile() ||
      sidecarStat.nlink !== 1 ||
      (process.platform !== 'win32' &&
        ((sidecarStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && sidecarStat.uid !== process.getuid())))
    ) {
      throw new SqliteRuntimeRunMigrationError(
        'source_corrupt',
        `${label} SQLite sidecar is unsafe.`,
      );
    }
  }
}

function assertPrivateTargetFile(path: string, label: string): void {
  try {
    assertPrivateSourceFile(path, label);
  } catch {
    throw new SqliteRuntimeRunMigrationError(
      'target_invalid',
      `${label} target is not a private owner-only regular file.`,
    );
  }
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) {
      throw new SqliteRuntimeRunMigrationError(
        'target_invalid',
        `${label} target retains a SQLite sidecar.`,
      );
    }
  }
}

function digestSnapshot(path: string): string {
  const view = openSqliteReadonlySnapshotView(path);
  try {
    return digestDatabase(view.database);
  } finally {
    view.close();
  }
}

function digestDatabase(database: Database): string {
  return createHash('sha256').update(database.serialize()).digest('hex');
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fingerprintFile(path: string): string {
  const stat = lstatSync(path);
  const sidecar = (suffix: string): string => {
    const candidate = `${path}${suffix}`;
    if (!existsSync(candidate)) return 'missing';
    const value = lstatSync(candidate);
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;
  };
  return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}|wal=${sidecar('-wal')}|shm=${sidecar('-shm')}`;
}

function sourceCorrupt(message: string): never {
  throw new SqliteRuntimeRunMigrationError('source_corrupt', message);
}

function isClosedMaintenanceBarrier(barrier: SqliteRuntimeRunMigrationMaintenanceBarrier): boolean {
  if (!barrier || typeof barrier !== 'object') return false;
  const actualKeys = Object.keys(barrier).sort();
  const expectedKeys = [
    'activeEffects',
    'activeTurns',
    'coordinatorStopped',
    'externalProcesses',
    'gatewayStopped',
    'pendingInteractions',
    'workspaceWorkersStopped',
  ];
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    barrier.coordinatorStopped === true &&
    barrier.workspaceWorkersStopped === true &&
    barrier.gatewayStopped === true &&
    barrier.activeTurns === 0 &&
    barrier.pendingInteractions === 0 &&
    barrier.activeEffects === 0 &&
    barrier.externalProcesses === 0
  );
}

function sameEvidence(
  actual: SqliteRuntimeRunMigrationSourceEvidence,
  expected: SqliteRuntimeRunMigrationSourceEvidence,
): boolean {
  return (
    actual.sourceLayoutGeneration === expected.sourceLayoutGeneration &&
    actual.sourceStoreIdentity === expected.sourceStoreIdentity &&
    actual.sourceStoreDigest === expected.sourceStoreDigest &&
    sameProfile(actual.sourceProfile, expected.sourceProfile)
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

function assertGeneration(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new SqliteRuntimeRunMigrationError('layout_invalid', 'Target generation is invalid.');
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function blockedWithJournal(
  reason: SqliteRuntimeRunMigrationBlockedReason,
  layout: SqliteRuntimeLayoutPaths,
  journal: SqliteRuntimeMigrationJournal | undefined,
): SqliteRuntimeRunMigrationResult {
  if (!journal) return { status: 'blocked', reason };
  const blockedJournal = { ...journal, pointerPhase: 'blocked' as const };
  try {
    writeSqliteRuntimeMigrationJournal(layout, blockedJournal);
  } catch {
    // An unavailable journal is itself a recovery blocker; preserve the typed reason.
  }
  return { status: 'blocked', reason, journal: blockedJournal };
}
