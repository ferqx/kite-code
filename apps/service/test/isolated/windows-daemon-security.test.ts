import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../../src/daemon/windows-security.ts', import.meta.url));
test('Node imports the security leaf without native loading or directory creation', () => {
  const javascript = new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(
    readFileSync(modulePath, 'utf8'),
  );
  const code = `${javascript}
import assert from 'node:assert/strict';
assert.equal(process.versions.bun, undefined);
assert.equal(typeof windowsDaemonSecurity, 'function');
Object.defineProperty(process, 'platform', { value: 'linux' });
assert.throws(() => windowsDaemonSecurity(), /daemon_platform_unsupported/);
console.log('node_inert_security_import');`;
  const result = spawnSync('node', ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 3000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('node_inert_security_import');
}, 5000);

test('lazy CJS Windows security binds TOKEN_USER, exact private descriptors and unknown LocalFree', () => {
  const code = `
import * as nativeFFI from 'bun:ffi';
import * as fs from 'node:fs';
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
assert.equal(typeof require('bun:ffi').dlopen, 'function');
let loads = [], writes = 0, nextDescriptor = 20000, failFree, badOwner = false, protectedAcl = true, directory = false, badMask = false;
let tokenUser;
const allocations = new Set(), freed = [], descriptors = [], handles = new Set();
const sidText = 'S-1-5-21-100-200-300-400';
const base = String.raw\`C:\\Users\\Owner\\AppData\\Local\`;
const system = String.raw\`C:\\Windows\\System32\`;
const folder = Buffer.from(base + '\\0', 'utf16le');
const acl = new ArrayBuffer(8), ace = new ArrayBuffer(12);
const symbols = {
 GetCurrentProcess: () => 99n,
 GetSystemDirectoryW(bytes, capacity) { assert.equal(capacity, 32768); for (let i=0;i<system.length;i++) bytes[i]=system.charCodeAt(i); return system.length; },
 OpenProcessToken(process, rights, output) { assert.equal(process, 99n); assert.equal(rights, 8); output[0]=42n; handles.add(42n); return true; },
 GetTokenInformation(token, kind, bytes, length, size) { assert.equal(token, 42n); assert.equal(kind, 1);
   if (!bytes) { assert.equal(length, 0); size[0]=16; return false; }
   assert.equal(length, 16); tokenUser = new WeakRef(bytes); new DataView(bytes.buffer).setBigUint64(0, 1000n, true); size[0]=16; return true; },
 ConvertSidToStringSidA(sid, output) { assert.equal(sid,1000); output[0]=2000n; allocations.add(2000); return true; },
 CloseHandle(handle) { assert.equal(handle,42n); assert.ok(handles.delete(handle)); return true; },
 LocalFree(address) { assert.ok(allocations.has(address)); if (failFree === address) return address; allocations.delete(address); freed.push(address); return 0; },
 SHGetKnownFolderPath(guid, flags, token, output) {
   assert.equal(Buffer.from(guid).toString('hex'), '8527b3f1ba6fcf4f9d557b8e7f157091');
   assert.equal(flags,0x4000); assert.equal(token,0); output[0]=9000n; allocations.add(9000); return 0; },
 CoTaskMemFree(address) { assert.equal(address,9000); assert.ok(allocations.delete(address)); freed.push(address); },
 ConvertStringSecurityDescriptorToSecurityDescriptorW(bytes, version, output, size) {
   assert.equal(version,1); assert.equal(size,null); const text=Buffer.from(bytes).toString('utf16le');
   assert.ok(text.endsWith('\\0')); descriptors.push(text.slice(0,-1)); const address=nextDescriptor++; output[0]=BigInt(address); allocations.add(address); return true; },
 GetSecurityInfo(handle, kind, information, owner, group, dacl, sacl, output) {
   assert.equal(handle,123n); assert.equal(kind,1); assert.equal(information,5); assert.equal(group,null); assert.equal(sacl,null);
   assert.equal(new DataView(tokenUser.deref().buffer).getBigUint64(0,true),1000n);
   owner[0]=badOwner?1001n:1000n; dacl[0]=3000n; output[0]=7000n; assert.ok(!allocations.has(7000)); allocations.add(7000); return 0; },
 EqualSid(first, second) { assert.equal(second,1000); return first===1000 || first===4008; },
 GetSecurityDescriptorControl(address, control, revision) { assert.equal(address,7000); control[0]=protectedAcl?0x1004:4; revision[0]=1; return true; },
 GetAce(address, index, output) { assert.equal(address,3000); assert.equal(index,0); output[0]=4000n; return true; },
};
mock.module('node:fs', () => ({ ...fs,
 mkdirSync() { writes++; throw Error('unexpected_fs_write'); }, writeFileSync() { writes++; throw Error('unexpected_fs_write'); },
 openSync() { writes++; throw Error('unexpected_fs_open'); }, chmodSync() { writes++; throw Error('unexpected_fs_chmod'); },
}));
mock.module('bun:ffi', () => ({ ...nativeFFI, ptr: value=>value,
 CString: class { constructor(address) { assert.equal(address,2000); } toString() { return sidText; } },
 toArrayBuffer(address, offset, length) {
   if (address===9000) return folder.buffer.slice(folder.byteOffset+offset,folder.byteOffset+offset+length);
   if (address===3000) { new DataView(acl).setUint16(4,1,true); return acl; }
   assert.equal(address,4000); const view=new DataView(ace); view.setUint8(0,0); view.setUint8(1,directory?3:0);
   view.setUint16(2,12,true); view.setUint32(4,badMask?0x120089:0x1f01ff,true); return ace;
 },
 dlopen(name) { loads.push(name); return { symbols, close() { throw Error('premature_library_close'); } }; },
}));
const { windowsDaemonSecurity } = await import(${JSON.stringify(modulePath)});
assert.equal(loads.length,0); assert.equal(writes,0);
Object.defineProperty(process,'platform',{value:'win32'}); Object.defineProperty(process,'arch',{value:'x64'});
const security=windowsDaemonSecurity(); assert.equal(windowsDaemonSecurity(),security);
assert.deepEqual(loads,['kernel32.dll',system+'\\\\advapi32.dll',system+'\\\\shell32.dll',system+'\\\\ole32.dll']);
assert.equal(security.sidText,sidText);
assert.equal(security.recordBase,win32.join(base,'kite-daemon-'+createHash('sha256').update(sidText).digest('hex'),'v1'));
assert.equal(handles.size,0); assert.equal(allocations.size,0);
const pipe=security.descriptor(false), dir=security.descriptor(true);
assert.deepEqual(descriptors,['O:'+sidText+'D:P(A;;FA;;;'+sidText+')','O:'+sidText+'D:P(A;OICI;FA;;;'+sidText+')']);
for (const descriptor of [pipe,dir]) { const view=new DataView(descriptor.attributes.buffer);
 assert.equal(descriptor.attributes.length,24); assert.equal(view.getUint32(0,true),24);
 assert.equal(view.getUint32(16,true),0); assert.ok(allocations.has(Number(view.getBigUint64(8,true)))); }
pipe.close(); pipe.close(); dir.close();
security.verifyPipe(123n); directory=true; security.verifyPrivateObject(123n,true); directory=false;
badOwner=true; assert.throws(()=>security.verifyPipe(123n),/daemon_endpoint_unsafe/); badOwner=false;
protectedAcl=false; assert.throws(()=>security.verifyPipe(123n),/daemon_endpoint_unsafe/); protectedAcl=true;
badMask=true; assert.throws(()=>security.verifyPipe(123n),/daemon_endpoint_unsafe/); badMask=false;
directory=true; assert.throws(()=>security.verifyPipe(123n),/daemon_endpoint_unsafe/); directory=false;
const retry=security.descriptor(false), address=Number(new DataView(retry.attributes.buffer).getBigUint64(8,true));
failFree=address; assert.throws(()=>retry.close(),/daemon_security_close_unknown/); assert.ok(allocations.has(address));
failFree=undefined; retry.close(); retry.close(); assert.ok(!allocations.has(address));
failFree=7000; assert.throws(()=>security.verifyPipe(123n),/daemon_security_close_unknown/);
assert.deepEqual([...allocations],[7000]); assert.equal(writes,0); assert.ok(freed.includes(9000));
console.log('windows_security_contract_passed');
`;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 3000,
    env: { ...process.env, BUN_BE_BUN: undefined },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('windows_security_contract_passed');
}, 5000);
