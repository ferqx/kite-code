/** Explicit host artifact lifetime; never grants profile or execution authority. */
import { closeSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  acquireFileLock,
  acquireInheritedSharedFileLock,
  attachLockResource,
  type FileLock,
} from './platform/locks';
import { retainWindowsArtifactScope } from './platform/windows-artifact-scope';

/** Fixed sibling lock remains outside the immutable bundle's integrity-checked file inventory. */
export function acquireArtifactAccess(input: {
  root: string;
  mode: 'shared' | 'exclusive';
}): FileLock {
  if (!['shared', 'exclusive'].includes(input.mode)) throw Error('artifact_access_invalid');
  const path = artifactLockPath(input.root);
  if (process.platform !== 'win32') return acquireFileLock(path, input.mode);
  const scope = retainWindowsArtifactScope(input.root);
  let lock: FileLock | undefined;
  try {
    lock = acquireFileLock(path, input.mode);
    attachLockResource(lock, scope);
    return lock;
  } catch (error) {
    try {
      lock?.release();
    } finally {
      scope.release();
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
