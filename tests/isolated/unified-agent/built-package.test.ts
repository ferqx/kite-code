import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
};
const repository = resolve(import.meta.dir, '../../..');
async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [exit, stdout, stderr] = await Promise.all([
      Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('artifact_fixture_deadline'));
          }, 20000);
        }),
      ]),
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`artifact_fixture_failed:${exit}\n${stderr}`);
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
async function buildManifest(manifest: Manifest, source: string, destination: string) {
  // Execute every command from the actual manifest, changing only its output destination.
  // All entries remain in one build invocation, preserving common-root behavior.
  for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
    const words = segment.trim().split(/\s+/);
    if (words.shift() !== 'bun') throw new Error('unsupported_manifest_build');
    const args = words.map((word) =>
      word === 'dist' || word === './dist'
        ? destination
        : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
    );
    const outputFlag = args.indexOf('--outdir');
    if (outputFlag >= 0) args[outputFlag + 1] = destination;
    await run(args, source);
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([key, path]) => [
      key,
      path.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
    ]),
  );
  writeFileSync(
    join(destination, 'package.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
  );
  for (const path of Object.values(exports)) expect(existsSync(join(destination, path))).toBe(true);
  return exports;
}

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
nativeTest(
  'complete manifest build runs SQLite Worker, Shell and MCP guardians, Web parser, Skills and paired Service outside source without fallback',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-built-package-'));
    try {
      const artifact = join(root, 'distribution');
      const modules = join(artifact, 'node_modules');
      const agentPath = join(modules, '@kite-ai/agent');
      mkdirSync(agentPath, { recursive: true });
      const agent = JSON.parse(
        readFileSync(join(repository, 'packages/agent/package.json'), 'utf8'),
      ) as Manifest;
      const exports = await buildManifest(agent, join(repository, 'packages/agent'), agentPath);
      // External npm dependencies are linked as installed modules. Workspace AI is a
      // separately built sibling package, never the source workspace alias.
      const ai = JSON.parse(
        readFileSync(join(repository, 'packages/ai/package.json'), 'utf8'),
      ) as Manifest;
      const aiPath = join(modules, '@kite-ai/ai');
      mkdirSync(aiPath, { recursive: true });
      await buildManifest(ai, join(repository, 'packages/ai'), aiPath);
      const client = JSON.parse(
        readFileSync(join(repository, 'packages/client/package.json'), 'utf8'),
      ) as Manifest;
      const clientPath = join(modules, '@kite-ai/client');
      mkdirSync(clientPath, { recursive: true });
      await buildManifest(client, join(repository, 'packages/client'), clientPath);
      const service = JSON.parse(
        readFileSync(join(repository, 'apps/service/package.json'), 'utf8'),
      ) as Manifest;
      const servicePath = join(modules, '@kite-ai/service');
      mkdirSync(servicePath, { recursive: true });
      await buildManifest(service, join(repository, 'apps/service'), servicePath);
      const dependencyOwners = new Map<string, string[]>();
      for (const [manifest, source] of [
        [agent, 'packages/agent'],
        [ai, 'packages/ai'],
        [client, 'packages/client'],
        [service, 'apps/service'],
      ] as const) {
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
          const owners = dependencyOwners.get(dependency) ?? [];
          owners.push(source);
          dependencyOwners.set(dependency, owners);
        }
      }
      for (const [dependency, owners] of dependencyOwners) {
        if (dependency.startsWith('@kite-ai/')) {
          expect(['@kite-ai/agent', '@kite-ai/ai', '@kite-ai/client']).toContain(dependency);
          continue;
        }
        const target = join(modules, dependency);
        mkdirSync(dirname(target), { recursive: true });
        const installed = [
          ...owners.map((owner) => join(repository, owner, 'node_modules', dependency)),
          join(repository, 'node_modules', dependency),
        ].find(existsSync);
        if (!installed) throw new Error(`artifact_dependency_unavailable:${dependency}`);
        symlinkSync(realpathSync(installed), target, 'dir');
      }
      expect(existsSync(join(agentPath, 'src'))).toBe(false);
      expect(existsSync(join(agentPath, 'storage/worker/main.js'))).toBe(true);
      expect(existsSync(join(agentPath, 'storage/migrations/0001-baseline.sql'))).toBe(true);
      expect(existsSync(join(agentPath, 'platform/process/shell-supervisor.js'))).toBe(true);
      expect(existsSync(join(agentPath, 'mcp/stdio-guardian.js'))).toBe(true);
      expect(exports).toEqual({
        '.': './index.js',
        './extensions': './extensions/index.js',
        './storage': './storage/index.js',
        './sqlite': './sqlite.js',
        './sources': './sources.js',
        './profile': './profile.js',
        './profile-access': './profile-access.js',
        './resources': './resources.js',
        './jobs/shell': './jobs/shell.js',
        './config': './config/index.js',
        './files': './files.js',
        './artifacts': './artifacts.js',
        './skills': './skills/index.js',
        './mcp': './mcp/index.js',
        './task': './extensions/task/index.js',
        './shell': './tools/shell.js',
        './ask-user': './tools/ask-user/index.js',
        './planning': './business/planning/index.js',
        './web-fetch': './tools/web-fetch/index.js',
        './maintenance': './maintenance/index.js',
        './artifact-access': './artifact-access.js',
        './skill-workflow': './business/skill-workflow/index.js',
        './sqlite-engine': './sqlite-engine.js',
        './windows-path-security': './platform/windows-path-security.js',
      });
      expect(exports['./maintenance']).toBe('./maintenance/index.js');
      expect(exports['./skill-workflow']).toBe('./business/skill-workflow/index.js');
      expect(exports['./web-fetch']).toBe('./tools/web-fetch/index.js');
      expect(existsSync(join(agentPath, 'tools/web-fetch/extractor-worker.js'))).toBe(true);
      expect(existsSync(join(agentPath, 'tools/web-fetch/extractor-worker.sha256'))).toBe(true);
      expect(relative(repository, artifact).startsWith('..')).toBe(true);
      writeFileSync(
        join(artifact, 'packaged-mcp-server.mjs'),
        `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const ledger=process.env.LEDGER;
writeFileSync(ledger,JSON.stringify({pid:process.pid,calls:0}));
createInterface({input:process.stdin}).on('line',line=>{
 const rpc=JSON.parse(line);if(rpc.id===undefined)return;let result;
 if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'packaged-stdio',version:'1'},capabilities:{tools:{}}};
 else if(rpc.method==='tools/list')result={tools:[{name:'count',inputSchema:{type:'object',additionalProperties:false}}]};
 else if(rpc.method==='tools/call'){const old=JSON.parse(readFileSync(ledger,'utf8'));writeFileSync(ledger,JSON.stringify({...old,calls:old.calls+1}));result={content:[{type:'text',text:'packaged stdio result'}]};}
 else throw new Error('unexpected_packaged_rpc');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\n');
});`,
      );
      const entry = join(artifact, 'verify.mjs');
      writeFileSync(
        entry,
        `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync,readFileSync,renameSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const base=import.meta.dir;
const packageRoot=join(base,'node_modules/@kite-ai/agent');
const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
for(const key of Object.keys(manifest.exports)){
 const specifier=key==='.'?'@kite-ai/agent':'@kite-ai/agent/'+key.slice(2);
 const path=Bun.resolveSync(specifier,base);
 assert(path.startsWith(packageRoot+'/')&&path.endsWith('.js')&&!path.includes('/src/'));
 await import(specifier);
}
assert(Bun.resolveSync('@kite-ai/ai',base).startsWith(join(base,'node_modules/@kite-ai/ai')+'/'));
for(const packageName of ['client','service']){
 const root=join(base,'node_modules/@kite-ai/'+packageName);assert(!existsSync(join(root,'src')));
 const entries=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).exports;
 for(const key of Object.keys(entries)){const name=key==='.'?'@kite-ai/'+packageName:'@kite-ai/'+packageName+'/'+key.slice(2);assert(Bun.resolveSync(name,base).startsWith(root+'/'));await import(name);}
}
const {createRuntime,AgentError}=await import('@kite-ai/agent');
const {AgentError:StorageAgentError}=await import('@kite-ai/agent/storage');
assert.equal(AgentError,StorageAgentError,'public entries must share their actual domain error constructor');
const {defineExtension}=await import('@kite-ai/agent/extensions');
const {openSqliteStore}=await import('@kite-ai/agent/sqlite');
const {createShellJob,shellSupervisorAsset}=await import('@kite-ai/agent/jobs/shell');
const {createSkillSource}=await import('@kite-ai/agent/skills');
const {compileSkillWorkflow,validateWorkflowArguments,createSkillWorkflowCompensator}=await import('@kite-ai/agent/skill-workflow');
const {createWorkspaceFiles}=await import('@kite-ai/agent/files');
const {webExtractorAsset}=await import('@kite-ai/agent/web-fetch');
const {selectProfile}=await import('@kite-ai/agent/profile');
const {createArtifactStore}=await import('@kite-ai/agent/artifacts');
const {createProfileBackup,inspectProfileBackup,restoreProfileBackup,inspectProfileRestore}=await import('@kite-ai/agent/maintenance');
const {createDefaultProcessConfiguration}=await import('@kite-ai/service/configuration');
const {createMcpAdapter,createMcpLifecycle,createMcpStdioTransportPort,mcpStdioGuardianAsset}=await import('@kite-ai/agent/mcp');
const {createFixedModel}=await import('@kite-ai/ai');
const {startService}=await import('@kite-ai/service');
const {createMcpHttpTransportPort}=await import('@kite-ai/service/mcp-http-port');
const {createClient,createServiceLifecycleClient}=await import('@kite-ai/client');
const {createBrowserClient}=await import('@kite-ai/client/browser');
const {launchPairedService}=await import('@kite-ai/service/paired');
const {startDevelopmentWeb}=await import('@kite-ai/service/development-web');
const working=join(base,'working');mkdirSync(working);
writeFileSync(join(working,'packaged.ts'),'one\\ntwo\\n');
const files=createWorkspaceFiles({root:working});const filePage=await files.read('packaged.ts',{offset:2,limit:1});assert.equal(filePage.content,'two\\n');assert.equal(filePage.baseline.size,8);assert.deepEqual((await files.glob({pattern:'**/*.ts'})).paths,['packaged.ts']);
const skills=join(working,'knowledge');mkdirSync(skills);writeFileSync(join(skills,'SKILL.md'),'---\\nname: packaged\\ndescription: artifact knowledge\\n---\\nRead [note](note.txt)');writeFileSync(join(skills,'note.txt'),'packaged reference');
const source=createSkillSource({trustedRoots:[skills],locations:[skills]});const summary=(await source.list()).entries[0];const body=await source.load({id:summary.id,version:summary.version});assert.equal(body.resources.length,1);assert.equal((await source.readResource({skillId:summary.id,version:summary.version,path:'note.txt'})).body,'packaged reference');
const workflowRoot=join(working,'workflow');mkdirSync(workflowRoot);writeFileSync(join(workflowRoot,'SKILL.md'),'---\\n'+JSON.stringify({name:'packaged-workflow',version:'1.0.0',description:'Actual built Workflow compiler',invocation:{allow_manual:true,allow_implicit:false},context:{mode:'inline',agent:'code'},input_schema:{type:'object'},output_schema:{type:'object',properties:{ok:{const:true}},required:['ok']},capabilities:{require:[],deny:[]},effects:{filesystem:'read',network:'none',external_state:'none'},approval:{minimum:'none'},execution:{timeout_ms:1000,max_attempts:1},verification:{mode:'required'},recovery:{retry:'never'}})+'\\n---\\nFollow the exact packaged workflow.');const compiledWorkflow=compileSkillWorkflow({skillDir:workflowRoot,source:'project',origin:'.agents'});assert.deepEqual(compiledWorkflow.diagnostics,[]);assert.equal(validateWorkflowArguments(compiledWorkflow.contract.outputSchema,{ok:true}),null);assert.notEqual(validateWorkflowArguments(compiledWorkflow.contract.outputSchema,{ok:false}),null);
assert.equal(shellSupervisorAsset(),join(packageRoot,'platform/process/shell-supervisor.js'));
assert.equal(mcpStdioGuardianAsset(),join(packageRoot,'mcp/stdio-guardian.js'));
let compensationQualified=false;
if(process.platform==='darwin'){
 const skillRoot=join(working,'compensation'),privateRoot=join(base,'compensation-control'),temporaryRoot=join(base,'compensation-runtime');
 for(const root of [skillRoot,privateRoot,temporaryRoot])mkdirSync(root);
 const ledger=join(working,'compensation-ledger');
 writeFileSync(join(skillRoot,'SKILL.md'),'---\\n'+JSON.stringify({name:'packaged-compensation',version:'1.0.0',description:'Original packaged compensation',invocation:{allow_manual:true,allow_implicit:false},context:{mode:'inline',agent:'code'},input_schema:{type:'object'},output_schema:{type:'object'},capabilities:{require:[],deny:[]},effects:{filesystem:'write',network:'none',external_state:'none'},approval:{minimum:'user'},execution:{timeout_ms:5000,max_attempts:1},verification:{mode:'required'},recovery:{retry:'never',compensation:'compensate.ts'}})+'\\n---\\nRun only the original declared script.');
 writeFileSync(join(skillRoot,'compensate.ts'),"import {writeFileSync} from 'node:fs';if(process.env.OWNED_SECRET)throw Error('secret_inherited');let refused=false;try{writeFileSync("+JSON.stringify(join(privateRoot,'forbidden'))+",'x')}catch{refused=true}if(!refused)throw Error('protected_write');writeFileSync("+JSON.stringify(ledger)+",'1');");
 const compiled=compileSkillWorkflow({skillDir:skillRoot,source:'project',origin:'.agents'});assert.deepEqual(compiled.diagnostics,[]);
 const compensator=createSkillWorkflowCompensator({entries:[compiled],protectedRoots:[privateRoot],temporaryRoot,shell:{cwd:working,env:{OWNED_SECRET:'nonsecret-fixture'},supervisorPath:shellSupervisorAsset(),bunExecutable:process.execPath,shellExecutable:'/bin/sh'}});
 const job=compensator.extension.jobs[0],input=compensator.compensationJob.prepare({entry:compiled,activationId:'one',attempt:1,outputDigest:createHash('sha256').update('{}').digest('hex'),output:{},decisionKey:'original/accepted/decision',decisionDigest:'a'.repeat(64)});
 const handle=await job.start(input,{sessionId:'owned',executionId:'packaged-compensation',signal:new AbortController().signal});let terminal;
 for await(const event of job.observe(handle))if(event.type==='terminal')terminal=event;
 assert.equal(terminal.supervision,'ended');assert.equal(terminal.result.outcome,'succeeded');assert.equal(readFileSync(ledger,'utf8'),'1');assert.equal(existsSync(join(privateRoot,'forbidden')),false);assert.equal(readdirSync(temporaryRoot).length,0);await job.dispose(handle);compensationQualified=true;
}
let effects=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){if(request.method!=='POST')return new Response(null,{status:405});const rpc=await request.json();if(rpc.id===undefined)return new Response(null,{status:202});let result;if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'artifact',version:'1'},capabilities:{tools:{}}};else if(rpc.method==='tools/list')result={tools:[{name:'artifact-count',inputSchema:{type:'object'}}]};else{effects++;result={content:[{type:'text',text:'artifact operation'}]};}return Response.json({jsonrpc:'2.0',id:rpc.id,result});}});
const adapter=createMcpAdapter({id:'packaged',transport:{type:'http',url:server.url.href}});const scope=adapter.scope('session');
const webAsset=webExtractorAsset();assert.equal(webAsset,join(packageRoot,'tools/web-fetch/extractor-worker.js'));
const parserHash=createHash('sha256').update(readFileSync(webAsset)).digest('hex');assert.equal(readFileSync(webAsset.replace(/\\.js$/,'.sha256'),'utf8').trim(),parserHash);
let webRequests=0,webAdmissions=0,providerRequests=[];
const html='<html><head><title>Packaged article</title></head><body><article><h1>Package verification</h1>'+Array.from({length:700},(_,i)=>'<p>Paragraph '+i+(i===699?' FINAL PACKAGED HTML MARKER':'')+' contains complete packaged article evidence, with enough readable context and a <a href="/reference">reference link</a>.</p>').join('')+'<script>fetch("/forbidden-subresource")</script><img src="/forbidden-subresource" /></article></body></html>';
const web=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){webRequests++;const path=new URL(request.url).pathname;assert.notEqual(path,'/forbidden-subresource');return new Response(path==='/robots.txt'?'User-agent: *':html,{headers:{'content-type':path==='/robots.txt'?'text/plain':'text/html'}});}});
const webUrl='http://fixture.test:'+web.port+'/article';
const provider=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json();providerRequests.push(body);const last=body.messages.reduce((found,message,i)=>message.role==='user'&&message.content.startsWith('packaged-web')?i:found,-1);const answered=body.messages.slice(last+1).some(message=>message.role==='tool');const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({id:'packaged-web',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,delta,finish_reason}]})+'\\n\\n';return new Response(chunk(answered?{content:'Web result observed'}:{tool_calls:[{index:0,id:'web-'+providerRequests.length,type:'function',function:{name:'web_fetch',arguments:JSON.stringify({url:webUrl})}}]},null)+chunk({},answered?'stop':'tool_calls')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});}});
let runtime;let store;let service;let webSelected=false;let webHost;
let stdioAdmissions=0,stdioEffects=0,stdioStopped=false;
const stdioLedger=join(working,'stdio-ledger.json');
const stdioConfiguration={type:'stdio',command:process.execPath,args:[join(base,'packaged-mcp-server.mjs')],cwd:working,env:{LEDGER:stdioLedger}};
const stdioPort=createMcpStdioTransportPort({servers:[{id:'packaged-stdio',configuration:stdioConfiguration}],guardianPath:mcpStdioGuardianAsset(),bunExecutable:process.execPath,allowedEnvNames:['LEDGER'],async admit(binding){const execution=await store.getExecution(binding.executionId);assert.equal(execution.kind,'job');assert.equal(execution.status,'dispatching');assert.equal(execution.originStoreId,binding.originalStoreId);assert.equal(execution.sessionId,binding.sessionId);assert.equal(execution.definitionVersion,binding.configDigest);const command=await store.getCommand(execution.originCommandId);assert.equal(command.receipt.executionId,execution.id);stdioAdmissions++;}});
const lifecycle=createMcpLifecycle({servers:[{id:'packaged-stdio',transport:stdioConfiguration}],transportPort:stdioPort});
assert(!existsSync(stdioLedger));
try{
 const tools=await scope.snapshotTools();const shell=createShellJob({cwd:working,env:{PATH:'/usr/bin:/bin'}});
 const extension=defineExtension({id:'mcp.packaged',version:'1',apiMajor:1,tools,jobs:[shell],actions:[{id:'artifact-launch',version:'1',description:'artifact shell',inputSchema:{type:'object'},async prepare(input){return input;},async execute(_input,ctx){const ref=await ctx.operations.ensure({key:'shell',request:{kind:'job',definitionId:shell.id,definitionVersion:shell.version,input:{command:'printf packaged-helper'}}});return {outcome:'succeeded',content:'admitted',details:{executionId:ref.executionId}};}}]});
 store=await openSqliteStore({dataRoot:join(working,'data'),profile:'artifact'});
 const metadata=await store.getMetadata();assert(metadata.storeId);
 await store.createWorkspace({expectedStoreId:metadata.storeId,id:'w',rootUri:'file://'+working,name:'artifact'});await store.createSession({expectedStoreId:metadata.storeId,commandId:'session',sessionId:'s',workspaceId:'w',subjectId:'owner',title:'artifact'});
 await assert.rejects(store.createSession({expectedStoreId:metadata.storeId,commandId:'session',sessionId:'s',workspaceId:'w',subjectId:'owner',title:'changed'}),error=>error instanceof AgentError&&error.code==='command_conflict','Worker errors must retain the public constructor after crossing the sqlite leaf');
 const model=createFixedModel([[{type:'tool_call',id:'mcp-call',name:tools[0].id,arguments:'{}'},{type:'finish',reason:'tool_calls',usage:{inputTokens:0,outputTokens:0}}],[{type:'finish',reason:'stop',usage:{inputTokens:0,outputTokens:0}}]]);
 let selectedModel=model;
 const selectedProfile=await selectProfile({dataRoot:join(working,'data'),profile:'artifact'});
 writeFileSync(join(selectedProfile.profilePath,'config.jsonc'),JSON.stringify({modelId:'local',models:[{id:'local',provider:'compatible',model:'local',baseURL:'http://127.0.0.1:'+provider.port+'/v1'}],tools:[{id:'web_fetch',definitionVersion:'1'}]}),{mode:0o600,flag:'wx'});
 webHost=createDefaultProcessConfiguration({profile:selectedProfile,permissions:{async authorize(){return{allowed:true,revision:'packaged-host-only'};}},webFetch:{network:{policy:{mode:'allowlist',hosts:['fixture.test']},allowLoopbackForTests:true,resolveAddresses:async()=>[{address:'127.0.0.1',family:4}],async admitHop(binding){const execution=await store.getExecution(binding.executionId);assert.equal(execution.kind,'tool');assert.equal(execution.status,'dispatching');assert.equal(execution.originStoreId,binding.originStoreId);assert.equal(execution.sessionId,binding.sessionId);webAdmissions++;return{allowed:true,revision:'packaged-resource-1'};}}}});
 assert.equal(webRequests,0);assert.equal(providerRequests.length,0);
 assert.equal(webHost.extensions.filter(candidate=>candidate.id===lifecycle.extension.id).length,1);
 const webHostExtensions=webHost.extensions.filter(candidate=>candidate.id!==lifecycle.extension.id);
 runtime=createRuntime({store,artifacts:createArtifactStore({profile:selectedProfile,store}),model,extensions:[extension,lifecycle.extension,...webHostExtensions],permissions:{async authorize(){return{allowed:true,revision:'1'};}},resolveRunConfiguration:async input=>webSelected?webHost.resolveRunConfiguration(input):({model:selectedModel,modelId:'fixed',toolIds:[tools[0].id,'mcp.connect'],snapshot:{},readStepCapabilities:async input=>{const value=await lifecycle.readStepCapabilities(input);return{...value,toolIds:[tools[0].id,'mcp.connect',...value.toolIds]};}})});
 const profile={dataRoot:join(working,'data'),name:'artifact',accessKey:'packaged-profile'};
 service=await startService({runtime,profile,buildId:'packaged-build',subjectId:'owner'});
 const lifecycleClient=createServiceLifecycleClient({endpoint:service.endpoint,token:service.bootstrap.token,expected:{profile,instanceId:service.bootstrap.instanceId}});const lifecycleStatus=await lifecycleClient.getStatus();assert.equal(lifecycleStatus.state,'accepting');assert.equal(lifecycleStatus.dataAvailability,'available');assert.equal(lifecycleStatus.buildId,'packaged-build');lifecycleClient.disposeNetwork();
 const client=createClient({endpoint:service.endpoint,token:service.bootstrap.token,bootstrap:service.bootstrap,expected:{profile,apiMajor:1,instanceId:service.bootstrap.instanceId,buildId:'packaged-build',requiredCapabilities:['history','commands']}});assert.equal((await client.connect()).storeId,metadata.storeId);assert.equal((await client.getView('s')).session.id,'s');
 await assert.rejects(client.createSession({expectedStoreId:metadata.storeId,commandId:'session',sessionId:'s',workspaceId:'w',title:'changed'}),error=>error.code==='command_conflict'&&error.status===409,'built HTTP must preserve the known conflict instead of generic 503');
 const httpPort=createMcpHttpTransportPort({servers:[{id:'packaged-http',url:server.url.href}],admit:async()=>{throw new Error('unadmitted_fixture');},allowLoopbackForTests:true});assert.equal(typeof httpPort.open,'function');
 await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'mcp',sessionId:'s',subjectId:'owner',request:{kind:'run.start',content:'artifact fixture'}});await runtime.waitForCommand('mcp',{timeoutMs:5000});assert.equal(effects,1);assert.equal((await runtime.getView('s')).runs[0].status,'completed');
 await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'shell',sessionId:'s',subjectId:'owner',request:{kind:'extension.invoke',extensionId:extension.id,actionId:'artifact-launch',definitionVersion:'1',input:{}}});await runtime.waitForCommand('shell',{timeoutMs:5000});const actionId=(await runtime.getCommand('shell')).receipt.executionId;const jobId=(await runtime.getExecution(actionId)).result.details.executionId;
 const deadline=Date.now()+5000;let job;while(true){job=await runtime.getExecution(jobId);if(['succeeded','failed','cancelled','outcome_unknown'].includes(job.status))break;if(Date.now()>deadline)throw new Error('shell_fixture_deadline');await Bun.sleep(10);}
 assert.equal(job.status,'succeeded');assert.equal(job.result.details.groupStopped,true);const output=await runtime.listExecutionOutput({executionId:jobId});assert.equal(output.items.map(item=>item.content).join(''),'packaged-helper');
 webSelected=true;
 await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'web',sessionId:'s',subjectId:'owner',request:{kind:'run.start',content:'packaged-web complete HTML'}});
 const webCommand=await runtime.waitForCommand('web',{timeoutMs:5000});assert.equal((await runtime.getRun(webCommand.receipt.runId)).status,'completed');
 const webExecution=(await store.listExecutions('s')).find(item=>item.originCommandId==='web'&&item.definitionId==='web_fetch');assert.equal(webExecution.status,'succeeded');assert.equal(webExecution.definitionVersion,'1');assert.equal(webExecution.originStoreId,metadata.storeId);assert.deepEqual(webExecution.input,{url:webUrl});assert.equal(webExecution.result.details.parserAssetHash,parserHash);
 assert.equal(webRequests,2);assert.equal(webAdmissions,2);assert.equal(providerRequests.length,2);assert(providerRequests[0].tools.some(tool=>tool.function.name==='web_fetch'));
 const reference=webExecution.result.artifactRefs[0];assert.deepEqual(reference.scope,{kind:'execution',id:webExecution.id});
 const readCursor=(await store.getMetadata()).lastChangeCursor;const binary=await client.readArtifact('s',{expectedStoreId:metadata.storeId,refId:reference.id,scope:reference.scope});const markdown=new TextDecoder('utf-8',{fatal:true}).decode(binary.content);assert(binary.content.byteLength>65536,'full article must publish Artifact');assert(markdown.includes('FINAL PACKAGED HTML MARKER'),'final readable paragraph must survive extraction');assert(markdown.includes('[reference link](http://fixture.test:'+web.port+'/reference)'),'Markdown resolves reference links');assert(!markdown.includes('<article>'));const durableReference=await store.getArtifactReference({expectedStoreId:metadata.storeId,sessionId:'s',subjectId:'owner',refId:reference.id,scope:reference.scope});assert.equal(durableReference.storeId,metadata.storeId);assert.equal(createHash('sha256').update(binary.content).digest('hex'),durableReference.hash);assert.equal(binary.reference.hash,durableReference.hash);assert.equal(String(binary.content.byteLength),durableReference.size);assert(providerRequests[1].messages.some(message=>message.role==='tool'&&message.content.includes('Complete artifact body:\\n'+markdown)));assert.equal((await store.getMetadata()).lastChangeCursor,readCursor);assert.equal((await runtime.getExecution(jobId)).status,'succeeded');
 // A packaged asset is an execution dependency, not an optional source fallback.
 renameSync(webAsset,webAsset+'.held');try{await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'web-missing',sessionId:'s',subjectId:'owner',request:{kind:'run.start',content:'packaged-web missing asset'}});await runtime.waitForCommand('web-missing',{timeoutMs:5000});const failed=(await store.listExecutions('s')).find(item=>item.originCommandId==='web-missing'&&item.definitionId==='web_fetch');assert.equal(failed.status,'failed');assert.equal(failed.result.content,'web_parser_unavailable');assert.equal(webRequests,2);assert.equal(webAdmissions,2);}finally{renameSync(webAsset+'.held',webAsset);}
 webSelected=false;
 if(process.platform==='darwin'){
  await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'stdio-connect',sessionId:'s',subjectId:'owner',request:{kind:'extension.invoke',extensionId:lifecycle.extension.id,actionId:'mcp.connect',definitionVersion:'1',input:{serverId:'packaged-stdio',key:'packaged'}}});await runtime.waitForCommand('stdio-connect',{timeoutMs:5000});
  const connect=(await runtime.getCommand('stdio-connect')).receipt.executionId;assert.equal((await runtime.getExecution(connect)).status,'succeeded');assert.equal(stdioAdmissions,1);
  const cached=await lifecycle.readStepCapabilities({command:{originStoreId:metadata.storeId},session:{id:'s'}});assert.equal(cached.toolIds.length,1);
  selectedModel=createFixedModel([[{type:'tool_call',id:'stdio-call',name:cached.toolIds[0],arguments:'{}'},{type:'finish',reason:'tool_calls',usage:{inputTokens:0,outputTokens:0}}],[{type:'finish',reason:'stop',usage:{inputTokens:0,outputTokens:0}}]]);
  await runtime.submitCommand({expectedStoreId:metadata.storeId,commandId:'stdio-work',sessionId:'s',subjectId:'owner',request:{kind:'run.start',content:'use packaged stdio'}});const work=await runtime.waitForCommand('stdio-work',{timeoutMs:5000});assert.equal((await runtime.getRun(work.receipt.runId)).status,'completed');
  const ledger=JSON.parse(readFileSync(stdioLedger,'utf8'));stdioEffects=ledger.calls;assert.equal(stdioEffects,1);
  const connection=(await store.listExecutions('s')).find(item=>item.definitionId==='mcp.connection.packaged-stdio');assert.equal(connection.status,'running');
  await runtime.cancelSession({expectedStoreId:metadata.storeId,commandId:'stop-stdio',sessionId:'s',subjectId:'owner',includeBackground:true});
  const end=Date.now()+5000;while(true){const fact=await runtime.getExecution(connection.id);if(fact.status==='cancelled'){assert.equal(fact.result.details.transportStopped,true);assert.equal(fact.result.details.remoteToolStopConfirmed,false);stdioStopped=true;break;}if(Date.now()>end)throw new Error('stdio_fixture_deadline');await Bun.sleep(10);}
  assert.throws(()=>process.kill(ledger.pid,0));assert.equal((await lifecycle.readStepCapabilities({command:{originStoreId:metadata.storeId},session:{id:'s'}})).toolIds.length,0);
 }
 const mainEntry=Bun.resolveSync('@kite-ai/service/main',base);assert.equal(mainEntry,join(base,'node_modules/@kite-ai/service/main.js'));
 const pairedProfile=selectProfile({dataRoot:join(working,'paired-data'),profile:'empty'});const providerBeforePaired=providerRequests.length;
 let paired,gateway,browser;let pairedMain=false,pairedStopped=false,gatewayRead=false,nativeSecretHidden=false;
 try{
  paired=await launchPairedService({entrypoint:mainEntry,profile:pairedProfile,instanceId:'packaged-paired-instance',buildId:'packaged-paired-build',apiMajor:1,requiredCapabilities:['sessions','history','commands']});
  assert(paired.pid!==process.pid);process.kill(paired.pid,0);assert.equal(paired.bootstrap.instanceId,'packaged-paired-instance');assert.equal(paired.bootstrap.buildId,'packaged-paired-build');assert.equal(paired.bootstrap.profile.accessKey,pairedProfile.profileAccessKey);assert.equal(paired.bootstrap.profile.dataRoot,pairedProfile.dataRoot);assert.equal((await paired.client.listWorkspaces()).length,0);pairedMain=true;
  // The Gateway default observation document needs no source or UI build fallback.
  gateway=startDevelopmentWeb({admittedClient:paired.client});const shell=await fetch(gateway.endpoint+'/');assert.equal(shell.status,200);const html=await shell.text();assert(!html.includes(paired.bootstrap.token));assert(!html.includes(paired.bootstrap.endpoint));assert(shell.headers.get('content-security-policy').includes("script-src 'self'"));const cookie=shell.headers.get('set-cookie').split(';')[0];
  const browserBodies=[];browser=createBrowserClient({origin:gateway.endpoint,pageIdentity:gateway.pageIdentity,fetch:async(input,init)=>{const headers=new Headers(init?.headers);assert(!headers.has('authorization'));headers.set('cookie',cookie);const response=await fetch(input,{...init,headers});browserBodies.push(await response.clone().text());return response;}});
  const browserInfo=await browser.connect();assert.equal(browserInfo.instanceId,'packaged-paired-instance');assert.equal(browserInfo.storeId,paired.bootstrap.storeId);assert.equal((await browser.listWorkspaces()).length,0);assert.equal((await browser.listSessions()).length,0);assert(browserBodies.every(body=>!body.includes(paired.bootstrap.token)&&!body.includes(paired.bootstrap.endpoint)));assert(!JSON.stringify(paired.diagnostics).includes(paired.bootstrap.token));nativeSecretHidden=true;gatewayRead=true;
  assert.equal(providerRequests.length,providerBeforePaired);assert(!existsSync(join(pairedProfile.profilePath,'config.jsonc')));
  const pairedPid=paired.pid,nativeEndpoint=paired.bootstrap.endpoint,gatewayEndpoint=gateway.endpoint;browser.disposeNetwork();await gateway.close();await paired.close();assert.equal(await paired.exited,0);assert.throws(()=>process.kill(pairedPid,0));
  for(const endpoint of [nativeEndpoint,gatewayEndpoint]){let refused=false;try{await fetch(endpoint+'/health',{signal:AbortSignal.timeout(1000)});}catch{refused=true;}assert(refused,'closed owned listener must reject connections');}pairedStopped=true;
  const reopened=await openSqliteStore({dataRoot:pairedProfile.dataRoot,profile:pairedProfile.profile,mode:'readonly'});try{assert.deepEqual(await reopened.listWorkspaces(),[]);assert.deepEqual(await reopened.listSessions(),[]);}finally{await reopened.close();}
 }finally{browser?.disposeNetwork();await gateway?.close();await paired?.close();}
 const lifecycleProfile=selectProfile({dataRoot:join(working,'lifecycle-data'),profile:'empty'});let lifecycleStopped=false;
 const explicitService=await launchPairedService({entrypoint:mainEntry,profile:lifecycleProfile,instanceId:'packaged-lifecycle-instance',buildId:'packaged-lifecycle-build',apiMajor:1,requiredCapabilities:['sessions']});
 let explicitClient,exitDeadline;
 try{explicitClient=createServiceLifecycleClient({endpoint:explicitService.bootstrap.endpoint,token:explicitService.bootstrap.token,expected:{profile:{dataRoot:lifecycleProfile.dataRoot,name:lifecycleProfile.profile,accessKey:lifecycleProfile.profileAccessKey},instanceId:'packaged-lifecycle-instance'}});assert.equal((await explicitClient.getStatus()).state,'accepting');assert.equal((await explicitClient.shutdown('if_idle')).accepted,true);assert.equal(await Promise.race([explicitService.exited,new Promise((_,reject)=>{exitDeadline=setTimeout(()=>reject(new Error('lifecycle_exit_deadline')),5000);})]),0);assert.throws(()=>process.kill(explicitService.pid,0));assert.equal(providerRequests.length,providerBeforePaired);lifecycleStopped=true;}
 finally{clearTimeout(exitDeadline);explicitClient?.disposeNetwork();await explicitService.close();}
 const beforeBackup={provider:providerRequests.length,effects,stdioEffects};
 const originalConfiguration=readFileSync(join(selectedProfile.profilePath,'config.jsonc'));
 const originalWorkflowConfiguration=Buffer.from('// original Workflow flags and unknown fields\\n{"version":1,"features":{"skillActivation":true,"skillWorkflow":false,"verification":true},"unknown":"preserve"}\\n');
 writeFileSync(join(selectedProfile.profilePath,'skill-workflow.jsonc'),originalWorkflowConfiguration,{mode:0o600,flag:'wx'});
 const originalTuiDraft={id:createHash('sha256').update(JSON.stringify([metadata.storeId,'w','s'])).digest('hex'),storeId:metadata.storeId,workspaceId:'w',sessionId:'s',revision:'9007199254740993',text:'Original unsent draft \u4fdd\u7559\u5168\u6587'};
 const originalTuiBytes=Buffer.from(JSON.stringify({version:1,revision:'9007199254740994',drafts:[originalTuiDraft]}));
 mkdirSync(join(selectedProfile.profilePath,'ui'),{mode:0o700});writeFileSync(join(selectedProfile.profilePath,'ui','tui.json'),originalTuiBytes,{mode:0o600,flag:'wx'});
 await service.close();await runtime.close();
 const backup=await createProfileBackup({profile:selectedProfile,destinationRoot:join(working,'backups')});
 const inspected=await inspectProfileBackup({directory:backup.directory});
 assert.deepEqual(inspected,backup);assert.equal(backup.manifest.source.storeId,metadata.storeId);
 assert.equal(backup.manifest.assets.skillWorkflowConfiguration.present,true);assert.equal(backup.manifest.assets.skillWorkflowConfiguration.proof.sha256,createHash('sha256').update(originalWorkflowConfiguration).digest('hex'));assert.deepEqual(readFileSync(join(backup.directory,'skill-workflow.jsonc')),originalWorkflowConfiguration);
 assert(BigInt(backup.manifest.media.blobCount)>0n);assert.equal(backup.manifest.version,5);assert.equal(backup.manifest.assets.configuration.present,true);assert.deepEqual(readFileSync(join(backup.directory,'config.jsonc')),originalConfiguration);assert.equal(backup.manifest.assets.configuration.proof.sha256,createHash('sha256').update(originalConfiguration).digest('hex'));assert.equal(backup.manifest.assets.desktopUi.present,false);assert.equal(backup.manifest.assets.tuiUi.present,true);assert.deepEqual(backup.manifest.assets.tuiUi.format,{version:1});assert.equal(backup.manifest.assets.tuiUi.proof.sha256,createHash('sha256').update(originalTuiBytes).digest('hex'));assert.deepEqual(readFileSync(join(backup.directory,'ui','tui.json')),originalTuiBytes);assert.equal(backup.manifest.assets.vaultExcluded,true);assert(!existsSync(join(backup.directory,'.coordination')));
 const copiedMedia=readFileSync(join(backup.directory,'blobs',binary.reference.hash.slice(0,2),binary.reference.hash));assert.deepEqual(copiedMedia,Buffer.from(binary.content));
 const restored=await restoreProfileBackup({profile:selectedProfile,expectedStoreId:metadata.storeId,backup,intent:'replace_with_selected_backup'});
 assert.equal(restored.outcome,'restored');assert.notEqual(restored.storeId,metadata.storeId);assert(existsSync(join(restored.preservedDirectory,'core.db')));assert.equal(inspectProfileRestore({profile:selectedProfile}),null);assert.deepEqual(readFileSync(join(selectedProfile.profilePath,'config.jsonc')),originalConfiguration);assert.deepEqual(readFileSync(join(selectedProfile.profilePath,'ui','tui.json')),originalTuiBytes);assert.equal(JSON.parse(readFileSync(join(selectedProfile.profilePath,'ui','tui.json'),'utf8')).drafts[0].storeId,metadata.storeId);
 const restoredReader=await openSqliteStore({...selectedProfile,mode:'readonly'});
 assert.deepEqual(readFileSync(join(selectedProfile.profilePath,'skill-workflow.jsonc')),originalWorkflowConfiguration);
 try{assert.equal((await restoredReader.getMetadata()).storeId,restored.storeId);assert.equal((await restoredReader.getExecution(webExecution.id)).originStoreId,metadata.storeId);
 const historical=await restoredReader.getArtifactReference({expectedStoreId:restored.storeId,sessionId:'s',subjectId:'owner',refId:reference.id,scope:reference.scope});assert(historical,'restored exact original Artifact must remain readable');assert.equal(historical.storeId,metadata.storeId);assert.equal(historical.hash,binary.reference.hash);
 const restoredModel=createFixedModel([]),restoredRuntime=createRuntime({store:restoredReader,artifacts:createArtifactStore({profile:selectedProfile,store:restoredReader}),model:restoredModel,modelId:'fixed'});
 let restoredService,restoredClient;
 try{restoredService=await startService({runtime:restoredRuntime,profile,buildId:'packaged-restored',subjectId:'owner'});
 restoredClient=createClient({endpoint:restoredService.endpoint,token:restoredService.bootstrap.token,bootstrap:restoredService.bootstrap,expected:{profile,apiMajor:1,instanceId:restoredService.bootstrap.instanceId,buildId:'packaged-restored',requiredCapabilities:['history']}});
 assert.equal((await restoredClient.connect()).storeId,restored.storeId);
 const restoredBinary=await restoredClient.readArtifact('s',{expectedStoreId:restored.storeId,refId:reference.id,scope:reference.scope});assert.deepEqual(restoredBinary.content,binary.content);assert.equal(restoredBinary.reference.storeId,metadata.storeId);assert.equal(restoredModel.requests.length,0);
 }finally{restoredClient?.disposeNetwork();await restoredService?.close();await restoredRuntime.close();}

 }finally{await restoredReader.close();}
 assert.deepEqual({provider:providerRequests.length,effects,stdioEffects},beforeBackup);
 process.stdout.write(JSON.stringify({entries:Object.keys(manifest.exports).length,worker:true,guardian:true,mcpGuardian:true,service:true,client:true,httpPort:true,stdioQualified:process.platform==='darwin',stdioAdmissions,stdioEffects,stdioStopped,skillVersion:body.version,mcpEffects:effects,shellStatus:job.status,sourceFallback:false,filePaging:true,glob:true,webWorker:true,parserHash,webArtifactBytes:binary.content.byteLength,webArtifactScope:reference.scope.kind,webRequests,webAdmissions,webStatus:webExecution.status,webMissingAssetRejected:true,pairedMain,pairedStopped,lifecycleStopped,gatewayRead,nativeSecretHidden,backupVerified:true,restoreVerified:true,compensationQualified})+'\\n');
}finally{await files.close();await service?.close();await runtime?.close();if(!runtime)await store?.close();await lifecycle.close();await adapter.close();server.stop(true);web.stop(true);provider.stop(true);}
`,
      );
      const result = JSON.parse((await run([entry], artifact)).trim()) as {
        entries: number;
        worker: boolean;
        guardian: boolean;
        mcpGuardian: boolean;
        service: boolean;
        client: boolean;
        httpPort: boolean;
        stdioQualified: boolean;
        stdioAdmissions: number;
        stdioEffects: number;
        stdioStopped: boolean;
        skillVersion: string;
        mcpEffects: number;
        shellStatus: string;
        sourceFallback: boolean;
        filePaging: boolean;
        glob: boolean;
        webWorker: boolean;
        parserHash: string;
        webArtifactBytes: number;
        webArtifactScope: string;
        webRequests: number;
        webAdmissions: number;
        webStatus: string;
        webMissingAssetRejected: boolean;
        pairedMain: boolean;
        pairedStopped: boolean;
        lifecycleStopped: boolean;
        gatewayRead: boolean;
        nativeSecretHidden: boolean;
        backupVerified: boolean;
        restoreVerified: boolean;
        compensationQualified: boolean;
      };
      expect(result.compensationQualified).toBe(process.platform === 'darwin');
      expect(result).toMatchObject({
        entries: Object.keys(exports).length,
        worker: true,
        guardian: true,
        mcpGuardian: true,
        service: true,
        client: true,
        httpPort: true,
        stdioQualified: process.platform === 'darwin',
        stdioAdmissions: process.platform === 'darwin' ? 1 : 0,
        stdioEffects: process.platform === 'darwin' ? 1 : 0,
        stdioStopped: process.platform === 'darwin',
        mcpEffects: 1,
        shellStatus: 'succeeded',
        sourceFallback: false,
        filePaging: true,
        glob: true,
        webWorker: true,
        webArtifactScope: 'execution',
        webRequests: 2,
        webAdmissions: 2,
        webStatus: 'succeeded',
        webMissingAssetRejected: true,
        pairedMain: true,
        pairedStopped: true,
        lifecycleStopped: true,
        gatewayRead: true,
        nativeSecretHidden: true,
        backupVerified: true,
        restoreVerified: true,
      });
      expect(result.skillVersion).toHaveLength(64);
      expect(result.parserHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.webArtifactBytes).toBeGreaterThan(65536);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
