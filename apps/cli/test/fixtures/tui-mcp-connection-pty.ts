import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

const settings = JSON.parse(process.argv[2]!) as {
  root: string;
  evidence: string;
  controlUrl: string;
  selectedServerId: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_connection_interrupted'));
process.once('SIGINT', interrupted);
let active: TuiPTY | undefined;
let phase: 'warm' | 'cold' = 'warm';
const owners: TuiPTY[] = [];
const record = (name: string, value: unknown) =>
  appendFileSync(join(settings.evidence, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const current = async () => {
  abort.signal.throwIfAborted();
  const frame = await active!.projection();
  return { fresh: frame.fresh, text: normalized(frame.text) };
};
const control = async (path: string) => {
  const response = await fetch(settings.controlUrl + path, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw Error(`owned_control_failed:${path}:${await response.text()}`);
  return (await response.json()) as { commandId: string };
};
const key = (value: string) => active!.key(value);
const wait = async (text: string, compact = false) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    if (frame.fresh && (compact ? frame.text.replaceAll(' ', '') : frame.text).includes(text))
      return;
    if (Date.now() > deadline) throw Error(`expected ${text} tail=${frame.text.slice(-5000)}`);
    if (active!.ended) throw Error('owned_pty_eof');
    await Bun.sleep(50);
  }
};
const choose = async (label: string) => {
  // Use the current parsed choice, including restored original requests.
  const deadline = Date.now() + 10000;
  if (!(await current()).text.includes('› Project sources')) {
    await key('\x1b[A'.repeat(32));
    await wait('› Project sources');
  }
  for (let index = 0; index < 32; index++) {
    const before = await current();
    if (before.fresh && before.text.replaceAll(' ', '').includes(`›${label.replaceAll(' ', '')}`))
      return;
    await key('\x1b[B');
    for (;;) {
      const after = await current();
      if (after.fresh && after.text !== before.text) break;
      if (Date.now() > deadline) throw Error(`owned_choice_deadline:${label}`);
      if (active!.ended) throw Error('owned_pty_eof');
      await Bun.sleep(50);
    }
  }
  throw Error(`owned_choice_unavailable:${label}`);
};
const selectedConnection = (id: string) =>
  wait(`Originalconnection:${id}·Connectionoutcomeunknown;checkoriginal`, true);
const start = async () => {
  active = spawnTuiPTY({
    cmd: [process.execPath, '--no-install', join(settings.root, 'host.js')],
    cwd: settings.root,
    env: {
      HOME: settings.root,
      KITE_CODE_HOME: join(settings.root, 'owned-home'),
      ...(process.platform === 'win32' ? { USERPROFILE: settings.root } : {}),
    },
  });
  owners.push(active);
  record('pids.jsonl', { phase, tuiPid: active.host.pid });
  await wait('New Run >');
};
const requestConnection = async () => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('Server list ready');
  await key('\x1b[B');
  await wait(`›${settings.selectedServerId}·enabled·available`, true);
  await key('\r');
  await wait(`Server:${settings.selectedServerId}·http`, true);
  await wait('Source:');
  await key('\x1b[B'.repeat(6));
  await wait('› Request connection');
  await key('\r');
  await wait('Confirm connection request:');
  await key('\r');
  await wait('Original connection:');
};
const lookupDetail = async () => {
  await choose('Check original connection');
  await key('\r');
  await wait('Original catalogue ready');
  record('frames.jsonl', { phase, frame: (await current()).text });
};
const close = async () => {
  await key('\x11');
  const deadline = Date.now() + 6000;
  while (!active!.ended && Date.now() < deadline) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'owned_connection_exit_unconfirmed',
  );
  assert.equal(code, 0);
  await active!.drain();
  active!.close();
  record('exits.jsonl', { pid: active!.host.pid, exit: code });
};

let failure: unknown;
try {
  await start();
  await requestConnection();
  const first = (await control('approve-new')).commandId;
  await lookupDetail();
  await choose('Request connection');
  await key('\r');
  await wait('Confirm connection request:');
  await key('\r');
  await wait('Original connection:');
  const second = (await control('approve-reuse')).commandId;
  await lookupDetail();
  await wait('Reused original connection');
  await close();
  await control('cold');
  phase = 'cold';
  await start();
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('No configured MCP servers');
  await choose(`Original connection: ${second}`);
  await key('\r');
  await selectedConnection(second);
  await control('cold-selected');
  await choose('Check original connection');
  await key('\r');
  await wait('Original catalogue ready');
  await wait('Live connection not confirmed');
  await control('cold-lookup');
  await choose(`Original connection: ${first}`);
  await key('\r');
  await selectedConnection(first);
  await choose('Check original connection');
  await key('\r');
  await wait('Original catalogue ready');
  await wait('Live connection not confirmed');
  await control('check');
  await key('\x1b');
  await wait('New Run >');
  await control('restore-source');
  await requestConnection();
  await control('approve-new');
  await lookupDetail();
  await wait('Created by original request');
  await close();
  await control('detached');
  console.log('ORIGINAL_CONNECTION_WARM_COLD_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupted);
  writeFileSync(join(settings.evidence, 'final-frame.txt'), active?.sinceAction() ?? '', {
    mode: 0o600,
  });
  for (const owner of owners) {
    try {
      if (!owner.ended) await terminateTuiTree(owner, { exitTimeoutMs: 9000 });
      await owner.drain();
      owner.close();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'owned_connection_cleanup_failed')
        : error;
    }
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
