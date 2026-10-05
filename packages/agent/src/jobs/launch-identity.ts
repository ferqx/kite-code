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
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

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
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile())
        throw Error('confined_launch_changed');
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(canonical, { bigint: true });
      if (
        after.size !== BigInt(bytes.length) ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        current.dev !== after.dev ||
        current.ino !== after.ino
      )
        throw Error('confined_launch_changed');
      digest = createHash('sha256').update(bytes).digest('hex');
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
