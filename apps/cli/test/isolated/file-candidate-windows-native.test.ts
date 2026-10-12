import { expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CandidateDirectory, CandidateIgnoreFile } from '../../host/file-candidate-filesystem';
import { openWindowsCandidateDirectory } from '../../host/file-candidate-windows';

test.skipIf(process.platform !== 'win32')(
  'actual Windows HANDLE candidates preserve Unicode and full ignore EOF, pin ancestry, and reject junctions and hardlinks',
  () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'kite-candidate-win-'))),
      root = join(base, 'workspace'),
      outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(join(root, '目录🙂'));
    writeFileSync(join(root, '雪e\u0301.txt'), 'ordinary workspace file');
    const ignoreBytes = Buffer.from(`# 完整🙂\r\n${'ignored-雪\r\n'.repeat(16000)}`);
    writeFileSync(join(root, '.gitignore'), ignoreBytes);
    symlinkSync(outside, join(root, 'junction'), 'junction');
    let directory: CandidateDirectory | undefined,
      child: CandidateDirectory | undefined,
      ignore: CandidateIgnoreFile | undefined,
      failure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      directory = openWindowsCandidateDirectory(root);
      directory.verifyCanonicalPath(root);
      const entries = directory.entries();
      expect(entries).toContainEqual({ name: '目录🙂', type: 4 });
      expect(entries).toContainEqual({ name: '雪e\u0301.txt', type: 8 });
      expect(entries).toContainEqual({ name: 'junction', type: 10 });
      expect(() => directory!.openDirectory('junction')).toThrow();
      expect(() => renameSync(root, `${root}-moved`)).toThrow();
      child = directory.openDirectory('目录🙂');
      child.verifyCanonicalPath(join(root, '目录🙂'));
      child.verifyCanonicalPath(`${root}/目录🙂`);
      ignore = directory.openIgnoreFile();
      const before = ignore.facts();
      expect(before.regular).toBe(true);
      expect(before.links).toBe(1);
      expect(() => writeFileSync(join(root, '.gitignore'), 'replacement')).toThrow();
      expect(() => renameSync(join(root, '.gitignore'), join(root, 'changed-ignore'))).toThrow();
      const parts: Uint8Array[] = [],
        buffer = new Uint8Array(4096);
      for (;;) {
        const count = ignore.read(buffer);
        if (!count) break;
        parts.push(buffer.slice(0, count));
      }
      expect(Buffer.concat(parts)).toEqual(ignoreBytes);
      expect(ignore.facts()).toEqual(before);
      ignore.close();
      ignore = undefined;
      child.close();
      child = undefined;
      directory.close();
      directory = undefined;
      linkSync(join(root, '.gitignore'), join(root, 'ignore-alias'));
      directory = openWindowsCandidateDirectory(root);
      directory.entries();
      expect(() => directory!.openIgnoreFile()).toThrow();
      expect(readFileSync(join(root, '.gitignore'))).toEqual(ignoreBytes);
    } catch (error) {
      failure = error;
    } finally {
      for (const owned of [ignore, child, directory])
        try {
          owned?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (!cleanupErrors.length) rmSync(base, { recursive: true, force: true });
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        `candidate_native_cleanup_unconfirmed:${base}`,
      );
    if (failure) throw failure;
  },
);
