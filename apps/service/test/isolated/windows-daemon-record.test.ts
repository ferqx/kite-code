import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWindowsDaemonRecord,
  removeWindowsDaemonRecord,
  reserveWindowsDaemonRecord,
} from '../../src/daemon/windows-record';

const bytes = (value: string) => new TextEncoder().encode(value);
test.skipIf(process.platform !== 'win32')(
  'Windows record original owner permits shared reads and rejects another writer, then deletes only the exact record',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-daemon-record-'));
    const path = join(root, 'private', 'owner.json');
    const first = bytes('{"ready":false}'),
      second = bytes('{"ready":true}');
    let owner: ReturnType<typeof reserveWindowsDaemonRecord> | undefined;
    try {
      expect(readWindowsDaemonRecord(path)).toBeUndefined();
      owner = reserveWindowsDaemonRecord(path, first);
      expect(readWindowsDaemonRecord(path)).toEqual({ bytes: first, identity: owner.identity });
      expect(() => reserveWindowsDaemonRecord(path, second)).toThrow();
      expect(() => removeWindowsDaemonRecord(path, first, owner!.identity)).toThrow();
      owner.publish(second);
      expect(readWindowsDaemonRecord(path)?.bytes).toEqual(second);
      expect(() => owner!.remove(first)).toThrow('drift');
      expect(owner.read()).toEqual(second);
      const identity = owner.identity;
      owner.close();
      owner = undefined;
      expect(() => removeWindowsDaemonRecord(path, second, { ...identity, ino: '0' })).toThrow(
        'drift',
      );
      expect(readWindowsDaemonRecord(path)?.bytes).toEqual(second);
      removeWindowsDaemonRecord(path, second, identity);
      expect(readWindowsDaemonRecord(path)).toBeUndefined();
    } finally {
      owner?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('record HANDLE protocol preserves original identity, bounded full bytes and uncertain closes', () => {
  const module = fileURLToPath(new URL('../../src/daemon/windows-record.ts', import.meta.url));
  const security = fileURLToPath(new URL('../../src/daemon/windows-security.ts', import.meta.url));
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as ffi from 'bun:ffi';
import * as path from 'node:path';
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
mock.module('@kite-ai/agent/windows-path-security', () => ({ privateDirectory() {}, defaultWindowsPathSecurity: () => ({ verifyPath() {} }) }));
mock.module(${JSON.stringify(security)}, () => ({ windowsDaemonSecurity: () => ({ verifyPrivateObject(h, directory) { if (!directory && failVerify) { failVerify = false; failedClose = h; throw Error('original_acl_denied'); } }, descriptor: () => ({ attributes: new Uint8Array(24), close() {} }) }) }));
const files = new Map(), handles = new Map(), ids = new Map(), calls = [];
let next = 1n, error = 2, failedClose, swapped = false, failVerify = false, lockBusy = false;
const text = b => Buffer.from(b).toString('utf16le').split('\\0')[0];
const symbols = {
 CreateFileW(b, access, share, _sa, creation) {
  const name = text(b), file = name.endsWith('.json');
  if (creation === 1 && files.has(name)) { error = 80; return 18446744073709551615n; }
  if (file && creation === 3 && !files.has(name)) { error = 2; return 18446744073709551615n; }
  if (creation === 1) files.set(name, { bytes: Buffer.alloc(0), stamp: 0 });
  if (!ids.has(name)) ids.set(name, ids.size + 1);
  const h = next++; handles.set(h, { name, file, offset: 0, marked: false });
  calls.push({ name, access, share, h }); return h;
 },
 GetFileInformationByHandle(h, b) {
  const e = handles.get(h), v = new DataView(b.buffer), f = files.get(e.name);
  v.setUint32(0, e.file ? 0 : 0x10, true); v.setUint32(28, 1, true);
  v.setUint32(36, f?.bytes.length ?? 0, true); v.setUint32(40, 1, true); v.setUint32(48, ids.get(e.name) + (swapped && e.file ? 1 : 0), true); return true;
 },
 GetFileInformationByHandleEx(h, _kind, b) { new DataView(b.buffer).setBigInt64(24, BigInt(files.get(handles.get(h).name)?.stamp ?? 0), true); return true; },
 SetFilePointerEx(h) { handles.get(h).offset = 0; return true; },
 ReadFile(h, b, limit, count) { const e = handles.get(h), part = files.get(e.name).bytes.subarray(e.offset, e.offset + Math.min(limit, 3)); b.set(part); count[0] = part.length; e.offset += part.length; return true; },
 WriteFile(h, b, limit, count) { const e = handles.get(h), f = files.get(e.name), size = Math.min(limit, 3), end = e.offset + size; if (f.bytes.length < end) { const expanded = Buffer.alloc(end); f.bytes.copy(expanded); f.bytes = expanded; } Buffer.from(b).copy(f.bytes, e.offset, 0, size); e.offset = end; f.stamp++; count[0] = size; return true; },
 SetEndOfFile(h) { const e = handles.get(h), f = files.get(e.name); f.bytes = f.bytes.subarray(0, e.offset); f.stamp++; return true; },
 FlushFileBuffers: () => true,
 LockFileEx: () => !lockBusy, UnlockFileEx: () => true,
 SetFileInformationByHandle(h, kind, b) { assert.equal(kind, 4); assert.equal(b[0], 1); handles.get(h).marked = true; return true; },
 GetFileAttributesW(b) { if (files.has(text(b))) return 0; error = 2; return 0xffffffff; },
 GetLastError: () => error,
 CloseHandle(h) { if (failedClose === h) { failedClose = undefined; return false; } const e = handles.get(h); assert.ok(e); if (e.marked) files.delete(e.name); handles.delete(h); return true; },
};
// The production leaf deliberately uses lazy CommonJS builtin loading.
Object.assign(require('bun:ffi'), { ptr: b => b, dlopen: () => ({ symbols, close() {} }) });
const { reserveWindowsDaemonRecord, readWindowsDaemonRecord, removeWindowsDaemonRecord } = await import(${JSON.stringify(module)});
const pathName = '/private/owner.json', initial = Buffer.from('{"ready":false}');
assert.equal(readWindowsDaemonRecord(pathName), undefined); assert.equal(handles.size, 0);
const beforeCreate = calls.length;
const owner = reserveWindowsDaemonRecord(pathName, initial);
assert(calls.filter(c => c.name === '/').every(c => c.access === 0x20080));
const parentPin = calls.slice(beforeCreate).find(c => c.name === '/private' && handles.has(c.h));
assert.ok(parentPin); assert.equal(parentPin.access, 0x200a0);
const original = calls.find(c => c.name === pathName && c.access === 0xc0030080); assert.ok(original); assert.equal(original.share, 1);
assert.deepEqual(Buffer.from(owner.read()), initial);
lockBusy = true; assert.throws(() => owner.read(), /busy/); lockBusy = false;
assert.deepEqual(Buffer.from(readWindowsDaemonRecord(pathName).bytes), initial);
assert.equal(calls.filter(c => c.name === '/private').at(-1).access, 0x20080);
assert.throws(() => reserveWindowsDaemonRecord(pathName, initial), /busy/);
const updated = Buffer.from('{"ready":true}'); owner.publish(updated); assert.deepEqual(Buffer.from(owner.read()), updated);
assert.throws(() => owner.remove(initial), /drift/); assert.equal(files.has(pathName), true);
swapped = true; assert.throws(() => owner.read(), /unsafe/); swapped = false;
assert.throws(() => owner.publish(Buffer.alloc(16385)), /unsafe/);
failedClose = original.h; assert.throws(() => owner.remove(updated), /close_unknown/);
assert.equal(handles.has(original.h), true); const openCount = calls.length;
owner.remove(updated); assert.equal(calls.length, openCount); owner.close(); owner.close(); assert.equal(handles.size, 0);
assert.equal(readWindowsDaemonRecord(pathName), undefined);
const cold = reserveWindowsDaemonRecord(pathName, initial), identity = cold.identity; cold.close();
assert.throws(() => removeWindowsDaemonRecord(pathName, initial, { ...identity, ino: '0' }), /drift/);
assert.deepEqual(Buffer.from(readWindowsDaemonRecord(pathName).bytes), initial);
removeWindowsDaemonRecord(pathName, initial, identity); assert.equal(handles.size, 0); assert.equal(files.has(pathName), false);
// Failed factory cleanup retains the original unconfirmed file, not merely an error label.
failVerify = true;
assert.throws(() => reserveWindowsDaemonRecord('/private/unknown.json', initial), error =>
 error instanceof AggregateError && error.errors.some(e => String(e).includes('original_acl_denied')) && error.message === 'daemon_record_close_unknown');
assert.equal(handles.size, 1); assert.equal([...handles.values()][0].name, '/private/unknown.json');
console.log('original-record-owner-confirmed');
`;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 4000 });
  if (child.error || child.status !== 0) process.stderr.write(child.stderr || String(child.error));
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('original-record-owner-confirmed\n');
});
