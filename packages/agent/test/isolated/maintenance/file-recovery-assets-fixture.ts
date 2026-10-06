import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '../../../src/platform/profile';
import { nodeAssets, retainLegacyDb5Fixture } from './assets-fixture';

const repository = new URL('../../../../../', import.meta.url).pathname;
export async function nodeFileRecoveryAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
  action: 'seed' | 'read' = 'seed',
) {
  if (action === 'seed') await nodeAssets(root, profile, storeId);
  const directory = join(root, 'node-file-recovery-fixture');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const helper = join(root, 'node-ui-fixture/profile-access-helper.js');
  const driver = join(directory, 'driver.js');
  if (action === 'seed') {
    const source = join(directory, 'driver.ts');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(join(repository, 'apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(join(repository, 'apps/desktop/electron/private-data.ts'))};
import {planFileRecoveryIntent,parseFileRecoveryIntent} from ${JSON.stringify(join(repository, 'packages/client/src/file-recovery-intent.ts'))};
import http from 'node:http';
import https from 'node:https';
const input=JSON.parse(process.argv[2]);
let httpRequests=0;
const deniedHttp=()=>{httpRequests++;throw Error('metadata_fixture_http_forbidden');};
globalThis.fetch=async()=>deniedHttp();
for(const protocol of [http,https])for(const method of ['request','get'])protocol[method]=deniedHttp;
const lease=await acquireDesktopProfileAccess(input.access);
let data;
try {
 data=openPrivateData(input.profilePath,lease);
 if(input.action==='seed'){
  const checkpoint={id:'a'.repeat(64),boundary:{storeId:input.storeId,workspaceId:'w',sessionId:'original_parent',runId:'original_run',contextSelectionId:'original_selection',messageId:'original_before',messageSeq:'1',triggerMessageId:'original_trigger',triggerSeq:'2'},workspace:{device:'1',inode:'2'}};
  const observation={storeId:input.storeId,sessionId:'original_current',workspaceId:'w',contextSelectionId:'current_selection',checkpoint,boundary:{messageId:'current_before',seq:'1'},trigger:{messageId:'current_trigger',seq:'2'}};
  for(const scope of ['session','code','both']){
   const intent=await planFileRecoveryIntent({scope,observation,subjectId:'original_subject',...(scope!=='session'?{code:{commandId:'code-'+scope,restoreId:'restore-'+scope}}:{}),...(scope!=='code'?{fork:{commandId:'fork-'+scope,newSessionId:'new-'+scope,title:'Original é e\\u0301\\r\\n" '+scope}}:{})});
   await data.prepareFileRecovery(intent);
   const copy=JSON.parse(JSON.stringify(intent));
   if(copy.code)copy.code.phase=scope==='both'?'succeeded':'unknown';
   if(copy.fork)copy.fork.phase='unknown';
   await data.updateFileRecovery(await parseFileRecoveryIntent(copy),intent);
  }
 }
 console.log(JSON.stringify({records:await data.fileRecoveries(),httpRequests}));
}finally{if(data)data.close();else lease.close();}
`,
      { mode: 0o600 },
    );
    const build = await Bun.build({
      entrypoints: [source],
      target: 'node',
      packages: 'bundle',
      outdir: directory,
      naming: 'driver.js',
    });
    if (!build.success)
      throw new AggregateError(build.logs, 'owned Node file recovery UI driver build');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  }
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const node = Bun.which('node');
  if (!node) throw Error('owned_node_unavailable');
  const child = Bun.spawn(
    [
      node,
      driver,
      JSON.stringify({
        action,
        storeId,
        profilePath: selectProfile(profile).profilePath,
        access: {
          profile,
          bunExecutable: process.execPath,
          bunSha256: digest(process.execPath),
          helperPath: helper,
          helperSha256: digest(helper),
        },
      }),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw Error(`owned_node_file_recovery_ui_failed: ${stderr}`);
  retainLegacyDb5Fixture(profile);
  return JSON.parse(stdout) as { records: Record<string, unknown>[]; httpRequests: number };
}
