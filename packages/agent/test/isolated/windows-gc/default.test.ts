import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows GC owns the original DELETE reader through full hash, role checks and failed close', () => {
  const module = fileURLToPath(
    new URL('../../../src/platform/windows-artifact-files.ts', import.meta.url),
  );
  const code = `
import * as nativeFFI from 'bun:ffi';
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
assert.equal(typeof nativeFFI.dlopen, 'function');
assert.equal(typeof require('bun:ffi').dlopen, 'function');
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
mock.module('node:fs', () => ({ ...fs, realpathSync: value => value }));
const files = new Map(), handles = new Map(), ids = new Map(), calls = [];
let next = 1n, role, failClose, badAcl = false;
const acl = new ArrayBuffer(8), ace = new ArrayBuffer(12);
new DataView(acl).setUint16(4, 1, true);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = buffer => Buffer.from(buffer).toString('utf16le').split('\\0')[0];
const ticks = ms => 116444736000000000n + BigInt(ms) * 10000n;
const symbols = {
 GetCurrentProcess: () => 99n,
 GetSystemDirectoryW(buffer) { const name = String.fromCharCode(67, 58, 92) + ['Windows', 'System32'].join(String.fromCharCode(92)); for (let index = 0; index < name.length; index++) buffer[index] = name.charCodeAt(index); return name.length; },
 OpenProcessToken(_process, _flags, output) { output[0] = 900n; return true; },
 GetTokenInformation(_token, _kind, bytes, _length, size) { size[0] = 16; if (bytes) new DataView(bytes.buffer).setBigUint64(0, 1000n, true); return true; },
 ConvertSidToStringSidA(_sid, output) { output[0] = 5000n; return true; },
 GetSecurityInfo(handle, _kind, _flags, owner, _group, dacl, _sacl, sd) { role = handles.get(handle); owner[0] = 1000n; dacl[0] = 3000n; sd[0] = 4000n; return 0; },
 GetSecurityDescriptorControl(_sd, control, revision) { control[0] = 0x1004; revision[0] = 1; return true; },
 GetAce(_acl, _index, output) {
  const view = new DataView(ace); view.setUint8(0, 0); view.setUint8(1, role.directory ? 3 : 0); view.setUint16(2, 12, true);
  view.setUint32(4, badAcl ? 0x1f01ff : (!role.directory && role.published ? 0x120089 : 0x1f01ff), true);
  output[0] = 2000n; return true;
 },
 EqualSid: () => true, LocalFree() {},
 CreateFileW(buffer, access, share) {
  const name = text(buffer), directory = !files.has(name), data = files.get(name);
  if (!ids.has(name)) ids.set(name, ids.size + 1);
  const handle = next++;
  handles.set(handle, { name, directory, published: !directory && /^[a-f0-9]{64}$/.test(name.split('/').at(-1)), data, offset: 0, marked: false });
  calls.push({ kind: 'open', name, access, share, handle }); return handle;
 },
 GetFileInformationByHandle(handle, bytes) {
  const entry = handles.get(handle); assert.ok(entry);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, entry.directory ? 0x10 : 0, true); view.setUint32(28, 1, true);
  view.setUint32(36, entry.directory ? 0 : entry.data.length, true); view.setUint32(40, 1, true); view.setUint32(48, ids.get(entry.name), true); return true;
 },
 GetFileInformationByHandleEx(_handle, _kind, bytes) {
  const view = new DataView(bytes.buffer); view.setBigInt64(0, ticks(10), true); view.setBigInt64(16, ticks(1234), true); view.setBigInt64(24, ticks(5678), true); return true;
 },
 ReadFile(handle, bytes, limit, count) {
  const entry = handles.get(handle); const part = entry.data.subarray(entry.offset, entry.offset + limit);
  bytes.set(part); count[0] = part.length; entry.offset += part.length; calls.push({ kind: 'read', handle }); return true;
 },
 SetFileInformationByHandle(handle, kind, disposition, size) {
  assert.equal(kind, 4); assert.equal(size, 1); assert.equal(disposition[0], 1);
  handles.get(handle).marked = true; calls.push({ kind: 'delete', handle }); return true;
 },
 CloseHandle(handle) {
  if (handle === 900n) return true;
  calls.push({ kind: 'close', handle });
  if (failClose === handle) { failClose = undefined; return false; }
  const entry = handles.get(handle); assert.ok(entry);
  if (entry.marked) files.delete(entry.name); handles.delete(handle); return true;
 },
 GetFileAttributesW(buffer) { return files.has(text(buffer)) ? 0 : 0xffffffff; },
 GetLastError: () => 2,
};
mock.module('bun:ffi', () => ({ ...nativeFFI, ptr: value => value,
 toArrayBuffer(address) { return address === 3000 ? acl : ace; },
 CString: class { toString() { return 'S-1-5-21-1'; } },
 dlopen() { return { symbols, close() {} }; },
}));
const { retainWindowsGcArtifact, WindowsGcArtifactAcquireUnknownError } = await import(${JSON.stringify(module)});
const profile = '/owned-profile';
const seed = (name, bytes) => { const location = profile + '/blobs/' + (name.startsWith('.publish-') ? '' : name.slice(0, 2) + '/') + name; files.set(location, bytes); return location; };
const body = Buffer.from('complete-original-body'.repeat(5000)), hash = sha(body), location = seed(hash, body);
const owner = retainWindowsGcArtifact(profile, hash);
assert.deepEqual(owner.metadata, { size: BigInt(body.length), ctimeMs: 5678, mtimeMs: 1234 });
const original = calls.find(call => call.kind === 'open' && call.name === location && call.access === 0x80030080);
assert.ok(original); assert.equal(original.share, 1);
assert.equal(Buffer.concat([...owner.chunks()]).equals(body), true);
assert.equal(calls.filter(call => call.kind === 'read').every(call => call.handle === original.handle), true);
owner.remove(); assert.equal(files.has(location), false);
assert.deepEqual(calls.filter(call => call.kind === 'delete').map(call => call.handle), [original.handle]);
owner.close(); owner.close(); assert.equal(handles.size, 0);
// A genuine FA temporary uses the same original reader and deletion protocol.
const temporary = '.publish-00000000-0000-0000-0000-000000000000', temporaryPath = seed(temporary, body);
const temp = retainWindowsGcArtifact(profile, temporary); assert.equal(Buffer.concat([...temp.chunks()]).equals(body), true);
temp.remove(); temp.close(); assert.equal(files.has(temporaryPath), false); assert.equal(handles.size, 0);
seed(hash, body); const early = retainWindowsGcArtifact(profile, hash), iterator = early.chunks(); iterator.next(); iterator.return();
assert.throws(() => early.remove(), /artifact_content_mismatch/); early.close(); assert.equal(files.has(location), true);
const wrongHash = 'b'.repeat(64), wrongPath = seed(wrongHash, body), wrong = retainWindowsGcArtifact(profile, wrongHash);
assert.throws(() => [...wrong.chunks()], /artifact_content_mismatch/); assert.throws(() => wrong.remove(), /artifact_content_mismatch/);
wrong.close(); assert.equal(files.has(wrongPath), true);
// Failed original Close keeps that exact native object; retry never reopens it.
calls.length = 0; const retry = retainWindowsGcArtifact(profile, hash); [...retry.chunks()];
const retryHandle = calls.find(call => call.kind === 'open' && call.name === location && call.access === 0x80030080).handle;
failClose = retryHandle; assert.throws(() => retry.remove(), /artifact_content_mismatch/);
assert.equal(handles.has(retryHandle), true); assert.equal(files.has(location), true);
const opened = calls.filter(call => call.kind === 'open').length;
retry.remove(); retry.close(); assert.equal(files.has(location), false); assert.equal(handles.size, 0);
assert.equal(calls.filter(call => call.kind === 'open').length, opened);
// Acquisition must reject a FA published object; no ACL repair or deletion occurs.
seed(hash, body); badAcl = true;
assert.throws(() => retainWindowsGcArtifact(profile, hash), /artifact_content_mismatch/);
assert.equal(files.has(location), true); assert.equal(handles.size, 0);
assert.equal(typeof WindowsGcArtifactAcquireUnknownError, 'function');
console.log('original-gc-owner-confirmed');
`;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 4000 });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('original-gc-owner-confirmed\n');
});

test('public Windows GC retains Profile EX only when original acquisition cleanup is unknown', () => {
  const module = (path: string) => fileURLToPath(new URL(`../../../src/${path}`, import.meta.url));
  const code = `
import * as nativeFFI from 'bun:ffi';
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Retain the actual AsyncLocalStorage owner, pending-resource and lease functions.
const actualFiles = await import(${JSON.stringify(module('maintenance/files.ts'))});
const actualPort = await import(${JSON.stringify(module('platform/windows-artifact-files.ts'))});
assert.equal(typeof nativeFFI.dlopen, 'function');
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
mock.module('node:fs', () => ({ ...fs, existsSync: value => !value.endsWith('-journal') }));
const regions = new Set(), releaseCounts = new Map(), portNames = [], pendingObserved = [];
const primary = Error('gc-original-permission-denied'), cleanup = Error('gc-original-close-unknown');
const unknown = new actualPort.WindowsGcArtifactAcquireUnknownError(primary, cleanup);
let mode = 'unknown', databaseCloses = 0, directoryCloses = 0;
mock.module(${JSON.stringify(module('platform/profile.ts'))}, () => ({
 acquireProfileAccess(options, kind) {
  assert.equal(kind, 'exclusive'); const id = options.profile;
  assert.equal(regions.has(id), false); regions.add(id); releaseCounts.set(id, 0);
  return { profilePath: '/owned-' + id, databasePath: '/owned-' + id + '/core.db',
   lock: { release() { releaseCounts.set(id, releaseCounts.get(id) + 1); regions.delete(id); } },
  };
 },
}));
mock.module(${JSON.stringify(module('maintenance/files.ts'))}, () => ({
 ...actualFiles,
 privateDirectory: value => value,
 checkpoint: async () => {},
 withPrivateDatabaseSnapshot: async (_source, _scratch, read) => read('/owned-snapshot'),
 openMaintenanceDirectory() {
  const owner = {}, release = actualFiles.retainMaintenanceResource(owner); let read = false, closed = false;
  return { readSync() { if (read) return null; read = true; return { name: '.publish-00000000-0000-0000-0000-000000000000' }; },
   closeSync() { if (!closed) { closed = true; directoryCloses++; release(); } },
  };
 },
}));
mock.module(${JSON.stringify(module('maintenance/sqlite.ts'))}, () => ({
 capture: () => ({ storeId: 'owned-store' }),
 openBackupDatabase() {
  const owner = {}, release = actualFiles.retainMaintenanceResource(owner);
  return { close(strict) { assert.equal(strict, true); databaseCloses++; release(); } };
 },
 openMaintenanceDatabase() { throw Error('unexpected-SQL-mutation'); },
}));
mock.module(${JSON.stringify(module('maintenance/gc-history.ts'))}, () => ({
 planHistoryCollection: () => ({ workspaces: [], sessionGroups: [], previouslyCollected: false,
  retainedRecentWorkspaces: 0, retainedUnsettledWorkspaces: 0,
  retainedRecentSessionGroups: 0, retainedUnsettledSessionGroups: 0, retainedReferencedSessionGroups: 0,
 }),
 collectHistory() { throw Error('unexpected-history-mutation'); },
}));
mock.module(${JSON.stringify(module('platform/windows-artifact-files.ts'))}, () => ({
 ...actualPort,
 retainWindowsGcArtifact(profile, name) {
  portNames.push([profile, name]); pendingObserved.push(actualFiles.maintenanceResourcesClosed());
  throw mode === 'unknown' ? unknown : primary;
 },
}));
const { collectProfileGarbage } = await import(${JSON.stringify(module('maintenance/gc.ts'))});
await assert.rejects(collectProfileGarbage({ profile: { dataRoot: '/owned-data', profile: 'unknown' }, expectedStoreId: 'owned-store' }), error => error === unknown);
assert.deepEqual(unknown.errors, [primary, cleanup]);
assert.equal(releaseCounts.get('unknown'), 0); assert.equal(regions.has('unknown'), true);
assert.equal(databaseCloses, 1); assert.equal(directoryCloses, 1);
mode = 'ordinary';
await assert.rejects(collectProfileGarbage({ profile: { dataRoot: '/owned-data', profile: 'ordinary' }, expectedStoreId: 'owned-store' }), error => error === primary);
assert.equal(releaseCounts.get('ordinary'), 1); assert.equal(regions.has('ordinary'), false);
assert.equal(regions.has('unknown'), true);
assert.equal(databaseCloses, 2); assert.equal(directoryCloses, 2);
assert.deepEqual(pendingObserved, [false, false]);
assert.deepEqual(portNames, [
 ['/owned-unknown', '.publish-00000000-0000-0000-0000-000000000000'],
 ['/owned-ordinary', '.publish-00000000-0000-0000-0000-000000000000'],
]);
console.log('public-gc-owner-confirmed');
`;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 4000 });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('public-gc-owner-confirmed\n');
});
