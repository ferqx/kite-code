import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
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
  acquireFileLock,
  assertLiveLock,
  type FileLock,
} from '../../packages/agent/src/platform/locks';

export function acquireCLIRegistrationLocks(prefixes: readonly string[]): FileLock[] {
  const locks: FileLock[] = [];
  try {
    for (const prefix of [...new Set(prefixes)].sort()) {
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
    for (const lock of locks.reverse()) lock.release();
    throw error;
  }
}
function held(prefix: string, locks: readonly FileLock[]) {
  const lock = locks.find((item) => item.path === join(prefix, '.install.lock'));
  if (!lock) throw Error('cli_registration_lock_missing');
  assertLiveLock(lock, lock.path, 'exclusive');
}
function sync(prefix: string) {
  const fd = openSync(prefix, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function publish(prefix: string, owned: boolean, registration: CLIRegistration) {
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
  assertManagedCLIPrefix(prefix);
  readCLIRegistration(prefix);
  const candidate = readManagedCLIActive(prefix);
  if (verifyTerminalBundle(join(prefix, 'releases', candidate)).digest !== candidate)
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
  assertManagedCLIPrefix(nativePrefix, true);
  assertManagedCLIPrefix(terminalPrefix);
  const previous = readCLIRegistration(nativePrefix, true);
  if (previous && previous.terminalPrefix !== terminalPrefix)
    throw Error('cli_registration_already_owned');
  const before = readCLIRegistration(terminalPrefix);
  const candidateId = readManagedCLIActive(nativePrefix);
  if (verifyNativeRuntimeBundle(join(nativePrefix, 'releases', candidateId)).digest !== candidateId)
    throw Error('cli_registration_candidate_invalid');
  const independent = readManagedCLIActive(terminalPrefix);
  if (verifyTerminalBundle(join(terminalPrefix, 'releases', independent)).digest !== independent)
    throw Error('cli_registration_candidate_invalid');
  if (
    !sameCLIRegistration(before, readCLIRegistration(terminalPrefix)) ||
    !sameCLIRegistration(previous, readCLIRegistration(nativePrefix, true))
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
  publish(nativePrefix, true, registration);
  publish(terminalPrefix, false, registration);
  return registration;
}
export function unregisterNativeCLIWhileLocked(
  nativePrefix: string,
  locks: readonly FileLock[],
): boolean {
  held(nativePrefix, locks);
  assertManagedCLIPrefix(nativePrefix, true);
  const owned = readCLIRegistration(nativePrefix, true);
  if (!owned) return false;
  let removed = false;
  if (lstatSync(owned.terminalPrefix, { throwIfNoEntry: false })) {
    held(owned.terminalPrefix, locks);
    assertManagedCLIPrefix(owned.terminalPrefix);
    const current = readCLIRegistration(owned.terminalPrefix);
    if (sameCLIRegistration(owned, current)) {
      rmSync(join(owned.terminalPrefix, CLI_REGISTRATION_FILE));
      sync(owned.terminalPrefix);
      removed = true;
    }
  }
  if (!sameCLIRegistration(owned, readCLIRegistration(nativePrefix, true)))
    throw Error('cli_registration_changed');
  rmSync(join(nativePrefix, OWNED_CLI_REGISTRATION_FILE));
  sync(nativePrefix);
  return removed;
}
export function registerNativeCLI(input: { nativePrefix: string; terminalPrefix: string }) {
  const nativePrefix = realpathSync(input.nativePrefix),
    terminalPrefix = realpathSync(input.terminalPrefix);
  const locks = acquireCLIRegistrationLocks([nativePrefix, terminalPrefix]);
  try {
    return registerNativeCLIWhileLocked({ nativePrefix, terminalPrefix }, locks);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
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
  try {
    if (!sameCLIRegistration(owned, readCLIRegistration(nativePrefix, true)))
      throw Error('cli_registration_changed');
    return unregisterNativeCLIWhileLocked(nativePrefix, locks);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
