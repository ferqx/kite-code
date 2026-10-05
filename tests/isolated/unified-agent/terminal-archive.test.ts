import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
  verifyTerminalBundle,
} from '../../../apps/cli/host/terminal-artifact';
import {
  packTerminalBundle,
  unpackTerminalBundle,
} from '../../../scripts/release/terminal-archive';
import { fixtureTerminalSqlite } from '../../fixtures/unified-agent/sqlite-engine-fixture';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Small inert closure, independent of installed profiles and test-file module side effects. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-archive-'))),
    bundleRoot = join(root, 'candidate');
  mkdirSync(bundleRoot, { mode: 0o700 });
  const entries = terminalBundleEntries(process.platform),
    content: Record<string, Uint8Array> = Object.create(null),
    files: TerminalBundleManifest['files'][number][] = [];
  for (const path of [...Object.values(entries), 'node_modules/example/index.js']) {
    const bytes = Buffer.from(`INERT ${path}`),
      mode = path === entries.runtime ? 493 : 420;
    content[path] = bytes;
    mkdirSync(dirname(join(bundleRoot, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(bundleRoot, path), bytes, { mode });
    chmodSync(join(bundleRoot, path), mode);
    files.push({ path, size: bytes.length, sha256: hash(bytes), mode });
  }
  const manifest: TerminalBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    bunVersion: Bun.version,
    sqlite: fixtureTerminalSqlite(bundleRoot, files),
    productVersion: '0.1.0',
    source: { commit: 'a'.repeat(40), dirty: true },
    entries,
    files,
    links: [{ path: 'node_modules/alias', target: 'example' }],
  };
  for (const file of files) content[file.path] ??= readFileSync(join(bundleRoot, file.path));
  content['terminal-manifest.json'] = Buffer.from(JSON.stringify(manifest) + '\n');
  writeFileSync(join(bundleRoot, 'terminal-manifest.json'), content['terminal-manifest.json']!);
  symlinkSync('example', join(bundleRoot, 'node_modules/alias'));
  const archivePath = join(root, 'bundle.tar.gz'),
    destination = join(root, 'unpacked');
  const unpack = (bytes: Uint8Array, maxUnpackedBytes?: number) => {
    writeFileSync(archivePath, bytes);
    return unpackTerminalBundle({
      archivePath,
      destination,
      sha256: hash(bytes),
      ...(maxUnpackedBytes === undefined ? {} : { maxUnpackedBytes }),
    });
  };
  return {
    root,
    bundleRoot,
    manifest,
    content,
    archivePath,
    destination,
    unpack,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
/** Raw attacker headers are needed to represent duplicate/link records that an object map cannot emit. */
function tarEntry(path: string, body: Uint8Array = Buffer.alloc(0), type = '0', target = '') {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(target, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([
    header,
    Buffer.from(body),
    Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length),
  ]);
}
function paxRecord(key: string, value: string) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (String(length).length + Buffer.byteLength(tail) !== length)
    length = String(length).length + Buffer.byteLength(tail);
  return Buffer.from(`${length}${tail}`);
}
const tar = (entries: Uint8Array[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const normalEntries = (content: Record<string, Uint8Array>) =>
  Object.entries(content).map(([path, bytes]) => tarEntry(path, bytes));
test('authenticated Terminal modes survive private umask077 without changing the process mask beyond synchronous unpack', async () => {
  const f = fixture();
  try {
    const original = verifyTerminalBundle(f.bundleRoot);
    const packed = await packTerminalBundle({
      bundleRoot: f.bundleRoot,
      archivePath: f.archivePath,
    });
    const previous = process.umask(0o077);
    try {
      const result = unpackTerminalBundle({
        archivePath: f.archivePath,
        destination: f.destination,
        sha256: packed.sha256,
      });
      expect(result.digest).toBe(original.digest);
      for (const file of original.manifest.files)
        expect(lstatSync(join(result.root, file.path)).mode & 0o777).toBe(file.mode);
      expect(lstatSync(join(result.root, 'terminal-manifest.json')).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previous);
    }
  } finally {
    f.close();
  }
});
test('actual Bun archive roundtrip stores no symlink entries and reconstructs only authenticated internal links', async () => {
  const f = fixture();
  try {
    const original = verifyTerminalBundle(f.bundleRoot),
      packed = await packTerminalBundle({ bundleRoot: f.bundleRoot, archivePath: f.archivePath });
    expect(packed.candidateId).toBe(original.candidateId);
    expect(readFileSync(`${f.archivePath}.sha256`, 'utf8')).toBe(
      `${packed.sha256}  bundle.tar.gz\n`,
    );
    const bytes = readFileSync(f.archivePath),
      archiveFiles = await new Bun.Archive(bytes).files();
    expect(archiveFiles.has('node_modules/alias')).toBe(false);
    expect(archiveFiles.has('terminal-manifest.json')).toBe(true);
    const result = unpackTerminalBundle({
      archivePath: f.archivePath,
      destination: f.destination,
      sha256: packed.sha256,
    });
    expect(result.candidateId).toBe(original.candidateId);
    expect(result.artifact.executable.startsWith(f.destination + '/')).toBe(true);
    expect(lstatSync(join(f.destination, 'node_modules/alias')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(f.destination, 'node_modules/alias'))).toBe('example');
    expect(readFileSync(join(f.destination, 'node_modules/alias/index.js'))).toEqual(
      Buffer.from(f.content['node_modules/example/index.js']!),
    );
    expect(lstatSync(result.artifact.executable).mode & 0o777).toBe(0o755);
  } finally {
    f.close();
  }
});
test('checksum and authenticated content tampering reject before destination exists', async () => {
  const f = fixture();
  try {
    const packed = await packTerminalBundle({
      bundleRoot: f.bundleRoot,
      archivePath: f.archivePath,
    });
    expect(() =>
      unpackTerminalBundle({
        archivePath: f.archivePath,
        destination: f.destination,
        sha256: '0'.repeat(64),
      }),
    ).toThrow('terminal_archive_invalid');
    expect(existsSync(f.destination)).toBe(false);
    const tampered = {
      ...f.content,
      'node_modules/example/index.js': Buffer.from('INERT tampered module'),
    };
    const bytes = await new Bun.Archive(tampered, { compress: 'gzip' }).bytes();
    expect(() => f.unpack(bytes)).toThrow('terminal_archive_invalid');
    expect(existsSync(f.destination)).toBe(false);
    expect(hash(readFileSync(f.archivePath))).not.toBe(packed.sha256);
  } finally {
    f.close();
  }
});
test('traversal, absolute and archive-controlled symlink/hardlink records never extract', () => {
  for (const [path, type, target] of [
    ['../escaped', '0', ''],
    ['/absolute', '0', ''],
    ['C:/outside', '0', ''],
    ['node_modules/alias', '2', '../../outside'],
    ['node_modules/alias', '1', 'terminal-manifest.json'],
  ] as const) {
    const f = fixture();
    try {
      const bytes = tar([
        ...normalEntries(f.content),
        tarEntry(path, Buffer.alloc(0), type, target),
      ]);
      expect(() => f.unpack(bytes)).toThrow('terminal_archive_invalid');
      expect(existsSync(f.destination)).toBe(false);
      expect(existsSync(join(f.root, 'escaped'))).toBe(false);
    } finally {
      f.close();
    }
  }
});
test('duplicate tar files, malformed checksums/PAX/end blocks and missing manifest fail closed', () => {
  const f = fixture();
  try {
    const regular = normalEntries(f.content);
    const badChecksum = Buffer.from(regular[0]!);
    badChecksum[0] = badChecksum[0]! ^ 1;
    const cases = [
      tar([...regular, tarEntry('terminal-manifest.json', f.content['terminal-manifest.json']!)]),
      tar([badChecksum, ...regular.slice(1)]),
      tar([tarEntry('PaxHeader', Buffer.from('9 path=../escape\n'), 'x'), ...regular]),
      tar([
        tarEntry('PaxHeader', paxRecord('path', '../escaped'), 'x'),
        tarEntry('safe-name', Buffer.alloc(0)),
        ...regular,
      ]),
      tar([
        tarEntry(
          'PaxHeader',
          Buffer.concat([paxRecord('path', 'safe'), paxRecord('path', 'again')]),
          'x',
        ),
        ...regular,
      ]),
      gzipSync(Buffer.concat([...regular, Buffer.alloc(512), Buffer.from('trailing-nonzero')])),
      tar(regular.filter((_, index) => index !== regular.length - 1)),
    ];
    for (const bytes of cases) {
      expect(() => f.unpack(bytes)).toThrow();
      expect(existsSync(f.destination)).toBe(false);
    }
  } finally {
    f.close();
  }
});
test('decompression budget stops a small compressed bomb before creating output; invalid budgets reject', async () => {
  const f = fixture();
  try {
    const contents = { ...f.content, 'unlisted-large': Buffer.alloc(1024 * 1024) },
      bytes = await new Bun.Archive(contents, { compress: 'gzip' }).bytes();
    expect(bytes.length).toBeLessThan(20_000);
    expect(() => f.unpack(bytes, 4096)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
    for (const budget of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => f.unpack(bytes, budget)).toThrow('terminal_archive_invalid');
      expect(existsSync(f.destination)).toBe(false);
    }
  } finally {
    f.close();
  }
});
test('authenticated regular-file/link ancestor collisions and external manifest links cannot create paths', () => {
  const f = fixture();
  try {
    for (const kind of ['file-ancestor', 'link-ancestor', 'external-link'] as const) {
      let manifest: TerminalBundleManifest,
        content = { ...f.content };
      if (kind === 'file-ancestor') {
        const body = Buffer.from('COLLIDING FILE');
        content.node_modules = body;
        manifest = {
          ...f.manifest,
          files: [
            ...f.manifest.files,
            { path: 'node_modules', size: body.length, sha256: hash(body), mode: 420 },
          ],
        };
      } else if (kind === 'link-ancestor')
        manifest = {
          ...f.manifest,
          links: [{ path: 'node_modules/example', target: '@kite-ai/service' }],
        };
      else
        manifest = {
          ...f.manifest,
          links: [{ path: 'node_modules/alias', target: '../../external' }],
        };
      content['terminal-manifest.json'] = Buffer.from(JSON.stringify(manifest) + '\n');
      expect(() => f.unpack(tar(normalEntries(content)))).toThrow();
      expect(existsSync(f.destination)).toBe(false);
    }
  } finally {
    f.close();
  }
});
test('pre-existing checksum sidecar symlink is refused without overwriting its external target', async () => {
  const f = fixture();
  try {
    const outside = join(f.root, 'outside-user-notes');
    writeFileSync(outside, 'DO_NOT_OVERWRITE');
    symlinkSync(outside, `${f.archivePath}.sha256`);
    let failure: unknown;
    try {
      await packTerminalBundle({ bundleRoot: f.bundleRoot, archivePath: f.archivePath });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(readFileSync(outside, 'utf8')).toBe('DO_NOT_OVERWRITE');
    expect(existsSync(f.archivePath)).toBe(false);
  } finally {
    f.close();
  }
});
test('packer refuses archive and sidecar publication inside the source, including a symlink ancestor, with source unchanged', async () => {
  for (const alias of [false, true]) {
    const f = fixture();
    try {
      const before = verifyTerminalBundle(f.bundleRoot),
        manifestBytes = readFileSync(join(f.bundleRoot, 'terminal-manifest.json'));
      let parent = f.bundleRoot;
      if (alias) {
        parent = join(f.root, 'source-alias');
        symlinkSync(f.bundleRoot, parent);
      }
      const archivePath = join(parent, 'nested-output', 'bundle.tar.gz');
      let failure: unknown;
      try {
        await packTerminalBundle({ bundleRoot: f.bundleRoot, archivePath });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('terminal_destination_overlaps_bundle');
      expect(existsSync(join(f.bundleRoot, 'nested-output'))).toBe(false);
      expect(existsSync(archivePath)).toBe(false);
      expect(existsSync(`${archivePath}.sha256`)).toBe(false);
      expect(readFileSync(join(f.bundleRoot, 'terminal-manifest.json'))).toEqual(manifestBytes);
      expect(verifyTerminalBundle(f.bundleRoot).digest).toBe(before.digest);
    } finally {
      f.close();
    }
  }
});
