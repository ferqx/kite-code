import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows Native launcher binds the kernel creator and original birth, retaining unknown closes', () => {
  const module = fileURLToPath(
    new URL('../../../apps/service/src/windows-native-parent.ts', import.meta.url),
  );
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
assert.equal(typeof require('bun:ffi').dlopen,'function');
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
const canonical=value=>value;canonical.native=canonical;
mock.module('node:fs',()=>({...fs,realpathSync:canonical}));
let next=1n,created=50n,selfCreated=100n,signal=258,foreign=false,failClose,loaded=0;
const live=new Map(),calls=[];
const alloc=kind=>{const h=next++;live.set(h,kind);return h;};
const prefix=String.raw\`C:\\Original\`, image=String.raw\`C:\\Original\\bin\\kite.exe\`;
const symbols={
 GetCurrentProcess:()=>999n,GetCurrentProcessId:()=>123,
 CreateToolhelp32Snapshot(flags,pid){assert.equal(flags,2);assert.equal(pid,0);return alloc('snapshot');},
 Process32FirstW(h,bytes){assert.equal(live.get(h),'snapshot');assert.equal(bytes.length,568);const v=new DataView(bytes.buffer);assert.equal(v.getUint32(0,true),568);v.setUint32(8,456,true);v.setUint32(32,789,true);return true;},
 Process32NextW(h,bytes){assert.equal(live.get(h),'snapshot');const v=new DataView(bytes.buffer);v.setUint32(8,123,true);v.setUint32(32,77,true);return true;},
 OpenProcess(access,inherit,pid){assert.equal(access,0x101000);assert.equal(inherit,false);assert.equal(pid,77);return alloc('parent');},
 GetProcessTimes(h,birth){assert.ok(h===999n||live.get(h)==='parent');birth[0]=h===999n?selfCreated:created;return true;},
 QueryFullProcessImageNameW(h,flags,bytes,count){assert.equal(live.get(h),'parent');assert.equal(flags,0);const value=foreign?String.raw\`C:\\Foreign\\kite.exe\`:image;for(let i=0;i<value.length;i++)bytes[i]=value.charCodeAt(i);count[0]=value.length;return true;},
 WaitForSingleObject(h,timeout){assert.equal(live.get(h),'parent');assert.equal(timeout,0);return signal;},
 CloseHandle(h){assert.notEqual(h,999n);assert.ok(live.has(h));calls.push(['close',h]);if(h===failClose)return false;live.delete(h);return true;}
};
mock.module('bun:ffi',()=>({ptr:value=>value,dlopen(name){assert.equal(name,'kernel32.dll');loaded++;return {symbols};}}));
const {retainWindowsNativeLauncherParent}=await import(${JSON.stringify(module)});
assert.equal(loaded,0);
const original=retainWindowsNativeLauncherParent(prefix,'cli');assert.equal(loaded,1);assert.deepEqual([...live.values()],['parent']);assert.ok(Object.isFrozen(original));assert.equal(original.parentPid,77);assert.equal(original.parentCreationTime,50n);assert.equal(original.selfPid,123);assert.equal(original.selfCreationTime,100n);original.verify();
signal=0;assert.throws(()=>original.verify(),/identity_mismatch/);signal=258;original.verify();
failClose=[...live.keys()][0];assert.throws(()=>original.release(),/close_unknown/);assert.equal(live.size,1);failClose=undefined;original.release();original.release();assert.equal(live.size,0);
created=200n;assert.throws(()=>retainWindowsNativeLauncherParent(prefix,'cli'),/identity_mismatch/);assert.equal(live.size,0);created=50n;
foreign=true;assert.throws(()=>retainWindowsNativeLauncherParent(prefix,'cli'),/identity_mismatch/);assert.equal(live.size,0);foreign=false;
failClose=next;assert.throws(()=>retainWindowsNativeLauncherParent(prefix,'cli'),/close_unknown/);assert.deepEqual([...live.values()],['snapshot']);assert.ok(calls.filter(c=>c[1]===failClose).length>=2);
`;
  const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 4000 });
  if (child.status !== 0)
    throw Error(
      `Windows Native parent mock failed: ${child.error?.message ?? ''}\n${child.stderr}`,
    );
  expect(child.status).toBe(0);
});
