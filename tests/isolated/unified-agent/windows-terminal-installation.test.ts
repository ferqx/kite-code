import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function installerScript(scenario: 'selection' | 'removal') {
  return `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
const { WindowsInstallationRemovalAcquireUnknownError } = await import(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))});
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const regions = new Set(), events = [];
let mode = ${JSON.stringify(scenario)};
const primary = Error('original-admission-error'), cleanup = Error('original-close-error');
const unknown = new WindowsInstallationRemovalAcquireUnknownError(primary, cleanup);
mock.module('node:fs', () => ({ ...fs,
  existsSync() { return true; }, realpathSync: value => value,
  readdirSync(path) {
    if (path.endsWith('/releases')) return [a, b];
    if (path.endsWith('/bin') || path.endsWith(a) || path.endsWith(b)) return [];
    return ['.kite-terminal-install.json', 'active', 'bin', 'releases'];
  },
  lstatSync(path) {
    const file = path.endsWith('/active') || path.endsWith('/.kite-terminal-install.json');
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
  privateDirectory() {},
  defaultWindowsPathSecurity() { return { verifyDirectory() {}, readScopeFile() { return Buffer.from(a + '\\n' + b + '\\n'); } }; },
}));
mock.module(${JSON.stringify(modulePath('apps/cli/host/windows-terminal-installation.ts'))}, () => ({
  readWindowsTerminalInstallation(root) { return { root, bootstrap: { candidateId: a, files: [] } }; },
  retainWindowsTerminalFrontdoor() { return { verify() { throw primary; }, release() { events.push('frontdoor-close'); } }; },
  parseWindowsTerminalInstallationMarker: value => value,
  windowsTerminalFrontdoorNames: [],
}));
mock.module(${JSON.stringify(modulePath('apps/cli/host/terminal-artifact.ts'))}, () => ({ verifyTerminalBundle(root) { return { digest: root.endsWith(b) ? b : a }; } }));
mock.module(${JSON.stringify(modulePath('apps/service/src/runtime-assets.ts'))}, () => ({ retainWindowsTerminalRuntimeFiles() {}, verifyTerminalRuntimeBundle() {} }));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-removal.ts'))}, () => ({
  WindowsInstallationRemovalAcquireUnknownError,
  retainWindowsInstallationRemoval() { throw mode === 'unknown' ? unknown : primary; },
}));
const { rollbackWindowsTerminalBundle, uninstallWindowsTerminalBundle } = await import(${JSON.stringify(modulePath('scripts/release/windows-terminal-install.ts'))});
if (mode === 'selection') {
  const prefix = '/owned-selection';
  assert.throws(() => rollbackWindowsTerminalBundle(prefix), error => {
    assert.equal(error.message, 'terminal_windows_close_unknown');
    assert.deepEqual(error.errors, [primary, cleanup]); return true;
  });
  assert.deepEqual([...regions], [prefix + '-selection']);
  assert.deepEqual(events, ['acquire:' + prefix + '-selection', 'frontdoor-close', 'coord-close:' + prefix]);
} else {
  mode = 'ordinary';
  assert.throws(() => uninstallWindowsTerminalBundle('/owned-ordinary'), error => error === primary);
  assert.equal(regions.size, 0);
  assert.deepEqual(events.filter(event => event.startsWith('close:')), [
    'close:/owned-ordinary-use-' + b, 'close:/owned-ordinary-use-' + a, 'close:/owned-ordinary-selection',
  ]);
  assert.ok(events.indexOf('coord-close:/owned-ordinary') < events.indexOf('close:/owned-ordinary-selection'));
  events.length = 0; mode = 'unknown';
  assert.throws(() => uninstallWindowsTerminalBundle('/owned-unknown'), error => error === unknown);
  assert.deepEqual([...regions], ['/owned-unknown-selection', '/owned-unknown-use-' + a, '/owned-unknown-use-' + b]);
  assert.deepEqual(unknown.errors, [primary, cleanup]);
  assert.equal(events.some(event => event.startsWith('close:') || event.startsWith('coord-close:')), false);
}
console.log('owned-close-confirmed');
`;
}

test('Windows failed artifact admission closes resources before SH and preserves unknown original owners', () => {
  subprocess(`
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
Object.defineProperty(process, 'platform', { value: 'win32' });
mock.module('node:path', () => ({ ...path, ...path.posix }));
const id = 'a'.repeat(64), regions = new Set(), events = [];
let failScope = true;
const original = Error('original-attachment-rejected'), cleanup = Error('original-scope-close-unknown');
mock.module('node:fs', () => ({ ...fs, existsSync: () => true, realpathSync: value => value,
  lstatSync() { return { isDirectory: () => true, isSymbolicLink: () => false }; },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/locks.ts'))}, () => ({
  acquireFileLock(path) {
    assert.equal(regions.has(path), false); regions.add(path);
    return { release() { events.push('lock-close'); regions.delete(path); } };
  },
  attachLockResource(_lock, resource) { resource.verify(); },
  acquireInheritedSharedFileLock() { throw Error('unexpected-inherited'); },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-artifact-scope.ts'))}, () => ({
  retainWindowsArtifactScope() { return { verify() { throw original; }, release() { events.push('scope-close'); if (failScope) throw cleanup; } }; },
  retainWindowsArtifactObjects() { throw Error('unexpected-full-file-pin'); },
}));
mock.module(${JSON.stringify(modulePath('packages/agent/src/platform/windows-installation-coordination.ts'))}, () => ({
  windowsInstallationCoordination(prefix) { return { candidateLockPath: value => prefix + '-use-' + value, verify() {}, release() { events.push('coord-close'); } }; },
}));
const { acquireArtifactAccess } = await import(${JSON.stringify(modulePath('packages/agent/src/artifact-access.ts'))});
assert.throws(() => acquireArtifactAccess({ root: '/owned-artifact/releases/' + id, mode: 'shared' }), error => {
  assert.equal(error.message, 'artifact_access_acquire_close_unknown');
  assert.deepEqual(error.errors, [original, cleanup]); return true;
});
assert.deepEqual(events, ['scope-close']);
assert.deepEqual([...regions], ['/owned-artifact-use-' + id]);
events.length = 0; failScope = false;
assert.throws(() => acquireArtifactAccess({ root: '/owned-clean/releases/' + id, mode: 'shared' }), error => error === original);
assert.deepEqual(events, ['scope-close', 'coord-close', 'lock-close']);
assert.deepEqual([...regions], ['/owned-artifact-use-' + id]);
console.log('owned-close-confirmed');
`);
});
