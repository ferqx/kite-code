import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { fixtureTerminalSqlite } from '../../../../tests/fixtures/unified-agent/sqlite-engine-fixture';
import {
  type DesktopRuntimeManifest,
  macosDesktopRuntimeEntries,
  parseTerminalBundleManifest,
  parseTerminalRuntimeProtection,
  type TerminalBundleManifest,
  terminalBundleEntries,
  terminalEmptyAssetDirectories,
  verifyTerminalRuntimeBundle,
  verifyTerminalRuntimeProtection,
  windowsDesktopRuntimeEntries,
  windowsTerminalRuntimeConfigFiles,
} from '../../src/runtime-assets';
import { desktopSqliteEngineRoot, reviewedSqliteSources } from '../../src/sqlite-release-assets';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function desktopManifest(
  target: DesktopRuntimeManifest['target'],
  entries: DesktopRuntimeManifest['entries'],
) {
  const sha256 = 'b'.repeat(64);
  return {
    version: 1,
    apiMajor: 1,
    target,
    bunVersion: '1.4.4',
    sqlite: {
      driver: 'bun:sqlite',
      linkage: target.platform === 'win32' ? 'builtin' : 'dynamic',
      version: '3.53.2',
      sourceId: reviewedSqliteSources['3.53.2'],
      manifestSha256: sha256,
    },
    productVersion: '0.1.0',
    source: { commit: 'a'.repeat(40), dirty: true },
    entries,
    files: [
      ...Object.values(entries),
      ...(target.platform === 'win32' ? windowsTerminalRuntimeConfigFiles : []),
      `${desktopSqliteEngineRoot}/engine-selection.json`,
      `${desktopSqliteEngineRoot}/engine-manifest.json`,
    ].map((path) => ({ path, size: 1, sha256, mode: path === entries.runtime ? 493 : 420 })),
    links: [],
  };
}

test('Windows embedded runtime retains verification of the previous desktop layout', () => {
  const manifest = desktopManifest(
    { platform: 'win32', arch: 'x64' },
    windowsDesktopRuntimeEntries,
  );
  const previousService = 'node_modules/@kite-ai/service/main.js';
  expect(
    parseTerminalBundleManifest(
      {
        ...manifest,
        entries: { ...manifest.entries, service: previousService },
        files: manifest.files.map((file) => ({
          ...file,
          path: file.path.replace(/^code\//u, 'node_modules/'),
        })),
      },
      true,
    ).entries.service,
  ).toBe(previousService);
});

test.each([
  ['Windows', desktopManifest({ platform: 'win32', arch: 'x64' }, windowsDesktopRuntimeEntries)],
  ['macOS', desktopManifest({ platform: 'darwin', arch: 'arm64' }, macosDesktopRuntimeEntries)],
] as const)('%s embedded desktop runtime excludes standalone clients and dependency directories', (_, manifest) => {
  expect(parseTerminalBundleManifest(manifest, true).entries).toEqual(manifest.entries);
  expect(() => parseTerminalBundleManifest(manifest)).toThrow('terminal_manifest_invalid');
  for (const path of [
    'web/manifest.json',
    'entrypoints/tui.js',
    'windows-frontdoor/terminal-verifier.exe',
    'code/@kite-ai/cli/host/index.js',
    'code/@kite-ai/ui/tui.js',
    'assets/node_modules/vendor/index.js',
    'code/@kite-ai/service/daemon-main.js',
  ]) {
    expect(() =>
      parseTerminalBundleManifest(
        {
          ...manifest,
          files: [...manifest.files, { path, size: 1, sha256: 'a'.repeat(64), mode: 420 }],
        },
        true,
      ),
    ).toThrow('terminal_manifest_invalid');
  }
  expect(() =>
    parseTerminalBundleManifest(
      { ...manifest, links: [{ path: 'node_modules/first', target: 'second' }] },
      true,
    ),
  ).toThrow('terminal_manifest_invalid');
});

test('macOS desktop manifest requires an Apple Silicon target and macOS executable', () => {
  const target = { platform: 'darwin', arch: 'arm64' };
  expect(() =>
    parseTerminalBundleManifest(desktopManifest(target, windowsDesktopRuntimeEntries), true),
  ).toThrow('terminal_manifest_invalid');
  expect(() =>
    parseTerminalBundleManifest(
      desktopManifest({ ...target, arch: 'x64' }, macosDesktopRuntimeEntries),
      true,
    ),
  ).toThrow('terminal_manifest_invalid');
});

function fixture() {
  const root = realpathSync(temporaryDirectory('kite-runtime-closure-'));
  const entries = terminalBundleEntries(process.platform);
  const files: TerminalBundleManifest['files'][number][] = [];
  for (const path of [...Object.values(entries), 'node_modules/dependency/index.js']) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (path === entries.runtime) copyFileSync(realpathSync(process.execPath), target);
    else
      writeFileSync(
        target,
        path === entries.webManifest ? '{}\n' : 'export const ownedFixture = true;\n',
      );
    const mode = path === entries.runtime ? 493 : 420;
    chmodSync(target, mode);
    const bytes = readFileSync(target);
    files.push({ path, mode, size: bytes.length, sha256: hash(bytes) });
  }
  symlinkSync('dependency', join(root, 'node_modules/alias'));
  const manifest: TerminalBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    bunVersion: Bun.version,
    sqlite: fixtureTerminalSqlite(root, files),
    productVersion: '0.1.0',
    source: { commit: 'a'.repeat(40), dirty: true },
    entries,
    files,
    links: [{ path: 'node_modules/alias', target: 'dependency' }],
  };
  const manifestPath = join(root, 'terminal-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const digest = hash(readFileSync(manifestPath));
  const proof = { kind: 'terminal.candidate' as const, root, manifestSha256: digest };
  const actual = {
    entrypoint: join(root, entries.service),
    executable: join(root, entries.runtime),
    buildId: `terminal-${digest}`,
  };
  return {
    root,
    entries,
    manifest,
    manifestPath,
    proof,
    actual,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('pure closed proof parse freezes metadata without probing even an absent root', () => {
  const raw = {
    kind: 'terminal.candidate',
    root: join(tmpdir(), 'absent-runtime-parse-only'),
    manifestSha256: 'a'.repeat(64),
  };
  const proof = parseTerminalRuntimeProtection(raw);
  expect(Object.isFrozen(proof)).toBe(true);
  raw.root = join(tmpdir(), 'changed');
  expect(proof.root).toBe(join(tmpdir(), 'absent-runtime-parse-only'));
  for (const invalid of [
    { ...raw, root: 'relative' },
    { ...raw, root: `/${'x'.repeat(4096)}` },
    { ...raw, root: '/a\0b' },
    { ...raw, manifestSha256: 'G'.repeat(64) },
    { ...raw, token: 'not-authority' },
  ])
    expect(() => parseTerminalRuntimeProtection(invalid)).toThrow(
      'terminal_runtime_protection_invalid',
    );
});

test('v1 worker closure requires only its fixed empty hooks directory and refuses missing or populated hooks', () => {
  const f = fixture();
  try {
    const directory = 'node_modules/@kite-ai/agent/tools/git-worktree';
    const files = [...f.manifest.files];
    for (const name of ['worker.js', 'empty-bunfig.toml', 'manifest.json']) {
      const path = `${directory}/${name}`,
        target = join(f.root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'SEALED_WORKTREE_ASSET', { mode: 0o644 });
      const bytes = readFileSync(target);
      files.push({ path, mode: 420, size: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { ...f.manifest, files };
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    expect(manifest.version).toBe(1);
    expect(terminalEmptyAssetDirectories(manifest)).toEqual([`${directory}/empty-hooks`]);
    const hooks = join(f.root, directory, 'empty-hooks');
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow();
    mkdirSync(hooks);
    expect(verifyTerminalRuntimeBundle(f.root).manifest.version).toBe(1);
    writeFileSync(join(hooks, 'post-checkout'), 'SHOULD_NEVER_EXECUTE');
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    unlinkSync(join(hooks, 'post-checkout'));
    rmdirSync(hooks);
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow();
    expect(
      terminalEmptyAssetDirectories({
        files: files.filter((file) => !file.path.endsWith('/manifest.json')),
      }),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test('real complete closure with actual Bun and declared internal link binds service and daemon to frozen original proof', () => {
  const f = fixture();
  try {
    const verified = verifyTerminalRuntimeBundle(f.root);
    expect(verified.root).toBe(f.root);
    expect(verified.digest).toBe(f.proof.manifestSha256);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.manifest.files[0])).toBe(true);
    expect(verifyTerminalRuntimeProtection(f.proof, f.actual)).toBe(f.root);
    expect(
      verifyTerminalRuntimeProtection(f.proof, {
        ...f.actual,
        entrypoint: join(f.root, f.entries.daemon),
      }),
    ).toBe(f.root);
    const parsed = parseTerminalBundleManifest(f.manifest);
    expect(parsed).toEqual(f.manifest);
  } finally {
    f.close();
  }
});

test('wrong manifest proof, build, entrypoint, Bun or leaf alias cannot confer a protected candidate root', () => {
  const f = fixture();
  try {
    expect(() =>
      verifyTerminalRuntimeProtection({ ...f.proof, manifestSha256: '0'.repeat(64) }, f.actual),
    ).toThrow('terminal_runtime_protection_mismatch');
    for (const actual of [
      { ...f.actual, buildId: 'wrong' },
      { ...f.actual, entrypoint: join(f.root, f.entries.cli) },
      { ...f.actual, executable: realpathSync(process.execPath) },
    ])
      expect(() => verifyTerminalRuntimeProtection(f.proof, actual)).toThrow(
        'terminal_runtime_protection_mismatch',
      );
    const alias = `${f.root}-entry-alias`;
    symlinkSync(f.actual.entrypoint, alias);
    try {
      expect(() =>
        verifyTerminalRuntimeProtection(f.proof, { ...f.actual, entrypoint: alias }),
      ).toThrow('terminal_runtime_protection_mismatch');
    } finally {
      unlinkSync(alias);
    }
  } finally {
    f.close();
  }
});

test('drift, changed file mode, extra file, undeclared directory and hardlink fail the whole physical closure', () => {
  const f = fixture();
  try {
    const entry = f.actual.entrypoint,
      original = readFileSync(entry);
    writeFileSync(entry, 'changed');
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    writeFileSync(entry, original);
    chmodSync(entry, 0o755);
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    chmodSync(entry, 0o644);
    const extra = join(f.root, 'extra.js');
    writeFileSync(extra, 'extra');
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    unlinkSync(extra);
    mkdirSync(join(f.root, 'undeclared'));
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    rmSync(join(f.root, 'undeclared'), { recursive: true });
    const linked = `${f.root}-hardlink`;
    linkSync(entry, linked);
    try {
      expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow(
        'terminal_bundle_identity_mismatch',
      );
    } finally {
      unlinkSync(linked);
    }
    expect(verifyTerminalRuntimeBundle(f.root).digest).toBe(f.proof.manifestSha256);
  } finally {
    f.close();
  }
});

test('changed or escaping node_modules link and incompatible platform are rejected; canonical ancestor selection remains exact', () => {
  const f = fixture();
  try {
    const link = join(f.root, 'node_modules/alias');
    unlinkSync(link);
    symlinkSync('../web', link);
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    unlinkSync(link);
    symlinkSync('dependency', link);
    expect(() =>
      parseTerminalBundleManifest({
        ...f.manifest,
        links: [{ path: 'node_modules/alias', target: '../../outside' }],
      }),
    ).toThrow('terminal_manifest_invalid');
    const alias = `${f.root}-root-alias`;
    symlinkSync(f.root, alias);
    try {
      expect(verifyTerminalRuntimeBundle(alias).root).toBe(f.root);
      expect(verifyTerminalRuntimeProtection({ ...f.proof, root: alias }, f.actual)).toBe(f.root);
    } finally {
      unlinkSync(alias);
    }
    writeFileSync(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        target: {
          platform: process.platform === 'darwin' ? 'linux' : 'darwin',
          arch: process.arch,
        },
      }),
    );
    expect(() => verifyTerminalRuntimeBundle(f.root)).toThrow('terminal_target_mismatch');
  } finally {
    f.close();
  }
});
