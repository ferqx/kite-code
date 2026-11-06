import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('trusted Linux Job waits for adapter drain and cleanup before cancellation or disposal', () => {
  const base = fileURLToPath(new URL('../../../src/', import.meta.url));
  const source = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {PassThrough} from 'node:stream';
const base=${JSON.stringify(base)};
const ownerPath=base+'platform/process/linux-owned-shell.ts',prepPath=base+'jobs/linux-preparation.ts';
const originalOwner=await import(ownerPath),originalPrep=await import(prepPath);
let last;
mock.module(prepPath,()=>({...originalPrep,captureLinuxLaunch(){return ()=>({cwd:'/mock/cwd',temp:'/mock/temp',mode:'workspace',profileDigest:'mock',preserveHostHome:true,bubblewrapPath:'/mock/bwrap',bubblewrapArgs:[],executablePaths:['/mock/init','/mock/bun','/bin/sh'],noExecPaths:[],trustedExecutableFiles:[],maskedRoots:[],cleanup(){last.cleanupCalls++;if(last.cleanupFails)throw Error('test_cleanup_unknown');}});}}));
mock.module(ownerPath,()=>({...originalOwner,startLinuxOwnedShell(options){
 const p=process.pid+10,stdout=new PassThrough(),stderr=new PassThrough();
 let resolve;const completion=new Promise(r=>resolve=r);
 const evidence={version:1,coverage:'linux-pid-namespace',ownerPid:process.pid,admission:{nonce:options.nonce,mode:options.mode},wrapper:{pid:p,birth:'1001',parentPid:process.pid,exit:null,closed:false,stdoutEof:false,stderrEof:false},namespace:{dev:'7',ino:'71',init:{pid:p+1,birth:'1002',parentPid:p,localPid:1,dead:false},root:{pid:p+2,birth:'1003',parentPid:p+1,localPid:2,dead:false,waitReceipt:null},treeStopped:false},phase:'ready',fdClosed:false,closeUnknown:false};
 const owner={stdout,stderr,cleanupCalls:0,cancelCalls:0,cleanupFails:false,confirmed:true,finished:false,finish(reason='natural'){
  if(owner.finished)return;owner.finished=true;stdout.end();stderr.end();
  // The actual owner returns its original completion, after both output EOFs.
  setImmediate(()=>{evidence.wrapper={...evidence.wrapper,exit:{code:0,signal:null,reaped:true},closed:true,stdoutEof:true,stderrEof:true};evidence.namespace.init.dead=true;evidence.namespace.root.dead=true;evidence.namespace.root.waitReceipt={localPid:2,code:0,signal:null,rawStatus:0,waitConfirmed:true,reaped:true};evidence.namespace.treeStopped=true;evidence.fdClosed=owner.confirmed;evidence.closeUnknown=!owner.confirmed;evidence.phase=owner.confirmed?'terminal':'unknown';resolve({confirmed:owner.confirmed,code:0,signal:null,reason});});
 }};
 last=owner;
 return {pid:p,stdout,stderr,ready:Promise.resolve(),completion,cancel(){owner.cancelCalls++;owner.finish('cancel');return completion;},readProcessEvidence(){return structuredClone(evidence);}};
}}));
const {createLinuxShellJob}=await import(base+'jobs/linux-shell.ts');
const job=createLinuxShellJob({cwd:'/mock/cwd',env:{},initExecutable:'/mock/init',bubblewrapPath:'/mock/bwrap',bunExecutable:'/mock/bun',shellExecutable:'/bin/sh',protectedRoots:[],filesystemScope:'workspace_write',mode:'host',trustedWorkerLaunch:()=>({version:1,digest:'mock',env:{},bunFlags:[]})});
const start=()=>job.start({command:'fixed trusted command'},{sessionId:'s',executionId:crypto.randomUUID(),signal:new AbortController().signal});
const collect=async handle=>{const events=[];for await(const event of job.observe(handle))events.push(event);return events;};
for(const mode of ['dispose-only','serial','parallel']){
 const handle=await start(),owner=last;
 if(mode==='dispose-only')await job.dispose(handle);
 else if(mode==='serial'){assert.equal((await job.cancel(handle)).status,'stopped');await job.dispose(handle);}
 else {const [confirmation]=await Promise.all([job.cancel(handle),job.dispose(handle)]);assert.equal(confirmation.status,'stopped');}
 assert.equal(owner.cleanupCalls,1);await job.dispose(handle);assert.equal((await job.cancel(handle)).status,'already_finished');
 const terminal=(await collect(handle)).at(-1);assert.equal(terminal.result.outcome,'cancelled');assert.equal(terminal.supervision,'ended');assert.equal(terminal.result.details.cleanupConfirmed,true);
}
{
 const handle=await start(),owner=last,utf8=Buffer.from('👋世界');
 owner.stdout.write(utf8.subarray(0,3));owner.stdout.write(utf8.subarray(3));owner.stdout.write('x'.repeat(65536));owner.stderr.write('stderr complete');owner.finish();
 const events=await collect(handle),terminal=events.at(-1);
 assert.equal(events.filter(e=>e.type==='output'&&e.stream==='stdout').map(e=>e.content).join(''),'👋世界'+'x'.repeat(65536));
 assert.equal(events.filter(e=>e.type==='output'&&e.stream==='stderr').map(e=>e.content).join(''),'stderr complete');assert.equal(events.some(e=>e.type==='output_dropped'),false);assert.equal(terminal.result.outcome,'succeeded');await job.dispose(handle);assert.equal(owner.cleanupCalls,1);
}
for(const bytes of [Buffer.from([0xff]),Buffer.from([0xf0,0x9f])]){
 const handle=await start(),owner=last;owner.stdout.write(bytes);owner.finish();
 const terminal=(await collect(handle)).at(-1);assert.equal(terminal.result.outcome,'failed');assert.equal(terminal.result.content,'shell_output_invalid_utf8');assert.equal(terminal.supervision,'ended');await job.dispose(handle);assert.equal(owner.cleanupCalls,1);
}
for(const fault of ['native-unknown','cleanup-unknown']){
 const handle=await start(),owner=last;
 if(fault==='native-unknown')owner.confirmed=false;else owner.cleanupFails=true;
 assert.equal((await job.cancel(handle)).status,'unknown');
 const terminal=(await collect(handle)).at(-1);assert.equal(terminal.result.outcome,'outcome_unknown');assert.equal(terminal.supervision,'unknown');assert.equal(terminal.result.details.cleanupConfirmed,false);
 const first=job.dispose(handle);await assert.rejects(first,/shell_owned_cleanup_unconfirmed/);
 const cancels=owner.cancelCalls;await assert.rejects(job.dispose(handle),/shell_owned_cleanup_unconfirmed/);assert.equal(owner.cancelCalls,cancels+1);
 assert.equal(owner.cleanupCalls,fault==='native-unknown'?0:1);
}
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) console.error(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});
