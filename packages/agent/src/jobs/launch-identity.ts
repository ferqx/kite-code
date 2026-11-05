import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Semaphore } from '../execution/resources';

// Shared across asynchronous launch-asset checks in this process, independent of Job slots.
const verificationSlots = new Semaphore(8);
const cleanupSlots = new Semaphore(4);
const uncancelledVerification = new AbortController().signal;
const unclosedVerificationFiles = new Set<FileHandle>();
let verificationDeadline = 0,
  verificationSteps = 0,
  verificationYield: Promise<void> | undefined;

async function verificationStep(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!verificationYield && ++verificationSteps < 64 && performance.now() < verificationDeadline)
    return;
  verificationYield ??= yieldToEventLoop().then(() => {
    verificationSteps = 0;
    verificationDeadline = performance.now() + 8;
    verificationYield = undefined;
  });
  await verificationYield;
  signal.throwIfAborted();
}

async function closeVerificationFile(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    unclosedVerificationFiles.add(handle);
    throw Error('confined_launch_close_unknown', { cause: error });
  }
}

/** Stop claiming work on failure/cancellation; settle all original reads before returning. */
export async function mapAssetVerification<T, R>(
  items: readonly T[],
  read: (item: T, signal: AbortSignal, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const batch = new AbortController();
  const abort = () => batch.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const results: R[] = new Array(items.length);
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(8, items.length) }, async () => {
        while (!batch.signal.aborted && next < items.length) {
          const index = next++;
          try {
            results[index] = await read(items[index]!, batch.signal, index);
          } catch (error) {
            batch.abort(error);
          }
        }
      }),
    );
    batch.signal.throwIfAborted();
    return results;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export interface LaunchIdentity {
  path: string;
  canonical: string;
  device: string;
  inode: string;
  mode: string;
  digest: string | null;
}
export function launchIdentity(path: string, file = false): LaunchIdentity {
  if (!isAbsolute(path) || path.includes('\0')) throw Error('invalid_confined_path');
  const canonical = realpathSync.native(path);
  const stat = lstatSync(canonical, { bigint: true });
  if (file ? !stat.isFile() : !stat.isDirectory()) throw Error('invalid_confined_path');
  let digest: string | null = null;
  if (file) {
    const fd = openSync(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = fstatSync(fd, { bigint: true });
      const unchanged = (current: BigIntStats) =>
        current.isFile() &&
        current.dev === opened.dev &&
        current.ino === opened.ino &&
        current.mode === opened.mode &&
        current.size === opened.size &&
        current.mtimeNs === opened.mtimeNs &&
        current.ctimeNs === opened.ctimeNs;
      if (!opened.isFile() || !unchanged(stat)) throw Error('confined_launch_changed');
      // One call-local buffer bounds native allocation even for large runtime
      // binaries. Empty files still need a one-byte read to observe actual EOF.
      const capacity = opened.size > 1048576n ? 1048576 : Math.max(1, Number(opened.size));
      const scratch = Buffer.allocUnsafe(capacity);
      const hash = createHash('sha256');
      let bytes = 0n;
      for (;;) {
        const count = readSync(fd, scratch, 0, scratch.length, null);
        if (count === 0) break;
        bytes += BigInt(count);
        // Never chase a growing file indefinitely or accept its changed prefix.
        if (bytes > opened.size) throw Error('confined_launch_changed');
        hash.update(scratch.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(canonical, { bigint: true });
      if (bytes !== opened.size || !unchanged(after) || !unchanged(current))
        throw Error('confined_launch_changed');
      digest = hash.digest('hex');
    } finally {
      closeSync(fd);
    }
  }
  return {
    path,
    canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    digest,
  };
}
export function verifyLaunchIdentities(facts: readonly LaunchIdentity[]): void {
  if (!Array.isArray(facts) || facts.length > 200) throw Error('invalid_confined_identity');
  for (const fact of facts) {
    if (
      !fact ||
      typeof fact.path !== 'string' ||
      typeof fact.canonical !== 'string' ||
      typeof fact.device !== 'string' ||
      typeof fact.inode !== 'string' ||
      typeof fact.mode !== 'string' ||
      (fact.digest !== null &&
        (typeof fact.digest !== 'string' || !/^[a-f0-9]{64}$/.test(fact.digest)))
    )
      throw Error('invalid_confined_identity');
    const current = launchIdentity(fact.path, fact.digest !== null);
    if (
      current.canonical !== fact.canonical ||
      current.device !== fact.device ||
      current.inode !== fact.inode ||
      current.mode !== fact.mode ||
      current.digest !== fact.digest
    )
      throw Error('confined_launch_changed');
  }
}

/** Fresh full-file proof on the original FD, with bounded private scratch and I/O. */
export async function launchIdentityAsync(
  path: string,
  file = false,
  signal: AbortSignal = uncancelledVerification,
): Promise<LaunchIdentity> {
  const release = await verificationSlots.acquire(signal);
  let openedFile: FileHandle | undefined;
  try {
    await verificationStep(signal);
    if (!isAbsolute(path) || path.includes('\0')) throw Error('invalid_confined_path');
    const canonical = await realpath(path);
    signal.throwIfAborted();
    const stat = await lstat(canonical, { bigint: true });
    signal.throwIfAborted();
    if (file ? !stat.isFile() : !stat.isDirectory()) throw Error('invalid_confined_path');
    let digest: string | null = null;
    if (file) {
      const handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      openedFile = handle;
      try {
        signal.throwIfAborted();
        const opened = await handle.stat({ bigint: true });
        const unchanged = (current: BigIntStats) =>
          current.isFile() &&
          current.dev === opened.dev &&
          current.ino === opened.ino &&
          current.mode === opened.mode &&
          current.size === opened.size &&
          current.mtimeNs === opened.mtimeNs &&
          current.ctimeNs === opened.ctimeNs;
        if (!opened.isFile() || !unchanged(stat)) throw Error('confined_launch_changed');
        signal.throwIfAborted();
        const scratch = Buffer.allocUnsafe(
          opened.size > 1048576n ? 1048576 : Math.max(1, Number(opened.size)),
        );
        const hash = createHash('sha256');
        let bytes = 0n;
        for (;;) {
          await verificationStep(signal);
          const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
          signal.throwIfAborted();
          if (bytesRead === 0) break;
          bytes += BigInt(bytesRead);
          if (bytes > opened.size) throw Error('confined_launch_changed');
          hash.update(scratch.subarray(0, bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        signal.throwIfAborted();
        const current = await lstat(canonical, { bigint: true });
        signal.throwIfAborted();
        if (bytes !== opened.size || !unchanged(after) || !unchanged(current))
          throw Error('confined_launch_changed');
        digest = hash.digest('hex');
      } finally {
        await closeVerificationFile(handle);
      }
    }
    signal.throwIfAborted();
    if ((await realpath(path)) !== canonical) throw Error('confined_launch_changed');
    signal.throwIfAborted();
    return {
      path,
      canonical,
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: String(stat.mode),
      digest,
    };
  } finally {
    if (!openedFile || !unclosedVerificationFiles.has(openedFile)) release();
  }
}

export async function verifyLaunchIdentitiesAsync(
  facts: readonly LaunchIdentity[],
  signal?: AbortSignal,
): Promise<void> {
  if (!Array.isArray(facts) || facts.length > 200) throw Error('invalid_confined_identity');
  for (const fact of facts) {
    if (
      !fact ||
      typeof fact.path !== 'string' ||
      typeof fact.canonical !== 'string' ||
      typeof fact.device !== 'string' ||
      typeof fact.inode !== 'string' ||
      typeof fact.mode !== 'string' ||
      (fact.digest !== null &&
        (typeof fact.digest !== 'string' || !/^[a-f0-9]{64}$/.test(fact.digest)))
    )
      throw Error('invalid_confined_identity');
    const current = await launchIdentityAsync(fact.path, fact.digest !== null, signal);
    if (
      current.canonical !== fact.canonical ||
      current.device !== fact.device ||
      current.inode !== fact.inode ||
      current.mode !== fact.mode ||
      current.digest !== fact.digest
    )
      throw Error('confined_launch_changed');
  }
}

/** Only after actual group stop; never follow a replaced runtime directory or child symlink. */
export function removeRuntimeTemp(fact: LaunchIdentity): void {
  let current: BigIntStats;
  try {
    current = lstatSync(fact.canonical, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    String(current.dev) !== fact.device ||
    String(current.ino) !== fact.inode
  )
    throw Error('confined_runtime_changed');
  function restore(path: string) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) restore(join(path, name));
  }
  restore(fact.canonical);
  rmSync(fact.canonical, { recursive: true, force: true });
}

/** Required cleanup after original group stop: no early cancellation or recursive I/O fan-out. */
export async function removeRuntimeTempAsync(fact: LaunchIdentity): Promise<void> {
  const release = await cleanupSlots.acquire(uncancelledVerification);
  const unchanged = (stat: BigIntStats, device: string, inode: string) =>
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    String(stat.dev) === device &&
    String(stat.ino) === inode;
  try {
    let root: BigIntStats;
    try {
      root = await lstat(fact.canonical, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!unchanged(root, fact.device, fact.inode)) throw Error('confined_runtime_changed');
    async function remove(path: string, stat: BigIntStats): Promise<void> {
      await verificationStep(uncancelledVerification);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) {
          const child = join(path, name);
          await remove(child, await lstat(child, { bigint: true }));
        }
        if (!unchanged(await lstat(path, { bigint: true }), String(stat.dev), String(stat.ino)))
          throw Error('confined_runtime_changed');
        await rmdir(path);
      } else {
        try {
          await unlink(path);
        } catch (error) {
          // Windows readonly files need their attribute restored before deletion.
          // Never chmod through a substituted file or a directory junction.
          if (
            (error as NodeJS.ErrnoException).code !== 'EPERM' ||
            !stat.isFile() ||
            stat.isSymbolicLink()
          )
            throw error;
          const current = await lstat(path, { bigint: true });
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== stat.dev ||
            current.ino !== stat.ino
          )
            throw Error('confined_runtime_changed');
          await chmod(path, 0o600);
          await unlink(path);
        }
      }
    }
    await remove(fact.canonical, root);
  } finally {
    release();
  }
}
