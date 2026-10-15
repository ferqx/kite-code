import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  root: string;
  runner: string;
  transcript: string;
  servicePid: string;
  original: string;
  responseMarker: string;
  databasePath: string;
};
const abort = new AbortController();
const stop = () => abort.abort(Error('ordinary_driver_interrupted'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const message = (value: unknown) => {
  if (value === 'owned-ink-parity-stop') stop();
};
if (process.platform === 'win32') process.on('message', message);
const pty = spawnTuiPTY({ cmd: [process.execPath, '--no-install', input.runner], cwd: input.root });
async function wait(text: string) {
  const until = Date.now() + 15000;
  while (true) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    if (frame.text.includes(text)) return frame.text;
    if (pty.ended || Date.now() > until)
      throw Error(`ordinary_tui_missing:${text}\n${frame.text.slice(-7000)}`);
    await Bun.sleep(25);
  }
}
async function key(value: string) {
  await pty.key(value);
  await Bun.sleep(75);
  await pty.drain();
}
let success = false;
try {
  await wait('Exit Kite Code');
  const gate = await pty.projection();
  assert.ok(gate.text.includes('trust') || gate.text.includes('Trust'));
  await key('\u001b[A');
  await key('\r');
  const initial = await wait('❯');
  assert.ok(initial.includes('──◆ Kite Code'));
  assert.ok(!initial.includes('New Run >'));
  await key('/help');
  await key('\r');
  const help = await wait('Shift+Tab');
  assert.ok(help.includes('Help'));
  await key('\u001b');
  await key(`\u001b[200~${input.original}\u001b[201~`);
  const editing = await wait('console.log("user literal");');
  for (const line of input.original.split('\n').filter(Boolean)) assert.ok(editing.includes(line));
  const beforeSubmit = new Database(input.databasePath, { readonly: true });
  try {
    assert.equal(
      (beforeSubmit.query('SELECT count(*) AS count FROM run').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (beforeSubmit.query('SELECT count(*) AS count FROM execution').get() as { count: number })
        .count,
      0,
    );
  } finally {
    beforeSubmit.close();
  }

  await key('\r');
  const completed = await wait(input.responseMarker);
  assert.ok(completed.includes('**literal user**'));
  assert.ok(completed.includes('Original table cell'));
  assert.ok(completed.includes('console.log'));
  assert.ok(!completed.includes('Original outcome pending or unknown'));
  const completedUntil = Date.now() + 5000;
  for (;;) {
    const db = new Database(input.databasePath, { readonly: true });
    let done: boolean;
    try {
      done =
        (
          db.query('SELECT status,is_active FROM run ORDER BY started_at DESC LIMIT 1').get() as {
            status: string;
            is_active: number;
          } | null
        )?.status === 'completed';
    } finally {
      db.close();
    }
    if (done) break;
    if (Date.now() > completedUntil) throw Error('ordinary_actual_run_not_completed');
    await Bun.sleep(25);
  }
  await key('\u0011');
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    15000,
    'ordinary_tui_exit_timeout',
  );
  assert.equal(code, 0);
  assert.equal(pty.host.signalCode, null);
  const servicePid = Number(readFileSync(input.servicePid, 'utf8'));
  const end = Date.now() + 5000;
  while (true) {
    try {
      process.kill(servicePid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
      throw error;
    }
    if (Date.now() > end) throw Error('owned_service_survived_normal_exit');
    await Bun.sleep(25);
  }
  success = true;
  console.log('ORDINARY_INK_PARITY_RUN_EXIT');
} finally {
  writeFileSync(input.transcript, pty.text());
  if (!success && !pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 10000 });
  pty.close();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (process.platform === 'win32') process.removeListener('message', message);
}
