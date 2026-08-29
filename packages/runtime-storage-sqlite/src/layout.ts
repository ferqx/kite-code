import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  assertNoFollowDatabasePath,
  assertSqliteRuntimeWorkspaceBinding,
  assertWorkspaceSqliteRuntimeStoreConnection,
  openSqliteReadonlySnapshotView,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  SqliteRuntimeStorageOpenError,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';
import { initializeSqliteRuntimeSchema } from './schema';

export const SQLITE_RUNTIME_ACTIVE_LAYOUT_SCHEMA_ = 'kite.runtime-active-layout.v1' as const;
export const SQLITE_RUNTIME_LAYOUT_MANIFEST_SCHEMA_ = 'kite.runtime-layout-manifest.v1' as const;
export const SQLITE_RUNTIME_MIGRATION_JOURNAL_SCHEMA_ =
  'kite.runtime-migration-journal.v1' as const;
export const SQLITE_RUNTIME_MIGRATION_FENCE_SCHEMA_ = 'kite.runtime-migration-fence.v1' as const;

const generation = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u, 'invalid layout generation');
const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0') && !/\p{Cc}/u.test(value), 'invalid layout text');
const digest = z.string().regex(/^[a-f0-9]{16,128}$/u, 'invalid layout digest');
const profileSchema = z
  .object({
    stateSchemaVersion: z.literal(SQLITE_RUNTIME_STATE_SCHEMA_VERSION),
    storeSchemaVersion: z.literal(SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION),
    formatEpoch: z.literal(SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH),
  })
  .strict();
const workspaceStoreDigestSchema = z.object({ workerScopeId: boundedText, digest }).strict();

const activeLayoutPointerSchema = z
  .object({
    schema: z.literal(SQLITE_RUNTIME_ACTIVE_LAYOUT_SCHEMA_),
    generation,
  })
  .strict();
export type SqliteRuntimeActiveLayoutPointer = z.infer<typeof activeLayoutPointerSchema>;

const layoutManifestSchema = z
  .object({
    schema: z.literal(SQLITE_RUNTIME_LAYOUT_MANIFEST_SCHEMA_),
    generation,
    profile: profileSchema,
    catalogDigest: digest,
    workspaceStores: z.array(workspaceStoreDigestSchema).max(10_000),
  })
  .strict();
export type SqliteRuntimeLayoutManifest = z.infer<typeof layoutManifestSchema>;

const migrationJournalSchema = z
  .object({
    schema: z.literal(SQLITE_RUNTIME_MIGRATION_JOURNAL_SCHEMA_),
    sourceStoreIdentity: boundedText,
    sourceStoreDigest: digest,
    sourceProfile: z
      .object({
        stateSchemaVersion: z.number().int().positive(),
        storeSchemaVersion: z.number().int().positive(),
        formatEpoch: boundedText,
      })
      .strict(),
    targetLayoutGeneration: generation,
    targetCatalogDigest: digest,
    workspaceStoreDigests: z.array(workspaceStoreDigestSchema).max(10_000),
    pointerPhase: z.enum([
      'source_active',
      'target_prepared',
      'pointer_switched',
      'target_ready',
      'committed',
      'blocked',
      'unknown',
    ]),
    targetWriteState: z.enum(['none', 'written']),
    migrationNonce: boundedText,
  })
  .strict();
export type SqliteRuntimeMigrationJournal = z.infer<typeof migrationJournalSchema>;

const migrationFenceSchema = z
  .object({
    schema: z.literal(SQLITE_RUNTIME_MIGRATION_FENCE_SCHEMA_),
    sourceStoreIdentity: boundedText,
    sourceStoreDigest: digest,
    sourceProfile: z
      .object({
        stateSchemaVersion: z.number().int().positive(),
        storeSchemaVersion: z.number().int().positive(),
        formatEpoch: boundedText,
      })
      .strict(),
    targetLayoutGeneration: generation,
    migrationNonce: boundedText,
    state: z.literal('active'),
  })
  .strict();
export type SqliteRuntimeMigrationFence = z.infer<typeof migrationFenceSchema>;

export interface SqliteRuntimeLayoutPaths {
  readonly root: string;
  readonly activeLayout: string;
  readonly layouts: string;
  readonly migrationJournal: string;
  readonly migrationFence: string;
}

export type SqliteRuntimeLayoutErrorCode =
  | 'invalid_path'
  | 'permission'
  | 'corrupt'
  | 'busy'
  | 'blocked';

export class SqliteRuntimeLayoutError extends Error {
  readonly code: SqliteRuntimeLayoutErrorCode;

  constructor(code: SqliteRuntimeLayoutErrorCode, message: string) {
    super(message);
    this.name = 'SqliteRuntimeLayoutError';
    this.code = code;
  }
}

export function resolveSqliteRuntimeLayoutPaths(kiteHomeRoot: string): SqliteRuntimeLayoutPaths {
  const root = resolve(assertAbsolutePath(kiteHomeRoot));
  return Object.freeze({
    root,
    activeLayout: join(root, 'active-layout'),
    layouts: join(root, 'layouts'),
    migrationJournal: join(root, 'migration-journal.json'),
    migrationFence: join(root, 'migration-fence.json'),
  });
}

export function ensureSqliteRuntimeLayoutRoot(kiteHomeRoot: string): SqliteRuntimeLayoutPaths {
  const paths = resolveSqliteRuntimeLayoutPaths(kiteHomeRoot);
  ensureOwnerDirectory(paths.root);
  ensureOwnerDirectory(paths.layouts);
  return paths;
}

export function ensureSqliteRuntimeGenerationRoot(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
): string {
  assertGeneration(layoutGeneration);
  const root = join(paths.layouts, layoutGeneration);
  ensureOwnerDirectory(root);
  return root;
}

export function resolveSqliteWorkspaceStorePath(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
  workerScopeId: string,
): string {
  assertGeneration(layoutGeneration);
  assertSafeSegment(workerScopeId, 'Worker scope');
  return join(paths.layouts, layoutGeneration, 'workers', workerScopeId, 'runtime.sqlite');
}

export function ensureSqliteWorkspaceStoreDirectory(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
  workerScopeId: string,
): string {
  const databasePath = resolveSqliteWorkspaceStorePath(paths, layoutGeneration, workerScopeId);
  ensureOwnerDirectory(dirname(databasePath));
  return databasePath;
}

export interface SqliteRuntimeWorkspaceStoreAdmission {
  readonly workerScopeId: string;
  readonly digest: string;
}

/**
 * Materialize one empty, exactly-bound Store 7 file and admit it under the same global layout
 * lease. Existing exact files are verified and resume the journal→manifest crash window; an
 * existing different file is never truncated or replaced.
 */
export function materializeAndAdmitNewWorkspaceStore(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
): SqliteRuntimeWorkspaceStoreAdmission & { readonly databasePath: string } {
  assertSqliteRuntimeWorkspaceBinding(binding);
  const databasePath = ensureSqliteWorkspaceStoreDirectory(
    paths,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  const admissionLease = acquireLayoutAdmissionLease(paths);
  let createdIdentity:
    | Readonly<{
        dev: number | bigint;
        ino: number | bigint;
      }>
    | undefined;
  try {
    if (!existsSync(databasePath)) {
      let database: Database | undefined;
      try {
        database = new Database(databasePath, { create: true, strict: true });
        initializeSqliteRuntimeSchema(database, {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
          workspaceBinding: binding,
        });
        database.run('PRAGMA journal_mode = DELETE');
        database.run('PRAGMA wal_checkpoint(TRUNCATE)');
        database.close(false);
        database = undefined;
        chmodSync(databasePath, 0o600);
        const stat = assertPrivateAuthorityFile(databasePath, 'New Workspace Store');
        createdIdentity = { dev: stat.dev, ino: stat.ino };
        const descriptor = openSync(databasePath, 'r');
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        fsyncParentDirectory(databasePath);
      } catch (error) {
        database?.close(false);
        throw error;
      }
    }
    assertAdmissibleWorkspaceStore(paths, binding, databasePath);
    const admission = admitNewWorkspaceStoreLocked(paths, binding, databasePath);
    return Object.freeze({ ...admission, databasePath });
  } catch (error) {
    if (createdIdentity !== undefined) {
      try {
        const current = lstatSync(databasePath);
        const journal = readSqliteRuntimeMigrationJournal(paths);
        const manifest = readSqliteRuntimeLayoutManifest(paths, binding.layoutGeneration);
        const recorded =
          journal?.workspaceStoreDigests.some(
            (entry) => entry.workerScopeId === binding.workerScopeId,
          ) ||
          manifest?.workspaceStores.some((entry) => entry.workerScopeId === binding.workerScopeId);
        if (
          !recorded &&
          current !== undefined &&
          current.dev === createdIdentity.dev &&
          current.ino === createdIdentity.ino
        ) {
          unlinkSync(databasePath);
          fsyncParentDirectory(databasePath);
        }
      } catch {
        // Preserve a target whose exact ownership or durable evidence cannot be re-proven.
      }
    }
    throw error;
  } finally {
    admissionLease.release();
  }
}

/**
 * Admit a newly materialized Store 7 file into the already-active generation.
 *
 * The caller owns Store header validation and Coordinator Catalog publication;
 * this narrow layout operation only verifies the canonical file and records
 * its digest in the generation evidence. The journal is made irreversible
 * before the manifest is extended, so a crash cannot reopen a partial target
 * or make rollback appear safe.
 */
export function admitNewWorkspaceStore(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
  databasePath: string,
): SqliteRuntimeWorkspaceStoreAdmission {
  assertAdmissibleWorkspaceStore(paths, binding, databasePath);
  const admissionLease = acquireLayoutAdmissionLease(paths);
  try {
    return admitNewWorkspaceStoreLocked(paths, binding, databasePath);
  } finally {
    admissionLease.release();
  }
}

function assertAdmissibleWorkspaceStore(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
  databasePath: string,
): void {
  assertSqliteRuntimeWorkspaceBinding(binding);
  assertNoFollowDatabasePath(databasePath);
  const expectedPath = resolveSqliteWorkspaceStorePath(
    paths,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  if (resolve(databasePath) !== resolve(expectedPath)) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'New Workspace Store path does not match its active generation.',
    );
  }
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SqliteRuntimeLayoutError(
      'permission',
      'New Workspace Store must be a private regular file.',
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new SqliteRuntimeLayoutError(
      'permission',
      'New Workspace Store permissions are not owner-only.',
    );
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    throw new SqliteRuntimeLayoutError(
      'permission',
      'New Workspace Store owner is not the current user.',
    );
  }
  let view: ReturnType<typeof openSqliteReadonlySnapshotView> | undefined;
  try {
    view = openSqliteReadonlySnapshotView(databasePath);
    assertWorkspaceSqliteRuntimeStoreConnection(view.database, binding);
  } catch {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'New Workspace Store profile or Workspace binding is invalid.',
    );
  } finally {
    view?.close();
  }
}

function admitNewWorkspaceStoreLocked(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
  databasePath: string,
): SqliteRuntimeWorkspaceStoreAdmission {
  const pointer = readSqliteActiveLayoutPointer(paths);
  if (!pointer || pointer.generation !== binding.layoutGeneration) {
    throw new SqliteRuntimeLayoutError('blocked', 'New Workspace Store generation is not active.');
  }
  const manifest = readSqliteRuntimeLayoutManifest(paths, binding.layoutGeneration);
  const journal = readSqliteRuntimeMigrationJournal(paths);
  const fence = readSqliteRuntimeMigrationFence(paths);
  if (
    !manifest ||
    !journal ||
    !fence ||
    journal.targetLayoutGeneration !== binding.layoutGeneration ||
    journal.pointerPhase !== 'committed' ||
    fence.targetLayoutGeneration !== binding.layoutGeneration ||
    fence.migrationNonce !== journal.migrationNonce ||
    manifest.profile.storeSchemaVersion !== SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION ||
    manifest.profile.stateSchemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    manifest.profile.formatEpoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'New Workspace Store admission evidence is incomplete or stale.',
    );
  }
  const currentDigest = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
  const manifestEntry = manifest.workspaceStores.find(
    (entry) => entry.workerScopeId === binding.workerScopeId,
  );
  const journalEntry = journal.workspaceStoreDigests.find(
    (entry) => entry.workerScopeId === binding.workerScopeId,
  );
  if (manifestEntry || journalEntry) {
    const evidenceDigest = manifestEntry?.digest ?? journalEntry?.digest;
    if (evidenceDigest === undefined) {
      throw new SqliteRuntimeLayoutError(
        'blocked',
        'New Workspace Store admission evidence is unavailable.',
      );
    }
    if (
      (manifestEntry !== undefined && journalEntry !== undefined
        ? manifestEntry.digest !== journalEntry.digest
        : false) ||
      (journal.targetWriteState === 'none' &&
        ((manifestEntry !== undefined && manifestEntry.digest !== currentDigest) ||
          (journalEntry !== undefined && journalEntry.digest !== currentDigest)))
    ) {
      throw new SqliteRuntimeLayoutError(
        'blocked',
        'New Workspace Store admission conflicts with existing generation evidence.',
      );
    }
    if (journalEntry !== undefined && manifestEntry === undefined) {
      writeSqliteRuntimeLayoutManifest(paths, {
        ...manifest,
        workspaceStores: [...manifest.workspaceStores, journalEntry].sort((left, right) =>
          left.workerScopeId.localeCompare(right.workerScopeId),
        ),
      });
    } else if (manifestEntry === undefined || journalEntry === undefined) {
      throw new SqliteRuntimeLayoutError(
        'blocked',
        'New Workspace Store admission evidence is one-sided.',
      );
    }
    return Object.freeze({
      workerScopeId: binding.workerScopeId,
      digest: evidenceDigest,
    });
  }
  const nextManifest: SqliteRuntimeLayoutManifest = {
    ...manifest,
    workspaceStores: [
      ...manifest.workspaceStores,
      { workerScopeId: binding.workerScopeId, digest: currentDigest },
    ].sort((left, right) => left.workerScopeId.localeCompare(right.workerScopeId)),
  };
  const nextJournal: SqliteRuntimeMigrationJournal = {
    ...journal,
    workspaceStoreDigests: [
      ...journal.workspaceStoreDigests,
      { workerScopeId: binding.workerScopeId, digest: currentDigest },
    ].sort((left, right) => left.workerScopeId.localeCompare(right.workerScopeId)),
    targetWriteState: 'written',
  };
  writeSqliteRuntimeMigrationJournal(paths, nextJournal);
  writeSqliteRuntimeLayoutManifest(paths, nextManifest);
  return Object.freeze({ workerScopeId: binding.workerScopeId, digest: currentDigest });
}

export function resolveSqliteCatalogPath(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
): string {
  assertGeneration(layoutGeneration);
  return join(paths.layouts, layoutGeneration, 'catalog.sqlite');
}

/** Return the only Catalog path authorized by the active-layout pointer. */
export function resolveSqliteActiveCatalogPath(paths: SqliteRuntimeLayoutPaths): string {
  const pointer = readSqliteActiveLayoutPointer(paths);
  if (!pointer) {
    throw new SqliteRuntimeLayoutError('blocked', 'SQLite active-layout pointer is absent.');
  }
  const manifest = readSqliteRuntimeLayoutManifest(paths, pointer.generation);
  if (!manifest || manifest.generation !== pointer.generation) {
    throw new SqliteRuntimeLayoutError('blocked', 'SQLite active Catalog manifest is absent.');
  }
  return resolveSqliteCatalogPath(paths, pointer.generation);
}

/**
 * Revalidate the mutable Coordinator Catalog against the one active layout.
 * The manifest digest is authoritative only until the generation's first
 * post-switch write; afterwards the global write fence prevents rollback and
 * Catalog integrity is verified by its schema owner on every reopen.
 */
export function assertSqliteCoordinatorCatalogActive(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
  catalogPath: string,
): SqliteRuntimeMigrationJournal {
  assertGeneration(layoutGeneration);
  const expectedPath = resolveSqliteCatalogPath(paths, layoutGeneration);
  if (resolve(catalogPath) !== resolve(expectedPath)) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Coordinator Catalog path does not match its active layout.',
    );
  }
  assertNoFollowDatabasePath(catalogPath);
  const stat = lstatSync(catalogPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SqliteRuntimeLayoutError(
      'permission',
      'Coordinator Catalog is not a private regular file.',
    );
  }
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
  ) {
    throw new SqliteRuntimeLayoutError('permission', 'Coordinator Catalog is not owner-only.');
  }
  const pointer = readSqliteActiveLayoutPointer(paths);
  const manifest = readSqliteRuntimeLayoutManifest(paths, layoutGeneration);
  const journal = readSqliteRuntimeMigrationJournal(paths);
  const fence = readSqliteRuntimeMigrationFence(paths);
  if (
    pointer?.generation !== layoutGeneration ||
    !manifest ||
    manifest.generation !== layoutGeneration ||
    manifest.profile.stateSchemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    manifest.profile.storeSchemaVersion !== SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION ||
    manifest.profile.formatEpoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
    !journal ||
    journal.pointerPhase !== 'committed' ||
    journal.targetLayoutGeneration !== layoutGeneration ||
    fence?.targetLayoutGeneration !== layoutGeneration ||
    fence.migrationNonce !== journal.migrationNonce
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Coordinator Catalog active-layout evidence is incomplete or stale.',
    );
  }
  if (
    journal.targetWriteState === 'none' &&
    createHash('sha256').update(readFileSync(catalogPath)).digest('hex') !== manifest.catalogDigest
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Coordinator Catalog does not match its pre-write manifest digest.',
    );
  }
  return journal;
}

/** Mark the shared generation written before the first Catalog mutation. */
export function markSqliteCoordinatorCatalogWritten(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
  catalogPath: string,
): void {
  const journal = assertSqliteCoordinatorCatalogActive(paths, layoutGeneration, catalogPath);
  if (journal.targetWriteState === 'written') return;
  writeSqliteRuntimeMigrationJournal(paths, { ...journal, targetWriteState: 'written' });
}

export function readSqliteActiveLayoutPointer(
  paths: SqliteRuntimeLayoutPaths,
): SqliteRuntimeActiveLayoutPointer | undefined {
  const value = readJsonFile(paths.activeLayout);
  if (value === undefined) return undefined;
  try {
    const pointer = activeLayoutPointerSchema.parse(value);
    const generationRoot = join(paths.layouts, pointer.generation);
    const stat = lstatSync(generationRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('target generation is not a real directory');
    }
    return pointer;
  } catch {
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite active-layout pointer is invalid.');
  }
}

export function writeSqliteActiveLayoutPointer(
  paths: SqliteRuntimeLayoutPaths,
  pointer: SqliteRuntimeActiveLayoutPointer,
): void {
  const parsed = activeLayoutPointerSchema.safeParse(pointer);
  if (!parsed.success)
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite active-layout pointer is invalid.');
  const generationRoot = join(paths.layouts, parsed.data.generation);
  ensureOwnerDirectory(generationRoot);
  writeAtomicJson(paths.activeLayout, parsed.data);
}

export function readSqliteRuntimeLayoutManifest(
  paths: SqliteRuntimeLayoutPaths,
  layoutGeneration: string,
): SqliteRuntimeLayoutManifest | undefined {
  assertGeneration(layoutGeneration);
  const value = readJsonFile(join(paths.layouts, layoutGeneration, 'manifest.json'));
  if (value === undefined) return undefined;
  try {
    const manifest = layoutManifestSchema.parse(value);
    if (manifest.generation !== layoutGeneration) throw new Error('generation mismatch');
    return manifest;
  } catch {
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite layout manifest is invalid.');
  }
}

export function writeSqliteRuntimeLayoutManifest(
  paths: SqliteRuntimeLayoutPaths,
  manifest: SqliteRuntimeLayoutManifest,
): void {
  const parsed = layoutManifestSchema.safeParse(manifest);
  if (!parsed.success)
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite layout manifest is invalid.');
  const generationRoot = join(paths.layouts, parsed.data.generation);
  ensureOwnerDirectory(generationRoot);
  writeAtomicJson(join(generationRoot, 'manifest.json'), parsed.data);
}

export function readSqliteRuntimeMigrationJournal(
  paths: SqliteRuntimeLayoutPaths,
): SqliteRuntimeMigrationJournal | undefined {
  const value = readJsonFile(paths.migrationJournal);
  if (value === undefined) return undefined;
  try {
    return migrationJournalSchema.parse(value);
  } catch {
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite migration journal is invalid.');
  }
}

export function writeSqliteRuntimeMigrationJournal(
  paths: SqliteRuntimeLayoutPaths,
  journal: SqliteRuntimeMigrationJournal,
): void {
  const parsed = migrationJournalSchema.safeParse(journal);
  if (!parsed.success)
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite migration journal is invalid.');
  writeAtomicJson(paths.migrationJournal, parsed.data);
}

export function readSqliteRuntimeMigrationFence(
  paths: SqliteRuntimeLayoutPaths,
): SqliteRuntimeMigrationFence | undefined {
  const value = readJsonFile(paths.migrationFence);
  if (value === undefined) return undefined;
  try {
    return migrationFenceSchema.parse(value);
  } catch {
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite migration fence is invalid.');
  }
}

export function writeSqliteRuntimeMigrationFence(
  paths: SqliteRuntimeLayoutPaths,
  fence: SqliteRuntimeMigrationFence,
): void {
  const parsed = migrationFenceSchema.safeParse(fence);
  if (!parsed.success)
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite migration fence is invalid.');
  writeAtomicJson(paths.migrationFence, parsed.data);
}

/**
 * Verify that an existing Store 7 writer is opening the one active generation.
 * A fresh target may be created before publication; every reopen must carry
 * this evidence or fail closed rather than silently opening a stale layout.
 */
export function assertSqliteWorkspaceStoreActive(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
  databasePath: string,
): SqliteRuntimeMigrationJournal {
  assertSqliteRuntimeWorkspaceBinding(binding);
  assertNoFollowDatabasePath(databasePath);
  const expectedPath = resolveSqliteWorkspaceStorePath(
    paths,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  if (resolve(databasePath) !== resolve(expectedPath)) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Store 7 writer path does not match its active Workspace generation.',
    );
  }
  let storeStat: ReturnType<typeof lstatSync>;
  try {
    storeStat = lstatSync(databasePath);
  } catch {
    throw new SqliteRuntimeLayoutError('blocked', 'Store 7 writer file is missing.');
  }
  if (
    storeStat.isSymbolicLink() ||
    !storeStat.isFile() ||
    storeStat.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((storeStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && storeStat.uid !== process.getuid())))
  ) {
    throw new SqliteRuntimeLayoutError(
      'permission',
      'Store 7 writer is not a private owner-only regular file.',
    );
  }
  const pointer = readSqliteActiveLayoutPointer(paths);
  if (!pointer || pointer.generation !== binding.layoutGeneration) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Store 7 writer generation is not the active layout.',
    );
  }
  const manifest = readSqliteRuntimeLayoutManifest(paths, binding.layoutGeneration);
  const manifestEntry = manifest?.workspaceStores.find(
    (entry) => entry.workerScopeId === binding.workerScopeId,
  );
  if (
    !manifest ||
    manifest.profile.storeSchemaVersion !== SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION ||
    manifest.profile.stateSchemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    manifest.profile.formatEpoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
    !manifestEntry
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Store 7 writer manifest does not contain its active Workspace store.',
    );
  }
  const journal = readSqliteRuntimeMigrationJournal(paths);
  const fence = readSqliteRuntimeMigrationFence(paths);
  const journalEntry = journal?.workspaceStoreDigests.find(
    (entry) => entry.workerScopeId === binding.workerScopeId,
  );
  if (
    !journal ||
    journal.targetLayoutGeneration !== binding.layoutGeneration ||
    !['pointer_switched', 'target_ready', 'committed'].includes(journal.pointerPhase) ||
    fence?.targetLayoutGeneration !== binding.layoutGeneration ||
    fence?.migrationNonce !== journal.migrationNonce ||
    !journalEntry ||
    journalEntry.digest !== manifestEntry.digest
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Store 7 writer transition evidence is incomplete or stale.',
    );
  }
  if (
    journal.targetWriteState === 'none' &&
    createHash('sha256').update(readFileSync(databasePath)).digest('hex') !== manifestEntry.digest
  ) {
    throw new SqliteRuntimeLayoutError(
      'blocked',
      'Store 7 writer does not match its pre-write manifest digest.',
    );
  }
  return journal;
}

/** Mark the generation written before the first Store 7 mutation. */
export function markSqliteWorkspaceStoreWritten(
  paths: SqliteRuntimeLayoutPaths,
  binding: SqliteRuntimeWorkspaceBinding,
  databasePath: string,
): void {
  const journal = assertSqliteWorkspaceStoreActive(paths, binding, databasePath);
  if (journal.targetWriteState === 'written') return;
  writeSqliteRuntimeMigrationJournal(paths, { ...journal, targetWriteState: 'written' });
}

export interface SqliteRuntimeLayoutCutover {
  prepareTarget(
    manifest: SqliteRuntimeLayoutManifest,
    journal: SqliteRuntimeMigrationJournal,
    fence: SqliteRuntimeMigrationFence,
  ): void;
  switchPointer(): void;
  markTargetWritten(): void;
  markTargetReady(): void;
  commit(): void;
  journal(): SqliteRuntimeMigrationJournal;
}

/**
 * Small crash-window state machine for copy-and-switch. It never copies data;
 * migration code owns that operation and calls these transitions only after
 * target validation. A written target can never automatically roll back.
 */
export function createSqliteRuntimeLayoutCutover(
  paths: SqliteRuntimeLayoutPaths,
): SqliteRuntimeLayoutCutover {
  let current = readSqliteRuntimeMigrationJournal(paths);

  const requireJournal = (): SqliteRuntimeMigrationJournal => {
    if (!current)
      throw new SqliteRuntimeLayoutError('blocked', 'SQLite migration journal is absent.');
    return current;
  };
  const save = (next: SqliteRuntimeMigrationJournal): void => {
    current = next;
    writeSqliteRuntimeMigrationJournal(paths, next);
  };

  return {
    prepareTarget: (manifest, journal, fence) => {
      if (journal.targetLayoutGeneration !== manifest.generation) {
        throw new SqliteRuntimeLayoutError(
          'corrupt',
          'SQLite target generation does not match its journal.',
        );
      }
      if (journal.targetWriteState !== 'none' || journal.pointerPhase !== 'source_active') {
        throw new SqliteRuntimeLayoutError(
          'busy',
          'SQLite migration target is not in a preparable phase.',
        );
      }
      if (
        fence.targetLayoutGeneration !== manifest.generation ||
        fence.migrationNonce !== journal.migrationNonce
      ) {
        throw new SqliteRuntimeLayoutError(
          'corrupt',
          'SQLite migration fence does not match its journal.',
        );
      }
      ensureOwnerDirectory(join(paths.layouts, manifest.generation));
      writeSqliteRuntimeLayoutManifest(paths, manifest);
      writeSqliteRuntimeMigrationFence(paths, fence);
      save({ ...journal, pointerPhase: 'target_prepared' });
    },
    switchPointer: () => {
      const journal = requireJournal();
      if (journal.pointerPhase !== 'target_prepared' || journal.targetWriteState !== 'none') {
        throw new SqliteRuntimeLayoutError(
          'blocked',
          'SQLite target is not ready for pointer switch.',
        );
      }
      const manifest = readSqliteRuntimeLayoutManifest(paths, journal.targetLayoutGeneration);
      if (
        !manifest ||
        manifest.catalogDigest !== journal.targetCatalogDigest ||
        JSON.stringify(manifest.workspaceStores) !== JSON.stringify(journal.workspaceStoreDigests)
      ) {
        throw new SqliteRuntimeLayoutError(
          'blocked',
          'SQLite target manifest does not match its migration journal.',
        );
      }
      writeSqliteActiveLayoutPointer(paths, {
        schema: SQLITE_RUNTIME_ACTIVE_LAYOUT_SCHEMA_,
        generation: journal.targetLayoutGeneration,
      });
      save({ ...journal, pointerPhase: 'pointer_switched' });
    },
    markTargetWritten: () => {
      const journal = requireJournal();
      if (
        !['pointer_switched', 'target_ready', 'committed'].includes(journal.pointerPhase) ||
        journal.targetWriteState !== 'none'
      ) {
        throw new SqliteRuntimeLayoutError(
          'blocked',
          'SQLite target write fence transition is invalid.',
        );
      }
      save({ ...journal, targetWriteState: 'written' });
    },
    markTargetReady: () => {
      const journal = requireJournal();
      if (journal.pointerPhase !== 'pointer_switched' && journal.pointerPhase !== 'target_ready') {
        throw new SqliteRuntimeLayoutError('blocked', 'SQLite target is not pointer-switched.');
      }
      const pointer = readSqliteActiveLayoutPointer(paths);
      if (!pointer || pointer.generation !== journal.targetLayoutGeneration) {
        throw new SqliteRuntimeLayoutError(
          'blocked',
          'SQLite active-layout pointer does not match its migration journal.',
        );
      }
      save({ ...journal, pointerPhase: 'target_ready' });
    },
    commit: () => {
      const journal = requireJournal();
      if (journal.pointerPhase !== 'target_ready') {
        throw new SqliteRuntimeLayoutError('blocked', 'SQLite target is not ready to commit.');
      }
      save({ ...journal, pointerPhase: 'committed' });
    },
    journal: () => requireJournal(),
  };
}

export function canRollbackSqliteRuntimeLayout(journal: SqliteRuntimeMigrationJournal): boolean {
  return (
    (journal.pointerPhase === 'target_prepared' && journal.targetWriteState === 'none') ||
    (journal.pointerPhase === 'pointer_switched' && journal.targetWriteState === 'none')
  );
}

function assertAbsolutePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    !isAbsolute(value) ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new SqliteRuntimeLayoutError(
      'invalid_path',
      'SQLite layout root must be an absolute path.',
    );
  }
  return value;
}

function assertGeneration(value: string): void {
  if (!generation.safeParse(value).success) {
    throw new SqliteRuntimeLayoutError('invalid_path', 'SQLite layout generation is invalid.');
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,128}$/u.test(value)) {
    throw new SqliteRuntimeLayoutError('invalid_path', `${label} is invalid.`);
  }
}

function ensureOwnerDirectory(path: string): void {
  const absolute = assertAbsolutePath(path);
  const parsed = parse(absolute);
  const tail = relative(parsed.root, absolute);
  let current = parsed.root;
  for (const segment of tail.split(sep).filter(Boolean)) {
    assertSafeSegment(segment, 'Layout path segment');
    current = join(current, segment);
    let created = false;
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      created = true;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SqliteRuntimeLayoutError(
        'permission',
        'SQLite layout directory is not a real directory.',
      );
    }
    // Existing ancestors may be owned by a system account (for example
    // /Users). Only the private target and directories created by this owner
    // receive the restrictive mode; never chmod a shared ancestor.
    if (created || current === absolute) chmodSync(current, 0o700);
    if (current === absolute && process.getuid && stat.uid !== process.getuid()) {
      throw new SqliteRuntimeLayoutError(
        'permission',
        'SQLite layout directory owner is unexpected.',
      );
    }
  }
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const stat = assertPrivateAuthorityFile(path, 'SQLite layout state');
  if (stat.size > 4 * 1024 * 1024)
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite layout state exceeds its size bound.');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new SqliteRuntimeLayoutError('corrupt', 'SQLite layout state JSON is invalid.');
  }
}

function writeAtomicJson(path: string, value: unknown): void {
  ensureOwnerDirectory(dirname(path));
  if (existsSync(path)) assertPrivateAuthorityFile(path, 'SQLite layout state');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    const temporaryStat = fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new SqliteRuntimeLayoutError(
        'permission',
        'SQLite layout temporary state is not a private regular file.',
      );
    }
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    fsyncParentDirectory(path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the exact target remains untouched.
    }
    if (error instanceof SqliteRuntimeLayoutError) throw error;
    throw new SqliteRuntimeStorageOpenError(
      'SQLite layout state could not be atomically published.',
    );
  }
}

interface LayoutAdmissionLease {
  release(): void;
}

function acquireLayoutAdmissionLease(paths: SqliteRuntimeLayoutPaths): LayoutAdmissionLease {
  ensureOwnerDirectory(paths.root);
  const path = join(paths.root, 'layout-admission.lock');
  const nonce = randomUUID();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${nonce}\n`, 'utf8');
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1) {
      throw new SqliteRuntimeLayoutError(
        'permission',
        'SQLite layout admission lock is not a private regular file.',
      );
    }
    closeSync(descriptor);
    descriptor = undefined;
    fsyncParentDirectory(path);
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        const current = assertPrivateAuthorityFile(path, 'SQLite layout admission lock');
        if (
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          readFileSync(path, 'utf8') !== `${nonce}\n`
        ) {
          throw new SqliteRuntimeLayoutError(
            'blocked',
            'SQLite layout admission lock identity changed.',
          );
        }
        unlinkSync(path);
        fsyncParentDirectory(path);
        released = true;
      },
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new SqliteRuntimeLayoutError('busy', 'SQLite layout admission is already active.');
    }
    throw error;
  }
}

function assertPrivateAuthorityFile(
  path: string,
  label: string,
): NonNullable<ReturnType<typeof lstatSync>> {
  const stat = lstatSync(path);
  if (stat === undefined) {
    throw new SqliteRuntimeLayoutError('permission', `${label} is unavailable.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SqliteRuntimeLayoutError('permission', `${label} is not a private regular file.`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new SqliteRuntimeLayoutError('permission', `${label} is not owner-only.`);
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    throw new SqliteRuntimeLayoutError('permission', `${label} owner is not the current user.`);
  }
  return stat;
}

function fsyncParentDirectory(path: string): void {
  // Windows directory durability requires the hosted write-through primitive;
  // do not pretend a POSIX directory descriptor is equivalent there.
  if (process.platform === 'win32') return;
  const descriptor = openSync(dirname(path), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
