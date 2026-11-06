import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { defaultWindowsPathSecurity } from '../../platform/windows-path-security';
import { limits } from './protocol';

export class WorktreeError extends Error {
  readonly code: string;
  readonly facts: Record<string, unknown>;
  constructor(code: string, message: string, facts: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.facts = facts;
  }
}
export function fail(code: string, message: string, facts: Record<string, unknown> = {}): never {
  throw new WorktreeError(code, message, facts);
}
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(
      'unsupported_path_encoding',
      'Git or filesystem data is not lossless UTF-8; inspect the original byte paths.',
    );
  }
}
export function validPath(path: string): void {
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    Buffer.byteLength(path) > limits.pathBytes ||
    utf8(Buffer.from(path)) !== path
  )
    fail(
      'invalid_worktree_arguments',
      'Use a lossless native absolute path of at most 4096 UTF-8 bytes.',
    );
}
export function samePath(left: string, right: string): boolean {
  const normalize = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}
export function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === '' ||
    (!isAbsolute(childRelative) && childRelative !== '..' && !childRelative.startsWith(`..${sep}`))
  );
}
export interface PathIdentity {
  dev: string;
  ino: string;
  ctimeNs: string;
  birthtimeNs: string;
}
export function identity(path: string): PathIdentity {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: String(stat.birthtimeNs),
  };
}
export function sameIdentity(left: PathIdentity, right: PathIdentity, generation = true): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    (!generation || left.ctimeNs === right.ctimeNs)
  );
}
export function inspectPath(path: string, directory?: boolean): void {
  validPath(path);
  if (process.platform === 'win32') {
    try {
      const security = defaultWindowsPathSecurity()!;
      security.verifyPath(path);
      // Opening the actual entry also rejects dangling/non-symlink reparse points.
      const stat = lstatSync(path);
      if (stat.isDirectory()) security.verifyScopeDirectory(path);
      else if (stat.isFile()) {
        // verifyPath uses native FILE_ATTRIBUTE_REPARSE_POINT for existing entries.
        // A dangling entry must not slip through its existence test.
        if (!samePath(realpathSync(path), path))
          fail('unsafe_reparse_point', 'A Windows entry redirects to a different physical path.');
      } else fail('unsafe_reparse_point', 'The Windows entry has an unsupported or reparse type.');
    } catch {
      fail(
        'unsafe_reparse_point',
        'A Windows path or ancestor is a reparse point or could not be verified.',
      );
    }
  }
  const chain: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    chain.unshift(current);
    if (current === parse(current).root) break;
  }
  for (let index = 0; index < chain.length; index++) {
    const entry = chain[index]!;
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink())
      fail(
        'unsafe_symlink',
        'A path or ancestor is a symbolic link; use its verified physical path.',
        { path: entry },
      );
    if (index < chain.length - 1 && !stat.isDirectory())
      fail('unsafe_target_path', 'A path ancestor is not a directory.');
    if (
      index === chain.length - 1 &&
      directory !== undefined &&
      (directory ? !stat.isDirectory() : !stat.isFile())
    )
      fail('unsafe_target_path', 'The path has an unexpected filesystem type.');
  }
}
export function canonicalDirectory(path: string): string {
  validPath(path);
  // macOS exposes these fixed, root-owned system aliases. All other links remain refused.
  if (process.platform === 'darwin') {
    for (let current = resolve(path); current !== parse(current).root; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink() && !['/tmp', '/var', '/etc'].includes(current))
        fail('unsafe_symlink', 'A user path ancestor is a symbolic link.');
    }
    path = realpathSync(path);
  }
  inspectPath(path, true);
  return realpathSync(path);
}
export function targetPath(path: string): string {
  validPath(path);
  return join(canonicalDirectory(dirname(path)), parse(path).base);
}
export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export function readOrdinaryFile(path: string, maxBytes: number): Buffer {
  inspectPath(path, false);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes))
      fail('inspection_limit', 'A required ordinary file exceeds the inspection limit.');
    const result = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, result, offset, result.length - offset, null);
      if (!count) break;
      offset += count;
      if (offset > Number(before.size))
        fail('path_scan_incomplete', 'A required file changed while being read.');
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    for (const field of ['dev', 'ino', 'ctimeNs', 'mtimeNs', 'size'] as const)
      if (before[field] !== after[field] || before[field] !== current[field])
        fail('path_scan_incomplete', 'A required file changed while being read.');
    if (offset !== Number(before.size))
      fail('path_scan_incomplete', 'A required file could not be completely read.');
    return result.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function mountSnapshot(): { targets: string[]; digest: string } {
  try {
    if (process.platform === 'linux') {
      const data = readFileSync('/proc/self/mountinfo');
      if (data.length > 16 * 1024 * 1024)
        fail(
          'unsupported_mount_inspection',
          'The platform mount table exceeds the inspection limit.',
        );
      const text = utf8(data);
      if (!text.endsWith('\n'))
        fail('unsupported_mount_inspection', 'The platform mount table is incomplete.');
      const targets = text
        .slice(0, -1)
        .split('\n')
        .map((line) => {
          const split = line.indexOf(' - '),
            fields = line.slice(0, split).split(' ');
          if (
            split < 0 ||
            fields.length < 6 ||
            !/^\d+$/.test(fields[0]!) ||
            !/^\d+$/.test(fields[1]!)
          )
            fail('unsupported_mount_inspection', 'The platform mount table is malformed.');
          if (!/^(?:[^\\]|\\(?:040|011|012|134))+$/.test(fields[4]!))
            fail('unsupported_mount_inspection', 'The mount path escape sequence is malformed.');
          const path = fields[4]!.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          );
          validPath(path);
          return resolve(path);
        })
        .sort();
      return { targets, digest: sha256(data) };
    }
    if (process.platform === 'darwin') {
      // Darwin statfs64: 2168 bytes, f_mntonname[1024] at offset 88.
      const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
      const native = dlopen('/usr/lib/libSystem.B.dylib', {
        getfsstat64: { args: ['ptr', 'i32', 'i32'], returns: 'i32' },
      });
      try {
        const count = native.symbols.getfsstat64(null, 0, 2);
        if (count < 1 || count > 100000)
          fail('unsupported_mount_inspection', 'The native mount count is unavailable.');
        const bytes = new Uint8Array((count + 16) * 2168);
        const actual = native.symbols.getfsstat64(ptr(bytes), bytes.length, 2);
        if (actual < 1 || actual >= count + 16)
          fail('unsupported_mount_inspection', 'The native mount snapshot is incomplete.');
        const paths: string[] = [],
          records: string[] = [];
        for (let index = 0; index < actual; index++) {
          const field = bytes.subarray(index * 2168 + 88, index * 2168 + 1112);
          const end = field.indexOf(0);
          if (end < 1)
            fail('unsupported_mount_inspection', 'The native mount path is not terminated.');
          const path = utf8(field.subarray(0, end));
          validPath(path);
          paths.push(resolve(path));
          // Stable mount identity/flags/names; exclude changing free-space counters.
          records.push(
            Buffer.from(bytes.subarray(index * 2168 + 48, index * 2168 + 2136)).toString('hex'),
          );
        }
        if (!paths.includes('/'))
          fail('unsupported_mount_inspection', 'The native mount snapshot has no root filesystem.');
        return { targets: paths.sort(), digest: sha256(records.sort().join('\n')) };
      } finally {
        native.close();
      }
    }
    if (process.platform === 'win32') return { targets: [], digest: 'windows-native-reparse-scan' }; // Every traversed entry uses native reparse verification.
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail('unsupported_mount_inspection', 'The complete platform mount table could not be read.');
  }
  return fail(
    'unsupported_mount_inspection',
    'This platform has no supported mount-table inspection.',
  );
}
export function mountTargets(): string[] {
  return mountSnapshot().targets;
}
export interface TrackedTreeEvidence {
  directories: { path: string; identity: PathIdentity; entriesDigest: string }[];
  mountDigest: string;
}
function directoryEntries(path: string): Buffer[] {
  return readdirSync(path, { encoding: 'buffer' }).sort(Buffer.compare);
}
function entryNamesDigest(names: Buffer[]): string {
  // Filesystem entry names cannot contain NUL, so byte names remain unambiguous.
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update('\0');
  return hash.digest('hex');
}
export function verifyTrackedTree(evidence: TrackedTreeEvidence): void {
  if (mountSnapshot().digest !== evidence.mountDigest)
    fail('unsupported_mount_inspection', 'The mount table changed during inspection.');
  try {
    for (const directory of evidence.directories) {
      inspectPath(directory.path, true);
      if (
        !sameIdentity(directory.identity, identity(directory.path)) ||
        entryNamesDigest(directoryEntries(directory.path)) !== directory.entriesDigest ||
        !sameIdentity(directory.identity, identity(directory.path))
      )
        fail('path_scan_incomplete', 'A directory changed during deletion inspection.');
    }
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail('path_scan_incomplete', 'The worktree directory proof could not be completely verified.');
  }
  if (mountSnapshot().digest !== evidence.mountDigest)
    fail('unsupported_mount_inspection', 'The mount table changed during inspection.');
}
export function scanTrackedTree(
  root: string,
  files: Set<string>,
  limit: number = limits.scanEntries,
): TrackedTreeEvidence {
  const mounts = mountSnapshot();
  if (mounts.targets.some((mount) => containsPath(root, mount)))
    fail('unsafe_mount_point', 'The worktree contains a mount boundary; leave it intact.');
  const directories = new Set<string>(['']);
  for (const file of files) {
    let parent = posix.dirname(file);
    while (parent !== '.') {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  let count = 0;
  const evidence: TrackedTreeEvidence = { directories: [], mountDigest: mounts.digest };
  const walk = (directory: string, prefix: string) => {
    inspectPath(directory, true);
    const before = identity(directory);
    const names = directoryEntries(directory);
    for (const bytes of names) {
      if (++count > limit) fail('inspection_limit', 'The worktree scan exceeds 100000 entries.');
      const name = utf8(bytes),
        local = prefix ? `${prefix}/${name}` : name,
        path = join(directory, name);
      inspectPath(path);
      const stat = lstatSync(path);
      if (local === '.git') {
        if (!stat.isFile())
          fail('not_linked_worktree', 'The linked worktree pointer must be an ordinary file.');
      } else if (stat.isDirectory()) {
        if (!directories.has(local))
          fail(
            'local_content_present',
            'An extra directory contains local content, even when it is empty.',
            { path },
          );
        walk(path, local);
      } else if (!stat.isFile())
        fail('local_content_present', 'A symbolic link or special file prevents deletion.', {
          path,
        });
      else if (!files.has(local))
        fail('local_content_present', 'An untracked or ignored file prevents deletion.', { path });
    }
    if (!sameIdentity(before, identity(directory)))
      fail('path_scan_incomplete', 'A directory changed during deletion inspection.');
    evidence.directories.push({
      path: directory,
      identity: before,
      entriesDigest: entryNamesDigest(names),
    });
  };
  try {
    walk(root, '');
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail('path_scan_incomplete', 'The worktree could not be completely inspected.');
  }
  verifyTrackedTree(evidence);
  return evidence;
}

export function acquireLock(commonDir: string, operationToken: string): { release(): void } {
  inspectPath(commonDir, true);
  const path = join(commonDir, 'kite-worktree-operation.lock');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: unknown;
    try {
      inspectPath(path, true);
      owner = JSON.parse(utf8(readOrdinaryFile(join(path, 'owner.json'), 4096)));
      if (
        !owner ||
        typeof owner !== 'object' ||
        Array.isArray(owner) ||
        Object.keys(owner).sort().join() !== 'nonce,operationToken' ||
        !/^[a-f0-9]{64}$/.test(String((owner as Record<string, unknown>).operationToken)) ||
        !/^[a-f0-9-]{36}$/.test(String((owner as Record<string, unknown>).nonce))
      )
        throw Error('invalid_lock_owner');
    } catch {
      fail(
        'lock_state_unknown',
        'An existing repository lock cannot be verified; inspect the original managed operation.',
      );
    }
    return fail(
      'worktree_busy',
      'Another repository operation owns the lock; observe that operation without removing its lock.',
      { owner },
    );
  }
  const nonce = randomUUID(),
    ownerPath = join(path, 'owner.json');
  const value = JSON.stringify({ operationToken, nonce });
  try {
    writeFileSync(ownerPath, value, { flag: 'wx', mode: 0o600 });
  } catch {
    fail(
      'lock_state_unknown',
      'This operation could not finish its lock owner record; preserve the lock and inspect the original operation.',
    );
  }
  const lockIdentity = identity(path),
    ownerIdentity = identity(ownerPath);
  return {
    release() {
      try {
        inspectPath(path, true);
        if (
          !sameIdentity(lockIdentity, identity(path)) ||
          !sameIdentity(ownerIdentity, identity(ownerPath)) ||
          utf8(readOrdinaryFile(ownerPath, 4096)) !== value ||
          readdirSync(path).join() !== 'owner.json'
        )
          fail(
            'worktree_lock_cleanup_failed',
            'The repository lock no longer belongs exclusively to this operation.',
          );
        unlinkSync(ownerPath);
        rmdirSync(path);
      } catch (error) {
        if (error instanceof WorktreeError) throw error;
        fail(
          'worktree_lock_cleanup_failed',
          'The mutation ended but its repository lock could not be safely removed.',
        );
      }
    },
  };
}
