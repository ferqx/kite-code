import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  executable: string;
  entrypoint: string;
  root: string;
  evidence: string;
  controlUrl: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_mcp_selection_interrupted'));
const stop = (message: unknown) => {
  if (message === 'mcp-selection-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
const output: Uint8Array[] = [];
const owned = spawnTuiPTY({
  cmd: [input.executable, '--no-install', input.entrypoint],
  cwd: input.root,
  onData(bytes) {
    output.push(bytes.slice());
  },
  env: {
    HOME: join(input.root, 'home'),
    TMPDIR: input.root,
    ...(process.platform === 'win32'
      ? { USERPROFILE: join(input.root, 'home'), TEMP: input.root, TMP: input.root }
      : {}),
  },
});
let complete = false;
let failure: unknown;
const controls: string[] = [];
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await owned.projection();
    if (frame.fresh && normalized(frame.text).includes(text)) return;
    if (owned.ended) throw Error(`early exit ${frame.text.slice(-3000)}`);
    if (Date.now() > end) throw Error(`expected ${text} tail=${frame.text.slice(-5000)}`);
    await Bun.sleep(50);
  }
};
const waitDraft = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await owned.projection();
    const footer = frame.text.split('Development TUI ·').at(-1)!;
    if (
      frame.fresh &&
      footer.includes('Session a ·') &&
      !footer.includes(' · Loading') &&
      footer.split('\n').includes(text)
    )
      return;
    if (owned.ended) throw Error('early exit before current draft');
    if (Date.now() > end) throw Error(`expected current draft ${text} tail=${footer.slice(-5000)}`);
    await Bun.sleep(50);
  }
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await owned.key(value);
};
const choose = async (label: string, prefix = false) => {
  const end = Date.now() + 10000;
  const current = async () => {
    const frame = await owned.projection();
    return { fresh: frame.fresh, text: owned.viewport() };
  };
  const selectedLabel = (text: string) =>
    text
      .split('\n')
      .map((row) => row.trim())
      .find((row) => row.startsWith('❯ '))
      ?.slice(2);
  const matches = (value?: string) =>
    prefix ? value?.startsWith(label) === true : value === label;
  const selected = async () => {
    for (;;) {
      abort.signal.throwIfAborted();
      const frame = await current();
      if (selectedLabel(frame.text) !== undefined) return frame;
      if (owned.ended) throw Error('original MCP host ended during navigation');
      if (Date.now() > end) throw Error(`expected original MCP selection: ${label} ${frame.text}`);
      await Bun.sleep(50);
    }
  };
  const initial = await selected();
  if (matches(selectedLabel(initial.text))) return;
  if (selectedLabel(initial.text) !== 'Project sources') {
    await owned.keyUnlessVisible('\x1b[A'.repeat(32), '❯ Project sources');
    for (;;) {
      const frame = await current();
      if (selectedLabel(frame.text) === 'Project sources') break;
      if (Date.now() > end) throw Error(`expected original MCP top ${frame.text}`);
      if (owned.ended) throw Error('original MCP host ended during navigation');
      await Bun.sleep(50);
    }
  }
  for (let n = 0; n < 32; n++) {
    const before = await selected();
    if (matches(selectedLabel(before.text))) return;
    await key('\x1b[B');
    for (;;) {
      const frame = await current();
      if (
        frame.fresh &&
        selectedLabel(frame.text) !== undefined &&
        selectedLabel(frame.text) !== selectedLabel(before.text)
      )
        break;
      if (Date.now() > end)
        throw Error(`original MCP selection did not move: ${label} ${frame.text}`);
      if (owned.ended) throw Error('original MCP host ended during navigation');
      await Bun.sleep(50);
    }
  }
  throw Error(`original MCP choice unavailable: ${label}`);
};
const check = async (path: string) => {
  controls.push(path);
  await ptyDeadline(
    (async () => {
      const response = await fetch(input.controlUrl + path, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Error(`${path} ${await response.text()}`);
      assert.equal(((await response.json()) as { passed: boolean }).passed, true);
    })(),
    12000,
    `owned_mcp_selection_control_deadline:${path}`,
  );
};
try {
  await wait('New Run');
  await key('New task: owned pending task');
  await wait('New task: owned pending task');
  await key('\r');
  await wait('approval [');
  await check('baseline');
  await key('/mcp');
  await waitDraft('/mcp');
  await key('\r');
  await wait('owned-server');
  await wait('Reading this list does not connect');
  await wait('Server list ready');
  await choose('owned-server ·', true);
  await wait('❯ owned-server ·');
  await key('\r');
  await wait('Server: owned-server');
  await wait('User settings');
  await wait('Project settings');
  await choose('Enable · User settings');
  await wait('❯ Enable · User settings');
  await check('read-detail');
  await key('\r');
  await wait('Confirm server change:');
  await wait('Enter saves; Esc abandons');
  await check('before-confirm');
  await key('\r');
  await wait('Waiting for original result');
  await check('approve-job');
  await choose('Check original change');
  await wait('❯ Check original change');
  await key('\r');
  await wait('Selection saved');
  await key('\x1b');
  await wait('New Run');
  await check('new-pending');
  await wait('approval [');
  await check('esc');
  await key('/mcp');
  await waitDraft('/mcp');
  await key('\r');
  await wait('owned-server');
  await wait('Server list ready');
  await choose('owned-server ·', true);
  await wait('❯ owned-server ·');
  await key('\r');
  await wait('Server: owned-server');
  await choose('Refresh servers');
  await wait('❯ Refresh servers');
  await key('\r');
  await wait('owned-server');
  await check('refresh');
  // Root MCP Ctrl+C cancels the active Run. Exercise the local reader scope.
  await choose('Saved tool snapshots');
  await key('\r');
  await wait('MCP Tools · saved metadata');
  await wait('Reading does not connect or authorize tools.');
  await key('\x03');
  await wait('Approve this execution only');
  await wait('pending · revision 1');
  await check('ctrl-c');
  assert.ok(Buffer.concat(output).includes(Buffer.from('ORIGINAL_COMPLETE_HISTORY_TAIL')));
  await key('/clear');
  await wait('/clear');
  await key('\r');
  await wait('Approve this execution only');
  await wait('pending · revision 1');
  await check('clear');
  assert.equal(
    owned.sinceAction().replace(ansi, '').includes('ORIGINAL_COMPLETE_HISTORY_TAIL'),
    false,
  );
  await key('PRIVATE_CARD_DRAFT');
  await wait('PRIVATE_CARD_DRAFT');
  await key('\x0c');
  await wait('PRIVATE_CARD_DRAFT');
  await check('draft-clear');
  await key('\x11');
  const end = Date.now() + 6000;
  while (!owned.ended && Date.now() < end) await Bun.sleep(50);
  const [exitCode] = await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    3000,
    'owned_mcp_selection_normal_exit_unconfirmed',
  );
  assert.equal(exitCode, 0);
  await owned.drain();
  complete = true;
  console.log(
    JSON.stringify({ pty: true, columns: 80, rows: 24, pid: owned.host.pid, exit: exitCode }),
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await owned.drain();
    writeFileSync(join(input.evidence, 'terminal.txt'), Buffer.concat(output));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'MCP terminal receipt failed') : error;
  }
  if (!owned.ended) {
    try {
      await terminateTuiTree(owned, { exitTimeoutMs: 5000 });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'MCP tree cleanup failed') : error;
    }
  }
  try {
    writeFileSync(
      join(input.evidence, 'pty-exits.json'),
      JSON.stringify({
        normalComplete: complete,
        normalCtrlQ: complete,
        pid: owned.host.pid,
        exitCode: owned.host.exitCode,
        controls,
      }),
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'MCP exit receipt failed') : error;
  }
  owned.close();
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (process.platform === 'win32') {
    process.removeListener('message', stop);
    if (process.connected) process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
