import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  fixtureNativeSqlite,
  fixtureTerminalSqlite,
} from '../../../../tests/fixtures/unified-agent/sqlite-engine-fixture';
import {
  type NativeBundleManifest,
  nativeBundleEntries,
  parseNativeBundleManifest,
  parseNativeRuntimeProtection,
  verifyNativeRuntimeBundle,
  verifyNativeRuntimeProtection,
} from '../../src/native-runtime-assets';
import {
  parseTerminalRuntimeProtection,
  type TerminalBundleManifest,
  terminalBundleEntries,
} from '../../src/runtime-assets';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-integrity-'))),
    root = join(parent, 'candidate');
  mkdirSync(root, { mode: 0o700 });
  const terminal = join(root, 'terminal');
  mkdirSync(terminal, { mode: 0o700 });
  const terminalEntries = terminalBundleEntries(process.platform),
    innerFiles: TerminalBundleManifest['files'][number][] = [];
  for (const path of Object.values(terminalEntries)) {
    mkdirSync(dirname(join(terminal, path)), { recursive: true });
    const bytes = Buffer.from(path);
    const mode = path === terminalEntries.runtime ? 493 : 420;
    writeFileSync(join(terminal, path), bytes, { mode });
    innerFiles.push({ path, size: bytes.length, sha256: sha(bytes), mode });
  }
  const inner: TerminalBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    bunVersion: '1.4.2',
    sqlite: fixtureTerminalSqlite(terminal, innerFiles),
    productVersion: '1.0.0',
    source: { commit: 'a'.repeat(40), dirty: true },
    entries: terminalEntries,
    files: innerFiles,
    links: [],
  };
  const innerBytes = Buffer.from(JSON.stringify(inner));
  writeFileSync(join(terminal, 'terminal-manifest.json'), innerBytes);
  const entries = nativeBundleEntries(process.platform),
    files: NativeBundleManifest['files'][number][] = [];
  for (const path of [
    ...Object.values(entries),
    'electron/version',
    '.use-terminal.lock',
    'electron/framework/actual',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    const bytes = Buffer.from(
        path === '.use-terminal.lock'
          ? ''
          : path === 'electron/version'
            ? '44.3.0'
            : path === entries.package
              ? JSON.stringify({ name: 'kite-native', version: '0.1.0', main: 'main.cjs' })
              : path,
      ),
      mode = path === '.use-terminal.lock' ? 384 : path === entries.electron ? 493 : 420;
    writeFileSync(join(root, path), bytes, { mode });
    files.push({ path, size: bytes.length, sha256: sha(bytes), mode });
  }
  symlinkSync('framework', join(root, 'electron/current'));
  const manifest: NativeBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    electronVersion: '44.3.0',
    sqlite: fixtureNativeSqlite,
    terminalRoot: 'terminal',
    terminalManifestSha256: sha(innerBytes),
    entries,
    files,
    links: [{ path: 'electron/current', target: 'framework' }],
    directories: ['electron/locale-empty'],
  };
  mkdirSync(join(root, 'electron/locale-empty'), { mode: 0o700 });
  writeFileSync(join(root, 'native-manifest.json'), JSON.stringify(manifest), { mode: 0o644 });
  return {
    root,
    parent,
    manifest,
    dispose: () => rmSync(parent, { recursive: true, force: true }),
  };
}
test('Node-safe full Native closure relocates with exact inner proof, fixed coordination file and confined Electron framework links', async () => {
  const f = fixture();
  try {
    const selected = verifyNativeRuntimeBundle(f.root),
      moved = join(f.parent, 'relocated');
    renameSync(f.root, moved);
    const actual = verifyNativeRuntimeBundle(moved);
    expect(actual.digest).toBe(selected.digest);
    expect(actual.terminal.digest).toBe(f.manifest.terminalManifestSha256);
    const proof = { kind: 'native.candidate' as const, root: moved, manifestSha256: actual.digest };
    expect(
      verifyNativeRuntimeProtection(proof, {
        entrypoint: join(actual.terminal.root, actual.terminal.manifest.entries.service),
        executable: join(actual.terminal.root, actual.terminal.manifest.entries.runtime),
        buildId: `native-${actual.digest}`,
      }).root,
    ).toBe(moved);
    expect(() =>
      verifyNativeRuntimeProtection(proof, {
        entrypoint: join(moved, 'app/main.cjs'),
        executable: process.execPath,
        buildId: `native-${actual.digest}`,
      }),
    ).toThrow('native_protection_identity_mismatch');
    const out = join(f.parent, 'node-reader.mjs'),
      built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../src/native-runtime-assets.ts')],
        target: 'node',
        format: 'esm',
        packages: 'bundle',
        outdir: f.parent,
        naming: 'node-reader.mjs',
      });
    expect(built.success).toBe(true);
    const before = readdirSync(moved),
      child = Bun.spawn(
        [
          'node',
          '--input-type=module',
          '-e',
          `import {verifyNativeRuntimeBundle} from ${JSON.stringify(out)};const value=verifyNativeRuntimeBundle(${JSON.stringify(moved)});console.log(value.digest);`,
        ],
        { env: { PATH: process.env.PATH!, NODE_PATH: '' }, stdout: 'pipe', stderr: 'pipe' },
      );
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(actual.digest);
    expect(readdirSync(moved)).toEqual(before);
    expect(readFileSync(join(moved, '.use-terminal.lock')).length).toBe(0);
  } finally {
    f.dispose();
  }
});
test('Native exact inventory refuses extra/missing/empty directories, same-size bytes, modes, hardlinks, escaped links and inner drift', () => {
  const mutations = [
    (root: string) => writeFileSync(join(root, 'app/extra'), 'x'),
    (root: string) => rmSync(join(root, 'app/preload.cjs')),
    (root: string) => mkdirSync(join(root, 'app/empty')),
    (root: string) => {
      const path = join(root, 'app/main.cjs'),
        bytes = readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(path, bytes);
    },
    (root: string) => chmodSync(join(root, 'app/main.cjs'), 0o755),
    (root: string) => {
      rmSync(join(root, 'app/main.cjs'));
      linkSync(join(root, 'app/preload.cjs'), join(root, 'app/main.cjs'));
    },
    (root: string) => {
      rmSync(join(root, 'electron/current'));
      symlinkSync('/tmp', join(root, 'electron/current'));
    },
    (root: string) => writeFileSync(join(root, 'terminal/entrypoints/cli.js'), 'changed'),
    (root: string) => writeFileSync(join(root, '.use-terminal.lock'), 'x'),
    (root: string) => chmodSync(join(root, '.use-terminal.lock'), 0o644),
    (root: string) => rmSync(join(root, 'electron/locale-empty'), { recursive: true }),
    (root: string) => writeFileSync(join(root, 'electron/locale-empty/new'), 'x'),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      mutate(f.root);
      expect(() => verifyNativeRuntimeBundle(f.root)).toThrow();
    } finally {
      f.dispose();
    }
  }
});
test('Native and existing terminal protection remain separately closed; manifests reject path/role/version/lock aliases', () => {
  const f = fixture();
  try {
    for (const value of [
      { ...f.manifest, version: 2 },
      { ...f.manifest, terminalRoot: '../terminal' },
      { ...f.manifest, extra: true },
      { ...f.manifest, entries: { ...f.manifest.entries, main: 'app/other.cjs' } },
      { ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] },
      { ...f.manifest, links: [{ path: 'app/link', target: 'main.cjs' }] },
      { ...f.manifest, links: [{ path: 'electron/link', target: '../../escape' }] },
    ])
      expect(() => parseNativeBundleManifest(value)).toThrow();
    expect(() =>
      parseNativeRuntimeProtection({
        kind: 'native.candidate',
        root: f.root,
        manifestSha256: 'a'.repeat(64),
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseTerminalRuntimeProtection({
        kind: 'native.candidate',
        root: f.root,
        manifestSha256: 'a'.repeat(64),
      }),
    ).toThrow();
  } finally {
    f.dispose();
  }
});
