import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import {
  inspectWorktreeExecutionRoot,
  parseWorktreeRootRequest,
} from '../../../../src/tools/git-worktree/execution-root';

const available = Bun.which('git');
const gitTest = available && process.platform !== 'win32' ? test : test.skip;
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([available!, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH!,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
}
function repository(root: string) {
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'file'), 'fixture');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
}
test('only explicit closed use/exit requests select a session execution root', () => {
  expect(parseWorktreeRootRequest({ action: 'use', path: '/repo/tree' })).toEqual({
    action: 'use',
    path: '/repo/tree',
  });
  expect(parseWorktreeRootRequest({ action: 'exit' })).toEqual({ action: 'exit' });
  for (const request of [
    { action: 'use', path: 'relative' },
    { action: 'exit', path: '/other' },
    { action: 'create', path: '/repo/tree' },
    { action: 'use', path: '/repo/tree', filesystem: 'full_access' },
    { action: 'observe', operationRef: 'gw_example' },
  ])
    expect(parseWorktreeRootRequest(request)).toBeNull();
});
gitTest(
  'activation proof requires the same repository and exact non-symlink double registration',
  () => {
    const root = persistentWorktreeDirectory('activation-proof-');
    const source = join(root, 'source'),
      target = join(root, 'target'),
      foreign = join(root, 'foreign');
    repository(source);
    repository(foreign);
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    expect(inspectWorktreeExecutionRoot(source, target).path).toBe(target);
    expect(() => inspectWorktreeExecutionRoot(foreign, target)).toThrow(
      'worktree_repository_mismatch',
    );
    expect(() => inspectWorktreeExecutionRoot(source, source)).toThrow(
      'worktree_repository_mismatch',
    );
    const alias = join(root, 'alias');
    symlinkSync(target, alias);
    expect(() => inspectWorktreeExecutionRoot(source, alias)).toThrow();
    const fake = join(root, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, '.git'), `gitdir: ${join(source, '.git/worktrees/target')}\n`);
    expect(() => inspectWorktreeExecutionRoot(source, fake)).toThrow('worktree_root_unverifiable');
  },
);
