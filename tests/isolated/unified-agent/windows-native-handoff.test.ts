import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows Native certificate binds original creator and actual child, retaining unknown pipe closes', () => {
  const leaf = fileURLToPath(
    new URL('../../../apps/service/src/windows-native-bootstrap.ts', import.meta.url),
  );
  const parent = fileURLToPath(
    new URL('../../../apps/service/src/windows-native-parent.ts', import.meta.url),
  );
  const security = fileURLToPath(
    new URL('../../../apps/service/src/daemon/windows-security.ts', import.meta.url),
  );
  const processes = fileURLToPath(
    new URL('../../../apps/service/src/daemon/windows-process.ts', import.meta.url),
  );
  const code = `
import {mock} from 'bun:test';import assert from 'node:assert/strict';
assert.equal(typeof require('bun:ffi').dlopen,'function');
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
let next=1n,lastError=0,serverPID=77,peerPID=777,certPID=123,certBirth=100n,failClose,closedParents=0,closedChildren=0,loaded=0;
let connected=false,cancelled=false,readOffset=0,processAlive=true,blockConnect=false;
const handles=new Map(),operations=new Map(),writes=[],calls=[];
const alloc=kind=>{const h=next++;handles.set(h,kind);return h;};
mock.module(${JSON.stringify(parent)},()=>({retainWindowsNativeLauncherParent(prefix,kind){assert.equal(prefix,'C:\\\\Original');assert.equal(kind,'desktop');return Object.freeze({parentPid:77,parentCreationTime:50n,selfPid:123,selfCreationTime:100n,verify(){assert.ok(processAlive);},release(){closedParents++;}});}}));
mock.module(${JSON.stringify(security)},()=>({windowsDaemonSecurity:()=>({descriptor(directory){assert.equal(directory,false);return {attributes:new Uint8Array(24),close(){calls.push('descriptor-close');}};},verifyPipe(h){assert.equal(handles.get(h),'pipe');calls.push('security');}})}));
mock.module(${JSON.stringify(processes)},()=>({retainWindowsProcess(pid){assert.equal(pid,777);const originalBirth=700n;return {identity:'windows:filetime:'+originalBirth,inspect:()=>processAlive?'alive':'dead',close(){closedChildren++;}};}}));
const frame=()=>{const b=new Uint8Array(32),v=new DataView(b.buffer);b.set(Buffer.from('KITELCH1'));v.setUint32(8,certPID,true);v.setBigUint64(16,certBirth,true);return b;};
const symbols={
GetLastError:()=>lastError,
CreateFileW(name,access,share,sa,creation,flags,template){assert.equal(access,0x120089);assert.equal(share,0);assert.equal(sa,null);assert.equal(creation,3);assert.equal(flags,0x40110000);assert.equal(template,0);readOffset=0;return alloc('pipe');},
CreateNamedPipeW(name,flags,mode,max,outSize,inSize,timeout,sa){assert.equal(flags,3|0x40000000|0x80000);assert.equal(mode,8);assert.equal(max,1);assert.equal(outSize,32);assert.equal(inSize,1);assert.equal(timeout,5000);assert.equal(sa.length,24);connected=false;cancelled=false;return alloc('pipe');},
CreateEventW(sa,manual,initial,name){assert.equal(sa,null);assert.equal(manual,true);assert.equal(initial,false);assert.equal(name,null);return alloc('event');},
ConnectNamedPipe(h,ov){assert.equal(handles.get(h),'pipe');operations.set(ov,'connect');lastError=997;return false;},
GetOverlappedResult(h,ov,count,wait){assert.equal(wait,false);assert.ok(handles.has(h));if(cancelled){lastError=995;operations.delete(ov);return false;}if(operations.get(ov)==='connect'){if(blockConnect){lastError=996;return false;}connected=true;operations.delete(ov);count[0]=0;return true;}assert.fail('unexpected operation');},
CancelIoEx(h,ov){assert.ok(handles.has(h));cancelled=true;calls.push('cancel');return true;},
ReadFile(h,bytes,size,count,ov){assert.equal(handles.get(h),'pipe');if(connected){assert.equal(size,1);lastError=109;return false;}const original=frame(),n=Math.min(size,7,32-readOffset);bytes.set(original.subarray(readOffset,readOffset+n));readOffset+=n;count[0]=n;return true;},
WriteFile(h,bytes,size,count,ov){assert.equal(handles.get(h),'pipe');const n=Math.min(size,9);writes.push(bytes.slice(0,n));count[0]=n;return true;},
GetNamedPipeServerProcessId(h,pid){assert.equal(handles.get(h),'pipe');pid[0]=serverPID;return true;},
GetNamedPipeClientProcessId(h,pid){assert.equal(handles.get(h),'pipe');pid[0]=peerPID;return true;},
DisconnectNamedPipe(h){assert.equal(handles.get(h),'pipe');calls.push('disconnect');return true;},
CloseHandle(h){assert.ok(handles.has(h));if(h===failClose)return false;handles.delete(h);return true;}
};
mock.module('bun:ffi',()=>({ptr:value=>value,dlopen(name){assert.equal(name,'kernel32.dll');loaded++;return {symbols};}}));
const {retainWindowsNativeLaunchCertificate,createWindowsNativeMainHandoff}=await import(${JSON.stringify(leaf)});
assert.equal(loaded,0);
const pipe=String.raw\`\\\\.\\pipe\\kite-native-launch-0123456789abcdef0123456789abcdef\`;
const original=await retainWindowsNativeLaunchCertificate('C:\\\\Original','desktop',pipe);
assert.equal(handles.size,0);assert.equal(closedParents,0);original.verify();original.release();original.release();assert.equal(closedParents,1);
serverPID=78;await assert.rejects(retainWindowsNativeLaunchCertificate('C:\\\\Original','desktop',pipe),/creator_mismatch/);serverPID=77;assert.equal(handles.size,0);
certPID=124;await assert.rejects(retainWindowsNativeLaunchCertificate('C:\\\\Original','desktop',pipe),/invalid_certificate/);certPID=123;
certBirth=101n;await assert.rejects(retainWindowsNativeLaunchCertificate('C:\\\\Original','desktop',pipe),/invalid_certificate/);certBirth=100n;
const main=createWindowsNativeMainHandoff();assert.match(main.pipe,/^\\\\\\\\\\.\\\\pipe\\\\kite-native-main-[a-f0-9]{32}$/);main.bind(777);assert.throws(()=>main.bind(777),/child_mismatch/);
await new Promise(r=>setTimeout(r,30));assert.ok(calls.includes('disconnect'));
const received=Buffer.concat(writes);assert.equal(received.length,32);assert.equal(received.subarray(0,8).toString(),'KITEMAI1');assert.equal(received.readUInt32LE(8),777);assert.equal(received.readUInt32LE(12),0);assert.equal(received.readBigUInt64LE(16),700n);assert.equal(received.readBigUInt64LE(24),0n);
failClose=[...handles].find(([h,kind])=>kind==='pipe')[0];await assert.rejects(main.close(),/close_unknown/);assert.equal(closedChildren,0);assert.equal(handles.get(failClose),'pipe');failClose=undefined;await main.close();await main.close();assert.equal(closedChildren,1);assert.equal(handles.size,0);
blockConnect=true;const early=createWindowsNativeMainHandoff();await early.close();blockConnect=false;assert.equal(handles.size,0);assert.ok(calls.includes('cancel'));
peerPID=778;const foreign=createWindowsNativeMainHandoff();foreign.bind(777);await new Promise(r=>setTimeout(r,30));await assert.rejects(foreign.close(),/close_unknown/);assert.equal(handles.size,0);peerPID=777;
const before=closedParents;failClose=next;await assert.rejects(retainWindowsNativeLaunchCertificate('C:\\\\Original','desktop',pipe),/close_unknown/);assert.equal(closedParents,before);assert.equal(handles.get(failClose),'pipe');
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(
      `Windows Native handoff mock failed: ${child.error?.message ?? ''}\n${child.stderr}`,
    );
  expect(child.status).toBe(0);
});
