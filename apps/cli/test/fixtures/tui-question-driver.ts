import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const [controlUrl, executable, host, root, evidence, detail, custom] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_question_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'owned-question-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
const output: Uint8Array[] = [];
const decoder = new TextDecoder('utf-8', { fatal: true });
let utf8Failure: unknown;
const owned = spawnTuiPTY({
  cmd: [executable, '--no-install', host],
  cwd: root,
  env: {
    HOME: root,
    KITE_CODE_HOME: join(root, 'owned-home'),
    ...(process.platform === 'win32' ? { USERPROFILE: root } : {}),
  },
  onData(bytes) {
    output.push(bytes.slice());
    try {
      decoder.decode(bytes, { stream: true });
    } catch (error) {
      utf8Failure = error;
    }
  },
});
const trace: Record<string, unknown>[] = [];
let failure: unknown;
let retainedFrame = false;
let latestCompleteFrame = '';
let normalComplete = false;
let normalCtrlQ = false;
let exitCode: number | null = null;
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const normalized = (value: string) => value.replace(ansi, '').replace(/\s+/g, ' ');
const current = () => normalized(owned.viewport());
const material = () => normalized(owned.sinceAction());
const note = (kind: string, values: Record<string, unknown>) =>
  trace.push({ kind, time: performance.now() / 1000, ...values });
const healthy = () => {
  abort.signal.throwIfAborted();
  if (utf8Failure) throw utf8Failure;
};
const wait = async (text: string, input: { material?: boolean; ready?: boolean } = {}) => {
  const end = Date.now() + 10000;
  for (;;) {
    healthy();
    const frame = await owned.projection();
    const actual = input.material ? material() : current();
    if (
      (frame.fresh || retainedFrame) &&
      actual.includes(text) &&
      (!input.ready || !current().includes('· Loading'))
    ) {
      note('matched', { text, material: !!input.material, frame: current() });
      return;
    }
    if (owned.ended || Date.now() > end)
      throw Error(`owned_question_frame_deadline:${text} tail=${actual.slice(-6000)}`);
    await Bun.sleep(50);
  }
};
const key = async (value: string, retain = false) => {
  healthy();
  await owned.drain();
  note('key', { hex: Buffer.from(value).toString('hex'), retain, frame: current() });
  retainedFrame = retain;
  await owned.key(value);
};
const check = async (stage: string) => {
  note('observe', { stage, frame: current() });
  await ptyDeadline(
    (async () => {
      const response = await fetch(controlUrl + stage, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      });
      assert.ok(response.ok, `${stage}: ${await response.clone().text()}`);
      assert.equal(((await response.json()) as { checked: boolean }).checked, true);
    })(),
    12000,
    `owned_question_control_deadline:${stage}`,
  );
};
const waitExit = async () => {
  const end = Date.now() + 6000;
  while (!owned.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    3000,
    'owned_question_exit_unconfirmed',
  );
  return code;
};
try {
  // A new physical Workspace must be admitted through the real first-run gate.
  await wait('› Exit Kite Code');
  await key('\x1b[B');
  await wait('› Trust this workspace and continue');
  await key('\r');
  await wait('New Run >');
  await key('/permissions');
  await wait('New Run > /permissions');
  await key('\r');
  await wait('T review trust');
  await wait('trusted, revision 1');
  await wait('D toggle · Enter review mode choice');
  await key('\r');
  await wait('Confirm original');
  await key('\r');
  await wait('permission.mode: applied');
  await key('\x1b');
  await wait('New Run >');
  await key('Ask the production default question');
  await wait('New Run > Ask the production default question');
  await key('\r');
  await wait('Choose original route', { material: true });
  await wait('First original route', { material: true });
  await wait('Second original route', { material: true });
  await wait('First original route (Recommended)', { material: true });
  assert.equal(material().includes('q1-o1') || material().includes('q1-o2'), false);
  await wait('Question 1/3', { material: true, ready: true });
  await wait('1 / 3', { ready: true });
  await check('initial');
  await key('\r', true);
  await wait('1 / 3', { ready: true });
  await wait('No selection (Enter has no answer)', { ready: true });
  await check('blank');
  await key('\x1b[B');
  await wait('❯ 1. First original route (Recommended)', { ready: true });
  await key('\r');
  await wait('Write original detail', { material: true });
  await wait('Question 2/3', { material: true, ready: true });
  await wait('2 / 3', { ready: true });
  await check('route');
  await key('\x1b[B');
  await wait('❯ 1. Brief detail', { ready: true });
  await key('\x1b[B');
  await key('\x1b[B');
  await wait('❯ Answer >', { ready: true });
  await key(`\x1b[200~${detail}\x1b[201~`);
  const pasted = `[Pasted ${Array.from(detail).length} characters]`;
  await wait(pasted);
  await check('text');
  // An ordinary question has no review artifact. Ctrl+A must leave this
  // original pasted answer intact, without issuing an attachment read.
  await key('\x01', true);
  await wait(pasted, { ready: true });
  await check('text-ctrl-a');
  await key('\x1b[A');
  await wait('❯ 2. Full detail', { ready: true });
  await check('custom-navigation');
  await key('\x1b[B');
  await wait('❯ Answer >', { ready: true });
  await wait(pasted);
  await key('\x1b[B');
  await wait('❯ 1. Brief detail', { ready: true });
  await check('custom-navigation');
  await key('\t');
  await wait('❯ Answer >', { ready: true });
  await wait(pasted);
  await check('custom-navigation');
  await key('\r');
  await wait('Choose final delivery', { material: true });
  await wait('Question 3/3', { material: true, ready: true });
  await wait('3 / 3', { ready: true });
  assert.equal(owned.text().includes('attachment_missing'), false);
  assert.equal(current().includes('Error:'), false);
  await check('text');
  await key('\x1b');
  await wait('Write original detail', { material: true });
  await wait('Question 2/3', { material: true, ready: true });
  await wait('2 / 3', { ready: true });
  await wait(pasted);
  await check('back');
  await key('\x1b');
  await wait('Choose original route', { material: true });
  await wait('Question 1/3', { material: true, ready: true });
  await wait('1 / 3', { ready: true });
  await key('\x1b[B');
  await wait('❯ 2. Second original route', { ready: true });
  await key('\r');
  await wait('Write original detail', { material: true });
  await wait('Question 2/3', { material: true, ready: true });
  await wait('2 / 3', { ready: true });
  await wait(pasted);
  await check('retained');
  await key('\r');
  await wait('Choose final delivery', { material: true });
  await wait('Question 3/3', { material: true, ready: true });
  await wait('3 / 3', { ready: true });
  await key('\x1b[B');
  await wait('❯ 1. Original delivery option', { ready: true });
  await key('\x1b[B');
  await key('\x1b[B');
  await wait('❯ Answer >', { ready: true });
  await key(custom);
  await wait('q3-o1');
  await check('custom');
  await key('\r');
  await check('finish');
  await wait('OWNED_QUESTION_COMPLETE', { material: true });
  await wait('New Run >');
  assert.equal(owned.text().includes('attachment_missing'), false);
  await key('\x11');
  exitCode = await waitExit();
  assert.equal(exitCode, 0);
  decoder.decode();
  if (utf8Failure) throw utf8Failure;
  normalCtrlQ = true;
  normalComplete = true;
} catch (error) {
  failure = error;
  note('failure', { message: String(error), frame: current() });
} finally {
  try {
    if (!owned.ended) {
      if (process.platform === 'win32') {
        await terminateTuiTree(owned, { exitTimeoutMs: 3000 });
      } else {
        owned.host.kill('SIGTERM');
        try {
          exitCode = await waitExit();
        } catch {
          if (!owned.ended) owned.host.kill('SIGKILL');
          exitCode = await ptyDeadline(owned.host.exited, 3000, 'owned_question_forced_exit');
        }
      }
    }
    await owned.drain();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Question cleanup failed') : error;
  } finally {
    latestCompleteFrame = current();
    owned.close();
  }
  try {
    for (const [name, value] of [
      ['pty-trace.json', { failure: failure ? String(failure) : null, latestCompleteFrame, trace }],
      [
        'pty-exit.json',
        {
          normalComplete,
          normalCtrlQ,
          pid: owned.host.pid,
          exitCode: exitCode ?? owned.host.exitCode,
        },
      ],
    ] as const) {
      const fd = openSync(
        join(evidence, name),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    writeFileSync(join(evidence, 'terminal.bin'), Buffer.concat(output), {
      flag: 'wx',
      mode: 0o600,
    });
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
