import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWindowsOwnedChild } from '../../../src/platform/process/windows-owned-child';

test.skipIf(process.platform === 'win32')('Windows owned child import is inert on POSIX', () => {
  expect(() =>
    startWindowsOwnedChild({
      executable: 'C:\\trusted\\child.exe',
      argv: [],
      cwd: 'C:\\work',
      env: {},
      stdin: 'ignore',
    }),
  ).toThrow('windows_owned_child_unsupported');
});

test('Windows original HANDLE/Job creation, stdio completion and unknown close contract', () => {
  const module = fileURLToPath(
    new URL('../../../src/platform/process/windows-owned-child.ts', import.meta.url),
  );
  const code = `
import * as originalFFI from 'bun:ffi';
import {mock} from 'bun:test';
import assert from 'node:assert/strict';
assert.equal(typeof require('bun:ffi').dlopen,'function');
Object.defineProperty(process,'platform',{value:'win32'});
Object.defineProperty(process,'arch',{value:'x64'});
let error=0, next=1n, address=4096, loads=0, assigned=false, resumed=false;
let failClose, failAssign=false, blockedWrite=false, currentRoot;
const handles=new Map(), memory=new Map(), calls=[], writes=[];
const ptr=value=>{const key=address;address+=65536;memory.set(key,value);return key;};
const bytes=value=>memory.get(Number(value));
const take=value=>{const h=next++;handles.set(h,value);return h;};
const sd=()=>{const slot=ptr(Buffer.alloc(32));return BigInt(slot);};
const processes=new Map([[42,{pid:42,birth:134123456789012345n,wait:258}]]);
const kernel={
 GetLastError:()=>error,
 CreateJobObjectW(sa,name){assert.equal(sa,null);assert.equal(name,null);assigned=false;resumed=false;calls.push('job');return Number(take({kind:'job',active:0}));},
 SetInformationJobObject(h,kind,value,size){assert.equal(kind,9);assert.equal(size,144);assert.equal(bytes(value).readUInt32LE(16),0x2000);calls.push('limits');return true;},
 QueryInformationJobObject(h,kind,value,size){assert.equal(kind,1);assert.equal(size,48);bytes(value).writeUInt32LE(handles.get(h).active,40);return true;},
 AssignProcessToJobObject(job,process){calls.push('assign');assert.equal(resumed,false);if(failAssign){error=5;return false;}assigned=true;handles.get(job).active=1;handles.get(process).job=job;return true;},
 TerminateJobObject(job){calls.push('terminate');handles.get(job).active=0;currentRoot.wait=0;return true;},
 InitializeProcThreadAttributeList(list,count,flags,size){assert.equal(count,1);bytes(size)[0]=64n;return list!==null;},
 UpdateProcThreadAttribute(list,flags,attribute,values,size){assert.equal(attribute,0x20002n);assert.equal(size,24n);const hs=bytes(values);assert.equal(hs.length,3);for(const h of hs)assert.ok(handles.get(h).inherit);handles.get(hs[0]).childStdin=true;return true;},
 DeleteProcThreadAttributeList(){calls.push('delete_attributes');},
 CreateProcessW(exe,command,pa,ta,inherit,flags,env,cwd,start,info){
  assert.equal(flags,0x80404);assert.equal(inherit,true);assert.equal(bytes(start).readUInt32LE(0),112);assert.equal(bytes(start).readUInt32LE(60),0x100);
  assert.equal(bytes(exe).toString('utf16le'),'C:\\\\trusted\\\\child.exe\\0');
  assert.equal(bytes(command).toString('utf16le'), '"C:\\\\trusted\\\\child.exe" "a b" "q\\\\"z" "tail\\\\\\\\"\\0');
  assert.equal(bytes(env).toString('utf16le'),'EMPTY=\\0SELECTED=original\\0\\0');
  assert.equal(bytes(cwd).toString('utf16le'),'C:\\\\work\\0');
  calls.push('create_suspended');currentRoot={pid:123,birth:134123456789012999n,wait:258,code:23};
  const root=take(currentRoot),thread=take({kind:'thread'});const p=bytes(info);p.writeBigUInt64LE(root,0);p.writeBigUInt64LE(thread,8);p.writeUInt32LE(123,16);return true;
 },
 ResumeThread(){assert.equal(assigned,true);resumed=true;calls.push('resume');return 1;},
 GetProcessId:h=>handles.get(h).pid,
 GetProcessTimes(h,start){bytes(start)[0]=handles.get(h).birth;return true;},
 WaitForSingleObject(h){const v=handles.get(h);return v.kind==='event'?(v.done?0:258):v.wait;},
 GetExitCodeProcess(h,code){assert.equal(handles.get(h).wait,0);bytes(code)[0]=handles.get(h).code;return true;},
 OpenProcess(access,inherit,pid){assert.equal(access,0x101000);assert.equal(inherit,false);return processes.has(pid)?Number(take(processes.get(pid))):0;},
 TerminateProcess(h){handles.get(h).wait=0;return true;},
 CloseHandle(h){calls.push(['close',h]);if(h===failClose){error=5;return false;}assert.ok(handles.delete(h));return true;},
 CreatePipe(read,write,sa){const pair={data:Buffer.from('完整尾部'),offset:0};bytes(read)[0]=take({kind:'read',pair,inherit:true});bytes(write)[0]=take({kind:'write',pair,inherit:true});return true;},
 SetHandleInformation(h,mask,flags){assert.equal(mask,1);assert.equal(flags,0);handles.get(h).inherit=false;return true;},
 PeekNamedPipe(h,data,size,read,available){const pair=handles.get(h).pair;const count=pair.data.length-pair.offset;if(count){bytes(available)[0]=count;return true;}error=109;return false;},
 ReadFile(h,out,size,read){const pair=handles.get(h).pair;const count=Math.min(size,pair.data.length-pair.offset);pair.data.copy(bytes(out),0,pair.offset,pair.offset+count);pair.offset+=count;bytes(read)[0]=count;return true;},
 CreateNamedPipeW(name,flags,mode,count,out,inSize,timeout,sa){assert.equal(flags,0x40080002);assert.equal(mode,8);assert.equal(count,1);assert.equal(bytes(sa).readUInt32LE(16),0);return Number(take({kind:'stdin',inherit:false}));},
 CreateFileW(name,access,share,sa){assert.equal(bytes(sa).readUInt32LE(16),1);return Number(take({kind:'child_stdin',inherit:true}));},
 ConnectNamedPipe(){error=535;return false;},
 CreateEventW(sa,manual,initial){assert.equal(manual,true);assert.equal(initial,false);return Number(take({kind:'event',done:false}));},
 WriteFile(h,data,size,count,overlap){const op=bytes(overlap),event=op.readBigUInt64LE(24);op.testCount=size;op.testBlocked=blockedWrite;writes.push(Buffer.from(bytes(data).subarray(0,size)));handles.get(event).done=!blockedWrite;error=997;return false;},
 GetOverlappedResult(h,overlap,count,wait){assert.equal(wait,false);const op=bytes(overlap);if(op.testBlocked&&!op.cancelled){error=996;return false;}if(op.cancelled){error=995;return false;}bytes(count)[0]=op.testCount;return true;},
 CancelIoEx(h,overlap){const op=bytes(overlap);op.cancelled=true;handles.get(op.readBigUInt64LE(24)).done=true;calls.push('cancel_io');return true;},
 GetCurrentProcess:()=>999,
 LocalFree(p){memory.delete(Number(p));return 0;},
};
const adv={
 OpenProcessToken(h,access,out){bytes(out)[0]=take({kind:'token'});return true;},
 GetTokenInformation(h,kind,out,size,length){bytes(length)[0]=32;if(out!==null)bytes(out).writeBigUInt64LE(888n,0);return out!==null;},
 ConvertSidToStringSidW(sid,out){bytes(out)[0]=BigInt(ptr(Buffer.from('S-1-5-21-1-2-3-4\\0','utf16le')));return true;},
 ConvertStringSecurityDescriptorToSecurityDescriptorW(text,version,out){assert.equal(bytes(text).toString('utf16le'),'O:S-1-5-21-1-2-3-4D:P(A;;FA;;;S-1-5-21-1-2-3-4)\\0');bytes(out)[0]=sd();return true;},
};
mock.module('bun:ffi',()=>({...originalFFI,ptr,toArrayBuffer(address,offset,length){return bytes(address).buffer.slice(bytes(address).byteOffset+offset,bytes(address).byteOffset+offset+length);},
 dlopen(name){loads++;assert.ok(['kernel32.dll','advapi32.dll'].includes(name));return{symbols:name==='kernel32.dll'?kernel:adv,close(){}};}}));
const {startWindowsOwnedChild,retainWindowsOwnedProcessObservation,WindowsOwnedChildStartError}=await import(${JSON.stringify(module)});
assert.equal(loads,0);
const input={executable:'C:\\\\trusted\\\\child.exe',argv:['a b','q"z','tail\\\\'],cwd:'C:\\\\work',env:{SELECTED:'original',EMPTY:''},stdin:'pipe'};
const child=startWindowsOwnedChild(input);
assert.deepEqual(calls.filter(x=>typeof x==='string').slice(0,5),['job','limits','create_suspended','assign','resume']);
assert.equal(child.pid,123);assert.equal(child.rootCreationTime,'134123456789012999');
assert.equal(child.readEvidence().root.exitCode,null);assert.equal(child.readEvidence().job.treeStopped,false);
assert.ok(Object.isFrozen(child.readEvidence().root));
await child.writeStdin(Buffer.from('original input'));assert.equal(Buffer.concat(writes).toString(),'original input');
const drain=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString();};
assert.equal(await drain(child.stdout),'完整尾部');assert.equal(await drain(child.stderr),'完整尾部');
await assert.rejects(drain(child.stdout),/output_consumer_conflict/);
blockedWrite=true;const pending=child.writeStdin(Buffer.from('cancel this'));const rejected=pending.catch(e=>e);
await new Promise(r=>setTimeout(r,10));
const proof=await child.stop({graceMs:0});assert.equal(proof.root.waitConfirmed,true);assert.equal(proof.root.exitCode,23);assert.equal(proof.job.activeProcesses,0);assert.equal(proof.job.treeStopped,true);
assert.match((await rejected).message,/stdin_write/);assert.ok(calls.includes('cancel_io'));assert.equal(await child.exited,23);
const job=[...handles].find(([,v])=>v.kind==='job')[0];const read=[...handles].find(([,v])=>v.kind==='read')[0];failClose=read;
await assert.rejects(child.close(),/close_unknown/);assert.ok(handles.has(job));assert.equal(child.readEvidence().closed,false);assert.equal(child.readEvidence().closeUnknown,true);
failClose=undefined;await child.close();await child.close();assert.equal(child.readEvidence().closed,true);assert.equal(handles.size,0);
const owner=retainWindowsOwnedProcessObservation(42);assert.equal(owner.creationTime,'134123456789012345');assert.equal(owner.inspect(),'alive');
const first=processes.get(42);processes.set(42,{pid:42,birth:134123456789012346n,wait:258});assert.equal(owner.inspect(),'alive');first.wait=0;assert.equal(owner.inspect(),'dead');owner.close();assert.equal(owner.inspect(),'uncertain');
const unavailable=retainWindowsOwnedProcessObservation(99);assert.equal(unavailable.creationTime,undefined);assert.equal(unavailable.inspect(),'uncertain');unavailable.close();
failAssign=true;const before=calls.filter(x=>x==='resume').length;
let startError;try{startWindowsOwnedChild(input);}catch(error){startError=error;}assert.ok(startError instanceof WindowsOwnedChildStartError);assert.match(startError.cause.message,/assign/);await startError.cleanup;assert.equal(calls.filter(x=>x==='resume').length,before);assert.equal(handles.size,0);
console.log('windows_owned_child_contract_passed');
`;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, BUN_BE_BUN: undefined },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('windows_owned_child_contract_passed');
}, 10000);
