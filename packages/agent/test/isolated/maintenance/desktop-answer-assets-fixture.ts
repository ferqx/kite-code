import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '../../../src/platform/profile';
import { nodeAssets, retainLegacyDb5Fixture } from './assets-fixture';

const repository = new URL('../../../../../', import.meta.url).pathname;
export async function nodeAnswerAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
  action: 'seed' | 'read' = 'seed',
) {
  if (action === 'seed') await nodeAssets(root, profile, storeId);
  const directory = join(root, 'node-answer-fixture');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const helper = join(root, 'node-ui-fixture/profile-access-helper.js'),
    driver = join(directory, 'driver.js');
  if (action === 'seed') {
    const source = join(directory, 'driver.ts');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(join(repository, 'apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(join(repository, 'apps/desktop/electron/private-data.ts'))};
import {answerRequestDigest} from ${JSON.stringify(join(repository, 'apps/desktop/electron/answer-journal.ts'))};
import {callerDigest} from ${JSON.stringify(join(repository, 'apps/desktop/electron/caller-journal.ts'))};
import http from 'node:http'; import https from 'node:https';
const input=JSON.parse(process.argv[2]);let httpRequests=0;
const denied=()=>{httpRequests++;throw Error('owned_answer_http_forbidden');};
globalThis.fetch=async()=>denied();for(const protocol of [http,https])for(const method of ['get','request'])protocol[method]=denied;
const lease=await acquireDesktopProfileAccess(input.access);let data;
try {data=openPrivateData(input.profilePath,lease);
if(input.action==='seed')for(const kind of ['question','approval','plan_review']){
 const interaction={id:'original-'+kind,sessionId:'original-session',executionId:'original-execution',runId:'original-run',revision:'9007199254740993',kind,attempt:1,definitionId:'original-definition',definitionVersion:'1',inputDigest:'original-input-digest',policyRevision:'original-policy'};
 const answer=kind==='question'?{kind,answers:{exact:'é e\\u0301 🙂\\r\\n'.repeat(24000)+'ORIGINAL_ANSWER_TAIL\\r\\n'}}:kind==='approval'?{kind,decision:'approve',grant:'approve_once'}:{kind,decision:'revise',feedback:'Original 改訂\\r\\n',mode:'original-mode'};
 const request={expectedStoreId:input.storeId,commandId:'answer-'+kind,expectedRevision:interaction.revision,answer};
 data.beginAnswer({intent:{scope:{storeId:input.storeId,sessionId:'original-session',workspaceId:'original-workspace',contextSelectionId:'original-selection'},subjectId:'original-subject',interaction,observationDigest:callerDigest({original:true,interaction}),request,bodyDigest:callerDigest(request),requestDigest:answerRequestDigest(interaction.id,request)},phase:'submitting'});
 data.finishAnswer(request.commandId,'unknown');
}
console.log(JSON.stringify({records:data.answers(),httpRequests}));
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
    if (!built.success) throw new AggregateError(built.logs, 'owned answer asset Node build');
    writeFileSync(join(directory, 'package.json'), ' {"type":"module"}', { mode: 0o600 });
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
  if (exit !== 0) throw Error('owned_node_answer_asset_failed:' + stderr);
  retainLegacyDb5Fixture(profile);
  return JSON.parse(stdout) as {
    records: {
      intent: {
        scope: { storeId: string; sessionId: string };
        subjectId: string;
        interaction: { id: string; revision: string };
        request: Record<string, unknown>;
        bodyDigest: string;
        requestDigest: string;
        observationDigest: string;
      };
      phase: string;
    }[];
    httpRequests: number;
  };
}
