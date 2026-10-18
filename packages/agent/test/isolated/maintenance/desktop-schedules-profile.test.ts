import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import { matchingSchema } from '../../../src/storage/sqlite/migrations';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
test('actual Node DB10 backup restores exact original bindings and foreign Store runner issues zero requests', async () => {
  const qualified = await prepareQualifiedSqliteFixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-schedule-profile-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'schedule' };
  try {
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Original workspace',
    });
    await store.createSession({
      expectedStoreId: storeId,
      sessionId: 'core-session',
      workspaceId: 'workspace',
      commandId: 'core-create',
      subjectId: 'owner',
      title: 'Original scheduled work',
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      sessionId: 'core-session',
      commandId: 'core-start',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Original task' },
    });
    const owner = (await store.acquireSessionOwner('core-session', 'original'))!;
    const coreRun = await store.startRun({
      expectedStoreId: storeId,
      owner,
      commandId: 'core-start',
      configuration: { modelId: 'model' },
    });
    await store.planExecution({
      expectedStoreId: storeId,
      owner,
      executionId: 'core-planned',
      sessionId: 'core-session',
      runId: coreRun.id,
      originCommandId: 'core-start',
      stepId: 'original-step',
      callId: 'original-call',
      kind: 'tool',
      definitionId: 'fixture/tool',
      definitionVersion: '1',
      input: {},
      decisionSource: { kind: 'model_decision', modelExecutionId: 'original-model' },
    });
    await store.close();
    const helper = join(root, 'profile-access-helper.js');
    expect(
      (
        await Bun.build({
          entrypoints: [resolve('apps/desktop/electron/profile-access-helper.ts')],
          target: 'bun',
          packages: 'bundle',
          outdir: root,
          naming: 'profile-access-helper.js',
        })
      ).success,
    ).toBe(true);
    const source = join(root, 'driver.ts');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(resolve('apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(resolve('apps/desktop/electron/private-data.ts'))};
import {ScheduledTaskRunner} from ${JSON.stringify(resolve('apps/desktop/electron/scheduled-task-runner.ts'))};
const input=JSON.parse(process.argv[2]);const lease=await acquireDesktopProfileAccess(input.access);let data;
try {data=openPrivateData(input.profilePath,lease);
if(input.action==='seed') {
 data.saveScheduledTask({id:'daily',name:'Daily review',prompt:'Original é🙂 task',workspaceId:'workspace',modelId:'model',storeId:input.storeId,enabled:true,schedule:{frequency:'daily',time:'09:00',timeZone:'UTC'}},0);
 const run=data.claimScheduledTask('daily',Date.parse('2026-10-14T12:00Z'),{storeId:input.storeId});
 data.updateScheduledTaskRun(run.id,{status:'unknown'});
 data.saveScheduledTask({id:'unclaimed',name:'Unclaimed',prompt:'No restored automatic authority',workspaceId:'workspace',modelId:'model',storeId:input.storeId,enabled:true,schedule:{frequency:'daily',time:'09:00',timeZone:'UTC'}},0);
}
let requests=0;let manualBlocked=false;
if(input.action==='foreign'){
 const client=new Proxy({serverInfo:{storeId:input.storeId,subjectId:'subject'}},{get(target,key){if(key==='serverInfo')return target.serverInfo;return async()=>{requests++;throw Error('unexpected_service_request')};}});
 const runner=new ScheduledTaskRunner(client,data,{clock:{now:()=>Date.parse('2026-10-15T12:00Z'),setTimeout:()=>0,clearTimeout:()=>{}}});
 runner.start();await runner.tick();await runner.stop();
 try{await runner.runNow('unclaimed')}catch{manualBlocked=true;}
}
if(input.action==='rebind') {
 const client={serverInfo:{storeId:input.storeId},listWorkspaces:async()=>[{id:'workspace'}],getModelSettings:async()=>({models:[{id:'model',enabled:true,configured:true}]})};
 const runner=new ScheduledTaskRunner(client,data,{clock:{now:()=>Date.parse('2026-10-15T08:00Z'),setTimeout:()=>0,clearTimeout:()=>{}}});
 const {nextRunAt,createdAt,updatedAt,...task}=data.scheduledTasks().find(t=>t.id==='daily');
 await runner.save({...task,storeId:input.storeId});
 const run=data.claimScheduledTask('daily',Date.parse('2026-10-15T09:00Z'),{storeId:input.storeId});
 if(!run)throw Error('rebound_claim_blocked');
}
console.log(JSON.stringify({tasks:data.scheduledTasks(),runs:data.scheduledTaskRuns(),requests,manualBlocked}));
}finally{if(data)data.close();else lease.close();}
`,
      { mode: 0o600 },
    );
    expect(
      (
        await Bun.build({
          entrypoints: [source],
          target: 'node',
          packages: 'bundle',
          outdir: root,
          naming: 'driver.mjs',
        })
      ).success,
    ).toBe(true);
    const profilePath = selectProfile(profile).profilePath,
      path = join(profilePath, 'desktop-private/data.sqlite');
    async function node(action: string, id: string) {
      const child = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.mjs'),
          JSON.stringify({
            action,
            storeId: id,
            profilePath,
            access: {
              profile,
              bunExecutable: realpathSync(process.execPath),
              bunSha256: sha(process.execPath),
              helperPath: helper,
              helperSha256: sha(helper),
            },
          }),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      try {
        const [exit, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exit !== 0) throw Error(`node_schedule_failed:${err}`);
        return JSON.parse(out);
      } finally {
        clearTimeout(timer);
      }
    }
    const seeded = await node('seed', storeId),
      original = readFileSync(path);
    const corePath = selectProfile(profile).databasePath;
    const sourceCore = new Database(corePath, { readonly: true });
    let coreChecksum: string;
    let originalAudits: unknown[];
    try {
      const schema = matchingSchema(sourceCore)!;
      expect(schema.migrations.map((migration) => migration.id)).toEqual([
        '0001-baseline',
        '0002-recovery-audit',
      ]);
      coreChecksum = schema.checksum;
      originalAudits = sourceCore.query('SELECT * FROM recovery_audit ORDER BY run_id').all();
      expect(originalAudits).toHaveLength(1);
    } finally {
      sourceCore.close(true);
    }
    const originalCore = readFileSync(corePath);
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backups') });
    expect(backup.manifest.version).toBe(19);
    expect(backup.manifest.assets.desktopUi.format?.userVersion).toBe(10);
    expect(backup.manifest.source.migrationChecksum).toBe(coreChecksum);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(path)).toEqual(original);
    expect(readFileSync(corePath)).toEqual(originalCore);
    const backupCore = new Database(join(backup.directory, 'core.db'), { readonly: true });
    try {
      expect(matchingSchema(backupCore)?.checksum).toBe(coreChecksum);
      expect(backupCore.query('SELECT * FROM recovery_audit ORDER BY run_id').all()).toEqual(
        originalAudits,
      );
    } finally {
      backupCore.close(true);
    }
    const restoredId = (
      await restoreProfileBackup({
        profile,
        expectedStoreId: storeId,
        backup,
        intent: 'replace_with_selected_backup',
      })
    ).storeId;
    expect(restoredId).not.toBe(storeId);
    const restoredCore = new Database(corePath, { readonly: true });
    try {
      expect(matchingSchema(restoredCore)?.checksum).toBe(coreChecksum);
      expect(restoredCore.query('SELECT * FROM recovery_audit ORDER BY run_id').all()).toEqual(
        originalAudits,
      );
      expect(restoredCore.query('SELECT store_id FROM recovery_audit').get()).toEqual({
        store_id: storeId,
      });
      expect(restoredCore.query('SELECT origin_store_id,state FROM execution').get()).toEqual({
        origin_store_id: storeId,
        state: 'outcome_unknown',
      });
      expect(restoredCore.query('SELECT status,is_active FROM run').get()).toEqual({
        status: 'interrupted',
        is_active: 0,
      });
    } finally {
      restoredCore.close(true);
    }
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const rejection = await readonly
        .verifyRunResume({
          expectedStoreId: restoredId,
          sessionId: 'core-session',
          commandId: 'forbidden-resume',
          subjectId: 'owner',
          runId: coreRun.id,
          expectedOwnerGeneration: String(BigInt(owner.generation) + 1n),
        })
        .catch((error: unknown) => error);
      expect(rejection).toMatchObject({ code: 'operation_unverifiable' });
    } finally {
      await readonly.close();
    }
    const restoredBytes = readFileSync(path);
    const cold = await node('read', restoredId);
    expect(cold.tasks).toEqual(seeded.tasks);
    expect(cold.runs).toEqual(seeded.runs);
    expect(readFileSync(path)).toEqual(restoredBytes);
    const foreign = await node('foreign', restoredId);
    expect(foreign.requests).toBe(0);
    expect(foreign.manualBlocked).toBe(true);
    expect(foreign.tasks).toEqual(seeded.tasks);
    expect(foreign.runs).toEqual(seeded.runs);
    expect(readFileSync(path)).toEqual(restoredBytes);
    expect(foreign.runs[0].task.storeId).toBe(storeId);
    const rebound = await node('rebind', restoredId);
    expect(rebound.runs).toHaveLength(2);
    expect(
      rebound.runs.find((run: { task: { storeId: string } }) => run.task.storeId === storeId),
    ).toEqual(seeded.runs[0]);
    expect(
      rebound.runs.find((run: { task: { storeId: string } }) => run.task.storeId === restoredId)
        .status,
    ).toBe('queued');
    const reboundBackup = await createProfileBackup({
      profile,
      destinationRoot: join(root, 'rebound-backups'),
    });
    expect((await inspectProfileBackup(reboundBackup)).manifest.version).toBe(19);
  } finally {
    rmSync(root, { recursive: true, force: true });
    qualified.close();
  }
}, 60000);
