import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseWindowsNativeInstallationMarker,
  windowsNativeFrontdoorNames,
} from '../../../apps/cli/host/windows-native-installation';

const modulePath = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
function subprocess(code: string) {
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 4000 });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('owned-close-confirmed\n');
}

// These isolated mocks observe actual public-owner control flow, not Windows native qualification.
test('Windows selection namespace unknown close retains its original EX', () => {
  subprocess(installerScript('selection'));
});
test('Windows DELETE acquisition unknown retains every original EX while ordinary rejection releases', () => {
  subprocess(installerScript('removal'));
});

test('Windows Native rollback preflights the same-nonce Terminal before publication', () => {
  subprocess(installerScript('registration'));
});

test('Windows Native completed publication with unknown original HANDLE close retains selection and resources', () => {
  subprocess(installerScript('move'));
});

function installerScript(scenario: 'selection' | 'removal' | 'registration' | 'move') {
  return `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
const { WindowsInstallationRemovalAcquireUnknownError } = await import(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))});
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const regions = new Set(), events = [], scratchEntries = new Set(), transferHandles = new Set();
const owned = { terminalPrefix: '/terminal', nativePrefix: '/owned-registration', nonce: 'c'.repeat(32), candidateId: a, version: 1 };
let mode = ${JSON.stringify(scenario)};
const primary = Error('original-admission-error'), cleanup = Error('original-close-error');
const unknown = new WindowsInstallationRemovalAcquireUnknownError(primary, cleanup);
mock.module('node:fs', () => ({ ...fs,
  existsSync(path) { return mode === 'move' && path.includes('/stage-') ? scratchEntries.has(path) : true; }, realpathSync: value => value,
  readdirSync(path) {
    if (path.endsWith('/releases')) return [a, b];
    if (path.endsWith('/bin') || path.endsWith(a) || path.endsWith(b)) return [];
    return ['.kite-native-install.json', 'active', 'bin', 'releases'];
  },
  lstatSync(path) {
    const file = path.endsWith('/active') || path.endsWith('/.kite-native-install.json');
    return { isSymbolicLink: () => false, isDirectory: () => !file, isFile: () => file };
  },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/locks.ts'))}, () => ({
  acquireFileLock(path, kind) {
    assert.equal(kind, 'exclusive');
    assert.equal(regions.has(path), false);
    regions.add(path); events.push('acquire:' + path);
    let closed = false;
    return { release() { if (!closed) { regions.delete(path); events.push('close:' + path); closed = true; } } };
  },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-coordination.ts'))}, () => ({
  windowsInstallationCoordination(prefix) {
    return { prefix, root: prefix + '-coord', selectionLockPath: prefix + '-selection',
      candidateLockPath: id => prefix + '-use-' + id, verify() {},
      release() { events.push('coord-close:' + prefix); if (mode === 'selection') throw cleanup; },
    };
  },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-path-security.ts'))}, () => ({
  privateDirectory(path) { if(mode === 'move') scratchEntries.add(path); },
  defaultWindowsPathSecurity() { return {
    verifyDirectory() {}, readScopeFile() { return Buffer.from(a + '\\n' + b + '\\n'); },
    writePrivateFile(path) { scratchEntries.add(path); events.push('write'); }, syncPrivateFile() { events.push('flush'); },
    movePrivateEntry(from,to,replace) {
      assert.equal(replace,true); assert.equal(to,'/owned-move/active'); assert.ok(scratchEntries.has(from));
      scratchEntries.delete(from); transferHandles.add(to); events.push('move-completed'); throw cleanup;
    },
  }; },
}));
mock.module(${JSON.stringify(modulePath('apps/cli/host/windows-native-installation.ts'))}, () => ({
  readWindowsNativeInstallation(root) { return { root, bootstrap: { candidateId: a, files: [] } }; },
  retainWindowsNativeFrontdoor() { return { verify() { if(mode !== 'move') throw primary; }, release() { events.push('frontdoor-close'); } }; },
  parseWindowsNativeInstallationMarker: value => value,
  windowsNativeFrontdoorNames: [],
}));
mock.module(${JSON.stringify(modulePath('apps/service/src/runtime-assets.ts'))}, () => ({ retainWindowsTerminalRuntimeFiles() {} }));
mock.module(${JSON.stringify(modulePath('apps/service/src/native-runtime-assets.ts'))}, () => ({ retainWindowsNativeRuntimeFiles() {}, verifyNativeRuntimeBundle(root) { return { digest: root.endsWith(b) ? b : a }; } }));
mock.module(${JSON.stringify(modulePath('apps/cli/host/cli-registration.ts'))}, () => ({
  OWNED_CLI_REGISTRATION_FILE: '.cli-registration.json',
  readCLIRegistration() { return mode === 'registration' ? owned : undefined; }, sameCLIRegistration: (a,b) => a === b,
}));
mock.module(${JSON.stringify(modulePath('scripts/release/cli-registration.ts'))}, () => ({
  acquireCLIRegistrationLocks(prefixes) {
    return prefixes.map(prefix => {
      const lock = prefix + '-selection';
      assert.equal(regions.has(lock), false); regions.add(lock); events.push('acquire:' + lock);
      return { release() { regions.delete(lock); events.push('close:' + lock); } };
    });
  },
  registerNativeCLIWhileLocked() { throw Error('unexpected-register'); },
  unregisterNativeCLIWhileLocked() {}, verifyCLIRegistrationTargetWhileLocked(target, locks) { assert.equal(mode, 'registration'); assert.equal(target, '/terminal'); assert.equal(locks.length, 2); events.push('target-preflight'); throw primary; },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))}, () => ({
  WindowsInstallationRemovalAcquireUnknownError,
  retainWindowsInstallationRemoval() { if(mode === 'move') return { remove() { events.push('scratch-removed'); scratchEntries.clear(); }, release() { events.push('scratch-close'); } }; throw mode === 'unknown' ? unknown : primary; },
}));
const { rollbackWindowsNativeBundle, uninstallWindowsNativeBundle } = await import(${JSON.stringify(modulePath('scripts/release/windows-native-install.ts'))});
if (mode === 'move') {
  assert.throws(() => rollbackWindowsNativeBundle('/owned-move'), error => error === cleanup);
  assert.deepEqual([...regions], ['/owned-move-selection']);
  assert.deepEqual([...transferHandles], ['/owned-move/active']);
  assert.deepEqual(events, ['acquire:/owned-move-selection', 'write', 'flush', 'move-completed']);
  assert.equal(events.some(event=> /close|removed/.test(event)),false);
} else if (mode === 'registration') {
  assert.throws(() => rollbackWindowsNativeBundle('/owned-registration'), error => error === primary);
  assert.equal(regions.size, 0);
  assert.deepEqual(events, ['acquire:/owned-registration-selection', 'acquire:/terminal-selection', 'target-preflight', 'frontdoor-close', 'coord-close:/owned-registration', 'close:/terminal-selection', 'close:/owned-registration-selection']);
} else if (mode === 'selection') {
  const prefix = '/owned-selection';
  assert.throws(() => rollbackWindowsNativeBundle(prefix), error => {
    assert.equal(error.message, 'native_windows_close_unknown');
    assert.deepEqual(error.errors, [primary, cleanup]); return true;
  });
  assert.deepEqual([...regions], [prefix + '-selection']);
  assert.deepEqual(events, ['acquire:' + prefix + '-selection', 'frontdoor-close', 'coord-close:' + prefix]);
} else {
  mode = 'ordinary';
  assert.throws(() => uninstallWindowsNativeBundle('/owned-ordinary'), error => error === primary);
  assert.equal(regions.size, 0);
  assert.deepEqual(events.filter(event => event.startsWith('close:')), [
    'close:/owned-ordinary-use-' + createHash('sha256').update(b + '\\0terminal').digest('hex'),
    'close:/owned-ordinary-use-' + b,
    'close:/owned-ordinary-use-' + createHash('sha256').update(a + '\\0terminal').digest('hex'),
    'close:/owned-ordinary-use-' + a, 'close:/owned-ordinary-selection',
  ]);
  assert.ok(events.indexOf('coord-close:/owned-ordinary') < events.indexOf('close:/owned-ordinary-selection'));
  events.length = 0; mode = 'unknown';
  assert.throws(() => uninstallWindowsNativeBundle('/owned-unknown'), error => error === unknown);
  assert.deepEqual([...regions], ['/owned-unknown-selection', '/owned-unknown-use-' + a, '/owned-unknown-use-' + createHash('sha256').update(a + '\\0terminal').digest('hex'), '/owned-unknown-use-' + b, '/owned-unknown-use-' + createHash('sha256').update(b + '\\0terminal').digest('hex')]);
  assert.deepEqual(unknown.errors, [primary, cleanup]);
  assert.equal(events.some(event => event.startsWith('close:') || event.startsWith('coord-close:')), false);
}
console.log('owned-close-confirmed');
`;
}

test('Windows Native marker seals all four ordered bootstrap identities and rejects unsealed fields', () => {
  const root = 'C:\\private\\native';
  const value = {
    version: 2,
    root,
    bootstrap: {
      candidateId: 'a'.repeat(64),
      files: windowsNativeFrontdoorNames.map((name) => ({
        name,
        size: 128,
        sha256: 'b'.repeat(64),
      })),
    },
  };
  const marker = parseWindowsNativeInstallationMarker(value, root);
  expect(marker.bootstrap.files.map((file) => file.name)).toEqual([
    'kite.exe',
    'kite-tui.exe',
    'kite-desktop.exe',
    'native-verifier.exe',
  ]);
  expect(Object.isFrozen(marker.bootstrap.files)).toBe(true);
  expect(() => parseWindowsNativeInstallationMarker({ ...value, extra: true }, root)).toThrow(
    'native_windows_install_identity_mismatch',
  );
  expect(() =>
    parseWindowsNativeInstallationMarker(
      { ...value, bootstrap: { ...value.bootstrap, files: [...value.bootstrap.files].reverse() } },
      root,
    ),
  ).toThrow('native_windows_install_identity_mismatch');
  expect(() => parseWindowsNativeInstallationMarker(value, 'C:\\other')).toThrow(
    'native_windows_install_identity_mismatch',
  );
  expect(() =>
    parseWindowsNativeInstallationMarker(
      { ...value, bootstrap: { ...value.bootstrap, files: value.bootstrap.files.slice(0, 3) } },
      root,
    ),
  ).toThrow('native_windows_install_identity_mismatch');
});
