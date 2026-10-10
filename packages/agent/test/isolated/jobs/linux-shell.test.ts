import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Linux ordinary Job preserves the full output, cancellation and retained unknown lifecycle', () => {
  const jobPath = fileURLToPath(new URL('../../../src/jobs/shell.ts', import.meta.url));
  const ownerPath = fileURLToPath(
    new URL('../../../src/platform/process/linux-owned-shell.ts', import.meta.url),
  );
  const identityPath = fileURLToPath(
    new URL('../../../src/jobs/launch-identity.ts', import.meta.url),
  );
  const source = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,existsSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const actualOwner=await import(${JSON.stringify(ownerPath)});
const actualIdentity=await import(${JSON.stringify(identityPath)});
const verifyOriginal=actualIdentity.verifyLaunchIdentities;
Object.defineProperty(process,'platform',{value:'linux'});
const root=realpathSync(mkdtempSync(join(tmpdir(),'kite-linux-job-contract-')));
const workspace=join(root,'workspace'),tempBase=join(root,'temp'),assets=join(root,'assets'),profile=join(root,'profile');
for(const path of [workspace,tempBase,assets,profile])mkdirSync(path);
mkdirSync(join(profile,'.coordination'));
const init=join(assets,'init'),bwrap=join(assets,'bwrap');
writeFileSync(init,'mock-only fixed native asset');writeFileSync(bwrap,'mock-only launcher');
let scenario,last,calls=0;
mock.module(${JSON.stringify(identityPath)},()=>({...actualIdentity,verifyLaunchIdentities(facts){verifyOriginal(facts);const temp=facts.find(f=>f.path.startsWith(tempBase+'/kite-linux-job-'));if(scenario==='preparation-cleanup-unknown'&&temp){renameSync(temp.path,temp.path+'-original');mkdirSync(temp.path);throw Error('confined_launch_changed');}}}));
const p=process.pid+10;
function facts(options){return {version:1,coverage:'linux-pid-namespace',ownerPid:process.pid,admission:{nonce:options.nonce,mode:options.mode},wrapper:{pid:p,birth:'1001',parentPid:process.pid,exit:null,closed:false,stdoutEof:false,stderrEof:false},namespace:{dev:'7',ino:'71',init:{pid:p+1,birth:'1002',parentPid:p,localPid:1,dead:false},root:{pid:p+2,birth:'1003',parentPid:p+1,localPid:2,dead:false,waitReceipt:null},treeStopped:false},phase:'ready',fdClosed:false,closeUnknown:false};}
mock.module(${JSON.stringify(ownerPath)},()=>({...actualOwner,startLinuxOwnedShell(options){
 calls++;assert.equal(options.bubblewrapPath,bwrap);assert.equal(options.initExecutable,init);assert.equal(options.shellExecutable,realpathSync('/bin/sh'));
 assert.deepEqual(options.maskedRoots,[profile]);assert.deepEqual(options.trustedExecutableFiles,[bwrap,init,realpathSync(process.execPath),realpathSync('/bin/sh')]);
 assert.equal(options.cwd,workspace);assert.equal(options.env.LD_PRELOAD,undefined);assert.equal(options.env.BASH_ENV,undefined);assert.equal(options.env.FIXED,'selected');assert.equal(options.env.TMPDIR,options.temp);assert.ok(existsSync(options.temp));
 if(scenario==='before-spawn')throw Error('original_spawn_error');
 if(scenario==='before-spawn-cleanup-unknown'){renameSync(options.temp,options.temp+'-original');mkdirSync(options.temp);throw Error('original_spawn_error');}
 if(scenario==='native-close-unknown')throw new actualOwner.LinuxOwnedShellStartError(Error('original_start_error'),Error('original_close_error'),{nonce:options.nonce,mode:options.mode});
 const stdout=new PassThrough(),stderr=new PassThrough();let resolve;const completion=new Promise(r=>resolve=r);const evidence=facts(options);
 const finish=(reason='natural',code=0,confirmed=true)=>{stdout.end();stderr.end();evidence.wrapper={...evidence.wrapper,exit:{code:0,signal:null,reaped:true},closed:true,stdoutEof:true,stderrEof:true};evidence.namespace.init.dead=true;evidence.namespace.root.dead=true;evidence.namespace.root.waitReceipt={localPid:2,code,signal:null,rawStatus:code*256,waitConfirmed:true,reaped:true};evidence.namespace.treeStopped=true;evidence.fdClosed=confirmed;evidence.closeUnknown=!confirmed;evidence.phase=confirmed?'terminal':'unknown';resolve({confirmed,code,signal:null,reason});};
 last={options,evidence,stdout,stderr,finish};
 return {pid:p,stdout,stderr,ready:Promise.resolve(),completion,cancel(){finish('cancel');return completion;},readProcessEvidence(){return structuredClone(evidence);}};
}}));
const {createLinuxHostShellJob,decodeShellProcessEvidence,shellProcessEvidenceEnded}=await import(${JSON.stringify(jobPath)});
const job=createLinuxHostShellJob({cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:'/original/home',FIXED:'selected',LD_PRELOAD:'forbidden',BASH_ENV:'forbidden'},linux:{bubblewrapPath:bwrap,initExecutable:init},bubblewrapPath:bwrap,bunExecutable:process.execPath,shellExecutable:'/bin/sh',protectedRoots:[profile,join(profile,'.coordination')],readonlyAssets:[assets],temporaryRoot:tempBase,filesystemScope:ctx=>ctx.executionId==='full'?'full_access':'workspace_write',maxQueuedBytes:1024});
const start=(input={command:'original command'},executionId='workspace')=>job.start(input,{sessionId:'s',executionId,signal:new AbortController().signal});
const collect=async handle=>{const all=[];for await(const event of job.observe(handle))all.push(event);return all;};
try {
 for(const input of [{command:'x',cwd:'/'},{command:'x',linux:{}},{command:''}])await assert.rejects(start(input),/invalid_shell_input/);
 assert.equal(calls,0);
 let handle=await start();assert.equal(last.options.mode,'workspace');assert.equal(last.options.command,'original command');assert.equal(last.options.env.HOME,'/original/home');
 const startup=handle.reference.ownedProcesses;assert.equal(startup.owner.phase,'ready');
 const utf8=Buffer.from('👋世界');last.stdout.write(utf8.subarray(0,3));last.stdout.write(utf8.subarray(3));last.stdout.write('x'.repeat(40000));last.stderr.write('original stderr');last.finish('natural',23);
 let events=await collect(handle),terminal=events.at(-1);assert.equal(terminal.result.outcome,'failed');assert.equal(terminal.supervision,'ended');assert.equal(terminal.result.details.exitCode,23);
 assert.equal(events.filter(e=>e.type==='output'&&e.stream==='stdout').map(e=>e.content).join(''),'👋世界');assert.equal(events.filter(e=>e.type==='output_dropped'&&e.stream==='stdout').reduce((n,e)=>n+BigInt(e.bytes),0n),40000n);
 assert.equal(events.filter(e=>e.type==='output'&&e.stream==='stderr').map(e=>e.content).join(''),'original stderr');
 assert.equal(startup.owner.phase,'ready');assert.equal(Object.isFrozen(startup.owner.namespace.root),true);
 const cold=decodeShellProcessEvidence(terminal.result.details.ownedProcesses,{sessionId:'s',executionId:'workspace',nonce:handle.reference.nonce},process.pid);assert.equal(shellProcessEvidenceEnded(cold),true);assert.equal(existsSync(last.options.temp),false);
 await assert.rejects(collect(handle),/shell_observer_already_attached/);assert.equal((await job.cancel(handle)).status,'already_finished');await job.dispose(handle);await job.dispose(handle);
 handle=await start({command:'same public command'},'full');assert.equal(last.options.mode,'full');const observed=collect(handle);assert.equal((await job.cancel(handle)).status,'stopped');terminal=(await observed).at(-1);assert.equal(terminal.result.outcome,'cancelled');assert.equal(terminal.supervision,'ended');await job.dispose(handle);
 handle=await start();last.finish('natural',0,false);terminal=(await collect(handle)).at(-1);assert.equal(terminal.result.outcome,'outcome_unknown');assert.equal(terminal.supervision,'unknown');assert.ok(existsSync(last.options.temp));assert.equal((await job.cancel(handle)).status,'unknown');await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);assert.equal(terminal.result.outcome,'outcome_unknown');
 handle=await start();renameSync(last.options.temp,last.options.temp+'-original');mkdirSync(last.options.temp);last.finish();terminal=(await collect(handle)).at(-1);assert.equal(terminal.supervision,'unknown');assert.equal(terminal.result.details.cleanupConfirmed,false);await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);
 scenario='before-spawn';const before=readdirSync(tempBase);await assert.rejects(start(),/original_spawn_error/);assert.deepEqual(readdirSync(tempBase),before);
 for(scenario of ['native-close-unknown','before-spawn-cleanup-unknown']){handle=await start();terminal=(await collect(handle)).at(-1);assert.equal(terminal.supervision,'unknown');assert.equal(terminal.result.details.ownedProcessesUnavailable,'shell_owned_process_evidence_unavailable');assert.equal((await job.cancel(handle)).status,'unknown');await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);}
 scenario='preparation-cleanup-unknown';const originalCalls=calls;handle=await start();terminal=(await collect(handle)).at(-1);assert.equal(calls,originalCalls);assert.equal(terminal.supervision,'unknown');assert.equal(terminal.result.details.ownedProcessesUnavailable,'shell_owned_process_evidence_unavailable');await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);
} finally {rmSync(root,{recursive:true,force:true});}
process.exit(0);
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    timeout: 4000,
    encoding: 'utf8',
  });
  if (result.status !== 0) console.error(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});
