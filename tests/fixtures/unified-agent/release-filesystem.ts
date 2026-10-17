/** Real platform filesystem primitives for release fixtures; no verifier or installer bypass. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../packages/agent/src/platform/windows-path-security';
import { directoryLink as directoryAlias } from '../test-filesystem';

export { directoryAlias };

export function releaseScratch(prefix: string): string {
  if (process.platform !== 'win32') return mkdtempSync(prefix);
  const root = join(realpathSync(tmpdir()), `${basename(prefix)}${randomUUID()}`);
  privateDirectory(root);
  return root;
}
export function releaseDirectory(path: string, options?: Parameters<typeof mkdirSync>[1]): void {
  if (process.platform === 'win32') privateDirectory(path);
  else mkdirSync(path, options);
}
export function fileAlias(target: string, path: string): void {
  if (process.platform === 'win32') linkSync(resolve(dirname(path), target), path);
  else symlinkSync(target, path);
}
export function expectReleaseMode(path: string, mode: number): void {
  if (process.platform === 'win32') {
    defaultWindowsPathSecurity()!.verifyFile(path);
    assert.equal(lstatSync(path).nlink, 1);
  } else assert.equal(lstatSync(path).mode & 0o777, mode);
}
/** A relocated fixture must retain private directories, as the actual installer does. */
export function releaseCopy(
  source: string,
  destination: string,
  options?: Parameters<typeof cpSync>[2],
): void {
  if (process.platform !== 'win32') {
    cpSync(source, destination, options);
    return;
  }
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) directoryAlias(readlinkSync(source), destination);
  else if (stat.isDirectory()) {
    releaseDirectory(destination);
    for (const name of readdirSync(source))
      releaseCopy(join(source, name), join(destination, name), options);
  } else copyFileSync(source, destination);
}
export function unsafeReleasePermissions(path: string, posixMode: number): void {
  if (process.platform !== 'win32') {
    chmodSync(path, posixMode);
    return;
  }
  const result = spawnSync(
    join(process.env.SystemRoot!, 'System32/icacls.exe'),
    [path, '/grant', '*S-1-1-0:(M)'],
    { windowsHide: true },
  );
  if (result.error || result.status !== 0) throw Error('fixture_acl_mutation_failed');
}
