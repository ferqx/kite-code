import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// No native process, launchctl or listening socket is ever started. Instrument
// only these two OS imports in a private copy of the production broker source.
const kind = process.argv[2] as 'browser' | 'mcp' | 'shell';
const mode = process.argv[3]!;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-channel-mock-')));
const cwd = process.cwd();
const calls: string[][] = [];
const frames: Record<string, unknown>[] = [];
let callback: (socket: unknown) => void;
let registration: { secret: string; label: string; domain: string };
let removed = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
let settleOnFrame!: () => void;
const onFrameGate = new Promise<void>((resolve) => {
  settleOnFrame = resolve;
});
class Channel extends EventEmitter {
  writable = true;
  destroyed = false;
  setEncoding() {
    return this;
  }
  pause() {
    return this;
  }
  resume() {
    return this;
  }
  end() {
    this.writable = false;
    if (mode === 'eof-half-close') queueMicrotask(() => this.emit('close'));
    return this;
  }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => {
      if (error) this.emit('error', error);
      this.emit('close');
    });
    return this;
  }
  write(content: string, done?: (error?: Error) => void) {
    const value = JSON.parse(content);
    queueMicrotask(() => done?.());
    if (value.type === 'start') {
      setImmediate(() => {
        const line = (v: object) => JSON.stringify({ nonce: 'nonce', ...v }) + '\n';
        const ready = line({ type: 'ready', sequence: 1, content: '慢' });
        const terminal = line({ type: 'terminal', sequence: 2, groupStopped: true });
        if (mode === 'split-utf8') {
          const bytes = Buffer.from(ready),
            split = bytes.indexOf(Buffer.from('慢')) + 1;
          this.emit('data', bytes.subarray(0, split));
          this.emit('data', bytes.subarray(split));
        } else this.emit('data', Buffer.from(ready));
        if (mode !== 'no-terminal') this.emit('data', Buffer.from(terminal));
        if (mode === 'duplicate') this.emit('data', Buffer.from(terminal));
        if (mode === 'partial') this.emit('data', Buffer.from('{'));
        if (mode === 'bad-json') this.emit('data', Buffer.from('not-json\n'));
        if (mode === 'invalid-utf8') this.emit('data', Buffer.from([0xff, 0x0a]));
        if (mode === 'error') this.emit('error', Error('fixture_socket_error'));
        setImmediate(() => {
          if (mode === 'extra') this.emit('data', Buffer.from(line({ type: 'invalid' })));
          if (mode !== 'no-eof' && mode !== 'close-only') this.emit('end');
          if (!['no-eof', 'no-close', 'eof-half-close'].includes(mode)) this.emit('close');
        });
        // A terminal isn't permission to resolve before the incoming EOF. In
        // the delayed-handler case EOF intentionally precedes handler finish.
        setTimeout(settleOnFrame, 10);
      });
    }
    return true;
  }
}
const socket = new Channel();
const server = Object.assign(new EventEmitter(), {
  listen(path: string, ready: () => void) {
    assert.equal(path, 'control.sock');
    queueMicrotask(ready);
    return server;
  },
  close(done?: (error?: Error) => void) {
    queueMicrotask(() => done?.());
    return server;
  },
});
const fixtureGlobal = globalThis as unknown as { fixtureNet: unknown; fixtureSpawn: unknown };
fixtureGlobal.fixtureNet = {
  createServer(fn: typeof callback) {
    callback = fn;
    return server;
  },
  createConnection() {
    throw Error('unexpected connection');
  },
};
fixtureGlobal.fixtureSpawn = (executable: string, args: string[]) => {
  assert.equal(executable, '/bin/launchctl');
  calls.push([...args]);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      throw Error('unexpected fake launchctl timeout');
    },
  });
  queueMicrotask(() => {
    if (args[0] === 'bootstrap') {
      registration = JSON.parse(readFileSync(join(dirname(args[2]!), 'owner.json'), 'utf8'));
      callback(socket);
      socket.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'guardian', secret: registration.secret, pid: 777 }) + '\n',
        ),
      );
    } else {
      assert.equal(args[1], registration.domain + '/' + registration.label);
      if (args[0] === 'bootout') removed = true;
      else assert.equal(args[0], 'print');
    }
    const code = args[0] === 'print' && removed ? 113 : 0;
    child.stdout.end(args[0] === 'print' && !removed ? '\tpid = 777\n' : '');
    child.stderr.end();
    child.emit('exit', code, null);
    child.emit('close', code, null);
  });
  return child;
};
Object.defineProperty(process, 'platform', { value: 'darwin' });
const supervisor = fileURLToPath(
  new URL('../../../src/platform/process/darwin-launchd-supervisor.ts', import.meta.url),
);
const identity = fileURLToPath(new URL('../../../src/jobs/launch-identity.ts', import.meta.url));
const original = readFileSync(supervisor, 'utf8');
assert.ok(original.includes("import { spawn } from 'node:child_process';"));
assert.ok(
  original.includes("import { createConnection, createServer, type Socket } from 'node:net';"),
);
assert.ok(original.includes("'../../jobs/launch-identity'"));
const instrumented = original
  .replace("import { spawn } from 'node:child_process';", 'const spawn = globalThis.fixtureSpawn;')
  .replace(
    "import { createConnection, createServer, type Socket } from 'node:net';",
    'const {createConnection,createServer}=globalThis.fixtureNet;type Socket=any;',
  )
  .replace("'../../jobs/launch-identity'", JSON.stringify(identity));
assert.notEqual(instrumented, original);
writeFileSync(join(root, 'supervisor.ts'), instrumented);
try {
  const { startLaunchdSupervisor } = await import(join(root, 'supervisor.ts'));
  const bridge = await startLaunchdSupervisor({
    kind,
    controlBase: root,
    frame: { type: 'start', nonce: 'nonce' },
    async onFrame(frame: Record<string, unknown>) {
      if (mode === 'delayed-handler' && frame.type === 'ready') await onFrameGate;
      frames.push(frame);
    },
  });
  let error: unknown;
  try {
    await Promise.race([
      bridge.finished,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('fixture_test_deadlock')), 2500);
      }),
    ]);
  } catch (cause) {
    error = cause;
  }
  clearTimeout(deadline);
  const valid = ['valid', 'delayed-handler', 'split-utf8', 'eof-half-close'].includes(mode);
  assert.equal(
    !error,
    valid,
    `${kind}/${mode}: ${error instanceof Error ? error.message : 'resolved'}`,
  );
  assert.notEqual(error instanceof Error ? error.message : '', 'fixture_test_deadlock');
  assert.equal(frames.filter((frame) => frame.type === 'terminal').length, valid ? 1 : 0);
  if (valid) assert.equal(frames[0]?.content, '慢');
  assert.equal(calls.filter((args) => args[0] === 'bootout').length, valid ? 1 : 0);
  console.log(JSON.stringify({ kind, mode, valid, terminalDelivered: valid, noNativeSpawn: true }));
} finally {
  clearTimeout(deadline);
  process.chdir(cwd);
  rmSync(root, { recursive: true });
}
