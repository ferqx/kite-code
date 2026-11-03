import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Darwin owner keeps malformed control sticky across later valid terminal and stream closure', () => {
  const owner = fileURLToPath(
    new URL('../../../src/tools/browser/darwin-owner.ts', import.meta.url),
  );
  const observation = fileURLToPath(
    new URL('../../../src/platform/process/owned-process-observation.ts', import.meta.url),
  );
  // Private subprocess mocks only the OS boundary; it starts no guardian or browser.
  const source = String.raw`
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
let child;
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms===5001?20:ms,...args);
const identity=(pid,parentPid)=>({pid,parentPid,birth:{seconds:'123',microseconds:456},unavailable:[]});
globalThis.fixtureSpawn=()=>{child=Object.assign(new EventEmitter(),{pid:101,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});return child;};
mock.module(${JSON.stringify(observation)},()=>({observeOwnedProcessIdentity:()=>identity(101,process.pid),isOwnedProcessIdentity:(v,pid,parent)=>v?.pid===pid&&v?.parentPid===parent,ownedProcessKernelState:()=> 'absent'}));
// Bun's native child_process named binding bypasses mock.module. Replace only
// that import in a private source copy; the owner state machine is unchanged.
const directory=mkdtempSync(tmpdir()+'/kite-owner-control-');
const original=readFileSync(${JSON.stringify(owner)},'utf8');
assert.ok(original.includes("import { spawn } from 'node:child_process';"));
assert.ok(original.includes("'../../platform/process/owned-process-observation'"));
const instrumented=original.replace("import { spawn } from 'node:child_process';",'const spawn = globalThis.fixtureSpawn;').replace("'../../platform/process/owned-process-observation'",JSON.stringify(${JSON.stringify(observation)}));
assert.notEqual(original,instrumented);
writeFileSync(directory+'/owner.ts',instrumented);
const {startDarwinBrowserOwner}=await import(directory+'/owner.ts');
for(const mode of ['cancel-before-ready','cancel-invalid-ready','cancel-invalid-then-ready','cancel-after-unknown','valid','after-terminal','partial','before-terminal','guardian-reaped','duplicate-terminal']){
 const owner=startDarwinBrowserOwner({guardianPath:'/fixture/guardian.js',bunExecutable:'/fixture/bun',executable:'/fixture/daemon',cwd:'/fixture',env:{},nonce:'nonce',graceMs:1,startupTimeoutMs:1000});
 const record=(pid,parent)=>({...identity(pid,parent),exit:null,kernelState:'alive'});
 const guardian=record(102,1),server=record(103,102),registration={label:'com.kitecode.browser.11111111-1111-1111-1111-111111111111',domain:'user/'+process.getuid(),removed:false};
 let sequence=0;
 const send=(frame)=>child.stdout.write(JSON.stringify({nonce:'nonce',sequence:++sequence,...frame})+'\n');
 const publicReady=owner.ready.then(()=>true,()=>false);
 const cancelled=mode.startsWith('cancel-');
 if(cancelled)void owner.cancel();
 if(mode==='cancel-after-unknown')assert.equal((await owner.completion).confirmed,false);
 const ready={type:'ready',broker:identity(101,process.pid),guardian,server,guardianPid:102,processGroupId:103,coalition:{pid:102,coalitionId:'7',uniqueId:'8',pidVersion:9},registration};
 if(mode==='cancel-invalid-ready'||mode==='cancel-invalid-then-ready')send({...ready,guardian:{...guardian,birth:null}});
 if(mode!=='cancel-invalid-ready')send(ready);
 assert.equal(await publicReady,!cancelled);
 if(mode==='before-terminal')send({type:'invalid'});
 const terminal={type:'terminal',guardian:mode==='guardian-reaped'?{...guardian,exit:{code:0,signal:null,reaped:true}}:guardian,server:{...server,exit:{code:0,signal:null,reaped:true}},registration:{...registration,removed:true},registrationRemoved:true,groupStopped:true,processTreeStopped:true,terminalTaskCount:1};
 send(terminal);
 if(mode==='after-terminal')send({type:'invalid'});
 if(mode==='duplicate-terminal')send(terminal);
 if(mode==='partial')child.stdout.write('{');
 child.stdout.end();child.stderr.end();
 await new Promise(resolve=>setImmediate(resolve));
 child.stdin.destroy();child.emit('exit',0,null);child.emit('close');
 const confirmed=mode==='valid'||mode==='cancel-before-ready';
 assert.equal((await owner.completion).confirmed,confirmed,mode);
 assert.equal(owner.readProcessEvidence().phase,confirmed?'terminal':'unknown',mode);
}
rmSync(directory,{recursive:true});
console.log('darwin-owner-sticky-control-verified');
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('darwin-owner-sticky-control-verified');
});
