import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
  type KiteHomeIdentity,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceLockIdentity,
  readLocalRuntimeServiceToken,
  resolveLocalRuntimeServiceStatePaths,
} from '@kite-ai/kite-local-runtime/service';
import {
  createSqliteRuntimeLayoutCutover,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  inspectSqliteRuntimeRunMigrationSource,
  migrateSqliteRuntimeLayoutToRunStore,
  migrateSqliteRuntimeStoreToWorkspaceLayout,
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeMigrationFence,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeLayoutManifest,
  type SqliteRuntimeLayoutPaths,
  type SqliteRuntimeMigrationCatalogBuilder,
  type SqliteRuntimeMigrationJournal,
  type SqliteRuntimeMigrationSessionIdentity,
  type SqliteRuntimeMigrationSourceGuard,
  type SqliteRuntimeMigrationWorkspaceBinding,
  type SqliteRuntimeRunMigrationCatalogPort,
  type SqliteRuntimeRunMigrationMaintenanceBarrier,
  type SqliteRuntimeRunMigrationResult,
  type SqliteRuntimeSnapshotCodec,
  sqliteRuntimeStoreDigest,
  sqliteRuntimeStoreFingerprint,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createSqliteRuntimeMigrationCatalogBuilder,
  createSqliteRuntimeRunMigrationCatalogPort,
} from '../../apps/kite-service/src/coordinator/catalog-builder';

const DEFAULT_FRESH_LAYOUT_GENERATION = 'generation-initial';
const FRESH_SOURCE_IDENTITY = 'kite-fresh-home-no-source-v1';
const FRESH_SOURCE_DIGEST = '0'.repeat(64);
const SOURCE_PROFILE = Object.freeze({
  stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  storeSchemaVersion: 6,
  formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
});

export type LocalLayoutMigrationServiceStatus = 'absent' | 'present' | 'uncertain';

export interface LocalLayoutMigrationOptions<Event = unknown, State = unknown> {
  /** Explicit canonical Kite home. No cwd, HOME, or ambient environment fallback is allowed. */
  readonly home: string | KiteHomeIdentity;
  /** Explicit legacy Store path. It is never guessed from cwd or another checkpoint path. */
  readonly sourceStorePath: string;
  /** The normal path only classifies a legacy source. Migration requires this explicit action. */
  readonly allowLegacyMigration?: boolean;
  readonly targetLayoutGeneration?: string;
  /** Required for legacy migration; must use validated persisted Workspace identity evidence. */
  readonly resolveWorkspaceBinding?: (
    identity: SqliteRuntimeMigrationSessionIdentity,
  ) => SqliteRuntimeMigrationWorkspaceBinding | null;
  readonly codec?: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly catalogBuilder?: SqliteRuntimeMigrationCatalogBuilder;
  readonly inspectService?: () =>
    | LocalLayoutMigrationServiceStatus
    | Promise<LocalLayoutMigrationServiceStatus>;
  readonly processProbe?: (pid: number) => LocalLayoutMigrationServiceStatus;
  readonly createMigrationNonce?: () => string;
}

export type LocalLayoutMigrationResult =
  | {
      readonly status: 'initialized';
      readonly targetLayoutGeneration: string;
      readonly catalogPath: string;
      readonly catalogDigest: string;
    }
  | {
      readonly status: 'migrated';
      readonly targetLayoutGeneration: string;
      readonly catalogDigest: string;
      readonly workspaceStoreDigests: readonly {
        readonly workerScopeId: string;
        readonly digest: string;
      }[];
    }
  | {
      readonly status: 'migration_required';
      readonly sourceStorePath: string;
      readonly reason: 'legacy_store_present' | 'workspace_identity_required';
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'service_present'
        | 'identity_uncertain'
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

export interface LocalRunStoreMigrationOptions<Event = unknown, State = unknown> {
  readonly home: string | KiteHomeIdentity;
  readonly targetLayoutGeneration: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly isSessionSettled: (state: Readonly<State>) => boolean;
  /** Manager-owned proof after admission is closed and every process/effect has converged. */
  readonly inspectMaintenanceBarrier: () =>
    | SqliteRuntimeRunMigrationMaintenanceBarrier
    | 'uncertain'
    | Promise<SqliteRuntimeRunMigrationMaintenanceBarrier | 'uncertain'>;
  readonly catalog?: SqliteRuntimeRunMigrationCatalogPort;
  readonly createMigrationNonce?: () => string;
  readonly faultAfterWorkspaceCopies?: number;
}

/** Explicit offline Store 7 → Store 8 maintenance orchestration; never runs during normal start. */
export async function runLocalRunStoreMigration<Event = unknown, State = unknown>(
  options: LocalRunStoreMigrationOptions<Event, State>,
): Promise<SqliteRuntimeRunMigrationResult> {
  const home = validateHome(options.home);
  const targetLayoutGeneration = validateGeneration(options.targetLayoutGeneration);
  const maintenanceBarrier = await options.inspectMaintenanceBarrier();
  if (maintenanceBarrier === 'uncertain') {
    return { status: 'blocked', reason: 'maintenance_required' };
  }
  const layout = resolveSqliteRuntimeLayoutPaths(home.root);
  let evidence: ReturnType<typeof inspectSqliteRuntimeRunMigrationSource>;
  try {
    evidence = inspectSqliteRuntimeRunMigrationSource(layout);
  } catch {
    return { status: 'blocked', reason: 'source_corrupt' };
  }
  const migrationNonce = options.createMigrationNonce?.() ?? `store-8-${randomUUID()}`;
  if (!/^[\x21-\x7e]{1,512}$/u.test(migrationNonce)) {
    throw new TypeError('Store 8 migration nonce is invalid.');
  }
  return migrateSqliteRuntimeLayoutToRunStore({
    layout,
    targetLayoutGeneration,
    sourceGuard: {
      ...evidence,
      maintenanceBarrier,
      fence: {
        schema: 'kite.runtime-migration-fence.v1',
        sourceStoreIdentity: evidence.sourceStoreIdentity,
        sourceStoreDigest: evidence.sourceStoreDigest,
        sourceProfile: evidence.sourceProfile,
        targetLayoutGeneration,
        migrationNonce,
        state: 'active',
      },
    },
    codec: options.codec,
    isSessionSettled: options.isSessionSettled,
    catalog:
      options.catalog ??
      createSqliteRuntimeRunMigrationCatalogPort({ canonicalKiteHomeRoot: home.root }),
    ...(options.faultAfterWorkspaceCopies === undefined
      ? {}
      : { faultAfterWorkspaceCopies: options.faultAfterWorkspaceCopies }),
  });
}

/**
 * Execute the explicit offline Store 6 → Store 7 maintenance boundary, or initialize a truly
 * empty home. A legacy source without a caller-supplied persisted Workspace resolver returns a
 * typed migration_required result; it is never silently imported or assigned to the current cwd.
 */
export async function runLocalLayoutMigration<Event = unknown, State = unknown>(
  options: LocalLayoutMigrationOptions<Event, State>,
): Promise<LocalLayoutMigrationResult> {
  const home = validateHome(options.home);
  const sourceStorePath = validateAbsolutePath(options.sourceStorePath, 'legacy Store');
  const layout = resolveSqliteRuntimeLayoutPaths(home.root);
  const layoutState = inspectLayoutState(layout);
  if (layoutState.kind === 'invalid') return { status: 'blocked', reason: 'layout_invalid' };
  const sourcePresent = hasLegacySource(sourceStorePath);
  if (sourcePresent) {
    if (layoutState.kind === 'present') {
      return { status: 'blocked', reason: 'layout_invalid', journal: layoutState.journal };
    }
    if (!options.allowLegacyMigration) {
      return { status: 'migration_required', sourceStorePath, reason: 'legacy_store_present' };
    }
    const serviceStatus = await (
      options.inspectService ?? defaultServiceInspection(home, options.processProbe)
    )();
    if (serviceStatus === 'present') return { status: 'blocked', reason: 'service_present' };
    if (serviceStatus === 'uncertain') return { status: 'blocked', reason: 'identity_uncertain' };
    const fence = readFence(layout);
    if (!fence) return { status: 'blocked', reason: 'missing_fence' };
    const targetLayoutGeneration = validateGeneration(
      options.targetLayoutGeneration ?? fence.targetLayoutGeneration,
    );
    if (fence.targetLayoutGeneration !== targetLayoutGeneration) {
      return { status: 'blocked', reason: 'missing_fence' };
    }
    if (!options.resolveWorkspaceBinding) {
      return {
        status: 'migration_required',
        sourceStorePath,
        reason: 'workspace_identity_required',
      };
    }
    let sourceGuard: SqliteRuntimeMigrationSourceGuard;
    try {
      sourceGuard = sourceGuardFor(sourceStorePath, fence);
    } catch {
      return { status: 'blocked', reason: 'source_corrupt' };
    }
    if (!options.codec) {
      throw new TypeError('Legacy Store migration requires a current-format codec.');
    }
    const migration = await migrateSqliteRuntimeStoreToWorkspaceLayout({
      sourceStorePath,
      layout,
      targetLayoutGeneration,
      sourceGuard,
      codec: options.codec,
      catalogBuilder:
        options.catalogBuilder ??
        createSqliteRuntimeMigrationCatalogBuilder({ canonicalKiteHomeRoot: home.root }),
      resolveWorkspaceBinding: options.resolveWorkspaceBinding,
    });
    return migration.status === 'committed'
      ? {
          status: 'migrated',
          targetLayoutGeneration: migration.targetLayoutGeneration,
          catalogDigest: migration.catalogDigest,
          workspaceStoreDigests: migration.workspaceStoreDigests,
        }
      : migration;
  }

  if (layoutState.kind === 'present') {
    return { status: 'blocked', reason: 'layout_invalid', journal: layoutState.journal };
  }
  return initializeFreshLayout(
    layout,
    validateGeneration(options.targetLayoutGeneration ?? DEFAULT_FRESH_LAYOUT_GENERATION),
    options.catalogBuilder ??
      createSqliteRuntimeMigrationCatalogBuilder({ canonicalKiteHomeRoot: home.root }),
    options.createMigrationNonce,
  );
}

async function initializeFreshLayout(
  layout: SqliteRuntimeLayoutPaths,
  targetLayoutGeneration: string,
  catalogBuilder: SqliteRuntimeMigrationCatalogBuilder,
  createMigrationNonce: (() => string) | undefined,
): Promise<LocalLayoutMigrationResult> {
  ensureSqliteRuntimeLayoutRoot(layout.root);
  ensureSqliteRuntimeGenerationRoot(layout, targetLayoutGeneration);
  const catalogPath = resolveSqliteCatalogPath(layout, targetLayoutGeneration);
  const catalogDigest = await catalogBuilder.build({
    catalogPath,
    layoutGeneration: targetLayoutGeneration,
    sessions: [],
  });
  if (catalogDigest !== sqliteRuntimeStoreDigest(catalogPath)) {
    throw new Error('Fresh Coordinator Catalog digest mismatch.');
  }
  assertPrivateCatalogFile(catalogPath);
  assertNoSqliteSidecars(catalogPath);
  const migrationNonce = createMigrationNonce?.() ?? `fresh-${randomUUID()}`;
  if (!/^[\x21-\x7e]{1,512}$/u.test(migrationNonce)) {
    throw new Error('Fresh layout migration nonce is invalid.');
  }
  const journal: SqliteRuntimeMigrationJournal = {
    schema: 'kite.runtime-migration-journal.v1',
    sourceStoreIdentity: FRESH_SOURCE_IDENTITY,
    sourceStoreDigest: FRESH_SOURCE_DIGEST,
    sourceProfile: SOURCE_PROFILE,
    targetLayoutGeneration,
    targetCatalogDigest: catalogDigest,
    workspaceStoreDigests: [],
    pointerPhase: 'source_active',
    targetWriteState: 'none',
    migrationNonce,
  };
  const fence = {
    schema: 'kite.runtime-migration-fence.v1' as const,
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile: SOURCE_PROFILE,
    targetLayoutGeneration,
    migrationNonce,
    state: 'active' as const,
  };
  const manifest: SqliteRuntimeLayoutManifest = {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: targetLayoutGeneration,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest,
    workspaceStores: [],
  };
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteRuntimeMigrationFence(layout, fence);
  const cutover = createSqliteRuntimeLayoutCutover(layout);
  cutover.prepareTarget(manifest, journal, fence);
  cutover.switchPointer();
  cutover.markTargetReady();
  cutover.commit();
  return { status: 'initialized', targetLayoutGeneration, catalogPath, catalogDigest };
}

function sourceGuardFor(
  sourceStorePath: string,
  fence: SqliteRuntimeMigrationSourceGuard['fence'],
): SqliteRuntimeMigrationSourceGuard {
  const sourceStoreIdentity = sqliteRuntimeStoreFingerprint(sourceStorePath);
  const sourceStoreDigest = sqliteRuntimeStoreDigest(sourceStorePath);
  if (
    fence.sourceStoreIdentity !== sourceStoreIdentity ||
    fence.sourceStoreDigest !== sourceStoreDigest ||
    fence.sourceProfile.storeSchemaVersion !== SOURCE_PROFILE.storeSchemaVersion ||
    fence.sourceProfile.formatEpoch !== SOURCE_PROFILE.formatEpoch
  ) {
    throw new Error('Legacy Store migration fence does not match the source.');
  }
  return { serviceAbsent: true, sourceStoreIdentity, sourceStoreDigest, fence };
}

function inspectLayoutState(
  layout: SqliteRuntimeLayoutPaths,
):
  | { readonly kind: 'fresh' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'present'; readonly journal?: SqliteRuntimeMigrationJournal }
  | { readonly kind: 'invalid' } {
  try {
    const pointer = readSqliteActiveLayoutPointer(layout);
    const journal = readSqliteRuntimeMigrationJournal(layout);
    const fence = readSqliteRuntimeMigrationFence(layout);
    if (pointer || journal) return { kind: 'present', ...(journal ? { journal } : {}) };
    if (fence) return { kind: 'fenced' };
    if (existsSync(layout.layouts) && readdirSync(layout.layouts).length > 0) {
      return { kind: 'present' };
    }
    return { kind: 'fresh' };
  } catch {
    return { kind: 'invalid' };
  }
}

function readFence(layout: SqliteRuntimeLayoutPaths) {
  try {
    return readSqliteRuntimeMigrationFence(layout);
  } catch {
    return undefined;
  }
}

function hasLegacySource(sourceStorePath: string): boolean {
  assertNoFollowDatabasePath(sourceStorePath);
  try {
    lstatSync(sourceStorePath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      for (const suffix of ['-wal', '-shm'] as const) {
        const sidecar = `${sourceStorePath}${suffix}`;
        try {
          const stat = lstatSync(sidecar);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw new Error('Legacy Store sidecar is unsafe.');
          }
          return true;
        } catch (sidecarError) {
          if (!isMissing(sidecarError)) throw sidecarError;
        }
      }
      return false;
    }
    throw error;
  }
}

function validateHome(value: string | KiteHomeIdentity): KiteHomeIdentity {
  const identity =
    typeof value === 'string' ? createKiteHomeIdentity(value, 'explicit_argument') : value;
  return ensureLocalRuntimeServiceHome(identity);
}

function validateAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0') || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} path must be explicit and absolute.`);
  }
  return resolve(value);
}

function validateGeneration(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError('Layout generation is invalid.');
  }
  return value;
}

function defaultServiceInspection(
  home: KiteHomeIdentity,
  processProbe?: (pid: number) => LocalLayoutMigrationServiceStatus,
): () => LocalLayoutMigrationServiceStatus {
  const paths = resolveLocalRuntimeServiceStatePaths(home);
  return () => {
    try {
      if (
        readLocalRuntimeServiceDescriptor(paths) !== undefined ||
        readLocalRuntimeServiceToken(paths, 'access') !== undefined ||
        readLocalRuntimeServiceToken(paths, 'control') !== undefined
      ) {
        return 'present';
      }
      const locks = [
        readLocalRuntimeServiceLockIdentity(paths, 'instance'),
        readLocalRuntimeServiceLockIdentity(paths, 'lifecycle'),
      ].filter((value): value is NonNullable<typeof value> => value !== undefined);
      if (locks.length === 0) return 'absent';
      const probe =
        processProbe ??
        ((pid: number): LocalLayoutMigrationServiceStatus => {
          try {
            process.kill(pid, 0);
            return 'present';
          } catch (error) {
            return isMissing(error) ? 'absent' : 'uncertain';
          }
        });
      const states = locks.map((lock) => probe(lock.pid));
      return states.includes('uncertain')
        ? 'uncertain'
        : states.includes('present')
          ? 'present'
          : 'absent';
    } catch {
      return 'uncertain';
    }
  };
}

function assertPrivateCatalogFile(path: string): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
  ) {
    throw new Error('Fresh Coordinator Catalog is not a private regular file.');
  }
}

function assertNoSqliteSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    try {
      lstatSync(`${path}${suffix}`);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    throw new Error('Fresh Coordinator Catalog still has a SQLite sidecar.');
  }
}

/**
 * The storage package keeps its database preflight implementation private. The
 * maintenance boundary repeats only the no-follow check it needs instead of
 * reaching into that implementation-private module.
 */
function assertNoFollowDatabasePath(path: string): void {
  for (const candidate of [path, dirname(path)]) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error('Maintenance path must not follow a symlink.');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
