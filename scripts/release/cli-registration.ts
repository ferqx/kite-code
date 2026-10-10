import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import {
  assertManagedCLIPrefix,
  CLI_REGISTRATION_FILE,
  type CLIRegistration,
  OWNED_CLI_REGISTRATION_FILE,
  readCLIRegistration,
  readManagedCLIActive,
  sameCLIRegistration,
} from '../../apps/cli/host/cli-registration';
import { verifyTerminalBundle } from '../../apps/cli/host/terminal-artifact';
import {
  readWindowsTerminalInstallation,
  retainWindowsTerminalFrontdoor,
} from '../../apps/cli/host/windows-terminal-installation';
import {
  acquireFileLock,
  assertLiveLock,
  attachLockResource,
  type FileLock,
} from '../../packages/agent/src/platform/locks';
import {
  type WindowsInstallationCoordination,
  windowsInstallationCoordination,
} from '../../packages/agent/src/platform/windows-installation-coordination';
import {
  assertWindowsInstallationRemoval,
  retainWindowsInstallationRemoval,
  type WindowsInstallationRemoval,
} from '../../packages/agent/src/platform/windows-installation-removal';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import {
  retainWindowsPrivateFileRemoval,
  WindowsPrivateFileRemovalAcquireUnknownError,
} from '../../packages/agent/src/platform/windows-private-file-removal';

interface WindowsRegistrationOwner {
  prefix: string;
  coordination: WindowsInstallationCoordination;
  resources: { confirm(): void }[];
  group: FileLock[];
}
const windowsOwners = new WeakMap<FileLock, WindowsRegistrationOwner>();
const pendingRegistrationOwners = new Set<object>();
/** All selection EX in this invocation remain held until a shared resource is confirmed. */
function retainWindowsGroup(owner: WindowsRegistrationOwner, confirm: () => void): () => void {
  let confirmed = false;
  const guard = {
    confirm() {
      if (confirmed) return;
      confirm();
      confirmed = true;
    },
  };
  const owners = owner.group
    .map((lock) => windowsOwners.get(lock))
    .filter((item) => item !== undefined);
  for (const member of owners) {
    member.resources.push(guard);
    pendingRegistrationOwners.add(member);
  }
  return () => {
    for (const member of owners) {
      const index = member.resources.indexOf(guard);
      if (index !== -1) member.resources.splice(index, 1);
    }
  };
}
function releaseLocks(locks: FileLock[], primary?: { error: unknown }): void {
  pendingRegistrationOwners.add(locks);
  try {
    while (locks.length) {
      locks.at(-1)!.release();
      locks.pop();
    }
    pendingRegistrationOwners.delete(locks);
  } catch (cleanup) {
    throw new AggregateError(
      primary ? [primary.error, cleanup] : [cleanup],
      'cli_registration_close_unknown',
    );
  }
}
function windowsOwner(prefix: string, locks: readonly FileLock[]): WindowsRegistrationOwner {
  const lock = locks.find((item) => windowsOwners.get(item)?.prefix === prefix);
  if (!lock) throw Error('cli_registration_lock_missing');
  assertLiveLock(lock, lock.path, 'exclusive');
  return windowsOwners.get(lock)!;
}

export function acquireCLIRegistrationLocks(prefixes: readonly string[]): FileLock[] {
  const locks: FileLock[] = [];
  try {
    for (const prefix of [...new Set(prefixes)].sort()) {
      if (process.platform === 'win32') {
        const coordination = windowsInstallationCoordination(prefix);
        let lock: FileLock | undefined;
        const owner: WindowsRegistrationOwner = {
          prefix: coordination.prefix,
          coordination,
          resources: [],
          group: locks,
        };
        try {
          lock = acquireFileLock(coordination.selectionLockPath, 'exclusive');
          locks.push(lock);
          windowsOwners.set(lock, owner);
          attachLockResource(lock, {
            verify() {
              coordination.verify();
            },
            release() {
              while (owner.resources.length) {
                owner.resources.at(-1)!.confirm();
                owner.resources.pop();
              }
              coordination.release();
              pendingRegistrationOwners.delete(owner);
            },
          });
        } catch (error) {
          if (!lock) {
            try {
              coordination.release();
            } catch (cleanup) {
              pendingRegistrationOwners.add(owner);
              throw new AggregateError([error, cleanup], 'cli_registration_close_unknown');
            }
          }
          throw error;
        }
        continue;
      }
      const directory = lstatSync(prefix);
      if (
        realpathSync(prefix) !== prefix ||
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o022) !== 0 ||
        (process.getuid && directory.uid !== process.getuid())
      )
        throw Error('cli_registration_prefix_unsafe');
      locks.push(acquireFileLock(join(prefix, '.install.lock'), 'exclusive'));
    }
    return locks;
  } catch (error) {
    releaseLocks(locks, { error });
    throw error;
  }
}
function held(prefix: string, locks: readonly FileLock[]) {
  if (process.platform === 'win32') {
    windowsOwner(prefix, locks);
    return;
  }
  const lock = locks.find((item) => item.path === join(prefix, '.install.lock'));
  if (!lock) throw Error('cli_registration_lock_missing');
  assertLiveLock(lock, lock.path, 'exclusive');
}
function observeWindows<T>(prefix: string, locks: readonly FileLock[], run: () => T): T {
  if (process.platform !== 'win32') return run();
  const owner = windowsOwner(prefix, locks);
  try {
    return run();
  } catch (error) {
    // Semantic codecs reject only after their private readers have returned. Opaque
    // path/pin close failures have no retry port and therefore keep this exact EX.
    const known =
      error instanceof Error &&
      !/close|unknown/.test(error.message) &&
      (/^cli_registration_(?:invalid|unsafe|identity_mismatch|active_invalid|prefix_unsafe|prefix_mismatch|candidate_invalid)$/.test(
        error.message,
      ) ||
        /^(?:terminal|native)_(?:windows_install_identity_mismatch|bundle_[a-z_]+|manifest_invalid|target_mismatch|terminal_identity_mismatch|electron_identity_mismatch|app_identity_mismatch)$/.test(
          error.message,
        ) ||
        error instanceof SyntaxError ||
        ('code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'));
    if (!known) {
      retainWindowsGroup(owner, () => {
        throw new AggregateError([error], 'cli_registration_observation_close_unknown');
      });
    }
    throw error;
  }
}
function observedRegistration(prefix: string, locks: readonly FileLock[], owned = false) {
  return observeWindows(prefix, locks, () => readCLIRegistration(prefix, owned));
}
function managed(prefix: string, locks: readonly FileLock[], native = false) {
  observeWindows(prefix, locks, () => assertManagedCLIPrefix(prefix, native));
}
function active(prefix: string, locks: readonly FileLock[]) {
  return observeWindows(prefix, locks, () => readManagedCLIActive(prefix));
}
function sync(prefix: string) {
  const fd = openSync(prefix, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** A failed opaque transfer cannot surrender EX until its host actually exits. */
function transferWindows(owner: WindowsRegistrationOwner, run: () => void): void {
  let failure: unknown;
  const confirmed = retainWindowsGroup(owner, () => {
    throw new AggregateError([failure], 'cli_registration_transfer_close_unknown');
  });
  try {
    run();
    confirmed();
  } catch (error) {
    failure = error;
    pendingRegistrationOwners.add(owner);
    throw error;
  }
}
function publishWindows(
  prefix: string,
  owned: boolean,
  registration: CLIRegistration,
  locks: readonly FileLock[],
): void {
  const owner = windowsOwner(prefix, locks);
  const security = defaultWindowsPathSecurity()!;
  const root = join(owner.coordination.root, `registration-${randomBytes(16).toString('hex')}`);
  const temporary = join(root, 'value');
  const target = join(prefix, owned ? OWNED_CLI_REGISTRATION_FILE : CLI_REGISTRATION_FILE);
  const bytes = Buffer.from(`${JSON.stringify(registration)}\n`);
  let removal: WindowsInstallationRemoval | undefined;
  retainWindowsGroup(owner, () => {
    if (!removal && !existsSync(root)) return;
    removal ??= retainWindowsInstallationRemoval({
      root,
      inventory: existsSync(temporary) ? [{ path: 'value', kind: 'file' }] : [],
    });
    removal.remove();
    removal.release();
  });
  transferWindows(owner, () => {
    if (existsSync(root)) throw Error('cli_registration_scratch_unknown');
    privateDirectory(root, security);
    security.writePrivateFile(temporary, bytes);
    security.syncPrivateFile(temporary);
    security.movePrivateEntry(temporary, target, true);
    const actual = security.readScopeFile(target, 16384, true);
    if (!actual || !Buffer.from(actual).equals(bytes))
      throw Error('cli_registration_publication_unconfirmed');
  });
}
function removeWindows(prefix: string, name: string, locks: readonly FileLock[]): void {
  const owner = windowsOwner(prefix, locks);
  let removal: ReturnType<typeof retainWindowsPrivateFileRemoval>;
  try {
    removal = retainWindowsPrivateFileRemoval(join(prefix, name));
  } catch (error) {
    if (error instanceof WindowsPrivateFileRemovalAcquireUnknownError) {
      retainWindowsGroup(owner, () => error.owner.release());
    }
    throw error;
  }
  retainWindowsGroup(owner, () => removal.release());
  removal.remove();
}
function runLocked<T>(locks: FileLock[], run: () => T): T {
  let failure: { error: unknown } | undefined;
  let value: T | undefined;
  try {
    value = run();
  } catch (error) {
    failure = { error };
  }
  releaseLocks(locks, failure);
  if (failure) throw failure.error;
  return value as T;
}
function publish(
  prefix: string,
  owned: boolean,
  registration: CLIRegistration,
  locks: readonly FileLock[],
) {
  if (process.platform === 'win32') {
    publishWindows(prefix, owned, registration, locks);
    return;
  }
  const path = join(prefix, owned ? OWNED_CLI_REGISTRATION_FILE : CLI_REGISTRATION_FILE),
    temporary = join(prefix, `.registration-${randomBytes(16).toString('hex')}`);
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(registration)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    sync(prefix);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function verifyCLIRegistrationTargetWhileLocked(
  prefix: string,
  locks: readonly FileLock[],
): void {
  held(prefix, locks);
  managed(prefix, locks);
  if (process.platform === 'win32') {
    const frontdoor = observeWindows(prefix, locks, () =>
      retainWindowsTerminalFrontdoor(readWindowsTerminalInstallation(prefix)),
    );
    retainWindowsGroup(windowsOwner(prefix, locks), () => frontdoor.release());
    frontdoor.verify();
  }
  observedRegistration(prefix, locks);
  const candidate = active(prefix, locks);
  if (
    observeWindows(prefix, locks, () => verifyTerminalBundle(join(prefix, 'releases', candidate)))
      .digest !== candidate
  )
    throw Error('cli_registration_candidate_invalid');
}
/** Two prefix EX owners; this operation never reads PATH, RC files or application data. */
export function registerNativeCLIWhileLocked(
  input: { nativePrefix: string; terminalPrefix: string },
  locks: readonly FileLock[],
): Readonly<CLIRegistration> {
  const { nativePrefix, terminalPrefix } = input;
  if (nativePrefix === terminalPrefix) throw Error('cli_registration_prefix_invalid');
  held(nativePrefix, locks);
  held(terminalPrefix, locks);
  managed(nativePrefix, locks, true);
  managed(terminalPrefix, locks);
  const previous = observedRegistration(nativePrefix, locks, true);
  if (previous && previous.terminalPrefix !== terminalPrefix)
    throw Error('cli_registration_already_owned');
  const before = observedRegistration(terminalPrefix, locks);
  const candidateId = active(nativePrefix, locks);
  if (
    observeWindows(nativePrefix, locks, () =>
      verifyNativeRuntimeBundle(join(nativePrefix, 'releases', candidateId)),
    ).digest !== candidateId
  )
    throw Error('cli_registration_candidate_invalid');
  const independent = active(terminalPrefix, locks);
  if (
    observeWindows(terminalPrefix, locks, () =>
      verifyTerminalBundle(join(terminalPrefix, 'releases', independent)),
    ).digest !== independent
  )
    throw Error('cli_registration_candidate_invalid');
  if (
    !sameCLIRegistration(before, observedRegistration(terminalPrefix, locks)) ||
    !sameCLIRegistration(previous, observedRegistration(nativePrefix, locks, true))
  )
    throw Error('cli_registration_changed');
  const registration = Object.freeze({
    version: 1 as const,
    terminalPrefix,
    nativePrefix,
    candidateId,
    nonce: randomBytes(16).toString('hex'),
  });
  // Reverse owner is durable first: a crash cannot publish an unowned global registration.
  publish(nativePrefix, true, registration, locks);
  publish(terminalPrefix, false, registration, locks);
  return registration;
}
export function unregisterNativeCLIWhileLocked(
  nativePrefix: string,
  locks: readonly FileLock[],
  nativeRemoval?: WindowsInstallationRemoval,
): boolean {
  if (nativeRemoval) {
    if (process.platform !== 'win32') throw Error('cli_registration_removal_invalid');
    assertWindowsInstallationRemoval(nativeRemoval, nativePrefix);
  }
  held(nativePrefix, locks);
  managed(nativePrefix, locks, true);
  const owned = observedRegistration(nativePrefix, locks, true);
  if (!owned) return false;
  let removed = false;
  if (lstatSync(owned.terminalPrefix, { throwIfNoEntry: false })) {
    held(owned.terminalPrefix, locks);
    managed(owned.terminalPrefix, locks);
    const current = observedRegistration(owned.terminalPrefix, locks);
    if (sameCLIRegistration(owned, current)) {
      if (process.platform === 'win32')
        removeWindows(owned.terminalPrefix, CLI_REGISTRATION_FILE, locks);
      else {
        rmSync(join(owned.terminalPrefix, CLI_REGISTRATION_FILE));
        sync(owned.terminalPrefix);
      }
      removed = true;
    }
  }
  if (!sameCLIRegistration(owned, observedRegistration(nativePrefix, locks, true)))
    throw Error('cli_registration_changed');
  if (process.platform === 'win32') {
    if (!nativeRemoval) removeWindows(nativePrefix, OWNED_CLI_REGISTRATION_FILE, locks);
  } else {
    rmSync(join(nativePrefix, OWNED_CLI_REGISTRATION_FILE));
    sync(nativePrefix);
  }
  return removed;
}
export function registerNativeCLI(input: { nativePrefix: string; terminalPrefix: string }) {
  const nativePrefix = realpathSync(input.nativePrefix),
    terminalPrefix = realpathSync(input.terminalPrefix);
  const locks = acquireCLIRegistrationLocks([nativePrefix, terminalPrefix]);
  return runLocked(locks, () =>
    registerNativeCLIWhileLocked({ nativePrefix, terminalPrefix }, locks),
  );
}
export function unregisterNativeCLI(nativePrefixInput: string): boolean {
  const nativePrefix = realpathSync(nativePrefixInput),
    owned = readCLIRegistration(nativePrefix, true);
  const locks = acquireCLIRegistrationLocks([
    nativePrefix,
    ...(owned && lstatSync(owned.terminalPrefix, { throwIfNoEntry: false })
      ? [owned.terminalPrefix]
      : []),
  ]);
  return runLocked(locks, () => {
    if (!sameCLIRegistration(owned, readCLIRegistration(nativePrefix, true)))
      throw Error('cli_registration_changed');
    return unregisterNativeCLIWhileLocked(nativePrefix, locks);
  });
}
