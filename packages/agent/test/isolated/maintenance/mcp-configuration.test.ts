import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { parseManifest } from '../../../src/maintenance/manifest';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

const files = [
  ['mcpConfiguration', 'mcp.json'],
  ['mcpApprovals', 'mcp-approvals.json'],
  ['mcpAuthBindings', 'mcp-auth-bindings.json'],
] as const;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-maintenance-mcp-configuration-'),
    profile = { dataRoot: join(root, 'data'), profile: 'mcp' },
    store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  await store.close();
  return {
    root,
    profile,
    storeId,
    selected: selectProfile(profile),
    destinationRoot: join(root, 'backups'),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function databaseFiles(path: string) {
  return ['', '-wal', '-shm'].map((suffix) => {
    const file = path + suffix;
    if (!existsSync(file)) return null;
    const stat = statSync(file, { bigint: true });
    return {
      bytes: readFileSync(file),
      dev: stat.dev,
      ino: stat.ino,
      ctimeNs: stat.ctimeNs,
      mode: stat.mode,
    };
  });
}

test('public offline backup and new-Store restore preserve all three raw MCP files and original absence of Vault/locks', async () => {
  const f = await fixture();
  try {
    const originals = [
      Buffer.from('\ufeff// 原完整声明\r\n{"mcpServers":{"原名":{"unknown":"原文🔐"}},\r\n'),
      Buffer.from(
        '// old source decisions\n{"version":1,"records":{"original":{"storeId":"A"}},"unknown":true}\n',
      ),
      Buffer.concat([
        Buffer.from(
          '{"credentialRef":"credential:01234567-1234-1234-1234-012345678901","originalStore":"A"}\n',
        ),
        Buffer.from([0xff, 0x00]),
      ]),
    ];
    for (const [index, [, path]] of files.entries())
      writeFileSync(join(f.selected.profilePath, path), originals[index]!, { mode: 0o600 });
    writeFileSync(join(f.selected.profilePath, 'credentials'), 'owned vault excluded', {
      mode: 0o600,
    });
    writeFileSync(join(f.selected.profilePath, '.mcp.json.lock'), 'owned lock excluded', {
      mode: 0o600,
    });
    const before = databaseFiles(f.selected.databasePath);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(16);
    expect(databaseFiles(f.selected.databasePath)).toEqual(before);
    expect(backup.manifest.assets.desktopUi.present).toBe(false);
    expect(backup.manifest.assets.vaultExcluded).toBe(true);
    expect(backup.manifest.assets.configurationMayContainSensitiveContent).toBe(true);
    for (const [index, [key, path]] of files.entries()) {
      const bytes = originals[index]!;
      expect(backup.manifest.assets[key]).toEqual({
        path,
        capturedAt: expect.any(String),
        present: true,
        proof: { byteLength: String(bytes.length), sha256: sha(bytes) },
      });
      expect(Number.isFinite(Date.parse(backup.manifest.assets[key]!.capturedAt))).toBe(true);
      expect(readFileSync(join(backup.directory, path))).toEqual(bytes);
    }
    expect(readFileSync(join(backup.directory, 'ready.json')).length).toBeLessThan(16384);
    expect(existsSync(join(backup.directory, 'credentials'))).toBe(false);
    expect(existsSync(join(backup.directory, '.mcp.json.lock'))).toBe(false);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(databaseFiles(f.selected.databasePath)).toEqual(before);
    for (const [, path] of files)
      writeFileSync(join(f.selected.profilePath, path), `later ${path}`, { mode: 0o600 });
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    for (const [index, [, path]] of files.entries()) {
      expect(readFileSync(join(f.selected.profilePath, path))).toEqual(originals[index]!);
      expect(readFileSync(join(restored.preservedDirectory, path), 'utf8')).toBe(`later ${path}`);
    }
    expect(existsSync(join(f.selected.profilePath, 'credentials'))).toBe(false);
    expect(existsSync(join(f.selected.profilePath, '.mcp.json.lock'))).toBe(false);
  } finally {
    f.close();
  }
});

test('only actual MCP presence selects v16; each absent sibling stays absent through a new-Store restore', async () => {
  for (const [presentKey, presentPath] of files) {
    const f = await fixture();
    try {
      const legacy = await createProfileBackup(f);
      expect(legacy.manifest.version).toBe(5);
      for (const [key] of files) expect(legacy.manifest.assets[key]).toBeUndefined();
      writeFileSync(join(f.selected.profilePath, presentPath), '', { mode: 0o600 });
      const backup = await createProfileBackup(f);
      expect(backup.manifest.version).toBe(16);
      for (const [key, path] of files) {
        expect(backup.manifest.assets[key]).toMatchObject({
          path,
          present: key === presentKey,
          proof: key === presentKey ? { byteLength: '0', sha256: sha(Buffer.alloc(0)) } : null,
        });
        expect(existsSync(join(backup.directory, path))).toBe(key === presentKey);
      }
      const absent = structuredClone(backup.manifest);
      absent.assets[presentKey]!.present = false;
      absent.assets[presentKey]!.proof = null;
      expect(() => parseManifest(absent)).toThrow('backup_invalid_manifest');
      await restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      });
      for (const [key, path] of files)
        expect(existsSync(join(f.selected.profilePath, path))).toBe(key === presentKey);
    } finally {
      f.close();
    }
  }
});

test('closed manifests and physical trees reject new MCP fields in old versions, bad metadata, omitted and tampered bytes', async () => {
  const f = await fixture();
  try {
    const legacy = await createProfileBackup(f);
    for (const [, path] of files)
      writeFileSync(join(f.selected.profilePath, path), path, { mode: 0o600 });
    const backup = await createProfileBackup(f);
    for (let version = 2; version <= 15; version++)
      expect(() => parseManifest({ ...backup.manifest, version })).toThrow(
        'backup_invalid_manifest',
      );
    for (const [key, path] of files) {
      for (const change of ['missing', 'extra', 'path', 'proof', 'format'] as const) {
        const bad = structuredClone(backup.manifest);
        const asset = bad.assets[key]!;
        if (change === 'missing') delete bad.assets[key];
        else if (change === 'extra') Object.assign(asset, { unexpected: true });
        else if (change === 'path') asset.path = 'config.jsonc';
        else if (change === 'proof') asset.proof = null;
        else Object.assign(asset, { format: { version: 1 } });
        expect(() => parseManifest(bad)).toThrow('backup_invalid_manifest');
      }
      const bytes = readFileSync(join(backup.directory, path));
      writeFileSync(join(backup.directory, path), 'tampered full raw bytes');
      await expect(inspectProfileBackup(backup)).rejects.toMatchObject({
        code: 'backup_asset_mismatch',
      });
      rmSync(join(backup.directory, path));
      await expect(inspectProfileBackup(backup)).rejects.toMatchObject({
        code: 'backup_asset_missing',
      });
      writeFileSync(join(backup.directory, path), bytes, { mode: 0o600 });
      writeFileSync(join(legacy.directory, path), bytes, { mode: 0o600 });
      await expect(inspectProfileBackup(legacy)).rejects.toMatchObject({
        code: 'backup_unexpected_asset',
      });
      rmSync(join(legacy.directory, path));
    }
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect((await inspectProfileBackup(legacy)).manifest).toEqual(legacy.manifest);
  } finally {
    f.close();
  }
});

test('MCP raw assets retain private regular-file guards and cancellation never publishes a ready backup', async () => {
  for (const [path, kind] of [
    ['mcp.json', 'symlink'],
    ['mcp-approvals.json', 'hardlink'],
    ['mcp-auth-bindings.json', 'permissions'],
    ['mcp.json', 'cancel'],
  ] as const) {
    const f = await fixture();
    try {
      const original = join(f.root, 'original'),
        source = join(f.selected.profilePath, path);
      writeFileSync(original, '{}', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(original, source);
      else if (kind === 'hardlink') linkSync(original, source);
      else {
        writeFileSync(source, 'x'.repeat(2 * 1024 * 1024), { mode: 0o600 });
        if (kind === 'permissions') chmodSync(source, 0o644);
      }
      const before = databaseFiles(f.selected.databasePath),
        controller = new AbortController(),
        work = createProfileBackup({ ...f, signal: controller.signal });
      if (kind === 'cancel') controller.abort(Error('owned cancellation'));
      await expect(work).rejects.toBeDefined();
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
      expect(databaseFiles(f.selected.databasePath)).toEqual(before);
      expect(readFileSync(original, 'utf8')).toBe('{}');
    } finally {
      f.close();
    }
  }
});
