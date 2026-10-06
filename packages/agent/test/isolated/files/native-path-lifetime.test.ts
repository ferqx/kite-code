import * as ffi from 'bun:ffi';
import { expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceFiles } from '../../../src/files';

const originalFFI = { ...ffi };
const collectedCalls = new Set<string>();
mock.module('bun:ffi', () => ({
  ...originalFFI,
  dlopen(
    filename: Parameters<typeof ffi.dlopen>[0],
    definitions: Parameters<typeof ffi.dlopen>[1],
  ) {
    const library = originalFFI.dlopen(filename, definitions);
    if (!('__openat' in definitions || 'openat' in definitions)) return library;
    return {
      ...library,
      symbols: Object.fromEntries(
        Object.entries(library.symbols).map(([name, call]) => [
          name,
          (...args: unknown[]) => {
            if (name.includes('openat') || ['renameat', 'linkat', 'unlinkat'].includes(name)) {
              collectedCalls.add(name);
              Bun.gc(true);
              const churn = Array.from({ length: 256 }, () => Buffer.alloc(256, 120));
              const result = Reflect.apply(call, undefined, args);
              if (churn[0]![0] !== 120) throw new Error('allocation changed');
              return result;
            }
            return Reflect.apply(call, undefined, args);
          },
        ]),
      ),
    };
  },
}));

test('anchored Files path bytes survive collection through actual read, rename, link and unlink calls', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-native-path-')));
  const directory = '目录';
  mkdirSync(join(root, directory));
  const path = `${directory}/原像-${'a'.repeat(160)}`;
  const original = Buffer.from('\uFEFF完整原字节\r\n');
  writeFileSync(join(root, path), original);
  const files = createWorkspaceFiles({ root });
  const maxBytes = 1024 * 1024;
  try {
    const before = await files.readBytes(path, { maxBytes });
    expect(Buffer.from(before.bytes)).toEqual(original);
    const updated = Buffer.from('实际替换\r\n');
    const after = await files.restore({ path, bytes: updated, base: before.baseline, maxBytes });
    expect(readFileSync(join(root, path))).toEqual(updated);
    expect(after.baseline.inode).not.toBe(before.baseline.inode);
    const restored = await files.restore({
      path,
      bytes: before.bytes,
      base: after.baseline,
      maxBytes,
    });
    expect((await files.readBytes(path, { maxBytes })).baseline).toEqual(restored.baseline);
    expect(readFileSync(join(root, path))).toEqual(original);
    const createdPath = `${directory}/新建-${'b'.repeat(160)}`;
    const created = await files.restore({
      path: createdPath,
      bytes: updated,
      base: null,
      maxBytes,
    });
    expect(readFileSync(join(root, createdPath))).toEqual(updated);
    await files.remove({ path: createdPath, base: created.baseline, maxBytes });
    expect(existsSync(join(root, createdPath))).toBe(false);
    expect([...collectedCalls].sort()).toEqual(
      [
        process.platform === 'darwin' ? '__openat' : 'openat',
        'linkat',
        'renameat',
        'unlinkat',
      ].sort(),
    );
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
    mock.restore();
  }
});
