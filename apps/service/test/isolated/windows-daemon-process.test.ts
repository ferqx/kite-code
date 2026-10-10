import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retainWindowsProcess } from '../../src/daemon/windows-process';

test('lazy Windows process observer retains exact HANDLE birth, bounded complete census and failed close', () => {
  const module = fileURLToPath(new URL('../../src/daemon/windows-process.ts', import.meta.url));
  const code = `
import * as nativeFFI from 'bun:ffi';
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
assert.equal(typeof require('bun:ffi').dlopen, 'function');
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
let loads = 0, nextHandle = 1n, closeFailure, error = 18, rows = [0, 7, 41], incomplete = false;
const handles = new Map(), processes = new Map([[41, { birth: 134123456789012345n, wait: 258 }]]);
const calls = [];
const symbols = {
 OpenProcess(access, inherit, pid) { assert.equal(access, 0x101000); assert.equal(inherit, false);
   const process = processes.get(pid); if (!process) return 0n;
   const handle = nextHandle++; handles.set(handle, { process, pid }); calls.push(['open', handle]); return handle; },
 GetProcessId(handle) { return handles.get(handle).pid; },
 GetProcessTimes(handle, creation) { creation[0] = handles.get(handle).process.birth; return true; },
 WaitForSingleObject(handle, timeout) { assert.equal(timeout, 0); return handles.get(handle).process.wait; },
 CloseHandle(handle) { calls.push(['close', handle]); if (closeFailure === handle) return false;
   assert.ok(handles.delete(handle)); return true; },
 CreateToolhelp32Snapshot(flags, pid) { assert.equal(flags, 2); assert.equal(pid, 0);
   const handle = nextHandle++; handles.set(handle, { rows: [...rows], index: 0 }); return handle; },
 Process32FirstW(handle, bytes) { assert.equal(bytes.byteLength, 568); assert.equal(new DataView(bytes.buffer).getUint32(0, true), 568);
   return symbols.Process32NextW(handle, bytes); },
 Process32NextW(handle, bytes) { const snapshot = handles.get(handle);
   if (snapshot.index >= snapshot.rows.length) { error = incomplete ? 5 : 18; return false; }
   new DataView(bytes.buffer).setUint32(8, snapshot.rows[snapshot.index++], true); return true; },
 GetLastError() { return error; },
};
mock.module('bun:ffi', () => ({ ...nativeFFI, ptr: value => value,
 dlopen(name) { assert.equal(name, 'kernel32.dll'); loads++; return { symbols, close() {} }; },
}));
const { retainWindowsProcess, readWindowsProcessStartIdentity, inspectWindowsProcess } = await import(${JSON.stringify(module)});
assert.equal(loads, 0);
const birth = 'windows:filetime:134123456789012345';
const owner = retainWindowsProcess(41, birth);
assert.equal(loads, 1); assert.equal(owner.identity, birth); assert.equal(owner.inspect(), 'alive');
const original = calls.find(call => call[0] === 'open')[1];
assert.ok(handles.has(original));
const originalProcess = processes.get(41);
processes.set(41, { birth: 134123456789012346n, wait: 258 });
assert.equal(owner.inspect(), 'alive'); // Still observes original HANDLE, never substituted PID.
assert.equal(inspectWindowsProcess(41, birth), 'dead');
originalProcess.wait = 0; assert.equal(owner.inspect(), 'dead');
closeFailure = original; assert.throws(() => owner.close(), /windows_process_close_unknown/);
assert.ok(handles.has(original)); assert.equal(owner.inspect(), 'uncertain');
closeFailure = undefined; owner.close(); owner.close(); assert.equal(owner.inspect(), 'uncertain');
assert.equal(readWindowsProcessStartIdentity(41), 'windows:filetime:134123456789012346');
processes.clear();
assert.equal(inspectWindowsProcess(41, birth), 'uncertain'); // OpenProcess failure and present census are not death.
rows = [0, 7]; incomplete = true; assert.equal(inspectWindowsProcess(41, birth), 'uncertain');
incomplete = false; assert.equal(inspectWindowsProcess(41, birth), 'dead');
rows = []; assert.equal(inspectWindowsProcess(41, birth), 'uncertain');
rows = [0, 7];
const failedSnapshotOwner = retainWindowsProcess(41, birth);
closeFailure = nextHandle;
assert.equal(failedSnapshotOwner.inspect(), 'uncertain');
assert.throws(() => failedSnapshotOwner.close(), /windows_process_close_unknown/);
closeFailure = undefined; failedSnapshotOwner.close();
assert.equal(inspectWindowsProcess(41, 'windows:filetime:18446744073709551616'), 'uncertain');
assert.equal(retainWindowsProcess(-1).inspect(), 'uncertain');
assert.equal(handles.size, 0);
console.log('windows_process_contract_passed');
`;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, BUN_BE_BUN: undefined },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('windows_process_contract_passed');
}, 10000);

const windowsTest = process.platform === 'win32' && process.arch === 'x64' ? test : test.skip;
windowsTest(
  'actual Windows child original HANDLE reports native birth and signaled exit after stdin EOF',
  async () => {
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text()'], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, BUN_BE_BUN: undefined },
    });
    const owner = retainWindowsProcess(child.pid);
    try {
      expect(owner.identity).toMatch(/^windows:filetime:[1-9][0-9]+$/);
      expect(owner.inspect()).toBe('alive');
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(owner.inspect()).toBe('dead');
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await child.exited;
      owner.close();
    }
  },
  10000,
);
