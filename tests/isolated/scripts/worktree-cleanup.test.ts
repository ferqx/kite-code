import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { checkWorktreeCleanup, inspectCleanupTree } from '../../../scripts/check-worktree-cleanup';

function cleanup(root: string, links: string[] = []) {
  const owned = realpathSync(root);
  if (!owned.startsWith(realpathSync(tmpdir()) + sep)) throw Error('fixture_outside_temp');
  for (const link of links) {
    if (!resolve(link).startsWith(owned + sep) || !lstatSync(link).isSymbolicLink())
      throw Error('unexpected_fixture_link');
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  }
  rmSync(owned, { recursive: true, force: true });
}

test('cleanup inspection rejects a dependency junction chain without walking or changing its source', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cleanup-links-')));
  const primary = join(root, 'primary');
  const checkout = join(root, 'checkout');
  const marker = join(primary, 'packages/ui/source.ts');
  mkdirSync(join(primary, 'packages/ui'), { recursive: true });
  mkdirSync(join(primary, 'node_modules/@kite-ai'), { recursive: true });
  mkdirSync(checkout);
  writeFileSync(marker, 'keep original source');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(primary, 'packages/ui'), join(primary, 'node_modules/@kite-ai/ui'), kind);
  symlinkSync(join(primary, 'node_modules'), join(checkout, 'node_modules'), kind);
  try {
    const result = inspectCleanupTree(checkout);
    expect(result.map((entry) => entry.path)).toEqual([join(checkout, 'node_modules')]);
    expect(readFileSync(marker, 'utf8')).toBe('keep original source');
    expect(existsSync(join(primary, 'node_modules/@kite-ai/ui'))).toBe(true);
    expect(inspectCleanupTree(join(checkout, 'node_modules/@kite-ai/ui'))[0]?.path).toBe(
      join(checkout, 'node_modules'),
    );
  } finally {
    cleanup(root, [join(checkout, 'node_modules'), join(primary, 'node_modules/@kite-ai/ui')]);
  }
});

test('cleanup inspection rejects internal cycles and broken links without following them', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cleanup-cycle-')));
  const link = join(root, 'cycle');
  const absent = join(root, 'absent');
  const broken = join(root, 'broken');
  mkdirSync(absent);
  symlinkSync(absent, broken, process.platform === 'win32' ? 'junction' : 'dir');
  rmdirSync(absent);
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    expect(
      inspectCleanupTree(root)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([broken, link].sort());
  } finally {
    cleanup(root, [link, broken]);
  }
});

test('cleanup cannot approve the primary checkout or an unregistered ordinary directory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cleanup-repository-')));
  const other = join(root, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', root]);
  try {
    expect(() => checkWorktreeCleanup(root, root)).toThrow('cleanup_primary_worktree_forbidden');
    expect(() => checkWorktreeCleanup(root, other)).toThrow(
      'cleanup_unregistered_worktree_forbidden',
    );
    expect(() => inspectCleanupTree('relative')).toThrow('cleanup_path_must_be_absolute');
    expect(inspectCleanupTree(resolve(other))).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test('a registered secondary checkout passes only while it contains no links', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cleanup-registered-')));
  const primary = join(root, 'primary');
  const checkout = join(root, 'checkout');
  mkdirSync(primary);
  execFileSync('git', ['init', '-q', primary]);
  execFileSync('git', [
    '-C',
    primary,
    '-c',
    'core.hooksPath=NUL',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit',
    '-qm',
    'fixture',
    '--allow-empty',
  ]);
  execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', '--detach', checkout, 'HEAD']);
  const link = join(checkout, 'shared');
  try {
    expect(checkWorktreeCleanup(primary, checkout).safe).toBe(true);
    symlinkSync(primary, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(checkWorktreeCleanup(primary, checkout).safe).toBe(false);
    expect(existsSync(join(primary, '.git'))).toBe(true);
  } finally {
    cleanup(root, existsSync(link) ? [link] : []);
  }
});
