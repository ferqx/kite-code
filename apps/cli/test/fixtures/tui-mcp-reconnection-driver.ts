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
  sourceId: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('owned_reconnection_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'mcp-reconnection-driver-stop') interrupt();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
if (process.platform === 'win32') process.on('message', stop);
let active: TuiPTY | undefined;
let latestFrame = '';
let retainedFrame: string | undefined;
let invalidUTF8: unknown;
let failure: unknown;
let complete = false;
const trace: object[] = [];
const exits: { phase: string; pid: number; exitCode: number; normalCtrlQ: boolean }[] = [];
const note = (kind: string, values: object = {}) => {
  trace.push({ kind, time: performance.now() / 1000, ...values });
  if (trace.length > 512) trace.shift();
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const current = async () => {
  abort.signal.throwIfAborted();
  if (invalidUTF8) throw invalidUTF8;
  const frame = await active!.projection();
  if (frame.fresh) retainedFrame = undefined;
  latestFrame = normalized(retainedFrame ?? frame.text);
  return { fresh: frame.fresh || retainedFrame !== undefined, text: latestFrame };
};
const control = async (path: string) => {
  note('control', { path, frame: latestFrame.slice(-32768) });
  // Bun's PTY callback keeps draining the real Host while the control reply is pending.
  return ptyDeadline(
    (async () => {
      const response = await fetch(new URL(path, input.controlURL), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Error(`owned_reconnection_control_failed:${path}:${response.status}`);
      return (await response.json()) as { commandId: string };
    })(),
    12000,
    `owned_reconnection_control_deadline:${path}`,
  );
};
const waitFor = async (
  label: string,
  matches: (frame: { fresh: boolean; text: string }) => boolean,
  end = Date.now() + 10000,
) => {
  for (;;) {
    const frame = await current();
    if (matches(frame)) return frame;
    if (Date.now() > end) throw Error(`owned_reconnection_frame_deadline:${label}`);
    if (active!.ended) throw Error('owned_reconnection_pty_eof');
    await Bun.sleep(50);
  }
};
const wait = async (text: string, compact = false) => {
  const frame = await waitFor(
    text,
    (frame) => frame.fresh && (compact ? frame.text.replace(/ /g, '') : frame.text).includes(text),
  );
  note('matched', { text, frame: frame.text.slice(-32768) });
};
const waitIdle = async () => {
  const frame = await waitFor(
    'composer',
    (frame) =>
      frame.fresh && frame.text.includes('New Run >') && !frame.text.includes(' · Loading '),
  );
  note('composer-ready', { frame: frame.text.slice(-32768) });
};
const waitNewReconnection = async (previous: string[]) => {
  let original: string | undefined;
  const frame = await waitFor('new-reconnection', (frame) => {
    if (!frame.fresh) return false;
    original = Array.from(
      frame.text.replace(/ /g, '').matchAll(/Originalforcedreconnect:([a-f0-9-]{36})/g),
      (match) => match[1]!,
    ).find((id) => !previous.includes(id));
    return original !== undefined;
  });
  note('new-reconnection', { commandId: original, frame: frame.text.slice(-32768) });
  return original!;
};
const key = async (value: string, preserveSelectedFrame = false) => {
  if (!value) return;
  await current();
  note('key', {
    hex: Buffer.from(value).toString('hex'),
    preserveSelectedFrame,
    frame: latestFrame.slice(-32768),
  });
  // Only callers that verified the identical original detail retain it across a no-op Enter.
  // Any subsequent real render supersedes that observation.
  retainedFrame = preserveSelectedFrame ? latestFrame : undefined;
  await active!.key(value);
};
const detail = (id: string) =>
  `Originalforcedreconnect:${id}·OriginalStore:${input.storeId}·Sessiona`;
const selected = (id: string) => wait(detail(id), true);
const start = async (phase: string) => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  invalidUTF8 = undefined;
  retainedFrame = undefined;
  active = spawnTuiPTY({
    cmd: [input.executable, '--no-install', input.host],
    cwd: input.root,
    env: {
      HOME: input.root,
      ...(process.platform === 'win32' ? { USERPROFILE: input.root } : {}),
      KITE_CODE_HOME: join(input.root, 'owned-home'),
    },
    onData(bytes) {
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
const choose = async (label: string, top = 'Project sources', settleMcp = false) => {
  const end = Date.now() + 10000;
  if (settleMcp) {
    const frame = await waitFor(
      `navigation-read:${label}`,
      (frame) =>
        frame.text.includes('Server list ready') ||
        frame.text.includes('Server list unknown; refresh to verify'),
      end,
    );
    note('mcp-navigation-read-settled', { frame: frame.text.slice(-32768) });
  }
  if ((await current()).text.includes(`› ${label}`)) return;
  if (!latestFrame.includes(`› ${top}`)) {
    await key('\x1b[A'.repeat(64));
    await waitFor(
      `navigation-top:${top}`,
      (frame) => frame.fresh && frame.text.includes(`› ${top}`),
      end,
    );
  }
  for (;;) {
    const frame = await current();
    if (frame.text.includes(`› ${label}`)) return;
    if (Date.now() > end) throw Error(`owned_reconnection_navigation_deadline:${label}`);
    await key('\x1b[B');
    await waitFor(`navigation-frame:${label}`, (next) => next.fresh && next.text.length > 0, end);
  }
};
const selectOriginal = async (id: string, top: string) => {
  await choose(`Original forced reconnect: ${id}`, top);
  const known = latestFrame.replace(/ /g, '').includes(detail(id));
  note('select-original-key', { commandId: id, retainedKnownDetail: known });
  await key('\r', known);
  await selected(id);
};
const mcp = async () => {
  await waitIdle();
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('Project sources');
};
const requestConnection = async () => {
  await mcp();
  await wait('Server list ready');
  await choose(`${input.sourceId} · enabled · available`);
  await key('\r');
  await wait('Server:');
  await choose('Request connection');
  await key('\r');
  await wait('Confirm connection request:');
  await key('\r');
  await wait('Original connection:');
};
const checkConnection = async () => {
  await choose('Check original connection');
  await key('\r');
  await wait('Original catalogue ready');
};
const reconnections = async () => {
  await mcp();
  await choose('Forced reconnects', 'Project sources', true);
  await key('\r');
  await wait('Selecting an original ID does not query, reconnect or authorize tools.');
};
const leave = async (pending = false, parentTitle = 'MCP · w') => {
  await key('\x03');
  await wait(parentTitle);
  note('parent-mcp-after-child-close', {
    expectedTitle: parentTitle,
    frame: latestFrame.slice(-32768),
  });
  await key('\x03');
  await wait(pending ? 'Ctrl+B pending cards' : 'New Run >');
  note('main-after-parent-close', { pending, frame: latestFrame.slice(-32768) });
};
const close = async (phase: string) => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active!.ended && Date.now() < end) await Bun.sleep(50);
  const [exitCode] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_reconnection_normal_exit_unconfirmed',
  );
  exits.push({ phase, pid: active!.host.pid, exitCode, normalCtrlQ: true });
  assert.equal(exitCode, 0);
  await active!.drain();
  active!.close();
  active = undefined;
};
try {
  await start('warm');
  await requestConnection();
  await control('approve-a');
  await checkConnection();
  await choose('Request connection');
  await key('\r');
  await wait('Confirm connection request:');
  await key('\r');
  await wait('Original connection:');
  const second = (await control('approve-b')).commandId;
  await checkConnection();
  await wait('Reused original connection');
  await choose('Review forced reconnect');
  await key('\r');
  await wait('Confirm forced reconnect:');
  await wait(`Original carrier: ${second}`);
  await wait('› Confirm forced reconnect');
  await control('before-confirm');
  await key('\r');
  const submittedReady = await waitNewReconnection([]);
  await leave(true);
  const ready = (await control('approve-replacement')).commandId;
  assert.equal(ready, submittedReady);
  await wait('New Run >');
  await reconnections();
  await selectOriginal(ready, 'Check original forced reconnect');
  await choose('Check original forced reconnect', 'Check original forced reconnect');
  await key('\r');
  await wait('Replacement catalogue ready');
  await wait('Live replacement observed');
  await choose('Review forced reconnect', 'Check original forced reconnect');
  await key('\r');
  await wait('Confirm forced reconnect:');
  await wait(`Original carrier: ${ready}`);
  await wait('› Confirm forced reconnect');
  await control('before-second-confirm');
  await key('\r');
  const submittedDenied = await waitNewReconnection([ready]);
  await leave(true);
  const original = (await control('deny-replacement')).commandId;
  assert.equal(original, submittedDenied);
  await wait('New Run >');
  await reconnections();
  await selectOriginal(original, 'Check original forced reconnect');
  await choose('Check original forced reconnect', 'Check original forced reconnect');
  await key('\r');
  await wait('Forced reconnect failed');
  await wait('Original connection stop confirmed');
  await wait('Live replacement not confirmed');
  await control('warm-complete');
  await leave();
  await close('warm');

  await control('cold-removed');
  await start('cold-removed');
  await reconnections();
  await control('selection-baseline');
  await selectOriginal(original, `Original forced reconnect: ${ready}`);
  await control('cold-selected');
  await choose('Check original forced reconnect', 'Check original forced reconnect');
  await key('\r');
  await wait('Forced reconnect failed');
  await wait('Original connection stop confirmed');
  await control('cold-lookup');
  await leave(false, 'MCP · unavailable');
  await close('cold-removed');

  await control('cold-foreign');
  await start('cold-foreign');
  await reconnections();
  await control('selection-baseline');
  await selectOriginal(original, `Original forced reconnect: ${ready}`);
  await wait('Forced reconnect outcome unknown; Check original');
  await control('foreign-selected');
  await choose('Check original forced reconnect', 'Check original forced reconnect');
  note('foreign-check-key', {
    commandId: original,
    observation: 'retained identical known unknown detail; no new frame or server receipt',
  });
  await key('\r', true);
  await selected(original);
  await wait('Forced reconnect outcome unknown; Check original');
  await control('foreign-lookup');
  await leave(false, 'MCP · unavailable');
  await close('cold-foreign');
  complete = true;
  console.log('RECONNECTION_WARM_COLD_FOREIGN_COMPLETE');
} catch (error) {
  failure = error;
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
              'owned_reconnection_failure_grace_deadline',
            );
          } catch {
            if (!active.ended) await terminateTuiTree(active, { exitTimeoutMs: 3000 });
            else await ptyDeadline(active.eof, 3000, 'owned_reconnection_failure_eof_deadline');
          }
        }
      }
      exits.push({
        phase: 'cleanup',
        pid: active.host.pid,
        exitCode: await active.host.exited,
        normalCtrlQ: false,
      });
      await active.drain();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Reconnection PTY failed') : error;
    } finally {
      active.close();
    }
  }
  for (const [basename, value] of [
    [
      'pty-trace.json',
      {
        failure:
          failure instanceof Error
            ? {
                type: failure.name,
                message: failure.message.slice(0, 4096),
                frame: latestFrame.slice(-32768),
              }
            : failure
              ? { type: 'unknown', frame: latestFrame.slice(-32768) }
              : null,
        latestCompleteFrame: latestFrame.slice(-32768),
        trace,
      },
    ],
    ['pty-exits.json', { normalComplete: complete, exits }],
  ] as const) {
    try {
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
      failure = failure
        ? new AggregateError([failure, error], 'Reconnection receipt failed')
        : error;
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
