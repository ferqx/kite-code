import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const native = fileURLToPath(new URL('../../../src/tools/browser/native.ts', import.meta.url));
const owned = fileURLToPath(
  new URL('../../../src/platform/process/linux-owned-program.ts', import.meta.url),
);

// Each injected fault has a fresh admission table and module-mock registry. The
// owner, sockets and scanner handles are fakes; no Chrome, native owner or socket
// is launched. Real temporary directories only exercise disposal/retention.
for (const fault of [
  'missing_entry',
  'permission',
  'open_failure',
  'directory_close',
  'file_close',
  'stalled_read',
] as const) {
  test(`native storage scanner handles ${fault} without inventing cleanup proof`, () => {
    const source = `
import realAssert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
let assertions = 0;
const assert = new Proxy(realAssert, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
}});
const fault = ${JSON.stringify(fault)};
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });
Object.defineProperty(process, 'geteuid', { value: () => 1000 });
delete process.env.CI;
const base = fs.mkdtempSync(join(tmpdir(), 'ab-res-'));
const originalLstat = fs.lstatSync, originalOpen = fs.openSync;
const originalRead = fs.readSync, originalClose = fs.closeSync;
let cgroupPosition = 0, starts = 0, current;
const endpoints = new Map();
const realTimeout = globalThis.setTimeout;
// Accelerate scanner cadence/deadline and local join timeout. These assertions
// establish stop/retention decisions, not elapsed-time or OS-quota guarantees.
globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback,
  ms === 1000 ? 10 : ms === 500 ? 30 : ms, ...args);
require('node:net');
mock.module('node:fs', () => ({ ...fs,
  lstatSync(path, ...args) {
    if (path === '/.dockerenv' || path === '/run/.containerenv')
      throw Object.assign(Error('fixture absent'), { code: 'ENOENT' });
    if (endpoints.has(path)) return { isSocket: () => true, uid: process.getuid() };
    return originalLstat(path, ...args);
  },
  openSync(path, ...args) {
    if (path === '/proc/self/cgroup' || path === '/proc/1/cgroup') { cgroupPosition = 0; return -10; }
    return originalOpen(path, ...args);
  },
  readSync(fd, buffer, offset, length, position) {
    if (fd !== -10) return originalRead(fd, buffer, offset, length, position);
    const count = Buffer.from('0::/user.slice').copy(buffer, offset, cgroupPosition, cgroupPosition + length);
    cgroupPosition += count; return count;
  },
  closeSync(fd) { if (fd !== -10) return originalClose(fd); },
}));
mock.module('node:fs/promises', () => ({ ...promises,
  async open(path, flags) {
    const fixture = current;
    assert.equal(path, fixture.directory);
    assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    assert.equal(flags & fs.constants.O_DIRECTORY, fs.constants.O_DIRECTORY);
    fixture.opens++;
    if (fixture.fault === 'open_failure') throw Object.assign(Error('open denied'), { code: 'EACCES' });
    return { fd: 900,
      async stat() { return originalLstat(path); },
      async close() {
        fixture.fileCloses++;
        fixture.scanClosed();
        if (fixture.fault === 'file_close') throw Error('file close receipt unknown');
      },
    };
  },
  async opendir(path, options) {
    const fixture = current;
    assert.equal(path, '/proc/self/fd/900', 'enumeration stays anchored to the opened directory');
    assert.equal(options.bufferSize, 32);
    let reads = 0;
    return {
      async read() {
        fixture.reads++;
        if (fixture.fault === 'stalled_read') return new Promise(resolve => { fixture.releaseRead = () => resolve(null); });
        if (reads++ === 0 && ['missing_entry', 'permission'].includes(fixture.fault)) return { name: 'raced-entry' };
        return null;
      },
      async close() {
        fixture.directoryCloses++;
        if (fixture.fault === 'directory_close') throw Error('directory close receipt unknown');
      },
    };
  },
  async lstat(path) {
    assert.equal(path, '/proc/self/fd/900/raced-entry');
    current.entryStats++;
    throw Object.assign(Error('injected child lookup failure'), { code: current.fault === 'missing_entry' ? 'ENOENT' : 'EACCES' });
  },
}));
mock.module('node:net', () => ({ ...net, createConnection(path) {
  const socket = new EventEmitter();
  let destroyed = false;
  socket.destroy = () => { if (!destroyed) { destroyed = true; queueMicrotask(() => socket.emit('close')); } return socket; };
  socket.write = (bytes, callback) => { callback(); queueMicrotask(() => endpoints.get(path)(socket, bytes)); return true; };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}}));
mock.module(${JSON.stringify(owned)}, () => ({
  LinuxOwnedProgramStartError: class extends Error {},
  startLinuxOwnedProgram(options) {
    starts++;
    const session = options.env.AGENT_BROWSER_SESSION;
    const endpoint = join(options.cwd, session + '.sock');
    fs.writeFileSync(join(options.cwd, session + '.version'), '0.39.4');
    let finish, scanClosed;
    const completion = new Promise(resolve => { finish = resolve; });
    const firstScanClosed = new Promise(resolve => { scanClosed = resolve; });
    const evidence = {
      version: 1, ownerPid: process.pid, coverage: 'linux-pid-namespace', admission: { nonce: options.nonce, purpose: 'stdio' },
      phase: 'ready', fdClosed: false, closeUnknown: false,
      wrapper: { exit: null, closed: false, stdoutEof: false, stderrEof: false },
      namespace: { treeStopped: false, init: { dead: false }, root: { localPid: 2, dead: false, waitReceipt: null } },
    };
    const fixture = { fault: starts === 1 ? fault : 'healthy', directory: options.cwd,
      cancels: 0, opens: 0, reads: 0, directoryCloses: 0, fileCloses: 0, entryStats: 0,
      requests: [], firstScanClosed, scanClosed,
    };
    const owner = { pid: 100, stdout: new PassThrough(), stderr: new PassThrough(), ready: Promise.resolve(), completion,
      readProcessEvidence: () => structuredClone(evidence),
      cancel() {
        fixture.cancels++;
        endpoints.delete(endpoint);
        evidence.phase = 'terminal'; evidence.fdClosed = true;
        evidence.wrapper = { exit: { code: 0, signal: null, reaped: true }, closed: true, stdoutEof: true, stderrEof: true };
        evidence.namespace.treeStopped = true; evidence.namespace.init.dead = true; evidence.namespace.root.dead = true;
        evidence.namespace.root.waitReceipt = { waitConfirmed: true, reaped: true };
        owner.stdout.end(); owner.stderr.end(); finish({ confirmed: true });
        return completion;
      },
    };
    endpoints.set(endpoint, (socket, bytes) => {
      const command = JSON.parse(bytes); fixture.requests.push(command);
      assert.equal(command.action, 'session_info', 'resource tests never send a browser launch or webpage action');
      socket.emit('data', Buffer.from(JSON.stringify({ id: command.id, success: true,
        data: { session, socketDir: options.cwd, backgroundPid: 2, browserLaunched: false } }) + '\\n'));
    });
    current = fixture;
    return owner;
  },
}));
const { createNativeBrowserTransport } = await import(${JSON.stringify(native)});
const options = { executable: process.execPath, browserPath: process.execPath,
  linux: { bubblewrapPath: process.execPath, initExecutable: process.execPath }, runtimeDirectory: base };
const context = () => ({ sessionId: 'fixture', executionId: 'scanner', signal: new AbortController().signal });
const transport = createNativeBrowserTransport(options, context());
const fixture = current;
await transport.ready;
assert.equal(fixture.requests.length, 1);
const unknown = ['directory_close', 'file_close', 'stalled_read'].includes(fault);
if (fault === 'missing_entry') {
  await fixture.firstScanClosed;
  assert.equal(fixture.entryStats, 1);
  assert.equal(fixture.cancels, 0, 'a disappearing child is not a failed scan');
  assert.deepEqual(await transport.close(), { confirmed: true });
} else {
  assert.deepEqual(await transport.completion, { confirmed: !unknown });
  assert.equal(fixture.cancels, 1, 'scanner failure requests exactly one owner stop');
}
assert.equal(fixture.opens, 1, 'failed scanner never schedules another pass');
if (fault === 'stalled_read') {
  assert.equal(fixture.directoryCloses, 0, 'pending read cannot be represented as closed');
  assert.equal(fixture.fileCloses, 0);
  fixture.releaseRead(); await fixture.firstScanClosed; await Promise.resolve();
  assert.deepEqual(await transport.close(), { confirmed: false }, 'late local completion cannot rewrite the original unknown stop proof');
}
assert.equal(fixture.directoryCloses, fault === 'open_failure' ? 0 : 1);
assert.equal(fixture.fileCloses, fault === 'open_failure' ? 0 : 1, 'outer file close still runs after directory-close failure');
if (unknown) {
  await assert.rejects(transport.dispose(), /browser_native_cleanup_unknown/);
  assert.equal(fs.existsSync(fixture.directory), true, 'unknown local cleanup preserves private storage');
  const second = createNativeBrowserTransport(options, context()); await second.ready;
  assert.throws(() => createNativeBrowserTransport(options, context()), /browser_native_session_limit/,
    'unknown local cleanup retains admission even after owner-tree stop');
  await second.dispose();
} else {
  await transport.dispose();
  assert.equal(fs.existsSync(fixture.directory), false);
}
// No native process/socket/FD exists in this fixture, including unknown cases.
fs.rmSync(base, { recursive: true, force: true });
console.log('browser-resource-fixture-ok fault=' + fault + ' assertions=' + assertions + ' fake-daemon-starts=' + starts);
`;
    const result = spawnSync(process.execPath, ['--eval', source], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    console.info(result.stdout.trim());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`browser-resource-fixture-ok fault=${fault}`);
  }, 15000);
}
