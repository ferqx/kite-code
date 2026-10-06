import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import { configBytes, nodeAssets, seedAssets, seedRecoveryAsset } from './assets-fixture';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-maintenance-assets-'),
    profile = { dataRoot: join(root, 'data'), profile: 'assets' },
    store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const selected = selectProfile(profile);
  return {
    root,
    profile,
    selected,
    storeId,
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function reject(work: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  if (code) expect((error as { code?: string }).code).toBe(code);
}

test('raw private config capture preserves comments, unknown and credential reference bytes including malformed JSONC; no vault or imaginary TUI asset', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from(
      '\ufeff// private raw original\n{"unknown":{"apiKey":"raw-private-fixture"},"credentialRef":"credential:01234567-1234-1234-1234-012345678901",\n',
    );
    writeFileSync(join(f.selected.profilePath, 'config.jsonc'), bytes, { mode: 0o600 });
    writeFileSync(join(f.selected.profilePath, 'credentials'), 'never copy', { mode: 0o600 });
    mkdirSync(join(f.selected.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(f.selected.profilePath, 'ui', 'unrelated.txt'), 'uncollected', {
      mode: 0o600,
    });
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(5);
    expect(backup.manifest.excluded).toEqual([
      'credentials',
      'credential_vault',
      'uncollected_host_private_files',
      'coordination',
      'locks',
    ]);
    expect(backup.manifest.assets.configuration.present).toBe(true);
    expect(backup.manifest.assets.configuration.proof?.byteLength).toBe(String(bytes.length));
    expect(Number.isFinite(Date.parse(backup.manifest.assets.configuration.capturedAt))).toBe(true);
    expect(backup.manifest.assets.desktopUi.present).toBe(false);
    expect(backup.manifest.assets.desktopUi.format).toBeNull();
    expect(backup.manifest.assets.tuiUi.present).toBe(false);
    expect(backup.manifest.assets.tuiUi.path).toBe('ui/tui.json');
    expect(backup.manifest.assets.tuiUi.format).toBeNull();
    expect(backup.manifest.assets.vaultExcluded).toBe(true);
    expect(backup.manifest.assets.configurationMayContainSensitiveContent).toBe(true);
    expect(readFileSync(join(backup.directory, 'config.jsonc'))).toEqual(bytes);
    expect(existsSync(join(backup.directory, 'credentials'))).toBe(false);
    expect(existsSync(join(backup.directory, 'ui'))).toBe(false);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    writeFileSync(join(f.selected.profilePath, 'config.jsonc'), 'later', { mode: 0o600 });
    const result = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(result.storeId).not.toBe(f.storeId);
    expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(bytes);
    expect(readFileSync(join(result.preservedDirectory, 'config.jsonc'), 'utf8')).toBe('later');
    expect(existsSync(join(f.selected.profilePath, 'credentials'))).toBe(false);
    const readyPath = join(backup.directory, 'ready.json'),
      ready = readFileSync(readyPath);
    const invalid = JSON.parse(ready.toString());
    invalid.excluded = invalid.excluded.filter((item: string) => item !== 'credential_vault');
    writeFileSync(readyPath, JSON.stringify(invalid));
    await reject(inspectProfileBackup(backup), 'backup_invalid_manifest');
    writeFileSync(readyPath, ready);
    writeFileSync(join(backup.directory, 'config.jsonc'), 'tampered');
    await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
    rmSync(join(backup.directory, 'config.jsonc'));
    await reject(inspectProfileBackup(backup), 'backup_asset_missing');
  } finally {
    f.close();
  }
});
test('asset links, public permissions and cancellation cannot publish a ready backup', async () => {
  for (const kind of ['symlink', 'hardlink', 'permissions', 'cancel'] as const) {
    const f = await fixture();
    try {
      const path = join(f.selected.profilePath, 'config.jsonc'),
        original = join(f.root, 'original');
      writeFileSync(original, '{}', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(original, path);
      else if (kind === 'hardlink') linkSync(original, path);
      else {
        writeFileSync(path, 'x'.repeat(2 * 1024 * 1024), { mode: 0o600 });
        if (kind === 'permissions') chmodSync(path, 0o644);
      }
      const controller = new AbortController();
      const work = createProfileBackup({ ...f, signal: controller.signal });
      if (kind === 'cancel') setTimeout(() => controller.abort(Error('owned cancellation')), 1);
      await reject(work);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
      expect(readFileSync(original, 'utf8')).toBe('{}');
    } finally {
      f.close();
    }
  }
});
test('unknown or damaged private UI format and SQL journal fail closed', async () => {
  for (const kind of ['schema', 'application', 'version', 'damaged', 'journal'] as const) {
    const f = await fixture();
    try {
      await seedAssets(f.root, f.profile, f.storeId);
      const parent = join(f.selected.profilePath, 'desktop-private');
      const path = join(parent, 'data.sqlite');
      const db = new Database(path);
      if (kind === 'schema') db.exec('CREATE TABLE unexpected(id TEXT);');
      if (kind === 'application') db.exec('PRAGMA application_id=123;');
      if (kind === 'version') db.exec('PRAGMA user_version=7;');
      db.close(true);
      if (kind === 'damaged') writeFileSync(path, 'not sqlite');
      if (kind === 'journal') writeFileSync(`${path}-journal`, 'owned incomplete', { mode: 0o600 });
      const before = readFileSync(path);
      await reject(createProfileBackup(f));
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    } finally {
      f.close();
    }
  }
});

test('actual Node private UI snapshot and cold restored reader preserve 133 drafts and unknown creation original Store identities', async () => {
  const f = await fixture();
  try {
    const seeded = await seedAssets(f.root, f.profile, f.storeId);
    expect(seeded.count).toBe(133);
    const before = readFileSync(join(f.selected.profilePath, 'desktop-private/data.sqlite'));
    const recoveryBytes = readFileSync(join(f.selected.profilePath, 'ui/recovery.json'));
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.desktopUi.present).toBe(true);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 5,
    });
    expect(Number.isFinite(Date.parse(backup.manifest.assets.desktopUi.capturedAt))).toBe(true);
    expect(readFileSync(join(f.selected.profilePath, 'desktop-private/data.sqlite'))).toEqual(
      before,
    );
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(readFileSync(join(f.selected.profilePath, 'ui/recovery.json'))).toEqual(recoveryBytes);
    expect(backup.manifest.assets.tuiRecovery).toMatchObject({
      path: 'ui/recovery.json',
      present: true,
      format: { version: 1 },
    });
    expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(configBytes);
    expect(await nodeAssets(f.root, f.profile, f.storeId, 'read')).toEqual(seeded);
    expect(seeded.creations[0]?.phase).toBe('unknown');
    expect(seeded.creations[0]?.input.expectedStoreId).toBe(f.storeId);
    expect(seeded.recoveries).toEqual([
      {
        observationId: 1,
        storeId: f.storeId,
        sessionId: 's',
        kind: 'run',
        targetId: 'original-run',
        originalCommandId: 'original-work',
        commandId: 'original-recovery',
        phase: 'outcome_unknown',
      },
    ]);
    const extra = join(backup.directory, 'desktop-private', 'unlisted');
    writeFileSync(extra, 'unlisted', { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_unexpected_asset');
    rmSync(extra);
    const path = join(backup.directory, 'desktop-private/data.sqlite');
    const db = new Database(path);
    db.query('UPDATE drafts SET content=?').run(JSON.stringify('tampered'));
    db.close(true);
    await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
    rmSync(path);
    await reject(inspectProfileBackup(backup), 'backup_asset_missing');
  } finally {
    f.close();
  }
});

test('cleanly closed actual private UI and Core backup/inspect preserve complete source bytes and absent WAL/SHM', async () => {
  const f = await fixture();
  let writer: Database | undefined;
  try {
    await seedAssets(f.root, f.profile, f.storeId);
    const path = join(f.selected.profilePath, 'desktop-private/data.sqlite');
    writer = new Database(path);
    writer.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;');
    const content = JSON.stringify('closed private UI original 🙂\r\n完整尾部');
    writer.query('UPDATE drafts SET content=? WHERE root_session_id=?').run(content, 'root-132');
    writer.close(true);
    writer = undefined;
    const originals = [path, f.selected.databasePath].map((databasePath) => ({
      path: databasePath,
      bytes: readFileSync(databasePath),
    }));
    const unchanged = () => {
      for (const original of originals) {
        expect(readFileSync(original.path)).toEqual(original.bytes);
        expect(existsSync(`${original.path}-wal`)).toBe(false);
        expect(existsSync(`${original.path}-shm`)).toBe(false);
      }
    };
    unchanged();
    const backup = await createProfileBackup(f);
    unchanged();
    expect(backup.manifest.source.storeId).toBe(f.storeId);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 5,
    });
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    unchanged();
    const candidate = new Database(join(backup.directory, 'desktop-private/data.sqlite'), {
      readonly: true,
    });
    try {
      expect(candidate.query('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 133 });
      expect(
        candidate
          .query(
            'SELECT store_id,workspace_id,root_session_id,content FROM drafts WHERE root_session_id=?',
          )
          .get('root-132'),
      ).toEqual({
        store_id: f.storeId,
        workspace_id: 'w',
        root_session_id: 'root-132',
        content,
      });
      expect(
        candidate
          .query('SELECT phase,input FROM creations WHERE command_id=?')
          .get('unknown-create'),
      ).toEqual({
        phase: 'unknown',
        input: JSON.stringify({
          commandId: 'unknown-create',
          expectedStoreId: f.storeId,
          workspaceId: 'w',
          sessionId: 'creation-original',
          title: 'original intent',
        }),
      });
    } finally {
      candidate.close(true);
    }
    unchanged();
    const checkPublished = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        expect(entry.name.startsWith('.')).toBe(false);
        expect(entry.name.includes('scratch')).toBe(false);
        expect(/-(wal|shm)$/.test(entry.name)).toBe(false);
        if (entry.isDirectory()) checkPublished(join(directory, entry.name));
      }
    };
    checkPublished(backup.directory);
    expect(readdirSync(f.destinationRoot)).toEqual([backup.directory.split('/').at(-1)!]);
  } finally {
    writer?.close(true);
    f.close();
  }
}, 30000);

test('private UI snapshot includes WAL facts without changing original DB or WAL bytes', async () => {
  const f = await fixture();
  let writer: Database | undefined;
  try {
    await seedAssets(f.root, f.profile, f.storeId);
    const path = join(f.selected.profilePath, 'desktop-private/data.sqlite');
    writer = new Database(path);
    writer.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;');
    writer
      .query('UPDATE drafts SET content=? WHERE root_session_id=?')
      .run(JSON.stringify('wal-only UI tail'), 'root-132');
    const before = readFileSync(path),
      wal = readFileSync(`${path}-wal`);
    const backup = await createProfileBackup(f);
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(`${path}-wal`)).toEqual(wal);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const candidate = new Database(join(backup.directory, 'desktop-private/data.sqlite'), {
      readonly: true,
    });
    try {
      expect(
        candidate.query('SELECT content FROM drafts WHERE root_session_id=?').get('root-132'),
      ).toEqual({ content: JSON.stringify('wal-only UI tail') });
      expect(candidate.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally {
      candidate.close(true);
    }
  } finally {
    writer?.close(true);
    f.close();
  }
});

test('private UI file hardlink, symlink and public parent refuse collection without a ready candidate', async () => {
  for (const kind of ['hardlink', 'symlink', 'parent'] as const) {
    const f = await fixture();
    try {
      await seedAssets(f.root, f.profile, f.storeId);
      const parent = join(f.selected.profilePath, 'desktop-private'),
        path = join(parent, 'data.sqlite'),
        outside = join(f.root, 'ui-original');
      const before = readFileSync(path);
      writeFileSync(outside, before, { mode: 0o600 });
      if (kind === 'parent') chmodSync(parent, 0o755);
      else {
        rmSync(path);
        if (kind === 'hardlink') linkSync(outside, path);
        else symlinkSync(outside, path);
      }
      await reject(createProfileBackup(f));
      expect(readFileSync(outside)).toEqual(before);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    } finally {
      f.close();
    }
  }
});

test('TUI exact unsent text and original scope are independently proven; closed format, tamper, missing and extra UI assets fail', async () => {
  const f = await fixture();
  try {
    const { seedTuiAsset, tuiText } = await import('./assets-fixture');
    seedTuiAsset(f.profile, f.storeId);
    const path = join(f.selected.profilePath, 'ui', 'tui.json'),
      bytes = readFileSync(path);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.tuiUi).toMatchObject({
      path: 'ui/tui.json',
      present: true,
      format: { version: 1 },
      proof: { byteLength: String(bytes.length) },
    });
    expect(Number.isFinite(Date.parse(backup.manifest.assets.tuiUi.capturedAt))).toBe(true);
    expect(readFileSync(join(backup.directory, 'ui', 'tui.json'))).toEqual(bytes);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    writeFileSync(path, 'broken', { mode: 0o600 });
    const result = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(join(result.preservedDirectory, 'ui', 'tui.json'), 'utf8')).toBe('broken');
    const restored = JSON.parse(readFileSync(path, 'utf8'));
    expect(restored.drafts[0].storeId).toBe(f.storeId);
    expect(restored.drafts[0].text).toBe(tuiText);
    const saved = join(backup.directory, 'ui', 'tui.json');
    writeFileSync(saved, 'tampered');
    await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
    rmSync(saved);
    await reject(inspectProfileBackup(backup), 'backup_asset_missing');
    writeFileSync(saved, bytes, { mode: 0o600 });
    writeFileSync(join(backup.directory, 'ui', 'unexpected'), 'not captured', { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_unexpected_asset');
    for (const invalid of [
      Buffer.from('{broken'),
      Buffer.from(JSON.stringify({ ...restored, version: 2 })),
      Buffer.from(
        JSON.stringify({ ...restored, drafts: [{ ...restored.drafts[0], id: '0'.repeat(64) }] }),
      ),
    ]) {
      writeFileSync(path, invalid);
      await reject(createProfileBackup(f), 'backup_tui_invalid');
      expect(readFileSync(path)).toEqual(invalid);
    }
    writeFileSync(path, bytes);
    const alias = join(f.root, 'tui-alias');
    linkSync(path, alias);
    await reject(createProfileBackup(f), 'backup_access_denied');
    rmSync(alias);
    rmSync(path);
    symlinkSync(join(f.root, 'missing-ui'), path);
    await reject(createProfileBackup(f));
    rmSync(path);
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(join(f.selected.profilePath, 'ui'), 0o755);
    await reject(createProfileBackup(f), 'backup_access_denied');
    chmodSync(join(f.selected.profilePath, 'ui'), 0o700);
    const controller = new AbortController();
    controller.abort();
    await reject(createProfileBackup({ ...f, signal: controller.signal }));
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    f.close();
  }
});

test('real TUI preference JSONC is an exact raw-byte asset, including corruption; restore excludes all other private UI files', async () => {
  const f = await fixture();
  try {
    const ui = join(f.selected.profilePath, 'ui');
    mkdirSync(ui, { mode: 0o700 });
    const path = join(ui, 'preferences.jsonc');
    const bytes = Buffer.from(
      '\ufeff// original preference comments\n{"language":"zh-CN","colorPreset":"purple","theme":"light","future":{"raw":true},\n',
    );
    writeFileSync(path, bytes, { mode: 0o600 });
    writeFileSync(join(ui, 'private-other.json'), 'uncollected', { mode: 0o600 });
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.tuiPreferences).toMatchObject({
      path: 'ui/preferences.jsonc',
      present: true,
      proof: { byteLength: String(bytes.length) },
    });
    expect(backup.manifest.assets.tuiUi.present).toBe(false);
    expect(readFileSync(join(backup.directory, 'ui/preferences.jsonc'))).toEqual(bytes);
    expect(existsSync(join(backup.directory, 'ui/private-other.json'))).toBe(false);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    writeFileSync(path, '{"language":"en-US"}', { mode: 0o600 });
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.outcome).toBe('restored');
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(join(ui, 'private-other.json'))).toBe(false);
    expect(existsSync(join(ui, 'tui.json'))).toBe(false);
    writeFileSync(join(backup.directory, 'ui/preferences.jsonc'), 'tampered', { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
  } finally {
    f.close();
  }
});

test('preference asset is closed and private; absence never creates a preference file or accepts an unlisted UI asset', async () => {
  const f = await fixture();
  try {
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.tuiPreferences).toMatchObject({
      path: 'ui/preferences.jsonc',
      present: false,
      proof: null,
    });
    expect(existsSync(join(backup.directory, 'ui'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(backup.directory, 'ready.json'), 'utf8'));
    delete manifest.assets.tuiPreferences;
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(manifest), { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_invalid_manifest');
    const ui = join(f.selected.profilePath, 'ui');
    mkdirSync(ui, { mode: 0o700 });
    const path = join(ui, 'preferences.jsonc');
    const outside = join(f.root, 'outside');
    writeFileSync(outside, '{}', { mode: 0o600 });
    symlinkSync(outside, path);
    await reject(createProfileBackup(f));
    expect(readFileSync(outside, 'utf8')).toBe('{}');
    rmSync(path);
    linkSync(outside, path);
    await reject(createProfileBackup(f));
    rmSync(path);
    writeFileSync(path, '{}', { mode: 0o644 });
    await reject(createProfileBackup(f));
    expect(readFileSync(path, 'utf8')).toBe('{}');
  } finally {
    f.close();
  }
});

test('Workflow flags preserve exact JSONC bytes including malformed input through backup and restore without enabling or parsing them', async () => {
  for (const bytes of [
    Buffer.from('// comments\n{"skillActivation":false,"unknown":{"keep":true}}\n'),
    Buffer.from('\ufeff// malformed flags\n{"skillWorkflow":true,"unknown":'),
  ]) {
    const f = await fixture();
    try {
      const path = join(f.selected.profilePath, 'skill-workflow.jsonc');
      writeFileSync(path, bytes, { mode: 0o600 });
      writeFileSync(join(f.selected.profilePath, 'unlisted-workflow.jsonc'), 'private', {
        mode: 0o600,
      });
      const backup = await createProfileBackup(f);
      expect(backup.manifest.assets.skillWorkflowConfiguration).toMatchObject({
        path: 'skill-workflow.jsonc',
        present: true,
        proof: { byteLength: String(bytes.length) },
      });
      expect(readFileSync(join(backup.directory, 'skill-workflow.jsonc'))).toEqual(bytes);
      expect(existsSync(join(backup.directory, 'unlisted-workflow.jsonc'))).toBe(false);
      expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
      writeFileSync(path, 'later flags', { mode: 0o600 });
      const restored = await restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      });
      expect(readFileSync(path)).toEqual(bytes);
      expect(readFileSync(join(restored.preservedDirectory, 'skill-workflow.jsonc'), 'utf8')).toBe(
        'later flags',
      );
      expect(existsSync(join(f.selected.profilePath, 'unlisted-workflow.jsonc'))).toBe(false);
      writeFileSync(join(backup.directory, 'skill-workflow.jsonc'), 'tampered');
      await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
    } finally {
      f.close();
    }
  }
});

test('Workflow asset absence and closed manifest reject forged paths, missing field, proofs and unlisted bytes', async () => {
  const f = await fixture();
  try {
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.skillWorkflowConfiguration).toMatchObject({
      path: 'skill-workflow.jsonc',
      present: false,
      proof: null,
    });
    const ready = join(backup.directory, 'ready.json');
    const original = readFileSync(ready);
    for (const alter of [
      (manifest: { assets: Record<string, { path: string; proof: unknown }> }) => {
        delete manifest.assets.skillWorkflowConfiguration;
      },
      (manifest: { assets: Record<string, { path: string; proof: unknown }> }) => {
        manifest.assets.skillWorkflowConfiguration!.path = '../outside';
      },
      (manifest: { assets: Record<string, { path: string; proof: unknown }> }) => {
        manifest.assets.skillWorkflowConfiguration!.proof = {
          sha256: 'a'.repeat(64),
          byteLength: '0',
        };
      },
    ]) {
      const manifest = JSON.parse(original.toString());
      alter(manifest);
      writeFileSync(ready, JSON.stringify(manifest));
      await reject(inspectProfileBackup(backup), 'backup_invalid_manifest');
    }
    writeFileSync(ready, original);
    const path = join(f.selected.profilePath, 'skill-workflow.jsonc');
    writeFileSync(path, 'later flags', { mode: 0o600 });
    await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(existsSync(path)).toBe(false);
    writeFileSync(join(backup.directory, 'skill-workflow.jsonc'), '{}', { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_asset_missing');
  } finally {
    f.close();
  }
});

test('Workflow configuration capture rejects links and nonprivate files without changing the source', async () => {
  const f = await fixture();
  try {
    const path = join(f.selected.profilePath, 'skill-workflow.jsonc');
    const outside = join(f.root, 'outside');
    writeFileSync(outside, '// raw', { mode: 0o600 });
    symlinkSync(outside, path);
    await reject(createProfileBackup(f));
    rmSync(path);
    linkSync(outside, path);
    await reject(createProfileBackup(f));
    rmSync(path);
    writeFileSync(path, '// raw', { mode: 0o644 });
    await reject(createProfileBackup(f));
    expect(readFileSync(outside, 'utf8')).toBe('// raw');
    expect(readFileSync(path, 'utf8')).toBe('// raw');
  } finally {
    f.close();
  }
});

test('Desktop current recovery fields and declared actual format are closed; legacy v1 backup stays precisely readable', async () => {
  const f = await fixture();
  try {
    await seedAssets(f.root, f.profile, f.storeId);
    const backup = await createProfileBackup(f);
    const forged = structuredClone(backup.manifest);
    forged.assets.desktopUi.format!.userVersion = 1;
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(forged), { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_asset_mismatch');
    const path = join(f.selected.profilePath, 'desktop-private/data.sqlite');
    let db = new Database(path);
    const row = db.query<{ state: string }, []>('SELECT state FROM recovery_intents').get()!;
    db.query('UPDATE recovery_intents SET state=?').run(
      JSON.stringify({ ...JSON.parse(row.state), runtime: 'forged' }),
    );
    db.close(true);
    const bytes = readFileSync(path);
    await reject(createProfileBackup(f), 'backup_ui_invalid');
    expect(readFileSync(path)).toEqual(bytes);
    db = new Database(path);
    db.exec(
      'DROP TABLE answer_intents; DROP TABLE recovery_intents; DROP TABLE caller_intents; DROP TABLE file_recovery_intents; PRAGMA user_version=1',
    );
    db.close(true);
    rmSync(join(f.selected.profilePath, 'ui/recovery.json'));
    const legacy = await createProfileBackup(f);
    expect(legacy.manifest.assets.desktopUi.format?.userVersion).toBe(1);
    const v2 = structuredClone(legacy.manifest);
    v2.version = 2;
    delete v2.assets.tuiRecovery;
    delete v2.assets.callerIntents;
    writeFileSync(join(legacy.directory, 'ready.json'), JSON.stringify(v2), { mode: 0o600 });
    expect((await inspectProfileBackup(legacy)).manifest).toEqual(v2);
    v2.assets.tuiRecovery = {
      path: 'ui/recovery.json',
      capturedAt: new Date().toISOString(),
      present: false,
      proof: null,
      format: null,
    };
    writeFileSync(join(legacy.directory, 'ready.json'), JSON.stringify(v2), { mode: 0o600 });
    await reject(inspectProfileBackup(legacy), 'backup_invalid_manifest');
  } finally {
    f.close();
  }
});
test('actual CLI pending journal is backed up as original bytes and rejects malformed scope, authority, duplicates and links', async () => {
  for (const kind of [
    'phase',
    'authority',
    'duplicate',
    'version',
    'overlong',
    'hardlink',
    'symlink',
  ]) {
    const f = await fixture();
    try {
      await seedRecoveryAsset(f.profile, f.storeId);
      const path = join(f.selected.profilePath, 'ui/recovery.json');
      const original = readFileSync(path);
      const doc = JSON.parse(original.toString());
      if (kind === 'phase') doc.records[0].phase = ['submitting'];
      if (kind === 'authority') doc.records[0].intent.request.runtime = 'forged';
      if (kind === 'duplicate') doc.records.push(doc.records[0]);
      if (kind === 'version') doc.version = 2;
      if (kind === 'overlong') doc.records = Array(129).fill(doc.records[0]);
      if (kind === 'hardlink') linkSync(path, join(f.root, 'alias'));
      else if (kind === 'symlink') {
        rmSync(path);
        writeFileSync(join(f.root, 'original'), original, { mode: 0o600 });
        symlinkSync(join(f.root, 'original'), path);
      } else writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
      const bytes = readFileSync(path);
      await reject(createProfileBackup(f));
      expect(readFileSync(path)).toEqual(bytes);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    } finally {
      f.close();
    }
  }
});
