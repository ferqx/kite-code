import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '../../../src/platform/profile';
import { retainLegacyDb6Fixture } from './assets-fixture';
import { nodeCallerAssets } from './desktop-callers-fixture';

const repository = new URL('../../../../../', import.meta.url).pathname;
/** DB6 qualification retains all DB6 assets; only proven empty DB7 additions are removed after owner close. */
export async function nodeConfigurationAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
  action: 'seed' | 'read' = 'seed',
  currentStoreId = storeId,
) {
  if (action === 'seed') await nodeCallerAssets(root, profile, storeId);
  const directory = join(root, 'node-configuration-fixture');
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
import http from 'node:http'; import https from 'node:https';
const input=JSON.parse(process.argv[2]); let httpRequests=0;
const denied=()=>{httpRequests++;throw Error('configuration_fixture_http_forbidden');};
globalThis.fetch=async()=>denied();for(const protocol of [http,https])for(const method of ['get','request'])protocol[method]=denied;
const lease=await acquireDesktopProfileAccess(input.access);let data;
try {data=openPrivateData(input.profilePath,lease);
 if(input.action==='seed'){
  const readSet={userEtag:'a'.repeat(64),workspaceEtag:null,explicitDigest:'b'.repeat(64),effectiveDigest:'c'.repeat(64)};
  const operation={provider:'compatible',connectionId:null,baseURL:'https://original.invalid/v1',modelNames:['Original-é-模型'],credential:'replace'};
  data.saveConfiguration({kind:'provider',input:{expectedStoreId:input.storeId,commandId:'provider-original',expectedReadSet:readSet,operation},state:{kind:'settings.providers.submission',commandId:'provider-original',storeId:input.storeId,observationId:1,operation,phase:'unknown',credentialState:'outcome_unknown',configurationState:'not_attempted'}});
  const modelOperation={kind:'default',modelId:'original_model'};
  data.saveConfiguration({kind:'model',input:{expectedStoreId:'historical_store',commandId:'model-original',expectedReadSet:readSet,operation:modelOperation},state:{kind:'settings.models.submission',commandId:'model-original',storeId:'historical_store',observationId:2,operation:modelOperation,scope:'user',phase:'unknown'}});
  data.rememberModelRoute(input.storeId,'original_session','original_model');
  data.rememberModelRoute(input.storeId,'other_session','other_model');
  const scope={storeId:input.storeId,workspaceId:'w',sessionId:'original_session'};
  for(const [kind,effort] of [['run.start','high'],['input.follow_up','minimal']]){
   const request={kind,expectedStoreId:input.storeId,commandId:'effort-'+kind.replace('.','-'),content:'Original effort é🙂\\r\\n',modelId:'original_model',reasoningEffort:effort,...(kind==='input.follow_up'?{afterRunId:null,contextSelectionId:'original_context'}:{})};
   const intent={scope,request,target:callerTarget(scope,request),subjectId:'original_subject',bodyDigest:callerDigest(request),requestDigest:callerTextDigest(canonicalCallerCommandRequest(request))};
   data.beginCaller({intent,phase:'submitting'});data.finishCaller(request.commandId,'unknown');
  }
 }
 console.log(JSON.stringify({configurations:data.configurations(),callers:data.callers(),originalRoute:data.modelRoute(input.storeId,'original_session'),otherRoute:data.modelRoute(input.storeId,'other_session'),currentRoute:data.modelRoute(input.currentStoreId,'original_session')??null,httpRequests}));
}finally{if(data)data.close();else lease.close();}
`,
      { mode: 0o600 },
    );
    const built = await Bun.build({
      entrypoints: [source],
      target: 'node',
      packages: 'bundle',
      outdir: directory,
      naming: 'driver.js',
    });
    if (!built.success)
      throw new AggregateError(built.logs, 'owned Node DB6 configuration fixture build');
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
        currentStoreId,
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
  if (exit !== 0) throw Error('owned_node_db6_configuration_failed:' + stderr);
  retainLegacyDb6Fixture(profile);
  return JSON.parse(stdout) as {
    configurations: {
      kind: string;
      input: { expectedStoreId: string; commandId: string; operation: Record<string, unknown> };
      state: Record<string, unknown>;
    }[];
    callers: {
      intent: { request: Record<string, unknown>; bodyDigest: string; requestDigest: string };
      phase: string;
    }[];
    originalRoute: string;
    otherRoute: string;
    currentRoute: string | null;
    httpRequests: number;
  };
}
