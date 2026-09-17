import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  observeLegacyKiteStoreProcesses,
  readKiteInstalledStdioLineage,
} from './legacy-store-processes';
import {
  acquireManagedReleaseSelectionLock,
  declareManagedStoreMaintenanceContract,
} from './managed-release-selection-lock';

export type InstalledKiteStoreAdmission =
  | { readonly admitted: false; readonly reason: string }
  | { readonly admitted: true; readonly lease: { revalidate(): void; release(): void } };

class InstalledLegacyProcessBusyError extends Error {}

/** macOS installed CLI/TUI stdio only; daemon has a separate pre-spawn format gate. */
export function acquireInstalledKiteStoreAdmission(input: {
  readonly canonicalKiteHome: string;
  readonly runtimeRoot: string;
}): InstalledKiteStoreAdmission {
  if (process.platform !== 'darwin') return { admitted: false, reason: 'unsupported_platform' };
  let executable: string;
  let installRoot: string;
  let candidateRoot: string;
  try {
    executable = realpathSync.native(process.execPath);
    candidateRoot = dirname(dirname(executable));
    installRoot = dirname(dirname(candidateRoot));
    if (
      basename(executable) !== 'kite-service' ||
      basename(dirname(executable)) !== 'bin' ||
      basename(dirname(candidateRoot)) !== 'releases' ||
      !/^[a-f0-9]{24}$/u.test(basename(candidateRoot)) ||
      process.argv.length !== 4 ||
      process.argv[2] !== 'app-server' ||
      process.argv[3] !== 'run-stdio' ||
      process.env.KITE_STANDALONE_EXECUTABLE !== '1' ||
      process.env.KITE_CODE_RELEASE_ROOT !== candidateRoot ||
      process.env.KITE_CODE_CANDIDATE_ID !== basename(candidateRoot) ||
      process.env.KITE_APP_SERVER_BUILD_ID !== basename(candidateRoot) ||
      process.env.KITE_CODE_CONFIG_HOME !== realpathSync.native(input.canonicalKiteHome) ||
      process.env.KITE_CODE_HOME !== realpathSync.native(input.runtimeRoot)
    )
      return { admitted: false, reason: 'installed_identity_mismatch' };
  } catch {
    return { admitted: false, reason: 'installed_identity_mismatch' };
  }
  // Publish the durable contract under the installer's exclusive selection fence.
  // Reacquire shared and revalidate: an installer may have switched active in the gap.
  try {
    const declaration = acquireManagedReleaseSelectionLock(installRoot, 'exclusive');
    try {
      assertSelectedCandidate(installRoot, candidateRoot, executable);
      declareManagedStoreMaintenanceContract(declaration);
    } finally {
      declaration.release();
    }
  } catch {
    return { admitted: false, reason: 'release_selection_busy_or_unsafe' };
  }
  let lock: ReturnType<typeof acquireManagedReleaseSelectionLock>;
  try {
    lock = acquireManagedReleaseSelectionLock(installRoot, 'shared');
  } catch {
    return { admitted: false, reason: 'release_selection_busy_or_unsafe' };
  }
  try {
    const revalidate = () => {
      lock.revalidate();
      assertSelectedCandidate(installRoot, candidateRoot, executable);
      assertNoOtherInstalledEntrypoints(installRoot, process.env.PATH ?? '');
      const lineage = readKiteInstalledStdioLineage({
        parentPid: process.ppid,
        candidateRoot,
        installRoot,
      });
      if (!lineage) throw new Error('Installed client and stable launcher lineage is unverified.');
      const observed = observeLegacyKiteStoreProcesses({
        exclude: lineage,
        managedInstallPrefixes: [installRoot],
      });
      if (observed.status === 'busy')
        throw new InstalledLegacyProcessBusyError('An earlier Kite Store writer is still running.');
      if (observed.status !== 'complete')
        throw new Error(`Old Store writer observation is ${observed.status}.`);
    };
    revalidate();
    return { admitted: true, lease: Object.freeze({ revalidate, release: () => lock.release() }) };
  } catch (error) {
    lock.release();
    return {
      admitted: false,
      reason:
        error instanceof InstalledLegacyProcessBusyError
          ? 'legacy_process_busy'
          : 'installed_selection_or_process_unverified',
    };
  }
}

function assertSelectedCandidate(
  installRoot: string,
  candidateRoot: string,
  executable: string,
): void {
  const id = basename(candidateRoot);
  if (readPrivateFile(join(installRoot, 'active'), 64).toString() !== `${id}\n`)
    throw new Error('Active candidate changed.');
  const marker = JSON.parse(
    readPrivateFile(join(installRoot, '.kite-code-managed.json'), 4096).toString(),
  ) as Record<string, unknown>;
  if (
    marker.schema !== 'KiteCodeManagedInstall' ||
    marker.version !== 2 ||
    marker.canonicalRoot !== installRoot ||
    marker.currentCandidateId !== id ||
    marker.activePointer !== 'active'
  )
    throw new Error('Managed selection marker differs.');
  if (readPrivateFile(join(candidateRoot, '.candidate-id'), 64).toString() !== `${id}\n`)
    throw new Error('Immutable candidate identity differs.');
  const manifestBytes = readPrivateFile(join(candidateRoot, 'manifest.json'), 262_144);
  if (createHash('sha256').update(manifestBytes).digest('hex').slice(0, 24) !== id)
    throw new Error('Immutable candidate manifest differs.');
  const manifest = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;
  if (manifest.storeMaintenanceContract !== 'managed-release-selection-v1')
    throw new Error('Selected candidate lacks the Store maintenance contract.');
  const files = manifest.files;
  if (!Array.isArray(files)) throw new Error('Candidate file list is absent.');
  const service = files.find(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'path' in entry &&
      entry.path === 'bin/kite-service',
  ) as Record<string, unknown> | undefined;
  if (
    !service ||
    typeof service.sha256 !== 'string' ||
    service.sha256 !== `sha256:${hashFile(executable)}`
  )
    throw new Error('Selected Service does not match the immutable candidate.');
  const slots = manifest.releaseSlots as Record<string, unknown> | undefined;
  const slot = slots?.service as Record<string, unknown> | undefined;
  if (slot?.entrypoint !== 'bin/kite-service' || slot.identity !== service.sha256)
    throw new Error('Selected Service slot does not match the candidate.');
}

function assertNoOtherInstalledEntrypoints(installRoot: string, searchPath: string): void {
  if (!searchPath) throw new Error('PATH is unavailable.');
  const defaultRoot = join(userInfo().homedir, '.local/share/kite-code');
  if (defaultRoot !== installRoot && lstatSync(defaultRoot, { throwIfNoEntry: false }))
    throw new Error('Another managed install is present.');
  for (const directory of searchPath.split(':')) {
    if (!isAbsolute(directory)) throw new Error('PATH is not absolute.');
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) continue;
      throw error;
    }
    if (
      directory !== join(installRoot, 'bin') &&
      names.some((name) => /^(?:kite|kite-tui|kite-service)(?:\.exe)?$/iu.test(name))
    )
      throw new Error('Another Kite launcher is on PATH.');
  }
  for (const root of ['/Applications', join(userInfo().homedir, 'Applications')]) {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (
      stat &&
      (!stat.isDirectory() ||
        stat.isSymbolicLink() ||
        readdirSync(root).some((name) => /^kite\.app$/iu.test(name)))
    )
      throw new Error('Another Desktop entrypoint is present.');
  }
}

function readPrivateFile(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 1 ||
    stat.size > maxBytes
  )
    throw new Error('Managed release file is unsafe.');
  return readFileSync(path);
}
function hashFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const digest = createHash('sha256');
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (count === 0) return digest.digest('hex');
      digest.update(bytes.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
}
function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
