import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { windowsInstallationCoordination } from '../../../packages/agent/src/platform/windows-installation-coordination';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { finiteNativeFixture } from '../../fixtures/unified-agent/native-artifact-fixture';
import {
  directoryAlias,
  expectReleaseMode,
  fileAlias,
  releaseDirectory as mkdirSync,
  releaseScratch as mkdtempSync,
  unsafeReleasePermissions,
} from '../../fixtures/unified-agent/release-filesystem';

// Real filesystem fixtures; this does not change product qualification deadlines.
setDefaultTimeout(30_000);

test('finite Native managed install preserves lock0600 and closed launcher, rollback is pointer-only; holder is only a lock proof', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-')));
  try {
    const root = finiteNativeFixture(parent),
      prefix = join(parent, 'installed'),
      installed = installNativeBundle({ bundleRoot: root, prefix });
    expect(installed.previousCandidateId).toBeNull();
    expect(readFileSync(join(prefix, 'active'), 'utf8')).toBe(`${installed.candidateId}\n\n`);
    if (process.platform === 'win32') {
      for (const name of ['kite.exe', 'kite-tui.exe', 'kite-desktop.exe', 'native-verifier.exe']) {
        expect(readFileSync(join(prefix, 'bin', name))).toEqual(
          readFileSync(join(root, 'app', name)),
        );
        expectReleaseMode(join(prefix, 'bin', name), 0o755);
      }
    } else
      expect(readFileSync(join(prefix, 'bin/kite-desktop'), 'utf8')).toContain(
        'unset NODE_PATH NODE_OPTIONS BUN_OPTIONS ELECTRON_RUN_AS_NODE',
      );
    expect(() => rollbackNativeBundle(prefix)).toThrow(
      process.platform === 'win32'
        ? 'native_windows_previous_unavailable'
        : 'native_previous_unavailable',
    );
    const inner = acquireArtifactAccess({
      root: join(installed.releaseRoot, 'terminal'),
      mode: 'shared',
    });
    try {
      expect(() => uninstallNativeBundle(prefix)).toThrow();
      expect(existsSync(installed.releaseRoot)).toBe(true);
      expect(readFileSync(join(prefix, 'active'), 'utf8')).toBe(`${installed.candidateId}\n\n`);
    } finally {
      inner.release();
    }
    const outer = acquireArtifactAccess({ root: installed.releaseRoot, mode: 'shared' });
    try {
      expect(() => uninstallNativeBundle(prefix)).toThrow();
      expect(existsSync(prefix)).toBe(true);
    } finally {
      outer.release();
    }
    uninstallNativeBundle(prefix);
    expect(existsSync(prefix)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test('Native uninstall rejects a live inner holder before reading corrupted candidate content and releases its outer lease', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-busy-')));
  try {
    const source = finiteNativeFixture(parent),
      prefix = join(parent, 'installed'),
      installed = installNativeBundle({ bundleRoot: source, prefix }),
      manifest = join(installed.releaseRoot, 'native-manifest.json'),
      original = readFileSync(manifest),
      active = readFileSync(join(prefix, 'active')),
      holder = acquireArtifactAccess({
        root: join(installed.releaseRoot, 'terminal'),
        mode: 'shared',
      });
    writeFileSync(manifest, 'invalid candidate content');
    try {
      expect(() => uninstallNativeBundle(prefix)).toThrow('Lock is busy');
      expect(readFileSync(join(prefix, 'active'))).toEqual(active);
      expect(readFileSync(manifest, 'utf8')).toBe('invalid candidate content');
      const outer = acquireArtifactAccess({ root: installed.releaseRoot, mode: 'exclusive' });
      outer.release();
    } finally {
      holder.release();
    }
    expect(() => uninstallNativeBundle(prefix)).toThrow('native_manifest_invalid');
    expect(existsSync(prefix)).toBe(true);
    expect(readFileSync(join(prefix, 'active'))).toEqual(active);
    writeFileSync(manifest, original);
    uninstallNativeBundle(prefix);
    expect(existsSync(prefix)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Native uninstall rejects candidate and inner directory aliases before taking their use locks', () => {
  for (const nested of [false, true]) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-alias-')));
    try {
      const source = finiteNativeFixture(parent),
        prefix = join(parent, 'installed'),
        installed = installNativeBundle({ bundleRoot: source, prefix }),
        path = nested ? join(installed.releaseRoot, 'terminal') : installed.releaseRoot,
        target = join(parent, 'alias-target'),
        active = readFileSync(join(prefix, 'active'));
      renameSync(path, target);
      directoryAlias(target, path);
      expect(() => uninstallNativeBundle(prefix)).toThrow();
      expect(existsSync(prefix)).toBe(true);
      expect(readFileSync(join(prefix, 'active'))).toEqual(active);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
test('finite Native install refuses unknown files, badactive/marker, lock aliases and modes without deleting managed candidate', () => {
  const mutations = [
    (p: string) => writeFileSync(join(p, 'unknown'), 'never delete'),
    (p: string) => writeFileSync(join(p, 'active'), 'bad\n\n'),
    (p: string) => writeFileSync(join(p, '.kite-native-install.json'), '{}'),
    (p: string) => {
      const coordination =
        process.platform === 'win32' ? windowsInstallationCoordination(p) : undefined;
      try {
        const lock = coordination?.selectionLockPath ?? join(p, '.install.lock');
        rmSync(lock);
        fileAlias(join(p, 'active'), lock);
      } finally {
        coordination?.release();
      }
    },
    (p: string) => unsafeReleasePermissions(join(p, 'active'), 0o644),
    (p: string) => writeFileSync(join(p, 'releases/.use-' + 'b'.repeat(64) + '.lock'), ''),
  ];
  for (const mutate of mutations) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-bad-')));
    try {
      const source = finiteNativeFixture(parent),
        prefix = join(parent, 'installed'),
        original = installNativeBundle({ bundleRoot: source, prefix });
      mutate(prefix);
      expect(() => uninstallNativeBundle(prefix)).toThrow();
      expect(existsSync(original.releaseRoot)).toBe(true);
      expect(() => installNativeBundle({ bundleRoot: source, prefix })).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-user-')));
  try {
    const source = finiteNativeFixture(parent),
      prefix = join(parent, 'user');
    mkdirSync(prefix);
    writeFileSync(join(prefix, 'user-file'), 'keep');
    expect(() => installNativeBundle({ bundleRoot: source, prefix })).toThrow(
      process.platform === 'win32'
        ? 'native_windows_install_not_empty'
        : 'native_install_not_empty',
    );
    expect(existsSync(join(prefix, '.install.lock'))).toBe(false);
    expect(readFileSync(join(prefix, 'user-file'), 'utf8')).toBe('keep');
    expect(() =>
      installNativeBundle({ bundleRoot: source, prefix: join(source, 'nested') }),
    ).toThrow('terminal_destination_overlaps_bundle');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Native install marker rejects invalid UTF8 even when replacement text would equal the owned Unicode root', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-marker-')));
  try {
    const source = finiteNativeFixture(parent),
      prefix = join(parent, 'owned-�'),
      installed = installNativeBundle({ bundleRoot: source, prefix }),
      path = join(prefix, '.kite-native-install.json'),
      bytes = readFileSync(path),
      index = bytes.indexOf(Buffer.from('�'));
    expect(index).toBeGreaterThan(-1);
    writeFileSync(
      path,
      Buffer.concat([bytes.subarray(0, index), Buffer.from([255]), bytes.subarray(index + 3)]),
    );
    expect(() => uninstallNativeBundle(prefix)).toThrow();
    expect(() => installNativeBundle({ bundleRoot: source, prefix })).toThrow();
    expect(existsSync(installed.releaseRoot)).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
