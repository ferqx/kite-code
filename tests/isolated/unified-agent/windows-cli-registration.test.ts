import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
function subprocess(scenario: string) {
  const child = spawnSync(process.execPath, ['-e', script(scenario)], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('registration-owner-confirmed\n');
}
// Original public registration flow with isolated trusted OS ports; not Windows native qualification.
test('Windows registration reads private handles and preserves same-nonce target CAS', () => {
  subprocess('registration');
});
test('Windows publication unknown keeps both original selection EX owners', () => {
  subprocess('publication');
});
test('Windows private deletion factory unknown retries its original owner before EX release', () => {
  subprocess('deletion');
});
test('Windows deregistration rejects a structural full-tree owner without genuine identity', () => {
  subprocess('forged');
});
function script(scenario: string) {
  return `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
const a = 'a'.repeat(64), b = 'b'.repeat(64), n = '/native', t = '/terminal';
const files = new Map([[n + '/active', Buffer.from(a+'\\n\\n')], [t + '/active', Buffer.from(b+'\\n\\n')]]);
const directories = new Set([n,t]), regions = new Set(), attachments = new Map(), events = [];
let scenario = ${JSON.stringify(scenario)}, failDelete = false;
const primary = Error('original_transfer_failure'), cleanup = Error('original_delete_close_unknown');
const stat = p => ({ mode: 0o777, uid: 1, nlink: 1, size: files.get(p)?.length ?? 0,
  isFile: () => files.has(p), isDirectory: () => directories.has(p), isSymbolicLink: () => false });
mock.module('node:fs', () => ({ ...fs, existsSync: p => files.has(p) || directories.has(p),
  lstatSync: (p, opts) => files.has(p) || directories.has(p) ? stat(p) : opts?.throwIfNoEntry === false ? undefined : (()=>{throw Error('missing:'+p)})(),
  realpathSync: p => p, readFileSync() { throw Error('Windows must read private HANDLE'); },
}));
const security = {
  verifyDirectory(p) { assert.ok(directories.has(p)); },
  readScopeFile(p, max, privateFile) { assert.equal(privateFile, true); const bytes = files.get(p); if(bytes) assert.ok(bytes.length <= max); return bytes ?? null; },
  writePrivateFile(p, bytes) { assert.equal(files.has(p), false); files.set(p, Buffer.from(bytes)); events.push('write:'+p); },
  syncPrivateFile(p) { assert.ok(files.has(p)); events.push('flush:'+p); },
  movePrivateEntry(from,to,replace) {
    assert.equal(replace,true); assert.ok(files.has(from)); files.set(to,files.get(from)); files.delete(from); events.push('publish:'+to);
    if(scenario === 'publication') throw primary;
  },
};
const securityModule = () => ({ defaultWindowsPathSecurity: () => security, privateDirectory(p) { directories.add(p); } });
mock.module('@kite-ai/agent/windows-path-security', securityModule);
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-path-security.ts'))}, securityModule);
mock.module(${JSON.stringify(modulePath('apps/cli/host/windows-native-installation.ts'))}, () => ({ readWindowsNativeInstallation(root) { assert.equal(root,n); return {root}; } }));
mock.module(${JSON.stringify(modulePath('apps/cli/host/windows-terminal-installation.ts'))}, () => ({
  readWindowsTerminalInstallation(root) { assert.equal(root,t); return {root}; },
  retainWindowsTerminalFrontdoor() { return { verify() {}, release() { events.push('frontdoor-close'); } }; },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/locks.ts'))}, () => ({
  acquireFileLock(path,mode) { assert.equal(mode,'exclusive'); assert.equal(regions.has(path),false); regions.add(path);
    const lock = {path,mode,release() { if(!regions.has(path)) return; attachments.get(lock)?.release(); regions.delete(path); events.push('unlock:'+path); }}; return lock; },
  attachLockResource(lock, resource) { resource.verify(); attachments.set(lock,resource); },
  assertLiveLock(lock,path,mode) { assert.equal(lock.path,path); assert.equal(lock.mode,mode); assert.ok(regions.has(path)); attachments.get(lock)?.verify(); },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-coordination.ts'))}, () => ({
  windowsInstallationCoordination(prefix) { const root=prefix+'-coord'; directories.add(root); return {
    prefix,root,selectionLockPath:root+'/selection.lock',verify() {},release() { events.push('namespace-close:'+prefix); }
  }; },
}));
const removalModulePath=${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))};
const {assertWindowsInstallationRemoval} = await import(removalModulePath);
mock.module(removalModulePath, () => ({ assertWindowsInstallationRemoval,
  retainWindowsInstallationRemoval({root,inventory}) { return {
    verify() {}, remove() { for(const item of inventory) files.delete(root+'/'+item.path); directories.delete(root); events.push('scratch-removed'); }, release() { events.push('scratch-close'); }
  }; },
}));
class WindowsPrivateFileRemovalAcquireUnknownError extends AggregateError {
  constructor(error, close, owner) { super([error,close],'windows_private_file_removal_acquire_unknown'); this.owner=owner; }
}
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-private-file-removal.ts'))}, () => ({
  WindowsPrivateFileRemovalAcquireUnknownError,
  retainWindowsPrivateFileRemoval(p) {
    const owner = { verify() {}, remove() { files.delete(p); events.push('delete:'+p); }, release() { events.push('delete-close:'+p); } };
    if(failDelete) { failDelete=false; throw new WindowsPrivateFileRemovalAcquireUnknownError(primary,cleanup,owner); }
    return owner;
  },
}));
mock.module('@kite-ai/service/native-runtime-assets', () => ({ verifyNativeRuntimeBundle(root) { assert.equal(root,n+'/releases/'+a); return {digest:a}; } }));
mock.module(${JSON.stringify(modulePath('apps/cli/host/terminal-artifact.ts'))}, () => ({ verifyTerminalBundle(root) { assert.equal(root,t+'/releases/'+b); return {digest:b}; } }));
const reader = await import(${JSON.stringify(modulePath('apps/cli/host/cli-registration.ts'))});
const api = await import(${JSON.stringify(modulePath('scripts/release/cli-registration.ts'))});
const release = locks => { while(locks.length) {locks.at(-1).release(); locks.pop();} };
const initial = {version:1,terminalPrefix:t,nativePrefix:n,candidateId:a,nonce:'c'.repeat(32)};
files.set(n+'/'+reader.OWNED_CLI_REGISTRATION_FILE,Buffer.from(JSON.stringify(initial)));
files.set(t+'/'+reader.CLI_REGISTRATION_FILE,Buffer.from(JSON.stringify(initial)));
assert.deepEqual(reader.readCLIRegistration(n,true),initial);
reader.assertManagedCLIPrefix(n,true); reader.assertManagedCLIPrefix(t);
files.set(t+'/active',Buffer.from(b+'\\n'+b+'\\n'));
assert.throws(()=>reader.readManagedCLIActive(t),/cli_registration_active_invalid/);
files.set(t+'/active',Buffer.from(b+'\\n\\n'));
const locks = api.acquireCLIRegistrationLocks([t,n,n]);
assert.deepEqual(locks.map(lock=>lock.path),[n+'-coord/selection.lock',t+'-coord/selection.lock']);
if(scenario === 'publication') {
  assert.throws(()=>api.registerNativeCLIWhileLocked({nativePrefix:n,terminalPrefix:t},locks), error=>error===primary);
  assert.throws(()=>release(locks),/cli_registration_transfer_close_unknown/);
  assert.equal(regions.size,2);
  assert.equal(events.some(event=>event.startsWith('unlock:') || event.startsWith('namespace-close:')),false);
} else if(scenario === 'deletion') {
  failDelete=true;
  assert.throws(()=>api.unregisterNativeCLIWhileLocked(n,locks), error=>error instanceof WindowsPrivateFileRemovalAcquireUnknownError && !!error.owner);
  assert.equal(regions.size,2);
  release(locks);
  assert.equal(regions.size,0);
  assert.ok(events.indexOf('delete-close:'+t+'/'+reader.CLI_REGISTRATION_FILE)<events.indexOf('namespace-close:'+t));
  assert.deepEqual(reader.readCLIRegistration(n,true),initial);
} else if(scenario === 'forged') {
  assert.throws(()=>api.unregisterNativeCLIWhileLocked(n,locks,{verify(){},remove(){},release(){}}),/windows_installation_removal_unknown/);
  assert.deepEqual(reader.readCLIRegistration(t),initial);
  release(locks); assert.equal(regions.size,0);
} else {
  api.verifyCLIRegistrationTargetWhileLocked(t,locks);
  const registered=api.registerNativeCLIWhileLocked({nativePrefix:n,terminalPrefix:t},locks);
  assert.notEqual(registered.nonce,initial.nonce);
  assert.deepEqual(reader.readCLIRegistration(n,true),registered);
  assert.deepEqual(reader.readCLIRegistration(t),registered);
  assert.ok(events.indexOf('publish:'+n+'/'+reader.OWNED_CLI_REGISTRATION_FILE)<events.indexOf('publish:'+t+'/'+reader.CLI_REGISTRATION_FILE));
  const later={...registered,nonce:'d'.repeat(32)};
  files.set(t+'/'+reader.CLI_REGISTRATION_FILE,Buffer.from(JSON.stringify(later)));
  assert.equal(api.unregisterNativeCLIWhileLocked(n,locks),false);
  assert.deepEqual(reader.readCLIRegistration(t),later);
  assert.equal(reader.readCLIRegistration(n,true),undefined);
  release(locks); assert.equal(regions.size,0);
  assert.ok(events.indexOf('scratch-close')<events.indexOf('namespace-close:'+n));
}
console.log('registration-owner-confirmed');
`;
}
