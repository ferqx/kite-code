import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import {
  captureTemporaryWorktreeRoots,
  inspectTemporaryWorktreeTarget,
  isTemporaryWorktreePath,
} from '../../../src/permissions/worktree-path-policy';

test('captures POSIX host temporary roots without treating similar prefixes as temporary', async () => {
  const roots = await captureTemporaryWorktreeRoots({
    platform: 'linux',
    temporaryDirectory: '/runtime/jobs',
    environment: { TMPDIR: '/custom/temp', TMP: 'relative', TEMP: '/other/temp' },
  });
  for (const path of ['/tmp', '/tmp/job', '/var/tmp/tree', '/runtime/jobs/tree', '/custom/temp/a'])
    expect(isTemporaryWorktreePath(path, roots, 'linux'), path).toBe(true);
  for (const path of ['/tmp-project', '/var/tmp-project/tree', '/home/user/project/.worktrees/id'])
    expect(isTemporaryWorktreePath(path, roots, 'linux'), path).toBe(false);
  expect(roots).not.toContain('relative');
  expect(Object.isFrozen(roots)).toBe(true);
});

test('captures macOS public and physical temporary aliases', async () => {
  const roots = await captureTemporaryWorktreeRoots({
    platform: 'darwin',
    temporaryDirectory: '/private/var/folders/aa/user/T',
    environment: {},
  });
  for (const path of [
    '/tmp/tree',
    '/private/tmp/tree',
    '/var/tmp/tree',
    '/var/folders/aa/user/T/tree',
    '/private/var/folders/aa/user/T/tree',
  ])
    expect(isTemporaryWorktreePath(path, roots, 'darwin'), path).toBe(true);
  expect(isTemporaryWorktreePath('/private/var/project/worktrees/id', roots, 'darwin')).toBe(false);
});

test('uses Windows native components, case folding and trusted environment names', async () => {
  const roots = await captureTemporaryWorktreeRoots({
    platform: 'win32',
    temporaryDirectory: 'D:\\Runtime\\Temp',
    environment: {
      Temp: 'C:\\Users\\Ada\\Temp',
      TMP: 'E:\\scratch',
      localappdata: 'C:\\Users\\Ada\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
    },
  });
  for (const path of [
    'd:/runtime/TEMP/tree',
    'c:/users/ada/temp/tree',
    'E:\\scratch\\tree',
    'C:\\Users\\Ada\\AppData\\Local\\Temp\\tree',
    'C:\\Windows\\Temp\\tree',
  ])
    expect(isTemporaryWorktreePath(path, roots, 'win32'), path).toBe(true);
  for (const path of ['D:/Runtime/Temporary/tree', 'C:/Users/Ada/projects/tree'])
    expect(isTemporaryWorktreePath(path, roots, 'win32'), path).toBe(false);
});

test('compares UNC roots without confusing neighbouring shares', () => {
  const roots = ['\\\\server\\share\\Temp'];
  expect(isTemporaryWorktreePath('//SERVER/share/TEMP/new/tree', roots, 'win32')).toBe(true);
  expect(isTemporaryWorktreePath('//server/share/Temporary/tree', roots, 'win32')).toBe(false);
  expect(isTemporaryWorktreePath('//server/other/Temp/tree', roots, 'win32')).toBe(false);
});

test('normalizes lexical dot segments and rejects non-native or NUL paths', () => {
  expect(isTemporaryWorktreePath('/tmp/../home/tree', ['/tmp'], 'linux')).toBe(false);
  expect(isTemporaryWorktreePath('/home/../tmp/tree', ['/tmp'], 'linux')).toBe(true);
  expect(() => isTemporaryWorktreePath('relative/tree', ['/tmp'], 'linux')).toThrow();
  expect(() => isTemporaryWorktreePath('/tmp/tree\0suffix', ['/tmp'], 'linux')).toThrow();
  expect(() => isTemporaryWorktreePath('C:relative', ['C:/Temp'], 'win32')).toThrow();
});

test.skipIf(process.platform === 'win32')(
  'captures real temporary-root aliases and checks missing descendants through existing ancestors',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worktree-path-policy-')));
    try {
      const physical = join(root, 'physical-temp');
      const durable = join(root, 'durable');
      const alias = join(root, 'alias');
      await mkdir(physical);
      await mkdir(durable);
      symlinkSync(physical, alias);
      const captured = await captureTemporaryWorktreeRoots({
        platform: process.platform,
        temporaryDirectory: alias,
        environment: {},
      });
      expect(captured).toContain(alias);
      expect(captured).toContain(physical);
      const missingRoot = await captureTemporaryWorktreeRoots({
        platform: process.platform,
        temporaryDirectory: join(alias, 'missing-root'),
        environment: {},
      });
      expect(missingRoot).toContain(join(physical, 'missing-root'));
      expect(isTemporaryWorktreePath(join(alias, 'missing', 'tree'), [physical])).toBe(false);
      expect(await inspectTemporaryWorktreeTarget(join(alias, 'missing', 'tree'), [physical])).toBe(
        true,
      );
      expect(
        await inspectTemporaryWorktreeTarget(join(durable, 'missing', 'tree'), [physical]),
      ).toBe(false);
    } finally {
      // This fixture contains ordinary empty directories and one symlink, never a Git worktree.
      rmSync(root, { recursive: true, force: true });
    }
  },
);
