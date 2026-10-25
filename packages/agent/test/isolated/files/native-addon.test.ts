import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceFileIo } from '../../../src/files-native-binding';
import { defaultWindowsPathSecurity } from '../../../src/platform/windows-path-security';

test('Node-API capability preserves native publication, complete bytes and protected/no-follow boundaries', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-addon-')));
  mkdirSync(join(root, 'protected'));
  writeFileSync(join(root, 'protected', 'secret'), 'private');
  const io = createNativeWorkspaceFileIo(root, ['protected'], true);
  try {
    const bytes = Buffer.from('\uFEFF完整 α\r\n');
    const temp = io.openAt(io.root, '.created', 'temporary');
    io.write(temp, bytes);
    io.sync(temp);
    defaultWindowsPathSecurity()?.verifyFile(join(root, '.created'));
    const original = io.stat(temp);
    io.publishAt(io.root, '.created', 'Exact.txt', true);
    io.sync(io.root);
    io.closeHandle(temp);
    if (io.createOnlyLeavesTemporary) io.unlinkAt(io.root, '.created');
    const read = io.openAt(io.root, 'Exact.txt', 'read');
    const actual = Buffer.alloc(65536);
    expect(io.read(read, actual)).toBe(bytes.length);
    expect(actual.subarray(0, bytes.length)).toEqual(bytes);
    expect(io.read(read, actual)).toBe(0);
    expect(io.stat(read)).toMatchObject({ dev: original.dev, ino: original.ino });
    io.verifyOwner(read);
    io.closeHandle(read);
    expect(readFileSync(join(root, 'Exact.txt'))).toEqual(bytes);
    const conflict = io.openAt(io.root, '.conflict', 'temporary');
    io.write(conflict, Buffer.from('replacement'));
    expect(() => io.publishAt(io.root, '.conflict', 'Exact.txt', true)).toThrow();
    expect(readFileSync(join(root, 'Exact.txt'))).toEqual(bytes);
    io.publishAt(io.root, '.conflict', 'Exact.txt', false);
    io.closeHandle(conflict);
    expect(readFileSync(join(root, 'Exact.txt'), 'utf8')).toBe('replacement');
    expect(() => io.openAt(io.root, 'protected', 'directory')).toThrow('file_path_protected');
    linkSync(join(root, 'Exact.txt'), join(root, 'hardlink'));
    const linked = io.openAt(io.root, 'hardlink', 'read', true);
    expect(io.stat(linked).nlink).toBe(2n);
    // POSIX create-only publication has a known temporary second link; its TS reader
    // checks the exact expected count. Windows has no such temporary hardlink.
    if (process.platform === 'win32')
      expect(() => io.verifyOwner(linked)).toThrow('file_owner_invalid');
    else io.verifyOwner(linked);
    io.closeHandle(linked);
    rmSync(join(root, 'hardlink'));
    symlinkSync(
      join(root, 'protected'),
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => io.openAt(io.root, 'escape', 'directory')).toThrow();
    expect(
      io
        .listAt(io.root)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['Exact.txt', 'escape']);
    io.unlinkAt(io.root, 'Exact.txt', true);
    expect(existsSync(join(root, 'Exact.txt'))).toBe(false);
    io.close();
    expect(() => io.verifyRoot()).toThrow('file_closed');
  } finally {
    io.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native directory creation is create-only, private and anchored without following existing links', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-parent-')));
  const io = createNativeWorkspaceFileIo(root, ['protected'], false);
  try {
    const parent = io.openAt(io.root, 'created', 'create-directory', true);
    expect(io.stat(parent).isDirectory()).toBe(true);
    io.verifyOwner(parent);
    if (process.platform === 'win32')
      defaultWindowsPathSecurity()!.verifyDirectory(join(root, 'created'));
    else expect(statSync(join(root, 'created')).mode & 0o777).toBe(0o700);
    expect(() => io.openAt(io.root, 'created', 'create-directory', true)).toThrow('EEXIST');
    expect(() => io.openAt(io.root, 'protected', 'create-directory', true)).toThrow(
      'file_path_protected',
    );
    expect(existsSync(join(root, 'protected'))).toBe(false);
    const child = io.openAt(parent, 'nested', 'create-directory', true);
    io.verifyOwner(child);
    expect(io.stat(child).isDirectory()).toBe(true);
    io.closeHandle(child);
    io.closeHandle(parent);
    symlinkSync(
      join(root, 'created'),
      join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => io.openAt(io.root, 'link', 'create-directory', true)).toThrow();
    expect(() => io.openAt(io.root, 'link', 'directory', true)).toThrow();
  } finally {
    io.close();
    rmSync(root, { recursive: true, force: true });
  }
});
