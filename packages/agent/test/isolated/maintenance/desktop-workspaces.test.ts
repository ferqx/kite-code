import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let selected: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>>;
beforeAll(async () => {
  selected = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => selected?.close());
test.skipIf(process.platform !== 'darwin')(
  'actual Node DB8 unknown Workspace intent survives public v17 restore with original bytes and the cold foreign caller performs HTTP zero',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-desktop-workspaces-'));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    try {
      const store = await openSqliteStore(profile),
        storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'w',
        rootUri: `file://${root}`,
      });
      await store.close();
      const directory = join(root, 'node');
      mkdirSync(directory, { mode: 0o700 });
      for (const [entry, name, target] of [
        [
          resolve(import.meta.dir, '../../../../../apps/desktop/electron/profile-access-helper.ts'),
          'helper.js',
          'bun',
        ],
        [
          resolve(
            import.meta.dir,
            '../../../../../apps/desktop/test/workspace-removal-private.fixture.ts',
          ),
          'driver.js',
          'node',
        ],
      ] as const)
        expect(
          (
            await Bun.build({
              entrypoints: [entry],
              target,
              packages: 'bundle',
              format: 'esm',
              outdir: directory,
              naming: name,
            })
          ).success,
        ).toBe(true);
      const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      const bun = realpathSync(process.execPath),
        helper = join(directory, 'helper.js');
      async function node(action: string, id: string) {
        const child = Bun.spawn(
          [
            realpathSync(Bun.which('node')!),
            join(directory, 'driver.js'),
            JSON.stringify({
              action,
              storeId: id,
              access: {
                profile,
                bunExecutable: bun,
                bunSha256: sha(bun),
                helperPath: helper,
                helperSha256: sha(helper),
              },
            }),
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const output = new Response(child.stdout).text(),
          errors = new Response(child.stderr).text();
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        try {
          const code = await child.exited;
          if (code) console.error(await errors);
          expect(code).toBe(0);
          return JSON.parse((await output).trim());
        } finally {
          clearTimeout(timer);
        }
      }
      const original = await node('seed', storeId);
      expect(original.rows).toHaveLength(1);
      const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backups') });
      expect(backup.manifest.version).toBe(17);
      expect(backup.manifest.assets.desktopUi.format!.userVersion).toBe(8);
      const restored = await restoreProfileBackup({
        profile,
        expectedStoreId: storeId,
        backup,
        intent: 'replace_with_selected_backup',
      });
      expect(restored.storeId).not.toBe(storeId);
      const cold = await node('cold', restored.storeId);
      expect(cold.rows).toEqual(original.rows);
      expect(cold.http).toBe(0);
      // A legacy manifest cannot disguise the new physical private schema.
      const ready = join(backup.directory, 'ready.json'),
        old = readFileSync(ready, 'utf8'),
        manifest = JSON.parse(old);
      manifest.version = 16;
      writeFileSync(ready, JSON.stringify(manifest), { mode: 0o600 });
      await expect(inspectProfileBackup({ directory: backup.directory })).rejects.toThrow(
        'backup_invalid_manifest',
      );
      writeFileSync(ready, old, { mode: 0o600 });
      const db = new Database(
        join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite'),
      );
      db.run(
        "UPDATE workspace_removal_intents SET state=json_set(state,'$.request.automaticReplay',json('true'))",
      );
      db.close();
      await expect(
        createProfileBackup({ profile, destinationRoot: join(root, 'invalid') }),
      ).rejects.toThrow('backup_ui_invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
