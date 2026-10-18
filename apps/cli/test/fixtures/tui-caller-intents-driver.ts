import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  runner: string;
  databasePath: string;
  journal: string;
  root: string;
  request: string;
  cold: boolean;
  crash: 'prepared' | 'post-lost';
  marker: string;
  firstGet: string;
  wire: string;
  transcript: string;
  nativeReady: string;
  servicePidPath: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_caller_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'owned-caller-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
const output: Uint8Array[] = [];
const owned = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: input.root,
  onData: (bytes) => output.push(bytes.slice()),
});
let servicePid: number | undefined;
let failure: unknown;
let normal = false;
let interruptedAtOriginalWindow = false;
let nativeDispatch: { callerPid: number; exitCode: number } | undefined;
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await owned.key(value);
  // Preserve the original 100ms pump after every key.
  await Bun.sleep(100);
};
const pump = async () => {
  await Bun.sleep(100);
  await owned.drain();
};
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await owned.projection();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (owned.ended || Date.now() > end)
      throw Error(`expected ${text} tail=${frame.text.slice(-6000)}`);
    await pump();
  }
};
const until = async (test: () => boolean, message: string, ms: number) => {
  const end = Date.now() + ms;
  while (!test()) {
    abort.signal.throwIfAborted();
    if (owned.ended || Date.now() > end) throw Error(message);
    await pump();
  }
};
const exited = async (ms: number) => {
  const end = Date.now() + ms;
  while (!owned.ended && Date.now() < end) await pump();
  const [code] = await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    3000,
    'owned_caller_exit_unconfirmed',
  );
  return code;
};
const serviceGone = async () => {
  assert.ok(servicePid !== undefined && Number.isSafeInteger(servicePid) && servicePid > 0);
  const end = Date.now() + 3000;
  for (;;) {
    try {
      process.kill(servicePid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() > end) throw Error('owned_caller_service_exit_unconfirmed');
    await Bun.sleep(20);
  }
};
try {
  // A committed caller has exactly its original completed Model; a prepared-only
  // caller has no Run. Neither cold caller may dispatch the original work again.
  const completedCaller = input.cold && input.crash === 'post-lost';
  if (completedCaller) {
    const records = JSON.parse(readFileSync(input.journal, 'utf8')).records;
    assert.equal(records.length, 1);
    const original = records[0].intent;
    assert.equal(original.scope.sessionId, 'caller');
    assert.equal(original.request.content, input.request);
    const database = new Database(input.databasePath, { readonly: true });
    try {
      const runs = database
        .query('SELECT origin_command_id,is_active FROM run WHERE session_id=?')
        .all('caller');
      assert.deepEqual(runs, [{ origin_command_id: original.request.commandId, is_active: 0 }]);
    } finally {
      database.close();
    }
  }
  await wait(input.cold ? 'Session caller' : 'New Run');
  servicePid = Number(readFileSync(input.servicePidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0);
  process.kill(servicePid, 0);
  if (input.cold) {
    const graphemes = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.request),
    ).length;
    await key('\x7f'.repeat(graphemes));
    await key('/recovery');
    await key('\r');
    await wait('Saved caller intents 1');
    await wait('unknown');
    await key('\x0c');
    if (input.crash === 'post-lost') {
      await until(() => existsSync(input.firstGet), 'original GET was not dropped', 5000);
      await key('\x03');
      await pump();
      await key('\x0c');
      await wait('run.start · applied');
    } else {
      await until(
        () =>
          readFileSync(input.wire, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .some((row) => row.cold && row.path?.startsWith('/v1/commands/')),
        'original GET was not sent',
        5000,
      );
    }
    await key('\x03');
    await key('\x1b');
    await wait('Session caller');
    await key('\x11');
    assert.equal(await exited(6000), 0);
    await serviceGone();
    normal = true;
    console.log('COLD_ORIGINAL_GET_ONLY');
  } else {
    await key(`\x1b[200~${input.request}\x1b[201~`);
    await key('\r');
    if (process.platform === 'win32') {
      // The runner pauses at the same durable/committed window. Only this held
      // caller is force-terminated; its paired Service performs EOF cleanup.
      await until(
        () => existsSync(input.nativeReady),
        'original native crash window missing',
        10000,
      );
      const ready = JSON.parse(readFileSync(input.nativeReady, 'utf8'));
      assert.equal(ready.pid, owned.host.pid);
      assert.equal(ready.crash, input.crash);
      assert.equal(owned.ended, false);
      process.kill(owned.host.pid, 0);
      const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(owned.host.pid), '/f'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(dispatch.exitCode, 0, dispatch.stderr.toString());
      nativeDispatch = { callerPid: owned.host.pid, exitCode: dispatch.exitCode };
      assert.notEqual(await exited(10000), 0);
      assert.throws(() => process.kill(owned.host.pid, 0), { code: 'ESRCH' });
    } else {
      await exited(10000);
      assert.equal(owned.host.signalCode, 'SIGKILL');
    }
    assert.equal(existsSync(input.marker), true);
    await serviceGone();
    interruptedAtOriginalWindow = true;
    console.log(
      process.platform === 'win32' ? 'ACTUAL_CALLER_WINDOWS_FORCED_EXIT' : 'ACTUAL_CALLER_SIGKILL',
    );
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (!owned.ended)
      await terminateTuiTree(owned, {
        exitTimeoutMs: 3000,
        servicePid,
        serviceExitTimeoutMs: 3000,
        requireServiceAlive: false,
      });
    await owned.drain();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Caller cleanup failed') : error;
  } finally {
    owned.close();
  }
  try {
    writeFileSync(input.transcript, Buffer.concat(output), { flag: 'a', mode: 0o600 });
    writeFileSync(
      `${input.transcript}.${input.cold ? 'cold' : 'producer'}.receipt.json`,
      JSON.stringify({
        pid: owned.host.pid,
        servicePid,
        cold: input.cold,
        crash: input.crash,
        normal,
        interruptedAtOriginalWindow,
        nativeDispatch,
        exitCode: owned.host.exitCode,
        signal: owned.host.signalCode,
        failure: failure ? String(failure) : null,
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    if (process.platform === 'win32') {
      process.removeListener('message', stop);
      if (process.connected) process.disconnect?.();
    }
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
