import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  cold: boolean;
  runner: string;
  root: string;
  base: string;
  jobId: string;
};
const pty = spawnTuiPTY({ cmd: [process.execPath, input.runner], cwd: input.root });
let normal = false,
  aborted = false;
const stop = () => {
  aborted = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.platform === 'win32')
  process.on('message', (message) => {
    if (message === 'caller-job-driver-stop') stop();
  });
async function pump() {
  await Bun.sleep(100);
  await pty.drain();
  if (aborted) throw Error('caller_job_driver_aborted');
}
async function key(value: string) {
  await pty.key(value);
  await pump();
}
async function wait(text: string) {
  const end = Date.now() + 10000;
  for (;;) {
    const projection = await pty.projection();
    if (projection.fresh && projection.text.replace(/\s+/g, ' ').includes(text)) return;
    if (Date.now() > end || pty.ended) throw Error(`${text}: ${pty.text().slice(-4000)}`);
    await pump();
  }
}
try {
  await wait('Session s');
  await wait('Session s · Idle');
  await wait(`Background Jobs: ${input.cold ? 1 : 2} unfinished · 0 unknown`);
  await wait('PARENT_DONE_TWO_INDEPENDENT_JOBS');
  if (input.cold) {
    await key('/recovery');
    await key('\r');
    await wait('execution.cancel');
    await key('\x0c');
    const end = Date.now() + 5000;
    while (!existsSync(`${input.base}.get-lost`)) {
      if (Date.now() > end) throw Error('GET loss missing');
      await pump();
    }
    await key('\x03');
    await pump();
    await key('\x0c');
    await wait('execution.cancel · applied');
    await key('\x11');
    await ptyDeadline(
      Promise.all([pty.host.exited, pty.eof]),
      6000,
      'cold caller normal exit deadline',
    );
    assert.equal(pty.host.exitCode, 0);
    normal = true;
  } else {
    await key(`/background stop ${input.jobId}`);
    await key('\r');
    if (process.platform === 'win32') {
      const deadline = Date.now() + 10000;
      while (!existsSync(`${input.base}.killed`)) {
        if (pty.ended || Date.now() > deadline) throw Error('committed loss barrier missing');
        await pump();
      }
      assert.equal(pty.ended, false);
      process.kill(pty.host.pid, 0);
      const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(pty.host.pid), '/f'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(dispatch.exitCode, 0, 'caller-only native termination dispatch failed');
      writeFileSync(
        `${input.base}.native-kill.json`,
        JSON.stringify({
          pid: pty.host.pid,
          dispatchExitCode: dispatch.exitCode,
          committedLossBarrier: true,
          descendants: false,
        }),
      );
    }
    await ptyDeadline(
      Promise.all([pty.host.exited, pty.eof]),
      10000,
      'producer abrupt exit deadline',
    );
    if (process.platform !== 'win32') assert.equal(pty.host.signalCode, 'SIGKILL');
    else {
      assert.notEqual(pty.host.exitCode, 0);
      assert.throws(
        () => process.kill(pty.host.pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      );
    }
    assert.ok(existsSync(`${input.base}.killed`));
  }
} finally {
  if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
  await pty.drain();
  appendFileSync(`${input.base}.pty.log`, pty.text());
  writeFileSync(
    `${input.base}.${input.cold ? 'cold' : 'producer'}.exit.json`,
    JSON.stringify({
      pid: pty.host.pid,
      normal,
      exitCode: pty.host.exitCode,
      signalCode: pty.host.signalCode,
      platform: process.platform,
    }),
  );
  pty.close();
  if (process.platform === 'win32') process.disconnect?.();
}
