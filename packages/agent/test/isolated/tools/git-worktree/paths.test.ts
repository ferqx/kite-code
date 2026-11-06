import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mountTargets,
  scanTrackedTree,
  verifyTrackedTree,
} from '../../../../src/tools/git-worktree/paths';

function root() {
  return fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'kite-worktree-paths-')));
}
function mockMounts(paths: string[], changed = false) {
  if (process.platform === 'darwin') {
    const ffi = require('bun:ffi') as typeof import('bun:ffi');
    let calls = 0;
    return spyOn(ffi, 'dlopen').mockImplementation((() => ({
      symbols: {
        getfsstat64(pointer: import('bun:ffi').Pointer | null, _size: number, _flags: number) {
          if (pointer === null) return paths.length;
          const bytes = new Uint8Array(ffi.toArrayBuffer(pointer, 0, (paths.length + 16) * 2168));
          bytes.fill(0);
          paths.forEach((path, index) => {
            bytes.set(Buffer.from(path), index * 2168 + 88);
          });
          if (changed) bytes[48] = ++calls;
          return paths.length;
        },
      },
      close() {},
    })) as unknown as typeof ffi.dlopen);
  }
  const original = fs.readFileSync;
  let calls = 0;
  return spyOn(fs, 'readFileSync').mockImplementation(((
    path: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (path === '/proc/self/mountinfo') {
      calls++;
      const mountEscape = (path: string) =>
        path
          .replace(/\\/g, '\\134')
          .replace(/ /g, '\\040')
          .replace(/\t/g, '\\011')
          .replace(/\n/g, '\\012');
      return Buffer.from(
        paths
          .map(
            (path, index) =>
              `${index + 1} 0 8:${index + 1 + (changed ? calls : 0)} / ${mountEscape(path)} rw - ext4 /dev/test rw\n`,
          )
          .join(''),
      );
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
}
test('mount boundaries are refused before traversing the target', () => {
  if (process.platform === 'win32') return;
  const directory = root();
  const mounts = mockMounts(['/', directory]);
  try {
    expect(() => scanTrackedTree(directory, new Set())).toThrow('mount boundary');
  } finally {
    mounts.mockRestore();
    fs.rmdirSync(directory);
  }
});
test('mount identity changes fail closed even when mount paths are unchanged', () => {
  if (process.platform === 'win32') return;
  const directory = root(),
    mounts = mockMounts(['/'], true);
  try {
    expect(() => scanTrackedTree(directory, new Set())).toThrow('mount table changed');
  } finally {
    mounts.mockRestore();
    fs.rmdirSync(directory);
  }
});
test('unavailable native mount table never falls back to st_dev', () => {
  if (process.platform === 'win32') return;
  if (process.platform === 'darwin') {
    const ffi = require('bun:ffi') as typeof import('bun:ffi');
    const mocked = spyOn(ffi, 'dlopen').mockImplementation(() => {
      throw Error('injected mount denial');
    });
    try {
      expect(() => mountTargets()).toThrow('mount table could not be read');
    } finally {
      mocked.mockRestore();
    }
  } else {
    const original = fs.readFileSync,
      mocked = spyOn(fs, 'readFileSync').mockImplementation(((
        path: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        if (path === '/proc/self/mountinfo') throw Error('injected mount denial');
        return (original as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync);
    try {
      expect(() => mountTargets()).toThrow('mount table could not be read');
    } finally {
      mocked.mockRestore();
    }
  }
});
test('recursive inspection refuses entry limits and leaves every file intact', () => {
  const directory = root();
  fs.writeFileSync(join(directory, 'a'), 'a');
  fs.writeFileSync(join(directory, 'b'), 'b');
  expect(() => scanTrackedTree(directory, new Set(['a', 'b']), 1)).toThrow('100000 entries');
  expect(fs.readFileSync(join(directory, 'a'), 'utf8')).toBe('a');
  expect(fs.readFileSync(join(directory, 'b'), 'utf8')).toBe('b');
  fs.unlinkSync(join(directory, 'a'));
  fs.unlinkSync(join(directory, 'b'));
  fs.rmdirSync(directory);
});
test('a closed tree proof rejects nested additions even when directory timestamps collide', () => {
  const directory = root(),
    nested = join(directory, 'nested'),
    tracked = join(nested, 'tracked');
  fs.mkdirSync(nested);
  fs.writeFileSync(tracked, 'tracked');
  const tree = scanTrackedTree(directory, new Set(['nested/tracked']));
  const before = fs.lstatSync(nested, { bigint: true });
  fs.writeFileSync(join(nested, 'ignored-local'), 'preserve');
  const original = fs.lstatSync;
  const stat = spyOn(fs, 'lstatSync').mockImplementation(((
    path: fs.PathLike,
    options?: { bigint?: boolean },
  ) =>
    path === nested && options?.bigint
      ? before
      : original(path, options as never)) as typeof fs.lstatSync);
  try {
    expect(() => verifyTrackedTree(tree)).toThrow('directory changed');
    expect(fs.readFileSync(join(nested, 'ignored-local'), 'utf8')).toBe('preserve');
  } finally {
    stat.mockRestore();
    fs.unlinkSync(join(nested, 'ignored-local'));
    fs.unlinkSync(tracked);
    fs.rmdirSync(nested);
    fs.rmdirSync(directory);
  }
});
test('a closed tree proof rejects a later mount identity change', () => {
  if (process.platform === 'win32') return;
  const directory = root();
  let mounts = mockMounts(['/']);
  try {
    const tree = scanTrackedTree(directory, new Set());
    mounts.mockRestore();
    mounts = mockMounts(['/', '/late-volume']);
    expect(() => verifyTrackedTree(tree)).toThrow('mount table changed');
  } finally {
    mounts.mockRestore();
    fs.rmdirSync(directory);
  }
});
test('an unchanged closed tree proof can be rechecked without filesystem mutation', () => {
  const directory = root();
  fs.writeFileSync(join(directory, 'tracked'), 'tracked');
  try {
    const tree = scanTrackedTree(directory, new Set(['tracked']));
    expect(() => verifyTrackedTree(tree)).not.toThrow();
    expect(fs.readFileSync(join(directory, 'tracked'), 'utf8')).toBe('tracked');
  } finally {
    fs.unlinkSync(join(directory, 'tracked'));
    fs.rmdirSync(directory);
  }
});
