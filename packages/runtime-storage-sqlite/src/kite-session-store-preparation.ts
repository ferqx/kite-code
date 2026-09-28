import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { assertCanonicalKiteDatabasePath } from './kite-home-runtime-file';
import { validateKiteSessionStoreContinuity } from './kite-session-continuity-validation';
import {
  acquireKiteSessionStoreMaintenance,
  type KiteSessionMaintenanceLock,
} from './kite-session-maintenance';
import {
  inspectKiteSessionStoreDatabase,
  KiteSessionStoreOpenError,
  type KiteSessionStorePreparationStage,
} from './kite-session-runtime-file';
import { createKiteSessionStoreCandidate } from './kite-session-store-candidate';
import {
  captureKiteSessionPublicationSource,
  inspectKiteSessionPublication,
  publishVerifiedKiteSessionCandidate,
  resumeKiteSessionPublication,
} from './kite-session-store-publication';
import { inspectKiteSessionStoreSources } from './kite-session-store-sources';
import type { SqliteRuntimeSnapshotCodec } from './preflight';

const ATTEMPT_NAME = 'preparation-attempt.json';
const ATTEMPT_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ATTEMPT_BYTES = 512;

interface PreparationAttempt {
  readonly version: 1;
  readonly status: 'attempt_started';
  readonly buildDigest: string;
  readonly sourceDigest: string;
}

/**
 * One bounded startup preparation for the observed Store 9–13 paths. It never runs from a
 * history query. Ordinary current-format startup only inspects metadata and known locations.
 */
export async function prepareKiteSessionStore<Event, State>(input: {
  readonly databasePath: string;
  /** Exact Service build identity; absent only for in-process callers without a release identity. */
  readonly buildId?: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly isSettledState: (state: State) => boolean;
  /** Service-owned admission: supported entrypoints gated and retired writers stopped. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Existing guards return void; managed guards also return a held lease.
  readonly assertRetiredWritersStopped: () => void | {
    revalidate(): void;
    release(): void;
  };
  readonly onProgress?: (stage: KiteSessionStorePreparationStage) => void | Promise<void>;
  /** One-shot prepublication decision; a committed intent must always be settled. */
  readonly beforePublication?: () => Promise<'commit' | 'cancel'>;
  readonly nowMs?: number;
}): Promise<{ readonly status: 'current' | 'prepared' | 'resumed' }> {
  let stage: KiteSessionStorePreparationStage = 'inspecting';
  const report = (next: KiteSessionStorePreparationStage): void => {
    stage = next;
    try {
      const result = input.onProgress?.(next);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Progress is observational; it cannot change Store publication.
    }
  };
  report('inspecting');
  try {
    const result = await prepare(input, report);
    report('ready');
    return result;
  } catch (error) {
    if (error instanceof KiteSessionStoreOpenError)
      throw new KiteSessionStoreOpenError(error.code, error.message, {
        cause: error,
        ...(error.compatibility ? { compatibility: error.compatibility } : {}),
        ...(error.admissionReason ? { admissionReason: error.admissionReason } : {}),
        stage,
      });
    if (isStorageSpaceFailure(error)) {
      throw new KiteSessionStoreOpenError(
        'store_insufficient_space',
        'Store preparation ran out of writable storage space; retained data must not be deleted.',
        { cause: error, stage },
      );
    }
    if (
      hasFailureCode(error, [
        'EACCES',
        'EPERM',
        'EROFS',
        'SQLITE_CANTOPEN',
        'SQLITE_PERM',
        'SQLITE_READONLY',
        'SQLITE_IOERR',
      ])
    ) {
      throw new KiteSessionStoreOpenError(
        'store_access_denied',
        'Store preparation could not access required data or recovery assets.',
        { cause: error, stage },
      );
    }
    if (hasFailureCode(error, ['SQLITE_CORRUPT', 'SQLITE_NOTADB'])) {
      throw new KiteSessionStoreOpenError(
        'store_corrupt',
        'Store preparation encountered corrupt SQLite data.',
        { cause: error, stage },
      );
    }
    throw new KiteSessionStoreOpenError(
      'store_history_reconciliation_required',
      'Session data preparation could not complete. Existing data and recovery assets were retained; retry startup after resolving the reported compatibility condition.',
      { cause: error, stage },
    );
  }
}

async function prepare<Event, State>(
  input: Parameters<typeof prepareKiteSessionStore<Event, State>>[0],
  report: (stage: KiteSessionStorePreparationStage) => void,
): Promise<{ readonly status: 'current' | 'prepared' | 'resumed' }> {
  const canonicalPath = assertCanonicalKiteDatabasePath(input.databasePath, 'kite-session.sqlite');
  const pending = inspectKiteSessionPublication(canonicalPath);
  const historical =
    pending.status === 'pending'
      ? pending.sourcePaths
      : inspectKiteSessionStoreSources(canonicalPath);
  if (pending.status === 'none' && historical.length === 0) {
    try {
      inspectKiteSessionStoreDatabase(canonicalPath, false);
      return { status: 'current' };
    } catch (error) {
      // Only exact retired epochs reach private candidate conversion.
      if (
        !(error instanceof KiteSessionStoreOpenError) ||
        !(
          (error.compatibility?.actualSchema === 11 &&
            error.compatibility.actualEpoch === 'kite-session-accepted-runs-2026-09-15') ||
          (error.compatibility?.actualSchema === 11 &&
            error.compatibility.actualEpoch === 'kite-session-lineage-2026-09-24') ||
          (error.compatibility?.actualSchema === 12 &&
            error.compatibility.actualEpoch === 'kite-session-child-approval-2026-09-25') ||
          (error.compatibility?.actualSchema === 13 &&
            error.compatibility.actualEpoch === 'kite-session-cross-followup-2026-09-25') ||
          (error.compatibility?.actualSchema === 10 &&
            error.compatibility.actualEpoch === 'kite-session-app-server-2026-09-02')
        )
      )
        throw error;
    }
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new KiteSessionStoreOpenError(
      'store_migration_required',
      'Automatic Store preparation is not qualified on this platform. Keep this data and use a supported Runtime recovery entrypoint.',
    );
  }
  const paths = [...new Set([canonicalPath, ...historical])].sort();
  const locks = new Map<string, KiteSessionMaintenanceLock>();
  let admission: ReturnType<typeof input.assertRetiredWritersStopped> | null = null;
  try {
    report('acquiring_maintenance');
    for (const path of paths)
      locks.set(path, acquireKiteSessionStoreMaintenance(path, 'exclusive'));
    const canonicalMaintenance = locks.get(canonicalPath)!;
    admission = input.assertRetiredWritersStopped();
    const validate = (database: Database): void => {
      validateKiteSessionStoreContinuity({ database, codec: input.codec });
    };
    const pendingAfterLock = inspectKiteSessionPublication(canonicalPath);
    if (pendingAfterLock.status === 'pending') {
      const pendingPaths = [...new Set([canonicalPath, ...pendingAfterLock.sourcePaths])].sort();
      if (JSON.stringify(pendingPaths) !== JSON.stringify(paths)) {
        throw new KiteSessionStoreOpenError(
          'store_busy',
          'Store publication sources changed before maintenance admission; retry startup.',
        );
      }
      report('publishing');
      resumeKiteSessionPublication({
        canonicalPath,
        canonicalMaintenance,
        validatePublished: validate,
        sourceMaintenance: paths.map((databasePath) => ({
          databasePath,
          maintenance: locks.get(databasePath)!,
        })),
      });
      clearCompletedAttempt(dirname(canonicalPath));
      return { status: 'resumed' };
    }
    report('preparing');
    // Recheck discovery after obtaining all locks. Another preparer may have completed first.
    const rediscovered = inspectKiteSessionStoreSources(canonicalPath);
    if (JSON.stringify(rediscovered) !== JSON.stringify(historical)) {
      throw new KiteSessionStoreOpenError(
        'store_busy',
        'Session data sources changed while maintenance admission was acquired. Retry startup.',
      );
    }
    const sources = paths.map((databasePath) => ({
      databasePath,
      maintenance: locks.get(databasePath)!,
      files: captureKiteSessionPublicationSource(canonicalPath, databasePath),
    }));
    if (
      sources.some(
        (source) =>
          (source.files.main?.size ?? 0) === 0 &&
          (source.files.wal !== null || source.files.shm !== null),
      )
    ) {
      throw new Error('A Store with sidecars cannot be omitted because its main file is empty.');
    }
    const nonempty = sources.filter(
      (source) => source.files.main !== null && source.files.main.size > 0,
    );
    if (sources.some((source) => source.files.main === null && source.files.wal !== null)) {
      throw new Error('A historical Store main file is missing while its WAL remains.');
    }
    if (nonempty.length === 0)
      throw new Error('Historical data was discovered without a readable Store.');
    const sourceBytes = sources.reduce(
      (total, source) =>
        total + BigInt(source.files.main?.size ?? 0) + BigInt(source.files.wal?.size ?? 0),
      0n,
    );
    const recoveryRoot = join(dirname(canonicalPath), 'session-store-recovery');
    const attempt = input.buildId ? preparationAttempt(input.buildId, sources) : undefined;
    if (attempt) {
      ensurePrivateDirectory(recoveryRoot);
      const existing = readPreparationAttempt(recoveryRoot);
      if (
        existing?.buildDigest === attempt.buildDigest &&
        existing.sourceDigest === attempt.sourceDigest
      ) {
        throw new KiteSessionStoreOpenError(
          'store_preparation_retry_blocked',
          'This Service build already attempted preparation of these exact Store bytes. Retained recovery assets are unchanged; retry with a corrected build or changed source.',
        );
      }
    }
    const space = statfsSync(dirname(canonicalPath), { bigint: true });
    // Budget for immutable backups, converted sources, merged candidate and SQLite scratch.
    // This conservative preflight does not replace handling ENOSPC at every write boundary.
    if (space.bavail * space.bsize < sourceBytes * 6n + 64n * 1024n * 1024n) {
      throw new KiteSessionStoreOpenError(
        'store_insufficient_space',
        'Insufficient free space for verified Store recovery assets and candidates.',
      );
    }
    ensurePrivateDirectory(recoveryRoot);
    if (attempt) writePreparationAttempt(recoveryRoot, attempt);
    const migrationDirectory = join(recoveryRoot, `migration-${randomBytes(12).toString('hex')}`);
    let admissionRevalidationFailed = false;
    try {
      mkdirSync(migrationDirectory, { mode: 0o700 });
      fsyncDirectory(migrationDirectory);
      fsyncDirectory(recoveryRoot);
      const candidate = createKiteSessionStoreCandidate({
        sources: nonempty,
        migrationDirectory,
        codec: input.codec,
        isSettledState: input.isSettledState,
        validate,
        nowMs: input.nowMs ?? Date.now(),
      });
      if ((await input.beforePublication?.()) === 'cancel') {
        throw new KiteSessionStoreOpenError(
          'store_preparation_cancelled',
          'Store preparation was cancelled before publication.',
        );
      }
      try {
        if (admission) admission.revalidate();
        else admission = input.assertRetiredWritersStopped();
      } catch (error) {
        // Writer admission is external and may recover without a new Service build.
        admissionRevalidationFailed = true;
        throw error;
      }
      const publicationSources = sources.map((source) => {
        const files = captureKiteSessionPublicationSource(canonicalPath, source.databasePath);
        // SQLite's read locks may update shared-memory bookkeeping. The committed main/WAL
        // identity and bytes must remain unchanged; capture SHM only after all readers closed.
        if (
          JSON.stringify([files.main, files.wal]) !==
          JSON.stringify([source.files.main, source.files.wal])
        ) {
          throw new Error('Original Store changed while its candidate was prepared.');
        }
        return { ...source, files };
      });
      report('publishing');
      publishVerifiedKiteSessionCandidate({
        canonicalPath,
        canonicalMaintenance,
        migrationDirectory,
        candidatePath: candidate.databasePath,
        candidateManifest: candidate.manifest,
        validatePublished: validate,
        sources: publicationSources,
      });
      if (attempt) clearPreparationAttempt(recoveryRoot, attempt);
      return { status: 'prepared' };
    } catch (error) {
      if (
        attempt &&
        (admissionRevalidationFailed || isTransientPreparationFailure(error)) &&
        inspectKiteSessionPublication(canonicalPath).status === 'none'
      ) {
        clearPreparationAttempt(recoveryRoot, attempt);
      }
      throw error;
    }
  } finally {
    try {
      for (const lock of [...locks.values()].reverse()) lock.release();
    } finally {
      admission?.release();
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(path);
    fsyncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync.native(path) !== path
  ) {
    throw new Error('Session recovery asset directory is not private and canonical.');
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function preparationAttempt(
  buildId: string,
  sources: readonly {
    readonly databasePath: string;
    readonly files: ReturnType<typeof captureKiteSessionPublicationSource>;
  }[],
): PreparationAttempt {
  if (!buildId || buildId.length > 4_096 || /\p{Cc}/u.test(buildId))
    throw new Error('Store preparation requires a bounded Service build identity.');
  return {
    version: 1,
    status: 'attempt_started',
    buildDigest: createHash('sha256').update(buildId).digest('hex'),
    sourceDigest: createHash('sha256')
      .update(
        JSON.stringify(
          sources.map((source) => ({
            path: source.databasePath,
            main: source.files.main?.sha256 ?? null,
            wal: source.files.wal?.sha256 ?? null,
          })),
        ),
      )
      .digest('hex'),
  };
}

function readPreparationAttempt(recoveryRoot: string): PreparationAttempt | undefined {
  const path = join(recoveryRoot, ATTEMPT_NAME);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_ATTEMPT_BYTES ||
    realpathSync.native(path) !== path
  ) {
    throw new Error('Store preparation attempt marker is not private and canonical.');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Store preparation attempt marker is malformed.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['buildDigest', 'sourceDigest', 'status', 'version'])
  ) {
    throw new Error('Store preparation attempt marker is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.status !== 'attempt_started' ||
    typeof record.buildDigest !== 'string' ||
    !ATTEMPT_DIGEST.test(record.buildDigest) ||
    typeof record.sourceDigest !== 'string' ||
    !ATTEMPT_DIGEST.test(record.sourceDigest)
  ) {
    throw new Error('Store preparation attempt marker is malformed.');
  }
  return record as unknown as PreparationAttempt;
}

function writePreparationAttempt(recoveryRoot: string, attempt: PreparationAttempt): void {
  // A durable marker must precede the first large backup, including process-kill windows.
  const temp = join(recoveryRoot, `.preparation-attempt-${randomBytes(12).toString('hex')}.tmp`);
  writeFileSync(temp, `${JSON.stringify(attempt)}\n`, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(recoveryRoot);
  renameSync(temp, join(recoveryRoot, ATTEMPT_NAME));
  fsyncDirectory(recoveryRoot);
}

function clearPreparationAttempt(recoveryRoot: string, expected: PreparationAttempt): void {
  const current = readPreparationAttempt(recoveryRoot);
  if (
    !current ||
    current.buildDigest !== expected.buildDigest ||
    current.sourceDigest !== expected.sourceDigest
  ) {
    throw new Error('Store preparation attempt marker changed during maintenance.');
  }
  unlinkSync(join(recoveryRoot, ATTEMPT_NAME));
  fsyncDirectory(recoveryRoot);
}

function clearCompletedAttempt(canonicalRoot: string): void {
  const recoveryRoot = join(canonicalRoot, 'session-store-recovery');
  if (!lstatSync(recoveryRoot, { throwIfNoEntry: false })) return;
  ensurePrivateDirectory(recoveryRoot);
  const attempt = readPreparationAttempt(recoveryRoot);
  if (attempt) clearPreparationAttempt(recoveryRoot, attempt);
}

function isTransientPreparationFailure(error: unknown): boolean {
  if (
    error instanceof KiteSessionStoreOpenError &&
    [
      'store_preparation_cancelled',
      'store_busy',
      'store_insufficient_space',
      'store_access_denied',
    ].includes(error.code)
  )
    return true;
  return (
    isStorageSpaceFailure(error) ||
    hasFailureCode(error, [
      'EINTR',
      'ETIMEDOUT',
      'EBUSY',
      'EACCES',
      'EPERM',
      'EROFS',
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_CANTOPEN',
      'SQLITE_PERM',
      'SQLITE_READONLY',
      'SQLITE_IOERR',
    ])
  );
}

function isStorageSpaceFailure(error: unknown): boolean {
  for (let depth = 0; depth < 8 && typeof error === 'object' && error !== null; depth++) {
    const detail = error as { code?: unknown; cause?: unknown };
    if (detail.code === 'ENOSPC' || detail.code === 'EDQUOT' || detail.code === 'SQLITE_FULL')
      return true;
    error = detail.cause;
  }
  return false;
}

function hasFailureCode(error: unknown, prefixes: readonly string[]): boolean {
  for (let depth = 0; depth < 8 && typeof error === 'object' && error !== null; depth++) {
    const detail = error as { code?: unknown; cause?: unknown };
    const code = String(detail.code ?? '');
    if (prefixes.some((prefix) => code === prefix || code.startsWith(`${prefix}_`))) return true;
    error = detail.cause;
  }
  return false;
}
