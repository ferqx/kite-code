import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, preflightSqliteStore } from '@kite-ai/agent/sqlite';
import {
  initializeDefaultSqliteEngine,
  initializeSqliteEngine,
} from '@kite-ai/agent/sqlite-engine';

const [root, manifestSha256, data] = process.argv.slice(2);
assert(root && manifestSha256 && data);
initializeSqliteEngine({ root, manifestSha256 });
assert.equal(initializeDefaultSqliteEngine().qualification, 'selected');
const profile = { dataRoot: data, profile: 'patched' };
const a = await openSqliteStore(profile),
  b = await openSqliteStore(profile);
try {
  const storeId = (await a.getMetadata()).storeId;
  assert.equal((await b.getMetadata()).storeId, storeId);
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      (i % 2 ? a : b).createWorkspace({
        expectedStoreId: storeId,
        id: `w-${i}`,
        name: `workspace-${i}`,
        rootUri: `file://${join(data, `w-${i}`)}`,
      }),
    ),
  );
  assert.equal((await a.listWorkspaces({ limit: 100 })).length, 24);
  assert.equal((await b.listWorkspaces({ limit: 100 })).length, 24);
} finally {
  await b.close();
  await a.close();
}
assert.equal((await preflightSqliteStore(profile)).status, 'compatible');
const source = await openSqliteStore({ ...profile, mode: 'readonly' });
const oldId = (await source.getMetadata()).storeId;
await source.close();
const backupRoot = join(data, 'backups');
mkdirSync(backupRoot, { mode: 0o700 });
const backup = await createProfileBackup({ profile, destinationRoot: backupRoot });
assert.equal(backup.manifest.engine.version, '3.51.3');
assert.equal(
  backup.manifest.engine.sourceId,
  '2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618',
);
await restoreProfileBackup({
  profile,
  backup,
  expectedStoreId: oldId,
  intent: 'replace_with_selected_backup',
});
const restored = await openSqliteStore({ ...profile, mode: 'readonly' });
try {
  assert.notEqual((await restored.getMetadata()).storeId, oldId);
  assert.equal((await restored.listWorkspaces({ limit: 100 })).length, 24);
} finally {
  await restored.close();
}
console.log(
  JSON.stringify({
    publicStores: 2,
    walWrites: 24,
    backupEngine: backup.manifest.engine,
    restored: true,
    readonlyCold: true,
  }),
);
