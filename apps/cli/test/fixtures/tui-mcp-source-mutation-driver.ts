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
const interrupted = () => abort.abort(Error('owned_source_mutation_interrupted'));
const shutdown = (message: unknown) => {
  if (message === 'owned-source-mutation-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', shutdown);
const trace: Record<string, unknown>[] = [];
const exits: { phase: string; pid: number; exitCode: number; normalCtrlQ: boolean }[] = [];
const owners: TuiPTY[] = [];
let active: TuiPTY | undefined;
let decoder: TextDecoder;
let decodeFailure: unknown;
let retained: string | undefined;
let latestFrame = '';
let complete = false;
let failure: unknown;
const note = (kind: string, values: Record<string, unknown> = {}) => {
  trace.push({ kind, time: performance.now() / 1000, ...values });
  if (trace.length > 512) trace.shift();
};
const current = async () => {
  abort.signal.throwIfAborted();
  if (decodeFailure) throw decodeFailure;
  const frame = await active!.projection();
  // The original driver retained only an explicitly validated unchanged detail.
  // A newly parsed render always supersedes that retained observation.
  const text = frame.fresh || retained === undefined ? frame.text : retained;
  latestFrame = text;
  return { fresh: frame.fresh || retained !== undefined, text };
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const selectedLabel = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('❯ '))
    ?.slice(2);
const control = async (path: string) => {
  const frame = active!.ended ? latestFrame : (await current()).text;
  note('control', { path, frame: normalized(frame).slice(-32768) });
  const response = await fetch(controlUrl + path, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw Error(`owned_source_mutation_control_failed:${path}`);
  return (await response.json()) as { commandId: string; executionId: string };
};
const wait = async (text: string, compact = false) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const value = normalized(frame.text);
    if (frame.fresh && (compact ? value.replaceAll(' ', '') : value).includes(text)) {
      note('matched', { text, frame: value.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_source_mutation_frame_deadline:${text}`);
    if (active!.ended) throw Error('owned_source_mutation_pty_eof');
    await Bun.sleep(50);
  }
};
const waitAbsent = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const value = normalized(frame.text);
    if (frame.fresh && value && !value.includes(text)) {
      note('absent', { text, frame: value.slice(-32768) });
      return;
    }
    if (Date.now() > end) throw Error(`owned_source_mutation_absent_deadline:${text}`);
    if (active!.ended) throw Error('owned_source_mutation_pty_eof');
    await Bun.sleep(50);
  }
};
const key = async (value: string, retain = false) => {
  const before = await current();
  note('key', {
    hex: Buffer.from(value).toString('hex'),
    retain,
    frame: normalized(before.text).slice(-32768),
  });
  retained = retain ? before.text : undefined;
  await active!.key(value);
};
const choose = async (label: string, top = 'Add source entry') => {
  const end = Date.now() + 10000;
  const selection = async () => {
    for (;;) {
      const frame = await current();
      if (selectedLabel(frame.text) !== undefined) return frame;
      if (Date.now() > end) throw Error(`owned_source_mutation_selection_absent:${label}`);
      await Bun.sleep(50);
    }
  };
  const initial = await selection();
  if (normalized(initial.text).includes(`❯ ${label}`)) return;
  if (!normalized(initial.text).includes(`❯ ${top}`)) {
    retained = undefined;
    note('navigate-top', { target: top });
    await active!.keyUnlessVisible('\x1b[A'.repeat(64), `❯ ${top}`);
    for (;;) {
      const frame = await current();
      if (frame.fresh && normalized(frame.text).includes(`❯ ${top}`)) break;
      if (Date.now() > end) throw Error(`owned_source_mutation_top_deadline:${top}`);
      await Bun.sleep(50);
    }
  }
  for (;;) {
    const before = await selection();
    if (before.fresh && normalized(before.text).includes(`❯ ${label}`)) return;
    if (Date.now() > end) throw Error(`owned_source_mutation_navigation_deadline:${label}`);
    const previous = selectedLabel(before.text);
    await key('\x1b[B');
    for (;;) {
      const after = await current();
      const selected = selectedLabel(after.text);
      if (after.fresh && selected !== undefined && selected !== previous) break;
      if (Date.now() > end) throw Error(`owned_source_mutation_navigation_frame_deadline:${label}`);
      await Bun.sleep(50);
    }
  }
};
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
const changes = async () => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('Project sources');
  await choose('Source entry changes', 'Project sources');
  await key('\r');
  await wait('Add source entry');
  await waitAbsent('Reading source entry facts');
};
const selected = (id: string) =>
  wait(`Originalsourcechange:${id}OriginalStore:${storeId}·Sessiona`, true);
const selectOriginal = async (id: string) => {
  await choose(`Original source change: ${id}`);
  const known = normalized((await current()).text)
    .replaceAll(' ', '')
    .includes(`Originalsourcechange:${id}OriginalStore:${storeId}·Sessiona`);
  await key('\r', known);
  await selected(id);
};
const leave = async (parent = 'MCP · w', pending = false) => {
  await key('\x03');
  await wait(parent);
  await key('\x03');
  await wait(pending ? 'Ctrl+B pending cards' : 'New Run >');
};
const close = async (phase: string) => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active!.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_source_mutation_normal_exit_unconfirmed',
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
  await changes();
  await choose('Add source entry');
  await key('\r');
  await wait('❯ HTTP');
  await key('\r');
  await wait('Source entry name:');
  await key('\r');
  await wait('Invalid source entry name');
  await control('empty-name');
  for (const character of 'shared') {
    await key(character);
    await wait('Source entry name:');
  }
  await key('\r');
  await wait('Source entry value:');
  await key('https://controlled.invalid/project');
  await wait('https://controlled.invalid/project');
  await key('\r');
  await wait('❯ Current project');
  await key('\r');
  await wait('Review source entry change');
  await control('add-review');
  await key('\r');
  await wait('Confirm source entry change');
  await control('add-confirm');
  await key('\r');
  await wait('Original source change:');
  await leave('MCP · w', true);
  const addedFact = await control('approve-add');
  const added = addedFact.commandId;
  await wait(`builtin.mcp.sources/mcp.source.add[${addedFact.executionId}]succeeded`, true);
  await wait('New Run >');
  await changes();
  await selectOriginal(added);
  await choose('Check original source change');
  await key('\r');
  await selected(added);
  await wait('saved');
  await choose('Remove source entry: shared · workspace');
  await key('\r');
  await wait('Review source entry change');
  await wait('Removal reveals user source: shared');
  await control('remove-review');
  await key('\r');
  await wait('Confirm source entry change');
  await wait('Removal reveals user source: shared');
  await control('remove-confirm');
  await key('\r');
  await wait('Original source change:');
  await leave('MCP · w', true);
  const removedFact = await control('approve-remove');
  const removed = removedFact.commandId;
  await wait(`builtin.mcp.sources/mcp.source.remove[${removedFact.executionId}]succeeded`, true);
  await wait('New Run >');
  await changes();
  await selectOriginal(removed);
  await choose('Check original source change');
  await key('\r');
  await selected(removed);
  await wait('saved');
  await control('warm-complete');
  await leave();
  await close('warm');
  await control('cold-removed');
  await start('cold-removed');
  await changes();
  await control('selection-baseline');
  await selectOriginal(removed);
  await control('cold-selected');
  await choose('Check original source change');
  await key('\r');
  await selected(removed);
  await wait('saved');
  await control('cold-lookup');
  await leave('MCP · unavailable');
  await close('cold-removed');
  await control('cold-foreign');
  await start('cold-foreign');
  await changes();
  await control('selection-baseline');
  await selectOriginal(removed);
  await control('foreign-selected');
  await choose('Check original source change');
  await key('\r', true);
  await selected(removed);
  await wait('outcome_unknown');
  await control('foreign-lookup');
  await leave('MCP · unavailable');
  await close('cold-foreign');
  complete = true;
  console.log('SOURCE_MUTATION_WARM_COLD_FOREIGN_COMPLETE');
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
            'owned_source_mutation_failure_exit_timeout',
          );
        } catch {
          await terminateTuiTree(active, { exitTimeoutMs: 3000 });
        }
      }
      exits.push({
        phase: 'failure',
        pid: active.host.pid,
        exitCode: await active.host.exited,
        normalCtrlQ: false,
      });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Source PTY failed') : error;
    }
  }
  for (const owned of owners) {
    try {
      await owned.drain();
      owned.close();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Source PTY close failed') : error;
    }
  }
  for (const [name, value] of [
    [
      'pty-trace.json',
      {
        failure: failure ? String(failure) : null,
        latestCompleteFrame: normalized(latestFrame).slice(-32768),
        trace,
      },
    ],
    ['pty-exits.json', { normalComplete: complete, exits }],
  ] as const) {
    durableReceipt(join(evidence, name), JSON.stringify(value), 'wx');
  }
  if (process.platform === 'win32') {
    process.removeListener('message', shutdown);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
