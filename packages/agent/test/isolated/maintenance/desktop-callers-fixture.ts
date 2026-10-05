import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '../../../src/platform/profile';
import { nodeAssets } from './assets-fixture';

const repository = new URL('../../../../../', import.meta.url).pathname;
export async function nodeCallerAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
  action: 'seed' | 'read' = 'seed',
) {
  if (action === 'seed') await nodeAssets(root, profile, storeId);
  const directory = join(root, 'node-caller-fixture');
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
import {callerDigest,callerTarget,callerTextDigest} from ${JSON.stringify(join(repository, 'apps/desktop/electron/caller-journal.ts'))};
import {canonicalCallerCommandRequest} from ${JSON.stringify(join(repository, 'packages/client/src/index.ts'))};
const input=JSON.parse(process.argv[2]);
const lease=await acquireDesktopProfileAccess(input.access);
let data;
try {
 data=openPrivateData(input.profilePath,lease);
 if(input.action==='seed'){
  const content='é🙂\\r\\n'.repeat(40000)+'ORIGINAL_FULL_CALLER_TAIL\\r\\n';
  const scope={storeId:input.storeId,workspaceId:'w',sessionId:'original_session'};
  const saved=data.save({storeId:scope.storeId,workspaceId:scope.workspaceId,rootSessionId:scope.sessionId},0,content);
  const requests=[
   {kind:'run.start',content,modelId:'original_model',selectedSkills:['OriginalSkill'],extensionInputs:[{extensionId:'builtin.planning',definitionVersion:'1',input:{mode:'plan'}}]},
   {kind:'input.steer',content,targetRunId:'original_run',contextSelectionId:'original_context'},
   {kind:'input.follow_up',content,afterRunId:null,contextSelectionId:'original_context',modelId:'original_model',selectedSkills:[],extensionInputs:[]},
   {kind:'command.cancel',targetCommandId:'original_command'},
   {kind:'execution.cancel',executionId:'original_job'}
  ];
  for(let i=0;i<requests.length;i++){
   const request={...requests[i],expectedStoreId:input.storeId,commandId:'original-caller-'+i};
   const intent={scope,request,target:callerTarget(scope,request),subjectId:'original_subject',bodyDigest:callerDigest(request),requestDigest:callerTextDigest(canonicalCallerCommandRequest(request)),...('content' in request?{draft:{id:saved.id,revision:String(saved.revision),textDigest:callerTextDigest(content)}}:{})};
   data.beginCaller({intent,phase:'submitting'});
   data.finishCaller(request.commandId,'unknown');
  }
 }
 console.log(JSON.stringify({records:data.callers(),httpRequests:0}));
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
    if (!build.success) throw new AggregateError(build.logs, 'owned Node caller UI driver build');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  }
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
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
          bunSha256: hash(process.execPath),
          helperPath: helper,
          helperSha256: hash(helper),
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
  if (exit !== 0) throw Error(`owned_node_caller_ui_failed: ${stderr}`);
  return JSON.parse(stdout) as { records: CallerAssetRow[]; httpRequests: 0 };
}
export interface CallerAssetRow {
  intent: {
    scope: { storeId: string; workspaceId: string; sessionId: string };
    request: Record<string, unknown> & {
      commandId: string;
      expectedStoreId: string;
      kind: string;
      content?: string;
    };
    target: Record<string, unknown>;
    subjectId: string;
    bodyDigest: string;
    requestDigest: string;
    draft?: { id: string; revision: string; textDigest: string };
  };
  phase: string;
}
