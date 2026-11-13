import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';

const module = pathToFileURL(
  join(import.meta.dirname, '../../../src/jobs/launch-identity.ts'),
).href;
for (const scenario of [
  'sizes-and-short-reads',
  'tail-change',
  'growth',
  'truncate',
  'replace',
  'mode-change',
  'read-failure',
  'cancel-reading',
  'cancel-queued',
  'close-failure',
  'batch-failure',
  'cooperative-yield',
] as const)
  test(`async launch proof retains full bytes and closes its bounded reads: ${scenario}`, async () => {
    const root = temporaryDirectory('kite-async-launch-');
    const code = `import {setTimeout as sleepTimer} from 'node:timers/promises';

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as io from 'node:fs/promises';
import {mock} from '#kite-test';
const original={...io}, root=${JSON.stringify(root)}, scenario=${JSON.stringify(scenario)};
const path=root+'/binary', payload=Buffer.alloc(2*1024*1024+37,97);
payload[payload.length-1]=121;fs.writeFileSync(path,payload,{mode:0o600});
let tracking=false,mutated=false,opened=0,peak=0,reads=[],buffers=new Set(),live=new Set();
let hold=false,release,started=0,unknown,yieldObserved=false;
const blocked=new Promise(resolve=>release=resolve);
mock.module('node:fs/promises',()=>({...original,
 async open(...args){
  const handle=await original.open(...args);opened++;live.add(handle);peak=Math.max(peak,live.size);
  return new Proxy(handle,{get(target,key){
   if(key==='close')return async()=>{
    if(scenario==='close-failure'&&!unknown){unknown=target;throw Error('fixture_close_failed');}
    try{await target.close();}finally{live.delete(target);}
   };
   if(key==='read')return async(buffer,offset,length,position)=>{
    buffers.add(buffer);const observation={allocation:buffer.byteLength,requested:length,count:null};reads.push(observation);
    if(scenario==='read-failure'&&reads.length===2)throw Error('fixture_read_failed');
    if(scenario==='cooperative-yield'&&reads.length===1)setImmediate(()=>yieldObserved=true);
    const result=scenario==='cooperative-yield'
     ?{bytesRead:fs.readSync(target.fd,buffer,offset,Math.min(length,17311),position)}
     :await target.read(buffer,offset,Math.min(length,17311),position);
    observation.count=result.bytesRead;
    if(scenario==='cooperative-yield'&&result.bytesRead===0)
     assert.equal(yieldObserved,true,'completed I/O promises must yield a real event-loop turn before EOF');
    if(hold){started++;await blocked;}
    if(tracking&&!mutated&&result.bytesRead){
     mutated=true;
     if(scenario==='growth')fs.appendFileSync(path,'grown');
     if(scenario==='truncate')fs.truncateSync(path,3);
     if(scenario==='replace'){fs.renameSync(path,path+'.old');fs.writeFileSync(path,payload,{mode:0o600});}
     if(scenario==='mode-change')fs.chmodSync(path,0o400);
    }
    return result;
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 }
}));
const {launchIdentityAsync,verifyLaunchIdentitiesAsync,mapAssetVerification}=await import(${JSON.stringify(module)});
const until=async read=>{const deadline=Date.now()+3000;while(!read()){if(Date.now()>deadline)throw Error('fixture_deadline');await sleepTimer(1);}};
if(scenario==='sizes-and-short-reads'){
 for(const size of [0,1,65536,payload.length]){
  fs.writeFileSync(path,payload.subarray(0,size));reads=[];buffers.clear();tracking=true;
  const identity=await launchIdentityAsync(path,true);tracking=false;
  assert.equal(identity.digest,createHash('sha256').update(payload.subarray(0,size)).digest('hex'));
  assert.equal(reads.at(-1).count,0,'must observe real EOF');assert.equal(buffers.size,1,'one private scratch');
  assert.ok(reads.every(read=>read.allocation<=Math.max(1,Math.min(size,1048576))));
  assert.equal(live.size,0);
 }
}else if(scenario==='cooperative-yield'){
 const identity=await launchIdentityAsync(path,true);
 assert.equal(identity.digest,createHash('sha256').update(payload).digest('hex'));
}else if(scenario==='tail-change'){
 const fact=await launchIdentityAsync(path,true);const fd=fs.openSync(path,'r+');
 try{fs.writeSync(fd,Buffer.from('z'),0,1,payload.length-1);}finally{fs.closeSync(fd);}
 await assert.rejects(verifyLaunchIdentitiesAsync([fact]),/confined_launch_changed/);
 assert.notEqual((await launchIdentityAsync(path,true)).digest,fact.digest);
}else if(scenario==='cancel-reading'){
 const abort=new AbortController(),reason=Error('cancel-original');hold=true;let settled=false;
 const pending=launchIdentityAsync(path,true,abort.signal);pending.then(()=>settled=true,()=>settled=true);
 await until(()=>started===1);abort.abort(reason);await sleepTimer(10);
 assert.equal(settled,false,'do not release an FD while its read is still in flight');assert.equal(live.size,1);
 hold=false;release();await assert.rejects(pending,error=>error===reason);assert.equal(live.size,0);
 assert.equal((await launchIdentityAsync(path,true)).digest,createHash('sha256').update(payload).digest('hex'));
}else if(scenario==='cancel-queued'){
 hold=true;const active=Array.from({length:8},()=>launchIdentityAsync(path,true));
 await until(()=>started===8);assert.equal(peak,8);
 const abort=new AbortController(),reason=Error('cancel-queued-original');
 const queued=launchIdentityAsync(path,true,abort.signal);abort.abort(reason);
 await assert.rejects(queued,error=>error===reason);assert.equal(opened,8,'a cancelled waiter must not open a file');
 let admitted=false;const next=launchIdentityAsync(path,true).then(value=>{admitted=true;return value;});
 await sleepTimer(10);assert.equal(admitted,false);assert.equal(opened,8);
 hold=false;release();await Promise.all([...active,next]);assert.ok(peak<=8);assert.equal(live.size,0);
}else if(scenario==='close-failure'){
 await assert.rejects(launchIdentityAsync(path,true),/confined_launch_close_unknown/);
 assert.equal(live.size,1,'retain the original unknown FD');
 hold=true;const active=Array.from({length:7},()=>launchIdentityAsync(path,true));
 await until(()=>started===7);assert.equal(peak,8);
 const abort=new AbortController();const queued=launchIdentityAsync(path,true,abort.signal);
 await sleepTimer(10);assert.equal(opened,8,'unknown close must retain its resource permit');
 abort.abort(Error('cancel-after-unknown'));await assert.rejects(queued,/cancel-after-unknown/);
 hold=false;release();await Promise.all(active);assert.equal(live.size,1);
 await unknown.close();live.delete(unknown);
}else if(scenario==='batch-failure'){
 hold=true;let failed=false,settled=false;
 const pending=mapAssetVerification(Array.from({length:24},(_,i)=>i),async(i,signal)=>{
  if(i===7){await until(()=>started===7);failed=true;throw Error('batch-original');}
  return await launchIdentityAsync(path,true,signal);
 });
 pending.then(()=>settled=true,()=>settled=true);
 await until(()=>failed);await sleepTimer(10);
 assert.equal(settled,false);assert.equal(live.size,7);assert.equal(opened,7);
 hold=false;release();await assert.rejects(pending,/batch-original/);
 assert.equal(opened,7,'failed batch stops claiming later work');assert.equal(live.size,0);
 assert.equal((await launchIdentityAsync(path,true)).digest,createHash('sha256').update(payload).digest('hex'));
}else{
 tracking=true;await assert.rejects(launchIdentityAsync(path,true),scenario==='read-failure'?/fixture_read_failed/:/confined_launch_changed/);
}
assert.equal(live.size,0,'success, failure and cancellation close every original FD');
if(fs.existsSync(path))fs.chmodSync(path,0o600);
console.log('async_launch_proof_passed');
`;
    try {
      const child = spawnProcess(
        [process.execPath, ...testRuntimeFlags, '--input-type=module-typescript', '--eval', code],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          windowsHide: true,
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      expect(stdout.trim()).toBe('async_launch_proof_passed');
    } finally {
      removeTemporaryDirectory(root);
    }
  }, 10000);
