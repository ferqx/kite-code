import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import { nodeConfigurationAssets } from './desktop-configurations-fixture';

async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-db6-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  return {
    root,
    profile,
    storeId,
    path: join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite'),
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

test('actual Node DB6 and manifest v14 preserve original configuration GETs, Session routes and full effort requests across new-Store restore', async () => {
  const f = await fixture();
  try {
    const original = await nodeConfigurationAssets(f.root, f.profile, f.storeId);
    expect(original.configurations).toHaveLength(2);
    expect(original.callers).toHaveLength(7);
    expect(original.httpRequests).toBe(0);
    expect(original.originalRoute).toBe('original_model');
    expect(original.otherRoute).toBe('other_model');
    expect(
      original.callers
        .filter((row) => row.intent.request.reasoningEffort)
        .map((row) => row.intent.request.reasoningEffort)
        .sort(),
    ).toEqual(['high', 'minimal']);
    expect(JSON.stringify(original.configurations)).not.toContain('secret');
    expect(JSON.stringify(original.configurations)).not.toContain('reasoningEffort');
    const before = readFileSync(f.path);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(14);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 6,
    });
    expect(readFileSync(f.path)).toEqual(before);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(f.path)).toEqual(before);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    const cold = await nodeConfigurationAssets(
      f.root,
      f.profile,
      f.storeId,
      'read',
      restored.storeId,
    );
    expect(cold).toEqual({ ...original, currentRoute: null });
    expect(cold.configurations[1]!.input.expectedStoreId).toBe(f.storeId);
    const ready = join(backup.directory, 'ready.json');
    writeFileSync(ready, JSON.stringify({ ...backup.manifest, version: 13 }), { mode: 0o600 });
    expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
  } finally {
    f.close();
  }
}, 30000);

test('DB6 rejects secret-bearing original metadata, invalid UTF8 and route authority before ready publication without changing source bytes', async () => {
  const f = await fixture();
  try {
    await nodeConfigurationAssets(f.root, f.profile, f.storeId);
    const good = readFileSync(f.path);
    const changes = [
      (db: Database) => {
        const value = JSON.parse(
          db
            .query<{ state: string }, []>(
              "SELECT state FROM configuration_intents WHERE command_id='provider-original'",
            )
            .get()!.state,
        );
        value.input.operation.provider = ['compatible'];
        value.input.operation.credential = ['replace'];
        value.state.operation = value.input.operation;
        value.state.phase = ['unknown'];
        value.state.credentialState = ['outcome_unknown'];
        db.query(
          "UPDATE configuration_intents SET state=? WHERE command_id='provider-original'",
        ).run(JSON.stringify(value));
      },
      (db: Database) => {
        const value = JSON.parse(
          db
            .query<{ state: string }, []>(
              "SELECT state FROM caller_intents WHERE command_id='effort-run-start'",
            )
            .get()!.state,
        );
        value.intent.request.reasoningEffort = ['high'];
        const sha = (input: Json) =>
          createHash('sha256').update(canonicalJson(input)).digest('hex');
        value.intent.bodyDigest = sha(value.intent.request);
        const request = { ...value.intent.request };
        delete request.expectedStoreId;
        delete request.commandId;
        value.intent.requestDigest = sha(request);
        db.query("UPDATE caller_intents SET state=? WHERE command_id='effort-run-start'").run(
          JSON.stringify(value),
        );
      },
      (db: Database) => {
        const row = db
          .query<{ state: string }, []>(
            "SELECT state FROM configuration_intents WHERE command_id='provider-original'",
          )
          .get()!;
        const value = JSON.parse(row.state);
        value.input.secret = 'forbidden';
        db.query(
          "UPDATE configuration_intents SET state=? WHERE command_id='provider-original'",
        ).run(JSON.stringify(value));
      },
      (db: Database) =>
        db.run(
          "UPDATE configuration_intents SET state=CAST(X'80' AS TEXT) WHERE command_id='provider-original'",
        ),
      (db: Database) => db.run("UPDATE model_routes SET store_id='forged/store'"),
    ];
    for (const change of changes) {
      writeFileSync(f.path, good);
      mutate(f.path, change);
      const damaged = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
      expect(readFileSync(f.path)).toEqual(damaged);
      expect(
        existsSync(f.destinationRoot)
          ? readdirSync(f.destinationRoot).filter((name) => !name.startsWith('.'))
          : [],
      ).toEqual([]);
    }
  } finally {
    f.close();
  }
}, 30000);
