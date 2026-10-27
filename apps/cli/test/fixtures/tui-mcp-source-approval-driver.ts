import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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
type SelectionCompletion = {
  phase: string;
  completion: number;
  requestedSessionId: string;
  storeId?: string;
  sessionId?: string;
  loading?: boolean;
  stale?: boolean;
  snapshotStale?: boolean;
  rejected?: boolean;
  cards?: { id: string; revision: string; storeId: string; sessionId: string }[];
};
const selections = (): SelectionCompletion[] => {
  try {
    return readFileSync(join(root, 'selection-completions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SelectionCompletion);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};
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
    if (frame.includes(`❯${target}`)) {
      note('source-choice', { label, frame: (await current()).text.slice(-32768) });
      return;
    }
    const selectedAt = frame.indexOf('❯');
    const targetAt = frame.indexOf(target);
    if (selectedAt < 0) {
      // A PTY data chunk may end between Ink clearing and painting its menu.
      // Require the real selected row within the original navigation deadline;
      // an incomplete paint consumes no key and grants no retained observation.
      if (Date.now() > end) throw Error('owned_source_selection_absent');
      await Bun.sleep(50);
      step--;
      continue;
    }
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
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    if (frame.fresh && frame.text.includes('New Run >')) break;
    if (
      frame.fresh &&
      frame.text.includes('Open this workspace?') &&
      frame.text.includes('› Exit Kite Code')
    ) {
      await key('\x1b[A');
      await wait('› Trust this workspace and continue', false, end);
      await key('\r');
      await wait('New Run >', false, end);
      break;
    }
    if (Date.now() > end) throw Error('owned_frame_deadline:workspace-trust-or-main');
    if (active!.ended) throw Error('owned_pty_eof');
    await Bun.sleep(50);
  }
};
const sources = async () => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('❯ Project sources');
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
    await wait('❯ Review project source');
    await key('\r');
    await wait('Confirm project source review:');
    await control(`before-confirm/${n}`);
    const completionBefore =
      selections()
        .filter((row) => row.phase === 'warm')
        .at(-1)?.completion ?? 0;
    await key('\r');
    const originalId = await waitNewOriginal(ids);
    const ordinary = await control(`ordinary/${n}`);
    assert.equal(ordinary.commandId, originalId);
    // Observe management closing before reading the original approval; an
    // original ID alone does not prove completed navigation.
    const navigationDeadline = Date.now() + 10000;
    await key('\x03');
    for (;;) {
      const frame = await current();
      const viewport = normalized(active!.viewport());
      if (
        frame.fresh &&
        viewport.includes(`[${ordinary.id}]`) &&
        viewport.includes('original Session a · pending · revision 1') &&
        viewport.includes('❯ Allow once') &&
        !viewport.includes('Project sources')
      )
        break;
      if (Date.now() > navigationDeadline)
        throw Error(`owned_source_management_close_deadline:${viewport}`);
      await Bun.sleep(50);
    }
    // The existing observer must publish a fresh, exact original card after
    // submission. No approval or Source answer is sent to obtain this read.
    await wait(`approval[${ordinary.id}]originalSessiona`, true, navigationDeadline);
    for (;;) {
      const completion = selections().find(
        (row) =>
          row.phase === 'warm' &&
          row.completion > completionBefore &&
          row.requestedSessionId === 'a' &&
          row.sessionId === 'a' &&
          row.storeId === storeId &&
          !row.rejected &&
          row.loading === false &&
          row.stale === false &&
          row.snapshotStale === false &&
          row.cards?.some(
            (card) =>
              card.id === ordinary.id &&
              card.revision === '1' &&
              card.storeId === storeId &&
              card.sessionId === 'a',
          ),
      );
      if (completion) break;
      if (Date.now() > navigationDeadline)
        throw Error('owned_source_original_refresh_completion_deadline');
      await Bun.sleep(5);
    }
    await wait(`approval[${ordinary.id}]originalSessiona`, true, navigationDeadline);
    if ((await current()).text.includes('Ctrl+A: read required attachment.')) {
      await key('\x01');
      const deadline = Date.now() + 10000;
      for (;;) {
        const frame = await current();
        if (frame.fresh && !frame.text.includes('Ctrl+A: read required attachment.')) break;
        if (Date.now() > deadline) throw Error('owned_source_attachment_read_deadline');
        await Bun.sleep(5);
      }
    }
    // The ordinary production approval panel uses an explicit selected action.
    // Preserve this original card's identity and independent approval before
    // the Source-specific Question becomes actionable.
    const approvalDeadline = Date.now() + 10000;
    for (;;) {
      const frame = await current();
      const viewport = normalized(active!.viewport());
      if (
        frame.fresh &&
        viewport.includes('❯ Allow once') &&
        !viewport.includes('Project sources') &&
        !viewport.includes('Original outcome pending or unknown') &&
        !viewport.includes('Loading')
      )
        break;
      if (Date.now() > approvalDeadline)
        throw Error(`owned_source_approval_focus_deadline:${viewport}`);
      await Bun.sleep(50);
    }
    await wait('Approve this execution only');
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
  note('failure', {
    message: String(error),
    frame: normalized(latestFrame).slice(-32768),
    viewport: active?.viewport(),
  });
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
  for (const [index, owned] of owners.entries()) {
    try {
      await owned.drain();
      owned.close();
      durableReceipt(join(evidence, `pty-${index}.ansi`), owned.text(), 'wx');
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
