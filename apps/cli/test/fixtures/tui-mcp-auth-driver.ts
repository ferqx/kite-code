import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  controlURL: string;
  executable: string;
  host: string;
  root: string;
  evidence: string;
  storeId: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('owned_auth_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'mcp-auth-driver-stop') interrupt();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
if (process.platform === 'win32') process.on('message', stop);
let active: TuiPTY | undefined;
const exits: { phase: string; pid: number; exitCode: number; normalCtrlQ: boolean }[] = [];
const trace: object[] = [];
let failure: unknown;
let complete = false;
let latestFrame = '';
let invalidUTF8: unknown;
let chosenOriginalId: string | undefined;
let retainedDetail: { commandId: string; text: string } | undefined;
const note = (kind: string, values: object = {}) => {
  trace.push({ kind, time: performance.now() / 1000, ...values });
  if (trace.length > 512) trace.shift();
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const current = async () => {
  abort.signal.throwIfAborted();
  if (invalidUTF8) throw invalidUTF8;
  const frame = await active!.projection();
  if (frame.fresh) retainedDetail = undefined;
  latestFrame = normalized(frame.text);
  return { ...frame, text: latestFrame };
};
const control = async (path: string) => {
  note('control', { path, frame: latestFrame.slice(-32768) });
  return ptyDeadline(
    (async () => {
      const response = await fetch(new URL(path, input.controlURL), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Error(`owned_auth_control_failed:${path}:${response.status}`);
      return (await response.json()) as { commandId: string; executionId: string };
    })(),
    12000,
    `owned_auth_control_deadline:${path}`,
  );
};
const wait = async (text: string, compact = false, originalId?: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const retained =
      !frame.fresh && originalId !== undefined && retainedDetail?.commandId === originalId
        ? retainedDetail.text
        : undefined;
    const candidate = retained ?? frame.text;
    if (
      (frame.fresh || retained !== undefined) &&
      (compact ? candidate.replace(/ /g, '') : candidate).includes(text)
    ) {
      note('matched', { text, frame: frame.text.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_auth_frame_deadline:${text}`);
    if (active!.ended) throw Error('owned_auth_pty_eof');
    await Bun.sleep(50);
  }
};
const waitAbsent = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    if (frame.fresh && frame.text && !frame.text.includes(text)) {
      note('absent', { text, frame: frame.text.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_auth_absent_deadline:${text}`);
    if (active!.ended) throw Error('owned_auth_pty_eof');
    await Bun.sleep(50);
  }
};
const key = async (value: string, retain = false) => {
  const frame = await current();
  retainedDetail = undefined;
  if (
    retain &&
    frame.fresh &&
    chosenOriginalId !== undefined &&
    frame.text
      .replace(/ /g, '')
      .includes(`Originalauthentication:${chosenOriginalId}OriginalStore:${input.storeId}·Sessiona`)
  )
    retainedDetail = { commandId: chosenOriginalId, text: frame.text };
  note('key', {
    hex: Buffer.from(value).toString('hex'),
    retain,
    frame: latestFrame.slice(-32768),
  });
  await active!.key(value);
};
const choose = async (label: string) => {
  const end = Date.now() + 10000;
  for (let step = 0; step < 32; step++) {
    const frame = (await current()).text.replace(/ /g, '');
    const target = label.replace(/ /g, '');
    if (frame.includes(`›${target}`)) {
      chosenOriginalId = label.startsWith('Original authentication: ')
        ? label.slice('Original authentication: '.length)
        : undefined;
      note('choice', { label, frame: latestFrame.slice(-32768) });
      return;
    }
    const selectedAt = frame.indexOf('›'),
      targetAt = frame.indexOf(target);
    if (selectedAt < 0) throw Error('owned_auth_selection_absent');
    await key(
      targetAt < 0
        ? label.startsWith('Original authentication:')
          ? '\x1b[B'
          : '\x1b[A'
        : targetAt < selectedAt
          ? '\x1b[A'
          : '\x1b[B',
    );
    for (;;) {
      const next = await current();
      if (next.fresh && next.text) break;
      if (Date.now() > end) throw Error(`owned_auth_navigation_frame_deadline:${label}`);
      await Bun.sleep(50);
    }
  }
  throw Error(`owned_auth_choice_unavailable:${label}`);
};
const start = async (phase: string) => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  invalidUTF8 = undefined;
  chosenOriginalId = undefined;
  retainedDetail = undefined;
  active = spawnTuiPTY({
    cmd: [input.executable, '--no-install', input.host],
    cwd: input.root,
    env: {
      HOME: input.root,
      ...(process.platform === 'win32' ? { USERPROFILE: input.root } : {}),
      KITE_CODE_HOME: join(input.root, 'owned-home'),
    },
    onData: (bytes) => {
      try {
        decoder.decode(bytes, { stream: true });
      } catch (error) {
        invalidUTF8 = error;
      }
    },
  });
  const fd = openSync(join(input.evidence, 'pty-owned.jsonl'), 'a', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ phase, pid: active.host.pid })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await wait('New Run >');
};
const auth = async (history = false) => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('Project sources');
  await choose('Project sources');
  await key('\r');
  await wait('Original authentication requests');
  await waitAbsent('Reading project sources');
  if (history) await choose('Original authentication requests');
  await key('\r');
  if (!history) {
    await wait('Authentication');
    await choose('Authentication');
    await key('\r');
  }
  await wait('MCP authentication');
  await waitAbsent('Reading authentication');
};
const selected = (id: string) =>
  wait(`Originalauthentication:${id}OriginalStore:${input.storeId}·Sessiona`, true, id);
const leave = async (pending = false) => {
  await key('\x03');
  await wait('Project sources');
  await key('\x03');
  await wait(pending ? 'Ctrl+B pending cards' : 'New Run >');
};
const close = async (phase: string) => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active!.ended && Date.now() < end) await Bun.sleep(50);
  const [exitCode] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_auth_normal_exit_unconfirmed',
  );
  exits.push({ phase, pid: active!.host.pid, exitCode, normalCtrlQ: true });
  assert.equal(exitCode, 0);
  await active!.drain();
  active!.close();
  active = undefined;
};
try {
  await start('warm');
  const ids: string[] = [];
  const labels = [
    'Login',
    'Refresh credentials',
    'Revoke remote credentials',
    'Login',
    'Clear local credentials',
  ];
  const actions = ['login', 'refresh', 'revoke', 'login', 'clear'];
  for (let i = 0; i < labels.length; i++) {
    const n = i + 1,
      label = labels[i]!;
    await auth();
    await choose(`Review ${label}`);
    await key('\r');
    await wait(`Confirm authentication: ${label}`);
    await control(`before-confirm/${n}`);
    await key('\r');
    await wait('Original authentication:');
    await leave(true);
    const actual = await control(`finish/${n}`);
    ids.push(actual.commandId);
    await wait(`builtin.mcp.sources/mcp.auth.${actions[i]} [${actual.executionId}] succeeded`);
    await wait('New Run >');
    await auth();
    await choose(`Original authentication: ${actual.commandId}`);
    await key('\r', true);
    await selected(actual.commandId);
    await choose('Check original authentication');
    await key('\r');
    await selected(actual.commandId);
    await wait(
      n === 3 || n === 5 ? 'Credentials cleared' : 'Credentials saved; reconnect separately',
    );
    await leave();
  }
  await control('warm-complete');
  await close('warm');
  await control('cold-removed');
  await start('cold-removed');
  await auth(true);
  const original = (await control('selection-baseline')).commandId;
  await choose(`Original authentication: ${original}`);
  await key('\r', true);
  await selected(original);
  await control('cold-selected');
  await choose('Check original authentication');
  await key('\r');
  await selected(original);
  await wait('Credentials saved; reconnect separately');
  await control('cold-lookup');
  await leave();
  await close('cold-removed');
  complete = true;
  console.log('AUTH_WARM_COLD_COMPLETE');
} catch (error) {
  failure = error;
  note('failure', { message: String(error), frame: latestFrame.slice(-32768) });
} finally {
  if (active) {
    try {
      if (!active.ended) {
        if (process.platform === 'win32') await terminateTuiTree(active, { exitTimeoutMs: 3000 });
        else {
          active.host.kill('SIGTERM');
          try {
            await ptyDeadline(
              Promise.all([active.host.exited, active.eof]),
              6000,
              'owned_auth_failure_grace_deadline',
            );
          } catch {
            if (!active.ended) await terminateTuiTree(active, { exitTimeoutMs: 3000 });
            else await ptyDeadline(active.eof, 3000, 'owned_auth_failure_eof_deadline');
          }
        }
      }
      exits.push({
        phase: 'failure',
        pid: active.host.pid,
        exitCode: await active.host.exited,
        normalCtrlQ: false,
      });
      await active.drain();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Auth PTY failed') : error;
    } finally {
      active.close();
    }
  }
  for (const [basename, value] of [
    [
      'pty-trace.json',
      {
        failure: failure ? String(failure) : null,
        latestCompleteFrame: latestFrame.slice(-32768),
        trace,
      },
    ],
    ['pty-exits.json', { normalComplete: complete, exits }],
  ] as const) {
    try {
      // Exclusive creation also rejects an existing Windows reparse/link leaf.
      const fd = openSync(
        join(input.evidence, basename),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Auth receipt failed') : error;
    }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (process.platform === 'win32') {
    process.removeListener('message', stop);
    if (process.connected) process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
