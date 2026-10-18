import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';

export { privateDirectory };

/** A canonical, owned scratch root with real private permissions on the current OS. */
export function temporaryDirectory(prefix: string): string {
  const parent = realpathSync.native(tmpdir());
  if (process.platform !== 'win32') return mkdtempSync(join(parent, prefix));
  // mkdtemp inherits the Windows temp directory's ACL; mode: 0700 does not protect it.
  const root = join(parent, `${prefix}${randomUUID()}`);
  privateDirectory(root);
  return root;
}

/** Real directory traversal aliases without requiring Windows symlink privileges. */
export function directoryLink(target: string, path: string): void {
  symlinkSync(
    process.platform === 'win32' ? resolve(dirname(path), target) : target,
    path,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/** Private-record consumers reject every reparse entry, including directory junctions. */
export function recordReparseEntry(target: string, path: string): void {
  if (process.platform === 'win32') directoryLink(dirname(resolve(dirname(path), target)), path);
  else symlinkSync(target, path, 'file');
  assert(lstatSync(path).isSymbolicLink());
}

export function expectPrivateMode(path: string, mode: number): void {
  const stat = lstatSync(path);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, mode);
  else {
    const security = defaultWindowsPathSecurity()!;
    if (stat.isDirectory()) security.verifyDirectory(path);
    else {
      security.verifyFile(path);
      assert.equal(stat.nlink, 1);
    }
  }
}

/** Change a real foreign-access ACL on Windows; chmod there cannot express POSIX privacy. */
export function fixturePermissions(path: string, mode: number): void {
  if (process.platform !== 'win32') {
    chmodSync(path, mode);
    return;
  }
  const foreign = mode & 0o077;
  const args = foreign
    ? [path, '/grant:r', `*S-1-1-0:(${foreign & 0o022 ? 'M' : 'R'})`]
    : [path, '/remove:g', '*S-1-1-0'];
  const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), args, {
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw Error('fixture_acl_mutation_failed');
}

/** Deliberate corruption of an owned immutable fixture; restore its real read-only policy. */
export function rewriteArtifact(path: string, content: string | Uint8Array): void {
  const permission = (writable: boolean) => {
    if (process.platform !== 'win32') {
      chmodSync(path, writable ? 0o600 : 0o400);
      return;
    }
    const system = join(process.env.SystemRoot!, 'System32');
    const identity = spawnSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sid = identity.stdout?.match(/S-1-(?:\d+-)*\d+/)?.[0];
    if (identity.error || identity.status !== 0 || !sid) throw Error('fixture_owner_unavailable');
    const result = spawnSync(
      join(system, 'icacls.exe'),
      [path, '/grant:r', `*${sid}:(${writable ? 'F' : 'R'})`],
      { windowsHide: true },
    );
    if (result.error || result.status !== 0) throw Error('fixture_acl_mutation_failed');
  };
  permission(true);
  try {
    writeFileSync(path, content);
  } finally {
    permission(false);
  }
}
