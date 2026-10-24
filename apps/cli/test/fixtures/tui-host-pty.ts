import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectProcess } from '@kite-ai/service/daemon';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  mode: 'complete' | 'cancel' | 'eof';
  root: string;
  workspace: string;
  dataRoot: string;
  databasePath: string;
  entrypoint: string;
  serviceEntry: string;
  evidence: string;
  stopPath: string;
  tail: string;
};
const abort = new AbortController();
const stop = () => abort.abort(Error('original_host_driver_interrupted'));
const control = (message: unknown) => {
  if (message === 'owned-host-stop') stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
if (process.platform === 'win32') process.on('message', control);
const observation = `${input.evidence}.service.json`;
const pty = spawnTuiPTY({
  cmd: [
    process.execPath,
    '--preload',
    `${import.meta.dir}/tui-management-observation.ts`,
    `${import.meta.dir}/tui-diagnostics-entry.ts`,
    input.entrypoint,
    '--workspace',
    input.workspace,
    '--thread',
    'a',
    '--data-root',
    input.dataRoot,
  ],
  cwd: input.root,
  env: {
    KITE_MANAGEMENT_SERVICE_ENTRY: input.serviceEntry,
    KITE_MANAGEMENT_OBSERVATION: observation,
  },
  conptyCellWidths: process.platform === 'win32',
  scrollback: 20000,
});
const wait = async (text: string, viewport = false) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    const material = (viewport ? pty.viewport() : frame.text).replace(/\s+/g, '');
    if (frame.fresh && material.includes(text.replace(/\s+/g, ''))) return;
    if (pty.ended || Date.now() > deadline)
      throw Error(`expected ${text} tail=${material.slice(-3000)}`);
    await Bun.sleep(50);
  }
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await pty.key(value);
};
let failure: unknown;
try {
  await wait('New Run', true);
  const owned = JSON.parse(readFileSync(observation, 'utf8')) as {
    pid: number;
    start: string;
    cmd: string[];
  };
  assert(Number.isSafeInteger(owned.pid) && owned.pid > 0 && owned.start);
  assert(owned.cmd.includes(input.serviceEntry));
  assert.equal(inspectProcess(owned.pid, owned.start), 'alive');
  await key('owned task');
  await Bun.sleep(100);
  await key('\r');
  if (input.mode === 'complete') {
    await wait('360025 bytes, complete');
    await key('\x0f');
    const original = `${'正文'.repeat(60000)}${input.tail}`;
    const deadline = Date.now() + 10000;
    for (;;) {
      abort.signal.throwIfAborted();
      const frame = await pty.projection();
      if (frame.fresh && frame.text.replace(/\s+/g, '').includes(original)) break;
      if (pty.ended || Date.now() > deadline)
        throw Error('complete original Model body not painted');
      await Bun.sleep(50);
    }
    await key('\x0e');
    await wait('New Workspace Session selected');
    await key('\x12');
    await wait('Select Session', true);
    await key('\x1b');
    await key('\x11');
    console.log('FULL_TAIL True');
  } else if (input.mode === 'cancel') {
    await wait('approval [');
    // One native batch is repeated cancellation, while two independent presses
    // within a second are the documented normal Host quit gesture.
    await key('\x03\x03');
    await wait('Idle');
    await key('\x11');
  } else {
    await wait('approval [');
    // Real PTY/ConPTY closure sends input-loss SIGHUP to the original Host.
    // It is not an answer and is not the later explicit Host stop.
    pty.host.terminal!.close();
    await Bun.sleep(300);
    assert.equal(pty.ended, false, 'original Host must survive input loss');
    const database = new Database(input.databasePath, { readonly: true });
    try {
      assert.deepEqual(database.query("SELECT status FROM run WHERE session_id='a'").all(), [
        { status: 'waiting_interaction' },
      ]);
      assert.deepEqual(
        database.query("SELECT count(*) AS n FROM interaction WHERE state='accepted'").get(),
        { n: 0 },
      );
    } finally {
      database.close();
    }
    console.log('EOF_WAITING_ZERO_APPROVAL');
    // Windows kill(SIGTERM) is TerminateProcess. The isolated entry's private
    // stop file invokes the existing Host stop listener only after real EOF proof.
    if (process.platform === 'win32') writeFileSync(input.stopPath, 'explicit owned Host stop');
    else pty.host.kill('SIGTERM');
  }
  const deadline = Date.now() + 6000;
  while (!pty.ended && Date.now() < deadline) {
    await Bun.sleep(100);
    await pty.drain();
  }
  const [exit] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'original Host exit timeout',
  );
  assert.equal(exit, 0);
  const serviceExit = JSON.parse(readFileSync(`${observation}.exit`, 'utf8')) as {
    pid: number;
    start: string;
    code: number;
  };
  assert.equal(serviceExit.pid, owned.pid);
  assert.equal(serviceExit.start, owned.start);
  assert.equal(serviceExit.code, 0);
  assert.equal(inspectProcess(owned.pid, owned.start), 'dead');
  console.log('OWNED_SERVICE_STOPPED');
  console.log('HOST_EXIT 0');
} catch (error) {
  failure = error;
} finally {
  try {
    if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
    await pty.drain();
    writeFileSync(input.evidence, pty.text());
    pty.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'original Host PTY failed') : error;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (process.platform === 'win32') {
    process.removeListener('message', control);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
