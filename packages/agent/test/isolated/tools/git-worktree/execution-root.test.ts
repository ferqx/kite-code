import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import {
  inspectWorktreeExecutionRoot,
  inspectWorktreeSource,
  parseWorktreeRootRequest,
} from '../../../../src/tools/git-worktree/execution-root';
import { Git } from '../../../../src/tools/git-worktree/git';
import { sha256 } from '../../../../src/tools/git-worktree/paths';

const available = Bun.which('git');
const onWindows = process.platform === 'win32';
const gitTest = available && (!onWindows || process.arch === 'x64') ? test : test.skip;
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([available!, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH!,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: onWindows ? 'NUL' : '/dev/null',
      ...(onWindows ? { SystemRoot: process.env.SystemRoot!, USERPROFILE: cwd } : {}),
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
  const path = onWindows ? 'C:\\repo\\tree' : '/repo/tree';
  expect(parseWorktreeRootRequest({ action: 'use', path })).toEqual({ action: 'use', path });
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
    expect(() => inspectWorktreeExecutionRoot(source, source)).toThrow('not_linked_worktree');
    expect(() => inspectWorktreeExecutionRoot(source, join(root, 'missing'))).toThrow(
      'not_linked_worktree',
    );
    expect(() => inspectWorktreeExecutionRoot(target, foreign)).toThrow(
      'worktree_repository_mismatch',
    );
    const alias = join(root, 'alias');
    symlinkSync(target, alias, onWindows ? 'junction' : 'dir');
    expect(() => inspectWorktreeExecutionRoot(source, alias)).toThrow(
      onWindows ? 'unsafe_reparse_point' : 'unsafe_symlink',
    );
    const fake = join(root, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, '.git'), `gitdir: ${join(source, '.git/worktrees/target')}\n`);
    expect(() => inspectWorktreeExecutionRoot(source, fake)).toThrow('worktree_root_unverifiable');
  },
);

gitTest(
  'bounded source discovery rejects an unauthorized enclosing repo and permits a verified subdirectory',
  async () => {
    const root = persistentWorktreeDirectory('activation-boundary-');
    const source = join(root, 'repo');
    const child = join(source, 'selected');
    const target = join(root, 'linked');
    const hooks = join(root, 'hooks');
    repository(source);
    mkdirSync(child);
    mkdirSync(hooks);
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    // This selected workspace has no .git, even though ordinary Git can discover the parent.
    expect(() => inspectWorktreeSource(child)).toThrow('within the authorized workspace');
    expect(() => inspectWorktreeExecutionRoot(child, child)).toThrow('not_git_repository');
    expect(inspectWorktreeSource(child, source).root).toBe(source);
    expect(inspectWorktreeExecutionRoot(child, target, source).path).toBe(target);
    const reader = new Git(available!, sha256(readFileSync(available!)), hooks);
    await expect(reader.repository(child)).rejects.toMatchObject({ code: 'not_git_repository' });
    const repo = await reader.repository(child, source);
    expect(
      (await reader.list(repo)).map(({ path }) => path.replaceAll('/', onWindows ? '\\' : '/')),
    ).toEqual([source, target]);
    expect((await reader.repository(target)).commonDir).toBe(repo.commonDir);
  },
);

gitTest('selection evidence detects a replacement at the same registered linked path', () => {
  const root = persistentWorktreeDirectory('activation-replaced-');
  const source = join(root, 'source');
  const target = join(root, 'linked');
  repository(source);
  git(source, 'worktree', 'add', '--detach', target, 'HEAD');
  const original = inspectWorktreeExecutionRoot(source, target);
  const pointer = readFileSync(join(target, '.git'));
  renameSync(target, join(root, 'original'));
  mkdirSync(target);
  writeFileSync(join(target, '.git'), pointer);
  const replacement = inspectWorktreeExecutionRoot(source, target);
  expect(replacement.identity).not.toEqual(original.identity);
  expect(replacement.repositoryRevision).not.toBe(original.repositoryRevision);
});
