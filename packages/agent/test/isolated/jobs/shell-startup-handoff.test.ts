import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';

const posixTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const source = join(import.meta.dirname, '../../../src');
const helper = String.raw`
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
let input='',nonce,child,ready=false,cancelled=false,closing=false;
const scenario=process.env.SCENARIO,root=process.env.FIXTURE_ROOT;
function send(frame,done){process.stdout.write(JSON.stringify({nonce,...frame})+'\n',done);}
function stop(){
 if(closing||!child)return;closing=true;
 child.once('close',()=>send({type:'terminal',outcome:'cancelled',groupStopped:true,exitCode:null},()=>process.exit(0)));
 try{process.kill(-child.pid,'SIGTERM')}catch{}
}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;while(input.includes('\n')){
 const end=input.indexOf('\n'),frame=JSON.parse(input.slice(0,end));input=input.slice(end+1);
 if(frame.type==='start'){
  nonce=frame.nonce;child=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});
  child.once('spawn',()=>{
   writeFileSync(root+'/child.pid',String(child.pid));
   if(scenario.includes('protocol'))send({type:'unrecognized'});
   setTimeout(()=>{ready=true;send({type:'ready',processGroupId:child.pid});if(cancelled&&!scenario.includes('unknown'))stop();},250);
  });
 }else if(frame.type==='cancel'){
  if(!nonce){nonce=frame.nonce;appendFileSync(root+'/cancel.log',nonce+'\n');send({type:'terminal',outcome:'cancelled',groupStopped:true,exitCode:null},()=>process.exit(0));continue;}
  appendFileSync(root+'/cancel.log',frame.nonce+'\n');cancelled=true;
  if(scenario.includes('unknown'))send({type:'terminal',outcome:'outcome_unknown',groupStopped:false,exitCode:null});
  else if(ready)stop();
 }
}});
process.stdin.on('end',()=>{appendFileSync(root+'/eof.log','eof\n');stop();});
setInterval(()=>{if(existsSync(root+'/release'))stop();},10);
`;

const probe = String.raw`import {build as buildBundle} from ${JSON.stringify(new URL('../../../../../scripts/tooling/build.ts', import.meta.url).href)};
import {fixtureRuntimeBuild} from ${JSON.stringify(new URL('../../fixtures/node-runtime.ts', import.meta.url).href)};

import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [source,root,scenario]=process.argv.slice(2);
let cleanupCalls=0;const cleanupFixture=scenario.startsWith('spawn-cleanup-');
let shellModule=source+'/jobs/shell.ts';
if(cleanupFixture){
 const {mock}=await import('#kite-test');const {resolve}=await import('node:path');
 // Only this private zero-spawn probe substitutes the OS event boundary. The
 // original Shell body is copied verbatim except its import locations.
 globalThis.fixtureSpawns=0;globalThis.fixtureEscaped=undefined;
 writeFileSync(root+'/zero-spawn.js',"import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';export function spawn(){globalThis.fixtureSpawns++;const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:undefined,exitCode:null,signalCode:null});queueMicrotask(()=>{try{child.emit('error',Error('fixture_spawn_failed'));}catch(error){globalThis.fixtureEscaped=error.message;}child.exitCode=-1;child.emit('close');});return child;}");
 const original=readFileSync(shellModule,'utf8');
 const relocated=original.replace(/from '([^']+)'/g,(whole,spec)=>spec==='node:child_process'?"from '"+root+"/zero-spawn.js'":spec.startsWith('.')?"from '"+resolve(source+'/jobs',spec)+"'":whole);
 shellModule=root+'/shell-probe.ts';writeFileSync(shellModule,relocated);
 writeFileSync(root+'/owned-temp','original private temp');
 mock.module(source+'/jobs/host-preparation.ts',()=>({captureMacosHostLaunch:()=>()=>({executable:'/bin/sh',argv:['-c','unused'],cwd:root,cleanup(){cleanupCalls++;if(scenario==='spawn-cleanup-unknown'&&!existsSync(root+'/release'))throw Error('fixture_cleanup_refused');unlinkSync(root+'/owned-temp');}})}));
}
const {createShellJob,createMacosHostShellJob}=await import(shellModule);
const {JobStartError}=await import(source+'/extensions/index.ts');
const originalTimer=globalThis.setTimeout;
// This private child alone shortens the existing startup timer; no product option or debug entry.
globalThis.setTimeout=(callback,delay,...args)=>originalTimer(callback,delay===5000?100:delay,...args);
if(scenario==='write-failure'){
 const {Writable}=await import('node:stream');const write=Writable.prototype.write;
 Writable.prototype.write=function(chunk,...args){if(typeof chunk==='string'&&chunk.includes('\"type\":\"start\"')){Writable.prototype.write=write;throw Error('fixture_start_write_failed');}return write.call(this,chunk,...args);};
}
const job=(cleanupFixture?createMacosHostShellJob:createShellJob)({cwd:root,env:{PATH:'/usr/bin:/bin',SCENARIO:scenario,FIXTURE_ROOT:root},supervisorPath:root+'/guardian.js',...((scenario==='spawn-failure'||cleanupFixture)?{runtimeExecutable:root}: {}),...(cleanupFixture?{controlBase:root}:{})});
const until=async check=>{const end=Date.now()+7000;while(!await check()){if(Date.now()>end)throw Error('fixture_condition_timeout');await new Promise(r=>originalTimer(r,10));}};
let handle,store,runtime;
try{
 if(scenario==='runtime-preflight'){
  const {createRuntime}=await import(source+'/index.ts');const {openSqliteStore}=await import(source+'/sqlite.ts');
  const {createFixedModel}=await import(source+'/../../ai/src/index.ts');const {createShellExtension}=await import(source+'/tools/shell.ts');
  const built=await buildBundle({entrypoints:[source+'/platform/process/shell-supervisor.ts'],outdir:root+'/assets',...fixtureRuntimeBuild(root+'/assets'),naming:'real-guardian.js'});assert.equal(built.success,true);
  const missing=root+'/missing-supervisor.js';assert.equal(existsSync(missing),false);
  store=await openSqliteStore({dataRoot:root+'/data',profile:'test'});let disposals=0;
  const finish={type:'finish',reason:'stop',usage:{inputTokens:1,outputTokens:1}};
  runtime=createRuntime({store,permissions:{async authorize(){return{allowed:true,revision:'preflight-1'}}},async resolveRunConfiguration({session}){
   const selected=createShellJob({cwd:root,env:{PATH:'/usr/bin:/bin'},supervisorPath:session.id==='healthy'?built.outputs[0].path:missing});
   return{model:createFixedModel([[{type:'tool_call',id:'one',name:'shell_execute',arguments:JSON.stringify({command:"printf '%s' 'healthy' > '"+root+"/healthy.txt'"})},{...finish,reason:'tool_calls'}],[finish]]),modelId:'fixed',extensions:[createShellExtension({job:selected})],snapshot:{},async dispose(){disposals++;}};
  }});
  const expectedStoreId=(await store.getMetadata()).storeId;await runtime.createWorkspace({expectedStoreId,id:'w',rootUri:pathToFileURL(root).href,name:'fixture'});
  for(const id of ['bad0','bad1','bad2','bad3','healthy']){
   await runtime.createSession({expectedStoreId,workspaceId:'w',sessionId:id,commandId:'create-'+id,subjectId:'owner',title:id});
   await runtime.submitCommand({expectedStoreId,sessionId:id,commandId:'run-'+id,subjectId:'owner',request:{kind:'run.start',content:'one exact owned Shell'}});
   await runtime.waitForCommand('run-'+id,{timeoutMs:3000});
   const rows=await store.listExecutions(id),jobs=rows.filter(e=>e.kind==='job'),tools=rows.filter(e=>e.kind==='tool');assert.equal(jobs.length,1);assert.equal(tools.length,1);
   if(id==='healthy'){assert.equal(jobs[0].status,'succeeded');assert.equal(tools[0].status,'succeeded');assert.equal(readFileSync(root+'/healthy.txt','utf8'),'healthy');}
   else{assert.equal(jobs[0].status,'failed');assert.equal(jobs[0].result.details.adapterAttempted,false);assert.equal(jobs[0].result.content,'shell_supervisor_asset_unavailable');assert.equal(tools[0].status,'failed');assert.equal(existsSync(root+'/healthy.txt'),false);}
  }
  await until(()=>disposals===5);await runtime.close();assert.equal(runtime.getLifecycleState().state,'closed');assert.equal(disposals,5);
  console.log('four zero-spawn failures release slots; same Runtime fifth real Shell succeeds and closes');process.exit(0);
 }
 if(scenario.startsWith('runtime-')){
  const {createRuntime}=await import(source+'/index.ts');
  const {openSqliteStore}=await import(source+'/sqlite.ts');
  const {createFixedModel}=await import(source+'/../../ai/src/index.ts');
  store=await openSqliteStore({dataRoot:root+'/data',profile:'test'});
  let bindingDisposals=0;
  const tool={id:'fixture.start',version:'1',description:'owned startup fixture',inputSchema:{type:'object'},async execute(_input,context){await context.operations.ensure({key:'owned',cancellation:'detached',request:{kind:'job',definitionId:job.id,definitionVersion:job.version,input:{command:'unused'}}});return{outcome:'succeeded',content:'original admitted operation'};}};
  const originalStart=job.start.bind(job);job.start=async(...args)=>{try{return await originalStart(...args)}catch(error){handle=error.handle;throw error;}};
  const finish={type:'finish',reason:'stop',usage:{inputTokens:1,outputTokens:1}};
  runtime=createRuntime({store,permissions:{async authorize(){return{allowed:true,revision:'fixture-1'}}},async resolveRunConfiguration(){return{model:createFixedModel([[{type:'tool_call',id:'call',name:tool.id,arguments:'{}'},{...finish,reason:'tool_calls'}],[finish]]),modelId:'fixed',extensions:[{id:'fixture',version:'1',apiMajor:1,tools:[tool],jobs:[job]}],snapshot:{},async dispose(){bindingDisposals++;}};}});
  const expectedStoreId=(await store.getMetadata()).storeId;
  await runtime.createWorkspace({expectedStoreId,id:'w',rootUri:pathToFileURL(root).href,name:'fixture'});
  await runtime.createSession({expectedStoreId,workspaceId:'w',sessionId:'s',commandId:'create',subjectId:'owner',title:'fixture'});
  await runtime.submitCommand({expectedStoreId,sessionId:'s',commandId:'run',subjectId:'owner',request:{kind:'run.start',content:'one original startup'}});
  await until(async()=>{const rows=await store.listExecutions('s');return rows.some(e=>e.kind==='job'&&e.status==='outcome_unknown');});
  assert.ok(handle,'startup failure must preserve the original handle');
  await runtime.waitForCommand('run');
  const rows=await store.listExecutions('s');assert.equal(rows.filter(e=>e.kind==='job').length,1);
  if(scenario.includes('unknown')){
   assert.equal(bindingDisposals,0);
   await assert.rejects(runtime.close(),error=>error.code==='shutdown_cleanup_unconfirmed');
   assert.equal(bindingDisposals,0);assert.equal(runtime.getLifecycleState().state,'drain_failed');
   assert.equal((await store.getMetadata()).storeId,expectedStoreId);
  }else{
   await runtime.close();assert.equal(bindingDisposals,1);assert.equal(runtime.getLifecycleState().state,'closed');
  }
 }else{
  const failure=await job.start({command:'unused'},{sessionId:'s',executionId:'startup',signal:new AbortController().signal}).then(()=>{throw Error('startup unexpectedly returned')},error=>error);
  assert.ok(failure instanceof JobStartError, failure?.message);handle=failure.handle;
  if(scenario==='spawn-failure'||scenario==='spawn-cleanup-success'){assert.equal(handle,undefined);if(cleanupFixture){assert.equal(globalThis.fixtureSpawns,1);assert.equal(cleanupCalls,1);assert.equal(existsSync(root+'/owned-temp'),false);}console.log('zero-spawn');process.exit(0);}
  if(scenario==='spawn-cleanup-unknown'){
   assert.equal(globalThis.fixtureSpawns,1);assert.ok(handle);assert.equal(handle.reference.supervisorPid,null);assert.equal(cleanupCalls,2);assert.equal(existsSync(root+'/owned-temp'),true);
   assert.equal((await job.cancel(handle)).status,'unknown');assert.equal(cleanupCalls,3);
   await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);assert.equal(cleanupCalls,4);
   const events=[];for await(const event of job.observe(handle))events.push(event);assert.equal(events.at(-1).supervision,'unknown');assert.equal(events.at(-1).result.outcome,'outcome_unknown');assert.equal(existsSync(root+'/owned-temp'),true);
   assert.equal(globalThis.fixtureEscaped,undefined,'startup cleanup failure must not escape its original owner');
   writeFileSync(root+'/release','original cleanup cause resolved');
   assert.equal((await job.cancel(handle)).status,'stopped');assert.equal(cleanupCalls,5);assert.equal(existsSync(root+'/owned-temp'),false);
   await job.dispose(handle);await job.dispose(handle);assert.equal(cleanupCalls,5);assert.equal(globalThis.fixtureSpawns,1);
   assert.equal(events.at(-1).supervision,'unknown');assert.equal(events.at(-1).result.outcome,'outcome_unknown');
   console.log('same zero-broker handle retries original cleanup without replay or result rewrite');process.exit(0);
  }
  assert.ok(handle,'startup failure must preserve the original handle');
  assert.equal(handle.reference.executionId,'startup');assert.ok(Number.isInteger(handle.reference.supervisorPid));
  const events=[];const observation=(async()=>{for await(const event of job.observe(handle))events.push(event);})();
  if(scenario.includes('unknown')){
   assert.equal((await job.cancel(handle)).status,'unknown');
   await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);
  }else assert.ok(['stopped','already_finished'].includes((await job.cancel(handle)).status));
  await observation;assert.equal(events.at(-1).supervision,'unknown');assert.equal(events.at(-1).result.outcome,'outcome_unknown');
 }
 assert.equal(existsSync(root+'/eof.log'),false,'admission failure must not sever its proof channel');
 assert.ok(existsSync(root+'/cancel.log'));assert.equal(new Set(readFileSync(root+'/cancel.log','utf8').trim().split('\n')).size,1);
 writeFileSync(root+'/release','release original owned fixture');
 await until(async()=>['stopped','already_finished'].includes((await job.cancel(handle)).status));
 await job.dispose(handle);await job.dispose(handle);
 if(scenario.includes('unknown')&&store)await store.close();
 console.log('original startup handle settled: '+scenario);
}finally{
 writeFileSync(root+'/release','cleanup fixture');
 if(existsSync(root+'/child.pid')){const pid=Number(readFileSync(root+'/child.pid','utf8'));await until(()=>{try{process.kill(pid,0);return false}catch{return true}});}
}
`;

posixTest.each([
  'late',
  'protocol',
  'unknown',
  'spawn-failure',
  ...(process.platform === 'darwin' ? ['spawn-cleanup-success', 'spawn-cleanup-unknown'] : []),
  'write-failure',
  'runtime-preflight',
  'runtime-late',
  'runtime-unknown',
])(
  'Shell startup hands off its original resources: %s',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'kite-shell-startup-handoff-'));
    let child: ReturnType<typeof spawnProcess> | undefined;
    try {
      writeFileSync(join(root, 'guardian.js'), helper);
      writeFileSync(join(root, 'probe.ts'), probe);
      const probeProcess = spawnProcess(
        [process.execPath, ...testRuntimeFlags, join(root, 'probe.ts'), source, root, scenario],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      child = probeProcess;
      const stdout = new Response(probeProcess.stdout).text();
      const stderr = new Response(probeProcess.stderr).text();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('fixture_deadline')), 15000);
        }),
      ]).finally(() => clearTimeout(timer));
      const output = `${await stdout}\n${await stderr}`;
      expect({ exit, output }).toMatchObject({ exit: 0 });
    } finally {
      writeFileSync(join(root, 'release'), 'release original fixture');
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
