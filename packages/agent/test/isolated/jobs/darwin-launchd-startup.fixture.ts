import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as actualChild from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as actualNet from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const bootstrapUnknown = process.argv[2] === 'bootstrap-unknown';
const calls: string[][] = [];
let originalTarget: string | undefined;
let registrationRoot: string | undefined;
const realCreateServer = actualNet.createServer;
const originalError = Object.assign(
  new Error('listen EPERM: operation not permitted control.sock'),
  {
    code: 'EPERM',
    syscall: 'listen',
    address: 'control.sock',
  },
);
let listenCalls = 0;
let spawnCalls = 0;
mock.module('node:net', () => ({
  ...actualNet,
  createServer(...args: Parameters<typeof actualNet.createServer>) {
    const server = realCreateServer(...args);
    server.listen = ((path: string, callback: () => void) => {
      assert.equal(path, 'control.sock');
      listenCalls++;
      queueMicrotask(() => {
        if (bootstrapUnknown) callback();
        else server.emit('error', originalError);
      });
      return server;
    }) as typeof server.listen;
    return server;
  },
}));
mock.module('node:child_process', () => ({
  ...actualChild,
  spawn(executable: string, args: string[]) {
    spawnCalls++;
    if (!bootstrapUnknown) throw Error('unexpected bootstrap spawn');
    assert.equal(executable, '/bin/launchctl');
    calls.push([...args]);
    if (args[0] === 'bootstrap') {
      assert.equal(calls.length, 1);
      registrationRoot = join(args[2]!, '..');
      const registration = JSON.parse(readFileSync(join(registrationRoot, 'owner.json'), 'utf8'));
      originalTarget = `${registration.domain}/${registration.label}`;
      assert.equal(args[1], registration.domain);
    } else {
      assert.equal(args[1], originalTarget);
      assert.equal(existsSync(join(registrationRoot!, 'owner.json')), true);
      assert.equal(args[0], calls.length === 2 ? 'bootout' : 'print');
      assert.ok(calls.length <= 3);
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        throw Error('unexpected launchctl timeout');
      },
    });
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      const code = args[0] === 'bootstrap' ? null : args[0] === 'bootout' ? 0 : 113;
      child.emit('exit', code, code === null ? 'SIGKILL' : null);
      child.emit('close', code, code === null ? 'SIGKILL' : null);
    });
    return child;
  },
}));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-launchd-startup-')));
const originalCwd = process.cwd();
const unrelated = Buffer.from('unrelated original private bytes\n');
writeFileSync(join(root, 'unrelated'), unrelated, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ root }));
let confirmed = false;
try {
  const { startLaunchdSupervisor } = await import(
    '../../../src/platform/process/darwin-launchd-supervisor'
  );
  let caught: unknown;
  try {
    await startLaunchdSupervisor({
      kind: 'mcp',
      controlBase: root,
      frame: { type: 'start', nonce: 'original-startup-nonce' },
      async onFrame() {
        throw Error('unexpected guardian frame');
      },
    });
  } catch (error) {
    caught = error;
  }
  if (bootstrapUnknown) {
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'launchd_bootstrap_failed');
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['bootstrap', 'bootout', 'print'],
    );
    assert.equal(spawnCalls, 3);
  } else {
    assert.equal(caught, originalError);
    assert.equal(originalError.code, 'EPERM');
    assert.equal(originalError.syscall, 'listen');
    assert.equal(originalError.address, 'control.sock');
    assert.equal(listenCalls, 1);
    assert.equal(spawnCalls, 0);
  }
  assert.deepEqual(readFileSync(join(root, 'unrelated')), unrelated);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith('mcp-') && !name.endsWith('.json')),
    [],
  );
  const failures = readdirSync(root).filter((name) =>
    /^mcp-failure-[a-f0-9-]{36}\.json$/.test(name),
  );
  assert.equal(failures.length, 1);
  const diagnostic = JSON.parse(readFileSync(join(root, failures[0]!), 'utf8'));
  assert.equal(
    diagnostic.code,
    bootstrapUnknown ? 'launchd_bootstrap_failed' : originalError.message,
  );
  if (!bootstrapUnknown) {
    assert.equal(diagnostic.causeCode, 'EPERM');
    assert.equal(diagnostic.syscall, 'listen');
    assert.equal(diagnostic.address, 'control.sock');
  }
  assert.equal(diagnostic.guardianStderr, null);
  confirmed = true;
  console.log(
    bootstrapUnknown
      ? 'original-bootstrap-unknown-cleanup-confirmed'
      : 'original-listen-error-and-cleanup-confirmed',
  );
} finally {
  process.chdir(originalCwd);
  if (confirmed) rmSync(root, { recursive: true });
}
