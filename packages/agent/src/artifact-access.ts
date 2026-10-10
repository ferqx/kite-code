/** Explicit host artifact lifetime; never grants profile or execution authority. */
import { closeSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  acquireFileLock,
  acquireInheritedSharedFileLock,
  attachLockResource,
  type FileLock,
} from './platform/locks';
import { retainWindowsArtifactScope } from './platform/windows-artifact-scope';
import {
  deriveNativeWindowsUseKeys,
  windowsInstallationCoordination,
} from './platform/windows-installation-coordination';
import { defaultWindowsPathSecurity } from './platform/windows-path-security';

/** Failed admissions keep their exact resources until native closure is confirmed. */
const pendingArtifactAcquisitions = new Set<() => void>();

/** Fixed sibling lock remains outside the immutable bundle's integrity-checked file inventory. */
export function acquireArtifactAccess(input: {
  root: string;
  mode: 'shared' | 'exclusive';
}): FileLock {
  if (!['shared', 'exclusive'].includes(input.mode)) throw Error('artifact_access_invalid');
  const path = artifactLockPath(input.root);
  if (process.platform !== 'win32') return acquireFileLock(path, input.mode);
  // Installed Terminal use locks survive removal of the install tree. Every actual
  // consumer and the installer derive the same namespace; source bundles keep their
  // existing sibling lock contract.
  const candidateRoot = basename(input.root) === 'terminal' ? dirname(input.root) : input.root;
  const prefix = dirname(dirname(candidateRoot));
  const id = basename(candidateRoot);
  const managedNative =
    basename(dirname(candidateRoot)) === 'releases' &&
    /^[a-f0-9]{64}$/.test(id) &&
    existsSync(join(prefix, '.kite-native-install.json'));
  if (managedNative) {
    const bytes = defaultWindowsPathSecurity()!.readScopeFile(
      join(prefix, '.kite-native-install.json'),
      16384,
      true,
    );
    if (!bytes) throw Error('artifact_access_invalid');
    const marker: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !marker ||
      typeof marker !== 'object' ||
      Array.isArray(marker) ||
      Object.keys(marker).sort().join(',') !== 'bootstrap,root,version' ||
      Reflect.get(marker, 'version') !== 2 ||
      Reflect.get(marker, 'root') !== prefix
    )
      throw Error('artifact_access_invalid');
    const bootstrap = Reflect.get(marker, 'bootstrap');
    const names = ['kite.exe', 'kite-tui.exe', 'kite-desktop.exe', 'native-verifier.exe'];
    if (
      !bootstrap ||
      typeof bootstrap !== 'object' ||
      Array.isArray(bootstrap) ||
      Object.keys(bootstrap).sort().join(',') !== 'candidateId,files' ||
      typeof Reflect.get(bootstrap, 'candidateId') !== 'string' ||
      !/^[a-f0-9]{64}$/.test(Reflect.get(bootstrap, 'candidateId')) ||
      !Array.isArray(Reflect.get(bootstrap, 'files')) ||
      Reflect.get(bootstrap, 'files').length !== names.length
    )
      throw Error('artifact_access_invalid');
    for (const [index, file] of Reflect.get(bootstrap, 'files').entries()) {
      if (
        !file ||
        typeof file !== 'object' ||
        Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'name,sha256,size' ||
        Reflect.get(file, 'name') !== names[index] ||
        !Number.isSafeInteger(Reflect.get(file, 'size')) ||
        Reflect.get(file, 'size') <= 0 ||
        Reflect.get(file, 'size') > 512 * 1048576 ||
        typeof Reflect.get(file, 'sha256') !== 'string' ||
        !/^[a-f0-9]{64}$/.test(Reflect.get(file, 'sha256'))
      )
        throw Error('artifact_access_invalid');
    }
  }
  const coordination =
    managedNative ||
    (basename(dirname(input.root)) === 'releases' &&
      /^[a-f0-9]{64}$/.test(basename(input.root)) &&
      existsSync(join(prefix, '.kite-terminal-install.json')))
      ? windowsInstallationCoordination(prefix)
      : undefined;
  const useKey = managedNative
    ? deriveNativeWindowsUseKeys(id)[candidateRoot === input.root ? 'outer' : 'terminal']
    : basename(input.root);
  let scope: ReturnType<typeof retainWindowsArtifactScope> | undefined;
  let lock: FileLock | undefined;
  let attached = false;
  try {
    scope = retainWindowsArtifactScope(input.root);
    const retained = scope;
    lock = acquireFileLock(coordination?.candidateLockPath(useKey) ?? path, input.mode);
    attachLockResource(lock, {
      verify() {
        coordination?.verify();
        retained.verify();
      },
      release() {
        retained.release();
        coordination?.release();
      },
    });
    attached = true;
    return lock;
  } catch (error) {
    const release = () => {
      if (attached) lock!.release();
      else {
        // Attachment verification can reject before the actual lock owns the scope.
        // Keep the original lock region until both original resource owners close.
        scope?.release();
        coordination?.release();
        lock?.release();
      }
    };
    pendingArtifactAcquisitions.add(release);
    try {
      release();
      pendingArtifactAcquisitions.delete(release);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'artifact_access_acquire_close_unknown');
    }
    throw error;
  }
}
function artifactLockPath(root: string): string {
  if (
    !isAbsolute(root) ||
    realpathSync(root) !== root ||
    !basename(root) ||
    Array.from(basename(root)).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw Error('artifact_access_invalid');
  for (const path of [root, dirname(root)]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    )
      throw Error('artifact_access_invalid');
  }
  return join(dirname(root), `.use-${basename(root)}.lock`);
}

/** Trusted Bun helper owns only its inherited fd copy; no Profile or execution authority. */
export function acquireInheritedArtifactAccess(input: { root: string; fd: number }): FileLock {
  if (!Number.isSafeInteger(input.fd) || input.fd < 0)
    throw Error('Invalid inherited lock descriptor.');
  let ownsFd = true;
  try {
    const path = artifactLockPath(input.root);
    // Existing constructor closes the adopted fd on failure or eventual release.
    ownsFd = false;
    return acquireInheritedSharedFileLock(path, input.fd);
  } catch (error) {
    if (ownsFd) closeSync(input.fd);
    throw error;
  }
}

/** Explicit host pin after complete candidate manifest verification. */
export { retainWindowsCandidateFiles } from './platform/windows-candidate-files';
export {
  assertWindowsInstallationRemoval,
  type WindowsInstallationRemoval,
} from './platform/windows-installation-removal';
