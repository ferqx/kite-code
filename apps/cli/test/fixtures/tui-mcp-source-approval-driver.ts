import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

const [controlUrl, executable, hostPath, root, evidence, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const durableReceipt = (path: string, value: string, flag: 'a' | 'wx') => {
  const flags =
    flag === 'wx' && process.platform !== 'win32'
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      : flag;
  const descriptor = openSync(path, flags, 0o600);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_source_approval_interrupted'));
const shutdown = (message: unknown) => {
  if (message === 'owned-source-approval-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', shutdown);
const owners: TuiPTY[] = [];
const exits: { phase: string; pid: number; exitCode: number; normalCtrlQ: boolean }[] = [];
const trace: Record<string, unknown>[] = [];
let active: TuiPTY | undefined;
let decoder: TextDecoder;
let decodeFailure: unknown;
let retained: string | undefined;
let latestFrame = '';
let failure: unknown;
let complete = false;
const note = (kind: string, values: Record<string, unknown> = {}) => {
  trace.push({ kind, time: performance.now() / 1000, ...values });
  if (trace.length > 512) trace.shift();
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const current = async () => {
  abort.signal.throwIfAborted();
  if (decodeFailure) throw decodeFailure;
  const frame = await active!.projection();
  // Only explicit original-detail selection/checks preserve an unchanged frame.
  // Any fresh parsed rendering supersedes that retained observation.
  const text = frame.fresh || retained === undefined ? frame.text : retained;
  latestFrame = text;
  return { fresh: frame.fresh || retained !== undefined, text: normalized(text) };
};
const control = async (path: string) => {
  const frame = active!.ended ? normalized(latestFrame) : (await current()).text;
  note('control', { path, frame: frame.slice(-32768) });
  const response = await fetch(controlUrl + path, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw Error(`owned_source_control_failed:${path}`);
  return (await response.json()) as { id: string; commandId: string; ids: string[] };
};
const wait = async (text: string, compact = false, end = Date.now() + 10000) => {
  for (;;) {
    const frame = await current();
    if (frame.fresh && (compact ? frame.text.replaceAll(' ', '') : frame.text).includes(text)) {
      note('matched', { text, frame: frame.text.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_frame_deadline:${text}`);
    if (active!.ended) throw Error('owned_pty_eof');
    await Bun.sleep(50);
  }
};
const waitNewOriginal = async (previous: string[]) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const original = [
      ...frame.text.replaceAll(' ', '').matchAll(/Originalsourcedecision:([a-f0-9-]{36})/g),
    ]
      .map((match) => match[1]!)
      .find((id) => !previous.includes(id));
    if (frame.fresh && original) {
      note('new-original', { commandId: original, frame: frame.text.slice(-32768) });
      return original;
    }
    if (Date.now() > end) throw Error('owned_new_original_deadline');
    if (active!.ended) throw Error('owned_pty_eof');
    await Bun.sleep(50);
  }
};
const sourceQuestionReady = async (questionId: string, decision: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    if (
      frame.fresh &&
      frame.text.includes('Session a · Idle') &&
      frame.text.includes(`Up/Down explicit source decision: ${decision}`) &&
      !frame.text.includes(' · Loading')
    ) {
      note('source-question-ready', { questionId, decision, frame: frame.text.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_source_question_ready_deadline:${questionId}`);
    if (active!.ended) throw Error('owned_pty_eof');
    await Bun.sleep(50);
  }
};
const key = async (value: string, preserveSelectedFrame = false) => {
  if (!value) return;
  const before = await current();
  note('key', {
    hex: Buffer.from(value).toString('hex'),
    preserveSelectedFrame,
    frame: before.text.slice(-32768),
  });
  retained = preserveSelectedFrame ? latestFrame : undefined;
  await active!.key(value);
};
const chooseSource = async (label: string) => {
  const end = Date.now() + 10000;
  for (let step = 0; step < 16; step++) {
    const frame = (await current()).text.replaceAll(' ', '');
    const target = label.replaceAll(' ', '');
    if (frame.includes(`›${target}`)) {
      note('source-choice', { label, frame: (await current()).text.slice(-32768) });
      return;
    }
    const selectedAt = frame.indexOf('›');
    const targetAt = frame.indexOf(target);
    if (selectedAt < 0) throw Error('owned_source_selection_absent');
    if (targetAt < 0 && label !== 'Check original source decision')
      throw Error(`owned_source_choice_absent:${label}`);
    await key(targetAt < 0 || targetAt < selectedAt ? '\x1b[A' : '\x1b[B');
    await wait('Project sources', false, end);
  }
  throw Error(`owned_source_choice_unavailable:${label}`);
};
const selected = (id: string) =>
  wait(`Originalsourcedecision:${id}·OriginalStore:${storeId}·Sessiona`, true);
const start = async (phase: string) => {
  decoder = new TextDecoder('utf-8', { fatal: true });
  decodeFailure = undefined;
  retained = undefined;
  active = spawnTuiPTY({
    cmd: [executable, '--no-install', hostPath],
    cwd: root,
    env: {
      HOME: root,
      KITE_CODE_HOME: join(root, 'owned-home'),
      ...(process.platform === 'win32' ? { USERPROFILE: root } : {}),
    },
    onData(bytes) {
      try {
        decoder.decode(bytes, { stream: true });
      } catch (error) {
        decodeFailure = error;
      }
    },
  });
  owners.push(active);
  durableReceipt(
    join(evidence, 'pty-owned.jsonl'),
    `${JSON.stringify({ phase, pid: active.host.pid })}\n`,
    'a',
  );
  await wait('New Run >');
};
const sources = async () => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('› Project sources');
  await key('\r');
  await wait('Project sources');
};
const close = async (phase: string) => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active!.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_source_normal_exit_unconfirmed',
  );
  exits.push({ phase, pid: active!.host.pid, exitCode: code, normalCtrlQ: true });
  assert.equal(code, 0);
  await active!.drain();
  decoder.decode();
  if (decodeFailure) throw decodeFailure;
  active!.close();
};

try {
  await start('warm');
  const ids: string[] = [];
  const decisions = ['approved', 'rejected', 'cancel'] as const;
  for (const [index, decision] of decisions.entries()) {
    const n = index + 1;
    await sources();
    await wait('Source list ready');
    await key('\r');
    await wait('› Review project source');
    await key('\r');
    await wait('Confirm project source review:');
    await control(`before-confirm/${n}`);
    await key('\r');
    const originalId = await waitNewOriginal(ids);
    await key('\x03');
    const ordinary = await control(`ordinary/${n}`);
    assert.equal(ordinary.commandId, originalId);
    await wait(`approval[${ordinary.id}]originalSessiona`, true);
    await key('approve');
    await wait('revise feedback / deny. approve');
    await key('\r');
    const question = await control(`question/${n}`);
    await wait(`question[${question.id}]originalSessiona`, true);
    await sourceQuestionReady(question.id, 'none (Enter has no answer)');
    // Blank Enter is a proven no-op. Retain only this same ready Question,
    // then require the original control's pending/zero-answer proof and ID.
    await key('\r', true);
    const blank = await control(`question-blank/${n}`);
    assert.equal(blank.id, question.id);
    await sourceQuestionReady(question.id, 'none (Enter has no answer)');
    await key('\x1b[B'.repeat(n));
    await sourceQuestionReady(question.id, decision);
    await key('\r');
    const terminal = await control(`finish/${n}`);
    ids.push(terminal.commandId);
    await wait('New Run >');
    await sources();
    await wait('Source list ready');
    await chooseSource('Check original source decision');
    await key('\r');
    await wait(
      ['Source approval saved', 'Source rejection saved', 'Source request cancelled'][index]!,
    );
    await control(`warm-saved/${n}`);
    await key('\x03');
    await wait('New Run >');
    await control('check');
  }
  await control('warm-complete');
  await close('warm');
  for (const cold of ['cold-removed', 'cold-missing']) {
    await control(cold);
    await start(cold);
    await sources();
    await wait(
      cold === 'cold-removed'
        ? 'Source list ready'
        : 'Source list unknown; original decisions remain available',
    );
    for (const [index, id] of ids.entries()) {
      const n = index + 1;
      await control('selection-baseline');
      await chooseSource(`Original source decision: ${id}`);
      if (n === 1) await selected(id);
      await key('\r', true);
      await selected(id);
      await control('cold-selected');
      await chooseSource('Check original source decision');
      await key('\r');
      await wait(
        ['Source approval saved', 'Source rejection saved', 'Source request cancelled'][index]!,
      );
      await control(`cold-lookup/${n}`);
    }
    await key('\x03');
    await wait('New Run >');
    await control('check');
    await close(cold);
  }
  await control('cold-foreign');
  await start('cold-foreign');
  await sources();
  await wait('Source list unknown; original decisions remain available');
  for (const [index, id] of ids.entries()) {
    const n = index + 1;
    await control('selection-baseline');
    await chooseSource(`Original source decision: ${id}`);
    await key('\r', true);
    await selected(id);
    await wait('Source outcome unknown; check original');
    await control(`foreign-selected/${n}`);
    await chooseSource('Check original source decision');
    note('foreign-check-key', {
      commandId: id,
      observation: 'retained identical known detail; no new frame or public receipt',
    });
    await key('\r', true);
    await selected(id);
    await wait('Source outcome unknown; check original');
    await control(`foreign-lookup/${n}`);
  }
  await key('\x03');
  await wait('New Run >');
  await control('check');
  await close('cold-foreign');
  complete = true;
  console.log('SOURCE_APPROVAL_WARM_COLD_COMPLETE');
} catch (error) {
  failure = error;
  note('failure', { message: String(error), frame: normalized(latestFrame).slice(-32768) });
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (active && !active.ended) {
    try {
      if (process.platform === 'win32') {
        await terminateTuiTree(active, { exitTimeoutMs: 3000 });
      } else {
        active.host.kill('SIGTERM');
        try {
          await ptyDeadline(
            Promise.all([active.host.exited, active.eof]),
            6000,
            'owned_source_failure_exit_timeout',
          );
        } catch {
          await terminateTuiTree(active, { exitTimeoutMs: 3000 });
        }
      }
      exits.push({
        phase: 'cleanup',
        pid: active.host.pid,
        exitCode: await active.host.exited,
        normalCtrlQ: false,
      });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Source approval PTY failed')
        : error;
    }
  }
  for (const owned of owners) {
    try {
      await owned.drain();
      owned.close();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Source approval PTY close failed')
        : error;
    }
  }
  durableReceipt(
    join(evidence, 'pty-trace.json'),
    JSON.stringify({
      failure: failure ? String(failure) : null,
      latestCompleteFrame: normalized(latestFrame).slice(-32768),
      trace,
    }),
    'wx',
  );
  durableReceipt(
    join(evidence, 'pty-exits.json'),
    JSON.stringify({ normalComplete: complete, exits }),
    'wx',
  );
  if (process.platform === 'win32') {
    process.removeListener('message', shutdown);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
