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
import { createNativeWorkspaceFileIo } from '../../../src/files-native-binding';

const collectedCalls = new Set<string>();
const actualNative = createNativeWorkspaceFileIo;
mock.module('../../../src/files-native-binding', () => ({
  createNativeWorkspaceFileIo(...args: Parameters<typeof createNativeWorkspaceFileIo>) {
    const io = actualNative(...args);
    return new Proxy(
      { ...io },
      {
        get(source, key) {
          const value = Reflect.get(source, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (['openAt', 'read', 'write', 'publishAt', 'unlinkAt'].includes(String(key))) {
              collectedCalls.add(String(key));
              Bun.gc(true);
              const churn = Array.from({ length: 256 }, () => Buffer.alloc(256, 120));
              const result = Reflect.apply(value, source, args);
              Bun.gc(true);
              if (churn[0]![0] !== 120) throw new Error('allocation changed');
              return result;
            }
            return Reflect.apply(value, source, args);
          };
        },
      },
    );
  },
}));
const { createWorkspaceFiles } = await import('../../../src/files');

test('Node-API Files paths and owned buffers survive collection across actual read, publication and deletion', async () => {
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
    expect([...collectedCalls].sort()).toEqual([
      'openAt',
      'publishAt',
      'read',
      'unlinkAt',
      'write',
    ]);
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
    mock.restore();
  }
});
