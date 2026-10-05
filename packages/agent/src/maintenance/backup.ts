import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  opendirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { artifactPath, readPublishedArtifactChunks } from '../artifacts-files';
import { canonicalJson } from '../json';
import { acquireProfileAccess, assertNoSymlinkPath } from '../platform/profile';
import { selectProfile } from '../platform/profile-identity';
import { initializeDefaultSqliteEngine } from '../sqlite-engine';
import { captureAssets, verifyAssets } from './assets';
import {
  checkpoint,
  contains,
  decimal,
  fingerprint,
  openPrivate,
  privateDirectory,
  syncDirectory,
  syncFile,
  withPrivateDatabaseSnapshot,
  writeAll,
} from './files';
import { excluded, mediaLines, parseManifest, readManifest } from './manifest';
import { capture, mediaRows, openBackupDatabase } from './sqlite';
import {
  type BackupManifest,
  type CreateProfileBackupInput,
  type InspectProfileBackupInput,
  MaintenanceError,
  type ProfileBackup,
} from './types';

function platform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new MaintenanceError('maintenance_platform_unsupported');
}
function sourceFiles(databasePath: string, signal?: AbortSignal) {
  return ['', '-wal'].map((suffix) =>
    existsSync(databasePath + suffix) ? fingerprint(databasePath + suffix, signal) : null,
  );
}
async function copyMedia(
  source: string,
  target: string,
  hash: string,
  size: string,
  signal?: AbortSignal,
) {
  closeSync(openPrivate(artifactPath(source, hash)));
  const path = artifactPath(target, hash);
  privateDirectory(dirname(path), true);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let sinceYield = 0;
    for (const chunk of readPublishedArtifactChunks(source, hash, size)) {
      signal?.throwIfAborted();
      writeAll(fd, chunk);
      sinceYield += chunk.byteLength;
      if (sinceYield >= 1024 * 1024) {
        await checkpoint(signal);
        sinceYield = 0;
      }
    }
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}
function exactTree(directory: string, database: Database, manifest: BackupManifest): void {
  const top = opendirSync(directory);
  try {
    for (let item = top.readSync(); item; item = top.readSync()) {
      if (
        ![
          'core.db',
          'media.jsonl',
          'blobs',
          'ready.json',
          ...(manifest.assets.configuration.present ? ['config.jsonc'] : []),
          ...(manifest.assets.skillWorkflowConfiguration.present ? ['skill-workflow.jsonc'] : []),
          ...(manifest.assets.desktopUi.present ? ['desktop-private'] : []),
          ...(manifest.assets.tuiUi.present ||
          manifest.assets.tuiPreferences.present ||
          manifest.assets.tuiRecovery?.present ||
          manifest.assets.callerIntents?.present ||
          manifest.assets.fileRecoveryIntents?.present ||
          manifest.assets.mcpSelectionIntents?.present ||
          manifest.assets.mcpConnectionIntents?.present ||
          manifest.assets.mcpSourceApprovalIntents?.present ||
          manifest.assets.mcpReconnectionIntents?.present ||
          manifest.assets.mcpSourceMutationIntents?.present
            ? ['ui']
            : []),
        ].includes(item.name)
      )
        throw new MaintenanceError('backup_unexpected_asset');
      if (item.name === 'desktop-private' || item.name === 'ui') {
        privateDirectory(join(directory, item.name));
        const children = opendirSync(join(directory, item.name));
        try {
          for (let child = children.readSync(); child; child = children.readSync())
            if (
              !(
                item.name === 'ui'
                  ? [
                      ...(manifest.assets.tuiUi.present ? ['tui.json'] : []),
                      ...(manifest.assets.tuiRecovery?.present ? ['recovery.json'] : []),
                      ...(manifest.assets.callerIntents?.present ? ['caller-intents.json'] : []),
                      ...(manifest.assets.fileRecoveryIntents?.present
                        ? ['file-recovery-intents.json']
                        : []),
                      ...(manifest.assets.tuiPreferences.present ? ['preferences.jsonc'] : []),
                      ...(manifest.assets.mcpSourceMutationIntents?.present
                        ? ['mcp-source-mutation-intents.json']
                        : []),
                      ...(manifest.assets.mcpReconnectionIntents?.present ||
                      manifest.assets.mcpSourceMutationIntents?.present
                        ? ['mcp-reconnection-intents.json']
                        : []),
                      ...(manifest.assets.mcpSourceApprovalIntents?.present
                        ? ['mcp-source-approval-intents.json']
                        : []),
                      ...(manifest.assets.mcpConnectionIntents?.present
                        ? ['mcp-connection-intents.json']
                        : []),
                      ...(manifest.assets.mcpSelectionIntents?.present
                        ? ['mcp-selection-intents.json']
                        : []),
                    ]
                  : ['data.sqlite']
              ).includes(child.name)
            )
              throw new MaintenanceError('backup_unexpected_asset');
        } finally {
          children.closeSync();
        }
      }
      if (item.name === 'blobs') {
        const blobs = join(directory, 'blobs');
        privateDirectory(blobs);
        const prefixes = opendirSync(blobs);
        try {
          for (let prefix = prefixes.readSync(); prefix; prefix = prefixes.readSync()) {
            if (!/^[a-f0-9]{2}$/.test(prefix.name))
              throw new MaintenanceError('backup_unexpected_asset');
            const path = join(blobs, prefix.name);
            privateDirectory(path);
            const files = opendirSync(path);
            try {
              for (let file = files.readSync(); file; file = files.readSync()) {
                if (
                  !/^[a-f0-9]{64}$/.test(file.name) ||
                  file.name.slice(0, 2) !== prefix.name ||
                  !database.query('SELECT 1 FROM blob_ref WHERE blob_hash=? LIMIT 1').get(file.name)
                )
                  throw new MaintenanceError('backup_unexpected_asset');
              }
            } finally {
              files.closeSync();
            }
          }
        } finally {
          prefixes.closeSync();
        }
      }
    }
  } finally {
    top.closeSync();
  }
}
async function verify(
  directory: string,
  manifest: BackupManifest,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const databasePath = join(directory, manifest.database.path);
  if (
    canonicalJson(fingerprint(databasePath, signal)) !==
    canonicalJson({ sha256: manifest.database.sha256, byteLength: manifest.database.byteLength })
  )
    throw new MaintenanceError('backup_database_mismatch');
  if (
    canonicalJson(fingerprint(join(directory, manifest.media.inventory), signal)) !==
    canonicalJson({ sha256: manifest.media.sha256, byteLength: manifest.media.byteLength })
  )
    throw new MaintenanceError('backup_inventory_mismatch');
  const database = openBackupDatabase(databasePath);
  try {
    database.run('PRAGMA query_only=ON');
    const actual = capture(database);
    if (
      actual.storeId !== manifest.source.storeId ||
      actual.formatMajor !== manifest.source.formatMajor ||
      actual.snapshotCursor !== manifest.source.snapshotCursor ||
      actual.migrationChecksum !== manifest.source.migrationChecksum
    )
      throw new MaintenanceError('backup_database_mismatch');
    const rows = mediaRows(database),
      lines = mediaLines(join(directory, manifest.media.inventory));
    let blobs = 0n,
      refs = 0n;
    try {
      for (const row of rows) {
        signal?.throwIfAborted();
        const line = lines.next();
        if (line.done || canonicalJson(line.value) !== canonicalJson({ ...row }))
          throw new MaintenanceError('backup_inventory_mismatch');
        decimal(row.size);
        decimal(row.referenceCount);
        closeSync(openPrivate(artifactPath(directory, row.hash)));
        let work = 0;
        for (const chunk of readPublishedArtifactChunks(directory, row.hash, row.size)) {
          work += chunk.byteLength;
          if (work >= 1024 * 1024) {
            await checkpoint(signal);
            work = 0;
          }
        }
        blobs++;
        refs += BigInt(row.referenceCount);
        await checkpoint(signal);
      }
      if (
        !lines.next().done ||
        String(blobs) !== manifest.media.blobCount ||
        String(refs) !== manifest.media.referenceCount
      )
        throw new MaintenanceError('backup_inventory_mismatch');
    } finally {
      rows.return?.();
      lines.return(undefined);
    }
    verifyAssets(directory, manifest.assets, signal);
    exactTree(directory, database, manifest);
  } finally {
    database.close(true);
  }
  if (
    canonicalJson(fingerprint(databasePath, signal)) !==
      canonicalJson({
        sha256: manifest.database.sha256,
        byteLength: manifest.database.byteLength,
      }) ||
    canonicalJson(fingerprint(join(directory, manifest.media.inventory), signal)) !==
      canonicalJson({ sha256: manifest.media.sha256, byteLength: manifest.media.byteLength })
  )
    throw new MaintenanceError('backup_content_changed');
}

/** Only this invocation's private staging is removed on failure. Source files are never modified. */
export async function createProfileBackup(input: CreateProfileBackupInput): Promise<ProfileBackup> {
  initializeDefaultSqliteEngine();
  platform();
  input.signal?.throwIfAborted();
  const selection = selectProfile(input.profile);
  const destination = resolve(input.destinationRoot);
  assertNoSymlinkPath(destination);
  if (
    contains(selection.profilePath, destination) ||
    contains(join(selection.dataRoot, '.coordination'), destination)
  )
    throw new MaintenanceError('backup_destination_invalid');
  // The same stable OS object is held before inspecting the replaceable profile.
  const access = acquireProfileAccess(input.profile, 'exclusive');
  let staging: string | undefined;
  let published = false;
  try {
    privateDirectory(access.profilePath);
    if (existsSync(`${access.databasePath}-journal`))
      throw new MaintenanceError('backup_source_journal_present');
    if (existsSync(`${access.databasePath}-shm`))
      closeSync(openPrivate(`${access.databasePath}-shm`));
    const before = sourceFiles(access.databasePath, input.signal);
    const parent = privateDirectory(destination, true);
    staging = join(parent, `.backup-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    const candidatePath = join(staging, 'core.db');
    for (const suffix of ['-wal', '-shm']) assertNoSymlinkPath(access.databasePath + suffix);
    const { sourceCapture, engine } = await withPrivateDatabaseSnapshot(
      access.databasePath,
      join(staging, `.source-${randomUUID()}`),
      (databasePath) => {
        const source = openBackupDatabase(databasePath);
        try {
          const sourceCapture = capture(source);
          const engine = source
            .query<{ version: string; sourceId: string }, []>(
              'SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId',
            )
            .get()!;
          source.query('VACUUM INTO ?').run(candidatePath);
          if (canonicalJson(capture(source)) !== canonicalJson(sourceCapture))
            throw new MaintenanceError('backup_source_changed');
          return { sourceCapture, engine };
        } finally {
          source.close(true);
        }
      },
      input.signal,
    );
    chmodSync(candidatePath, 0o600);
    initializeDefaultSqliteEngine();
    const normalize = new Database(
      candidatePath,
      sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      const journal = normalize
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode=DELETE')
        .get();
      if (journal?.journal_mode.toLowerCase() !== 'delete')
        throw new MaintenanceError('backup_database_invalid');
    } finally {
      normalize.close(true);
    }
    await checkpoint(input.signal);
    const candidate = openBackupDatabase(candidatePath);
    let blobs = 0n,
      refs = 0n;
    const inventoryPath = join(staging, 'media.jsonl');
    const inventory = openSync(
      inventoryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      candidate.run('PRAGMA query_only=ON');
      if (canonicalJson(capture(candidate)) !== canonicalJson(sourceCapture))
        throw new MaintenanceError('backup_database_mismatch');
      for (const row of mediaRows(candidate)) {
        decimal(row.size);
        decimal(row.referenceCount);
        await copyMedia(access.profilePath, staging, row.hash, row.size, input.signal);
        writeAll(inventory, Buffer.from(`${JSON.stringify(row)}\n`));
        blobs++;
        refs += BigInt(row.referenceCount);
        await checkpoint(input.signal);
      }
      fsyncSync(inventory);
    } finally {
      closeSync(inventory);
      candidate.close(true);
    }
    const assets = await captureAssets(access.profilePath, staging, input.signal);
    const manifest = parseManifest({
      version: assets.mcpSourceMutationIntents
        ? 12
        : assets.mcpReconnectionIntents
          ? 11
          : assets.mcpSourceApprovalIntents
            ? 10
            : assets.mcpConnectionIntents
              ? 9
              : assets.mcpSelectionIntents
                ? 8
                : assets.desktopUi.format?.userVersion === 5
                  ? 7
                  : assets.fileRecoveryIntents
                    ? 6
                    : 5,
      kind: 'profile_backup',
      createdAt: new Date().toISOString(),
      source: { ...sourceCapture, profileAccessKey: access.profileAccessKey },
      engine,
      database: { path: 'core.db', ...fingerprint(candidatePath, input.signal) },
      media: {
        inventory: 'media.jsonl',
        ...fingerprint(inventoryPath, input.signal),
        blobCount: decimal(String(blobs)),
        referenceCount: decimal(String(refs)),
      },
      assets,
      consistency: 'sqlite_snapshot_with_verified_media_and_separate_assets',
      excluded,
    });
    await verify(staging, manifest, input.signal);
    const after = sourceFiles(access.databasePath, input.signal);
    if (canonicalJson(before) !== canonicalJson(after))
      throw new MaintenanceError('backup_source_changed');
    syncFile(candidatePath);
    syncFile(inventoryPath);
    syncDirectory(staging);
    input.signal?.throwIfAborted();
    writeFileSync(join(staging, 'ready.json.tmp'), `${JSON.stringify(manifest)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    syncFile(join(staging, 'ready.json.tmp'));
    renameSync(join(staging, 'ready.json.tmp'), join(staging, 'ready.json'));
    syncDirectory(staging);
    const directory = join(parent, `backup-${randomUUID()}`);
    // A unique generated name avoids replacing a caller's existing backup.
    if (existsSync(directory)) throw new MaintenanceError('backup_destination_invalid');
    renameSync(staging, directory);
    staging = directory;
    syncDirectory(parent);
    published = true;
    return { directory, manifest };
  } finally {
    try {
      if (staging && !published) rmSync(staging, { recursive: true, force: true });
    } finally {
      access.lock.release();
    }
  }
}
/** Reads only this selected immutable backup. A ready marker alone is never sufficient. */
export async function inspectProfileBackup(
  input: InspectProfileBackupInput,
): Promise<ProfileBackup> {
  platform();
  input.signal?.throwIfAborted();
  const directory = privateDirectory(input.directory);
  if (!existsSync(join(directory, 'ready.json'))) throw new MaintenanceError('backup_not_ready');
  const manifest = readManifest(join(directory, 'ready.json'));
  await verify(directory, manifest, input.signal);
  const after = readManifest(join(directory, 'ready.json'));
  if (canonicalJson(manifest as never) !== canonicalJson(after as never))
    throw new MaintenanceError('backup_content_changed');
  return { directory, manifest };
}
