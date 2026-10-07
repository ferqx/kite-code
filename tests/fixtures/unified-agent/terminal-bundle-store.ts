import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { getLoadedSqliteEngine } from '@kite-ai/agent/sqlite-engine';

const [mode, dataRoot, workspace] = process.argv.slice(2);
assert((mode === 'prepare' || mode === 'cold') && dataRoot && workspace);
const profile = { dataRoot, profile: 'default' };
const a = await openSqliteStore({ ...profile, ...(mode === 'cold' ? { mode: 'readonly' } : {}) });
try {
  const storeId = (await a.getMetadata()).storeId;
  if (mode === 'prepare') {
    const b = await openSqliteStore(profile);
    try {
      assert.equal((await b.getMetadata()).storeId, storeId);
      await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          (index % 2 ? a : b).createWorkspace({
            expectedStoreId: storeId,
            id: `bundle-wal-${index}`,
            name: `workspace-${index}`,
            rootUri: `file://${join(workspace, `wal-${index}`)}`,
          }),
        ),
      );
      assert.equal((await b.listWorkspaces({ limit: 100 })).length, 25);
    } finally {
      await b.close();
    }
  }
  const engine = getLoadedSqliteEngine();
  assert(engine);
  console.log(
    JSON.stringify({
      storeId,
      engine,
      workspaces: (await a.listWorkspaces({ limit: 100 })).map((row) => row.id).sort(),
      session: await a.getSession('bundle-session'),
      messages: await a.listMessages('bundle-session'),
      executions: await a.listExecutions('bundle-session'),
    }),
  );
} finally {
  await a.close();
}
