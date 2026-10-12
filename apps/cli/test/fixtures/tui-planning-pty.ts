import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  entrance: 'slash-task' | 'draft-mode' | 'active-queued' | 'scope-draft';
  root: string;
  workspace: string;
  databasePath: string;
  runner: string;
  firstLost: string;
  transcript: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_planning_interrupted'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
const shutdown = (message: unknown) => {
  if (message === 'owned-planning-stop') interrupted();
};
// Windows TerminateProcess cannot run finally. The private driver channel
// enters the same abort path, which owns termination of its ConPTY subtree.
if (process.platform === 'win32') process.on('message', shutdown);
const pty = spawnTuiPTY({ cmd: [process.execPath, '--no-install', input.runner], cwd: input.root });
const current = async () => {
  abort.signal.throwIfAborted();
  return pty.projection();
};
const wait = async (text: string) => {
  const end = Date.now() + 8000;
  for (;;) {
    const frame = await current();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (Date.now() > end) throw Error(`expected ${text} tail=${frame.text.slice(-5000)}`);
    if (pty.ended) throw Error('original Planning host ended');
    await Bun.sleep(50);
  }
};
const key = async (value: string) => {
  await pty.key(value);
  // Preserve the original key's 100ms pump window while native PTY callbacks drain.
  await Bun.sleep(100);
  await pty.drain();
};
const choose = async (id: string, title: string) => {
  await key('\x12');
  await wait(title);
  for (const direction of [undefined, '\x1b[B', '\x1b[A']) {
    if (direction) await key(direction);
    const frame = await current();
    if (frame.fresh && frame.text.split('\n').includes(`> ${title} [${id}]`)) {
      await key('\r');
      await wait(`Session ${id} ·`);
      return;
    }
  }
  throw Error(`original Session target not selected ${id}`);
};
const planningTask = 'original single plan 中文🙂';
const slash = async () => {
  await key(`/plan ${planningTask}`);
  await wait('/plan original single plan');
  await key('\r');
};
const readDatabase = <T>(work: (database: Database) => T): T => {
  const database = new Database(input.databasePath, { readonly: true });
  try {
    return work(database);
  } finally {
    database.close();
  }
};
let failure: unknown;
try {
  await wait('New Run >');
  if (input.entrance === 'scope-draft') {
    await choose('b', 'Other original Plan scope');
    await wait('New Run >');
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key('UNSENT_ORIGINAL_OTHER_PLAN');
    await wait('UNSENT_ORIGINAL_OTHER_PLAN');
    await choose('s', 'Original Plan');
    await wait('New Run >');
    await slash();
  } else if (input.entrance === 'active-queued') {
    await key('original parent task');
    await wait('original parent task');
    await key('\r');
    await wait('Steer original active Run >');
    await slash();
    await wait('input.follow_up: accepted');
    readDatabase((database) => {
      assert.deepEqual(database.query("SELECT COUNT(*) AS n FROM run WHERE session_id='s'").get(), {
        n: 1,
      });
      assert.equal(
        (database.query("SELECT status FROM run WHERE session_id='s'").get() as { status: string })
          .status,
        'running',
      );
    });
    writeFileSync(
      join(input.root, 'original-model-release'),
      'explicit owned original Model release',
    );
  } else if (input.entrance === 'slash-task') {
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key('\x1b[Z');
    await wait('New Run >');
    await slash();
  } else {
    await key('/plan');
    await wait('/plan');
    await key('\r');
    await wait('Planning next Run >');
    await key('\x1b[Z');
    await wait('New Run >');
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key(planningTask);
    await wait('original single plan');
    await key('\r');
  }
  await wait('plan_review');
  assert.equal(
    existsSync(join(input.workspace, 'before.txt')),
    false,
    'original Full wrote before plan',
  );
  assert.equal(
    existsSync(join(input.workspace, 'after.txt')),
    false,
    'effect existed before user approval',
  );
  await key('\x01');
  await wait('ORIGINAL_PLAN_FULL_TAIL');
  await key('approve accept_edits');
  await wait('approve accept_edits');
  await key('\r');
  await wait('interaction.answer: unknown');
  await key('\x0c');
  await wait('interaction.answer: unknown');
  assert.equal(existsSync(input.firstLost), true);
  await key('\x0c');
  await wait('interaction.answer: applied');
  await wait('ORIGINAL_PLAN_ACTUALLY_COMPLETED');
  const end = Date.now() + 8000;
  for (;;) {
    abort.signal.throwIfAborted();
    const run = readDatabase(
      (database) =>
        database
          .query("SELECT status,reason FROM run WHERE session_id='s' ORDER BY rowid DESC LIMIT 1")
          .get() as { status: string; reason: string | null },
    );
    if (run.status === 'completed') break;
    if (Date.now() > end) throw Error(`actual original Run not completed ${JSON.stringify(run)}`);
    await pty.drain();
    await Bun.sleep(50);
  }
  if (input.entrance === 'scope-draft') {
    await choose('b', 'Other original Plan scope');
    await wait('Planning next Run >');
    await wait('UNSENT_ORIGINAL_OTHER_PLAN');
  }
  await key('\x11');
  const deadline = Date.now() + 6000;
  while (!pty.ended && Date.now() < deadline) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'original Planning host exit timeout',
  );
  assert.equal(code, 0);
  console.log('ORIGINAL_PLAN_PT Y_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  try {
    if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
    await pty.drain();
    pty.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Planning PTY failed') : error;
  }
  writeFileSync(input.transcript, pty.text());
  if (process.platform === 'win32') {
    process.removeListener('message', shutdown);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
