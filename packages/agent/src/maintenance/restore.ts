import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { artifactPath } from '../artifacts-files';
import { canonicalJson } from '../json';
import {
  acquireProfileMaintenanceAccess,
  type ProfileOptions,
  selectProfile,
} from '../platform/profile';
import { initializeDefaultSqliteEngine } from '../sqlite-engine';
import type { Json } from '../storage/types';
import { restoreAssets } from './assets';
import { inspectProfileBackup } from './backup';
import {
  checkpoint,
  closePrivate as closeSync,
  copyWindowsMedia,
  fingerprint,
  movePrivateEntry,
  openPrivate,
  privateDirectory,
  syncDirectory,
  syncFile,
  writeAll,
} from './files';
import { parseManifest } from './manifest';
import { capture, mediaRows, openBackupDatabase } from './sqlite';
import {
  MaintenanceError,
  type ProfileRestoreJournal,
  type ProfileRestoreResult,
  type RestoreProfileBackupInput,
} from './types';

function supported() {
  if (!['darwin', 'linux', 'win32'].includes(process.platform))
    throw new MaintenanceError('maintenance_platform_unsupported');
}
function digestTree(directory: string): string {
  privateDirectory(directory);
  const digest = createHash('sha256');
  function visit(path: string, relative: string) {
    const entries = opendirSync(path);
    const names: string[] = [];
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync())
        names.push(entry.name);
    } finally {
      entries.closeSync();
    }
    for (const name of names.sort()) {
      const target = join(path, name),
        key = `${relative}${name}`;
      const readOnly = /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key);
      const fd = opendirOrFile(target, readOnly);
      if (fd === 'directory') {
        privateDirectory(target);
        digest.update(JSON.stringify([key, 'directory', lstatSync(target).mode & 0o777]));
        visit(target, `${key}/`);
      } else {
        digest.update(
          JSON.stringify([
            key,
            lstatSync(target).mode & 0o777,
            fingerprint(target, undefined, readOnly),
          ]),
        );
      }
    }
  }
  visit(directory, '');
  return digest.digest('hex');
}
function opendirOrFile(path: string, readOnly: boolean): 'directory' | 'file' {
  // lstat does not follow a replacement or authorize a file read.
  const stat = lstatSync(path);
  if (stat.isDirectory()) return 'directory';
  closeSync(openPrivate(path, readOnly));
  return 'file';
}
async function copyFile(source: string, destination: string, signal?: AbortSignal) {
  const input = openPrivate(source);
  let output: number | undefined;
  try {
    output = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.alloc(65536);
    let sinceYield = 0;
    for (;;) {
      signal?.throwIfAborted();
      const length = readSync(input, bytes, 0, bytes.length, null);
      if (!length) break;
      writeAll(output, bytes.subarray(0, length));
      sinceYield += length;
      if (sinceYield >= 1024 * 1024) {
        await checkpoint(signal);
        sinceYield = 0;
      }
    }
    fsyncSync(output);
  } finally {
    try {
      if (output !== undefined) closeSync(output);
    } finally {
      closeSync(input);
    }
  }
  if (process.platform === 'win32') syncFile(destination);
}
function journalPath(profile: ReturnType<typeof selectProfile>) {
  return join(profile.coordinationPath, 'restore-journal.json');
}
function saveJournal(profile: ReturnType<typeof selectProfile>, journal: ProfileRestoreJournal) {
  const temporary = join(profile.coordinationPath, `restore-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600, flag: 'wx' });
  syncFile(temporary);
  movePrivateEntry(temporary, journalPath(profile), true);
  syncDirectory(profile.coordinationPath);
}
function readJournal(profile: ReturnType<typeof selectProfile>): ProfileRestoreJournal | null {
  if (!existsSync(journalPath(profile))) return null;
  const fd = openPrivate(journalPath(profile));
  let value: unknown;
  try {
    const bytes = Buffer.alloc(32769);
    let offset = 0;
    for (;;) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!length) break;
      offset += length;
      if (offset > 32768) throw new MaintenanceError('restore_invalid_journal');
    }
    value = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
  } finally {
    closeSync(fd);
  }
  const row = value as ProfileRestoreJournal;
  if (
    !row ||
    Object.keys(row).sort().join(',') !==
      [
        'version',
        'restoreId',
        'profileAccessKey',
        'phase',
        'expectedStoreId',
        'newStoreId',
        'backupManifest',
        'stagingName',
        'preservedName',
        'originalDigest',
        'candidateDigest',
      ]
        .sort()
        .join(',') ||
    row.version !== 1 ||
    row.profileAccessKey !== profile.profileAccessKey ||
    !/^[a-f0-9-]{36}$/.test(row.restoreId) ||
    !['prepared', 'old_moved', 'published', 'verified'].includes(row.phase) ||
    typeof row.expectedStoreId !== 'string' ||
    !row.expectedStoreId ||
    typeof row.newStoreId !== 'string' ||
    !row.newStoreId ||
    row.expectedStoreId === row.newStoreId ||
    row.stagingName !== `.restore-${row.restoreId}` ||
    row.preservedName !== `.preserved-${row.restoreId}` ||
    !/^[a-f0-9]{64}$/.test(row.originalDigest) ||
    !/^[a-f0-9]{64}$/.test(row.candidateDigest)
  )
    throw new MaintenanceError('restore_invalid_journal');
  parseManifest(row.backupManifest);
  return row;
}
function storeId(path: string) {
  const db = openBackupDatabase(join(path, 'core.db'));
  try {
    return capture(db).storeId;
  } finally {
    db.close(true);
  }
}
function matches(path: string, digest: string, identity: string): boolean {
  return existsSync(path) && digestTree(path) === digest && storeId(path) === identity;
}
function clearJournal(profile: ReturnType<typeof selectProfile>) {
  rmSync(journalPath(profile));
  syncDirectory(profile.coordinationPath);
}
function journalDigest(journal: ProfileRestoreJournal) {
  return createHash('sha256')
    .update(canonicalJson(journal as unknown as Json))
    .digest('hex');
}
export function inspectProfileRestore(input: {
  profile: ProfileOptions;
}): { journal: ProfileRestoreJournal; digest: string } | null {
  supported();
  const journal = readJournal(selectProfile(input.profile));
  return journal ? { journal, digest: journalDigest(journal) } : null;
}
/** Internal deterministic fault-injection seam; public API has no callback or environment bypass. */
export async function runProfileRestore(
  input: RestoreProfileBackupInput,
  observe?: (point: string) => Promise<void>,
): Promise<ProfileRestoreResult> {
  supported();
  input.signal?.throwIfAborted();
  if (input.intent !== 'replace_with_selected_backup' || !input.expectedStoreId)
    throw new MaintenanceError('restore_intent_required');
  const profile = selectProfile(input.profile);
  // No target profile or empty database is initialized by this preflight.
  privateDirectory(profile.profilePath);
  const selected = {
    directory: privateDirectory(input.backup.directory),
    manifest: structuredClone(parseManifest(input.backup.manifest)),
  };
  initializeDefaultSqliteEngine();
  const access = acquireProfileMaintenanceAccess(input.profile);
  let staging: string | undefined,
    journalWritten = false;
  try {
    if (readJournal(profile)) throw new MaintenanceError('restore_reconciliation_required');
    if (storeId(profile.profilePath) !== input.expectedStoreId)
      throw new MaintenanceError('store_identity_mismatch');
    const verified = await inspectProfileBackup({
      directory: selected.directory,
      signal: input.signal,
    });
    if (
      canonicalJson(verified.manifest as unknown as Json) !==
      canonicalJson(selected.manifest as unknown as Json)
    )
      throw new MaintenanceError('backup_content_changed');
    const restoreId = randomUUID(),
      newStoreId = randomUUID();
    staging = join(profile.dataRoot, `.restore-${restoreId}`);
    const preserved = join(profile.dataRoot, `.preserved-${restoreId}`);
    privateDirectory(staging, true);
    await copyFile(join(selected.directory, 'core.db'), join(staging, 'core.db'), input.signal);
    const db = openBackupDatabase(join(staging, 'core.db'));
    try {
      for (const row of mediaRows(db)) {
        if (process.platform === 'win32') {
          await copyWindowsMedia(selected.directory, staging, row.hash, row.size, input.signal);
          continue;
        }
        const prefix = join(staging, 'blobs', row.hash.slice(0, 2));
        privateDirectory(prefix, true);
        await copyFile(
          artifactPath(selected.directory, row.hash),
          artifactPath(staging, row.hash),
          input.signal,
        );
        chmodSync(artifactPath(staging, row.hash), 0o400);
        syncFile(artifactPath(staging, row.hash));
        syncDirectory(prefix);
      }
    } finally {
      db.close(true);
    }
    await restoreAssets(selected.directory, staging, selected.manifest.assets, input.signal);
    // Reinspect the selected source after copying; every copied file must match its source.
    await inspectProfileBackup({ directory: selected.directory, signal: input.signal });
    if (fingerprint(join(staging, 'core.db')).sha256 !== selected.manifest.database.sha256)
      throw new MaintenanceError('backup_content_changed');
    if (existsSync(join(staging, 'blobs'))) syncDirectory(join(staging, 'blobs'));
    const copied = openBackupDatabase(join(staging, 'core.db'));
    try {
      for (const row of mediaRows(copied))
        if (fingerprint(artifactPath(staging, row.hash), undefined, true).sha256 !== row.hash)
          throw new MaintenanceError('backup_content_changed');
    } finally {
      copied.close(true);
    }
    initializeDefaultSqliteEngine();
    const candidate = new Database(
      join(staging, 'core.db'),
      sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      candidate.run('PRAGMA synchronous=FULL');
      candidate.run('BEGIN IMMEDIATE');
      candidate
        .query(
          'UPDATE storage_meta SET store_id=?,replay_floor=last_change_cursor WHERE singleton=1',
        )
        .run(newStoreId);
      candidate.run("UPDATE command SET status='needs_review' WHERE status='accepted'");
      candidate.run(
        "UPDATE run SET status='interrupted',is_active=0,reason='profile_restored' WHERE is_active=1",
      );
      candidate.run(
        "UPDATE execution SET state='outcome_unknown' WHERE state IN ('planned','dispatching','running')",
      );
      candidate.run("UPDATE interaction SET state='cancelled' WHERE state='pending'");
      if (
        candidate
          .query('SELECT 1 FROM session WHERE owner_generation=9223372036854775807 LIMIT 1')
          .get()
      )
        throw new MaintenanceError('sequence_exhausted');
      candidate.run('UPDATE session SET owner_instance=NULL,owner_generation=owner_generation+1');
      candidate.run('COMMIT');
    } catch (error) {
      try {
        candidate.run('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      candidate.close(true);
    }
    syncFile(join(staging, 'core.db'));
    syncDirectory(staging);
    const journal: ProfileRestoreJournal = {
      version: 1,
      restoreId,
      profileAccessKey: profile.profileAccessKey,
      phase: 'prepared',
      expectedStoreId: input.expectedStoreId,
      newStoreId,
      backupManifest: selected.manifest,
      stagingName: `.restore-${restoreId}`,
      preservedName: `.preserved-${restoreId}`,
      originalDigest: digestTree(profile.profilePath),
      candidateDigest: digestTree(staging),
    };
    saveJournal(profile, journal);
    journalWritten = true;
    await observe?.('prepared');
    input.signal?.throwIfAborted();
    movePrivateEntry(profile.profilePath, preserved);
    syncDirectory(profile.dataRoot);
    await observe?.('old_directory_moved');
    journal.phase = 'old_moved';
    saveJournal(profile, journal);
    await observe?.('old_moved');
    movePrivateEntry(staging, profile.profilePath);
    syncDirectory(profile.dataRoot);
    await observe?.('candidate_published');
    journal.phase = 'published';
    saveJournal(profile, journal);
    await observe?.('published');
    if (
      !matches(profile.profilePath, journal.candidateDigest, newStoreId) ||
      !matches(preserved, journal.originalDigest, input.expectedStoreId)
    )
      throw new MaintenanceError('restore_content_changed');
    journal.phase = 'verified';
    saveJournal(profile, journal);
    await observe?.('verified');
    clearJournal(profile);
    await observe?.('journal_cleared');
    staging = undefined;
    return { restoreId, storeId: newStoreId, preservedDirectory: preserved, outcome: 'restored' };
  } finally {
    if (staging && !journalWritten) rmSync(staging, { recursive: true });
    access.lock.release();
  }
}
export function restoreProfileBackup(input: RestoreProfileBackupInput) {
  return runProfileRestore(input);
}
export async function reconcileProfileRestore(input: {
  profile: ProfileOptions;
  restoreId: string;
  expectedJournalDigest: string;
  decision: 'complete' | 'rollback';
}): Promise<ProfileRestoreResult> {
  supported();
  if (!['complete', 'rollback'].includes(input.decision))
    throw new MaintenanceError('restore_decision_required');
  const profile = selectProfile(input.profile),
    access = acquireProfileMaintenanceAccess(input.profile);
  try {
    const journal = readJournal(profile);
    if (
      !journal ||
      journal.restoreId !== input.restoreId ||
      journalDigest(journal) !== input.expectedJournalDigest
    )
      throw new MaintenanceError('restore_journal_mismatch');
    const staging = join(profile.dataRoot, journal.stagingName),
      preserved = join(profile.dataRoot, journal.preservedName);
    const originalHere = matches(
        profile.profilePath,
        journal.originalDigest,
        journal.expectedStoreId,
      ),
      originalSaved = matches(preserved, journal.originalDigest, journal.expectedStoreId),
      candidateStaged = matches(staging, journal.candidateDigest, journal.newStoreId),
      candidateHere = matches(profile.profilePath, journal.candidateDigest, journal.newStoreId);
    // Only exact known arrangements are reconciled. Unexpected directories/content stay fenced.
    if (
      !(originalHere && !existsSync(preserved) && candidateStaged) &&
      !(!existsSync(profile.profilePath) && originalSaved && candidateStaged) &&
      !(candidateHere && originalSaved && !existsSync(staging))
    )
      throw new MaintenanceError('restore_content_changed');
    if (input.decision === 'complete') {
      if (originalHere) {
        movePrivateEntry(profile.profilePath, preserved);
        syncDirectory(profile.dataRoot);
      }
      if (!candidateHere) {
        movePrivateEntry(staging, profile.profilePath);
        syncDirectory(profile.dataRoot);
      }
      if (!matches(profile.profilePath, journal.candidateDigest, journal.newStoreId))
        throw new MaintenanceError('restore_content_changed');
      journal.phase = 'verified';
      saveJournal(profile, journal);
      clearJournal(profile);
      return {
        restoreId: journal.restoreId,
        storeId: journal.newStoreId,
        preservedDirectory: preserved,
        outcome: 'restored',
      };
    }
    if (candidateHere) {
      movePrivateEntry(profile.profilePath, staging);
      syncDirectory(profile.dataRoot);
    }
    if (!originalHere) {
      movePrivateEntry(preserved, profile.profilePath);
      syncDirectory(profile.dataRoot);
    }
    if (!matches(profile.profilePath, journal.originalDigest, journal.expectedStoreId))
      throw new MaintenanceError('restore_content_changed');
    clearJournal(profile);
    return {
      restoreId: journal.restoreId,
      storeId: journal.expectedStoreId,
      preservedDirectory: staging,
      outcome: 'rolled_back',
    };
  } finally {
    access.lock.release();
  }
}
