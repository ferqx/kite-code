import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
import { join } from 'node:path';
import { editorFileTarget } from '../electron/editor';
import { queryBranch, switchBranch } from '../electron/git';
import {
  knownProject,
  readProjectDisplay,
  readProjects,
  rememberProject,
} from '../electron/projects';

test('project registry is explicit, canonical, deduplicated and preserves missing entries', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-projects-')));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const data = join(root, 'data');
    mkdirSync(first);
    mkdirSync(second);
    expect(readProjects(data)).toEqual([]);
    expect(() => knownProject(data, first)).toThrow();
    rememberProject(data, first);
    rememberProject(data, second);
    rememberProject(data, first);
    expect(readProjects(data).map((project) => project.path)).toEqual([first, second]);
    expect(knownProject(data, first)).toBe(first);
    rmSync(second, { recursive: true });
    expect(() => knownProject(data, second)).toThrow();
    expect(readProjectDisplay(data).map((project) => project.directoryMissing)).toEqual([
      false,
      true,
    ]);
    expect(readFileSync(join(data, 'projects.json'), 'utf8')).not.toContain('directoryMissing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editor targets stay inside the unchanged workspace and reject symlink escapes', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-editor-')));
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'hello world.ts'), 'export {};');
    writeFileSync(join(root, 'outside.ts'), 'private');
    expect(editorFileTarget(workspace, 'hello world.ts')).toBe(join(workspace, 'hello world.ts'));
    expect(() => editorFileTarget(workspace, '../outside.ts')).toThrow();
    expect(() => editorFileTarget(workspace, join(root, 'outside.ts'))).toThrow();
    expect(() => editorFileTarget(workspace, 'missing.ts')).toThrow();
    expect(() => editorFileTarget(workspace, '.')).toThrow();
    expect(() => editorFileTarget(workspace, 'hello\nworld.ts')).toThrow();
    symlinkSync(join(root, 'outside.ts'), join(workspace, 'escape.ts'));
    expect(() => editorFileTarget(workspace, 'escape.ts')).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git switching requires a clean repository root and the observed environment identity', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-git-')));
  try {
    expect((await queryBranch(root)).repository).toBe(false);
    git(root, 'init', '--initial-branch=main');
    writeFileSync(join(root, 'file.txt'), 'main\n');
    git(root, 'add', 'file.txt');
    git(
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial',
    );
    git(root, 'branch', 'feature');
    const before = await queryBranch(root);
    expect(before).toMatchObject({
      repository: true,
      current: 'main',
      dirty: false,
      canSwitch: true,
    });
    await expect(switchBranch(root, 'missing', before)).rejects.toThrow('不存在');
    const changed = await switchBranch(root, 'feature', before);
    expect(changed.current).toBe('feature');
    await expect(switchBranch(root, 'main', before)).rejects.toThrow('改变');

    writeFileSync(join(root, 'file.txt'), 'keep my edit\n');
    const dirty = await queryBranch(root);
    await expect(switchBranch(root, 'main', dirty)).rejects.toThrow('改动');
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('keep my edit\n');
    git(root, 'restore', 'file.txt');
    mkdirSync(join(root, 'nested'));
    const nested = await queryBranch(join(root, 'nested'));
    expect(nested.canSwitch).toBe(false);
    await expect(switchBranch(join(root, 'nested'), 'main', nested)).rejects.toThrow('根目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable Git marker does not block an ordinary workspace', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-non-git-')));
  try {
    writeFileSync(join(root, '.git'), 'invalid git marker\n');
    const workspace = join(root, 'notes');
    mkdirSync(workspace);

    expect((await queryBranch(root)).repository).toBe(false);
    expect(await queryBranch(workspace)).toEqual({
      workspace,
      repository: false,
      root: null,
      current: null,
      head: null,
      branches: [],
      dirty: false,
      canSwitch: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(directory: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdio: 'pipe',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`);
}
