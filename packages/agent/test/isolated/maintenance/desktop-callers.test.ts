import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  inspectProfileRestore,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import { type CallerAssetRow, nodeCallerAssets } from './desktop-callers-fixture';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function proofs(row: CallerAssetRow) {
  row.intent.bodyDigest = hash(canonicalJson(row.intent.request as Json));
  const request: Record<string, unknown> = { ...row.intent.request };
  delete request.expectedStoreId;
  delete request.commandId;
  row.intent.requestDigest = hash(canonicalJson(request as Json));
  return row;
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-native-caller-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const selected = selectProfile(profile);
  const path = join(selected.profilePath, 'desktop-private/data.sqlite');
  return {
    root,
    profile,
    storeId,
    selected,
    path,
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
function mutate(path: string, work: (db: Database) => void) {
  const db = new Database(path);
  try {
    work(db);
  } finally {
    db.close(true);
  }
}

test('actual Node DB5 keeps all five full requests and original draft/scope across v7 backup and new-Store cold read', async () => {
  const f = await fixture();
  try {
    const original = await nodeCallerAssets(f.root, f.profile, f.storeId);
    expect(original.records).toHaveLength(5);
    expect(original.httpRequests).toBe(0);
    expect(Buffer.byteLength(original.records[0]!.intent.request.content!)).toBeGreaterThan(300000);
    expect(
      original.records[0]!.intent.request.content!.endsWith('ORIGINAL_FULL_CALLER_TAIL\r\n'),
    ).toBe(true);
    const before = readFileSync(f.path);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(7);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 5,
    });
    expect(readFileSync(f.path)).toEqual(before);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    const cold = await nodeCallerAssets(f.root, f.profile, f.storeId, 'read');
    expect(cold).toEqual(original);
    expect(
      cold.records.every(
        (row) =>
          row.intent.scope.storeId === f.storeId &&
          row.intent.request.expectedStoreId === f.storeId,
      ),
    ).toBe(true);
    expect(cold.records[0]!.intent.request.extensionInputs).toEqual([
      { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
    ]);
    expect(cold.records[2]!.intent.target).toEqual({
      kind: 'after_run',
      id: null,
      contextSelectionId: 'original_context',
    });
    expect(cold.records[0]!.intent.draft).toBeDefined();
  } finally {
    f.close();
  }
});

test('Native caller rows reject wrong PK, content proofs, UTF8, phase, target and authority before ready publication', async () => {
  const f = await fixture();
  try {
    const seeded = await nodeCallerAssets(f.root, f.profile, f.storeId);
    const row = seeded.records[0]!;
    const commandId = row.intent.request.commandId;
    const change: ((row: CallerAssetRow) => void)[] = [
      (r) => {
        r.phase = 'future';
      },
      (r) => {
        r.intent.request.token = 'forged';
      },
      (r) => {
        r.intent.request.commandId = 'wrong-key';
      },
      (r) => {
        r.intent.target.id = 'wrong-session';
      },
      (r) => {
        r.intent.scope.storeId = 'wrong-store';
      },
      (r) => {
        r.intent.bodyDigest = '0'.repeat(64);
      },
      (r) => {
        r.intent.requestDigest = '0'.repeat(64);
      },
      (r) => {
        r.intent.draft!.revision = '9223372036854775808';
      },
    ];
    for (const work of change) {
      const next = structuredClone(row);
      work(next);
      mutate(f.path, (db) =>
        db
          .query('UPDATE caller_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(next), commandId),
      );
      const before = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
      expect(readFileSync(f.path)).toEqual(before);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    }
    mutate(f.path, (db) =>
      db
        .query("UPDATE caller_intents SET state=CAST(x'ff' AS TEXT) WHERE command_id=?")
        .run(commandId),
    );
    const before = readFileSync(f.path);
    expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    f.close();
  }
});

test('whole Native Journal count and full UTF8 byte capacity are checked without clipping or evicting rows', async () => {
  const f = await fixture();
  try {
    const rows = (await nodeCallerAssets(f.root, f.profile, f.storeId)).records;
    for (const capacity of ['count', 'bytes']) {
      mutate(f.path, (db) => {
        db.exec('DELETE FROM caller_intents');
        const base = rows[capacity === 'count' ? 3 : 1]!;
        for (let i = 0; i < (capacity === 'count' ? 129 : 14); i++) {
          const row = structuredClone(base);
          row.intent.request.commandId = 'capacity-' + i;
          delete row.intent.draft;
          if (capacity === 'bytes') row.intent.request.content = '🙂'.repeat(310000);
          proofs(row);
          db.query('INSERT INTO caller_intents VALUES(?,?)').run(
            row.intent.request.commandId,
            JSON.stringify(row),
          );
        }
      });
      const before = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
      expect(readFileSync(f.path)).toEqual(before);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    }
  } finally {
    f.close();
  }
});

test('a rehashed damaged Native Journal candidate cannot publish a restore or change the current Store', async () => {
  const f = await fixture();
  try {
    const original = await nodeCallerAssets(f.root, f.profile, f.storeId);
    const backup = await createProfileBackup(f);
    const path = join(backup.directory, 'desktop-private/data.sqlite');
    mutate(path, (db) => {
      const row = structuredClone(original.records[0]!);
      row.intent.bodyDigest = '0'.repeat(64);
      db.query('UPDATE caller_intents SET state=? WHERE command_id=?').run(
        JSON.stringify(row),
        row.intent.request.commandId,
      );
    });
    const bytes = readFileSync(path);
    backup.manifest.assets.desktopUi.proof = {
      sha256: hash(bytes),
      byteLength: String(bytes.length),
    };
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(backup.manifest), {
      mode: 0o600,
    });
    expect(await code(inspectProfileBackup(backup))).toBe('backup_ui_invalid');
    expect(
      await code(
        restoreProfileBackup({
          profile: f.profile,
          expectedStoreId: f.storeId,
          backup,
          intent: 'replace_with_selected_backup',
        }),
      ),
    ).toBe('backup_ui_invalid');
    expect(await inspectProfileRestore({ profile: f.profile })).toBeNull();
    const store = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await store.getMetadata()).storeId).toBe(f.storeId);
    } finally {
      await store.close();
    }
    expect(await nodeCallerAssets(f.root, f.profile, f.storeId, 'read')).toEqual(original);
  } finally {
    f.close();
  }
});

test('v2-v6 manifests retain their precise legacy UI schemas and cannot relabel current DB5', async () => {
  const f = await fixture();
  try {
    await nodeCallerAssets(f.root, f.profile, f.storeId);
    const current = await createProfileBackup(f);
    for (const version of [2, 3, 4, 5, 6] as const) {
      const manifest = structuredClone(current.manifest);
      manifest.version = version;
      if (version < 6) delete manifest.assets.fileRecoveryIntents;
      if (version === 2) delete manifest.assets.tuiRecovery;
      if (version < 4) delete manifest.assets.callerIntents;
      writeFileSync(join(current.directory, 'ready.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      expect(await code(inspectProfileBackup(current))).toBe('backup_invalid_manifest');
      manifest.assets.desktopUi.format!.userVersion =
        version === 2 ? 1 : version === 6 ? 4 : version === 5 ? 3 : 2;
      writeFileSync(join(current.directory, 'ready.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      expect(await code(inspectProfileBackup(current))).toBe('backup_asset_mismatch');
    }
    mutate(f.path, (db) => db.exec('DROP TABLE answer_intents; PRAGMA user_version=4'));
    const db4 = await createProfileBackup(f);
    expect(db4.manifest.version).toBe(6);
    expect(db4.manifest.assets.desktopUi.format!.userVersion).toBe(4);
    expect((await inspectProfileBackup(db4)).manifest).toEqual(db4.manifest);
    mutate(f.path, (db) => db.exec('DROP TABLE file_recovery_intents; PRAGMA user_version=3'));
    const db3 = await createProfileBackup(f);
    expect(db3.manifest.version).toBe(5);
    expect(db3.manifest.assets.desktopUi.format!.userVersion).toBe(3);
    expect((await inspectProfileBackup(db3)).manifest).toEqual(db3.manifest);
    mutate(f.path, (db) => db.exec('DROP TABLE caller_intents; PRAGMA user_version=2'));
    const legacy = await createProfileBackup(f);
    expect(legacy.manifest.assets.desktopUi.format!.userVersion).toBe(2);
    for (const version of [3, 4] as const) {
      const manifest = structuredClone(legacy.manifest);
      manifest.version = version;
      if (version === 3) delete manifest.assets.callerIntents;
      writeFileSync(join(legacy.directory, 'ready.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      expect((await inspectProfileBackup(legacy)).manifest).toEqual(manifest);
    }
  } finally {
    f.close();
  }
});
