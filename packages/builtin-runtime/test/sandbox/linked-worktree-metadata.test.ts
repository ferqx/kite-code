import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRegisteredGitMetadataReadOnlyRoots } from '../../src/git';
import { generateBwrapArgs, generateSandboxProfile } from '../../src/sandbox';

function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Kite Test',
      GIT_AUTHOR_EMAIL: 'kite@example.invalid',
      GIT_COMMITTER_NAME: 'Kite Test',
      GIT_COMMITTER_EMAIL: 'kite@example.invalid',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
  });
}

function realRepository(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-linked-sandbox-primary-'));
  git(workspace, 'init', '--quiet');
  writeFileSync(join(workspace, 'README.md'), 'fixture\n');
  git(workspace, 'add', 'README.md');
  git(workspace, 'commit', '--quiet', '-m', 'initial');
  return workspace;
}

describe.skipIf(process.platform === 'win32')('linked worktree sandbox metadata roots', () => {
  test('grants only the reciprocal registered common Git directory as read-only', () => {
    const primary = realRepository();
    const linked = mkdtempSync(join(tmpdir(), 'kite-linked-sandbox-worktree-'));
    rmSync(linked, { recursive: true, force: true });
    try {
      git(primary, 'worktree', 'add', '--quiet', '-b', 'linked-sandbox-test', linked);
      const commonDir = realpathSync.native(join(primary, '.git'));
      const roots = resolveRegisteredGitMetadataReadOnlyRoots(linked);
      expect(roots).toEqual([commonDir]);

      const profile = generateSandboxProfile(linked, { runtimeReadOnlyRoots: roots });
      expect(profile).toContain(`(subpath "${commonDir}")`);

      const args = generateBwrapArgs(linked, { runtimeReadOnlyRoots: roots });
      expect(args).toEqual(expect.arrayContaining(['--ro-bind', commonDir, commonDir]));
      expect(
        args.some(
          (value, index) =>
            value === '--bind' && args[index + 1] === commonDir && args[index + 2] === commonDir,
        ),
      ).toBe(false);
    } finally {
      try {
        git(primary, 'worktree', 'remove', '--force', linked);
      } catch {
        // The bounded fixture cleanup below handles an already-removed worktree.
      }
      rmSync(linked, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  });

  test('an arbitrary external gitfile or symlinked metadata grants nothing', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-linked-sandbox-hostile-'));
    const external = mkdtempSync(join(tmpdir(), 'kite-linked-sandbox-private-'));
    try {
      mkdirSync(join(external, 'worktrees', 'fake'), { recursive: true });
      writeFileSync(join(external, 'worktrees', 'fake', 'commondir'), '../..\n');
      writeFileSync(join(external, 'worktrees', 'fake', 'gitdir'), join(workspace, '.git'));
      writeFileSync(join(workspace, '.git'), `gitdir: ${join(external, 'worktrees', 'fake')}\n`);
      expect(resolveRegisteredGitMetadataReadOnlyRoots(workspace)).toEqual([]);

      rmSync(join(workspace, '.git'));
      symlinkSync(join(external, 'worktrees', 'fake'), join(workspace, '.git'));
      expect(resolveRegisteredGitMetadataReadOnlyRoots(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test('a broken reciprocal backlink grants nothing', () => {
    const primary = realRepository();
    const linked = mkdtempSync(join(tmpdir(), 'kite-linked-sandbox-broken-'));
    rmSync(linked, { recursive: true, force: true });
    try {
      git(primary, 'worktree', 'add', '--quiet', '-b', 'linked-sandbox-broken', linked);
      const gitDirLine = readFileSync(join(linked, '.git'), 'utf8').trim();
      const gitDir = realpathSync.native(gitDirLine.slice('gitdir:'.length).trim());
      writeFileSync(join(gitDir, 'gitdir'), join(dirname(linked), 'different', '.git'));
      expect(resolveRegisteredGitMetadataReadOnlyRoots(linked)).toEqual([]);
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  });
});
