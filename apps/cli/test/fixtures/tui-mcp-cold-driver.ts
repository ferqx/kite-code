import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

const [controlUrl, executable, hostPath, root, evidence] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_mcp_cold_interrupted'));
const shutdown = (message: unknown) => {
  if (message === 'owned-mcp-cold-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', shutdown);
const owners: TuiPTY[] = [];
const controls: string[] = [];
const exits: { pid: number; code: number; normalCtrlQ: boolean }[] = [];
const output: Uint8Array[] = [];
let active: TuiPTY | undefined;
let retained: string | undefined;
let failure: unknown;
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
const current = async () => {
  abort.signal.throwIfAborted();
  const frame = await active!.projection();
  return {
    fresh: frame.fresh || retained !== undefined,
    text: frame.fresh || retained === undefined ? frame.text : retained,
  };
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const selectedLabel = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('› '))
    ?.slice(2);
const wait = async (text: string, absent?: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const view = normalized(frame.text);
    if (frame.fresh && view.includes(text) && (absent === undefined || !view.includes(absent)))
      return;
    if (active!.ended) throw Error(`early exit ${active!.text().slice(-3000)}`);
    if (Date.now() > end) throw Error(`expected ${text} tail=${view.slice(-5000)}`);
    await Bun.sleep(50);
  }
};
const key = async (value: string, preserveCurrentDetail = false) => {
  retained = preserveCurrentDetail ? (await current()).text : undefined;
  await active!.key(value);
};
const choose = async (label: string) => {
  const end = Date.now() + 10000;
  if (selectedLabel((await current()).text) === label) return;
  if (selectedLabel((await current()).text) !== 'Project sources') {
    await key('\x1b[A'.repeat(64));
    await wait('› Project sources');
  }
  while (selectedLabel((await current()).text) !== label) {
    const previous = selectedLabel((await current()).text);
    await key('\x1b[B');
    for (;;) {
      const frame = await current();
      const selected = selectedLabel(frame.text);
      if (frame.fresh && selected !== undefined && selected !== previous) break;
      if (Date.now() > end) throw Error(`original MCP selection did not move: ${label}`);
      if (active!.ended) throw Error('original MCP host ended');
      await Bun.sleep(50);
    }
  }
};
const check = async (path: string) => {
  controls.push(path);
  const response = await fetch(controlUrl + path, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw Error(`owned_cold_control_failed:${path}:${await response.text()}`);
  return (await response.json()) as { originals: string[] };
};
const start = async () => {
  retained = undefined;
  active = spawnTuiPTY({
    cmd: [executable, '--no-install', hostPath],
    cwd: root,
    onData(bytes) {
      output.push(bytes.slice());
    },
  });
  owners.push(active);
  let ownership: { pid: number; pgid?: number; ownership: string };
  if (process.platform === 'win32') {
    ownership = { pid: active.host.pid, ownership: 'windows-process-tree' };
  } else {
    const { dlopen } = await import('bun:ffi');
    const library = dlopen(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      { getpgid: { args: ['i32'], returns: 'i32' } },
    );
    try {
      const pgid = library.symbols.getpgid(active.host.pid);
      assert.equal(pgid, active.host.pid, 'actual owned process group must be the host');
      ownership = { pid: active.host.pid, pgid, ownership: 'posix-process-group' };
    } finally {
      library.close();
    }
  }
  durableReceipt(join(root, 'pty-pids.jsonl'), `${JSON.stringify(ownership)}\n`, 'a');
};
const quit = async () => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active!.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_cold_normal_exit_unconfirmed',
  );
  exits.push({ pid: active!.host.pid, code, normalCtrlQ: true });
  assert.equal(code, 0);
  await active!.drain();
  active!.close();
  return active!.host.pid;
};

try {
  await start();
  await wait('New Run');
  for (const ordinal of [1, 2]) {
    await key('/mcp');
    await wait('/mcp');
    await key('\r');
    await wait('owned-server', 'Reading servers');
    await wait('Server list ready');
    await key('\x1b[B');
    await wait('› owned-server ·');
    await key('\r');
    await wait('Server: owned-server');
    await key('\x1b[B');
    await wait(`› ${ordinal === 1 ? 'Enable' : 'Disable'} · User settings`);
    await key('\r');
    await wait('Confirm server change:');
    await key('\r');
    await wait('Waiting for original result');
    await check(`approve-${ordinal}`);
    await key('\x1b[B'.repeat(2));
    await wait('› Check original change');
    await key('\r');
    await wait('Selection saved');
    await key('\x1b');
    await wait('New Run');
  }
  const warm = await quit();
  const row = await check('warm-closed');
  const second = row.originals[1]!;
  await start();
  await wait('New Run');
  await key('/mcp');
  await wait('/mcp');
  await key('\r');
  await wait('No configured MCP servers');
  await wait(`Original change: ${second}`);
  await check('cold-open');
  await choose(`Original change: ${second}`);
  const detail = `Original change: ${second} · Outcome unknown; check original change`;
  // Enter can be an unchanged selection. Preserve only the exact current detail.
  const known = normalized((await current()).text).includes(detail);
  await key('\r', known);
  await wait(detail);
  await check('cold-selected');
  await choose('Check original change');
  await key('\r');
  await wait('Selection saved');
  await check('cold-lookup');
  await key('\x1b');
  await wait('New Run');
  const cold = await quit();
  console.log(JSON.stringify({ columns: 80, rows: 24, warmPid: warm, coldPid: cold, exit: 0 }));
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (active && !active.ended) {
    try {
      await terminateTuiTree(active, { exitTimeoutMs: 5000 });
      exits.push({ pid: active.host.pid, code: await active.host.exited, normalCtrlQ: false });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Cold MCP cleanup failed') : error;
    }
  }
  for (const owned of owners) {
    try {
      await owned.drain();
      owned.close();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Cold MCP close failed') : error;
    }
  }
  writeFileSync(join(evidence, 'terminal.txt'), Buffer.concat(output));
  durableReceipt(
    join(evidence, 'driver-facts.json'),
    JSON.stringify({ failure: failure ? String(failure) : null, controls, exits }),
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
