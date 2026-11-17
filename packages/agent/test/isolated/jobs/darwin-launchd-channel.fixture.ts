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
const heldAuthentication = mode === 'auth-held-timeout';
const slowAuthentication = mode === 'auth-slow';
const cleanupUnconfirmed = mode === 'auth-cancel-cleanup-unconfirmed';
const cancellation =
  mode === 'auth-cancelled' || cleanupUnconfirmed ? new AbortController() : undefined;
const interruptedAuthentication = heldAuthentication || !!cancellation;
const delayedAuthentication = heldAuthentication || slowAuthentication;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-channel-mock-')));
const cwd = process.cwd();
const calls: string[][] = [];
const frames: Record<string, unknown>[] = [];
const writes: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
let callback: (socket: unknown) => void;
let registration: { secret: string; label: string; domain: string };
let removed = false;
const began = performance.now();
let authenticationPending = false;
let closeAttemptedAt: number | undefined;
let closeCompleted = false;
let closeCallback: (() => void) | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let settleOnFrame!: () => void;
const onFrameGate = new Promise<void>((resolve) => {
  settleOnFrame = resolve;
});
let settleAuthentication!: () => void;
const authenticationDone = new Promise<void>((resolve) => {
  settleAuthentication = resolve;
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
    writes.push(value.type);
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
const unauthenticatedSocket = new Channel();
const lateSocket = new Channel();
const accepted = interruptedAuthentication ? [socket, unauthenticatedSocket, lateSocket] : [socket];
const openSockets = new Set(accepted);
function settleServerClose() {
  if (openSockets.size === 0) {
    const done = closeCallback;
    closeCallback = undefined;
    done?.();
  }
}
for (const channel of accepted)
  channel.on('close', () => {
    openSockets.delete(channel);
    settleServerClose();
  });
const server = Object.assign(new EventEmitter(), {
  listen(path: string, ready: () => void) {
    assert.equal(path, 'control.sock');
    queueMicrotask(ready);
    return server;
  },
  close(done?: (error?: Error) => void) {
    if (interruptedAuthentication) {
      closeAttemptedAt = performance.now() - began;
      closeCallback = () => {
        closeCompleted = true;
        queueMicrotask(() => done?.());
      };
      // Already queued connections can reach the callback while closing.
      callback(lateSocket);
      settleServerClose();
    } else queueMicrotask(() => done?.());
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
  // A delayed identity reply remains the exact successful observation captured
  // before bootout, so rejection cannot rely on that late reply becoming absent.
  const wasRemoved = removed;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      throw Error('unexpected fake launchctl timeout');
    },
  });
  const complete = () => {
    if (args[0] === 'bootstrap') {
      const plist = readFileSync(args[2]!, 'utf8');
      const processType = kind === 'shell' ? 'Standard' : 'Background';
      assert.ok(plist.includes(`<key>ProcessType</key><string>${processType}</string>`));
      assert.ok(plist.includes('<key>LimitLoadToSessionType</key><string>Background</string>'));
      registration = JSON.parse(readFileSync(join(dirname(args[2]!), 'owner.json'), 'utf8'));
      callback(socket);
      if (interruptedAuthentication) callback(unauthenticatedSocket);
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
    const code = args[0] === 'print' && wasRemoved ? (cleanupUnconfirmed ? 77 : 113) : 0;
    child.stdout.end(args[0] === 'print' && !wasRemoved ? '\tpid = 777\n' : '');
    child.stderr.end();
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
  if (delayedAuthentication && args[0] === 'bootstrap') setTimeout(complete, 1500);
  else if ((delayedAuthentication || cancellation) && args[0] === 'print' && !removed) {
    // With delayed bootstrap, keep the PID check pending beyond the original
    // four-second deadline while staying within launchctl's separate budget.
    authenticationPending = true;
    setTimeout(
      () => {
        authenticationPending = false;
        complete();
        settleAuthentication();
      },
      cancellation ? 200 : 2700,
    );
    cancellation?.abort();
  } else queueMicrotask(complete);
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
  const { LaunchdStartupCancelled, startLaunchdSupervisor } = await import(
    join(root, 'supervisor.ts')
  );
  const starting = startLaunchdSupervisor({
    kind,
    controlBase: root,
    startSignal: cancellation?.signal,
    frame: { type: 'start', nonce: 'nonce' },
    async onFrame(frame: Record<string, unknown>) {
      if (mode === 'delayed-handler' && frame.type === 'ready') await onFrameGate;
      frames.push(frame);
    },
  });
  if (interruptedAuthentication) {
    let caught: unknown;
    try {
      await Promise.race([
        starting,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Error('fixture_startup_cleanup_deadlock')), 5000);
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    clearTimeout(deadline);
    console.log(
      JSON.stringify({
        mode,
        closeAttemptedAt,
        closeCompleted,
        authenticationPending,
        destroyed: accepted.map((value) => value.destroyed),
        calls: calls.map((args) => args[0]),
        error: caught instanceof Error ? caught.message : null,
        noNativeSpawn: true,
      }),
    );
    const expectedError = cleanupUnconfirmed
      ? 'launchd_start_cleanup_unconfirmed'
      : cancellation
        ? 'launchd_start_cancelled'
        : 'launchd_guardian_start_timeout';
    assert.equal(caught instanceof Error ? caught.message : null, expectedError);
    assert.equal(caught instanceof LaunchdStartupCancelled, !!cancellation && !cleanupUnconfirmed);
    if (heldAuthentication) assert.ok(closeAttemptedAt! >= 3800);
    assert.equal(authenticationPending, true);
    assert.equal(closeCompleted, true);
    assert.deepEqual(
      accepted.map((value) => value.destroyed),
      [true, true, true],
    );
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['bootstrap', 'print', 'bootout', 'print'],
    );
    assert.equal(frames.length, 0);
    // Let the successful original PID response arrive after startup cleanup.
    // It must not send any business frame or escape as an unhandled rejection.
    await authenticationDone;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authenticationPending, false);
    assert.deepEqual(writes, []);
    assert.deepEqual(unhandled, []);
    assert.equal(frames.length, 0);
    console.log(
      JSON.stringify({ lateAuthenticationCompleted: true, businessWrites: 0, unhandled: 0 }),
    );
  } else {
    const bridge = await starting;
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
    const valid = [
      'valid',
      'delayed-handler',
      'split-utf8',
      'eof-half-close',
      'auth-slow',
    ].includes(mode);
    assert.equal(
      !error,
      valid,
      `${kind}/${mode}: ${error instanceof Error ? error.message : 'resolved'}`,
    );
    assert.notEqual(error instanceof Error ? error.message : '', 'fixture_test_deadlock');
    assert.equal(frames.filter((frame) => frame.type === 'terminal').length, valid ? 1 : 0);
    if (valid) assert.equal(frames[0]?.content, '慢');
    assert.equal(calls.filter((args) => args[0] === 'bootout').length, valid ? 1 : 0);
    if (slowAuthentication) {
      assert.ok(performance.now() - began > 4000);
      assert.deepEqual(writes, ['start']);
    }
    console.log(
      JSON.stringify({ kind, mode, valid, terminalDelivered: valid, noNativeSpawn: true }),
    );
  }
} finally {
  process.off('unhandledRejection', onUnhandled);
  clearTimeout(deadline);
  process.chdir(cwd);
  rmSync(root, { recursive: true });
}
