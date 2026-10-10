import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CLI_REGISTRATION_FILE,
  OWNED_CLI_REGISTRATION_FILE,
  parseCLIRegistration,
  readCLIRegistration,
} from '../../../apps/cli/host/cli-registration';
import { acquireRegisteredTerminalSelection } from '../../../apps/cli/host/registered-terminal';
import {
  acquireCLIRegistrationLocks,
  registerNativeCLI,
} from '../../../scripts/release/cli-registration';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import {
  installTerminalBundle,
  uninstallTerminalBundle,
  verifyTerminalBundle,
} from '../../../scripts/release/terminal-bundle';
import { finiteNativeFixture } from '../../fixtures/unified-agent/native-artifact-fixture';

function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-cli-registration-'));
  const source = finiteNativeFixture(root);
  const terminal = installTerminalBundle({
    bundleRoot: join(source, 'terminal'),
    prefix: join(root, 'standalone'),
  });
  const nativePrefix = join(root, 'native-a');
  const original = join(root, 'user-data', 'draft');
  mkdirSync(join(root, 'user-data'));
  writeFileSync(original, 'ORIGINAL UTF8 草稿');
  return {
    root,
    source,
    terminal,
    nativePrefix,
    original,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test.skipIf(process.platform === 'win32')(
  'finite owned registration selects full Native proof, holds both roots, then uninstall restores original Terminal and independent data',
  () => {
    const f = fixture();
    try {
      const installed = installNativeBundle({
        bundleRoot: f.source,
        prefix: f.nativePrefix,
        cliPrefix: f.terminal.root,
      });
      for (const file of ['kite', 'kite-tui', 'kite-desktop'])
        expect(lstatSync(join(f.nativePrefix, 'bin', file)).mode & 0o777).toBe(0o755);
      const registration = readCLIRegistration(f.terminal.root)!;
      expect(registration.nativePrefix).toBe(f.nativePrefix);
      expect(registration.candidateId).toBe(installed.candidateId);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(registration);
      const selected = acquireRegisteredTerminalSelection(f.terminal.releaseRoot);
      try {
        expect(selected.artifact.runtimeProtection?.kind).toBe('native.candidate');
        expect(selected.artifact.buildId).toBe(`native-${installed.candidateId}`);
        expect(
          selected.artifact.entrypoint.startsWith(`${join(installed.releaseRoot, 'terminal')}/`),
        ).toBe(true);
        expect(() => uninstallNativeBundle(f.nativePrefix)).toThrow('Lock is busy');
        expect(readCLIRegistration(f.terminal.root)).toEqual(registration);
      } finally {
        selected.close();
      }
      uninstallNativeBundle(f.nativePrefix);
      expect(readCLIRegistration(f.terminal.root)).toBeUndefined();
      const restored = acquireRegisteredTerminalSelection(f.terminal.releaseRoot);
      try {
        expect(restored.artifact.buildId).toBe(`terminal-${f.terminal.candidateId}`);
      } finally {
        restored.close();
      }
      expect(readFileSync(f.original, 'utf8')).toBe('ORIGINAL UTF8 草稿');
      uninstallTerminalBundle(f.terminal.root);
      expect(existsSync(f.terminal.root)).toBe(false);
    } finally {
      f.close();
    }
  },
);
test.skipIf(process.platform === 'win32')(
  'old Native uninstall cannot erase another installation nonce; prefix locks use fixed sorted order',
  () => {
    const f = fixture();
    try {
      installNativeBundle({
        bundleRoot: f.source,
        prefix: f.nativePrefix,
        cliPrefix: f.terminal.root,
      });
      const old = readCLIRegistration(f.nativePrefix, true)!;
      const other = installNativeBundle({ bundleRoot: f.source, prefix: join(f.root, 'native-b') });
      const newer = registerNativeCLI({
        nativePrefix: other.root,
        terminalPrefix: f.terminal.root,
      });
      expect(newer.nonce).not.toBe(old.nonce);
      const locks = acquireCLIRegistrationLocks([other.root, f.terminal.root]);
      try {
        expect(locks.map((lock) => lock.path)).toEqual(
          [other.root, f.terminal.root].sort().map((prefix) => join(prefix, '.install.lock')),
        );
      } finally {
        for (const lock of locks.reverse()) lock.release();
      }
      uninstallNativeBundle(f.nativePrefix);
      expect(readCLIRegistration(f.terminal.root)).toEqual(newer);
      const selected = acquireRegisteredTerminalSelection(f.terminal.releaseRoot);
      try {
        expect(selected.artifact.entrypoint.startsWith(`${other.releaseRoot}/`)).toBe(true);
      } finally {
        selected.close();
      }
      uninstallNativeBundle(other.root);
      expect(readCLIRegistration(f.terminal.root)).toBeUndefined();
    } finally {
      f.close();
    }
  },
);
test.skipIf(process.platform === 'win32')(
  'registered missing, mismatched, future, linked or unsafe metadata fail closed without selecting the independent fallback',
  () => {
    for (const kind of ['missing', 'nonce', 'future', 'link', 'mode', 'active'] as const) {
      const f = fixture();
      try {
        installNativeBundle({
          bundleRoot: f.source,
          prefix: f.nativePrefix,
          cliPrefix: f.terminal.root,
        });
        const path = join(f.terminal.root, CLI_REGISTRATION_FILE);
        const raw = readCLIRegistration(f.terminal.root)!;
        if (kind === 'missing')
          rmSync(join(f.nativePrefix, 'releases', raw.candidateId), { recursive: true });
        if (kind === 'nonce')
          writeFileSync(path, JSON.stringify({ ...raw, nonce: 'f'.repeat(32) }));
        if (kind === 'future') writeFileSync(path, JSON.stringify({ ...raw, version: 2 }));
        if (kind === 'link') {
          rmSync(path);
          symlinkSync(join(f.nativePrefix, OWNED_CLI_REGISTRATION_FILE), path);
        }
        if (kind === 'active')
          writeFileSync(join(f.nativePrefix, 'active'), `${'e'.repeat(64)}\n\n`);
        if (kind === 'mode') {
          rmSync(path);
          writeFileSync(path, JSON.stringify(raw), { mode: 0o644 });
        }
        expect(() => acquireRegisteredTerminalSelection(f.terminal.releaseRoot)).toThrow();
        expect(readFileSync(f.original, 'utf8')).toBe('ORIGINAL UTF8 草稿');
        expect(existsSync(join(f.root, '.kite-code'))).toBe(false);
      } finally {
        f.close();
      }
    }
    for (const invalid of [
      { version: 1 },
      {
        version: 1,
        terminalPrefix: '/a',
        nativePrefix: '/a',
        candidateId: 'a'.repeat(64),
        nonce: 'b'.repeat(32),
      },
    ])
      expect(() => parseCLIRegistration(invalid)).toThrow();
  },
);

test.skipIf(process.platform === 'win32')(
  'registration follows immutable upgrade and rollback pointers; invalid explicit target fails before active publication',
  () => {
    const f = fixture();
    try {
      const invalid = join(f.root, 'unmanaged');
      mkdirSync(invalid);
      writeFileSync(join(invalid, 'keep'), 'owned unrelated');
      expect(() =>
        installNativeBundle({ bundleRoot: f.source, prefix: f.nativePrefix, cliPrefix: invalid }),
      ).toThrow();
      expect(existsSync(join(f.nativePrefix, 'active'))).toBe(false);
      expect(readFileSync(join(invalid, 'keep'), 'utf8')).toBe('owned unrelated');
      const first = installNativeBundle({
        bundleRoot: f.source,
        prefix: f.nativePrefix,
        cliPrefix: f.terminal.root,
      });
      const firstRegistration = readCLIRegistration(f.terminal.root)!;
      const next = join(f.root, 'next');
      cpSync(f.source, next, { recursive: true, verbatimSymlinks: true });
      const path = join(next, 'native-manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const innerPath = join(next, 'terminal/terminal-manifest.json');
      const inner = JSON.parse(readFileSync(innerPath, 'utf8'));
      inner.productVersion = '0.1.1';
      const innerBytes = Buffer.from(JSON.stringify(inner));
      writeFileSync(innerPath, innerBytes);
      manifest.terminalManifestSha256 = createHash('sha256').update(innerBytes).digest('hex');
      writeFileSync(path, JSON.stringify(manifest));
      const second = installNativeBundle({ bundleRoot: next, prefix: f.nativePrefix });
      expect(second.previousCandidateId).toBe(first.candidateId);
      expect(readCLIRegistration(f.terminal.root)!.candidateId).toBe(second.candidateId);
      expect(readCLIRegistration(f.terminal.root)!.nonce).not.toBe(firstRegistration.nonce);
      const rolled = rollbackNativeBundle(f.nativePrefix);
      expect(rolled.candidateId).toBe(first.candidateId);
      expect(readCLIRegistration(f.terminal.root)!.candidateId).toBe(first.candidateId);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(
        readCLIRegistration(f.terminal.root),
      );
      uninstallNativeBundle(f.nativePrefix);
      expect(readCLIRegistration(f.terminal.root)).toBeUndefined();
    } finally {
      f.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'normal standalone Terminal uninstall leaves Native independently upgradeable without recreating or registering the missing target',
  () => {
    const f = fixture();
    try {
      const first = installNativeBundle({
        bundleRoot: f.source,
        prefix: f.nativePrefix,
        cliPrefix: f.terminal.root,
      });
      const owned = readCLIRegistration(f.nativePrefix, true)!;
      const activePath = join(f.nativePrefix, 'active');
      const originalActive = readFileSync(activePath);
      uninstallTerminalBundle(f.terminal.root);
      expect(existsSync(f.terminal.root)).toBe(false);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(owned);
      const next = join(f.root, 'next-independent');
      cpSync(f.source, next, { recursive: true, verbatimSymlinks: true });
      const path = join(next, 'native-manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const innerPath = join(next, 'terminal/terminal-manifest.json');
      const inner = JSON.parse(readFileSync(innerPath, 'utf8'));
      inner.productVersion = '0.1.1';
      const innerBytes = Buffer.from(JSON.stringify(inner));
      writeFileSync(innerPath, innerBytes);
      manifest.terminalManifestSha256 = createHash('sha256').update(innerBytes).digest('hex');
      writeFileSync(path, JSON.stringify(manifest));
      expect(() =>
        installNativeBundle({
          bundleRoot: next,
          prefix: f.nativePrefix,
          cliPrefix: f.terminal.root,
        }),
      ).toThrow();
      expect(readFileSync(activePath)).toEqual(originalActive);
      const invalid = join(f.root, 'unmanaged-explicit');
      mkdirSync(invalid);
      writeFileSync(join(invalid, 'keep'), 'unrelated original');
      expect(() =>
        installNativeBundle({ bundleRoot: next, prefix: f.nativePrefix, cliPrefix: invalid }),
      ).toThrow();
      expect(readFileSync(activePath)).toEqual(originalActive);
      expect(readFileSync(join(invalid, 'keep'), 'utf8')).toBe('unrelated original');
      const second = installNativeBundle({ bundleRoot: next, prefix: f.nativePrefix });
      expect(second.candidateId).not.toBe(first.candidateId);
      expect(second.previousCandidateId).toBe(first.candidateId);
      expect(readFileSync(activePath, 'utf8')).toBe(
        `${second.candidateId}\n${first.candidateId}\n`,
      );
      expect(existsSync(f.terminal.root)).toBe(false);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(owned);
      const rolled = rollbackNativeBundle(f.nativePrefix);
      expect(rolled.candidateId).toBe(first.candidateId);
      expect(readFileSync(activePath, 'utf8')).toBe(
        `${first.candidateId}\n${second.candidateId}\n`,
      );
      expect(existsSync(f.terminal.root)).toBe(false);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(owned);
      expect(readFileSync(f.original, 'utf8')).toBe('ORIGINAL UTF8 草稿');
      uninstallNativeBundle(f.nativePrefix);
      expect(existsSync(f.nativePrefix)).toBe(false);
      expect(existsSync(f.terminal.root)).toBe(false);
      expect(readFileSync(f.original, 'utf8')).toBe('ORIGINAL UTF8 草稿');
    } finally {
      f.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'registered Native rollback rejects a damaged Terminal before selection changes, then repair preserves the original frontdoor and permits normal rollback',
  () => {
    const f = fixture();
    try {
      const first = installNativeBundle({
        bundleRoot: f.source,
        prefix: f.nativePrefix,
        cliPrefix: f.terminal.root,
      });
      const next = join(f.root, 'next-rollback-preflight');
      cpSync(f.source, next, { recursive: true, verbatimSymlinks: true });
      const manifestPath = join(next, 'native-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const innerPath = join(next, 'terminal/terminal-manifest.json');
      const inner = JSON.parse(readFileSync(innerPath, 'utf8'));
      inner.productVersion = '0.1.1';
      const innerBytes = Buffer.from(JSON.stringify(inner));
      writeFileSync(innerPath, innerBytes);
      manifest.terminalManifestSha256 = createHash('sha256').update(innerBytes).digest('hex');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const second = installNativeBundle({ bundleRoot: next, prefix: f.nativePrefix });
      const selectedPaths = [
        join(f.nativePrefix, 'active'),
        join(f.nativePrefix, OWNED_CLI_REGISTRATION_FILE),
        join(f.terminal.root, CLI_REGISTRATION_FILE),
      ];
      const before = selectedPaths.map((path) => readFileSync(path));
      const data = readFileSync(f.original);
      const asset = join(
        f.terminal.releaseRoot,
        verifyTerminalBundle(f.terminal.releaseRoot).manifest.entries.cli,
      );
      const original = readFileSync(asset);
      const damaged = Buffer.from(original);
      damaged[0] = damaged[0]! ^ 1;
      writeFileSync(asset, damaged);
      expect(() => rollbackNativeBundle(f.nativePrefix)).toThrow();
      for (const [index, path] of selectedPaths.entries())
        expect(readFileSync(path)).toEqual(before[index]!);
      expect(readFileSync(f.original)).toEqual(data);
      writeFileSync(asset, original);
      const unchanged = acquireRegisteredTerminalSelection(f.terminal.releaseRoot);
      try {
        expect(unchanged.artifact.buildId).toBe(`native-${second.candidateId}`);
        expect(() => uninstallNativeBundle(f.nativePrefix)).toThrow('Lock is busy');
        for (const [index, path] of selectedPaths.entries())
          expect(readFileSync(path)).toEqual(before[index]!);
      } finally {
        unchanged.close();
      }
      const rolled = rollbackNativeBundle(f.nativePrefix);
      expect(rolled.candidateId).toBe(first.candidateId);
      const registration = readCLIRegistration(f.terminal.root)!;
      expect(registration.candidateId).toBe(first.candidateId);
      expect(readCLIRegistration(f.nativePrefix, true)).toEqual(registration);
      const selected = acquireRegisteredTerminalSelection(f.terminal.releaseRoot);
      try {
        expect(selected.artifact.buildId).toBe(`native-${first.candidateId}`);
      } finally {
        selected.close();
      }
      uninstallNativeBundle(f.nativePrefix);
      expect(readCLIRegistration(f.terminal.root)).toBeUndefined();
      uninstallTerminalBundle(f.terminal.root);
      expect(readFileSync(f.original)).toEqual(data);
    } finally {
      f.close();
    }
  },
);
