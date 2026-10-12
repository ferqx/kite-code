import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const [runner, workspace, profilePath, wire, transcript, quoteName, servicePidPath] =
  process.argv.slice(2) as [string, string, string, string, string, string, string];
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_file_candidates_interrupted'));
const shutdown = (message: unknown) => {
  if (message === 'owned-file-candidates-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', shutdown);
const pty = spawnTuiPTY({ cmd: [process.execPath, '--no-install', runner], cwd: workspace });
let failure: unknown;
let normal = false;
let servicePid: number | undefined;
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await pty.key(value);
  // Preserve the original 100ms pump after every input, including each Delete.
  await Bun.sleep(100);
};
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (pty.ended || Date.now() > end)
      throw Error(`expected ${text} tail=${frame.text.slice(-6000)}`);
    await Bun.sleep(20);
  }
};
const posts = () =>
  readFileSync(wire, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.method === 'POST');
const draft = async (expected: string) => {
  const end = Date.now() + 5000;
  const path = join(profilePath, 'ui/tui.json');
  for (;;) {
    abort.signal.throwIfAborted();
    if (existsSync(path)) {
      const rows = JSON.parse(readFileSync(path, 'utf8')).drafts as {
        sessionId: string;
        text: string;
      }[];
      if (rows.some((row) => row.sessionId === 'files' && row.text === expected)) return;
      if (Date.now() > end) throw Error(`draft mismatch ${JSON.stringify(rows)}`);
    } else if (Date.now() > end) throw Error('draft file unavailable');
    await Bun.sleep(20);
  }
};
const erase = async (text: string) => {
  await key('\x1b[H');
  for (const _character of Array.from(text)) await key('\x1b[3~');
};
try {
  await wait('New Run');
  servicePid = Number(readFileSync(servicePidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0);
  process.kill(servicePid, 0);
  await key('@目录/中文');
  await wait('目录/中文 空格.txt');
  assert.deepEqual(posts(), []);
  await key('\t');
  await draft('@"目录/中文 空格.txt"');
  assert.deepEqual(posts(), []);
  await erase('@"目录/中文 空格.txt"');
  await key('@catalog-060');
  await wait('catalog-0600.txt');
  assert.deepEqual(posts(), []);
  await key('\x1b');
  await key('4');
  await wait('catalog-0604.txt');
  await key('\t');
  await draft('@catalog-0604.txt');
  assert.deepEqual(posts(), []);
  await erase('@catalog-0604.txt');
  await key('@目录/quote');
  await wait('quote');
  await key('\t');
  // POSIX retains the original physical quote/backslash sample. Windows uses a
  // legal physical name requiring JSON quoting; pure Composer tests cover escapes.
  const quoted =
    process.platform === 'win32'
      ? `@${JSON.stringify(`目录/${quoteName}`)}`
      : '@"目录/quote\\"\\\\.txt"';
  await draft(quoted);
  assert.deepEqual(posts(), []);
  await erase(quoted);
  await key('@');
  await wait('File candidates incomplete');
  await key('\x03');
  assert.deepEqual(posts(), []);
  await key('\x11');
  const end = Date.now() + 6000;
  while (!pty.ended && Date.now() < end) await Bun.sleep(20);
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'owned_file_candidates_normal_exit_unconfirmed',
  );
  assert.equal(code, 0);
  assert.throws(() => process.kill(servicePid!, 0), { code: 'ESRCH' });
  normal = true;
  console.log('FILES_REAL_SCOPED_TAB_ZERO_POST');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (!pty.ended) {
    try {
      await terminateTuiTree(pty, {
        exitTimeoutMs: 3000,
        servicePid,
        serviceExitTimeoutMs: 3000,
        requireServiceAlive: false,
      });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Files cleanup failed') : error;
    }
  }
  await pty.drain();
  writeFileSync(transcript, pty.text());
  writeFileSync(
    `${transcript}.receipt.json`,
    JSON.stringify({
      pid: pty.host.pid,
      servicePid,
      normal,
      code: pty.host.exitCode,
      failure: failure ? String(failure) : null,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  pty.close();
  if (process.platform === 'win32') {
    process.removeListener('message', shutdown);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
