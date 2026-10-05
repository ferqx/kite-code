import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  parseTerminalBundleManifest,
  type TerminalBundleManifest,
  terminalBundleEntries,
  verifyTerminalBundle,
} from '../../../apps/cli/host/terminal-artifact';
import { fixtureTerminalSqlite } from '../../fixtures/unified-agent/sqlite-engine-fixture';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-artifact-'))),
    root = join(parent, 'original');
  mkdirSync(root);
  const entries = terminalBundleEntries(process.platform),
    files: TerminalBundleManifest['files'][number][] = [];
  for (const path of [...Object.values(entries), 'node_modules/example/index.js']) {
    const bytes = Buffer.from(
        path === 'node_modules/example/index.js' ? 'export const value=1;' : `fixture ${path}`,
      ),
      mode = path === entries.runtime ? 493 : 420;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes, { mode });
    chmodSync(join(root, path), mode);
    files.push({ path, size: bytes.byteLength, sha256: sha(bytes), mode });
  }
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
    links: [{ path: 'node_modules/alias', target: 'example' }],
  };
  symlinkSync('example', join(root, 'node_modules/alias'));
  const save = (value: unknown = manifest) => {
    writeFileSync(join(root, 'terminal-manifest.json'), JSON.stringify(value) + '\n', {
      mode: 0o644,
    });
  };
  save();
  return {
    parent,
    root,
    manifest,
    save,
    close: () => rmSync(parent, { recursive: true, force: true }),
  };
}
test('unknown empty directories and external hardlinks cannot be part of a verified closure', () => {
  for (const kind of ['empty-directory', 'external-hardlink', 'manifest-hardlink'] as const) {
    const f = fixture();
    try {
      if (kind === 'empty-directory') mkdirSync(join(f.root, 'unknown'));
      else
        linkSync(
          join(
            f.root,
            kind === 'manifest-hardlink' ? 'terminal-manifest.json' : f.manifest.entries.cli,
          ),
          join(f.parent, 'outside-link'),
        );
      expect(() => verifyTerminalBundle(f.root)).toThrow();
    } finally {
      f.close();
    }
  }
});
test('relocated full closure binds manifest bytes, exact installed runtime, Service, daemon and Web without source/PATH fallback', () => {
  const f = fixture();
  try {
    const original = verifyTerminalBundle(f.root);
    expect(original.candidateId).toBe(sha(readFileSync(join(f.root, 'terminal-manifest.json'))));
    expect(original.buildId).toBe('terminal-' + original.candidateId);
    expect(original.artifact.executable).toBe(join(f.root, f.manifest.entries.runtime));
    expect(original.artifact.daemon?.web.directory).toBe(join(f.root, 'web'));
    const moved = join(f.parent, 'moved');
    cpSync(f.root, moved, { recursive: true, dereference: false, verbatimSymlinks: true });
    rmSync(f.root, { recursive: true });
    const selected = verifyTerminalBundle(moved);
    expect(selected.candidateId).toBe(original.candidateId);
    expect(selected.artifact.entrypoint).toBe(join(moved, f.manifest.entries.service));
    expect(selected.artifact.daemon?.entrypoint).toBe(join(moved, f.manifest.entries.daemon));
    expect(selected.artifact.executableSha256).toBe(original.artifact.executableSha256);
    expect(Object.isFrozen(selected.manifest.files[0])).toBe(true);
    expect(selected.manifest.source.dirty).toBe(true);
  } finally {
    f.close();
  }
});
test('every inventoried file is checked; missing, extra, same-size tamper and altered mode fail closed', () => {
  for (const action of ['missing', 'extra', 'tamper', 'mode'] as const) {
    const f = fixture();
    try {
      const path = join(f.root, 'node_modules/example/index.js');
      if (action === 'missing') rmSync(path);
      if (action === 'extra') writeFileSync(join(f.root, 'extra.txt'), 'unlisted');
      if (action === 'tamper') writeFileSync(path, 'export const value=2;');
      if (action === 'mode') chmodSync(path, 0o755);
      expect(() => verifyTerminalBundle(f.root)).toThrow('terminal_bundle_identity_mismatch');
    } finally {
      f.close();
    }
  }
});
test('relative internal links are exact; external, escaping, dangling, cycle, parent alias and hardlink paths are refused', () => {
  for (const action of ['external', 'escape', 'dangling', 'cycle', 'alias', 'hardlink'] as const) {
    const f = fixture();
    try {
      const link = join(f.root, 'node_modules/alias');
      rmSync(link);
      if (action === 'external') {
        symlinkSync(f.parent, link);
        f.save({ ...f.manifest, links: [{ path: 'node_modules/alias', target: f.parent }] });
      }
      if (action === 'escape') {
        symlinkSync('../../outside', link);
        f.save({ ...f.manifest, links: [{ path: 'node_modules/alias', target: '../../outside' }] });
      }
      if (action === 'dangling') symlinkSync('missing', link);
      if (action === 'cycle') symlinkSync('alias', link);
      if (action === 'alias') {
        symlinkSync('example', link);
        f.save({
          ...f.manifest,
          files: [
            ...f.manifest.files,
            { ...f.manifest.files.at(-1)!, path: 'node_modules/alias/index.js' },
          ],
        });
      }
      if (action === 'hardlink') {
        symlinkSync('example', link);
        const original = join(f.root, 'node_modules/example/index.js');
        linkSync(original, join(f.root, 'node_modules/duplicate.js'));
        f.save({
          ...f.manifest,
          files: [
            ...f.manifest.files,
            { ...f.manifest.files.at(-1)!, path: 'node_modules/duplicate.js' },
          ],
        });
      }
      expect(() => verifyTerminalBundle(f.root)).toThrow();
    } finally {
      f.close();
    }
  }
});
test('closed schema rejects unknown fields, path aliases, duplicate identity and missing fixed entry, target mismatch is explicit', () => {
  const f = fixture();
  try {
    for (const input of [
      { ...f.manifest, signed: true },
      { ...f.manifest, source: { ...f.manifest.source, signature: 'false' } },
      { ...f.manifest, entries: { ...f.manifest.entries, cli: 'entrypoints/other.js' } },
      { ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] },
      {
        ...f.manifest,
        files: f.manifest.files.map((row, i) =>
          i === 0 ? { ...row, path: 'runtime/../runtime/bun' } : row,
        ),
      },
      { ...f.manifest, files: f.manifest.files.slice(1) },
      { ...f.manifest, links: [{ path: 'node_modules/alias', target: 'C:/external' }] },
    ])
      expect(() => parseTerminalBundleManifest(input)).toThrow('terminal_manifest_invalid');
    f.save({
      ...f.manifest,
      target: { ...f.manifest.target, arch: process.arch === 'arm64' ? 'x64' : 'arm64' },
    });
    expect(() => verifyTerminalBundle(f.root)).toThrow('terminal_target_mismatch');
  } finally {
    f.close();
  }
});
test('manifest identity uses full original bytes; symlink manifest cannot become installed authority', () => {
  const f = fixture();
  try {
    const first = verifyTerminalBundle(f.root);
    writeFileSync(
      join(f.root, 'terminal-manifest.json'),
      JSON.stringify(f.manifest, null, 2) + '\n',
    );
    const second = verifyTerminalBundle(f.root);
    expect(second.candidateId).not.toBe(first.candidateId);
    expect(second.artifact.entrypointSha256).toBe(first.artifact.entrypointSha256);
    const manifest = join(f.root, 'terminal-manifest.json');
    cpSync(manifest, join(f.parent, 'manifest-copy'));
    rmSync(manifest);
    symlinkSync('../manifest-copy', manifest);
    expect(() => verifyTerminalBundle(f.root)).toThrow('terminal_bundle_unavailable');
  } finally {
    f.close();
  }
});
test('new terminal entrypoints pure help/version and nonterminal TUI reject without bundle or profile reads', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kite-terminal-pure-'));
  try {
    for (const [entry, argv, code] of [
      ['terminal-cli.ts', ['--help'], 0],
      ['terminal-cli.ts', ['--version'], 0],
      ['terminal-tui.ts', ['--help'], 0],
      ['terminal-tui.ts', ['--version'], 0],
      ['terminal-tui.ts', [], 1],
    ] as const) {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, '../../../scripts/release/entrypoints', entry),
          ...argv,
        ],
        { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(code);
      if (code === 1) expect(stderr).toContain('tui_terminal_unavailable');
      else expect(stdout.length).toBeGreaterThan(0);
      expect(() =>
        readFileSync(join(home, '.kite-code', 'unified-agent', 'default', 'core.db')),
      ).toThrow();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
