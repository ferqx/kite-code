import { expect, test } from 'bun:test';
import {
  linkSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseScratch } from '../../../../../tests/fixtures/unified-agent/release-filesystem';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../src/platform/windows-path-security';

const windows = process.platform === 'win32';
test.skipIf(!windows)(
  'private artifact batch preserves complete bytes, CREATE_NEW, strict directories and confirmed closure',
  () => {
    const root = releaseScratch(join(tmpdir(), 'kite-private-tree-'));
    const security = defaultWindowsPathSecurity()!;
    try {
      const source = join(root, 'source'),
        target = join(root, 'target');
      privateDirectory(source);
      privateDirectory(target);
      const entries = new Map([
        ['nested/完整.dat', Buffer.from('完整 UTF-8\n'.repeat(100_000))],
        ['nested/empty', Buffer.alloc(0)],
        ['another.txt', Buffer.from('original')],
      ]);
      security.writePrivateArtifactFiles(source, entries);
      security.copyPrivateArtifactFiles(source, target, [...entries.keys()]);
      for (const [path, expected] of entries) {
        expect(readFileSync(join(target, path))).toEqual(expected);
        security.verifyFile(join(target, path));
      }
      security.verifyDirectory(join(target, 'nested'));
      expect(() =>
        security.writePrivateArtifactFiles(
          target,
          new Map([['another.txt', Buffer.from('overwrite')]]),
        ),
      ).toThrow();
      expect(readFileSync(join(target, 'another.txt'), 'utf8')).toBe('original');
      writeFileSync(join(target, 'another.txt'), 'all original native handles closed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!windows)(
  'private artifact batch rejects ambiguous names, source aliases and destination junctions without outside writes',
  () => {
    const root = releaseScratch(join(tmpdir(), 'kite-private-tree-negative-'));
    const security = defaultWindowsPathSecurity()!;
    try {
      const source = join(root, 'source'),
        target = join(root, 'target'),
        outside = join(root, 'outside');
      for (const path of [source, target, outside]) privateDirectory(path);
      const bytes = Buffer.from('original');
      for (const paths of [
        ['../outside/escape'],
        ['a:b'],
        ['a\\b'],
        ['CON.txt'],
        ['a', 'A'],
        ['x./file'],
      ]) {
        expect(() =>
          security.writePrivateArtifactFiles(target, new Map(paths.map((path) => [path, bytes]))),
        ).toThrow();
        expect(readdirSync(target)).toEqual([]);
      }
      security.writePrivateArtifactFiles(source, new Map([['asset', bytes]]));
      linkSync(join(source, 'asset'), join(outside, 'hardlink'));
      expect(() => security.copyPrivateArtifactFiles(source, target, ['asset'])).toThrow();
      expect(readdirSync(target)).toEqual([]);
      unlinkSync(join(outside, 'hardlink'));
      symlinkSync(outside, join(target, 'alias'), 'junction');
      expect(() =>
        security.writePrivateArtifactFiles(target, new Map([['alias/escape', bytes]])),
      ).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      unlinkSync(join(target, 'alias'));
      symlinkSync(outside, join(source, 'alias'), 'junction');
      security.writePrivateArtifactFile(join(outside, 'original'), bytes);
      expect(() => security.copyPrivateArtifactFiles(source, target, ['alias/original'])).toThrow();
      expect(readdirSync(target)).toEqual([]);
      expect(readFileSync(join(outside, 'original'))).toEqual(bytes);
      unlinkSync(join(source, 'alias'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
