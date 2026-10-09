import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { parseManifest } from '../../../src/maintenance/manifest';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import { nodeCallerAssets } from './desktop-callers-fixture';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('actual Node DB9 reuses complete original caller rows in v18 restore and never acquires cold or foreign POST authority', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-desktop-extensions-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  try {
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId;
    await store.close();
    const old = await nodeCallerAssets(root, profile, storeId);
    const path = join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite');
    const directory = join(root, 'node-extension');
    mkdirSync(directory, { mode: 0o700 });
    const source = join(directory, 'driver.ts');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(resolve('apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(resolve('apps/desktop/electron/private-data.ts'))};
import {NativeCallerJournal} from ${JSON.stringify(resolve('apps/desktop/electron/caller-journal.ts'))};
import {NativeExtensions} from ${JSON.stringify(resolve('apps/desktop/electron/extensions.ts'))};
const input=JSON.parse(process.argv[2]);
const lease=await acquireDesktopProfileAccess(input.access);
let data;let gets=0,posts=0;
try {
 data=openPrivateData(input.profilePath,lease);
 const client={serverInfo:{storeId:input.storeId,subjectId:'original_subject'},
 getView:async(id)=>{gets++;return {storeId:input.storeId,session:{id,workspaceId:'w',parentSessionId:null,deletedAt:null}}},
 getCommand:async()=>{gets++;throw Error('original_not_available')},
 invokeExtension:async()=>{posts++;throw Error('unexpected_post')}};
 const journal=new NativeCallerJournal(client,data);
 if(input.action==='seed'){
  await journal.prepare('original_session',{kind:'extension.invoke',expectedStoreId:input.storeId,commandId:'original-extension',extensionId:'example.independent',actionId:'analyze',definitionVersion:'2026.10+preview',input:{body:'雪🙂\\r\\n'.repeat(30000)+'ORIGINAL_EXTENSION_TAIL',future:{arbitrary:[null,true,3.5]}}});
  journal.releaseFirst('original-extension');
 }
 if(input.action==='cold')try{await journal.submit('original-extension')}catch{}
 if(input.action==='foreign'){
  const leaf=new NativeExtensions(client,()=>undefined,journal);
  const result=await leaf.lookup('original-extension');
  if(result.outcome!=='unknown')throw Error('foreign_became_known');
 }
 console.log(JSON.stringify({records:data.callers(),gets,posts}));
}finally{if(data)data.close();else lease.close()}
`,
      { mode: 0o600 },
    );
    expect(
      (
        await Bun.build({
          entrypoints: [source],
          target: 'node',
          packages: 'bundle',
          outdir: directory,
          naming: 'driver.js',
        })
      ).success,
    ).toBe(true);
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}', { mode: 0o600 });
    const helper = join(root, 'node-ui-fixture/profile-access-helper.js');
    async function node(action: string, id = storeId) {
      const child = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(directory, 'driver.js'),
          JSON.stringify({
            action,
            storeId: id,
            profilePath: selectProfile(profile).profilePath,
            access: {
              profile,
              bunExecutable: realpathSync(process.execPath),
              bunSha256: sha(readFileSync(process.execPath)),
              helperPath: helper,
              helperSha256: sha(readFileSync(helper)),
            },
          }),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exit !== 0) throw Error(`extension_node_failed:${stderr}`);
        return JSON.parse(stdout) as { records: typeof old.records; gets: number; posts: number };
      } finally {
        clearTimeout(timer);
      }
    }
    const seeded = await node('seed');
    expect(seeded.records).toHaveLength(6);
    expect(seeded.posts).toBe(0);
    expect(seeded.records.slice(0, 5)).toEqual(old.records);
    const extension = seeded.records.find(
      (row) => row.intent.request.commandId === 'original-extension',
    )!;
    expect(String((extension.intent.request.input as { body: string }).body)).toEndWith(
      'ORIGINAL_EXTENSION_TAIL',
    );
    const original = readFileSync(path);
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
    expect(backup.manifest.version).toBe(18);
    expect(backup.manifest.assets.desktopUi.format?.userVersion).toBe(9);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(path)).toEqual(original);
    expect(() => parseManifest({ ...backup.manifest, version: 17 })).toThrow();
    const currentStore = (
      await restoreProfileBackup({
        profile,
        expectedStoreId: storeId,
        backup,
        intent: 'replace_with_selected_backup',
      })
    ).storeId;
    expect(currentStore).not.toBe(storeId);
    const restored = readFileSync(path);
    const foreign = await node('foreign', currentStore);
    expect(foreign.posts).toBe(0);
    expect(foreign.gets).toBe(0);
    expect(foreign.records).toEqual(seeded.records);
    expect(readFileSync(path)).toEqual(restored);
    const cold = await node('cold');
    expect(cold.posts).toBe(0);
    expect(cold.gets).toBe(1);
    expect(
      cold.records.find((row) => row.intent.request.commandId === 'original-extension')!.phase,
    ).toBe('unknown');
    // Re-labeling this same row as old DB8 must not broaden its old closed caller grammar.
    const db = new Database(path);
    db.run('PRAGMA user_version=8');
    db.close(true);
    await expect(
      createProfileBackup({ profile, destinationRoot: join(root, 'relabel') }),
    ).rejects.toMatchObject({ code: 'backup_ui_invalid' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test('closed DB9 extension caller codec accepts public JSON cardinality and leaves old caller grammar closed', async () => {
  const { verifyCallerIntentRecords } = await import('../../../src/maintenance/caller-intents');
  const { canonicalJson } = await import('../../../src/json');
  const request = {
    kind: 'extension.invoke',
    commandId: 'command',
    expectedStoreId: 'store',
    extensionId: 'independent.extension',
    actionId: 'analyze',
    definitionVersion: '2026.10+preview',
    input: { values: Array.from({ length: 150000 }, () => 0) },
  };
  const { expectedStoreId: _store, commandId: _command, ...body } = request;
  const hash = (value: Parameters<typeof canonicalJson>[0]) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const row = {
    intent: {
      scope: { storeId: 'store', workspaceId: 'workspace', sessionId: 'session' },
      subjectId: 'subject',
      request,
      target: { kind: 'session', id: 'session' },
      bodyDigest: hash(request),
      requestDigest: hash(body),
    },
    phase: 'unknown',
  };
  expect(verifyCallerIntentRecords([row], false, true, true)).toBe(true);
  expect(() => verifyCallerIntentRecords([row], false, true)).toThrow();
  expect(() =>
    verifyCallerIntentRecords(
      [
        {
          ...row,
          intent: {
            ...row.intent,
            draft: { id: 'a'.repeat(64), revision: '1', textDigest: 'a'.repeat(64) },
          },
        },
      ],
      false,
      true,
      true,
    ),
  ).toThrow();
  const forged = structuredClone(row);
  forged.intent.requestDigest = 'a'.repeat(64);
  expect(() => verifyCallerIntentRecords([forged], false, true, true)).toThrow();
});
