import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
  verifyTerminalBundle,
} from '../../../apps/cli/host/terminal-artifact';
import { acquireArtifactAccess } from '../../../packages/agent/src/artifact-access';
import {
  installTerminalBundle,
  rollbackTerminalBundle,
  uninstallTerminalBundle,
} from '../../../scripts/release/terminal-bundle';
import { fixtureTerminalSqlite } from '../../fixtures/unified-agent/sqlite-engine-fixture';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** These are inert byte fixtures: fake Bun is never executed and no Runtime/Store is opened. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-install-'))),
    prefix = join(root, 'managed');
  const data = join(root, 'profiles', 'default', 'core.db');
  mkdirSync(dirname(data), { recursive: true, mode: 0o700 });
  writeFileSync(data, 'ORIGINAL_APPLICATION_DATA');
  function candidate(name: string) {
    const candidate = join(root, name);
    mkdirSync(candidate, { mode: 0o700 });
    const entries = terminalBundleEntries(process.platform),
      files: TerminalBundleManifest['files'][number][] = [];
    for (const path of Object.values(entries)) {
      const bytes = Buffer.from(`INERT ${name} ${path}`),
        mode = path === entries.runtime ? 493 : 420;
      const target = join(candidate, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode });
      chmodSync(target, mode);
      files.push({ path, size: bytes.length, sha256: sha(bytes), mode });
    }
    const manifest: TerminalBundleManifest = {
      version: 1,
      apiMajor: 1,
      target: { platform: process.platform, arch: process.arch },
      bunVersion: Bun.version,
      sqlite: fixtureTerminalSqlite(candidate, files),
      productVersion: '0.1.0',
      source: { commit: 'a'.repeat(40), dirty: true },
      entries,
      files,
      links: [],
    };
    writeFileSync(join(candidate, 'terminal-manifest.json'), JSON.stringify(manifest) + '\n', {
      mode: 0o644,
    });
    return verifyTerminalBundle(candidate);
  }
  return {
    root,
    prefix,
    data,
    first: candidate('candidate-one'),
    second: candidate('candidate-two'),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const pointer = (prefix: string) => readFileSync(join(prefix, 'active'), 'utf8');
test('private umask077 preserves authenticated installed files, both launchers755 and coordination600 through upgrade rollback uninstall', () => {
  const f = fixture();
  const previous = process.umask(0o077);
  try {
    const first = installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix });
    for (const file of f.first.manifest.files)
      expect(lstatSync(join(first.releaseRoot, file.path)).mode & 0o777).toBe(file.mode);
    for (const name of ['kite', 'kite-tui'])
      expect(lstatSync(join(f.prefix, 'bin', name)).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(f.prefix, '.install.lock')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(f.prefix, 'active')).mode & 0o777).toBe(0o600);
    const use = acquireArtifactAccess({ root: first.releaseRoot, mode: 'shared' });
    try {
      expect(
        lstatSync(join(f.prefix, 'releases', `.use-${f.first.digest}.lock`)).mode & 0o777,
      ).toBe(0o600);
    } finally {
      use.release();
    }
    installTerminalBundle({ bundleRoot: f.second.root, prefix: f.prefix });
    expect(rollbackTerminalBundle(f.prefix).candidateId).toBe(f.first.digest);
    uninstallTerminalBundle(f.prefix);
    expect(existsSync(f.prefix)).toBe(false);
    expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
  } finally {
    process.umask(previous);
    f.close();
  }
});
test('real installer publishes distinct immutable candidates and exact complete rollback pointers without touching application data', () => {
  const f = fixture();
  try {
    const first = installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix });
    expect(pointer(f.prefix)).toBe(`${f.first.digest}\n\n`);
    expect(first.previousCandidateId).toBeNull();
    expect(verifyTerminalBundle(first.releaseRoot).digest).toBe(f.first.digest);
    const oneBytes = readFileSync(join(first.releaseRoot, 'terminal-manifest.json'));
    const second = installTerminalBundle({ bundleRoot: f.second.root, prefix: f.prefix });
    expect(pointer(f.prefix)).toBe(`${f.second.digest}\n${f.first.digest}\n`);
    expect(second.previousCandidateId).toBe(f.first.digest);
    expect(readFileSync(join(first.releaseRoot, 'terminal-manifest.json'))).toEqual(oneBytes);
    const again = installTerminalBundle({ bundleRoot: f.second.root, prefix: f.prefix });
    expect(again.previousCandidateId).toBe(f.first.digest);
    expect(pointer(f.prefix)).toBe(`${f.second.digest}\n${f.first.digest}\n`);
    const back = rollbackTerminalBundle(f.prefix);
    expect(back.candidateId).toBe(f.first.digest);
    expect(pointer(f.prefix)).toBe(`${f.first.digest}\n${f.second.digest}\n`);
    expect(rollbackTerminalBundle(f.prefix).candidateId).toBe(f.second.digest);
    expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
    uninstallTerminalBundle(f.prefix);
    expect(existsSync(f.prefix)).toBe(false);
    expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
  } finally {
    f.close();
  }
});
test('actual shared candidate flock rejects uninstall; after precise release artifacts are removed and independent data survives', () => {
  const f = fixture();
  let use: ReturnType<typeof acquireArtifactAccess> | undefined;
  try {
    const installed = installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix });
    const before = pointer(f.prefix);
    use = acquireArtifactAccess({ root: installed.releaseRoot, mode: 'shared' });
    expect(() => uninstallTerminalBundle(f.prefix)).toThrow('Lock is busy');
    expect(pointer(f.prefix)).toBe(before);
    expect(verifyTerminalBundle(installed.releaseRoot).digest).toBe(f.first.digest);
    use.release();
    use = undefined;
    uninstallTerminalBundle(f.prefix);
    expect(existsSync(f.prefix)).toBe(false);
    expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
  } finally {
    use?.release();
    f.close();
  }
});
test('unknown bin file and forged use-lock directory are not recursively deleted', () => {
  for (const kind of ['bin', 'lock-directory'] as const) {
    const f = fixture();
    try {
      installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix });
      const directory =
        kind === 'bin'
          ? join(f.prefix, 'bin')
          : join(f.prefix, 'releases', `.use-${'f'.repeat(64)}.lock`);
      if (kind === 'lock-directory') mkdirSync(directory, { mode: 0o700 });
      const foreign = join(directory, 'user-notes.txt');
      writeFileSync(foreign, 'DO_NOT_DELETE');
      const before = pointer(f.prefix);
      expect(() => uninstallTerminalBundle(f.prefix)).toThrow();
      expect(readFileSync(foreign, 'utf8')).toBe('DO_NOT_DELETE');
      expect(pointer(f.prefix)).toBe(before);
    } finally {
      f.close();
    }
  }
});
test('tampered source never switches active; corrupt previous candidate cannot become rollback target', () => {
  const f = fixture();
  try {
    const first = installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix }),
      before = pointer(f.prefix);
    const sourceEntry = join(f.second.root, f.second.manifest.entries.cli),
      bytes = readFileSync(sourceEntry);
    writeFileSync(sourceEntry, 'CORRUPTED');
    expect(() => installTerminalBundle({ bundleRoot: f.second.root, prefix: f.prefix })).toThrow(
      'terminal_bundle_identity_mismatch',
    );
    expect(pointer(f.prefix)).toBe(before);
    expect(verifyTerminalBundle(first.releaseRoot).digest).toBe(f.first.digest);
    writeFileSync(sourceEntry, bytes);
    installTerminalBundle({ bundleRoot: f.second.root, prefix: f.prefix });
    const current = pointer(f.prefix);
    writeFileSync(join(first.releaseRoot, f.first.manifest.entries.cli), 'CORRUPTED');
    expect(() => rollbackTerminalBundle(f.prefix)).toThrow('terminal_bundle_identity_mismatch');
    expect(pointer(f.prefix)).toBe(current);
    expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
  } finally {
    f.close();
  }
});
test('invalid active pointer cannot authorize cleanup and managed candidate directory alias cannot authorize reuse', () => {
  for (const kind of ['active', 'alias'] as const) {
    const f = fixture();
    try {
      const installed = installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix });
      if (kind === 'active') {
        writeFileSync(join(f.prefix, 'active'), 'CORRUPTED_POINTER\n');
        expect(() => uninstallTerminalBundle(f.prefix)).toThrow();
        expect(pointer(f.prefix)).toBe('CORRUPTED_POINTER\n');
        expect(existsSync(installed.releaseRoot)).toBe(true);
      } else {
        const before = pointer(f.prefix);
        rmSync(installed.releaseRoot, { recursive: true });
        symlinkSync(f.first.root, installed.releaseRoot);
        expect(() =>
          installTerminalBundle({ bundleRoot: f.first.root, prefix: f.prefix }),
        ).toThrow();
        expect(pointer(f.prefix)).toBe(before);
        expect(verifyTerminalBundle(f.first.root).digest).toBe(f.first.digest);
      }
    } finally {
      f.close();
    }
  }
});
test('installer rejects a prefix inside the source, including a symlink ancestor, before mutating the immutable candidate', () => {
  for (const alias of [false, true]) {
    const f = fixture();
    try {
      const source = f.first.root,
        before = readFileSync(join(source, 'terminal-manifest.json'));
      let parent = source;
      if (alias) {
        parent = join(f.root, 'source-alias');
        symlinkSync(source, parent);
      }
      const prefix = join(parent, 'nested-install');
      expect(() => installTerminalBundle({ bundleRoot: source, prefix })).toThrow(
        'terminal_destination_overlaps_bundle',
      );
      expect(existsSync(join(source, 'nested-install'))).toBe(false);
      expect(readFileSync(join(source, 'terminal-manifest.json'))).toEqual(before);
      expect(verifyTerminalBundle(source).digest).toBe(f.first.digest);
      expect(readFileSync(f.data, 'utf8')).toBe('ORIGINAL_APPLICATION_DATA');
    } finally {
      f.close();
    }
  }
});
