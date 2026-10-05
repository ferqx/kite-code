import { closeSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireFileLock,
  acquireInheritedSharedFileLock,
  assertLiveLock,
  type FileLock,
  retainLockOwner,
  type WindowsPathSecurity,
} from './locks';
import { assertNoSymlinkPath, type ProfileSelection, selectProfile } from './profile-identity';
import { defaultWindowsPathSecurity, privateDirectory } from './windows-path-security';

export { assertNoSymlinkPath, selectProfile } from './profile-identity';
export interface ProfileOptions {
  dataRoot: string;
  profile: string;
  windowsPathSecurity?: WindowsPathSecurity;
}
export interface ProfileAccess extends ProfileSelection {
  readonly lock: FileLock;
}
const profileAuthorities = new WeakMap<
  ProfileAccess,
  { paths: ProfileSelection; security?: WindowsPathSecurity }
>();
function authority(
  paths: ProfileSelection,
  lock: FileLock,
  security?: WindowsPathSecurity,
): ProfileAccess {
  const access = Object.freeze({ ...paths, lock });
  profileAuthorities.set(access, { paths, security });
  return access;
}
/** Validate the original live host lease without acquiring a second file lock. */
export function assertProfileAccess(access: ProfileAccess): void {
  const original = profileAuthorities.get(access);
  if (!original) throw Error('profile_access_authority_invalid');
  const { paths, security } = original;
  assertLiveLock(access.lock, join(paths.coordinationPath, 'profile-use.lock'), 'shared');
  verifyCoordination(paths, security);
  if (existsSync(join(paths.coordinationPath, 'restore-journal.json')))
    throw Error('restore_reconciliation_required');
  assertNoSymlinkPath(paths.profilePath);
}
/** Short host write exclusion; no arbitrary path or maintenance capability. */
export function acquireProfileDataLock(access: ProfileAccess, purpose: 'tui_private'): FileLock {
  const original = profileAuthorities.get(access);
  if (!original || purpose !== 'tui_private') throw Error('profile_data_lock_authority_invalid');
  assertProfileAccess(access);
  const { paths, security } = original;
  const lock = acquireFileLock(
    join(paths.coordinationPath, 'tui-private.lock'),
    'exclusive',
    security,
  );
  try {
    retainLockOwner(access.lock, lock);
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}
export function resolveProfile(options: ProfileOptions): Omit<ProfileAccess, 'lock'> {
  defaultWindowsPathSecurity()?.verifyPath(options.dataRoot);
  const selection = selectProfile(options);
  const { dataRoot: canonicalRoot, coordinationPath } = selection;
  privateDirectory(canonicalRoot, options.windowsPathSecurity);
  assertNoSymlinkPath(coordinationPath);
  privateDirectory(coordinationPath, options.windowsPathSecurity);
  verifyCoordination(selection, options.windowsPathSecurity ?? defaultWindowsPathSecurity());
  return selection;
}
function verifyCoordination(selection: ProfileSelection, security?: WindowsPathSecurity): void {
  const { dataRoot: canonicalRoot, coordinationPath } = selection;
  assertNoSymlinkPath(coordinationPath);
  for (const path of [canonicalRoot, join(canonicalRoot, '.coordination'), coordinationPath]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    )
      throw new Error('Profile coordination requires private owned directories.');
  }
  if (process.platform === 'win32') {
    const actual = security ?? defaultWindowsPathSecurity()!;
    for (const path of [canonicalRoot, join(canonicalRoot, '.coordination'), coordinationPath]) {
      defaultWindowsPathSecurity()!.verifyDirectory(path);
      actual.verifyDirectory(path);
    }
  }
}
export function acquireProfileAccess(
  options: ProfileOptions,
  mode: FileLock['mode'] = 'shared',
): ProfileAccess {
  const paths = resolveProfile(options);
  const lock = acquireFileLock(
    join(paths.coordinationPath, 'profile-use.lock'),
    mode,
    options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  );
  try {
    if (existsSync(join(paths.coordinationPath, 'restore-journal.json')))
      throw new Error('restore_reconciliation_required');
    assertNoSymlinkPath(paths.profilePath);
    return authority(paths, lock, options.windowsPathSecurity ?? defaultWindowsPathSecurity());
  } catch (error) {
    lock.release();
    throw error;
  }
}
/** Trusted Bun helper: adopt its copy of the Node-owned fd; do not create namespace or profile. */
export function acquireInheritedProfileAccess(options: {
  dataRoot: string;
  profile: string;
  fd: number;
}): ProfileAccess {
  if (!Number.isSafeInteger(options.fd) || options.fd < 0)
    throw new Error('Invalid inherited lock descriptor.');
  let ownsFd = true;
  try {
    const paths = selectProfile(options);
    verifyCoordination(paths);
    // The lock constructor closes its owned descriptor on either success release or failure.
    ownsFd = false;
    const lock = acquireInheritedSharedFileLock(
      join(paths.coordinationPath, 'profile-use.lock'),
      options.fd,
    );
    try {
      if (existsSync(join(paths.coordinationPath, 'restore-journal.json')))
        throw new Error('restore_reconciliation_required');
      assertNoSymlinkPath(paths.profilePath);
      return authority(paths, lock);
    } catch (error) {
      lock.release();
      throw error;
    }
  } catch (error) {
    if (ownsFd) closeSync(options.fd);
    throw error;
  }
}
/** Explicit journal reconciliation only; never used by normal Store/bootstrap opening. */
export function acquireProfileMaintenanceAccess(options: ProfileOptions): ProfileAccess {
  const paths = resolveProfile(options);
  const lock = acquireFileLock(
    join(paths.coordinationPath, 'profile-use.lock'),
    'exclusive',
    options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  );
  try {
    assertNoSymlinkPath(paths.profilePath);
    return { ...paths, lock };
  } catch (error) {
    lock.release();
    throw error;
  }
}
export function acquireSessionLock(
  access: ProfileAccess,
  sessionId: string,
  security?: WindowsPathSecurity,
): FileLock {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid Session identity.');
  return acquireFileLock(
    join(access.coordinationPath, `session-${sessionId}.lock`),
    'exclusive',
    security ?? profileAuthorities.get(access)?.security ?? defaultWindowsPathSecurity(),
  );
}
