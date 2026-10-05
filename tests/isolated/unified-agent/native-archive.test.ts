import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { packNativeBundle, unpackNativeBundle } from '../../../scripts/release/native-archive';
import { readCandidateArchiveFiles } from '../../../scripts/release/terminal-archive';
import { finiteNativeFixture, hash } from '../../fixtures/unified-agent/native-artifact-fixture';

test('finite Native archive preserves full two manifest bytes, relative link and emptydir; explicit bounds and exclusive outputs', async () => {
  const parent = realpathSync(mkdtempSync('/private/tmp/kite-native-archive-'));
  try {
    const root = finiteNativeFixture(parent),
      original = verifyNativeRuntimeBundle(root),
      archivePath = join(parent, 'native.tar.gz'),
      packed = await packNativeBundle({ bundleRoot: root, archivePath });
    expect(packed.candidateId).toBe(original.digest);
    expect(readFileSync(`${archivePath}.sha256`, 'utf8')).toBe(`${packed.sha256}  native.tar.gz\n`);
    const moved = unpackNativeBundle({ ...packed, destination: join(parent, 'moved') });
    expect(moved.digest).toBe(original.digest);
    expect(moved.terminal.digest).toBe(original.terminal.digest);
    expect(readFileSync(join(moved.root, '.use-terminal.lock'))).toHaveLength(0);
    expect(verifyNativeRuntimeBundle(moved.root).manifest.directories).toEqual([
      'electron/empty-locale',
    ]);
    await expect(packNativeBundle({ bundleRoot: root, archivePath })).rejects.toThrow(
      'native_destination_exists',
    );
    expect(() => unpackNativeBundle({ ...packed, destination: moved.root })).toThrow(
      'native_destination_exists',
    );
    for (const maxUnpackedBytes of [0, 1, NaN])
      expect(() =>
        unpackNativeBundle({ ...packed, destination: join(parent, 'bounded'), maxUnpackedBytes }),
      ).toThrow();
    expect(existsSync(join(parent, 'bounded'))).toBe(false);
    await expect(
      packNativeBundle({ bundleRoot: root, archivePath: join(root, 'inside.tar.gz') }),
    ).rejects.toThrow('terminal_destination_overlaps_bundle');
    expect(existsSync(join(root, 'inside.tar.gz'))).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test('finite Native archive closed regular inventory refuses bad SHA, extra/missing, ancestor, invalidempty and rehashed corrupt closure', async () => {
  const parent = realpathSync(mkdtempSync('/private/tmp/kite-native-archive-bad-'));
  try {
    const root = finiteNativeFixture(parent),
      packed = await packNativeBundle({
        bundleRoot: root,
        archivePath: join(parent, 'original.tgz'),
      }),
      files = readCandidateArchiveFiles(packed);
    const mutations = [
      (m: Map<string, Uint8Array>) => m.set('extra', Buffer.from('x')),
      (m: Map<string, Uint8Array>) => m.delete('app/preload.cjs'),
      (m: Map<string, Uint8Array>) => m.set('app', Buffer.from('ancestor')),
      (m: Map<string, Uint8Array>) => m.set('app/main.cjs', Buffer.from('bitflip')),
      (m: Map<string, Uint8Array>) => {
        const raw = JSON.parse(Buffer.from(m.get('native-manifest.json')!).toString());
        raw.directories = ['app/empty'];
        m.set('native-manifest.json', Buffer.from(JSON.stringify(raw)));
      },
      (m: Map<string, Uint8Array>) => m.set('terminal/terminal-manifest.json', Buffer.from('{}')),
    ];
    for (const [i, mutate] of mutations.entries()) {
      const altered = new Map(files);
      mutate(altered);
      const archivePath = join(parent, `bad-${i}.tgz`),
        bytes = await new Bun.Archive(Object.fromEntries(altered), { compress: 'gzip' }).bytes();
      writeFileSync(archivePath, bytes);
      const destination = join(parent, `bad-${i}`);
      expect(() => unpackNativeBundle({ archivePath, sha256: hash(bytes), destination })).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    expect(() =>
      unpackNativeBundle({
        ...packed,
        sha256: '0'.repeat(64),
        destination: join(parent, 'wrongsha'),
      }),
    ).toThrow();
    for (const mutate of [
      (p: string) => chmodSync(join(p, '.use-terminal.lock'), 0o644),
      (p: string) => {
        rmSync(join(p, 'app/main.cjs'));
        linkSync(join(p, 'app/preload.cjs'), join(p, 'app/main.cjs'));
      },
      (p: string) => mkdirSync(join(p, 'electron/undeclared'), { mode: 0o700 }),
    ]) {
      const p = finiteNativeFixture(parent, `source-${Math.random().toString(16).slice(2)}`);
      mutate(p);
      await expect(
        packNativeBundle({
          bundleRoot: p,
          archivePath: join(parent, `${p.split('/').at(-1)}.tgz`),
        }),
      ).rejects.toThrow();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** Raw tar records cover hostile forms that an object file map cannot represent. */
function header(path: string, body = Buffer.alloc(0), type = '0', link = '') {
  const bytes = Buffer.alloc(512);
  bytes.write(path, 0, 100);
  bytes.write('0000644\0', 100, 8);
  bytes.write('0000000\0', 108, 8);
  bytes.write('0000000\0', 116, 8);
  bytes.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  bytes.write('00000000000\0', 136, 12);
  bytes.fill(32, 148, 156);
  bytes[156] = type.charCodeAt(0);
  bytes.write(link, 157, 100);
  bytes.write('ustar\0', 257, 6);
  bytes.write('00', 263, 2);
  bytes.write(
    `${bytes
      .reduce((sum, b) => sum + b, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  );
  return Buffer.concat([
    bytes,
    body,
    Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length),
  ]);
}
test('Native unpack directly rejects duplicate, traversal, real links, bad PAX and rehashed checksum-invalid tar; sidecar aliases untouched', async () => {
  const { gzipSync } = await import('node:zlib'),
    { symlinkSync } = await import('node:fs');
  const parent = realpathSync(mkdtempSync('/private/tmp/kite-native-archive-tar-'));
  try {
    const root = finiteNativeFixture(parent),
      archivePath = join(parent, 'good.tgz'),
      packed = await packNativeBundle({ bundleRoot: root, archivePath }),
      files = readCandidateArchiveFiles(packed),
      normal = [...files].map(([path, bytes]) => header(path, Buffer.from(bytes)));
    const badChecksum = Buffer.from(normal[0]!);
    badChecksum[0] = badChecksum[0]! ^ 1;
    const cases = [
      ...['../escape', '/absolute', 'C:/drive'].map((path) => [...normal, header(path)]),
      [...normal, header('link', Buffer.alloc(0), '2', '/tmp')],
      [...normal, header('hard', Buffer.alloc(0), '1', 'app/main.cjs')],
      [...normal, normal[0]!],
      [badChecksum, ...normal.slice(1)],
      [header('PaxHeader', Buffer.from('9 path=../escape\n'), 'x'), ...normal],
    ];
    for (const [index, entries] of cases.entries()) {
      const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
        path = join(parent, `bad-${index}.tgz`),
        destination = join(parent, `dest-${index}`);
      writeFileSync(path, bytes);
      expect(() =>
        unpackNativeBundle({ archivePath: path, sha256: hash(bytes), destination }),
      ).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    const outside = join(parent, 'keep'),
      newArchive = join(parent, 'alias.tgz');
    writeFileSync(outside, 'keep exact');
    symlinkSync(outside, `${newArchive}.sha256`);
    await expect(packNativeBundle({ bundleRoot: root, archivePath: newArchive })).rejects.toThrow(
      'native_destination_exists',
    );
    expect(readFileSync(outside, 'utf8')).toBe('keep exact');
    expect(existsSync(newArchive)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('exact verified Native file modes and installed launcher survive a private umask without weakening lock0600', async () => {
  const { lstatSync } = await import('node:fs'),
    { installNativeBundle, uninstallNativeBundle } = await import(
      '../../../scripts/release/native-install'
    );
  const parent = realpathSync(mkdtempSync('/private/tmp/kite-native-umask-'));
  try {
    const source = finiteNativeFixture(parent),
      packed = await packNativeBundle({
        bundleRoot: source,
        archivePath: join(parent, 'bundle.tgz'),
      });
    const previous = process.umask(0o077);
    try {
      const moved = unpackNativeBundle({ ...packed, destination: join(parent, 'unpacked') }),
        installed = installNativeBundle({
          bundleRoot: moved.root,
          prefix: join(parent, 'installed'),
        });
      expect(lstatSync(join(moved.root, 'native-manifest.json')).mode & 0o777).toBe(0o644);
      expect(lstatSync(join(installed.root, 'bin/kite-desktop')).mode & 0o777).toBe(0o755);
      expect(lstatSync(join(installed.releaseRoot, '.use-terminal.lock')).mode & 0o777).toBe(0o600);
      expect(verifyNativeRuntimeBundle(installed.releaseRoot).digest).toBe(moved.digest);
      uninstallNativeBundle(installed.root);
    } finally {
      process.umask(previous);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
